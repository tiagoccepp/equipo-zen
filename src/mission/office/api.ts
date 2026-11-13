import type { CompanyWork, MissionGoal, MissionLive, MissionTask } from '../types.ts';
import { apiBase } from '../../client.ts';

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(apiBase() + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchLive(): Promise<MissionLive | null> {
  const data = await getJson<MissionLive>('/api/mission/live');
  if (!data || !Array.isArray(data.live)) return null;
  return data;
}

interface CompanyRow { id: string; name: string; }

export async function fetchAllWork(): Promise<CompanyWork[] | null> {
  const list = await getJson<{ companies: CompanyRow[] }>('/api/companies');
  if (!list || !Array.isArray(list.companies)) return null;
  if (!list.companies.length) return [];
  const sorted = [...list.companies].sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  const rows = await Promise.all(sorted.map(async (c) => {
    const work = await getJson<{
      company: { id: string; name: string };
      team: CompanyWork['team'];
      goals: Array<{ id: string; title: string; status: string; tasks?: Array<{ id: string; text: string; status: string; agentId?: string | null; blockedReason?: string | null; }> }>;
    }>(`/api/companies/${encodeURIComponent(c.id)}/work`);
    if (!work || !work.company || !Array.isArray(work.goals)) return null;
    const goals: MissionGoal[] = (work.goals || []).map((g) => ({
      id: g.id, title: g.title, status: g.status,
      tasks: (Array.isArray(g.tasks) ? g.tasks : []).map((t): MissionTask => ({
        id: t.id, text: t.text, status: t.status, agentId: t.agentId ?? null, blockedReason: t.blockedReason ?? null
      }))
    }));
    return { company: work.company, team: Array.isArray(work.team) ? work.team : [], goals } as CompanyWork;
  }));
  return rows.filter((r): r is CompanyWork => !!r).sort((a, b) => a.company.id.localeCompare(b.company.id));
}
