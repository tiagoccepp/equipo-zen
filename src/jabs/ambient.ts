// Ambient controller: graceful fetching + periodic refresh + last-seen tracking.
// Uses apiBase() from ../client for any fetching. Safe in non-browser contexts.

import { apiBase } from '../client.ts';
import {
  synthesizePulse,
  detectNudges,
  buildSessionBrief,
  type MissionPulse,
  type Nudge,
  type SessionBrief,
  type PulseLiveMeeting,
  type PulseWork
} from './insights.ts';
import { deriveQuickActions, type QuickAction } from './command-actions.ts';

export interface JabsSnapshot {
  live: PulseLiveMeeting[];
  work: PulseWork | null;
  fetchedAt: number;
  degraded: { live?: boolean; work?: boolean };
}

export interface JabsState {
  snapshot: JabsSnapshot;
  pulse: MissionPulse;
  nudges: Nudge[];
  brief: SessionBrief;
  actions: QuickAction[];
}

export interface AmbientOptions {
  pollMs?: number;
  lastSeenKey?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetcher?: typeof fetch;
  now?: () => number;
  companyId?: string | null;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_LAST_SEEN_KEY = 'jabs:lastSeenAt';

async function getJson<T>(path: string, fetcher: typeof fetch): Promise<T | null> {
  try {
    const res = await fetcher(apiBase() + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getStorage(opt?: AmbientOptions['storage']): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (opt !== undefined) return opt;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // ignore
  }
  return null;
}

export function readLastSeen(key = DEFAULT_LAST_SEEN_KEY, storage?: AmbientOptions['storage']): number | null {
  const st = getStorage(storage);
  if (!st) return null;
  try {
    const raw = st.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastSeen(ts: number, key = DEFAULT_LAST_SEEN_KEY, storage?: AmbientOptions['storage']): void {
  const st = getStorage(storage);
  if (!st) return;
  try {
    st.setItem(key, String(ts));
  } catch {
    // ignore
  }
}

function normalizeWork(work: any): PulseWork {
  return {
    company: { id: String(work.company.id), name: String(work.company.name || '') },
    team: Array.isArray(work.team) ? work.team : [],
    goals: (Array.isArray(work.goals) ? work.goals : []).map((g: any) => ({
      id: String(g.id),
      title: String(g.title || ''),
      status: String(g.status || ''),
      tasks: (Array.isArray(g.tasks) ? g.tasks : []).map((t: any) => ({
        id: String(t.id),
        text: String(t.text || ''),
        status: String(t.status || ''),
        agentId: t.agentId ?? null,
        blockedReason: t.blockedReason ?? null
      }))
    }))
  };
}

async function fetchWork(fetcher: typeof fetch, companyId?: string | null): Promise<PulseWork | null> {
  if (companyId) {
    const work = await getJson<any>(`/api/companies/${encodeURIComponent(companyId)}/work`, fetcher);
    if (work && work.company && Array.isArray(work.goals)) return normalizeWork(work);
    return null;
  }
  const list = await getJson<{ companies: Array<{ id: string; name: string }> }>('/api/companies', fetcher);
  const first = list && Array.isArray(list.companies) ? list.companies[0] : null;
  if (!first) return null;
  const work = await getJson<any>(`/api/companies/${encodeURIComponent(first.id)}/work`, fetcher);
  if (!work || !work.company || !Array.isArray(work.goals)) return null;
  return normalizeWork(work);
}

export async function fetchJabsSnapshot(options: AmbientOptions = {}): Promise<JabsSnapshot> {
  const fetcher = options.fetcher || fetch;
  const now = (options.now || Date.now)();
  const liveData = await getJson<{ live: PulseLiveMeeting[] }>('/api/mission/live', fetcher);
  const workData = await fetchWork(fetcher, options.companyId);
  const live = liveData && Array.isArray(liveData.live) ? liveData.live : [];
  return {
    live,
    work: workData,
    fetchedAt: now,
    degraded: { live: !liveData, work: workData == null }
  };
}

export function computeJabsState(
  snapshot: JabsSnapshot,
  opts: { lastSeenAt?: number | null; dismissedNudges?: string[]; now?: number } = {}
): JabsState {
  const now = opts.now ?? snapshot.fetchedAt;
  const pulse = synthesizePulse({ live: snapshot.live, work: snapshot.work, now });
  const nudges = detectNudges({ live: snapshot.live, work: snapshot.work, now, dismissed: opts.dismissedNudges || [] });
  const brief = buildSessionBrief({ lastSeenAt: opts.lastSeenAt ?? null, now, live: snapshot.live, work: snapshot.work });
  const actions = deriveQuickActions({ live: snapshot.live, work: snapshot.work, now });
  return { snapshot, pulse, nudges, brief, actions };
}

export type Unsubscribe = () => void;

export class AmbientPulse {
  private options: Required<Pick<AmbientOptions, 'pollMs' | 'lastSeenKey'>> & AmbientOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(state: JabsState) => void>();
  private dismissed = new Set<string>();
  private lastSeenAt: number | null;
  private lastState: JabsState | null = null;

  constructor(options: AmbientOptions = {}) {
    this.options = {
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      lastSeenKey: options.lastSeenKey ?? DEFAULT_LAST_SEEN_KEY,
      ...options
    };
    this.lastSeenAt = readLastSeen(this.options.lastSeenKey, this.options.storage);
  }

  getState(): JabsState | null {
    return this.lastState;
  }

  subscribe(fn: (state: JabsState) => void): Unsubscribe {
    this.listeners.add(fn);
    if (this.lastState) fn(this.lastState);
    return () => this.listeners.delete(fn);
  }

  dismissNudge(key: string): void {
    this.dismissed.add(key);
    if (this.lastState) {
      const nudges = this.lastState.nudges.filter((n) => n.dismissKey !== key);
      this.setState({ ...this.lastState, nudges });
    }
  }

  markSeen(ts?: number): void {
    const t = ts ?? (this.options.now || Date.now)();
    this.lastSeenAt = t;
    writeLastSeen(t, this.options.lastSeenKey, this.options.storage);
  }

  async refresh(): Promise<JabsState> {
    const snapshot = await fetchJabsSnapshot(this.options);
    const state = computeJabsState(snapshot, {
      lastSeenAt: this.lastSeenAt,
      dismissedNudges: Array.from(this.dismissed),
      now: snapshot.fetchedAt
    });
    this.setState(state);
    return state;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setState(state: JabsState): void {
    this.lastState = state;
    for (const fn of this.listeners) fn(state);
  }
}

export function renderPulse(el: HTMLElement, pulse: MissionPulse): void {
  el.classList.add('jabs-pulse');
  el.dataset.level = pulse.level;
  el.innerHTML = `
    <span class="jabs-pulse-dot" aria-hidden="true"></span>
    <span class="jabs-pulse-text"></span>
    <span class="jabs-pulse-meta"></span>
  `;
  (el.querySelector('.jabs-pulse-text') as HTMLElement).textContent = pulse.text;
  const meta = `${pulse.signals.activeAgents} active · ${pulse.signals.blockedTasks} blocked`;
  (el.querySelector('.jabs-pulse-meta') as HTMLElement).textContent = meta;
}

export function renderBrief(el: HTMLElement, brief: SessionBrief): void {
  el.classList.add('jabs-brief');
  const lines = brief.lines.map(() => `<li></li>`).join('');
  el.innerHTML = `<div class="jabs-brief-head"></div><ul class="jabs-brief-lines">${lines}</ul>`;
  (el.querySelector('.jabs-brief-head') as HTMLElement).textContent = brief.headline;
  const items = Array.from(el.querySelectorAll('.jabs-brief-lines li')) as HTMLLIElement[];
  brief.lines.forEach((line, i) => { if (items[i]) items[i].textContent = line; });
}

export function renderNudges(el: HTMLElement, nudges: Nudge[], onDismiss?: (key: string) => void): void {
  el.classList.add('jabs-nudges');
  if (nudges.length === 0) {
    el.innerHTML = `<div class="jabs-nudges-empty">No pending nudges.</div>`;
    return;
  }
  el.innerHTML = nudges.map((n) => `
    <div class="jabs-nudge" data-severity="${n.severity}" data-kind="${n.kind}" data-key="${n.dismissKey}">
      <div class="jabs-nudge-msg"></div>
      <button class="jabs-nudge-dismiss" type="button" aria-label="Dismiss">Dismiss</button>
    </div>
  `).join('');
  const cards = Array.from(el.querySelectorAll('.jabs-nudge')) as HTMLElement[];
  nudges.forEach((n, i) => {
    const card = cards[i];
    if (!card) return;
    (card.querySelector('.jabs-nudge-msg') as HTMLElement).textContent = n.message;
    card.querySelector('.jabs-nudge-dismiss')?.addEventListener('click', () => onDismiss?.(n.dismissKey));
  });
}

export function renderActions(el: HTMLElement, actions: QuickAction[], onRun?: (action: QuickAction) => void): void {
  el.classList.add('jabs-actions');
  el.innerHTML = actions.map((a) => `
    <button class="jabs-action" type="button" data-id="${a.id}" ${a.enabled ? '' : 'disabled'}>
      <span class="jabs-action-label"></span>
      <span class="jabs-action-hint"></span>
    </button>
  `).join('');
  const btns = Array.from(el.querySelectorAll('.jabs-action')) as HTMLButtonElement[];
  actions.forEach((a, i) => {
    const btn = btns[i];
    if (!btn) return;
    (btn.querySelector('.jabs-action-label') as HTMLElement).textContent = a.label;
    (btn.querySelector('.jabs-action-hint') as HTMLElement).textContent = a.hint || a.group;
    btn.addEventListener('click', () => onRun?.(a));
  });
}
