// ── Contextual addressing (v2, Phase 1 / track T1) ─────────────────────────
// Decides whom each turn talks to: talking to me (Pablo), thinking aloud,
// talking to someone else, or noise? Primary Jev-free, Groq fallback,
// fail-open heuristic. Shadow by default: logs and returns legacy.
//
// Contract:
//   classifyAddressing({ text, context }, opts)
//     → { decision, confidence, source, ms }
//   decision ∈ me_habla | piensa_en_voz_alta | habla_con_otro | ruido
//   source   ∈ jev | groq | heuristica | legacy | bypass
// Legacy (fail-open) = respond ⇒ me_habla decision.
//
// Mode (env PABLO_ADDRESSING, default shadow):
//   live   → really decides (jev → groq → heuristic).
//   shadow → classifies the same, appends JSONL to workspace/shadow/addressing.jsonl
//            and returns legacy (me_habla). Lets you compare without affecting turns.
//   off    → total bypass: neither classifies nor logs, returns legacy.
//
// ZERO hardcode: "pablo" in the text is a SIGNAL, never a rule. TO-vs-ABOUT is
// decided by context (pronouns, verb tense, chatActive, last turn).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { LLM_PROVIDERS, rootDir } from './config.js';
import { parseJsonFromModel } from './llm.js';
import { getLlmKeys } from './settings.js';

export const DECISIONS = ['me_habla', 'piensa_en_voz_alta', 'habla_con_otro', 'ruido'];

// decision → turn action. solo-contexto = the text enters the context
// but produces no reply; ignorar = not even that (garbage/STT).
export const ADDRESSING_ACTION = {
  me_habla: 'responder',
  piensa_en_voz_alta: 'solo-contexto',
  habla_con_otro: 'ignorar',
  ruido: 'ignorar'
};

export const JEV_URL = 'https://opencode.ai/inference/systemone/v1/systemone';
export const JEV_MODEL = 'jev-1.13-free';
export const JEV_TIMEOUT_MS = 8000;
export const GROQ_TIMEOUT_MS = 5000;

// TypeSafe `choice` question (real format docs.typesafe.ai/api, verified
// 09/11 against live Zen): criteria = option → description map.
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

// ── Primary Jev ────────────────────────────────────────────────────────
// Real TypeSafe POST: { model, state, questions: { addressing: { type:
// 'choice', instructions, criteria } } } → answers.addressing { choice,
// confidence, probabilities }. (T1 had left it speculative; main fixed it
// against docs + live smoke test on 09/11.)
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
      // Go lane requires a session (same header as the opencode provider in config.js).
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
  // official confidence; if missing, the winning option's prob.
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
// Reuses the EXISTING llm/groq path: URL, model and headers come from
// LLM_PROVIDERS.groq (config.js), the key from getLlmKeys('groq') (settings.js),
// the body mirrors buildBody() in llm.js and parsing uses parseJsonFromModel().
// (llm.js routes by ACTIVE provider, so a direct completeChat would call
// the wrong provider with the groq key: hence fetch goes to the explicit
// groq URL, without inventing a protocol.)
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

// ── Fail-open heuristic (legacy behavior = respond) ──────────────────────
// Conservative: me_habla default; only high-signal patterns divert.
// "pablo" is ALWAYS combined with another signal (pronoun/tense/context).
const RE_SEGUNDA = /\b(vos|t[uú]|te\b|ti\b|tu\b|ustedes?|contame|decime|explicame|ayudame|pod[eé]s|puedes|haceme|mostrame|pasame|che\b)/i;
const RE_PREGUNTA = /\?\s*$/;
const RE_IMPERATIVO = /\b(decime|contame|explic[aá]|busca|busc[aá]|abri|abr[ií]|cerr[aá]|pon[eé]|sac[aá]|mostr[aá]|pas[aá]|llam[aá]|escrib[ií]|cre[aá]|hac[eé])/i;
// Third person / narrated past ⇒ TALKING ABOUT, not TALKING TO.
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

  // TO-vs-ABOUT-Pablo: "Pablo" + 2nd person/question ⇒ TALKING TO;
  // "Pablo" + 3rd person/narrated past ⇒ TALKING ABOUT (with someone else).
  if (mencionaPablo && tercera && !segunda) {
    return decide('habla_con_otro', 0.75);
  }
  if (mencionaPablo && segunda) {
    return decide('me_habla', 0.8);
  }
  // "Pablo" alone, no other signal: context rules (active chat / talked to
  // me last ⇒ probably talking to me; otherwise, talking to someone else).
  if (mencionaPablo) {
    if (chatActive || lastTurn === 'mine') {
      return decide('me_habla', 0.55);
    }
    return decide('habla_con_otro', 0.55);
  }

  // Vocative to ANOTHER name ("María, ¿…?", "che Juan,…") ⇒ talking to someone else.
  if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(,|\s+(¿|\?|qué|cuándo|cómo|dónde|por qué|me|te|se |le ))/u.test(t) && tercera) {
    return decide('habla_con_otro', 0.6);
  }

  // Thinking aloud: opening fillers + no direct question or
  // imperative. If the chat is active and the last turn was mine, it may still
  // be for me ⇒ me_habla with low confidence (fail-open).
  if (RE_PENSAR.test(t) && !segunda) {
    if (chatActive && lastTurn === 'mine') {
      return decide('me_habla', 0.45);
    }
    return decide('piensa_en_voz_alta', 0.65);
  }

  // Short greeting ⇒ talking to me (direct social signal).
  if (RE_SALUDO.test(t) && t.length < 40) {
    return decide('me_habla', 0.7);
  }

  // Question or imperative without Pablo ⇒ talking to me.
  if (segunda) {
    return decide('me_habla', 0.65);
  }

  // Fail-open default: when in doubt, RESPOND (legacy behavior).
  return decide('me_habla', 0.4);
}

// ── Shadow log (JSONL, never includes keys) ──────────────────────────────
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

// ── Main entry ─────────────────────────────────────────────────────────
export async function classifyAddressing({ text = '', context = {} } = {}, opts = {}) {
  const started = Date.now();
  const mode = opts.mode || getAddressingMode();
  const fetchFn = opts.fetchFn || fetch;
  const groqFn = opts.groqFn || null; // injectable (tests); default = callGroqAddressing
  const timeoutMs = opts.timeoutMs || JEV_TIMEOUT_MS;

  if (mode === 'off') {
    return { decision: 'me_habla', confidence: 1, source: 'bypass', ms: Date.now() - started };
  }

  // Live chain: jev → groq → heuristic. Any exception falls through to
  // the next link; the heuristic never throws (total fail-open).
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
    // Shadow does NOT wait (main 09/11): cold Jev takes ~3s and not even shadow
    // can afford it on the turn hot path. Classifies in background and logs
    // on completion. awaitShadow=true only for deterministic tests.
    if (opts.awaitShadow) {
      const result = await runChain();
      try {
        appendShadowLog({ text, context, classification: result, legacy }, opts.shadowPath || null);
      } catch {
        // Logging never breaks the turn.
      }
      return { ...legacy, shadowed: result };
    }
    void runChain().then(
      (result) => {
        try {
          appendShadowLog({ text, context, classification: result, legacy }, opts.shadowPath || null);
        } catch {
          // Logging never breaks anything (already outside the turn).
        }
      },
      () => {
        // runChain never rejects (fail-open heuristic), but void requires a handler.
      }
    );
    return { ...legacy, shadowed: null };
  }

  return runChain();
}
