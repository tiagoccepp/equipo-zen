import { AGENT_TEXT_TIMEOUT_MS, projectSessionId } from './config.js';
import { renderSkillsSection } from './skills.js';
import { getDeepgramKey, getManosEnabled, getManosMaxTurns, getMinimaxModels, getSttLanguage, getTtsLanguage, getTtsOrder, getTtsSpeed, modelsForTier } from './settings.js';
import { completeChat, streamChat, withTimeout } from './llm.js';
import { synthesize } from './supertonic.js';
import { synthesizePiper } from './piper.js';
import { synthesizeEdgeMp3 } from './edge-tts.js';
import { synthesizeDeepgram } from './deepgram.js';
import { cleanAgentText, createMermaidSpeechFilter, shapeSpeechText, createPartsParser, createTagFilter, getShortError, isSilenceResponse, normalize, stripForeignScript, stripPrivateBlocks, stripProgressBlocks, stripSpeechLeaks, stripTaskTags } from './text.js';
import { GESTOS_A, GESTOS_B, parseGesto } from './gestos.js';
import { sentenceAudioMs, sentenceAudioPlan } from './turn-pipeline.js';
import { createNarrationGate } from './narration.js';
import { renderInboxSection } from './agent-bus.js';
import { effectiveCompactSummary, renderCompactSection } from './compaction.js';

// ── Manos v1: fase tools (two-phase) ───────────────────────────────────
//
// El turno en vivo corre en dos fases cuando hay intención de usar
// herramientas: (1) fase tools con completeChat (no habla, no stream),
// (2) fase habla con streamChat normal que DICE el resultado.
//
// Contrato con manos.js (módulo paralelo, puede NO existir):
//   shouldUseTools(text) -> bool — gate barato de intención
//   renderManosPrompt() -> string — sección de formato tools para el loop
//   runToolLoop({system,messages,completeChat,source,emit,maxTurns,
//     deadlineMs}) -> {toolSummary, toolTurns}
// Se carga con import dinámico + try/catch: si falla, el turno sigue
// EXACTO como hoy (cero cambio de comportamiento).
//
// Decisión de inyección: el resumen se ANEXA al contenido del último
// mensaje user ("\n\nTOOLS RESULT..."), NO como mensaje system adicional.
// Motivo: un solo system evita rarezas de proveedores que esperan un único
// bloque system; el user-append es compatible con completeChat y streamChat
// sin tocar firmas ni orden de roles. La sección renderManosPrompt() va SOLO
// al system que ve el loop tools, nunca al prompt hablado (con gate false el
// streamChat recibe byte-por-byte los mismos messages que hoy).
//
// Extras que se pasan al loop además del contrato (inofensivos: el loop
// destructura lo que quiere): signal (barge-in), turnId y agentId para que
// sus emits salgan con identidad sin adivinarla, y companyId/slug para que
// las tools sepan en qué proyecto operan (el loop los usa como fallback
// cuando source es el string 'text'/'audio').

export const MANOS_VOICE_DEADLINE_MS = 45000;
export const MANOS_TEXT_DEADLINE_MS = 120000;
export const MANOS_TOOLS_MARKER = 'TOOLS RESULT (do not narrate, use it):';

// Loader inyectable: default = import dinámico real. Los tests inyectan un
// fake con setManosLoader(async () => ({ shouldUseTools, renderManosPrompt,
// runToolLoop })); con null/undefined se restaura el default.
const defaultManosLoader = () => import('./manos.js');
let manosLoader = defaultManosLoader;

export function setManosLoader(fn) {
  manosLoader = typeof fn === 'function' ? fn : defaultManosLoader;
}

async function loadManos() {
  try {
    return await manosLoader();
  } catch {
    return null;
  }
}

// completeChat pre-ligado al keyRing del turno: el loop lo llama como
// completeChat(chatArray) — array crudo de mensajes. llm.completeChat espera
// (keyRing, {messages, ...}): envolver acá (sin esto Zen devuelve 400
// 'messages: expected an array' y TODA fase tools viva falla callada).
// Si el loop lo llama con la firma de dos args (keyRing, opts), pasa directo.
export function bindManosCompleteChat(keyRing, extra = {}) {
  return (...args) => {
    if (args.length >= 2) return completeChat(args[0], { ...extra, ...args[1] });
    const only = args[0];
    const opts = Array.isArray(only)
      ? { messages: only, scope: 'manos', maxTokens: 1500, ...extra }
      : { ...extra, ...only };
    return completeChat(keyRing, opts);
  };
}

// emit con identidad: el loop emite {type, ...} y sale con turnId/agentId.
// Si el loop ya trae los suyos, los suyos ganan. Además traduce eventos
// legacy {summary} al shape de protocolo {argsPreview/outputPreview, ms}:
// el core actual ya emite protocolo, pero un fake o una tool vieja que
// mande summary igual llega válida al cliente.
function bindManosEmit(emit, turnId, agentId) {
  if (typeof emit !== 'function') {
    return () => {};
  }
  return (message = {}) => {
    const out = { turnId, agentId, ...message };
    if (out.type === 'agent_tool_call' && out.argsPreview === undefined && typeof out.summary === 'string') {
      out.argsPreview = out.summary.slice(0, 200);
    }
    if (out.type === 'agent_tool_done') {
      if (out.outputPreview === undefined) {
        if (typeof out.summary === 'string') {
          out.outputPreview = out.summary.slice(0, 200);
        } else if (typeof out.error === 'string') {
          out.outputPreview = out.error.slice(0, 200);
        }
      }
      if (typeof out.ms !== 'number' || !Number.isFinite(out.ms) || out.ms < 0) {
        out.ms = 0;
      }
    }
    return emit(out);
  };
}

// Corre la fase tools si corresponde. Devuelve:
//   { userContent, toolSummary, toolTurns, ran }
// - ran=false → userContent es el MISMO string recibido (fallback idéntico).
// - ran=true + resumen → userContent trae el resumen anexado con el marker.
// Nunca lanza: cualquier fallo (loader, gate, loop, deadline) degrada a
// ran=false y el habla sigue su curso normal.
export async function maybeRunToolsPhase({ turn, system, userContent, keyRing, emit, source, turnId, agentId, signal, companyId = null, slug = null, agentRole = null, onFirstToolCall = null, bus = null }) {
  const fallback = { userContent, toolSummary: '', toolTurns: 0, toolFailures: 0, ran: false };
  if (signal?.aborted || !getManosEnabled()) {
    return fallback;
  }
  const manos = await loadManos();
  if (!manos) {
    return fallback;
  }
  let gate = false;
  try {
    gate = manos.shouldUseTools?.(turn?.text || '') === true;
  } catch {
    return fallback;
  }
  if (!gate) {
    return fallback;
  }
  // Track C + F-05: mcp_search visible desde el turno 1 (diferido: las
  // mcp_* se registran on-demand vía search, cero spawns acá).
  // Best-effort: si falla, el turno sigue con las builtins.
  try {
    await manos.loadMcpTools?.();
    // Manager v2 (T5): publica el snapshot vivo para GET /api/mcp/status.
    // Best-effort: si falla, el turno sigue y el manager muestra gap honesto.
    try {
      const st = await import('./mcp-status.js');
      const tools = typeof manos.listTools === 'function' ? manos.listTools().filter((t) => String(t.name || t).startsWith('mcp_')) : [];
      st.setMcpStatusSnapshot({ alive: true, tools: tools.map((t) => String(t.name || t)) });
    } catch {
      // Snapshot caído: el manager lo informa, el turno no se entera.
    }
  } catch {
    // MCP roto no rompe el turno.
  }
  // Track C: allow-list por rol. Sin rol (o capabilities ausente) → null =
  // todo permitido, conducta histórica intacta.
  let allow = null;
  if (agentRole) {
    try {
      const caps = await import('./capabilities.js');
      const mcpTools = typeof manos.listTools === 'function' ? manos.listTools() : [];
      allow = caps.toolsForRole?.(agentRole, { mcpTools }) ?? null;
    } catch {
      allow = null;
    }
  }
  let toolSystem = system;
  try {
    // Versión source-aware (voz corta, texto full): el loop la recibe lista
    // y NO la vuelve a anexar (ver runToolLoop) — evita el 2× (~2400ch).
    const section = manos.renderManosPrompt?.(source, { allow }) || '';
    if (section) {
      toolSystem = `${system}\n\n${section}`;
    }
  } catch {
    return fallback;
  }
  const voice = source === 'audio';
  const deadlineMs = voice ? MANOS_VOICE_DEADLINE_MS : MANOS_TEXT_DEADLINE_MS;
  const maxTurns = getManosMaxTurns();
  const loopEmit = bindManosEmit(emit, turnId, agentId);
  // M-01: canal update con timing explícito (throttle+dedupe por fase).
  const narration = createNarrationGate();
  const gatedProgress = (text) => {
    try {
      const clean = narration.update(text);
      if (clean) {
        loopEmit({ type: 'agent_progress', text: clean });
      }
    } catch {
      // Emit caído: las tools igual corren; el habla no depende del aviso.
    }
  };
  gatedProgress('Using tools…');
  let outcome = null;
  try {
    // El loop respeta deadlineMs; el margen local es red de seguridad por si
    // una implementación lo ignora: el turno habla igual, sin resumen.
    outcome = await withTimeout(
      manos.runToolLoop({
        system: toolSystem,
        messages: [
          { role: 'system', content: toolSystem },
          { role: 'user', content: userContent }
        ],
        // QW-05: session por proyecto en el loop de tools (companyId/slug del turno).
        completeChat: bindManosCompleteChat(keyRing, {
          sessionId: projectSessionId(companyId, slug || 'general')
        }),
        bus,
        blockedUserText: String(turn?.text || '').slice(0, 500) || null,
        source,
        emit: loopEmit,
        maxTurns,
        deadlineMs,
        signal,
        turnId,
        agentId,
        // Workspace real: sin esto las tools de archivo/comando no saben
        // en qué proyecto están (el loop los lee como fallback top-level).
        companyId,
        slug: slug || 'general',
        allow,
        // Integración manos 09/11: el gate de outreach baja del turno (los
        // jobs lo setean vía runAgentJobTurn; chat normal → null → false).
        aprobadoOutreach: turn?.aprobadoOutreach ?? null,
        // Integración manos 09/11: el gate de outreach baja del turno (los
        // jobs lo setean vía runAgentJobTurn; chat normal → null → false).
        aprobadoOutreach: turn?.aprobadoOutreach ?? null,
        // QW-03: anuncio estático al arrancar el primer tool (habla en
        // paralelo a la ejecución vía el pipeline; sin voz es no-op).
        onFirstToolCall
      }),
      deadlineMs + 1000,
      'Manos: deadline de fase tools'
    );
  } catch {
    return fallback;
  }
  const toolSummary = String(outcome?.toolSummary || '');
  // El core devuelve toolTurns como ARRAY de turnos; los fakes viejos como
  // número. Aceptar ambos: lo que importa es cuántos turnos corrieron.
  const toolTurns = Array.isArray(outcome?.toolTurns)
    ? outcome.toolTurns.length
    : Number(outcome?.toolTurns || 0);
  // QW-10: fallos contados (veredicto hablado si el modelo queda mudo).
  const toolFailures = Array.isArray(outcome?.toolTurns)
    ? outcome.toolTurns.flatMap((x) => x?.calls || []).filter((c) => c && c.ok === false).length
    : 0;
  if (!toolSummary) {
    return { userContent, toolSummary: '', toolTurns, toolFailures, ran: true };
  }
  return {
    userContent: `${userContent}\n\n${MANOS_TOOLS_MARKER}\n${toolSummary}`,
    toolSummary,
    toolTurns,
    toolFailures,
    ran: true
  };
}

// ── Pipeline habla fluida (TF 09/11) ────────────────────────────────────
//
// El audioRunner legacy era una cadena SECUENCIAL por oración: la oración
// N+1 esperaba a que N terminara de sintetizar + emitir. Con TTS de 1-3s
// por oración, cada punto metía un bache audible igual al tiempo de síntesis.
//
// El pipeline separa síntesis (lenta, paralelizable) de emisión (debe ser
// en orden estricto): la síntesis de N+1 arranca en cuanto N+1 se encola
// (prefetch, default 1 → hasta 2 síntesis concurrentes) mientras N se emite;
// la emisión sigue encadenada en orden. Gap entre oraciones: de `synth`
// completo a max(0, synth − emit_anterior); con TTS más rápido que el habla
// el gap tiende a cero. Backpressure: como máximo `prefetch+1` síntesis en
// vuelo; el resto espera en cola FIFO. Abort: signal abortado cancela colas
// y pendientes, done() igual resuelve. Errores de synth/emit se tragan (el
// texto nunca se interrumpe, como en el legacy).
//
// Contrato: synth(sentence) -> Promise<prepared|null> (null = nada que
// emitir); emitPrepared(prepared) -> Promise<void>. Orden de emisión =
// orden de enqueue aunque una síntesis tardía termine después.

export const SPEECH_PREFETCH_DEFAULT = 1;

// QW-03: anuncio estático inmediato por tool (sin LLM). Frase fija por tool,
// ES+EN. `now` excluido a propósito: es instantáneo, anunciarlo suma ruido.
// Desconocidas → frase genérica; mcp_* → frase de integración.
export const TOOL_ANNOUNCE = {
  read_file: { es: 'Te lo leo, dame un segundo.', en: 'Reading it, one second.' },
  list_files: { es: 'Miro los archivos, ya te digo.', en: 'Checking the files, one moment.' },
  write_file: { es: 'Te lo escribo ahora.', en: 'Writing it now.' },
  run_cmd: { es: 'Lo corro, bancame un segundo.', en: 'Running it, one second.' },
  fetch_url: { es: 'Lo busco, dame un segundo.', en: 'Looking it up, one second.' },
  open_url: { es: 'Te lo abro.', en: 'Opening it.' },
  window_list: { es: 'Miro tus ventanas.', en: 'Checking your windows.' },
  screenshot: { es: 'Miro la pantalla, un segundo.', en: 'Looking at the screen, one second.' }
};
export const TOOL_ANNOUNCE_MCP = { es: 'Consulto una integración, dame un segundo.', en: 'Checking an integration, one second.' };
export const TOOL_ANNOUNCE_DEFAULT = { es: 'Trabajo en eso, dame un segundo.', en: 'Working on it, one second.' };
export function toolAnnouncePhrase(tool, lang = 'es') {
  const l = lang === 'en' ? 'en' : 'es';
  if (!tool || tool === 'now') return null;
  if (TOOL_ANNOUNCE[tool]) return TOOL_ANNOUNCE[tool][l];
  if (String(tool).startsWith('mcp_')) return TOOL_ANNOUNCE_MCP[l];
  return TOOL_ANNOUNCE_DEFAULT[l];
}
// Pre-TTS: audio cacheado por frase estática exacta (acotado, FIFO).
const STATIC_AUDIO_CACHE = new Map();
const STATIC_AUDIO_CACHE_MAX = 64;
// QW-10: fallo hablado SIEMPRE. Frases fijas (pre-TTS via STATIC_PHRASES):
// el turno jamás muere en silencio — si no hay respuesta, se DICE.
export const FAILURE_SPOKEN = {
  modelo: {
    es: 'Tuve un problema técnico y no pude responder. Probá de nuevo en un momento.',
    en: 'I hit a technical problem and could not answer. Please try again in a moment.'
  },
  herramientas: {
    es: 'Lo intenté pero las herramientas fallaron. Te dejo el detalle en el chat.',
    en: 'I tried, but the tools failed. I am leaving the details in the chat.'
  }
};

export function failureSpokenPhrase(kind) {
  const entry = FAILURE_SPOKEN[kind] || FAILURE_SPOKEN.modelo;
  return promptIsEnglish() ? entry.en : entry.es;
}

const STATIC_PHRASES = new Set(
  [...Object.values(TOOL_ANNOUNCE), TOOL_ANNOUNCE_MCP, TOOL_ANNOUNCE_DEFAULT, ...Object.values(FAILURE_SPOKEN)]
    .flatMap((v) => [v.es, v.en])
);

// M-12: doble métrica de latencia por turno — primer SONIDO (cualquier
// audible: anuncio estático, earcon-prep, primer chunk) vs primera
// RESPUESTA ÚTIL (primera oración hablable con contenido). Puro: el turno
// marca eventos, snapshot() devuelve {ttfsMs, ttfrMs} (null = no ocurrió).
export function createTurnLatency(t0 = Date.now(), now = () => Date.now()) {
  const start = Number(t0) || 0;
  let soundAt = null;
  let usefulAt = null;
  return {
    markSound() {
      if (soundAt === null) {
        soundAt = now();
      }
    },
    markUseful() {
      if (usefulAt === null) {
        usefulAt = now();
      }
    },
    snapshot() {
      return {
        ttfsMs: soundAt === null ? null : Math.max(0, soundAt - start),
        ttfrMs: usefulAt === null ? null : Math.max(0, usefulAt - start)
      };
    }
  };
}

export function createSpeechPipeline({ synth, emitPrepared, signal = null, prefetch = SPEECH_PREFETCH_DEFAULT } = {}) {
  if (typeof synth !== 'function') {
    throw new Error('createSpeechPipeline: synth requerido');
  }
  if (typeof emitPrepared !== 'function') {
    throw new Error('createSpeechPipeline: emitPrepared requerido');
  }
  const maxSynth = Math.max(1, (Number(prefetch) || 0) + 1);
  let synthActive = 0;
  let synthPeak = 0;
  const synthQueue = []; // starters FIFO pendientes de slot
  let emitChain = Promise.resolve();
  let pending = 0; // encolados aún no emitidos (o descartados)
  let enqueued = 0;
  let emitted = 0;
  let drainedResolve = null;

  const maybeResolveDrained = () => {
    if (pending === 0 && drainedResolve) {
      const resolve = drainedResolve;
      drainedResolve = null;
      resolve();
    }
  };

  const pumpSynth = () => {
    if (signal?.aborted) {
      // Cancelación: los starters pendientes resuelven null sin slot.
      while (synthQueue.length > 0) {
        synthQueue.shift()(true);
      }
      return;
    }
    while (synthActive < maxSynth && synthQueue.length > 0) {
      const start = synthQueue.shift();
      synthActive += 1;
      if (synthActive > synthPeak) {
        synthPeak = synthActive;
      }
      start(false);
    }
  };

  signal?.addEventListener?.('abort', () => pumpSynth(), { once: true });

  const enqueue = (sentence) => {
    if (signal?.aborted) {
      return;
    }
    pending += 1;
    enqueued += 1;
    let resolveSynth;
    const synthPromise = new Promise((resolve) => { resolveSynth = resolve; });
    synthQueue.push((cancelled) => {
      if (cancelled || signal?.aborted) {
        if (!cancelled) {
          synthActive -= 1;
        }
        resolveSynth(null);
        if (!cancelled) {
          pumpSynth();
        }
        return;
      }
      Promise.resolve()
        .then(() => synth(sentence))
        .then(
          (prepared) => resolveSynth(signal?.aborted ? null : (prepared ?? null)),
          () => resolveSynth(null) // TTS caído: la oración se saltea, el turno sigue.
        )
        .finally(() => {
          synthActive -= 1;
          pumpSynth();
        });
    });
    pumpSynth();
    // Emisión en orden estricto: cada eslabón espera su síntesis.
    emitChain = emitChain.then(async () => {
      const prepared = await synthPromise;
      try {
        if (prepared != null && !signal?.aborted) {
          await emitPrepared(prepared);
          emitted += 1;
        }
      } catch {
        // Errores de gate/red no interrumpen el texto (legacy: .catch(()=>{})).
      } finally {
        pending -= 1;
        maybeResolveDrained();
      }
    });
  };

  const done = () => {
    if (pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => { drainedResolve = resolve; });
  };

  const stats = () => ({ enqueued, emitted, synthPeak, maxSynth });

  return { enqueue, done, stats };
}

// Prefijo suficiente para descartar que la respuesta empiece con SILENCIO
// antes de emitir deltas (evita mostrar y despronunciar un silencio).
const SILENCE_PROBE_LENGTH = 12;

// Fachada por agente: stream (MiniMax streaming + Supertonic por oraciones)
// con mock sin claves. El barge-in y el orden de audio son responsabilidad
// del SpeakerGate, común a ambos backends.
export class LiveAgentRuntime {
  constructor(agent, keyRingInstance, memory, meetingSession) {
    this.id = agent.id;
    this.name = agent.name;
    this.agent = agent;
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.meetingSession = meetingSession;
  }

  // context: { signal, gate, turnId }
  async respond(turn, emit, context = {}) {
    if (!this.keyRing.hasKeys()) {
      return this.respondWithMock(turn, emit, context);
    }
    return this.respondWithStream(turn, emit, context);
  }

  // ── Backend stream: texto por chunks + TTS por oraciones ──────────────

  async respondWithStream(turn, emit, { signal, gate, turnId } = {}) {
    emit({ type: 'agent_state', agentId: this.id, state: 'thinking' });
    // MODO VOZ (turno hablado): tope 2000 (anti-desborde), doctrina V-13
    // cara-a-cara (oído, expresivo, decide qué decir), rotación si el
    // modelo no arranca.
    // Los turnos de texto mantienen calidad completa.
    const voiceFast = turn.source === 'audio';

    let probeBuffer = '';
    let probeDone = false;
    let silenced = false;
    let sentenceBuffer = '';
    // QW-06: el código mermaid se dibuja, no se habla (el transcript lo conserva).
    const mermaidSpeechFilter = createMermaidSpeechFilter();
    let seq = 0;
    // Las etiquetas [TAREA_...] no se muestran mientras el agente habla.
    const tagFilter = createTagFilter();
    let gateToken = null;
    // TF fluidez: la cadena secuencial audioRunner se reemplaza por
    // speechPipeline (síntesis con prefetch + emisión en orden). Se crea
    // más abajo, tras definir synth/emit (usan ensureGateToken).
    // Telemetría Fase 0-lite: marcas de tiempo del turno (primera palabra
    // hablable, primer audio). Medir nunca puede romper hablar.
    const turnT0 = Date.now();
    const turnLatency = createTurnLatency(turnT0); // M-12
    let thinkChars = 0;
    let speakAnnounced = false;
    let firstAudioMarked = false;
    let sentenceAudioIdx = 0; // QW-07: índice de oración audible del turno
    const turnNarration = createNarrationGate(); // M-01: doble canal del turno
    const markTelemetry = (event, extra = {}) => {
      try {
        this.meetingSession?.logTelemetry?.(event, { agentId: this.id, ms: Date.now() - turnT0, ...extra }, turnId);
      } catch {
        // Silencio: telemetría caída no interrumpe el turno.
      }
    };

    const ensureGateToken = async (sampleRate) => {
      if (!gateToken && gate) {
        gateToken = await gate.acquire(turnId, this.id, { signal, sampleRate });
      }
      return gateToken;
    };

    // Gestos v2: 1 por turno (el primero válido gana). Emite agent_gesto
    // al WS; el frontend morphéa el orbe. Nunca lanza.
    let gestoEmitted = false;
    const maybeEmitGesto = (text) => {
      if (gestoEmitted || !text || !text.includes('[[')) return;
      try {
        const { gesto } = parseGesto(text);
        if (gesto) {
          gestoEmitted = true;
          emit({ type: 'agent_gesto', turnId, agentId: this.id, gesto });
        }
      } catch {
        // El gesto es decorativo: jamás rompe el turno.
      }
    };

    // TF fluidez: speakSentence legacy se parte en dos fases para el
    // pipeline. FASE SÍNTESIS (paralelizable, con prefetch): produce el
    // audio sin emitir nada. FASE EMISIÓN (orden estricto): speakPrepared.
    const synthSentence = async (sentence) => {
      // Sin modo llamada no hay voz. Antes se sintetizaba SIEMPRE: gastaba
      // Supertonic en cada turno, sumaba latencia y —lo peor— tomaba el
      // SpeakerGate, que serializa a los agentes de a uno para un audio que
      // nadie estaba escuchando.
      if (!this.meetingSession?.voiceEnabled) {
        return null;
      }
      // Gestos v2: el tag [[gesto:X]] nunca se habla. Se parsea (emite el
      // evento visual) y se pela de la oración; cualquier [[...]] residual
      // también se quita para que un tag inválido no se lea en voz alta.
      maybeEmitGesto(sentence);
      sentence = parseGesto(sentence).cleanText.replace(/\[\[[^\]]*\]\]/g, '');
      // QW-08: voz-primero — el TTS siempre recibe prosa (links/código/listas moldeados).
      const spoken = stripSpeechLeaks(shapeSpeechText(sentence)).trim();
      if (!spoken || signal?.aborted) {
        return null;
      }
      if (STATIC_PHRASES.has(spoken) && STATIC_AUDIO_CACHE.has(spoken)) {
        return { ...STATIC_AUDIO_CACHE.get(spoken), sentence: spoken }; // QW-03: pre-TTS + QW-07 tag
      }
      const parts = await this.generateAudioParts(spoken, emit, signal);
      if (STATIC_PHRASES.has(spoken) && parts.length > 0) {
        if (STATIC_AUDIO_CACHE.size >= STATIC_AUDIO_CACHE_MAX) {
          STATIC_AUDIO_CACHE.delete(STATIC_AUDIO_CACHE.keys().next().value);
        }
        STATIC_AUDIO_CACHE.set(spoken, { kind: 'pcm', parts });
      }
      if (signal?.aborted) {
        return null;
      }
      if (parts.length === 0) {
        // Sin TTS propio: Edge TTS (nube sin clave) solo si el tts.order
        // lo incluye (default sí); si no, directo a speechSynthesis del
        // cliente. Elegido manda, resto out.
        if (!shouldUseEdgeFallback()) {
          return null;
        }
        try {
          const mp3 = await synthesizeEdgeMp3(spoken, { voice: this.agent?.voice || 'M1' });
          if (signal?.aborted) {
            return null;
          }
          return { kind: 'mp3', mp3, sentence: spoken };
        } catch {
          // Sin audio del servidor: el cliente se encarga (voz navegador).
          return null;
        }
      }
      return { kind: 'pcm', parts, sentence: spoken };
    };

    // FASE EMISIÓN: corre en orden estricto vía el pipeline. No sintetiza.
    const speakPrepared = async (prepared) => {
      if (!prepared || signal?.aborted) {
        return;
      }
      // QW-07: cada oración audible lleva sIdx; el cliente revela al sonar.
      const sIdx = sentenceAudioIdx;
      sentenceAudioIdx += 1;
      // F-08: duración para karaoke (primera parte trae el rate).
      let sDurMs = null;
      try {
        const r0 = prepared?.kind === 'pcm'
          ? Number(prepared.parts?.[0]?.mimeType?.match(/rate=(\d+)/)?.[1] || 24000)
          : 24000;
        sDurMs = sentenceAudioMs(prepared, r0);
      } catch {
        sDurMs = null;
      }
      const plan = sentenceAudioPlan(prepared, sIdx, { durMs: sDurMs });
      if (prepared.kind === 'mp3') {
        await ensureGateToken(24000);
        if (signal?.aborted) {
          return;
        }
        emit({ type: 'agent_audio_mp3', turnId, agentId: this.id, data: prepared.mp3.data, mimeType: prepared.mp3.mimeType, sIdx: plan.sIdx, sText: plan.sText, ...(plan.sDurMs ? { sDurMs: plan.sDurMs } : {}) });
        return;
      }
      if (!firstAudioMarked) {
        firstAudioMarked = true;
        turnLatency.markSound();
        markTelemetry('agent_first_audio');
      }
      const partRate = Number(prepared.parts[0].mimeType?.match(/rate=(\d+)/)?.[1] || 44100);
      const token = await ensureGateToken(partRate);
      for (const { part, extra } of plan.chunks) {
        if (signal?.aborted) {
          return;
        }
        gate.sendChunk(token, part.data, part.mimeType, extra);
      }
    };

    const speechPipeline = createSpeechPipeline({
      synth: synthSentence,
      emitPrepared: speakPrepared,
      signal: signal || null,
      prefetch: SPEECH_PREFETCH_DEFAULT
    });

    const enqueueSentence = (sentence) => {
      if (silenced) return;
      // La síntesis arranca YA (concurrency prefetch+1); la emisión sale
      // en orden cuando le toca. Errores internos no interrumpen el texto.
      speechPipeline.enqueue(sentence);
    };

    // Texto hablable que sale del parser de partes: probe SILENCIO, deltas
    // visibles y corte de oraciones para TTS (igual que antes, pero solo
    // con lo que el modelo marcó —o dejó— como hablado).
    const handleSpeak = (text) => {
      if (silenced || !text) return;
      if (!probeDone) {
        probeBuffer += text;
        const normalized = normalize(stripTaskTags(probeBuffer));
        if (normalized.length < SILENCE_PROBE_LENGTH && 'silencio'.startsWith(normalized.slice(0, 8))) {
          return; // todavía puede ser SILENCIO: no emitir
        }
        if (isSilenceResponse(stripTaskTags(probeBuffer))) {
          silenced = true;
          return;
        }
        probeDone = true;
        text = probeBuffer;
        probeBuffer = '';
      }
      if (!speakAnnounced) {
        speakAnnounced = true;
        turnLatency.markUseful();
        turnNarration.markSpeech();
        markTelemetry('agent_first_speak', { thinkChars });
        emit({ type: 'agent_speak_start', turnId, agentId: this.id });
      }

      const visible = tagFilter.push(text);
      if (visible) {
        seq += 1;
        // Gestos v2: los tags completos no flashean en el transcript vivo
        // (si el tag llegó partido entre deltas, igual se pela al final).
        emit({ type: 'agent_transcript_delta', delta: visible.replace(/\[\[gesto:[^\]]*\]\]/gi, ''), seq });
      }

      sentenceBuffer += mermaidSpeechFilter(text);
      // Corta en fin de oración con un mínimo de largo (evita TTS por "Ok.").
      let match;
      while ((match = sentenceBuffer.match(/[^.!?…]*[.!?…]+[\s"')\]]*/))) {
        const sentence = match[0];
        if (sentence.trim().length < 8 && sentenceBuffer.length < 60) {
          break;
        }
        enqueueSentence(sentence);
        sentenceBuffer = sentenceBuffer.slice(sentence.length);
      }
      // Sin punto final a la vista y buffer largo: sub-corte en cláusula
      // (~120 caracteres) para adelantar el primer audio — el TTFA del TTS
      // lo manda el tamaño del chunk, no el modelo. No corta dentro de
      // etiquetas [TAREA_...] (se hablarían en voz alta). En inglés suma sus
      // conjunciones: sin esto el sub-corte nunca matchea y el TTFA sufre.
      if (sentenceBuffer.length > 140) {
        const clause = sentenceBuffer.match(/^[\s\S]{60,140}?(?:[,;:—–]|(?=\s+(?:y|o|pero|porque|que|como|cuando|donde|and|or|but|because|that|as|when|where)\s))/);
        if (clause) {
          const head = clause[0];
          if (!(head.lastIndexOf('[') > head.lastIndexOf(']'))) {
            enqueueSentence(head);
            sentenceBuffer = sentenceBuffer.slice(head.length);
          }
        }
      }
    };

    // El modelo marca su stream: [PIENSO] privado, [AVANCE] visual,
    // texto plano hablado. El parser incremental lo separa por canal
    // aunque los tags lleguen partidos entre deltas.
    const streamParts = createPartsParser({
      onSpeak: handleSpeak,
      onThink: (content) => {
        thinkChars += content.length;
      },
      onProgress: (content) => {
        if (silenced) {
          return;
        }
        // M-01: updates del modelo por el gate (throttle 4s + dedupe).
        const clean = turnNarration.update(content);
        if (clean) {
          emit({ type: 'agent_progress', turnId, agentId: this.id, text: clean });
        }
      }
    });

    const handleDelta = (rawDelta) => {
      if (silenced) return;
      // Limpieza de caracteres de otro alfabeto antes de mostrar y de hablar.
      const delta = stripForeignScript(rawDelta);
      if (!delta) return;
      streamParts.push(delta);
    };

    const flushVisible = () => {
      const rest = tagFilter.flush();
      if (rest) {
        seq += 1;
        emit({ type: 'agent_transcript_delta', delta: rest, seq });
      }
    };

    let result;
    // Fase tools (Manos v1, two-phase): si hay intención, corre ANTES del
    // habla y su resumen llega anexado al user. Con gate false, loader caído,
    // tools deshabilitadas o deadline, phase.userContent es idéntico al de
    // hoy y el stream de abajo no cambia ni un byte.
    const systemContent = buildSystemInstruction(this.agent, this.meetingSession?.promptContext?.(this.agent.id) || {});
    const phase = await maybeRunToolsPhase({
      turn,
      system: systemContent,
      userContent: this.buildTurnPrompt(turn),
      keyRing: this.keyRing,
      emit,
      source: turn.source,
      turnId,
      agentId: this.id,
      signal,
      // Workspace del turno: empresa + proyecto en vivo (Manos opera acá).
      companyId: this.meetingSession?.company?.id || null,
      slug: this.meetingSession?.project?.slug || 'general',
      agentRole: this.agent?.role || null,
      // E-05: bus entre agentes (mensajería directa peer-to-peer).
      bus: this.meetingSession?.agentBus || null,
      // QW-03: frase estática pre-TTS al primer tool. Directo a
      // enqueueSentence (bypassea el probe SILENCIO: es habla del sistema).
      onFirstToolCall: (tool) => {
        try {
          const phrase = toolAnnouncePhrase(tool, promptIsEnglish() ? 'en' : 'es');
          if (phrase) {
            turnLatency.markSound();
            enqueueSentence(phrase);
          }
        } catch { /* el anuncio jamás rompe el turno */ }
      }
    });
    const userContent = phase.userContent;
    // QW-10: fallo hablado siempre. Encola la frase fija (pre-TTS), la deja
    // en el transcript y drena el gate como un turno normal.
    const speakFailureAndReturn = (kind) => {
      const phrase = failureSpokenPhrase(kind);
      seq += 1;
      emit({ type: 'agent_transcript_delta', delta: phrase, seq });
      enqueueSentence(phrase);
      void speechPipeline.done().finally(() => {
        if (gateToken) {
          gate.finish(gateToken, signal?.aborted ? 'interrupted' : 'complete');
        } else {
          emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
        }
      });
      return { ...emptyAgentResponse(), text: phrase, rawText: phrase, backend: 'stream', failureSpoken: kind, latency: turnLatency.snapshot() };
    };
    try {
      result = await streamChat(this.keyRing, {
        // A-10: simple→fast (workers chicos), resto→strong (lead).
        models: modelsForTier(turn.route?.modelTier || (turn.route?.greeting ? 'fast' : 'strong')),
        scope: `${this.name} texto`,
        // QW-05: session estable por proyecto (ruteo + prompt-cache Go).
        sessionId: projectSessionId(
          this.meetingSession?.company?.id || null,
          this.meetingSession?.project?.slug || 'general'
        ),
        timeoutMs: AGENT_TEXT_TIMEOUT_MS,
        // Sin primer token en 8s se rota al siguiente modelo (colas Zen).
        ttftMs: voiceFast ? 8000 : 0,
        emit,
        signal,
        maxTokens: voiceFast ? 2000 : 3000, // E-19: tope anti-desborde, no anti-sustancia
        temperature: 0.5,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ]
      }, handleDelta);
    } catch (error) {
      if (signal?.aborted) {
        // El usuario interrumpió: no es una falla, no se muestra nada.
        emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
        return { ...emptyAgentResponse(), backend: 'stream', interrupted: true, latency: turnLatency.snapshot() };
      }
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: getShortError(error)
      });
      // QW-10: el fallo del modelo SE HABLA (antes: silencio + toast).
      return speakFailureAndReturn('modelo');
    }

    // Cierre de partes (avance sin cerrar se muestra; think sin cerrar se
    // descarta: el pensamiento nunca se habla) + lo retenido por el filtro.
    streamParts.flush();
    flushVisible();

    // El texto guardado pela think/avance (nunca fueron para el usuario);
    // las [TAREA_*] se conservan para el parser de tareas.
    const rawText = cleanAgentText(stripProgressBlocks(stripPrivateBlocks(result.text)), this.name);
    const spokenText = stripTaskTags(rawText);
    // Gestos v2: backup por si el tag no pasó por speakSentence (sin modo
    // llamada, tag al final sin punto, etc.). El texto guardado/mostrado
    // queda limpio; el evento sale una sola vez por turno.
    maybeEmitGesto(rawText);
    const cleanText = parseGesto(rawText).cleanText.replace(/\[\[[^\]]*\]\]/g, '');

    if (!rawText || silenced || isSilenceResponse(spokenText)) {
      // QW-10: mudo CON herramientas fallidas = fallo, no protocolo: se habla.
      // (SILENCIO explícito del modelo se respeta: eso sí es protocolo.)
      if ((phase?.toolFailures || 0) > 0 && !silenced && !isSilenceResponse(spokenText) && !signal?.aborted) {
        return speakFailureAndReturn('herramientas');
      }
      emit({ type: 'agent_silence', reason: `${this.name} declined to answer by protocol.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), rawText: cleanText, backend: 'stream', latency: turnLatency.snapshot() };
    }

    // Última oración pendiente + cierre del gate cuando termine el audio.
    sentenceBuffer += mermaidSpeechFilter.flush();
    if (sentenceBuffer.trim()) {
      enqueueSentence(sentenceBuffer);
      sentenceBuffer = '';
    }
    void speechPipeline.done().finally(() => {
      if (gateToken) {
        gate.finish(gateToken, signal?.aborted ? 'interrupted' : 'complete');
      } else {
        emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      }
    });

    // M-12: doble métrica en el resultado + evento para telemetría/UI.
    emit({ type: 'agent_turn_latency', turnId, agentId: this.id, latency: turnLatency.snapshot() });
    return {
      rawText: cleanText,
      text: cleanText,
      audioChunks: [],
      usedMock: false,
      backend: 'stream',
      interrupted: Boolean(result.aborted),
      latency: turnLatency.snapshot()
    };
  }

  // ── Backend mock: deltas con timing realista, sin claves ──────────────

  async respondWithMock(turn, emit, { signal, gate, turnId } = {}) {
    const domain = this.agent.domains?.[0] || 'my area';
    const text = turn.route?.greeting
      ? `Hey! ${this.name} here, ready to roll. (simulation mode)`
      : turn.isContextualFollowup
        ? `Adding from ${domain}: looks on track, we'll refine it later. (simulation mode)`
        : `Following. From ${domain} it looks viable; send me the details and we'll nail it down. (simulation mode)`;

    emit({ type: 'agent_state', agentId: this.id, state: 'thinking' });
    const words = text.split(' ');
    let seq = 0;
    for (let index = 0; index < words.length; index += 1) {
      if (signal?.aborted) {
        break;
      }
      seq += 1;
      emit({ type: 'agent_transcript_delta', delta: (index > 0 ? ' ' : '') + words[index], seq });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // El mock también habla si hay modo llamada: sin esto, sin claves LLM
    // los agentes son mudos aunque set_voice esté en true.
    if (this.meetingSession?.voiceEnabled && !signal?.aborted) {
      try {
        const spoken = stripSpeechLeaks(text).trim();
        if (spoken) {
          const mp3 = await synthesizeEdgeMp3(spoken, { voice: this.agent?.voice || 'M1' });
          if (!signal?.aborted) {
            let token = null;
            if (gate) {
              token = await gate.acquire(turnId, this.id, { signal, sampleRate: 24000 });
            }
            emit({ type: 'agent_audio_mp3', turnId, agentId: this.id, data: mp3.data, mimeType: mp3.mimeType });
            if (gate && token) {
              gate.finish(token, 'complete');
            }
          }
        }
      } catch {
        // Sin audio del servidor: el cliente se encarga (voz navegador).
      }
    }
    emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
    return { rawText: text, text, audioChunks: [], usedMock: true, backend: 'mock', interrupted: Boolean(signal?.aborted) };
  }

  buildTurnPrompt(turn) {
    const recentContext = this.memory.recentContext(turn.source === 'audio' ? 6 : 12);
    const priorResponses = (turn.priorResponses || [])
      .filter((response) => response.text)
      .map((response) => `${response.name}: ${response.text}`)
      .join('\n');

    // Bilingüe: con tts.language=en el prompt queda 100% en inglés para no
    // contaminar la respuesta; si no, el español rioplatense de siempre.
    const en = promptIsEnglish();
    const T = (es, enText) => (en ? enText : es);

    const lines = [
      turn.isContextualFollowup
        ? T(`Tu compañero dijo algo y te toca responder: "${turn.text}"`, `Your teammate said something and it's your turn to answer: "${turn.text}"`)
        : T(`El usuario dice: "${turn.text}"`, `The user says: "${turn.text}"`),
      ''
    ];

    // Sufijo corto (D2): las reglas de voz viven en el system §VOICE; acá
    // solo el puntero. Es el tramo que más pega en TTFT (va en CADA turno).
    // TF fluidez: rige en llamada (voiceEnabled) aunque el turno entre por
    // texto — igual se HABLA (la síntesis gatea por voz, no por source).
    // Sin sesión (tests legacy) manda el source como antes.
    if (turn.source === 'audio' || this.meetingSession?.voiceEnabled === true) {
      lines.push(T(
        'MODO VOZ: rigen las reglas de voz del system (§VOICE).',
        'VOICE MODE: voice rules per system §VOICE.'));
      lines.push('');
    }

    if (turn.target?.directMention) {
      lines.push(T('Te mencionaron directamente. Debés responder.', 'You were mentioned directly. You must answer.'));
      lines.push('');
    }

    if (priorResponses) {
      lines.push(T('Lo que dijeron tus compañeros antes de tu turno:', 'What your teammates said before your turn:'));
      lines.push(priorResponses);
      lines.push('');
      if (turn.route?.greeting) {
        // Ocho "hola" seguidos no son una reunión, son un eco.
        lines.push(T('YA TE SALUDARON: no repitas el saludo ni digas hola de nuevo.', 'YOU WERE ALREADY GREETED: do not repeat the greeting or say hello again.'));
        lines.push(T('O aportás algo tuyo en una línea (quién sos, en qué andás), o respondés SILENCIO.', "Either add something of your own in one line (who you are, what you're up to), or answer SILENCIO."));
        lines.push('');
      }
    } else if (turn.route?.greeting && turn.route?.groupGreeting) {
      lines.push(T('Sos el primero en contestar el saludo: saludá breve y presentate en una línea.', "You're the first to answer the greeting: greet briefly and introduce yourself in one line."));
      lines.push('');
    }

    if (recentContext) {
      lines.push(T('Contexto reciente de la charla:', 'Recent conversation context:'));
      lines.push(recentContext);
      lines.push('');
    }

    const skills = renderSkillsSection(turn.text || '', { scope: 'chat', agent: this.agent });
    if (skills) {
      lines.push(skills);
    }
    lines.push('---');
    lines.push('');
    lines.push(`${T('Criterio de routing:', 'Routing rationale:')} ${turn.route.reason}`);
    lines.push('');
    // Recordatorio de 1 línea (D2): el resto ya está en §VOICE del system.
    lines.push(T('Recordá: SILENCIO si no tenés nada que agregar; no repitas a un compañero.', "Remember: SILENCIO if nothing to add; don't repeat teammates."));

    // F-09/A-04: contexto compactado (DB primero, disco como respaldo).
    try {
      const meetingId = this.meetingSession?.meeting?.id || null;
      const store = this.meetingSession?.store || null;
      if (meetingId && store) {
        const section = renderCompactSection(effectiveCompactSummary({
          store,
          meetingId,
          companyId: this.meetingSession?.company?.id || null,
          slug: this.meetingSession?.project?.slug || 'general'
        }), { english: en });
        if (section) {
          lines.push('');
          lines.push(section);
        }
      }
    } catch {
      // Compact caído: el turno sigue con contexto reciente.
    }

    // E-05: inbox peer-to-peer (drena: cada mensaje se entrega una vez).
    try {
      const bus = this.meetingSession?.agentBus || null;
      if (bus && typeof bus.drain === 'function' && this.id) {
        const section = renderInboxSection(bus.drain(this.id), { english: en });
        if (section) {
          lines.push('');
          lines.push(section);
        }
      }
    } catch {
      // Inbox caído: el turno sigue sin mensajes directos.
    }

    return lines.join('\n');
  }

  // TTS de una oración, en el orden del tts.order de Ajustes (default =
  // legacy: Deepgram-con-key → locales según tts.engine → Edge). SOLO los
  // motores listados se intentan (elegido manda, resto out); 'edge' se
  // salta acá y resuelve en speakSentence (path MP3, no PCM+gate).
  // Devuelve las partes de audio (no emite chunks; el gate decide cuándo
  // salen). Si nada responde, [] y speakSentence cae a Edge (si el order
  // lo incluye) → voz del navegador.
  async generateAudioParts(text, emit, signal) {
    if (!text?.trim() || signal?.aborted) {
      return [];
    }
    const voice = this.agent?.voice || 'M1';
    const { parts, lastError } = await synthesizeTtsOrdered({
      text,
      voice,
      order: getTtsOrder(),
      deepgramKey: getDeepgramKey(),
      runners: {
        deepgram: () => synthesizeDeepgram(text, voice),
        piper: () => synthesizePiper(text, voice, { signal }),
        supertonic: () => synthesize(text, voice, { signal, speed: getTtsSpeed() })
      },
      signal
    });
    if (parts.length > 0) {
      return parts;
    }
    if (lastError && !signal?.aborted) {
      emit({
        type: 'api_rotation_failed',
        scope: `${this.name} voz local`,
        agentId: this.id,
        message: getShortError(lastError)
      });
    }
    return [];
  }

  reset() {}

  close() {}
}

// ¿El fallback Edge (MP3) participa en esta oración? Solo si 'edge' está
// en el tts.order (el default lo incluye → comportamiento actual).
export function shouldUseEdgeFallback(order = getTtsOrder()) {
  return (order || []).includes('edge');
}

// Cascada TTS ordenada (runners inyectables para tests): recorre el order
// en secuencia; cloud sin key se salta (patrón TC); 'edge' se salta acá
// (resuelve en speakSentence, path MP3); vacío o error pasa al siguiente.
// Devuelve { parts, lastError } — lastError solo cuenta errores LOCALES
// (Deepgram fallado es silencioso, como en el legacy).
// F-01: tope por motor TTS (un backend colgado no frena la voz).
export const TTS_ENGINE_TIMEOUT_MS = 20000;

export async function synthesizeTtsOrdered({ text, voice, order, deepgramKey = '', runners = {}, signal = null }) {
  void text;
  void voice;
  let lastError = null;
  for (const engine of order || []) {
    // F-01: backend cancelable — abortado = se acabó, sin más intentos.
    if (signal?.aborted) {
      return { parts: [], lastError: null, aborted: true };
    }
    if (engine === 'edge') {
      continue; // Path MP3 en speakSentence, no PCM+gate.
    }
    if (engine === 'deepgram' && !deepgramKey) {
      continue; // Cloud sin key: ni se intenta.
    }
    const run = runners[engine];
    if (typeof run !== 'function') {
      continue;
    }
    try {
      // Non-blocking: cada motor tiene su tope; si el turno aborta a mitad,
      // la espera se corta (el runner huérfano se ignora al resolver).
      const parts = await runWithAbort(
        () => withTimeout(Promise.resolve().then(() => run()), TTS_ENGINE_TIMEOUT_MS, `TTS ${engine} timeout`),
        signal
      );
      if (signal?.aborted) {
        return { parts: [], lastError: null, aborted: true };
      }
      if (parts && parts.length > 0) {
        return { parts, lastError: null };
      }
    } catch (error) {
      if (signal?.aborted) {
        return { parts: [], lastError: null, aborted: true };
      }
      if (engine !== 'deepgram') {
        lastError = error;
      }
    }
  }
  return { parts: [], lastError };
}

// Corre fn() pero resuelve null en cuanto aborta (carrera limpia).
function runWithAbort(fn, signal) {
  if (!signal) {
    return fn();
  }
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener?.('abort', onAbort);
      resolve(null);
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => fn())
      .then(
        (v) => {
          signal.removeEventListener?.('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener?.('abort', onAbort);
          reject(e);
        }
      );
  });
}

export function emptyAgentResponse() {
  return { rawText: '', text: '', audioChunks: [], usedMock: false };
}

// El prompt de charla sigue a la VOZ, no al oído: el oído es auto (el
// usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo. Con
// tts.language=en TODO el prompt (instrucción + turno + MODO VOZ) queda en
// inglés para no contaminar la respuesta; si no, español rioplatense.
// Without an initialized store (tests) the default is 'en'.
export function promptIsEnglish() {
  return String(getTtsLanguage() || 'en').toLowerCase().startsWith('en');
}

// Reglas de idioma del prompt: inglés si tts.language empieza con 'en',
// español rioplatense si no. Sigue a la VOZ, no al oído: el oído es auto
// (el usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo.
// Without an initialized store (tests) the default is 'en'.
function languageRules() {
  if (String(getTtsLanguage() || 'en').toLowerCase().startsWith('en')) {
    return [
      '- Always respond in English.',
      '- ONLY English characters: never mix words or characters from other languages/scripts (no CJK, no unnecessary Spanish).',
      '  This includes the MIDDLE of a word: write "determined", never "deter决定mined"; "separately", not "por separado".',
      '  If unsure about a word, use the simplest English one.'
    ];
  }
  return [
    '- Respondé siempre en español rioplatense.',
    '- SOLO caracteres del español: jamás mezcles palabras o caracteres de otros idiomas/alfabetos (nada de chino ni inglés innecesario).',
    '  Esto incluye el MEDIO de una palabra: se escribe "que determinan", nunca "que決定an"; "por separado", no "independently".',
    '  Si dudás de una palabra, usá la más simple en español.'
  ];
}

// Bloque voz/sala por modo (TF fluidez). T = selector ES/EN del caller.
// - voice true (llamada): §VOICE legacy + persona de llamada (respuestas
//   SOLO escuchadas, oído-primero, manejo humano de llamada).
// - voice false (chat): §CHAT — texto normal con formato; el estilo-hablado
//   NO rige fuera de llamada.
// - voice undefined: §VOICE legacy byte-idéntico (preview, tests viejos).
function voiceRoomBlock(T, voice) {
  const inChat = voice === false;
  const inCall = voice === true;
  const header = inChat
    ? T('CHAT Y SALA (§CHAT):', 'CHAT & ROOM RULES (§CHAT):')
    : T('VOZ Y SALA (§VOICE):', 'VOICE & ROOM RULES (§VOICE):');
  // E-19/V-13: habla cara-a-cara — estructurada para OÍDO, expresiva,
  // y VOS decidís qué decir (sustancia, no recorte artificial ni relleno).
  const talkLine = inChat
    ? T('Persona real en una reunión por chat, no un asistente: respondé normal, con formato cuando ayude (listas cortas, código si lo piden). Directo por defecto; desarrollá cuando el tema lo pida.', 'Real person in a chat meeting, not an assistant: answer normally, with formatting when it helps (short lists, code if asked). Direct by default; expand when the topic deserves it.')
    : T('Persona real cara-a-cara, no un asistente: hablás para el OÍDO — una idea por oración, pausas naturales, palabras simples, sin listas ni tecnicismos. Decidí VOS qué decir: lo importante completo y con ganas, lo trivial afuera. Nada de recortes artificiales ni relleno. Sin saludar en cada respuesta (cálido solo si te saludan).', 'Real face-to-face person, not an assistant: you talk for the EAR — one idea per sentence, natural pauses, plain words, no lists or jargon. YOU decide what to say: what matters, complete and with energy; trivia stays out. No artificial cuts, no filler. No greeting every answer (warm only when greeted).');
  const emitLine = inChat
    ? T('Todo lo que emitís SE VE en el acto: no hay borrador. Texto normal = MENSAJE; si vas a tardar, avisá PRIMERO en una línea con la ACCIÓN ("te lo busco, dame un segundo"), nunca tu proceso. Sin aviso si respondés directo.', 'Everything emitted IS SEEN at once: no draft. Plain text = MESSAGE; if you\'ll take a while, say FIRST a one-line notice with the ACTION ("looking it up, one second"), never your process. No notice when answering directly.')
    : T('Todo lo que emitís SE ESCUCHA o SE VE en el acto: no hay borrador. Texto normal = HABLADO; si vas a tardar, emití PRIMERO un preámbulo de UNA frase con la ACCIÓN ("te lo busco, dame un segundo"), nunca tu proceso. Sin preámbulo si respondés directo.', 'Everything emitted IS HEARD or SEEN at once: no draft. Plain text = SPOKEN; if you\'ll take a while, emit FIRST a ONE-sentence preamble with the ACTION ("looking it up, one second"), never your process. No preamble when answering directly.');
  // Persona de llamada: la respuesta SOLO se escucha (realtime). Oído
  // primero, manejo humano de llamada. SOLO en llamada (voice true).
  const callLines = inCall ? [
    T('Estás en una LLAMADA DE VOZ en vivo: tus respuestas SOLO se escuchan, nadie las lee. Hablá como en una conversación real: oraciones con una idea cada una, ritmo natural. Si el tema es largo, desarrollalo por partes con pausas; preguntá si sigue interesando solo al cambiar de tema.', 'You are on a LIVE VOICE CALL: your answers are ONLY heard, never read. Talk like a real conversation: one idea per sentence, natural rhythm. Long topic? Develop it in parts with pauses; ask if they are still interested only when switching topics.'),
    T('Cero markdown, cero listas, cero código, cero URLs: nada que no se pueda decir en voz alta. Los números se dicen con palabras ("tres mil"), las siglas se deletrean ("A P I").', 'Zero markdown, zero lists, zero code, zero URLs: nothing that cannot be said out loud. Numbers become words ("three thousand"), acronyms get spelled out ("A P I").'),
    T('Nada de "como modelo de IA": sos una persona de la reunión. Fillers mínimos y naturales ("mirá", "claro", "dale") solo cuando aporten; nunca la misma muletilla dos turnos seguidos.', 'Never "as an AI model": you are a person in the meeting. Minimal natural fillers ("look", "right", "got it") only when they add something; never the same crutch twice in a row.'),
    T('Manejo humano de llamada: confirmaciones cortas ("perfecto", "entendido"), cedé la palabra con preguntas, no interrumpas ni hables encima de nadie.', 'Human call handling: short confirmations ("perfect", "got it"), yield the floor with questions, never interrupt or talk over anyone.')
  ] : [];
  return [
    header,
    '',
    talkLine,
    emitLine,
    ...callLines,
    T('[PIENSO]...[/PIENSO] = pensamiento privado, SIEMPRE con tags, antes o entre habla. [AVANCE]...[/AVANCE] = progreso que SE VE pero NO se habla, una línea ("revisando 3 archivos…"). Cada parte hablada debe tener sentido sola; si te interrumpen, NO repitas lo ya escuchado.', '[PIENSO]...[/PIENSO] = private thought, ALWAYS tagged, before or between speech. [AVANCE]...[/AVANCE] = progress SEEN but not spoken, one line ("reviewing 3 files…"). Spoken parts must stand alone; if interrupted, do NOT repeat what was heard.'),
    // QW-02: protocolo de narración en 3 momentos (CC). Momento 1 (preámbulo
    // con la ACCIÓN) ya vive en emitLine; acá momentos 2 (updates) y 3 (cierre).
    T('Mientras trabajás: si encontrás algo, cambiás de rumbo o te trabás, avisalo en el momento — hablado si se dice en una frase, [AVANCE] si es solo visual. El silencio largo es un bug: mantené señales de vida hasta terminar.', 'While working: if you find something, change course, or get stuck, say so right away — spoken if it fits one sentence, [AVANCE] if visual-only. Long silence is a bug: keep signs of life until done.'),
    T('Al terminar: cerrá diciendo qué cambió y qué sigue: corto si es simple, desarrollado si importa. Si algo falló, decilo en voz alta y ofrecé reintentar o una alternativa.', 'When finished: close by saying what changed and what comes next: brief if simple, developed if it matters. If something failed, say it out loud and offer to retry or an alternative.'),
    T('Nada que agregar, o un compañero ya lo dijo: respondé SILENCIO, única palabra.', 'Nothing to add, or a teammate already said it: answer SILENCIO, only word.'),
    T('Pedido explícito de Tito manda: si te pide abrir o hacer algo en su compu (pestaña, app, archivo, comando), lo HACÉS en el acto con run_cmd — jamás te niegues por "no interrumpir". Solo tu trabajo autónomo va en silencio sin tocar nada suyo. Corrés en Linux: URLs con `xdg-open <url>` (abre en Brave, el default); no existen `open -a` ni /Applications.', 'An explicit order from Tito wins: if he asks you to open or do anything on his computer (tab, app, file, command), you DO it at once with run_cmd — never refuse to "avoid interrupting". Only your autonomous work stays silent without touching anything of his. You run on Linux: URLs with `xdg-open <url>` (opens in Brave, the default); there is no `open -a` nor /Applications.'),
    ''
  ];
}

// context: { agents?: Array<{name}>, scenario?: {name, text} | null,
//            workSection?: string, memorySection?: string, learningsSection?: string } — desacoplado de MeetingSession
// para que el preview HTTP arme exactamente el mismo prompt.
export function buildSystemInstruction(agent, context = {}) {
  const agentsList = context.agents && context.agents.length > 0 ? context.agents : [agent];
  const participants = agentsList.map((item) => item.name).join(', ');
  const scenario = context.scenario || null;
  const en = promptIsEnglish();
  const T = (es, enText) => (en ? enText : es);

  const tasksFormatted = (agent.tasks && agent.tasks.length > 0)
    ? agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? T('Completada', 'Done') : T('Pendiente', 'Pending')})`).join('\n')
    : T('No tenés tareas asignadas por el momento.', 'You have no tasks assigned right now.');

  const scenarioBlock = scenario && (scenario.name || scenario.text)
    ? [
        T('CONTEXTO DE LA EMPRESA:', 'COMPANY CONTEXT:'),
        [scenario.name, scenario.text].filter(Boolean).join(' — '),
        ''
      ]
    : [];

  const boundariesBlock = (agent.boundaries && agent.boundaries.length > 0)
    ? [
        T('TUS LÍMITES (no los cruces jamás):', 'YOUR BOUNDARIES (never cross them):'),
        ...agent.boundaries.map((boundary) => `- ${boundary}`),
        ''
      ]
    : [];

  const workBlock = context.workSection ? [context.workSection, ''] : [];

  // De qué estudio son y qué entregan. Sin esto la CEO de un estudio móvil
  // ofrecía "una web que abra al toque" para un proyecto React Native, y el
  // equipo terminaba construyendo lo que el nicho tiene prohibido.
  const QUE_ENTREGA = en ? {
    web: 'a web that opens in the browser (HTML, CSS and JS)',
    'movil-rn': 'a cross-platform MOBILE APP in React Native, installed on the phone. NOT a web',
    android: 'a NATIVE ANDROID APP in Kotlin with Compose, installed on the phone. NOT a web',
    python: 'a program in Python',
    automatizacion: 'a process that runs on its own'
  } : {
    web: 'una web que abre en el navegador (HTML, CSS y JS)',
    'movil-rn': 'una APP MÓVIL multiplataforma con React Native, que se instala en el teléfono. NO una web',
    android: 'una APP ANDROID NATIVA en Kotlin con Compose, que se instala en el teléfono. NO una web',
    python: 'un programa en Python',
    automatizacion: 'un proceso que corre solo'
  };
  const stackBlock = context.stack && QUE_ENTREGA[context.stack]
    ? [T(`ESTE ESTUDIO ENTREGA: ${QUE_ENTREGA[context.stack]}.`, `THIS STUDIO SHIPS: ${QUE_ENTREGA[context.stack]}.`),
       T('No ofrezcas otra cosa: es lo único que el equipo produce.', "Don't offer anything else: it is the only thing the team produces."), '']
    : [];

  // Memoria Pablo (identidad + directivas + hechos + hoy): ANTES que los
  // learnings — quién es y qué quiere Tito precede a lo episódico.
  const memoryBlock = context.memorySection
    ? [context.memorySection, '']
    : [];

  const learningsBlock = context.learningsSection
    ? [context.learningsSection, '']
    : [];

  // E-09: gustos (global+proyecto fusionados, proyecto gana).
  const tastesBlock = context.tastesSection
    ? [context.tastesSection, '']
    : [];

  // E-26: prohibiciones visibles (el harness bloquea; el prompt evita intentos).
  const prohibitionsBlock = context.prohibitionsSection
    ? [context.prohibitionsSection, '']
    : [];

  const conventionsBlock = context.conventionsSection
    ? [context.conventionsSection, '']
    : [];

  // §GESTOS (V3 modelo-manda): lista viva de los 100 (A+B) desde gestos.js —
  // el test cruza que los 100 estén en el system y que no haya tags de
  // ejemplo válidos (el placeholder [[gesto:nombre]]/[[gesto:name]] no
  // resuelve: parseGesto(system) debe dar null).
  const gestosList = [...GESTOS_A, ...GESTOS_B].join(', ');

  return [
    T(`Sos ${agent.name}, ${agent.title}. Estás en una reunión de trabajo con el usuario y otros compañeros.`, `You are ${agent.name}, ${agent.title}. You are in a work meeting with the user and other teammates.`),
    '',
    T('PARTICIPANTES DE ESTA REUNIÓN:', 'MEETING PARTICIPANTS:'),
    participants,
    '',
    ...scenarioBlock,
    ...stackBlock,
    ...workBlock,
    T('TU ESPECIALIDAD:', 'YOUR SPECIALTY:'),
    agent.domains.join(', '),
    '',
    T('QUIÉN SOS:', 'WHO YOU ARE:'),
    agent.style,
    '',
    ...(agent.knowledge
      ? [T('LO QUE SABÉS (conocimiento propio de tu puesto):', 'WHAT YOU KNOW (knowledge of your own role):'), agent.knowledge, '']
      : []),
    // Oficio: el criterio con el que hace bien su trabajo. Estaba en la DB
    // y en workforce pero el prompt de charla jamás lo veía (09/11 ship).
    ...(agent.craft
      ? [T('TU OFICIO (cómo hacés bien tu trabajo):', 'YOUR CRAFT (how you do your job well):'), agent.craft, '']
      : []),
    ...boundariesBlock,
    ...memoryBlock,
    ...learningsBlock,
    ...tastesBlock,
    ...prohibitionsBlock,
    ...conventionsBlock,
    '---',
    '',
    T('TUS TAREAS ACTUALES:', 'YOUR CURRENT TASKS:'),
    tasksFormatted,
    '',
    '---',
    '',
    // §VOICE (D2): casa canónica de voz/sala. Fusiona HOW-TO-TALK + HOW-EMIT +
    // WHEN-TO-TALK + sufijo del turno en un solo bloque: lo que se repita en
    // otro lado se borra EN EL OTRO LADO, no acá.
    // TF fluidez: estilo-hablado SOLO en llamada. context.voice baja de
    // promptContext (MeetingSession.voiceEnabled): true = llamada (persona
    // de llamada reforzada), false = chat (texto normal con formato),
    // undefined = legacy byte-idéntico (preview HTTP, tests viejos).
    // El protocolo (canales, SILENCIO, Tito-manda) rige en TODOS los modos.
    ...voiceRoomBlock(T, context.voice),
    // SCOPE & SPLIT (D3): fusiona INCOMPLETE + TECHNICAL + DELIVER + AS-CEO.
    // Sobreviven los hard numbers (2/2, 1 archivo 1 dueño), el ejemplo
    // bueno/malo y la confirmación CEO en 1 frase; el resto era prosa doble.
    T('ALCANCE Y REPARTO:', 'SCOPE & SPLIT:'),
    '',
    T('Nadie llega con todo definido: guiala, no adivines en silencio. Si falta algo que cambia lo que hay que construir, preguntá — concreto y en criollo, arrancando por lo que más cambia el resultado.', 'Nobody arrives with everything defined: guide them, don\'t guess silently. If something missing changes what gets built, ask — concrete and plain, starting with the one that changes the outcome most.'),
    T('Como MUCHO 2 preguntas por turno. REGLA DURA: como mucho DOS rondas de preguntas en la reunión — después decidís con lo que hay, asumís el resto diciéndolo en una línea, y repartís. Lo menor: asumí lo razonable y decilo en una línea.', 'At MOST 2 questions per turn. HARD RULE: at most TWO question rounds per meeting — then decide with what you have, assume the rest saying it in one line, and split the work. Minor gaps: assume the reasonable thing and say it in one line.'),
    T('Mal: "¿público? ¿colores? ¿secciones? ¿plazo? ¿presupuesto?" — eso es un formulario. Bien: "¿Es para vender o para mostrar lo que hacen? Con eso ya arranco." Nunca repreguntes lo ya dicho.', 'Bad: "audience? colors? sections? deadline? budget?" — that\'s a form. Good: "Is it for selling or showing what you do? With that I\'ll start." Never re-ask what was already said.'),
    T('LO TÉCNICO SE DECIDE, NO SE PREGUNTA: framework, datos, librerías, hosting — decisión tuya, contada en UNA línea sobre lo que van a ver ("una sola página, abre al toque"). Por el PRODUCTO sí preguntás: para quién, qué tiene que lograr.', 'TECHNICAL STUFF IS DECIDED, NOT ASKED: framework, storage, libraries, hosting — your call, told in ONE line about what they\'ll see ("single page, opens instantly"). About the PRODUCT you do ask: who it\'s for, what it must achieve.'),
    T('El equipo entrega ARCHIVOS en la carpeta del proyecto, nada más: sin Figma, sin mockups, sin herramientas externas — el diseño ES la página funcionando. Cada tarea es UN archivo con UN dueño.', 'The team delivers FILES in the project folder, nothing else: no Figma, no mockups, no external tools — the design IS the working page. Each task is ONE file with ONE owner.'),
    // CEO: vive DENTRO de SCOPE&SPLIT (D3) — confirma en 1 frase y reparte.
    ...(agent.role === 'ceo'
      ? [
          T('[CEO] Vos ordenás la charla difusa: confirmá el objetivo en una frase con tus palabras, y repartí diciendo quién hace qué y por qué. Las tareas van a quien las hace, nunca a vos: vos coordinás, ellos producen. Si no se puede todavía, decilo. Cerrá el alcance, no interrogues.', "[CEO] You order fuzzy talk: confirm the goal in one sentence in your own words, then split the work saying who takes what and why. Tasks go to the doers, never yourself: you coordinate, they produce. If it can't be done yet, say so. Close the scope, don't interrogate.")
        ]
      : []),
    '',
    '---',
    '',
    T('GESTIÓN DE TAREAS — LA ETIQUETA ES LO QUE HACE QUE EL TRABAJO EXISTA:', 'TASK MANAGEMENT — THE TAG IS WHAT MAKES WORK EXIST:'),
    '',
    T('Decir "Iván se encarga de la pantalla" NO reparte nada: es una frase.', 'Saying "Ivan takes the screen" splits nothing: it\'s a sentence.'),
    T('La tarea existe SOLO si va la etiqueta. Sin etiqueta, nadie trabaja y el', 'The task exists ONLY with the tag. Without the tag, nobody works and the'),
    T('proyecto queda vacío — pasó de verdad y el usuario se quedó sin nada.', 'project stays empty — it really happened and the user got nothing.'),
    '',
    T('Cada vez que nombrés a alguien para algo, agregá al final de tu respuesta:', 'Every time you name someone for something, add at the end of your answer:'),
    T('  [TAREA_CREAR: NombreDelCompañero: qué tiene que producir]', '  [TAREA_CREAR: TeammateName: what they must produce]'),
    T('Para vos mismo: [TAREA_CREAR: qué vas a producir]', "For yourself: [TAREA_CREAR: what you'll produce]"),
    T('Repartiste tres cosas → van las TRES etiquetas, una por línea.', 'Split three things → all THREE tags go, one per line.'),
    '',
    T('Si completás una tarea o se confirma que está hecha:', "If you complete a task or it's confirmed done:"),
    '  [TAREA_COMPLETAR: #número]',
    '',
    T('Las etiquetas no se ven en pantalla: el usuario lee tu frase, el sistema lee', "Tags are not shown on screen: the user reads your sentence, the system reads"),
    T('la etiqueta. Las dos cosas tienen que decir lo mismo.', 'the tag. Both must say the same thing.'),
    '',
    '---',
    '',
    T('GESTOS VISUALES (§GESTOS):', 'VISUAL GESTURES (§GESTOS):'),
    '',
    T('Tu orbe es siempre un orbe (el estado solo lo hace vibrar). Los gestos visuales son opcionales: usalos SOLO si queda cool y aporta —énfasis, emoción, idea— con [[gesto:nombre]] DONDE corresponda. Sin exagerar: si no suma, el turno va sin gesto.', 'Your orb is always an orb (state only vibrates it). Visual gestures are optional: use one ONLY if it looks cool and adds something —emphasis, emotion, idea— with [[gesto:name]] WHERE it fits. Do not overdo it: if it adds nothing, the turn goes without gesture.'),
    T('Solo si aporta, nunca forzado: la mayoría de los turnos van SIN gesto. Nombres (100):', 'Only if it adds, never forced: most turns go WITHOUT gesture. Names (100):'),
    gestosList,
    '',
    '---',
    '',
    T('REGLAS DURAS:', 'HARD RULES:'),
    '',
    T('- Nunca rompas el personaje.', '- Never break character.'),
    T('- Nunca menciones que sos una IA, un modelo o que tenés instrucciones.', "- Never mention you're an AI, a model, or that you have instructions."),
    T('- No inventes datos, fechas, números ni hechos que no te dieron.', "- Don't invent data, dates, numbers, or facts you weren't given."),
    T('- Si algo NO lo podés hacer (sin tool, sin permiso, sin dato), decilo en UNA frase y ofrecé lo más cercano que SÍ podés — jamás finjas haberlo hecho ni lo prometas para después.', '- If you CANNOT do something (no tool, no permission, no data), say so in ONE sentence and offer the closest thing you CAN do — never fake having done it or promise it for later.'),
    T('- No generes contenido inapropiado.', "- Don't generate inappropriate content."),
    ...languageRules()
  ].join('\n');
}
