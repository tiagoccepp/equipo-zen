// ── Addressing contextual (Equipo v2, Fase 1 / track T1) ────────────────────
// Decide a quién habla cada turno: ¿me habla a mí (Pablo), piensa en voz
// alta, habla con otro, o es ruido? Jev-free primario, Groq fallback,
// heurística fail-open. Shadow por defecto: loguea y devuelve legacy.
//
// Contrato:
//   classifyAddressing({ text, context }, opts)
//     → { decision, confidence, source, ms }
//   decision ∈ me_habla | piensa_en_voz_alta | habla_con_otro | ruido
//   source   ∈ jev | groq | heuristica | legacy | bypass
// Legacy (fail-open) = responder ⇒ decision me_habla.
//
// Modo (env PABLO_ADDRESSING, default shadow):
//   live   → decide de verdad (jev → groq → heurística).
//   shadow → clasifica igual, agrega JSONL a workspace/shadow/addressing.jsonl
//            y devuelve legacy (me_habla). Sirve para comparar sin afectar turnos.
//   off    → bypass total: no clasifica, no loguea, devuelve legacy.
//
// CERO hardcode: "pablo" en el texto es SEÑAL, nunca regla. El TO-vs-ABOUT se
// decide por contexto (pronombres, tiempo verbal, chatActive, último turno).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { LLM_PROVIDERS, rootDir } from './config.js';
import { parseJsonFromModel } from './llm.js';
import { getLlmKeys } from './settings.js';

export const DECISIONS = ['me_habla', 'piensa_en_voz_alta', 'habla_con_otro', 'ruido'];

// decision → acción del turno. solo-contexto = el texto entra al contexto
// pero no genera respuesta; ignorar = ni siquiera eso (basura/STT).
export const ADDRESSING_ACTION = {
  me_habla: 'responder',
  piensa_en_voz_alta: 'solo-contexto',
  habla_con_otro: 'ignorar',
  ruido: 'ignorar'
};

export const JEV_URL = 'https://opencode.ai/zen/v1/systemone';
export const JEV_MODEL = 'jev-1.13-free';
export const JEV_TIMEOUT_MS = 8000;
export const GROQ_TIMEOUT_MS = 5000;

// Pregunta `choice` TypeSafe (formato real docs.typesafe.ai/api, verificado
// 09/11 contra Zen en vivo): criteria = mapa opción → descripción.
const JEV_QUESTION_ID = 'addressing';
const JEV_CRITERIA = {
  me_habla: 'El hablante se dirige a Pablo/asistente: pregunta, pedido, orden o saludo en segunda persona.',
  piensa_en_voz_alta: 'El hablante razona consigo mismo: fragmentos, dudas, auto-preguntas sin esperar respuesta.',
  habla_con_otro: 'El hablante se dirige a otra persona (la nombra o le habla), no a Pablo.',
  ruido: 'Relleno, muletilla, fragmento de STT o sonido sin contenido dirigble.'
};
const JEV_INSTRUCTIONS = [
  '¿A quién le habla el hablante en este turno?',
  '"Pablo" en el texto es una señal más, no una regla: mirá pronombres, tiempo verbal y contexto',
  '(quién habló antes, de qué venían hablando) para decidir si LE HABLA a Pablo o HABLA DE Pablo.'
].join(' ');

export function getAddressingMode() {
  const raw = String(process.env.PABLO_ADDRESSING || 'shadow').trim().toLowerCase();
  return ['live', 'shadow', 'off'].includes(raw) ? raw : 'shadow';
}

export function defaultZenKeyPath() {
  return join(homedir(), '.config', 'equipo-zen.key');
}

export function defaultShadowPath() {
  return join(rootDir, 'workspace', 'shadow', 'addressing.jsonl');
}

function asDecision(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return DECISIONS.includes(v) ? v : null;
}

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function readKey(keyPath) {
  const p = keyPath || defaultZenKeyPath();
  try {
    const v = readFileSync(p, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchFn, url, { timeoutMs, ...init }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout en ${url}`)), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Jev primario ─────────────────────────────────────────────────────────
// POST TypeSafe real: { model, state, questions: { addressing: { type:
// 'choice', instructions, criteria } } } → answers.addressing { choice,
// confidence, probabilities }. (T1 lo había dejado especulativo; main lo
// corrigió contra docs + smoke en vivo 09/11.)
export async function callJev({ text, context = {}, key = null, keyPath = null, fetchFn = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const Z = key || readKey(keyPath);
  if (!Z) {
    throw new Error('Missing Zen key (sin key Jev, se intenta fallback).');
  }
  const started = Date.now();
  const response = await fetchWithTimeout(fetchFn, JEV_URL, {
    timeoutMs,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Z}`,
      // Zen exige sesión (mismo header que el proveedor opencode en config.js).
      'x-opencode-session': 'equipo-addressing'
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: JSON.stringify({ transcript: String(text || ''), context }),
      questions: {
        [JEV_QUESTION_ID]: {
          type: 'choice',
          instructions: JEV_INSTRUCTIONS,
          criteria: JEV_CRITERIA
        }
      }
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Jev HTTP ${response.status}: ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json().catch(() => null);
  const answer = body?.answers?.[JEV_QUESTION_ID] || null;
  const decision = asDecision(answer?.choice);
  if (!decision) {
    throw new Error('Jev devolvió decisión irreconocible.');
  }
  // confidence oficial; si falta, la prob de la opción ganadora.
  const fromProbs = answer?.probabilities ? answer.probabilities[answer.choice] : undefined;
  return {
    decision,
    confidence: clampConfidence(answer?.confidence ?? fromProbs, 0.7),
    source: 'jev',
    ms: Date.now() - started
  };
}

export function jevAuthHeader(Z) {
  return { Authorization: `Bearer ${Z}` };
}

// ── Groq fallback ────────────────────────────────────────────────────────
// Reusa el path llm/groq EXISTENTE: URL, modelo y headers salen de
// LLM_PROVIDERS.groq (config.js), la key de getLlmKeys('groq') (settings.js),
// el body espeja buildBody() de llm.js y el parse usa parseJsonFromModel().
// (llm.js rutea por proveedor ACTIVO, así que un completeChat directo llamaría
// al proveedor equivocado con la key de groq: por eso el fetch va a la URL de
// groq explícita, sin inventar protocolo.)
const GROQ_SYSTEM = [
  'Clasificás a quién habla cada turno. Respondé SOLO JSON: {"decision": <id>, "confidence": <0..1>}.',
  'Decisiones: me_habla (a Pablo/asistente: pregunta, pedido, orden, saludo en 2da persona),',
  'piensa_en_voz_alta (razona consigo mismo, no espera respuesta),',
  'habla_con_otro (se dirige a otra persona, no a Pablo), ruido (muletilla, fragmento STT, sin contenido).',
  '"Pablo" en el texto es una señal más, no una regla: mirá pronombres, tiempo verbal y contexto',
  '(chatActive, último turno) para decidir si LE HABLA a Pablo o HABLA DE Pablo.'
].join(' ');

export async function callGroqAddressing({ text, context = {}, groqKey = null, fetchFn = fetch, timeoutMs = GROQ_TIMEOUT_MS, model = null } = {}) {
  const provider = LLM_PROVIDERS.groq;
  const Z = groqKey || getLlmKeys('groq')[0] || '';
  if (!Z) {
    throw new Error('Missing Groq key (sin fallback Groq).');
  }
  const started = Date.now();
  const response = await fetchWithTimeout(fetchFn, provider.url, {
    timeoutMs,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Z}`,
      ...(provider.extraHeaders || {})
    },
    body: JSON.stringify({
      model: model || provider.defaultModel,
      messages: [
        { role: 'system', content: GROQ_SYSTEM },
        { role: 'user', content: JSON.stringify({ transcript: String(text || ''), context }) }
      ],
      stream: false,
      temperature: 0,
      max_completion_tokens: 120
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Groq HTTP ${response.status}: ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonFromModel(content);
  const decision = asDecision(parsed?.decision);
  if (!decision) {
    throw new Error('Groq devolvió decisión irreconocible.');
  }
  return {
    decision,
    confidence: clampConfidence(parsed?.confidence, 0.6),
    source: 'groq',
    ms: Date.now() - started
  };
}

// ── Heurística fail-open (conducta legacy = responder) ───────────────────
// Conservadora: default me_habla; solo patrones de alta señal desvían.
// "pablo" SIEMPRE se combina con otra señal (pronombre/tiempo/contexto).
const RE_SEGUNDA = /\b(vos|t[uú]|te\b|ti\b|tu\b|ustedes?|contame|decime|explicame|ayudame|pod[eé]s|puedes|haceme|mostrame|pasame|che\b)/i;
const RE_PREGUNTA = /\?\s*$/;
const RE_IMPERATIVO = /\b(decime|contame|explic[aá]|busca|busc[aá]|abri|abr[ií]|cerr[aá]|pon[eé]|sac[aá]|mostr[aá]|pas[aá]|llam[aá]|escrib[ií]|cre[aá]|hac[eé])/i;
// Tercera persona / pasado-narrado ⇒ HABLA DE, no LE HABLA.
const RE_TERCERA = /\b([eé]l|ella|ellos|dijo|dice que|hizo|hace que|fue|era|estaba|tiene que|va a venir|vino|llam[oó]|me dijo|le dije)\b/i;
const RE_PABLO = /pabl[oa]/i;
const RE_PENSAR = /^(mmm+|eh+|este+|a ver|veamos|bueno,? (a ver|veamos)|y si |capaz( que)?|quiz[aá]s|no s[eé](,|\.|$)|dejame pensar|estoy pensando)/i;
const RE_RUIDO = /^([a-záéíóúñ]{1,3}[.,… ]*|mmm+|eh+|aj[aá]|uh+|hm+)[.…, ]*$/i;
const RE_SALUDO = /^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|che|hey|ey)\b/i;

export function heuristicAddressing({ text = '', context = {} } = {}) {
  const started = Date.now();
  const t = String(text || '').trim();
  const chatActive = Boolean(context.chatActive);
  const lastTurn = String(context.lastTurn || '').toLowerCase(); // 'mine'|'theirs'|''

  const decide = (decision, confidence) => ({ decision, confidence, source: 'heuristica', ms: Date.now() - started });

  if (!t || t.length < 2 || RE_RUIDO.test(t)) {
    return decide('ruido', t ? 0.8 : 0.95);
  }

  const mencionaPablo = RE_PABLO.test(t);
  const segunda = RE_SEGUNDA.test(t) || RE_PREGUNTA.test(t) || RE_IMPERATIVO.test(t);
  const tercera = RE_TERCERA.test(t);

  // TO-vs-ABOUT-Pablo: "Pablo" + 2da persona/pregunta ⇒ LE HABLA;
  // "Pablo" + 3ra persona/pasado-narrado ⇒ HABLA DE (con otro).
  if (mencionaPablo && tercera && !segunda) {
    return decide('habla_con_otro', 0.75);
  }
  if (mencionaPablo && segunda) {
    return decide('me_habla', 0.8);
  }
  // "Pablo" solo, sin otra señal: el contexto manda (chat activo / me habló
  // último ⇒ probablemente me habla; si no, habla con otro).
  if (mencionaPablo) {
    if (chatActive || lastTurn === 'mine') {
      return decide('me_habla', 0.55);
    }
    return decide('habla_con_otro', 0.55);
  }

  // Vocativo a OTRO nombre ("María, ¿…?", "che Juan,…") ⇒ habla con otro.
  if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(,|\s+(¿|\?|qué|cuándo|cómo|dónde|por qué|me|te|se |le ))/u.test(t) && tercera) {
    return decide('habla_con_otro', 0.6);
  }

  // Piensa en voz alta: muletillas de arranque + sin pregunta directa ni
  // imperativo. Si el chat está activo y el último turno fue mío, igual puede
  // ser para mí ⇒ me_habla con confianza baja (fail-open).
  if (RE_PENSAR.test(t) && !segunda) {
    if (chatActive && lastTurn === 'mine') {
      return decide('me_habla', 0.45);
    }
    return decide('piensa_en_voz_alta', 0.65);
  }

  // Saludo corto ⇒ me habla (señal social directa).
  if (RE_SALUDO.test(t) && t.length < 40) {
    return decide('me_habla', 0.7);
  }

  // Pregunta o imperativo sin Pablo ⇒ me habla.
  if (segunda) {
    return decide('me_habla', 0.65);
  }

  // Default fail-open: ante la duda, RESPONDER (conducta legacy).
  return decide('me_habla', 0.4);
}

// ── Shadow log (JSONL, nunca incluye keys) ───────────────────────────────
export function appendShadowLog(entry, shadowPath = null) {
  const p = shadowPath || defaultShadowPath();
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    text: String(entry?.text || '').slice(0, 2000),
    context: entry?.context || {},
    classification: entry?.classification || null,
    legacy: entry?.legacy || null
  });
  appendFileSync(p, `${line}\n`, 'utf8');
  return p;
}

export function legacyResult(ms = 0) {
  return { decision: 'me_habla', confidence: 1, source: 'legacy', ms };
}

// ── Entrada principal ────────────────────────────────────────────────────
export async function classifyAddressing({ text = '', context = {} } = {}, opts = {}) {
  const started = Date.now();
  const mode = opts.mode || getAddressingMode();
  const fetchFn = opts.fetchFn || fetch;
  const groqFn = opts.groqFn || null; // inyectable (tests); default = callGroqAddressing
  const timeoutMs = opts.timeoutMs || JEV_TIMEOUT_MS;

  if (mode === 'off') {
    return { decision: 'me_habla', confidence: 1, source: 'bypass', ms: Date.now() - started };
  }

  // Cadena live: jev → groq → heurística. Cualquier excepción cae al
  // siguiente eslabón; la heurística nunca lanza (fail-open total).
  const runChain = async () => {
    let result = null;
    try {
      result = await callJev({ text, context, keyPath: opts.keyPath || null, fetchFn, timeoutMs });
    } catch {
      result = null;
    }
    if (!result) {
      try {
        result = groqFn
          ? await groqFn({ text, context })
          : await callGroqAddressing({ text, context, groqKey: opts.groqKey || null, fetchFn, timeoutMs: opts.groqTimeoutMs || GROQ_TIMEOUT_MS });
      } catch {
        result = null;
      }
    }
    if (!result) {
      result = heuristicAddressing({ text, context });
    }
    return result;
  };

  if (mode === 'shadow') {
    const legacy = legacyResult(Date.now() - started);
    // Shadow NO espera (main 09/11): Jev frío tarda ~3s y ni shadow puede
    // pagarlo en el hot path del turno. Clasifica en background y loguea
    // al terminar. awaitShadow=true solo para tests deterministas.
    if (opts.awaitShadow) {
      const result = await runChain();
      try {
        appendShadowLog({ text, context, classification: result, legacy }, opts.shadowPath || null);
      } catch {
        // El log nunca tumba el turno.
      }
      return { ...legacy, shadowed: result };
    }
    void runChain().then(
      (result) => {
        try {
          appendShadowLog({ text, context, classification: result, legacy }, opts.shadowPath || null);
        } catch {
          // El log nunca tumba nada (ya estamos fuera del turno).
        }
      },
      () => {
        // runChain no rechaza (heurística fail-open), pero void exige handler.
      }
    );
    return { ...legacy, shadowed: null };
  }

  return runChain();
}
