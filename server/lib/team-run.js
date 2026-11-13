// A-02: lead sintetizador — dos modos: subagente-barato (uno solo, tier
// fast) vs team (lead + workers con checklist compartida + bus directo).
// El modo sale de la complejidad (A-10): simple→cheap, resto→team.

import { scoreComplexity } from './complexity.js';

export const TEAM_MAX_WORKERS = 3;
export const TEAM_WORKER_TIMEOUT_MS = 120000;

export function teamModeFor(brief) {
  return scoreComplexity(brief) === 'simple' ? 'cheap' : 'team';
}

// Corre una tarea con el equipo de la sesión. session: MeetingSession viva
// (store, agents, sessionAgents, agentBus, gate). Devuelve {mode, summary}.
export async function runTeamTask(session, { goalId, brief, signal = null } = {}) {
  if (!session?.store || !brief) {
    throw new Error('runTeamTask necesita {session, brief}');
  }
  const mode = teamModeFor(brief);
  const goal = goalId ? session.store.getGoal(goalId) : session.project || null;
  if (mode === 'cheap') {
    const worker = pickWorker(session, null);
    if (!worker) {
      throw new Error('sin agentes para cheap-run');
    }
    const out = await session.runAgentJobTurn(worker.id, brief, { signal });
    return { mode, worker: worker.id, summary: out.text, toolCalls: out.toolCalls };
  }
  return runTeamMode(session, { goal, brief, signal });
}

function pickWorker(session, excludeId = null) {
  const agents = (session.sessionAgents || []).filter((a) => a && a.id !== excludeId && a.enabled !== false);
  // Lead preferido: orquestador/ceo; si no, el primero.
  return agents.find((a) => a.role === 'orquestador' || a.role === 'ceo') || agents[0] || null;
}

async function runTeamMode(session, { goal, brief, signal }) {
  const lead = pickWorker(session);
  const workers = (session.sessionAgents || [])
    .filter((a) => a && lead && a.id !== lead.id && a.enabled !== false)
    .slice(0, TEAM_MAX_WORKERS);
  const goalId = goal?.id || null;

  // Checklist compartida (visible en vivo, M-04).
  const steps = splitSteps(brief, workers.length);
  for (const step of steps) {
    try {
      session.store.addChecklistItem(goalId, step, lead?.id || null);
    } catch { /* best-effort */ }
  }

  // Lead reparte por bus directo (E-05): cada worker ve su parte.
  const assignments = [];
  workers.forEach((w, i) => {
    const part = steps[i % Math.max(1, steps.length)] || brief;
    try {
      session.agentBus?.send(lead?.id || 'lead', w.id, `Tu parte: ${part}`);
    } catch { /* bus caído: el prompt igual lleva contexto */ }
    assignments.push({ worker: w, part });
  });

  // Workers en paralelo acotado (serie si no hay slots: simple y seguro).
  const results = [];
  for (const { worker, part } of assignments) {
    if (signal?.aborted) {
      break;
    }
    try {
      const out = await session.runAgentJobTurn(worker.id, part, { signal, timeoutMs: TEAM_WORKER_TIMEOUT_MS });
      results.push({ worker: worker.id, name: worker.name, text: out.text, toolCalls: out.toolCalls });
    } catch (error) {
      results.push({ worker: worker.id, name: worker.name, text: '', error: String(error?.message || error).slice(0, 200) });
    }
  }

  // Lead sintetiza (sin workers = el lead hace todo).
  const parts = results.filter((r) => r.text).map((r) => `${r.name}: ${r.text}`).join('\n\n');
  let summary = parts;
  if (lead) {
    try {
      const synth = await session.runAgentJobTurn(
        lead.id,
        `Sintetizá estos aportes en un resultado final corto (qué se hizo + qué falta):\n\n${parts || brief}`,
        { signal, timeoutMs: TEAM_WORKER_TIMEOUT_MS }
      );
      if (synth.text) {
        summary = synth.text;
      }
    } catch {
      // Síntesis caída: valen los aportes crudos.
    }
  }
  return { mode: 'team', lead: lead?.id || null, workers: results.map((r) => r.worker), summary, results };
}

function splitSteps(brief, n) {
  const text = String(brief || '').trim();
  const byLines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byLines.length >= 2) {
    return byLines.slice(0, Math.max(2, n));
  }
  const bySentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (bySentences.length >= 2) {
    return bySentences.slice(0, Math.max(2, n));
  }
  return [text];
}
