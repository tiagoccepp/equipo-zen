// A-07: background bridge — workers de fondo promocionados a la charla
// viva (mid-flight) + inyección sintética de turnos. El workforce ya emite
// work_event (feed); esto PROMOCIONA resultados terminales a mensaje de
// agente (memoria + evento + voz opcional).

// ¿Evento promocionable? task_done/goal_done con resumen.
export function promotableWorkEvent(payload) {
  if (!payload || payload.type !== 'work_event') {
    return null;
  }
  if (payload.kind === 'task_done' && payload.summary) {
    return {
      kind: 'task_done',
      agentId: payload.agentId || null,
      agentName: payload.agentName || 'equipo',
      text: String(payload.summary).slice(0, 1500),
      taskId: payload.taskId || null
    };
  }
  if (payload.kind === 'goal_done' && payload.title) {
    return {
      kind: 'goal_done',
      agentId: null,
      agentName: 'equipo',
      text: `Objetivo listo: ${String(payload.title).slice(0, 300)}`,
      taskId: null
    };
  }
  return null;
}

// Inyección sintética: turno de agente sin usuario (revisión, nudge).
// session: MeetingSession (runAgentJobTurn). Devuelve el resultado.
export async function injectSynthetic(session, agentId, text, { signal = null, timeoutMs = 120000 } = {}) {
  if (!session || typeof session.runAgentJobTurn !== 'function') {
    throw new Error('injectSynthetic necesita session con runAgentJobTurn');
  }
  if (!agentId || !String(text || '').trim()) {
    throw new Error('injectSynthetic necesita {agentId, text}');
  }
  return session.runAgentJobTurn(agentId, String(text).slice(0, 2000), { signal, timeoutMs });
}
