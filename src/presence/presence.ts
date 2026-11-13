import { apiBase } from '../client.ts';
import {
  countBlockers,
  detectSignals,
  summarize,
  type Briefing,
  type PresenceSnapshot,
  type Signal
} from './signals.ts';

export interface PresenceOptions {
  fetchImpl?: typeof fetch;
  onSnapshot?: (snapshot: PresenceSnapshot) => void;
  onSignals?: (signals: Signal[]) => void;
  onBriefing?: (briefing: Briefing) => void;
  now?: () => number;
  lastSeenAt?: () => number | null;
  routes?: string[];
}

interface PresenceHandle {
  stop: () => void;
  refresh: () => Promise<void>;
}

const IDLE_MS = 12000;
const ACTIVE_MS = 4000;
const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 4000;

async function fetchJson(fetchImpl: typeof fetch, base: string, path: string): Promise<{ ok: boolean; data: unknown; ms: number }> {
  const start = performance.now();
  try {
    const res = await fetchImpl(base + path, { headers: { Accept: 'application/json' } });
    const ms = Math.max(0, performance.now() - start);
    if (!res.ok) return { ok: false, data: null, ms };
    const data = (await res.json()) as unknown;
    return { ok: true, data, ms };
  } catch {
    const ms = Math.max(0, performance.now() - start);
    return { ok: false, data: null, ms };
  }
}

async function collectSnapshot(fetchImpl: typeof fetch, base: string, now: number): Promise<PresenceSnapshot> {
  const [live, companies, jobs, connectivity, approvals, sidecars, settings] = await Promise.all([
    fetchJson(fetchImpl, base, '/api/mission/live'),
    fetchJson(fetchImpl, base, '/api/companies'),
    fetchJson(fetchImpl, base, '/api/team/jobs?limit=30'),
    fetchJson(fetchImpl, base, '/api/connectivity'),
    fetchJson(fetchImpl, base, '/api/approvals/pending'),
    fetchJson(fetchImpl, base, '/api/sidecars'),
    fetchJson(fetchImpl, base, '/api/settings')
  ]);

  let work: unknown = null;
  if (companies.ok) {
    const list = (companies.data as { companies?: Array<{ id?: string; name?: string }> } | null)?.companies;
    const pick = Array.isArray(list)
      ? list.find((c) => c.name === 'Pablo' || c.name === 'Sofia') || list[0]
      : null;
    if (pick?.id) {
      const w = await fetchJson(fetchImpl, base, `/api/companies/${encodeURIComponent(pick.id)}/work`);
      work = w.ok ? w.data : null;
    }
  }

  const latencies = [live.ms, companies.ms, jobs.ms, connectivity.ms, approvals.ms, sidecars.ms, settings.ms].filter((n) => Number.isFinite(n));
  const latencyMs = latencies.length ? Math.max(...latencies) : 0;
  const settingsData = settings.ok ? (settings.data as { settings?: { autoWork?: boolean; auto_work?: boolean } } | null) : null;
  const autoWorkOn = typeof settingsData?.settings?.autoWork === 'boolean'
    ? settingsData.settings.autoWork
    : typeof settingsData?.settings?.auto_work === 'boolean'
      ? settingsData.settings.auto_work
      : undefined;

  const snapshot: PresenceSnapshot = {
    now,
    fetchedAt: now,
    latencyMs,
    live: live.ok ? (live.data as PresenceSnapshot['live']) : undefined,
    work: (work as PresenceSnapshot['work']) ?? undefined,
    jobs: jobs.ok ? (jobs.data as PresenceSnapshot['jobs']) : undefined,
    approvals: approvals.ok ? (approvals.data as PresenceSnapshot['approvals']) : undefined,
    connectivity: connectivity.ok ? (connectivity.data as PresenceSnapshot['connectivity']) : undefined,
    sidecars: sidecars.ok ? (sidecars.data as PresenceSnapshot['sidecars']) : undefined
  };
  if (autoWorkOn !== undefined) snapshot.autoWorkOn = autoWorkOn;
  return snapshot;
}

export function startPresence(opts: PresenceOptions = {}): PresenceHandle {
  const fetchImpl = opts.fetchImpl || fetch.bind(globalThis);
  const now = opts.now || (() => Date.now());
  const lastSeenAt = opts.lastSeenAt || (() => {
    try {
      const raw = window.localStorage.getItem('jabs.lastSeen');
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  });

  let timer: number | null = null;
  let stopped = false;
  let failures = 0;
  let currentInterval = IDLE_MS;

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    clearTimer();
    timer = window.setTimeout(() => {
      void tick();
    }, ms);
  };

  const isActive = (snapshot: PresenceSnapshot): boolean => {
    const signals = detectSignals(snapshot);
    if (signals.length > 0) return true;
    const liveCount = snapshot.live?.live?.length || 0;
    if (liveCount > 0) return true;
    const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : (snapshot.jobs && typeof snapshot.jobs === 'object' && Array.isArray((snapshot.jobs as { jobs?: unknown[] }).jobs) ? (snapshot.jobs as { jobs: unknown[] }).jobs : []);
    return jobs.length > 0;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule(IDLE_MS);
      return;
    }
    try {
      const base = apiBase();
      const ts = now();
      const snapshot = await collectSnapshot(fetchImpl, base, ts);
      failures = 0;
      opts.onSnapshot?.(snapshot);
      const signals = detectSignals(snapshot);
      opts.onSignals?.(signals);
      const briefing = summarize(snapshot, lastSeenAt());
      opts.onBriefing?.(briefing);
      currentInterval = isActive(snapshot) ? ACTIVE_MS : IDLE_MS;
      schedule(currentInterval);
    } catch {
      failures += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, failures - 1)));
      schedule(backoff);
    }
  };

  const onVisibility = (): void => {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      clearTimer();
      void tick();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  void tick();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    async refresh(): Promise<void> {
      clearTimer();
      await tick();
    }
  };
}

export function getLastSeen(): number | null {
  try {
    const raw = window.localStorage.getItem('jabs.lastSeen');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markSeen(at: number = Date.now()): void {
  try {
    window.localStorage.setItem('jabs.lastSeen', String(at));
  } catch {
    // ignore
  }
}

export function shouldShowReturnBriefing(lastSeenAt: number | null, now: number): boolean {
  if (lastSeenAt === null || !Number.isFinite(lastSeenAt)) return false;
  return now - lastSeenAt > 30 * 60 * 1000;
}

export { countBlockers };
