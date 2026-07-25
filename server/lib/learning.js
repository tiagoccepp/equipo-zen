import { LEARNING_ENABLED } from './config.js';
import { getMinimaxModels } from './settings.js';
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
const MEMORY_TOP_K = 8;
const MEMORY_CHAR_BUDGET = 4800; // ~1200 tokens
const LEARNING_ITEM_MAX_CHARS = 200;

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
  observeCycle(meetingId, memory, agents, userText, onStored) {
    if (this.inFlight || !this.shouldObserve(userText)) {
      return;
    }
    this.inFlight = true;
    this.userTurnsSinceSweep = 0;
    void this.run(meetingId, memory, agents)
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

  async run(meetingId, memory, agents) {
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
      const duplicate = this.findSimilar(content, agentId);
      if (duplicate) {
        this.store.reinforceLearning(duplicate.id, confidence);
        this.store.logChange('observer', 'learning', String(duplicate.id), 'update', { reinforced: content });
        telemetry.add({ type: 'learning_reinforced', payload: { learningId: duplicate.id, content } });
        affectedAgentIds.push(agentId);
      } else {
        const learningId = this.store.insertLearning({
          agentId,
          meetingId,
          type,
          content,
          confidence,
          sourceTurnIds: [...userTurnIds]
        });
        this.store.logChange('observer', 'learning', String(learningId), 'create', { type, content, agentId });
        telemetry.add({ type: 'learning_created', payload: { learningId, type, content, agentId } });
        affectedAgentIds.push(agentId);
      }
    }
    return affectedAgentIds;
  }

  findSimilar(content, agentId) {
    const target = tokenSet(content);
    for (const learning of this.store.activeLearnings(agentId || undefined)) {
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
export function renderLearningsSection(store, agentId) {
  if (!LEARNING_ENABLED) {
    return '';
  }
  const agent = store.getAgent(agentId);
  if (agent && agent.learningEnabled === false) {
    return '';
  }
  const learnings = store.activeLearnings(agentId);
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
    'MEMORIA APRENDIDA (de reuniones anteriores):',
    ...lines,
    'Aplicá esto con naturalidad; no lo recites ni lo menciones.'
  ].join('\n');
}
