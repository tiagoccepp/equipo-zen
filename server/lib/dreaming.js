// F-03: dreaming — consolidación offline de memoria (episódico → semántico).
// Ciclo seguro y acotado: purga turnos viejos con resumen, decae learnings
// débiles sin refuerzo, y (opcional, con LLM inyectado) extrae hechos de
// resúmenes recientes. Lo llama el scheduler (E-13) o el endpoint manual.

export const DREAM_PRUNE_AFTER_DAYS = 30;
export const DREAM_PRUNE_MAX_TURNS = 500;
export const DREAM_DECAY_MIN_CONFIDENCE = 0.4;
export const DREAM_DECAY_AFTER_DAYS = 30;
export const DREAM_CONSOLIDATE_MAX = 3;

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

export async function dreamCycle({ store, completeChat = null, dryRun = false } = {}) {
  if (!store) {
    throw new Error('dreamCycle necesita store');
  }
  const report = { prunedTurns: 0, prunedMeetings: 0, decayed: 0, consolidated: 0, skipped: [] };

  // 1. Purga: reuniones cerradas viejas CON resumen pierden turnos crudos.
  const cutoff = daysAgo(DREAM_PRUNE_AFTER_DAYS);
  let pruneTargets = [];
  try {
    pruneTargets = store._prepare(`
      SELECT id FROM meetings
      WHERE status = 'closed' AND summary IS NOT NULL AND summary != ''
        AND (closed_at IS NULL OR closed_at < ?)
        AND (SELECT COUNT(*) FROM turns WHERE meeting_id = meetings.id) > 0
      LIMIT 20
    `).all(cutoff);
  } catch {
    pruneTargets = [];
  }
  for (const m of pruneTargets) {
    if (report.prunedTurns >= DREAM_PRUNE_MAX_TURNS) {
      break;
    }
    try {
      const left = DREAM_PRUNE_MAX_TURNS - report.prunedTurns;
      if (!dryRun) {
        const r = store._prepare(`DELETE FROM turns WHERE id IN (
          SELECT id FROM turns WHERE meeting_id = ? ORDER BY id ASC LIMIT ?
        )`).run(m.id, left);
        report.prunedTurns += r.changes || 0;
      } else {
        const c = store._prepare('SELECT COUNT(*) AS n FROM turns WHERE meeting_id = ?').get(m.id);
        report.prunedTurns += Math.min(c?.n || 0, left);
      }
      report.prunedMeetings += 1;
    } catch {
      report.skipped.push(`prune:${m.id}`);
    }
  }

  // 2. Decaimiento: learnings débiles sin refuerzo salen de 'active'.
  try {
    const stale = store._prepare(`
      SELECT id FROM learnings
      WHERE status = 'active' AND confidence < ? AND last_reinforced_at < ?
      LIMIT 50
    `).all(DREAM_DECAY_MIN_CONFIDENCE, daysAgo(DREAM_DECAY_AFTER_DAYS));
    for (const row of stale) {
      if (!dryRun) {
        store._prepare("UPDATE learnings SET status = 'decayed' WHERE id = ?").run(row.id);
      }
      report.decayed += 1;
    }
  } catch {
    report.skipped.push('decay');
  }

  // 3. Consolidación LLM (opcional): resúmenes recientes sin consolidar.
  if (typeof completeChat === 'function') {
    let pending = [];
    try {
      pending = store._prepare(`
        SELECT m.id, m.goal_id, m.summary FROM meetings m
        WHERE m.summary IS NOT NULL AND m.summary != ''
          AND m.id NOT IN (SELECT meeting_id FROM learnings WHERE meeting_id IS NOT NULL AND type = 'fact' AND content LIKE '[sueño]%')
        ORDER BY m.last_active_at DESC LIMIT ?
      `).all(DREAM_CONSOLIDATE_MAX);
    } catch {
      pending = [];
    }
    for (const m of pending) {
      try {
        const out = await completeChat({
          scope: 'dreaming',
          maxTokens: 600,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `De este resumen de reunión, extraé hasta 3 hechos durables sobre el usuario/proyecto (1 línea cada uno, sin trivia). Si no hay nada durable, respondé NADA.\n\nRESUMEN:\n${String(m.summary).slice(0, 2000)}`
          }]
        });
        const text = typeof out === 'string' ? out : String(out?.text || '');
        if (!dryRun) {
          if (/^\s*nada\s*\.?\s*$/i.test(text.trim())) {
            store.insertLearning({
              agentId: null, meetingId: m.id, goalId: m.goal_id || null,
              type: 'fact', content: '[sueño] sin hechos durables', confidence: 1, sourceTurnIds: []
            });
          } else {
            const facts = text.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter((l) => l.length > 10).slice(0, 3);
            for (const fact of facts) {
              store.insertLearning({
                agentId: null, meetingId: m.id, goalId: m.goal_id || null,
                type: 'fact', content: `[sueño] ${fact.slice(0, 300)}`, confidence: 0.6, sourceTurnIds: []
              });
            }
          }
        }
        report.consolidated += 1;
      } catch {
        report.skipped.push(`consolidate:${m.id}`);
      }
    }
  }

  // 4. E-11: reincidentes → propuesta de fix a Tito.
  try {
    const { proposeFixesForReincidents, learningHealth } = await import('./learning.js');
    report.health = learningHealth(store);
    if (!dryRun) {
      report.fixProposals = proposeFixesForReincidents(store);
    } else {
      report.fixProposals = [];
    }
  } catch {
    report.skipped.push('reincident');
  }

  if (!dryRun) {
    try {
      store.logChange('dreaming', 'memory', 'cycle', 'run', report);
    } catch { /* best-effort */ }
  }
  return report;
}
