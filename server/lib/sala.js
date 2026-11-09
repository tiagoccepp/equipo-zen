// ── Sala v1: gate solo-vs-equipo + 1 consulta silenciosa ────────────────
// Team v1 (timebox): sin rondas, sin UI, sin LLM para el gate. Si el flag
// sala.v1 está OFF, este módulo no se usa y el turno sigue idéntico.
// Especialista único en v1: Iván (investigación). El roster completo es v2.
//
// Contrato de degradación segura: TODO error/timeout → flujo normal.
// La consulta NUNCA habla al usuario: su texto se inyecta como TEAM NOTE
// silencioso al contexto del turno, y Pablo decide qué usar sin mencionarlo.

import {
  DEFAULT_SOP,
  getSalaAgentTimeoutMs,
  getSalaSop,
  getSalaTimeoutMs,
  getSalaV1,
  getSalaV2
} from './settings.js';
import { withTimeout } from './llm.js';

export { DEFAULT_SOP };

// Prefijo del NOTE inyectado al contexto del turno. El prompt del turno lo
// trata como contexto interno: Pablo lo usa en silencio, nunca lo cita.
export const TEAM_NOTE_PREFIX = 'TEAM NOTE (use silently, never mention):';

// System MÍNIMO del especialista v1 (Iván, investigación). Corto a
// propósito: el contexto largo lo tiene solo Pablo (§2.2 research).
export const IVAN_SYSTEM =
  'you research, answer facts only, 5 lines max';

// Keywords (normalizadas, sin acentos) que activan el gate. Trade-offs,
// comparaciones y pedidos de análisis/opinión → conviene 2ª opinión.
const GATE_KEYWORDS = [
  'trade-off', 'tradeoff', 'trade off',
  'compara', 'conviene', 'analiza', 'analizá',
  'pros', 'contras', 'pros-contras', 'pros y contras',
  'segunda opinion', 'segunda-opinion',
  'que te parece', 'qué te parece', 'que opinas', 'qué opinás',
  'cual es mejor', 'cuál es mejor', 'cual conviene', 'cuál conviene',
  'ventajas', 'desventajas', 'alternativa',
  'diseno', 'diseño', 'riesgo', 'propuesta'
];

// Largo a partir del cual el pedido probablemente es multi-dominio.
export const GATE_MIN_LENGTH = 200;

// ── Gate ────────────────────────────────────────────────────────────────
// Heurística SIN LLM (~0ms). Devuelve true si conviene 1 consulta silenciosa.
// route: resultado de AgentRouter.route() (opcional; si falta, solo texto).
export function shouldConsult(text, route = null) {
  const input = String(text || '');
  if (!input.trim()) {
    return false;
  }
  // Saludos y cierres nunca abren sala (lección 9bc6dbd: no coros).
  if (route && (route.greeting || route.closing)) {
    return false;
  }
  // Pedido largo → probablemente multi-dominio.
  if (input.length > GATE_MIN_LENGTH) {
    return true;
  }
  const normalized = input.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (GATE_KEYWORDS.some((kw) => normalized.includes(kw))) {
    return true;
  }
  // Route multi-dominio: ≥2 targets no-CEO con dominios distintos.
  if (route && Array.isArray(route.targets)) {
    const especialistas = route.targets.filter(
      (t) => !/general coordination|greeting|topic close/.test(
        String((t.matchedDomains || []).join(' '))
      )
    );
    const dominios = new Set();
    for (const t of especialistas) {
      for (const d of (t.matchedDomains || [])) {
        dominios.add(String(d));
      }
    }
    if (especialistas.length >= 2 && dominios.size >= 2) {
      return true;
    }
  }
  return false;
}

// ── Consulta silenciosa ─────────────────────────────────────────────────
// Hace 1 completeChat como especialista y devuelve el NOTE listo para
// inyectar, o null si hay que seguir con flujo normal (flag off, gate
// negativo, error, timeout). Nunca lanza: try/catch total.
//
// Deps inyectables para tests: { completeChat, keyRing, models, scope,
// timeoutMs, flagOn, onTelemetry }.
export async function consult({ text, specialty = 'ivan', route = null, deps = {} }) {
  const telemetry = typeof deps.onTelemetry === 'function' ? deps.onTelemetry : () => {};
  try {
    // Flag OFF → cero cambios, cero costo.
    const flagOn = deps.flagOn !== undefined ? deps.flagOn : getSalaV1();
    if (!flagOn) {
      telemetry('sala_skip', { reason: 'flag_off' });
      return null;
    }
    if (!shouldConsult(text, route)) {
      telemetry('sala_skip', { reason: 'gate_negative' });
      return null;
    }
    const completeChat = deps.completeChat;
    if (typeof completeChat !== 'function') {
      telemetry('sala_skip', { reason: 'no_model_fn' });
      return null;
    }
    const timeoutMs = deps.timeoutMs !== undefined ? deps.timeoutMs : getSalaTimeoutMs();
    const system = specialty === 'ivan' ? IVAN_SYSTEM : IVAN_SYSTEM; // v1: solo Iván
    const { text: answer } = await withTimeout(
      completeChat(deps.keyRing, {
        scope: deps.scope || 'sala_consult',
        models: deps.models,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: String(text).slice(0, 2000) }
        ],
        maxTokens: 300
      }),
      timeoutMs,
      'Timeout en sala_consult.'
    );
    const clean = String(answer || '').trim();
    if (!clean) {
      telemetry('sala_skip', { reason: 'empty_answer' });
      return null;
    }
    telemetry('sala_note', { specialty, chars: clean.length });
    return `${TEAM_NOTE_PREFIX} ${clean}`;
  } catch {
    // Timeout, fallo de modelo, settings caídos: flujo normal.
    telemetry('sala_skip', { reason: 'error' });
    return null;
  }
}

// ── Sala v2: discusión ordenada (rondas + síntesis de Pablo) ─────────────
// Detrás del flag sala.v2 (default OFF). Cuando el gate v1 rutea a equipo:
// R1 aportes en turno (orden por score) → R2 disenso condicional (orden
// inverso) → Pablo sintetiza con voto de calidad. Tito solo habla con Pablo:
// el resultado se inyecta como TEAM NOTE silencioso igual que v1.
// Degradación segura: TODO error/timeout/aborto → null (flujo normal).
// v1 (consult) queda intacto; v2 es código puramente aditivo.

export const V2_MAX_SPEAKERS = 4;
export const V2_MAX_ROUNDS_HARD = 2; // Tope duro: el SOP no puede pedir más.
export const V2_DEFAULT_AGENT_TIMEOUT_MS = 20000;

const SILENCE_RE = /^\s*SILENCIO\b/i;

// Voces por defecto cuando el route no trae targets útiles (gate por
// keyword/texto largo sin route). Orden = orden de oficio Iván→Bruno→Camila.
const DEFAULT_SPEAKERS = [
  { agentId: 'ivan', score: 0, domains: ['web'] },
  { agentId: 'bruno', score: 0, domains: ['codigo'] },
  { agentId: 'camila', score: 0, domains: ['riesgo'] }
];

// Systems cortos por oficio: el contexto largo lo tiene solo Pablo.
const SPECIALIST_SYSTEMS = {
  ivan: 'Sos Iván, investigador. Buscás datos y comparás alternativas. Citás fuente o decís "no verifiqué". No escribís archivos ni corrés comandos.',
  bruno: 'Sos Bruno, builder. Proponés cómo construir: archivos, código, comandos. No inventás requisitos.',
  camila: 'Sos Camila, revisora y abogada del diablo. Tu trabajo es romper propuestas: riesgos, edge cases, costos. Siempre das veredicto.',
  tomasa: 'Sos Tomasa, operativa. Seguimiento, estado, checklists. No prometés fechas sin chequear estado real.'
};
const GENERIC_SPECIALIST_SYSTEM = 'Sos un especialista del equipo. Aportás desde tu oficio con datos concretos.';

const APORTE_FORMAT = [
  'Formato obligatorio de respuesta:',
  'APORTE [tu-nombre]: <claim en 1 línea>',
  'EVIDENCIA: <dato citado o "no verifiqué">',
  'CONFIANZA: alta/media/baja',
  'IMPLICA: <qué debería hacer Pablo con esto>',
  'Si no aportás nada nuevo, respondé exactamente: SILENCIO'
].join('\n');

const DISENSO_FORMAT = [
  'Formato obligatorio de respuesta:',
  'DISENSO [tu-nombre] -> [nombre]: <qué objetás, en 1 línea>',
  'PORQUE: <motivo con dato, no gusto>',
  'PROPONGO: <alternativa concreta o "mantengo lo mío">',
  'Prohibido disentir sin proponer. Si estás de acuerdo, respondé exactamente: SILENCIO'
].join('\n');

// ── SOP ─────────────────────────────────────────────────────────────────
// Knobs parseados del texto (líneas `clave: valor`, case-insensitive):
// order: score-desc|score-asc · max_rounds: 1..2 (clamp duro) ·
// agent_timeout_ms: 1000..60000 · r2: on-disagreement|always|never.
// Lo desconocido o ausente → default. Puro y testeable.
export function parseSop(text) {
  const out = {
    order: 'score-desc',
    maxRounds: 2,
    agentTimeoutMs: V2_DEFAULT_AGENT_TIMEOUT_MS,
    r2: 'on-disagreement'
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim().toLowerCase();
    if (line.startsWith('order:')) {
      const v = line.slice(6).trim();
      if (v === 'score-desc' || v === 'score-asc') {
        out.order = v;
      }
    } else if (line.startsWith('max_rounds:')) {
      const n = Number.parseInt(line.slice(11).trim(), 10);
      if (Number.isFinite(n)) {
        out.maxRounds = Math.min(V2_MAX_ROUNDS_HARD, Math.max(1, n));
      }
    } else if (line.startsWith('agent_timeout_ms:')) {
      const n = Number.parseInt(line.slice(17).trim(), 10);
      if (Number.isFinite(n)) {
        out.agentTimeoutMs = Math.min(60000, Math.max(1000, n));
      }
    } else if (line.startsWith('r2:')) {
      const v = line.slice(3).trim();
      if (v === 'on-disagreement' || v === 'always' || v === 'never') {
        out.r2 = v;
      }
    }
  }
  return out;
}

// ── Orden de voces ──────────────────────────────────────────────────────
// Targets del router ordenados por score (dirección según SOP), sin CEO /
// greeting / closing, máx V2_MAX_SPEAKERS. Sin targets útiles → roster
// default. Puro y testeable.
export function orderSpeakers(route, sop = {}) {
  const order = sop.order === 'score-asc' ? 'score-asc' : 'score-desc';
  let cands = [];
  if (route && Array.isArray(route.targets)) {
    cands = route.targets
      .filter((t) => !/general coordination|greeting|topic close/i.test(
        String((t.matchedDomains || []).join(' '))
      ))
      .map((t) => ({
        agentId: String(t.agentId || ''),
        score: Number(t.score) || 0,
        domains: t.matchedDomains || []
      }))
      .filter((t) => t.agentId);
  }
  if (cands.length === 0) {
    cands = DEFAULT_SPEAKERS.map((s) => ({ ...s }));
  }
  cands.sort((a, b) => (order === 'score-asc' ? a.score - b.score : b.score - a.score));
  return cands.slice(0, V2_MAX_SPEAKERS);
}

// ¿Hay desacuerdo real? Regla simple y determinística: ≥2 aportes
// no-silencio en R1. (Refinar con similitud de claims es mejora futura.)
export function hasDisagreement(aportesR1) {
  const vivos = (aportesR1 || []).filter((a) => a && a.kind !== 'silencio' && a.kind !== 'ausente');
  return vivos.length >= 2;
}

function specialistSystem(agentId, sopText, round) {
  const oficio = SPECIALIST_SYSTEMS[String(agentId).toLowerCase()]
    || GENERIC_SPECIALIST_SYSTEM;
  const formato = round === 2 ? DISENSO_FORMAT : APORTE_FORMAT;
  return `${oficio}\nReglas de sala (SOP):\n${sopText}\n${formato}`;
}

function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

// 1 turno de 1 voz: 1 completeChat con timeout. Devuelve aporte o marca
// ausente (timeout/error → se sigue sin él, S10). Nunca lanza.
async function speak({ speaker, round, prompt, completeChat, deps, timeoutMs, telemetry }) {
  try {
    const { text: answer } = await withTimeout(
      completeChat(deps.keyRing, {
        scope: deps.scope || 'sala_v2',
        models: deps.models,
        messages: [
          { role: 'system', content: speaker.system },
          { role: 'user', content: prompt }
        ],
        maxTokens: round === 2 ? 300 : 300
      }),
      timeoutMs,
      'Timeout en sala_v2.'
    );
    const clean = String(answer || '').trim();
    if (!clean || SILENCE_RE.test(clean)) {
      telemetry('sala_aporte', { agentId: speaker.agentId, round, kind: 'silencio' });
      return { agentId: speaker.agentId, round, kind: 'silencio', text: '' };
    }
    telemetry('sala_aporte', { agentId: speaker.agentId, round, kind: round === 2 ? 'disenso' : 'aporte' });
    return {
      agentId: speaker.agentId,
      round,
      kind: round === 2 ? 'disenso' : 'aporte',
      text: clean
    };
  } catch {
    telemetry('sala_ausente', { agentId: speaker.agentId, round });
    return { agentId: speaker.agentId, round, kind: 'ausente', text: '' };
  }
}

// ── Sala v2 completa ────────────────────────────────────────────────────
// Devuelve { note, synthesis, aportes, roundsRun, ausentes, speakers } o
// null (flag off, gate negativo, sin aportes, aborto sin nada, sin modelo).
// Nunca lanza. Deps: { completeChat, keyRing, models, scope, flagV2,
// sopText, agentTimeoutMs, timeoutMs, signal, onTelemetry }.
export async function runSalaV2({ text, route = null, deps = {} }) {
  const telemetry = typeof deps.onTelemetry === 'function' ? deps.onTelemetry : () => {};
  try {
    const flagOn = deps.flagV2 !== undefined ? deps.flagV2 : getSalaV2();
    if (!flagOn) {
      telemetry('sala_skip', { reason: 'flag_off', sala: 'v2' });
      return null;
    }
    if (!shouldConsult(text, route)) {
      telemetry('sala_skip', { reason: 'gate_negative', sala: 'v2' });
      return null;
    }
    const completeChat = deps.completeChat;
    if (typeof completeChat !== 'function') {
      telemetry('sala_skip', { reason: 'no_model_fn', sala: 'v2' });
      return null;
    }
    const sopText = deps.sopText !== undefined ? deps.sopText : getSalaSop();
    const sop = parseSop(sopText);
    const speakers = orderSpeakers(route, sop);
    const agentTimeoutMs = deps.agentTimeoutMs !== undefined
      ? deps.agentTimeoutMs
      : (sop.agentTimeoutMs || getSalaAgentTimeoutMs());
    const signal = deps.signal || null;
    const question = String(text).slice(0, 2000);

    telemetry('sala_open', {
      pregunta: question.slice(0, 120),
      convocados: speakers.map((s) => s.agentId)
    });

    const aportes = [];
    const ausentes = [];
    let roundsRun = 0;

    // R1 — aportes en turno (orden por score).
    roundsRun = 1;
    for (const speaker of speakers) {
      if (isAborted(signal)) {
        break;
      }
      const aporte = await speak({
        speaker: { ...speaker, system: specialistSystem(speaker.agentId, sopText, 1) },
        round: 1,
        prompt: `Pregunta de Tito: "${question}"\nRespondé con formato APORTE o SILENCIO.`,
        completeChat,
        deps,
        timeoutMs: agentTimeoutMs,
        telemetry
      });
      aportes.push(aporte);
      if (aporte.kind === 'ausente') {
        ausentes.push(aporte.agentId);
      }
    }
    const cortadaR1 = isAborted(signal);

    // R2 — disenso en orden inverso, solo si corresponde y no hubo barge-in.
    const vivosR1 = aportes.filter((a) => a.kind !== 'silencio' && a.kind !== 'ausente');
    const quiereR2 = sop.maxRounds >= 2 && !cortadaR1
      && (sop.r2 === 'always' ? vivosR1.length >= 1 : sop.r2 === 'never' ? false : hasDisagreement(aportes));
    if (quiereR2) {
      roundsRun = 2;
      const contextoR1 = vivosR1.map((a) => `- ${a.agentId}: ${a.text}`).join('\n');
      const inverso = [...speakers].reverse();
      for (const speaker of inverso) {
        if (isAborted(signal)) {
          break;
        }
        const disenso = await speak({
          speaker: { ...speaker, system: specialistSystem(speaker.agentId, sopText, 2) },
          round: 2,
          prompt: `Pregunta de Tito: "${question}"\nAportes R1:\n${contextoR1}\nRespondé con formato DISENSO o SILENCIO.`,
          completeChat,
          deps,
          timeoutMs: agentTimeoutMs,
          telemetry
        });
        aportes.push(disenso);
        if (disenso.kind === 'ausente') {
          ausentes.push(disenso.agentId);
        }
      }
    }

    const vivos = aportes.filter((a) => a.kind === 'aporte' || a.kind === 'disenso');
    if (vivos.length === 0) {
      telemetry('sala_skip', { reason: cortadaR1 || isAborted(signal) ? 'barge_in' : 'all_silence', sala: 'v2' });
      return null;
    }

    // R3 — Pablo sintetiza con voto de calidad. Si la síntesis falla, NOTE
    // fallback con los aportes crudos (determinístico, sin costo extra).
    const bloque = vivos.map((a) => `- ${a.agentId} (R${a.round}): ${a.text}`).join('\n');
    let synthesis = '';
    try {
      const synthTimeout = deps.timeoutMs !== undefined ? deps.timeoutMs : getSalaTimeoutMs();
      const { text: answer } = await withTimeout(
        completeChat(deps.keyRing, {
          scope: deps.scope || 'sala_v2_sintesis',
          models: deps.models,
          messages: [
            {
              role: 'system',
              content: 'Sos Pablo, moderador del equipo. Sintetizás la discusión y decidís (voto de calidad si hay disenso). Respondé corto: DECISIÓN + motivo + dueños + riesgo (o "riesgo: ninguno").'
            },
            {
              role: 'user',
              content: `Pregunta de Tito: "${question}"\nDiscusión del equipo:\n${bloque}\nSintetizá y decidí.`
            }
          ],
          maxTokens: 600
        }),
        synthTimeout,
        'Timeout en sala_v2_sintesis.'
      );
      synthesis = String(answer || '').trim();
    } catch {
      synthesis = '';
    }
    if (!synthesis) {
      synthesis = `DECISIÓN (fallback sin síntesis): aportes del equipo:\n${bloque}`;
    }
    telemetry('sala_close', {
      rounds: roundsRun,
      aportes: vivos.length,
      ausentes,
      bargeIn: isAborted(signal)
    });
    return {
      note: `${TEAM_NOTE_PREFIX} ${synthesis}`,
      synthesis,
      aportes,
      roundsRun,
      ausentes,
      speakers: speakers.map((s) => s.agentId)
    };
  } catch {
    telemetry('sala_skip', { reason: 'error', sala: 'v2' });
    return null;
  }
}
