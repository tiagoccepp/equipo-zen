import type { CompanyWork, MissionLive, MissionTask } from '../types.ts';

export type AgentState = 'idle' | 'working' | 'speaking' | 'blocked' | 'offline';

export interface OfficeAgent {
  id: string;
  name: string;
  title: string;
  color: string;
  projectId: string;
  state: AgentState;
  label: string;
  deskX: number;
  deskY: number;
  currentTask: string | null;
}

export interface OfficeActivity {
  id: string;
  text: string;
  status: string;
  agentName: string | null;
  agentId: string | null;
  blockedReason: string | null;
  goal: string;
}

export interface OfficeRoom {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  agents: OfficeAgent[];
  goal: string;
  taskSummary: string;
  live: boolean;
  meetingStatus: string | null;
  lastActiveAt: string | null;
  turnCount: number;
  activities: OfficeActivity[];
  stats: { total: number; active: number; blocked: number; done: number; pending: number };
}

export interface OfficeWorld {
  rooms: OfficeRoom[];
  width: number;
  height: number;
}

const ROOM_PAD = 18;
const ROOM_HEADER = 28;
const DESK_W = 92;
const DESK_H = 50;
const COLS = 3;
const ROOM_W = 332;
const ROOM_H_BASE = 132;

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 58% 60%)`;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asText(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function normStatus(v: unknown): string {
  return asText(v).toLowerCase().trim();
}

function isDone(st: string): boolean { return /^(done|done_ok|completed|complete|success)$/i.test(st); }
function isActive(st: string): boolean { return /^(in_progress|doing|active|running|started)$/i.test(st); }
function isBlocked(st: string, reason?: string | null): boolean { return /^(blocked|failed|error|stuck)$/i.test(st) || !!(reason && String(reason).trim()); }
function isPending(st: string): boolean { return /^(pending|todo|queued|new|open|waiting)$/i.test(st); }

export function buildWorld(works: CompanyWork[], live: MissionLive | null, speakers: string[]): OfficeWorld {
  const speakerSet = new Set(asArray<string>(speakers).filter(Boolean));
  const liveByCompany = new Map<string, { lastActiveAt?: string | null; status?: string; turnCount?: number }>();
  for (const m of asArray<any>(live?.live)) {
    if (!m || typeof m !== 'object') continue;
    const cid = asText((m as any).companyId);
    if (!cid) continue;
    liveByCompany.set(cid, {
      lastActiveAt: (m as any).lastActiveAt ?? null,
      status: asText((m as any).status || ''),
      turnCount: typeof (m as any).turnCount === 'number' ? (m as any).turnCount : 0
    });
  }
  const ordered = asArray<CompanyWork>(works)
    .filter((w) => w && (w as any).company && asText((w as any).company.id))
    .sort((a, b) => asText(a.company.id).localeCompare(asText(b.company.id)) || asText(a.company.name).localeCompare(asText(b.company.name)));

  const rooms: OfficeRoom[] = ordered.map((work, idx) => {
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    const x = ROOM_PAD + col * (ROOM_W + ROOM_PAD);
    const team = asArray<any>((work as any).team).filter(Boolean);
    const perRow = 3;
    const rows = Math.max(1, Math.ceil(Math.max(team.length, 1) / perRow));
    const h = ROOM_H_BASE + rows * DESK_H;
    const y = ROOM_PAD + row * (ROOM_H_BASE + 3 * DESK_H + ROOM_PAD);

    const goals = asArray<any>((work as any).goals).filter(Boolean);
    const tasks: MissionTask[] = goals.flatMap((g) => asArray<any>(g.tasks).map((t) => ({
      id: asText(t?.id),
      text: asText(t?.text),
      status: asText(t?.status),
      agentId: t?.agentId == null ? null : asText(t.agentId),
      blockedReason: t?.blockedReason == null ? null : asText(t.blockedReason)
    } as MissionTask)));

    const agentNameById = new Map<string, string>();
    for (const m of team) {
      const id = asText(m?.id);
      if (id) agentNameById.set(id, asText(m?.name || 'Agent'));
    }

    const activities: OfficeActivity[] = [];
    let active = 0, blocked = 0, done = 0, pending = 0;
    const byAgent = new Map<string, { label: string; state: AgentState; task: string }>();

    for (const g of goals) {
      const goalTitle = asText(g?.title || 'Goal');
      for (const rawT of asArray<any>(g?.tasks)) {
        const st = normStatus(rawT?.status);
        const reason = rawT?.blockedReason == null ? null : asText(rawT.blockedReason);
        if (isDone(st)) done++; else if (isBlocked(st, reason)) blocked++; else if (isActive(st)) active++; else pending++;
        const aid = rawT?.agentId == null ? null : asText(rawT.agentId);
        const act: OfficeActivity = {
          id: asText(rawT?.id),
          text: asText(rawT?.text),
          status: asText(rawT?.status),
          agentName: aid ? (agentNameById.get(aid) || null) : null,
          agentId: aid,
          blockedReason: reason,
          goal: goalTitle
        };
        activities.push(act);
        if (!aid) continue;
        const b = isBlocked(st, reason);
        const w = isActive(st);
        if (b) byAgent.set(aid, { label: truncate(reason || act.text || 'Blocked', 42), state: 'blocked', task: act.text });
        else if (w) byAgent.set(aid, { label: truncate(act.text || 'Working', 42), state: 'working', task: act.text });
      }
    }
    const score = (a: OfficeActivity) => {
      const st = normStatus(a.status);
      if (isBlocked(st, a.blockedReason)) return 0;
      if (isActive(st)) return 1;
      if (isPending(st)) return 2;
      return 3;
    };
    activities.sort((a,b) => score(a) - score(b));

    const liveInfo = liveByCompany.get(asText(work.company.id));
    const isLive = !!liveInfo;

    const agents: OfficeAgent[] = team.map((m, i) => {
      const dc = i % perRow;
      const dr = Math.floor(i / perRow);
      const deskX = x + 12 + dc * DESK_W;
      const deskY = y + ROOM_HEADER + 22 + dr * DESK_H;
      const id = asText(m?.id || `${asText(work.company.id)}-a${i}`);
      const name = asText(m?.name || 'Agent');
      let state: AgentState = 'idle';
      let label = truncate(asText(goals.find((g: any) => !isDone(normStatus(g?.status)))?.title || goals[0]?.title || 'Ready for work'), 42);
      let currentTask: string | null = null;
      if (speakerSet.has(id)) { state = 'speaking'; label = 'Speaking now'; }
      else if (byAgent.has(id)) { const s = byAgent.get(id)!; state = s.state; label = s.label; currentTask = s.task; }
      else if (isLive) { state = 'working'; label = 'In live meeting'; currentTask = liveInfo?.status ? `Meeting: ${liveInfo.status}` : 'In meeting'; }
      else if (tasks.length > 0 && tasks.every((t) => isDone(normStatus(t.status)))) { state = 'idle'; label = 'All tasks done'; }
      else if (!isLive && goals.length === 0 && tasks.length === 0) { state = 'offline'; label = 'No active assignment'; }
      else { state = 'idle'; label = 'Standing by'; }
      return {
        id,
        name,
        title: asText(m?.title || m?.role || ''),
        color: asText(m?.color || hashColor(id || name || String(i))),
        projectId: asText(work.company.id),
        state,
        label,
        deskX,
        deskY,
        currentTask
      };
    });

    return {
      id: asText(work.company.id),
      name: asText(work.company.name || 'Project'),
      x, y, w: ROOM_W, h,
      agents,
      goal: truncate(asText(goals.find((g: any) => !isDone(normStatus(g?.status)))?.title || goals[0]?.title || 'No goal set'), 54),
      taskSummary: `${tasks.length} tasks · ${active} active · ${blocked} blocked`,
      live: isLive,
      meetingStatus: liveInfo?.status || null,
      lastActiveAt: liveInfo?.lastActiveAt || null,
      turnCount: liveInfo?.turnCount || 0,
      activities: activities.slice(0, 12),
      stats: { total: tasks.length, active, blocked, done, pending }
    };
  });

  const rowsCount = Math.max(1, Math.ceil(rooms.length / COLS));
  const width = ROOM_PAD * 2 + COLS * ROOM_W + (COLS - 1) * ROOM_PAD;
  const height = ROOM_PAD * 2 + rowsCount * (ROOM_H_BASE + 3 * DESK_H) + (rowsCount - 1) * ROOM_PAD;
  return { rooms, width, height };
}

export function findRoom(world: OfficeWorld | null, id: string | null): OfficeRoom | null {
  if (!world || !id) return null;
  return world.rooms.find((r) => r.id === id) || null;
}

export function truncate(s: string, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
}
