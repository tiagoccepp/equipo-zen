// Mission Control — lógica pura (formateo, parse, resumen). Sin DOM ni fetch.

export interface TaskSummary {
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
}

export interface SopSummary {
  rules: number;
  order: string | null;
  maxRounds: number | null;
  agentTimeoutMs: number | null;
  r2: string | null;
  firstRules: string[];
}

const DONE = new Set(['done', 'done_ok', 'completed']);
const ACTIVE = new Set(['in_progress', 'doing', 'active', 'running']);
const BLOCKED = new Set(['blocked', 'failed', 'error']);

/** 850 → "850 ms", 1500 → "1.5 s", null/NaN → "—". */
export function fmtMs(value: unknown): string {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    return '—';
  }
  if (n < 1000) {
    return `${Math.round(n)} ms`;
  }
  const s = n / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)} s`;
}

/** ISO → "hace 3 min" / "hace 2 h" / "—" si inválido. `now` inyectable para tests. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) {
    return '—';
  }
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) {
    return 'ahora';
  }
  if (min < 60) {
    return `hace ${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `hace ${h} h`;
  }
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

/** Clase CSS de pill según estado genérico. */
export function pillClass(status: string | null | undefined): 'ok' | 'warn' | 'bad' | 'mute' {
  const s = String(status || '').toLowerCase();
  if (['up', 'healthy', 'done', 'active', 'live', 'on', 'true', 'speaking'].includes(s)) {
    return 'ok';
  }
  if (['down', 'failed', 'error', 'blocked', 'off', 'false'].includes(s)) {
    return 'bad';
  }
  if (['unknown', 'idle', 'pending', 'standby', 'degraded', ''].includes(s)) {
    return 'mute';
  }
  return 'warn';
}

/** Punto "up hace X" para sidecars: edad desde lastSpawnAt. */
export function uptimeSince(lastSpawnAt: string | null | undefined, now = Date.now()): string {
  if (!lastSpawnAt) {
    return '—';
  }
  const t = new Date(lastSpawnAt).getTime();
  if (!Number.isFinite(t)) {
    return '—';
  }
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) {
    return 'up <1 min';
  }
  if (min < 60) {
    return `up ${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `up ${h} h`;
  }
  return `up ${Math.floor(h / 24)} d`;
}

export function summarizeTasks(tasks: Array<{ status: string }>): TaskSummary {
  const out: TaskSummary = { total: tasks.length, done: 0, active: 0, blocked: 0, pending: 0 };
  for (const t of tasks) {
    const s = String(t.status || '').toLowerCase();
    if (DONE.has(s)) {
      out.done += 1;
    } else if (ACTIVE.has(s)) {
      out.active += 1;
    } else if (BLOCKED.has(s)) {
      out.blocked += 1;
    } else {
      out.pending += 1;
    }
  }
  return out;
}

/** Elige empresa: 'Pablo'/'Sofia' legacy primero, si no la primera. */
export function pickCompany(companies: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  if (!companies.length) {
    return null;
  }
  return companies.find((c) => c.name === 'Pablo' || c.name === 'Sofia') || companies[0];
}

/** Resume el SOP: cuenta reglas S# + knobs (order/max_rounds/agent_timeout_ms/r2). */
export function parseSopSummary(sopText: string | null | undefined): SopSummary {
  const out: SopSummary = {
    rules: 0,
    order: null,
    maxRounds: null,
    agentTimeoutMs: null,
    r2: null,
    firstRules: []
  };
  if (!sopText) {
    return out;
  }
  for (const raw of String(sopText).split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (/^S\d+\s/i.test(line)) {
      out.rules += 1;
      if (out.firstRules.length < 3) {
        out.firstRules.push(line.length > 64 ? line.slice(0, 61) + '…' : line);
      }
      continue;
    }
    const knob = line.match(/^([a-z0-9_]+)\s*:\s*(.+)$/i);
    if (!knob) {
      continue;
    }
    const key = knob[1].toLowerCase();
    const val = knob[2].trim();
    if (key === 'order') {
      out.order = val;
    } else if (key === 'max_rounds') {
      const n = Number(val);
      if (Number.isFinite(n)) {
        out.maxRounds = n;
      }
    } else if (key === 'agent_timeout_ms') {
      const n = Number(val);
      if (Number.isFinite(n)) {
        out.agentTimeoutMs = n;
      }
    } else if (key === 'r2') {
      out.r2 = val;
    }
  }
  return out;
}

/** 0.73 → "73%", null/NaN → "—". */
export function fmtVol(value: unknown): string {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    return '—';
  }
  return `${Math.round(n * 100)}%`;
}

/** Nodo default (isDefault) o el primero; null si vacío. */
export function defaultNode<T extends { isDefault?: boolean }>(nodes: T[]): T | null {
  if (!nodes.length) {
    return null;
  }
  return nodes.find((n) => n.isDefault === true) || nodes[0];
}

/** Escape mínimo para interpolar texto del server en HTML. */
export function esc(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
