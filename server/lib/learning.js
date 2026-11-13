import { LEARNING_ENABLED } from './config.js';
import { getMinimaxModels, getTtsLanguage } from './settings.js';
import { completeChat, parseJsonFromModel } from './llm.js';
import { normalize } from './text.js';
import { telemetry } from './telemetry.js';

// Señales de corrección/enseñanza que disparan al observador sin esperar
// al barrido periódico.
const TEACHING_SIGNAL = /\b(no,|en realidad|te equivoc|no es asi|no es cierto|prefiero|preferiria|acordate|recorda|siempre|nunca|no me gusta|me gusta que|a partir de ahora|de ahora en mas|la proxima|importante:)\b/;

const SWEEP_EVERY_N_TURNS = 4;
const MAX_LEARNINGS_PER_CYCLE = 3;
const MIN_CONFIDENCE = 0.6;
const DEDUP_JACCARD = 0.6;
// Techos dieta D5 (09/11): los learnings inyectados no pueden pasar de
// 2000ch ni 5 items de 160ch — sin techo, esta sección escala a 4800ch y se
// vuelve la 2ª del system. El ranking no se toca (no-tocar §4.9).
const MEMORY_TOP_K = 5;
const MEMORY_CHAR_BUDGET = 2000; // ~500 tokens
const LEARNING_ITEM_MAX_CHARS = 160;

const OBSERVER_FORMAT = [
  'Respondé ÚNICAMENTE con un JSON válido, sin markdown, con esta forma exacta:',
  '{"learnings":[{"agentId":"<id del agente o global>","type":"user_preference|correction|fact|skill_note","content":"una oración en español","confidence":0.0,"evidence":"cita textual del turno del usuario"}]}',
  'Si no hay nada para aprender: {"learnings":[]}'
].join('\n');

// Observador asíncrono: corre DESPUÉS de que el ciclo del turno terminó
// (jamás bloquea la conversación) y extrae aprendizajes SOLO de lo que
// dijo el usuario. Funciona igual con backend live, stream o mock porque
// lee la transcripción persistida, no la vía de generación.
export class LearningObserver {
  constructor(store, keyRing) {
    this.store = store;
    this.keyRing = keyRing;
    this.inFlight = false;
    this.userTurnsSinceSweep = 0;
  }

  shouldObserve(userText) {
    if (!LEARNING_ENABLED || !this.keyRing.hasKeys()) {
      return false;
    }
    this.userTurnsSinceSweep += 1;
    if (TEACHING_SIGNAL.test(normalize(userText))) {
      return true;
    }
    if (this.userTurnsSinceSweep >= SWEEP_EVERY_N_TURNS) {
      return true;
    }
    return false;
  }

  // Fire-and-forget desde meeting-session; nunca lanza.
  observeCycle(meetingId, memory, agents, userText, onStored, goalId = null) {
    if (this.inFlight || !this.shouldObserve(userText)) {
      return;
    }
    this.inFlight = true;
    this.userTurnsSinceSweep = 0;
    void this.run(meetingId, memory, agents, goalId)
      .then((affected) => {
        if (affected && affected.length > 0) {
          onStored?.(affected);
        }
      })
      .catch((error) => {
        telemetry.add({ type: 'learning_observer_failed', payload: { error: String(error?.message || error).slice(0, 200) } });
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  async run(meetingId, memory, agents, goalId = null) {
    const recentTurns = memory.turns.slice(-10);
    if (recentTurns.length === 0) {
      return;
    }
    const userTurnIds = new Set(
      recentTurns.filter((turn) => turn.kind === 'user').map((turn) => turn.dbId).filter(Boolean)
    );
    if (userTurnIds.size === 0) {
      return;
    }

    const transcript = recentTurns
      .map((turn) => `[${turn.dbId ?? '-'}|${turn.kind}] ${turn.speaker}: ${turn.text}`)
      .join('\n');
    const existing = this.store.activeLearnings().slice(0, 30).map((item) => item.content);

    const prompt = [
      'Sos el observador de memoria de un sistema de reunión con agentes IA.',
      'Tu único trabajo: detectar si el USUARIO enseñó, corrigió o expresó una preferencia que valga la pena recordar para futuras reuniones.',
      '',
      'REGLAS ESTRICTAS:',
      '- Aprendé SOLO de turnos [*|user]. Lo que digan los agentes NUNCA es fuente de aprendizaje.',
      '- Máximo 3 aprendizajes. Si no hay nada claro, devolvé lista vacía. La mayoría de los ciclos no tienen nada.',
      '- Cada aprendizaje: una oración en español, concreta, útil para el futuro ("prefiere montos absolutos, no porcentajes").',
      '- NO aprendas trivia de la charla ("el usuario saludó"), ni pedidos puntuales de un solo uso.',
      '- agentId: usá el id del agente al que aplica; "global" si aplica a todos.',
      '- confidence entre 0 y 1: qué tan explícito fue el usuario.',
      '',
      `AGENTES: ${JSON.stringify(agents.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title })))}`,
      '',
      'APRENDIZAJES YA GUARDADOS (no repitas equivalentes):',
      existing.length ? existing.map((content) => `- ${content}`).join('\n') : '(ninguno)',
      '',
      'ÚLTIMOS TURNOS:',
      transcript
    ].join('\n');

    const { text: responseText } = await completeChat(this.keyRing, {
      models: getMinimaxModels(),
      scope: 'observador',
      timeoutMs: 12000,
      maxTokens: 1400,
      temperature: 0,
      messages: [{ role: 'user', content: `${prompt}\n\n${OBSERVER_FORMAT}` }]
    });

    const parsed = parseJsonFromModel(responseText);
    const candidates = Array.isArray(parsed?.learnings) ? parsed.learnings.slice(0, MAX_LEARNINGS_PER_CYCLE) : [];
    const validAgentIds = new Set(agents.map((agent) => agent.id));

    const affectedAgentIds = [];
    for (const candidate of candidates) {
      const content = String(candidate.content || '').trim().slice(0, LEARNING_ITEM_MAX_CHARS);
      const confidence = Number(candidate.confidence);
      const type = ['user_preference', 'correction', 'fact', 'skill_note'].includes(candidate.type)
        ? candidate.type
        : 'fact';
      if (!content || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
        continue;
      }
      // Grounding: la evidencia citada tiene que aparecer en un turno user.
      const evidence = normalize(String(candidate.evidence || ''));
      const grounded = evidence.length >= 4 && memory.turns.some(
        (turn) => turn.kind === 'user' && normalize(turn.text).includes(evidence.slice(0, 60))
      );
      if (!grounded) {
        telemetry.add({ type: 'learning_rejected', payload: { reason: 'sin_evidencia_user', content } });
        continue;
      }

      const agentId = candidate.agentId && validAgentIds.has(candidate.agentId) ? candidate.agentId : null;
      const targetAgent = agentId ? agents.find((agent) => agent.id === agentId) : null;
      if (targetAgent && targetAgent.learningEnabled === false) {
        continue;
      }
      const duplicate = this.findSimilar(content, agentId, goalId);
      if (duplicate) {
        this.store.reinforceLearning(duplicate.id, confidence);
        this.store.logChange('observer', 'learning', String(duplicate.id), 'update', { reinforced: content });
        telemetry.add({ type: 'learning_reinforced', payload: { learningId: duplicate.id, content } });
        affectedAgentIds.push(agentId);
      } else {
        const learningId = this.store.insertLearning({
          agentId,
          meetingId,
          goalId,
          type: type,
          content,
          confidence,
          sourceTurnIds: [...userTurnIds]
        });
        this.store.logChange('observer', 'learning', String(learningId), 'create', { type, content, agentId });
        telemetry.add({ type: 'learning_created', payload: { learningId, type, content, agentId } });
        // E-09: preferencia fuerte → gusto (sin preguntar).
        if (type === 'user_preference') {
          try {
            const { promoteLearningToTaste } = await import('./tastes.js');
            promoteLearningToTaste(this.store, { id: learningId, type, content, confidence, goalId });
          } catch {
            // Promoción caída: el learning igual quedó.
          }
        }
        affectedAgentIds.push(agentId);
      }
    }
    return affectedAgentIds;
  }

  findSimilar(content, agentId, goalId = null) {
    const target = tokenSet(content);
    for (const learning of this.store.activeLearnings(agentId || undefined, goalId || undefined)) {
      if (jaccard(target, tokenSet(learning.content)) > DEDUP_JACCARD) {
        return learning;
      }
    }
    return null;
  }
}

function tokenSet(value) {
  return new Set(normalize(value).split(' ').filter((token) => token.length > 2));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

// Sección MEMORIA APRENDIDA para el system prompt: top-K por
// confianza × recencia × refuerzos, con presupuesto duro de caracteres.
// E-11: métrica de mejora — ningún error se repite dos veces igual.
// Un [error] reforzado 3+ veces = REINCIDENTE = bug del loop: se propone
// fix (skill) a Tito en vez de seguir aprendiendo en vano.
export const REINCIDENT_THRESHOLD = 3;

export function reincidentErrors(store, goalId = null) {
  try {
    const rows = store._prepare(`
      SELECT * FROM learnings
      WHERE status = 'active' AND type = 'skill_note' AND content LIKE '[error]%'
        AND times_reinforced >= ?
        ${goalId ? 'AND (goal_id IS NULL OR goal_id = ?)' : ''}
      ORDER BY times_reinforced DESC LIMIT 20
    `).all(...(goalId ? [REINCIDENT_THRESHOLD, goalId] : [REINCIDENT_THRESHOLD]));
    return rows;
  } catch {
    return [];
  }
}

export function learningHealth(store, goalId = null) {
  try {
    const scope = goalId ? 'AND (goal_id IS NULL OR goal_id = ?)' : '';
    const params = goalId ? [goalId] : [];
    const total = store._prepare(
      `SELECT COUNT(*) AS n FROM learnings WHERE status = 'active' AND type = 'skill_note' AND content LIKE '[error]%' ${scope}`
    ).get(...params)?.n || 0;
    const reinforced = store._prepare(
      `SELECT COUNT(*) AS n FROM learnings WHERE status = 'active' AND type = 'skill_note' AND content LIKE '[error]%' AND times_reinforced > 1 ${scope}`
    ).get(...params)?.n || 0;
    const reincident = reincidentErrors(store, goalId).length;
    return {
      errorLearnings: total,
      repeatedOnce: reinforced,
      reincident,
      // Tasa de reincidencia: 0 = ningún error llegó a 3 (meta).
      reincidentRate: total > 0 ? Math.round((reincident / total) * 100) / 100 : 0
    };
  } catch {
    return { errorLearnings: 0, repeatedOnce: 0, reincident: 0, reincidentRate: 0 };
  }
}

// Propone fix (skill) por cada reincidente sin propuesta pendiente previa.
export function proposeFixesForReincidents(store, goalId = null) {
  const proposed = [];
  try {
    for (const row of reincidentErrors(store, goalId)) {
      const tool = (String(row.content).match(/\[error\] (\S+) falló/) || [])[1] || 'tool';
      const dup = store._prepare(`
        SELECT id FROM tasks WHERE kind = 'proposal' AND status = 'pending'
          AND text LIKE ? LIMIT 1
      `).get(`%reincidente:${tool}%`);
      if (dup) {
        continue;
      }
      const err = String(row.content).slice(0, 180);
      const task = store.proposeChange(row.goal_id || goalId, null, {
        kind: 'skill',
        action: 'create',
        payload: {
          name: `evitar-fallo-${tool}`.slice(0, 61),
          description: `Evitar el fallo reincidente de ${tool}.`,
          keywords: [tool, 'error', 'fallo'],
          scope: 'chat',
          body: `La tool ${tool} falló ${row.times_reinforced} veces con: ${err}. ANTES de usarla: verificar precondiciones (rutas, formato, tamaño). SI falla igual: NO reintentar idéntico — partir el trabajo, usar otra tool o pedir ayuda. Reportar el fallo en criollo.`
        },
        reason: `reincidente:${tool} falló ${row.times_reinforced} veces; el loop no lo corrigió solo`,
        risk: 'medium'
      });
      proposed.push(task.id);
    }
  } catch {
    // Proponer nunca rompe el ciclo.
  }
  return proposed;
}

// E-08: puente error→aprendizaje. Cada fallo de tool deja una skill_note
// accionable (o refuerza la existente): el error no se repite igual dos
// veces (E-11). Determinístico, sin LLM: plantilla + dedup.
export function recordErrorLearning(store, { agentId = null, meetingId = null, goalId = null, tool, error }) {
  if (!store || !tool) {
    return null;
  }
  const err = String(error || 'sin motivo').slice(0, 200);
  const content = `[error] ${tool} falló: ${err}. Si se repite, cambiar de estrategia (partir el trabajo, otra tool, pedir ayuda) en vez de reintentar igual.`;
  try {
    const existing = store.activeLearnings(agentId || undefined, goalId || undefined)
      .find((l) => l.type === 'skill_note' && l.content.includes(`[error] ${tool} falló:`));
    if (existing) {
      store.reinforceLearning(existing.id, 0.8);
      return { id: existing.id, reinforced: true };
    }
    const id = store.insertLearning({
      agentId,
      meetingId,
      goalId,
      type: 'skill_note',
      content: content.slice(0, 500),
      confidence: 0.8,
      sourceTurnIds: []
    });
    return { id, reinforced: false };
  } catch {
    return null;
  }
}

export function renderLearningsSection(store, agentId, goalId = null) {
  if (!LEARNING_ENABLED) {
    return '';
  }
  // El header viaja en el system prompt: en inglés si la voz es inglesa.
  const enLearn = String(getTtsLanguage() || 'en').toLowerCase().startsWith('en');
  const agent = store.getAgent(agentId);
  if (agent && agent.learningEnabled === false) {
    return '';
  }
  const learnings = store.activeLearnings(agentId, goalId || undefined);
  if (learnings.length === 0) {
    return '';
  }

  const now = Date.now();
  const ranked = learnings
    .map((learning) => {
      const ageDays = Math.max(0, (now - new Date(learning.lastReinforcedAt).getTime()) / 86400000);
      const recency = 1 / (1 + ageDays / 30);
      const score = learning.confidence * recency * Math.log(2 + learning.timesReinforced);
      return { learning, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MEMORY_TOP_K);

  const lines = [];
  let used = 0;
  for (const { learning } of ranked) {
    const line = `- ${learning.content.slice(0, LEARNING_ITEM_MAX_CHARS)}`;
    if (used + line.length > MEMORY_CHAR_BUDGET) {
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) {
    return '';
  }

  return [
    enLearn ? 'LEARNED MEMORY (from past meetings):' : 'MEMORIA APRENDIDA (de reuniones anteriores):',
    ...lines,
    enLearn ? 'Apply this naturally; do not recite or mention it.' : 'Aplicá esto con naturalidad; no lo recites ni lo menciones.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hook aditivo track C (flujo de equipo, 09/11): learnings de cierre de laburo
// + contexto previo por rol. No toca nada existente: solo nuevos exports que
// usan store.insertLearning / activeLearnings / reinforceLearning.
// ---------------------------------------------------------------------------

const LABURO_CONFIDENCE = 0.8;
const LABURO_MAX_ITEMS = 8;

// laburo: { meetingId?, agentePorRol?: { rol: agentId }, juicioFinal?,
//   rondas?, fallosRecurrentes?: string[], reusar?: string[], vigilar?: string[] }
// juicioFinal: salida de tester.juzgar (veredicto devolucion/aprobado).
// Idempotente: dedup Jaccard ≥ DEDUP_JACCARD contra activos → 2ª llamada = 0 creados.
// -> { creados, reforzados }
export function registrarLearningsDeLaburo(store, laburo = {}) {
  const out = { creados: 0, reforzados: 0 };
  if (!store || typeof store.insertLearning !== 'function') {
    return out;
  }
  const items = laburoLearnings(laburo).slice(0, LABURO_MAX_ITEMS);
  const activos = typeof store.activeLearnings === 'function' ? store.activeLearnings() : [];
  for (const item of items) {
    const content = String(item.content || '').trim().slice(0, LEARNING_ITEM_MAX_CHARS);
    if (!content) continue;
    const sig = tokenSet(content);
    const dup = activos.find((a) => jaccard(sig, tokenSet(a.content)) >= DEDUP_JACCARD);
    if (dup) {
      try {
        store.reinforceLearning(dup.id, LABURO_CONFIDENCE);
        out.reforzados += 1;
      } catch { /* store parcial en tests: no rompe */ }
      continue;
    }
    try {
      const id = store.insertLearning({
        agentId: item.agentId || null,
        meetingId: laburo.meetingId || null,
        type: 'skill_note',
        content,
        confidence: LABURO_CONFIDENCE,
        sourceTurnIds: []
      });
      activos.push({ id, content });
      out.creados += 1;
    } catch { /* store parcial: se ignora el item */ }
  }
  return out;
}

function laburoLearnings(laburo) {
  const items = [];
  const porRol = laburo.agentePorRol || {};
  const juicio = laburo.juicioFinal || {};
  const push = (rol, content) => {
    if (String(content || '').trim()) items.push({ agentId: porRol[rol] || null, content });
  };
  if (juicio.veredicto === 'aprobado') {
    const cob = juicio.cobertura || {};
    push('tester', `Laburo aprobado: ${cob.checksPasados ?? 0}/${cob.checksTotales ?? 0} checks en verde (${(cob.personas || []).length} personas × ${(cob.dimensiones || []).length} dims).`);
    for (const t of (juicio.arregladoEnRondas || []).slice(0, 3)) {
      push('tester', `Se detectó y arregló en rondas: ${t}.`);
    }
    for (const l of (juicio.limitaciones || []).slice(0, 2)) {
      push('tester', `Limitación conocida a cubrir la próxima: ${l}.`);
    }
  } else if (juicio.veredicto === 'devolucion') {
    for (const f of (juicio.fallos || []).slice(0, 4)) {
      push('tester', `[${f.severidad}] lo encontró ${f.persona} (${f.dimension}): ${f.titulo}.`);
    }
  }
  if (Number.isFinite(laburo.rondas) && laburo.rondas > 1) {
    push(null, `El laburo llevó ${laburo.rondas} rondas de test: reforzar definición de done en el brief.`);
  }
  for (const f of (laburo.fallosRecurrentes || []).slice(0, 3)) {
    push('tester', `Fallo recurrente a vigilar siempre: ${f}.`);
  }
  for (const r of (laburo.reusar || []).slice(0, 2)) {
    push(null, `Reusar en próximos laburos: ${r}.`);
  }
  for (const v of (laburo.vigilar || []).slice(0, 2)) {
    push(null, `Vigilar en próximos laburos: ${v}.`);
  }
  return items;
}

const STOPWORDS = new Set('de la el en y a los las un una para con por como más mas qué que se su sus al del esto esta este estos estas'.split(' '));

function temaTokens(tema) {
  return normalize(String(tema || '')).split(' ').filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Bloque a inyectar en el prompt del rol antes de producir (el cableado en
// runtime lo hace el main). '' si no hay nada relevante (sin ruido).
export function contextoPrevio(store, rol, tema, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 800;
  if (!store || typeof store.activeLearnings !== 'function') return '';
  const tokens = temaTokens(tema);
  if (tokens.length === 0) return '';
  const agentId = opts.agentId || null;
  let learnings;
  try {
    learnings = store.activeLearnings(agentId || undefined);
  } catch {
    return '';
  }
  if (!Array.isArray(learnings) || learnings.length === 0) return '';
  const scored = [];
  for (const l of learnings) {
    const contenido = normalize(String(l.content || ''));
    const hits = tokens.filter((t) => contenido.includes(t)).length;
    if (hits === 0) continue;
    scored.push({ l, score: hits * 10 + (Number(l.confidence) || 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const lines = [];
  let used = 0;
  for (const { l } of scored) {
    const line = `- ${String(l.content).slice(0, LEARNING_ITEM_MAX_CHARS)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  return [`CONTEXTO PREVIO (${rol}, de laburos anteriores):`, ...lines].join('\n');
}
