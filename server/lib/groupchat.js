// ── Llamada grupal: réplicas entre agentes (R2 + cierre CEO) ──────────────
// Lógica PURA (sin LLM, sin I/O): decidir quién replica tras la ronda 1.
//
// Regla: los agentes ALUDIDOS por un compañero en R1 (mención por
// nombre/alias) responden en R2. Tope: máx 2 rondas + cierre CEO, máx 3
// voces por turno salvo que Tito pida a todos (groupAddressed/greeting).
// SILENCIO sigue válido en todas las rondas (lo decide cada modelo).
//
// Todo el cableado vivo va detrás del flag `sala.groupchat` (default OFF):
// este módulo solo calcula; meeting-session.js decide si lo usa.

import { getMentionIndex, normalize } from './text.js';

export const MAX_ROUNDS = 2;
export const MAX_VOICES = 3;

// Marcadores de disenso explícito (normalizados, sin acentos): sirven para
// clasificar la réplica en telemetría, NO deciden solos (la mención manda).
// "Disenso real" sin mención lo juzga cada modelo con SILENCIO disponible.
const DISENSO_PATTERNS = [
  'no estoy de acuerdo', 'no estoy deacuerdo', 'discrepo', 'no coincido',
  'sin embargo', 'pero ', ' ojo ', 'ojo con', 'me preocupa', 'riesgo',
  'no me convence', 'no me cierra', 'cuidado con', 'en contra',
  'no es asi', 'no es tan simple', 'matiz', 'objecion', 'objeto que'
];

export function looksLikeDisenso(text) {
  const norm = ` ${normalize(text)} `;
  return DISENSO_PATTERNS.some((p) => norm.includes(p));
}

// Agentes mencionados en un texto, por nombre o alias del roster.
// excludeIds: los que ya hablaron (no se replican a sí mismos).
// Devuelve [{ agent, index }] ordenados por primera mención.
export function findMentionedAgents(text, agents, { excludeIds = null } = {}) {
  const normalized = normalize(text);
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const found = [];
  for (const agent of agents || []) {
    if (!agent?.id || excluded.has(agent.id)) {
      continue;
    }
    const aliases = Array.isArray(agent.aliases) && agent.aliases.length > 0
      ? agent.aliases
      : [agent.name];
    const index = getMentionIndex(normalized, aliases);
    if (index >= 0) {
      found.push({ agent, index });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

// ¿Tito pidió a todos? Con grupo convocado no hay tope de voces.
export function groupRequested(route) {
  return Boolean(route?.groupAddressed || route?.greeting || route?.groupGreeting);
}

// Recorta targets a MAX_VOICES cuando Tito NO pidió a todos.
// No muta: devuelve { targets, capped }.
export function capTargets(targets, route, maxVoices = MAX_VOICES) {
  const list = Array.isArray(targets) ? targets : [];
  if (groupRequested(route) || list.length <= maxVoices) {
    return { targets: list, capped: 0 };
  }
  return { targets: list.slice(0, maxVoices), capped: list.length - maxVoices };
}

// Targets de R2: aludidos en las respuestas de R1 que aún no hablaron.
// responsesR1: [{ agentId, name, text }] (route.responses tras R1).
// agents: roster activo (sessionAgents); spokenIds: hablaron este turno.
// totalSpoken: voces que ya salieron (R1 + réplicas); si el grupo NO fue
// convocado, R2 solo usa el resto hasta MAX_VOICES.
// Devuelve [{ agentId, name, score, directMention, matchedDomains, citedBy }].
export function selectReplicaTargets({ responsesR1, agents, spokenIds, totalSpoken = 0, route = null, maxVoices = MAX_VOICES }) {
  const roster = (agents || []).filter((a) => a && a.enabled !== false);
  const spoken = spokenIds instanceof Set ? new Set(spokenIds) : new Set(spokenIds || []);
  const byId = new Map(roster.map((a) => [a.id, a]));
  const picked = [];
  const pickedIds = new Set();

  const roomLeft = () => (groupRequested(route) ? Infinity : maxVoices - totalSpoken - picked.length);

  for (const response of responsesR1 || []) {
    if (!response?.text || roomLeft() <= 0) {
      continue;
    }
    // El que habló en R1 no se replica a sí mismo en este turno.
    const exclude = new Set([...spoken, ...pickedIds, response.agentId]);
    for (const { agent } of findMentionedAgents(response.text, roster, { excludeIds: exclude })) {
      if (roomLeft() <= 0) {
        break;
      }
      if (pickedIds.has(agent.id)) {
        continue;
      }
      pickedIds.add(agent.id);
      picked.push({
        agentId: agent.id,
        name: agent.name,
        score: 6,
        directMention: true,
        matchedDomains: ['réplica grupal'],
        citedBy: response.name || response.agentId,
        citedText: String(response.text).slice(0, 300)
      });
    }
  }

  // Solo agentes del roster válido (por si el id no existe).
  return picked.filter((t) => byId.has(t.agentId));
}

// ¿La CEO cierra? R2 tuvo ≥1 voz, CEO activa y sin hablar este turno.
export function shouldCeoClose({ replicaSpoke, agents, spokenIds }) {
  if (!replicaSpoke) {
    return null;
  }
  const spoken = spokenIds instanceof Set ? spokenIds : new Set(spokenIds || []);
  const ceo = (agents || []).find((a) => a?.role === 'ceo' && a?.enabled !== false);
  if (!ceo || spoken.has(ceo.id)) {
    return null;
  }
  return ceo;
}

// Texto del turno de réplica: el agente le habla AL compañero citado.
// Va con isContextualFollowup (render "Tu compañero dijo algo…").
export function replicaTurnText({ citedBy, citedText, originalText }) {
  const cita = String(citedText || '').slice(0, 300);
  const pedido = String(originalText || '').slice(0, 500);
  return `${citedBy} te habló en la reunión: "${cita}"`
    + (pedido ? `\n\nTito había pedido: "${pedido}"` : '')
    + '\n\nSi te habló a vos, respondéle a ÉL por su nombre ("Bruno, eso que decís…"). Si no tenés nada que agregar, SILENCIO.';
}

// Texto del cierre CEO: 1 línea, sin reabrir.
export function ceoCloseTurnText({ originalText }) {
  const pedido = String(originalText || '').slice(0, 500);
  return `Tus compañeros acaban de discutir entre ellos sobre: "${pedido}"\n\nCerrá la ronda en UNA línea (decisión o siguiente paso). No reabras el debate.`;
}
