// Mission Control — snapshot de reuniones vivas (server).
// Deps inyectadas (meetings/isLive/getCompany/teamFor) para no acoplar el
// store ni el registry WS: testeable con fakes, cero imports pesados.

/**
 * @param {object} deps
 * @param {Array} deps.meetings Filas de store.listMeetings (id, company_id, title, status, turn_count, last_active_at).
 * @param {(id: string) => boolean} deps.isLive
 * @param {(companyId: string) => { id: string, name: string } | null} deps.getCompany
 * @param {(companyId: string) => Array<{ id: string, name: string, title?: string, role?: string, color?: string }>} deps.teamFor
 * @param {(meetingId: string) => string | null} [deps.goalFor] Título del proyecto de la reunión (opcional).
 */
export function buildLiveSnapshot({ meetings, isLive, getCompany, teamFor, goalFor }) {
  const live = [];
  for (const m of meetings || []) {
    if (!m || !isLive(m.id)) {
      continue;
    }
    const company = getCompany(m.company_id);
    const team = (teamFor(m.company_id) || []).map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title ?? null,
      role: a.role ?? null,
      color: a.color ?? null
    }));
    live.push({
      meetingId: m.id,
      companyId: m.company_id,
      companyName: company ? company.name : m.company_id,
      goalTitle: typeof goalFor === 'function' ? goalFor(m.id) : null,
      status: m.status || 'active',
      turnCount: typeof m.turn_count === 'number' ? m.turn_count : 0,
      lastActiveAt: m.last_active_at || null,
      team
    });
  }
  return { live };
}
