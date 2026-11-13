// Pure, deterministic presence signal detection and briefing summarization.
// No Date.now(), no timers, no I/O.

export type SignalKind = 'blocker' | 'done' | 'attention' | 'drift' | 'health';

export interface Signal {
  kind: SignalKind;
  key: string;
  text: string;
  severity: 'low' | 'medium' | 'high';
  at?: number;
}

export interface Briefing {
  headline: string;
  sinceLabel: string;
  highlights: string[];
  blockers: Array<{ text: string; severity: 'low' | 'medium' | 'high' }>;
  nextActions: string[];
}

export interface PresenceAgent {
  id?: string;
  name?: string;
  status?: string;
  state?: string;
  currentTaskId?: string;
  currentTask?: string;
  task?: string;
  taskStartedAt?: number | string | null;
  workingSince?: number | string | null;
  startedAt?: number | string | null;
  lastActiveAt?: number | string | null;
  updatedAt?: number | string | null;
}

export interface PresenceTask {
  id?: string;
  text?: string;
  title?: string;
  status?: string;
  agentId?: string | null;
  assignee?: string | null;
  blockedReason?: string | null;
  startedAt?: number | string | null;
  updatedAt?: number | string | null;
  completedAt?: number | string | null;
  doneAt?: number | string | null;
  runCount?: number;
}

export interface PresenceRun {
  id?: string;
  status?: string;
  agentId?: string | null;
  taskId?: string | null;
  startedAt?: number | string | null;
  updatedAt?: number | string | null;
  endedAt?: number | string | null;
  summary?: string | null;
}

export interface PresenceJob {
  id?: string;
  estado?: string;
  status?: string;
  state?: string;
  slug?: string;
  updatedAt?: number | string | null;
  actualizadoEn?: number | string | null;
  createdAt?: number | string | null;
  completedAt?: number | string | null;
  failedAt?: number | string | null;
  startedAt?: number | string | null;
  brief?: { objetivo?: string };
  summary?: { objetivo?: string };
  progress?: {
    estado?: string;
    phase?: string;
    updatedAt?: number | string | null;
    startedAt?: number | string | null;
  };
  motivo?: string | null;
  error?: string | null;
}

export interface PresenceApproval {
  id?: string;
  kind?: string;
  status?: string;
  text?: string;
  title?: string;
  reason?: string;
  createdAt?: number | string | null;
  requestedAt?: number | string | null;
}

export interface PresenceGoal {
  id?: string;
  title?: string;
  status?: string;
  tasks?: PresenceTask[];
}

export interface PresenceWork {
  company?: { id?: string; name?: string };
  team?: PresenceAgent[];
  goals?: PresenceGoal[];
  runs?: PresenceRun[];
  comments?: unknown[];
}

export interface PresenceLiveMeeting {
  meetingId?: string;
  companyId?: string;
  companyName?: string;
  goalTitle?: string | null;
  status?: string;
  turnCount?: number;
  lastActiveAt?: number | string | null;
  team?: PresenceAgent[];
}

export interface PresenceConnectivityCheck {
  name?: string;
  ok?: boolean;
  ms?: number;
  detail?: string;
}

export interface PresenceConnectivity {
  online?: boolean;
  status?: 'online' | 'degraded' | 'offline' | string;
  checks?: PresenceConnectivityCheck[];
  ts?: number;
}

export interface PresenceSnapshot {
  now: number;
  fetchedAt?: number;
  latencyMs?: number;
  live?: { live?: PresenceLiveMeeting[] };
  work?: PresenceWork | null;
  jobs?: PresenceJob[] | { jobs?: PresenceJob[] } | null;
  approvals?: PresenceApproval[] | { pending?: PresenceApproval[]; approvals?: PresenceApproval[] } | null;
  connectivity?: PresenceConnectivity | null;
  sidecars?: Array<{ name?: string; status?: string; downs?: number }> | { sidecars?: Array<{ name?: string; status?: string; downs?: number }> } | null;
  autoWorkOn?: boolean;
  queueDepth?: number;
  lastActivityAt?: number | string | null;
}

const WORKING_MS = 20 * 60 * 1000;
const HIGH_LATENCY_MS = 400;

function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function normStatus(value: unknown): string {
  return String(value || '').toLowerCase().trim();
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['jobs', 'pending', 'approvals', 'sidecars', 'live']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

function jobsOf(snapshot: PresenceSnapshot): PresenceJob[] {
  return asArray<PresenceJob>(snapshot.jobs);
}

function approvalsOf(snapshot: PresenceSnapshot): PresenceApproval[] {
  return asArray<PresenceApproval>(snapshot.approvals);
}

function sidecarsOf(snapshot: PresenceSnapshot): Array<{ name?: string; status?: string; downs?: number }> {
  return asArray<{ name?: string; status?: string; downs?: number }>(snapshot.sidecars);
}

function tasksOf(snapshot: PresenceSnapshot): PresenceTask[] {
  const goals = snapshot.work?.goals || [];
  const out: PresenceTask[] = [];
  for (const goal of goals) {
    for (const task of goal.tasks || []) out.push(task);
  }
  return out;
}

function teamOf(snapshot: PresenceSnapshot): PresenceAgent[] {
  const byId = new Map<string, PresenceAgent>();
  for (const agent of snapshot.work?.team || []) {
    const key = String(agent.id || agent.name || byId.size);
    byId.set(key, { ...byId.get(key), ...agent });
  }
  for (const meeting of snapshot.live?.live || []) {
    for (const agent of meeting.team || []) {
      const key = String(agent.id || agent.name || byId.size);
      byId.set(key, { ...byId.get(key), ...agent });
    }
  }
  return [...byId.values()];
}

function isDoneStatus(status: string): boolean {
  return ['done', 'done_ok', 'completed', 'complete', 'success', 'succeeded', 'finished'].includes(status);
}

function isFailedStatus(status: string): boolean {
  return ['failed', 'error', 'errored', 'blocked', 'cancelled', 'canceled', 'aborted'].includes(status);
}

function isActiveStatus(status: string): boolean {
  return ['in_progress', 'doing', 'active', 'running', 'working', 'started', 'en_progreso'].includes(status);
}

function isQueueStatus(status: string): boolean {
  return ['queued', 'pending', 'waiting', 'todo', 'ready'].includes(status);
}

function severityRank(sev: Signal['severity']): number {
  return sev === 'high' ? 3 : sev === 'medium' ? 2 : 1;
}

function kindRank(kind: SignalKind): number {
  return kind === 'blocker' ? 5 : kind === 'health' ? 4 : kind === 'attention' ? 3 : kind === 'drift' ? 2 : 1;
}

function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const ka = kindRank(a.kind) - kindRank(b.kind);
    if (ka !== 0) return -ka;
    const sa = severityRank(a.severity) - severityRank(b.severity);
    if (sa !== 0) return -sa;
    const ta = a.at ?? Number.POSITIVE_INFINITY;
    const tb = b.at ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.key.localeCompare(b.key);
  });
}

export function detectSignals(snapshot: PresenceSnapshot): Signal[] {
  const now = snapshot.now;
  const out: Signal[] = [];
  const seen = new Set<string>();
  const add = (signal: Signal): void => {
    if (seen.has(signal.key)) return;
    seen.add(signal.key);
    out.push(signal);
  };

  for (const job of jobsOf(snapshot)) {
    const status = normStatus(job.estado || job.status || job.state || job.progress?.estado);
    if (!isFailedStatus(status)) continue;
    const id = String(job.id || job.slug || 'job');
    const label = String(job.brief?.objetivo || job.summary?.objetivo || job.slug || job.id || 'job');
    const reason = String(job.motivo || job.error || '').trim();
    add({
      kind: 'blocker',
      key: `job-failed:${id}`,
      text: reason ? `Job failed: ${label} (${reason})` : `Job failed: ${label}`,
      severity: 'high',
      at: toMs(job.failedAt || job.actualizadoEn || job.updatedAt) ?? undefined
    });
  }

  for (const approval of approvalsOf(snapshot)) {
    const status = normStatus(approval.status);
    if (status && !['pending', 'open', 'requested', 'waiting'].includes(status)) continue;
    const id = String(approval.id || approval.title || approval.kind || 'approval');
    const label = String(approval.title || approval.text || approval.reason || approval.kind || 'Approval required');
    add({
      kind: 'blocker',
      key: `approval:${id}`,
      text: `Pending approval: ${label}`,
      severity: 'high',
      at: toMs(approval.requestedAt || approval.createdAt) ?? undefined
    });
  }

  for (const task of tasksOf(snapshot)) {
    const status = normStatus(task.status);
    if (status !== 'blocked' && !task.blockedReason) continue;
    const id = String(task.id || task.text || 'task');
    const label = String(task.text || task.title || task.id || 'task');
    const reason = String(task.blockedReason || '').trim();
    add({
      kind: 'blocker',
      key: `task-blocked:${id}`,
      text: reason ? `Task blocked: ${label} (${reason})` : `Task blocked: ${label}`,
      severity: 'high',
      at: toMs(task.updatedAt) ?? undefined
    });
  }

  for (const task of tasksOf(snapshot)) {
    const status = normStatus(task.status);
    if (!isActiveStatus(status)) continue;
    const started = toMs(task.startedAt);
    if (started === null || now - started <= WORKING_MS) continue;
    const id = String(task.id || task.text || 'task');
    const agent = String(task.agentId || task.assignee || 'agent');
    const label = String(task.text || task.title || task.id || 'task');
    add({
      kind: 'drift',
      key: `working-long:${agent}:${id}`,
      text: `Agent working >20m on same task: ${label}`,
      severity: 'medium',
      at: started
    });
  }

  for (const agent of teamOf(snapshot)) {
    const status = normStatus(agent.status || agent.state);
    if (!['working', 'busy', 'active', 'in_progress'].includes(status)) continue;
    const started = toMs(agent.taskStartedAt || agent.workingSince || agent.startedAt);
    if (started === null || now - started <= WORKING_MS) continue;
    const sameTask = String(agent.currentTaskId || agent.currentTask || agent.task || 'task');
    const label = String(agent.currentTask || agent.task || sameTask);
    const who = String(agent.name || agent.id || 'agent');
    add({
      kind: 'drift',
      key: `agent-working-long:${who}:${sameTask}`,
      text: `Agent working >20m on same task: ${who} on ${label}`,
      severity: 'medium',
      at: started
    });
  }

  for (const run of snapshot.work?.runs || []) {
    const status = normStatus(run.status);
    if (!['running', 'in_progress', 'active'].includes(status)) continue;
    const started = toMs(run.startedAt);
    if (started === null || now - started <= WORKING_MS) continue;
    const taskId = String(run.taskId || run.id || 'task');
    const agent = String(run.agentId || 'agent');
    add({
      kind: 'drift',
      key: `run-working-long:${agent}:${taskId}`,
      text: `Agent working >20m on same task: run ${taskId}`,
      severity: 'medium',
      at: started
    });
  }

  if (typeof snapshot.latencyMs === 'number' && snapshot.latencyMs > HIGH_LATENCY_MS) {
    add({
      kind: 'health',
      key: 'latency:backend',
      text: `High backend latency: ${Math.round(snapshot.latencyMs)}ms`,
      severity: snapshot.latencyMs > 1200 ? 'high' : 'medium',
      at: snapshot.fetchedAt ?? now
    });
  }

  for (const check of snapshot.connectivity?.checks || []) {
    if (typeof check.ms === 'number' && check.ms > HIGH_LATENCY_MS) {
      add({
        kind: 'health',
        key: `latency:check:${String(check.name || 'backend')}`,
        text: `High backend latency: ${String(check.name || 'check')} ${Math.round(check.ms)}ms`,
        severity: check.ms > 1200 ? 'high' : 'medium',
        at: snapshot.connectivity?.ts
      });
    }
  }

  for (const sidecar of sidecarsOf(snapshot)) {
    const status = normStatus(sidecar.status);
    if (status && ['up', 'healthy', 'running', 'ok'].includes(status)) continue;
    add({
      kind: 'health',
      key: `sidecar:${String(sidecar.name || 'sidecar')}`,
      text: `Sidecar unhealthy: ${String(sidecar.name || 'sidecar')} (${status || 'unknown'})`,
      severity: 'medium'
    });
  }

  const lastSeen = Number.isFinite((snapshot as { lastSeenAt?: number }).lastSeenAt)
    ? ((snapshot as { lastSeenAt?: number }).lastSeenAt as number)
    : null;

  for (const job of jobsOf(snapshot)) {
    const status = normStatus(job.estado || job.status || job.state || job.progress?.estado);
    if (!isDoneStatus(status)) continue;
    const at = toMs(job.completedAt || job.actualizadoEn || job.updatedAt);
    if (lastSeen !== null && (at === null || at <= lastSeen)) continue;
    const id = String(job.id || job.slug || 'job');
    const label = String(job.brief?.objetivo || job.summary?.objetivo || job.slug || job.id || 'job');
    add({ kind: 'done', key: `job-done:${id}`, text: `Completed since last seen: ${label}`, severity: 'low', at: at ?? undefined });
  }

  for (const task of tasksOf(snapshot)) {
    const status = normStatus(task.status);
    if (!isDoneStatus(status)) continue;
    const at = toMs(task.completedAt || task.doneAt || task.updatedAt);
    if (lastSeen !== null && (at === null || at <= lastSeen)) continue;
    const id = String(task.id || task.text || 'task');
    const label = String(task.text || task.title || task.id || 'task');
    add({ kind: 'done', key: `task-done:${id}`, text: `Completed since last seen: ${label}`, severity: 'low', at: at ?? undefined });
  }

  const queueItems = jobsOf(snapshot).filter((j) => isQueueStatus(normStatus(j.estado || j.status || j.state || j.progress?.estado)));
  const queuedTasks = tasksOf(snapshot).filter((t) => isQueueStatus(normStatus(t.status)));
  const queueDepth = typeof snapshot.queueDepth === 'number' ? snapshot.queueDepth : queueItems.length + queuedTasks.length;
  const team = teamOf(snapshot);
  const activeWorkers = team.filter((a) => ['working', 'busy', 'active', 'in_progress', 'speaking', 'thinking'].includes(normStatus(a.status || a.state))).length;
  const liveBusy = (snapshot.live?.live || []).length;
  if (queueDepth > 0 && snapshot.autoWorkOn === true && activeWorkers === 0 && liveBusy === 0) {
    add({
      kind: 'attention',
      key: 'queue-idle:auto-on',
      text: `Idle team with non-empty queue while auto work is on (${queueDepth} queued)`,
      severity: 'medium'
    });
  }

  return sortSignals(out);
}

export function summarize(snapshot: PresenceSnapshot, lastSeenAt?: number | null): Briefing {
  const enriched: PresenceSnapshot & { lastSeenAt?: number } =
    lastSeenAt !== null && lastSeenAt !== undefined ? { ...snapshot, lastSeenAt } : snapshot;
  const signals = detectSignals(enriched);
  const blockers = signals
    .filter((s) => s.kind === 'blocker')
    .map((s) => ({ text: s.text, severity: s.severity }));
  const highlights = signals
    .filter((s) => s.kind === 'done' || s.kind === 'attention')
    .slice(0, 4)
    .map((s) => s.text);
  const healthNotes = signals.filter((s) => s.kind === 'health' || s.kind === 'drift').map((s) => s.text);
  for (const note of healthNotes) {
    if (highlights.length >= 4) break;
    if (!highlights.includes(note)) highlights.push(note);
  }

  const nextActions: string[] = [];
  if (signals.some((s) => s.key.startsWith('job-failed:'))) nextActions.push('Inspect failed jobs and retry or unblock the cause.');
  if (signals.some((s) => s.key.startsWith('approval:'))) nextActions.push('Review pending approvals to unblock execution.');
  if (signals.some((s) => s.key.startsWith('task-blocked:'))) nextActions.push('Clear blocked tasks with missing input or fixes.');
  if (signals.some((s) => s.kind === 'drift')) nextActions.push('Check long-running work for drift or a stuck task.');
  if (signals.some((s) => s.kind === 'attention')) nextActions.push('Verify the worker loop is running and picking up queued work.');
  if (signals.some((s) => s.kind === 'health')) nextActions.push('Investigate backend or sidecar health before queueing more work.');
  if (nextActions.length === 0) nextActions.push('No urgent action. Continue monitoring the current queue.');

  const doneCount = signals.filter((s) => s.kind === 'done').length;
  const headline = blockers.length > 0
    ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} ${blockers.length === 1 ? 'needs' : 'need'} attention`
    : signals.some((s) => s.kind === 'attention' || s.kind === 'health' || s.kind === 'drift')
      ? 'Attention needed'
      : doneCount > 0
        ? `${doneCount} update${doneCount === 1 ? '' : 's'} since last check`
        : 'All clear';

  const sinceLabel = formatSinceLabel(snapshot.now, lastSeenAt);

  return { headline, sinceLabel, highlights, blockers, nextActions };
}

export function formatSinceLabel(now: number, lastSeenAt?: number | null): string {
  if (lastSeenAt === null || lastSeenAt === undefined || !Number.isFinite(lastSeenAt)) {
    return 'Since last check: unknown';
  }
  const diff = Math.max(0, now - lastSeenAt);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Since last check: just now';
  if (min < 60) return `Since last check: ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rem = min % 60;
    return rem ? `Since last check: ${h}h ${rem}m ago` : `Since last check: ${h}h ago`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `Since last check: ${d}d ${remH}h ago` : `Since last check: ${d}d ago`;
}

export function countBlockers(signals: Signal[]): number {
  return signals.filter((s) => s.kind === 'blocker').length;
}
