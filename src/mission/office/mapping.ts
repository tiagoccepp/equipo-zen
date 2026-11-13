import type { CompanyWork, MissionLive } from '../types.ts';

export type AgentState = 'idle' | 'working' | 'speaking' | 'blocked';

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
}

export interface OfficeWorld {
  rooms: OfficeRoom[];
  width: number;
  height: number;
}

const ROOM_PAD = 16;
const ROOM_HEADER = 22;
const DESK_W = 88;
const DESK_H = 44;
const COLS = 3;
const ROOM_W = 320;
const ROOM_H_BASE = 120;

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 55% 62%)`;
}

export function buildWorld(works: CompanyWork[], live: MissionLive | null, speakers: string[]): OfficeWorld {
  const speakerSet = new Set(speakers);
  const liveByCompany = new Map<string, { lastActiveAt?: string | null }>();
  for (const m of live?.live || []) liveByCompany.set(m.companyId, { lastActiveAt: m.lastActiveAt });
  const ordered = [...works].sort((a, b) => a.company.id.localeCompare(b.company.id) || a.company.name.localeCompare(b.company.name));
  const rooms: OfficeRoom[] = ordered.map((work, idx) => {
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    const x = ROOM_PAD + col * (ROOM_W + ROOM_PAD);
    const team = work.team || [];
    const perRow = 3;
    const rows = Math.max(1, Math.ceil(Math.max(team.length, 1) / perRow));
    const h = ROOM_H_BASE + rows * DESK_H;
    const y = ROOM_PAD + row * (ROOM_H_BASE + 3 * DESK_H + ROOM_PAD); // uniform row height for simplicity
    const tasks = work.goals.flatMap((g) => g.tasks || []);
    const byAgent = new Map<string, { label: string; state: AgentState }>();
    for (const t of tasks) {
      if (!t.agentId) continue;
      const st = String(t.status || '').toLowerCase();
      const blocked = /blocked|failed|error/.test(st) || !!t.blockedReason;
      const working = /in_progress|doing|active|running/.test(st);
      if (blocked) byAgent.set(t.agentId, { label: t.blockedReason || t.text || 'Blocked', state: 'blocked' });
      else if (working) byAgent.set(t.agentId, { label: t.text || 'Working', state: 'working' });
    }
    const liveInfo = liveByCompany.get(work.company.id);
    const agents: OfficeAgent[] = team.map((m, i) => {
      const dc = i % perRow;
      const dr = Math.floor(i / perRow);
      const deskX = x + 12 + dc * DESK_W;
      const deskY = y + ROOM_HEADER + 18 + dr * DESK_H;
      let state: AgentState = 'idle';
      let label = work.goals[0]?.title || 'Idle';
      if (speakerSet.has(m.id)) { state = 'speaking'; label = 'Speaking…'; }
      else if (byAgent.has(m.id)) { const s = byAgent.get(m.id)!; state = s.state; label = s.label; }
      else if (liveInfo?.lastActiveAt) { state = 'working'; label = 'In meeting'; }
      return {
        id: m.id || `${work.company.id}-a${i}`,
        name: m.name || 'Agent',
        title: m.title || m.role || '',
        color: m.color || hashColor(m.id || m.name || String(i)),
        projectId: work.company.id,
        state,
        label: truncate(label, 36),
        deskX,
        deskY
      };
    });
    const active = tasks.filter((t) => /in_progress|doing|active|running/i.test(t.status)).length;
    const blocked = tasks.filter((t) => /blocked|failed|error/i.test(t.status) || t.blockedReason).length;
    return {
      id: work.company.id,
      name: work.company.name,
      x, y, w: ROOM_W, h,
      agents,
      goal: work.goals[0]?.title || 'No goal',
      taskSummary: `${tasks.length} tasks · ${active} active · ${blocked} blocked`
    };
  });
  const rowsCount = Math.max(1, Math.ceil(rooms.length / COLS));
  const width = ROOM_PAD * 2 + COLS * ROOM_W + (COLS - 1) * ROOM_PAD;
  const height = ROOM_PAD * 2 + rowsCount * (ROOM_H_BASE + 3 * DESK_H) + (rowsCount - 1) * ROOM_PAD;
  return { rooms, width, height };
}

function truncate(s: string, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
