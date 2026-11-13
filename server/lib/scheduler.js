// E-13: scheduler built-in — cron, intervalos, once y watchers, por
// proyecto o globales. Jobs en DB (sobreviven restarts); tick cada 30s;
// acciones: notify (→ outbox + subscribers; channels en E-18), task_create,
// dreaming. Casos concretos los define Tito después (esto es genérico).

export const SCHED_TICK_MS = 30000;
export const SCHED_JOB_TIMEOUT_MS = 120000;

// --- cron mínimo (5 campos, UTC-local del server) ---
function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field || '').trim().split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Math.max(1, Number(stepStr) || 1) : 1;
    let lo = min;
    let hi = max;
    if (range && range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isFinite(a)) {
        throw new Error(`cron inválido: ${field}`);
      }
      lo = a;
      hi = Number.isFinite(b) ? b : a;
    }
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) {
        out.add(v);
      }
    }
  }
  return out;
}

export function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('cron: se esperan 5 campos (m h dom mon dow)');
  }
  const [mi, h, dom, mon, dow] = fields;
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: parseField(dow, 0, 6)
  };
}

export function nextCronRun(expr, fromMs = Date.now()) {
  const c = parseCron(expr);
  // Domingos: cron 0/7 ambos valen.
  const dowHas = (d) => c.dow.has(d) || (d === 0 && c.dow.has(7));
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = t + 366 * 24 * 60 * 60000;
  while (t <= limit) {
    const d = new Date(t);
    if (c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) &&
        c.dom.has(d.getDate()) && c.month.has(d.getMonth() + 1) && dowHas(d.getDay())) {
      return t;
    }
    t += 60000;
  }
  return null;
}

export function nextRunFor(job, fromMs = Date.now()) {
  if (!job || job.enabled === false || job.enabled === 0) {
    return null;
  }
  const kind = job.kind;
  if (kind === 'interval') {
    const everyMs = Number(job.spec?.everyMs || job.spec?.every || 0);
    if (!(everyMs > 0)) {
      return null;
    }
    const base = Number(job.lastRun) > 0 ? Number(job.lastRun) : fromMs;
    return base + everyMs <= fromMs ? fromMs + 1000 : base + everyMs;
  }
  if (kind === 'once') {
    const at = Number(job.spec?.at || 0);
    return at > fromMs ? at : null;
  }
  if (kind === 'cron') {
    try {
      return nextCronRun(job.spec?.expr || '', fromMs);
    } catch {
      return null;
    }
  }
  if (kind === 'watcher') {
    return fromMs + SCHED_TICK_MS; // se evalúa cada tick
  }
  return null;
}

// --- watcher: hash barato de archivo/dir (mtime+size) ---
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function watcherFingerprint(target) {
  try {
    const st = statSync(target);
    if (!st.isDirectory()) {
      return `${st.mtimeMs}:${st.size}`;
    }
    const names = readdirSync(target).sort().slice(0, 200);
    const parts = names.map((n) => {
      try {
        const s = statSync(join(target, n));
        return `${n}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${n}:x`;
      }
    });
    return parts.join('|');
  } catch {
    return null;
  }
}

// --- runner ---
const subscribers = new Set();
const outbox = [];

export function onScheduledNotify(fn) {
  if (typeof fn === 'function') {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
  return () => {};
}

export function scheduledOutbox() {
  return [...outbox];
}

export function __resetSchedulerState() {
  subscribers.clear();
  outbox.length = 0;
}

async function runJobAction({ store, job }) {
  const action = job.action || {};
  const detail = { jobId: job.id, name: job.name, goalId: job.goal_id || null };
  if (action.type === 'notify') {
    const entry = {
      at: new Date().toISOString(),
      jobId: job.id,
      name: job.name,
      goalId: job.goal_id || null,
      text: String(action.text || job.name || 'recordatorio').slice(0, 500)
    };
    outbox.push(entry);
    while (outbox.length > 100) {
      outbox.shift();
    }
    for (const fn of subscribers) {
      try {
        await fn(entry);
      } catch { /* subscriber caído no frena */ }
    }
    // E-18: además va al channel + voz si corresponde.
    try {
      const { dispatchNotification, settingsAnnounce } = await import('./notifications.js');
      await dispatchNotification({
        title: entry.text,
        detail: `job ${job.name} (${job.id})`,
        goalId: job.goal_id || null,
        announce: settingsAnnounce
      });
    } catch { /* notify caído no frena el job */ }
    return { notified: true };
  }
  if (action.type === 'task_create') {
    const text = String(action.text || job.name || 'tarea programada').slice(0, 500);
    const id = `task-${Date.now().toString(36)}`;
    store._prepare(`
      INSERT INTO tasks (id, meeting_id, agent_id, text, completed, created_at, goal_id, kind, status)
      VALUES (?, NULL, 'unassigned', ?, 0, ?, ?, 'entregable', 'pending')
    `).run(id, text, new Date().toISOString(), job.goal_id || null);
    return { taskId: id };
  }
  if (action.type === 'plan_auto') {
    const { planAutoProceed } = await import('./plan-mode.js');
    const r = await planAutoProceed(store, action.planId);
    return { planAuto: r };
  }
  if (action.type === 'dreaming') {
    const { dreamCycle } = await import('./dreaming.js');
    const report = await dreamCycle({ store, dryRun: action.dryRun === true });
    return { dreaming: report };
  }
  return { skipped: `acción desconocida: ${action.type}` };
}

export async function runDueJobs({ store, nowMs = Date.now() } = {}) {
  if (!store) {
    throw new Error('runDueJobs necesita store');
  }
  const ran = [];
  let jobs = [];
  try {
    jobs = store._prepare("SELECT * FROM sched_jobs WHERE enabled = 1").all();
  } catch {
    return ran;
  }
  for (const row of jobs) {
    let job;
    try {
      job = {
        ...row,
        spec: JSON.parse(row.spec_json || '{}'),
        action: JSON.parse(row.action_json || '{}')
      };
    } catch {
      continue;
    }
    // Watcher: dispara solo si cambió el fingerprint.
    if (job.kind === 'watcher') {
      const fp = watcherFingerprint(job.spec?.path || '');
      const prev = job.spec?.lastFp || null;
      if (fp === null || fp === prev) {
        continue;
      }
      job.spec.lastFp = fp;
      try {
        store._prepare('UPDATE sched_jobs SET spec_json = ? WHERE id = ?').run(JSON.stringify(job.spec), job.id);
      } catch { /* best-effort */ }
    } else {
      const next = nextRunFor({ ...job, enabled: true }, nowMs);
      const storedNext = Number(job.next_run) || 0;
      if (storedNext > nowMs) {
        continue;
      }
      if (next === null && job.kind === 'once') {
        // Once vencido sin correr: deshabilitar para no reintentar eterno.
        try {
          store._prepare('UPDATE sched_jobs SET enabled = 0 WHERE id = ?').run(job.id);
        } catch { /* best-effort */ }
        continue;
      }
    }
    try {
      const result = await runJobAction({ store, job });
      const after = job.kind === 'watcher' ? null : nextRunFor({ ...job, lastRun: nowMs }, nowMs);
      store._prepare('UPDATE sched_jobs SET last_run = ?, next_run = ?, runs = runs + 1, last_result = ? WHERE id = ?')
        .run(nowMs, after, JSON.stringify(result).slice(0, 1000), job.id);
      ran.push({ id: job.id, name: job.name, result });
    } catch (error) {
      try {
        store._prepare('UPDATE sched_jobs SET last_run = ?, last_result = ? WHERE id = ?')
          .run(nowMs, JSON.stringify({ error: String(error?.message || error).slice(0, 300) }), job.id);
      } catch { /* best-effort */ }
      ran.push({ id: job.id, name: job.name, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return ran;
}

let tickTimer = null;

export function startScheduler({ store, tickMs = SCHED_TICK_MS } = {}) {
  stopScheduler();
  if (!store) {
    throw new Error('startScheduler necesita store');
  }
  const tick = () => {
    runDueJobs({ store }).catch(() => {});
  };
  tickTimer = setInterval(tick, tickMs);
  tickTimer.unref?.();
  // Primera pasada diferida (no frena el boot).
  const first = setTimeout(tick, 5000);
  first.unref?.();
  return () => stopScheduler();
}

export function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
