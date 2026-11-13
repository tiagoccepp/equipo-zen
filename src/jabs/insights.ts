// Pure, deterministic insight engines for J.A.B.S.
// No DOM, no timers, no fetching: inputs in, synthesized state out.

export interface PulseLiveMember {
  id: string;
  name: string;
}

export interface PulseLiveMeeting {
  meetingId: string;
  companyId: string;
  companyName: string;
  goalTitle?: string | null;
  status?: string;
  lastActiveAt?: string | null;
  team?: PulseLiveMember[];
}

export interface PulseTask {
  id: string;
  text: string;
  status: string;
  agentId?: string | null;
  blockedReason?: string | null;
}

export interface PulseGoal {
  id: string;
  title: string;
  status: string;
  tasks: PulseTask[];
}

export interface PulseWork {
  company: { id: string; name: string };
  team?: PulseLiveMember[];
  goals: PulseGoal[];
}

export interface PulseSnapshot {
  live: PulseLiveMeeting[];
  work: PulseWork | null;
  now?: number;
}

export type PulseLevel = 'calm' | 'active' | 'attention';

export interface MissionPulse {
  text: string;
  level: PulseLevel;
  signals: {
    liveMeetings: number;
    activeAgents: number;
    blockedTasks: number;
    inProgressTasks: number;
    pendingTasks: number;
  };
}

export interface SessionBrief {
  headline: string;
  lines: string[];
  awayMs: number;
  lastSeenAt: number | null;
}

export interface Nudge {
  id: string;
  kind: 'stalled' | 'blocked' | 'review' | 'silence' | 'queue';
  severity: 'info' | 'warn';
  message: string;
  dismissKey: string;
  subject?: { type: 'task' | 'goal' | 'meeting'; id: string; label: string };
}

export interface NudgeInput {
  live: PulseLiveMeeting[];
  work: PulseWork | null;
  now?: number;
  dismissed?: string[];
  staleAfterMs?: number;
}

const DEFAULT_STALE_MS = 8 * 60 * 1000;

function normStatus(s: string | undefined | null): string {
  return String(s || '').toLowerCase().trim();
}

function ago(ms: number): string {
  if (ms < 60_000) return 'moments ago';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function collectTasks(work: PulseWork | null): Array<{ task: PulseTask; goal: PulseGoal }> {
  if (!work) return [];
  const out: Array<{ task: PulseTask; goal: PulseGoal }> = [];
  for (const goal of work.goals || []) {
    for (const task of goal.tasks || []) out.push({ task, goal });
  }
  return out;
}

export function synthesizePulse(snapshot: PulseSnapshot): MissionPulse {
  const live = snapshot.live || [];
  const all = collectTasks(snapshot.work);
  const blocked = all.filter(({ task }) => {
    const s = normStatus(task.status);
    return s === 'blocked' || s === 'failed' || Boolean(task.blockedReason);
  });
  const inProgress = all.filter(({ task }) => {
    const s = normStatus(task.status);
    return s === 'in_progress' || s === 'running' || s === 'working' || s === 'active';
  });
  const pending = all.filter(({ task }) => {
    const s = normStatus(task.status);
    return s === 'pending' || s === 'queued' || s === 'todo' || s === 'open';
  });
  const review = all.filter(({ task }) => {
    const s = normStatus(task.status);
    return s === 'review' || s === 'needs_review' || s === 'unreviewed' || s === 'done_pending_review';
  });

  const activeAgents = new Set<string>();
  for (const m of live) for (const member of m.team || []) activeAgents.add(member.id);

  const signals = {
    liveMeetings: live.length,
    activeAgents: activeAgents.size,
    blockedTasks: blocked.length,
    inProgressTasks: inProgress.length,
    pendingTasks: pending.length
  };

  const parts: string[] = [];
  if (live.length === 0 && inProgress.length === 0 && blocked.length === 0 && pending.length === 0) {
    parts.push('Systems steady. No active work in view.');
  } else {
    if (live.length > 0) {
      const focus = live[0]?.goalTitle || live[0]?.companyName || 'current session';
      parts.push(live.length === 1 ? `Session live on ${focus}` : `${live.length} sessions live, led by ${focus}`);
    } else {
      parts.push('No live session');
    }
    if (inProgress.length > 0) parts.push(`${inProgress.length} in motion`);
    if (pending.length > 0) parts.push(`${pending.length} queued`);
    if (review.length > 0) parts.push(`${review.length} awaiting review`);
    if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
  }

  const level: PulseLevel = blocked.length > 0 ? 'attention' : (live.length > 0 || inProgress.length > 0) ? 'active' : 'calm';
  const text = parts.join(' · ');
  return { text, level, signals };
}

export function detectNudges(input: NudgeInput): Nudge[] {
  const now = input.now ?? Date.now();
  const dismissed = new Set(input.dismissed || []);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_MS;
  const nudges: Nudge[] = [];
  const all = collectTasks(input.work);

  for (const { task, goal } of all) {
    const s = normStatus(task.status);
    if (s === 'blocked' || s === 'failed' || task.blockedReason) {
      const reason = task.blockedReason ? `: ${task.blockedReason}` : '';
      nudges.push({
        id: `blocked:${task.id}`,
        kind: 'blocked',
        severity: 'warn',
        message: `Blocked in "${goal.title}" — ${task.text}${reason}`,
        dismissKey: `blocked:${task.id}`,
        subject: { type: 'task', id: task.id, label: task.text }
      });
    }
    if (s === 'review' || s === 'needs_review' || s === 'unreviewed' || s === 'done_pending_review') {
      nudges.push({
        id: `review:${task.id}`,
        kind: 'review',
        severity: 'info',
        message: `Ready for review in "${goal.title}" — ${task.text}`,
        dismissKey: `review:${task.id}`,
        subject: { type: 'task', id: task.id, label: task.text }
      });
    }
  }

  for (const meeting of input.live || []) {
    const last = parseTs(meeting.lastActiveAt);
    if (last != null && now - last > staleAfterMs) {
      const focus = meeting.goalTitle || meeting.companyName || 'session';
      nudges.push({
        id: `silence:${meeting.meetingId}`,
        kind: 'silence',
        severity: 'info',
        message: `Quiet for a while on ${focus} (last activity ${ago(now - last)})`,
        dismissKey: `silence:${meeting.meetingId}`,
        subject: { type: 'meeting', id: meeting.meetingId, label: focus }
      });
    }
  }

  const inProgress = all.some(({ task }) => ['in_progress', 'running', 'working', 'active'].includes(normStatus(task.status)));
  const pendingCount = all.filter(({ task }) => ['pending', 'queued', 'todo', 'open'].includes(normStatus(task.status))).length;
  if ((input.live || []).length === 0 && !inProgress && pendingCount > 0) {
    nudges.push({
      id: 'queue:stalled',
      kind: 'queue',
      severity: 'info',
      message: `${pendingCount} task${pendingCount === 1 ? '' : 's'} queued with no active session`,
      dismissKey: 'queue:stalled'
    });
  }

  const kindOrder: Record<Nudge['kind'], number> = { blocked: 0, stalled: 1, review: 2, silence: 3, queue: 4 };
  nudges.sort((a, b) => {
    const sev = (a.severity === 'warn' ? 0 : 1) - (b.severity === 'warn' ? 0 : 1);
    if (sev !== 0) return sev;
    const ko = kindOrder[a.kind] - kindOrder[b.kind];
    if (ko !== 0) return ko;
    return a.id.localeCompare(b.id);
  });

  return nudges.filter((n) => !dismissed.has(n.dismissKey));
}

export interface SessionBriefInput {
  lastSeenAt: number | null;
  now?: number;
  live: PulseLiveMeeting[];
  work: PulseWork | null;
  previousTaskStatus?: Record<string, string>;
}

export function buildSessionBrief(input: SessionBriefInput): SessionBrief {
  const now = input.now ?? Date.now();
  const lastSeenAt = input.lastSeenAt;
  const awayMs = lastSeenAt != null ? Math.max(0, now - lastSeenAt) : 0;
  const all = collectTasks(input.work);
  const lines: string[] = [];

  if (lastSeenAt == null) {
    return {
      headline: 'First look this session',
      lines: ['A quiet summary will be ready on your return.'],
      awayMs: 0,
      lastSeenAt: null
    };
  }

  const liveCount = (input.live || []).length;
  if (liveCount > 0) {
    const focus = input.live[0]?.goalTitle || input.live[0]?.companyName;
    lines.push(liveCount === 1 ? `Live now: ${focus || 'an active session'}.` : `${liveCount} sessions currently live.`);
  }

  const blocked = all.filter(({ task }) => ['blocked', 'failed'].includes(normStatus(task.status)) || task.blockedReason);
  const review = all.filter(({ task }) => ['review', 'needs_review', 'unreviewed', 'done_pending_review'].includes(normStatus(task.status)));
  if (blocked.length > 0) lines.push(`${blocked.length} item${blocked.length === 1 ? '' : 's'} need attention (blocked).`);
  if (review.length > 0) lines.push(`${review.length} item${review.length === 1 ? '' : 's'} ready for review.`);

  const prev = input.previousTaskStatus || {};
  const changed: string[] = [];
  for (const { task, goal } of all) {
    const before = prev[task.id];
    if (!before) continue;
    if (normStatus(before) !== normStatus(task.status)) {
      changed.push(`${task.text} (${goal.title}): ${before} → ${task.status}`);
    }
  }
  if (changed.length > 0) {
    lines.push(`Status changes since last check: ${changed.slice(0, 3).join('; ')}${changed.length > 3 ? ` (+${changed.length - 3} more)` : ''}.`);
  }

  if (lines.length === 0) {
    const total = all.length;
    lines.push(total > 0 ? `${total} tracked item${total === 1 ? '' : 's'}; no notable changes detected.` : 'No tracked work items yet.');
  }

  const headline = awayMs >= 60_000
    ? `While you were away (${ago(awayMs)})`
    : 'Quick status since your last check';

  return { headline, lines, awayMs, lastSeenAt };
}
