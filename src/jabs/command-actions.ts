// Context-aware quick actions as a pure data model for a command palette.
// No side effects: consumers decide how to execute/dispatch.

import type { PulseLiveMeeting, PulseTask, PulseGoal, PulseWork } from './insights.ts';

export interface ActionContext {
  live: PulseLiveMeeting[];
  work: PulseWork | null;
  selectedGoalId?: string | null;
  selectedTaskId?: string | null;
  now?: number;
}

export interface QuickAction {
  id: string;
  label: string;
  hint?: string;
  group: 'resume' | 'jump' | 'review' | 'project' | 'system';
  priority: number;
  intent:
    | 'jump.active_agent'
    | 'jump.meeting'
    | 'open.blocker'
    | 'resume.task'
    | 'review.task'
    | 'open.project'
    | 'start.project'
    | 'refresh.pulse';
  payload: Record<string, unknown>;
  enabled: boolean;
  reason?: string;
}

function normStatus(s: string | undefined | null): string {
  return String(s || '').toLowerCase().trim();
}

function flatten(work: PulseWork | null): Array<{ task: PulseTask; goal: PulseGoal }> {
  if (!work) return [];
  const out: Array<{ task: PulseTask; goal: PulseGoal }> = [];
  for (const goal of work.goals || []) {
    for (const task of goal.tasks || []) out.push({ task, goal });
  }
  return out;
}

export function deriveQuickActions(ctx: ActionContext): QuickAction[] {
  const actions: QuickAction[] = [];
  const all = flatten(ctx.work);
  const live = ctx.live || [];

  for (const meeting of live.slice(0, 3)) {
    const focus = meeting.goalTitle || meeting.companyName || 'session';
    actions.push({
      id: `jump-meeting:${meeting.meetingId}`,
      label: `Jump to live session: ${focus}`,
      hint: 'Go',
      group: 'jump',
      priority: 10,
      intent: 'jump.meeting',
      payload: { meetingId: meeting.meetingId, companyId: meeting.companyId },
      enabled: true
    });
    const firstMember = (meeting.team || [])[0];
    if (firstMember) {
      actions.push({
        id: `jump-agent:${meeting.meetingId}:${firstMember.id}`,
        label: `Jump to active agent: ${firstMember.name}`,
        hint: 'Go',
        group: 'jump',
        priority: 12,
        intent: 'jump.active_agent',
        payload: { meetingId: meeting.meetingId, agentId: firstMember.id, agentName: firstMember.name },
        enabled: true
      });
    }
  }

  for (const { task, goal } of all) {
    const s = normStatus(task.status);
    const blocked = s === 'blocked' || s === 'failed' || Boolean(task.blockedReason);
    const review = s === 'review' || s === 'needs_review' || s === 'unreviewed' || s === 'done_pending_review';
    const resumable = blocked || s === 'paused' || s === 'stalled' || s === 'error';

    if (blocked) {
      actions.push({
        id: `open-blocker:${task.id}`,
        label: `Open blocker: ${task.text}`,
        hint: 'Inspect',
        group: 'resume',
        priority: 20,
        intent: 'open.blocker',
        payload: { taskId: task.id, goalId: goal.id, blockedReason: task.blockedReason || null },
        enabled: true
      });
    }
    if (resumable) {
      actions.push({
        id: `resume:${task.id}`,
        label: `Resume: ${task.text}`,
        hint: 'Run',
        group: 'resume',
        priority: 22,
        intent: 'resume.task',
        payload: { taskId: task.id, goalId: goal.id, status: task.status },
        enabled: true
      });
    }
    if (review) {
      actions.push({
        id: `review:${task.id}`,
        label: `Review result: ${task.text}`,
        hint: 'Review',
        group: 'review',
        priority: 30,
        intent: 'review.task',
        payload: { taskId: task.id, goalId: goal.id },
        enabled: true
      });
    }
  }

  const goals = ctx.work?.goals || [];
  for (const goal of goals.slice(0, 5)) {
    const hasPending = (goal.tasks || []).some((t) => ['pending', 'queued', 'todo', 'open', 'blocked', 'failed', 'paused'].includes(normStatus(t.status)));
    actions.push({
      id: `open-project:${goal.id}`,
      label: `Open project: ${goal.title}`,
      hint: 'Open',
      group: 'project',
      priority: 40,
      intent: 'open.project',
      payload: { goalId: goal.id, companyId: ctx.work?.company.id || null },
      enabled: true
    });
    if (hasPending) {
      actions.push({
        id: `start-project:${goal.id}`,
        label: `Start project work: ${goal.title}`,
        hint: 'Start',
        group: 'project',
        priority: 42,
        intent: 'start.project',
        payload: { goalId: goal.id, companyId: ctx.work?.company.id || null },
        enabled: true
      });
    }
  }

  actions.push({
    id: 'refresh-pulse',
    label: 'Refresh mission pulse',
    hint: 'Sync',
    group: 'system',
    priority: 90,
    intent: 'refresh.pulse',
    payload: {},
    enabled: true
  });

  actions.sort((a, b) => (a.priority - b.priority) || a.label.localeCompare(b.label));
  return actions;
}

export function toPaletteItems(actions: QuickAction[]): Array<{
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  action: QuickAction;
}> {
  return actions.map((a) => ({
    id: a.id,
    title: a.label,
    subtitle: a.hint,
    keywords: [a.group, a.intent, a.hint || ''].filter(Boolean),
    action: a
  }));
}
