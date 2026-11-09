import { AGENT_TEXT_TIMEOUT_MS } from './config.js';
import { renderSkillsSection } from './skills.js';
import { getDeepgramKey, getManosEnabled, getManosMaxTurns, getMinimaxModels, getSttLanguage, getTtsEngine, getTtsLanguage, ttsLocalOrder } from './settings.js';
import { completeChat, streamChat, withTimeout } from './llm.js';
import { synthesize } from './supertonic.js';
import { synthesizePiper } from './piper.js';
import { synthesizeEdgeMp3 } from './edge-tts.js';
import { synthesizeDeepgram } from './deepgram.js';
import { cleanAgentText, createPartsParser, createTagFilter, getShortError, isSilenceResponse, normalize, stripForeignScript, stripPrivateBlocks, stripProgressBlocks, stripSpeechLeaks, stripTaskTags } from './text.js';

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
export function bindManosCompleteChat(keyRing) {
  return (...args) => {
    if (args.length >= 2) return completeChat(args[0], args[1]);
    const only = args[0];
    const opts = Array.isArray(only)
      ? { messages: only, scope: 'manos', maxTokens: 1500 }
      : only;
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
export async function maybeRunToolsPhase({ turn, system, userContent, keyRing, emit, source, turnId, agentId, signal, companyId = null, slug = null, agentRole = null }) {
  const fallback = { userContent, toolSummary: '', toolTurns: 0, ran: false };
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
  // Track C: MCP visibles en el prompt desde el turno 1. Antes loadMcpTools
  // corría DENTRO del loop (después del render) → las mcp_* no se listaban.
  // Best-effort: si falla, el turno sigue con las builtins.
  try {
    await manos.loadMcpTools?.();
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
  try {
    loopEmit({ type: 'agent_progress', text: 'Using tools…' });
  } catch {
    // Emit caído: las tools igual corren; el habla no depende del aviso.
  }
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
        completeChat: bindManosCompleteChat(keyRing),
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
        aprobadoOutreach: turn?.aprobadoOutreach ?? null
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
  if (!toolSummary) {
    return { userContent, toolSummary: '', toolTurns, ran: true };
  }
  return {
    userContent: `${userContent}\n\n${MANOS_TOOLS_MARKER}\n${toolSummary}`,
    toolSummary,
    toolTurns,
    ran: true
  };
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
    // MODO VOZ (turno hablado): contexto corto, tope 1000, instrucción
    // conversacional (resumido, sin tope de palabras), rotación si el
    // modelo no arranca.
    // Los turnos de texto mantienen calidad completa.
    const voiceFast = turn.source === 'audio';

    let probeBuffer = '';
    let probeDone = false;
    let silenced = false;
    let sentenceBuffer = '';
    let seq = 0;
    // Las etiquetas [TAREA_...] no se muestran mientras el agente habla.
    const tagFilter = createTagFilter();
    let gateToken = null;
    let audioRunner = Promise.resolve();
    // Telemetría Fase 0-lite: marcas de tiempo del turno (primera palabra
    // hablable, primer audio). Medir nunca puede romper hablar.
    const turnT0 = Date.now();
    let thinkChars = 0;
    let speakAnnounced = false;
    let firstAudioMarked = false;
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

    const speakSentence = async (sentence) => {
      // Sin modo llamada no hay voz. Antes se sintetizaba SIEMPRE: gastaba
      // Supertonic en cada turno, sumaba latencia y —lo peor— tomaba el
      // SpeakerGate, que serializa a los agentes de a uno para un audio que
      // nadie estaba escuchando.
      if (!this.meetingSession?.voiceEnabled) {
        return;
      }
      const spoken = stripSpeechLeaks(sentence).trim();
      if (!spoken || signal?.aborted) {
        return;
      }
      const parts = await this.generateAudioParts(spoken, emit, signal);
      if (signal?.aborted) {
        return;
      }
      if (parts.length === 0) {
        // Sin TTS propio (Deepgram ya se intentó en generateAudioParts):
        // Edge TTS (nube sin clave) → speechSynthesis del cliente.
        try {
          const mp3 = await synthesizeEdgeMp3(spoken, { voice: this.agent?.voice || 'M1' });
          if (signal?.aborted) {
            return;
          }
          await ensureGateToken(24000);
          if (signal?.aborted) {
            return;
          }
          emit({ type: 'agent_audio_mp3', turnId, agentId: this.id, data: mp3.data, mimeType: mp3.mimeType });
        } catch {
          // Sin audio del servidor: el cliente se encarga (voz navegador).
        }
        return;
      }
      if (!firstAudioMarked) {
        firstAudioMarked = true;
        markTelemetry('agent_first_audio');
      }
      const partRate = Number(parts[0].mimeType?.match(/rate=(\d+)/)?.[1] || 44100);
      const token = await ensureGateToken(partRate);
      for (const part of parts) {
        if (signal?.aborted) {
          return;
        }
        gate.sendChunk(token, part.data, part.mimeType);
      }
    };

    const enqueueSentence = (sentence) => {
      if (silenced) return;
      audioRunner = audioRunner
        .then(() => speakSentence(sentence))
        .catch(() => {
          // Errores de TTS/gate no interrumpen el texto.
        });
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
        markTelemetry('agent_first_speak', { thinkChars });
        emit({ type: 'agent_speak_start', turnId, agentId: this.id });
      }

      const visible = tagFilter.push(text);
      if (visible) {
        seq += 1;
        emit({ type: 'agent_transcript_delta', delta: visible, seq });
      }

      sentenceBuffer += text;
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
        const clean = content.trim();
        if (clean && !silenced) {
          emit({ type: 'agent_progress', turnId, agentId: this.id, text: clean.slice(0, 200) });
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
      agentRole: this.agent?.role || null
    });
    const userContent = phase.userContent;
    try {
      result = await streamChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `${this.name} texto`,
        timeoutMs: AGENT_TEXT_TIMEOUT_MS,
        // Sin primer token en 8s se rota al siguiente modelo (colas Zen).
        ttftMs: voiceFast ? 8000 : 0,
        emit,
        signal,
        maxTokens: voiceFast ? 1000 : 3000,
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
        return { ...emptyAgentResponse(), backend: 'stream', interrupted: true };
      }
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: getShortError(error)
      });
      emit({ type: 'agent_silence', reason: `${this.name} could not generate a real answer.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), backend: 'stream' };
    }

    // Cierre de partes (avance sin cerrar se muestra; think sin cerrar se
    // descarta: el pensamiento nunca se habla) + lo retenido por el filtro.
    streamParts.flush();
    flushVisible();

    // El texto guardado pela think/avance (nunca fueron para el usuario);
    // las [TAREA_*] se conservan para el parser de tareas.
    const rawText = cleanAgentText(stripProgressBlocks(stripPrivateBlocks(result.text)), this.name);
    const spokenText = stripTaskTags(rawText);

    if (!rawText || silenced || isSilenceResponse(spokenText)) {
      emit({ type: 'agent_silence', reason: `${this.name} declined to answer by protocol.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), rawText, backend: 'stream' };
    }

    // Última oración pendiente + cierre del gate cuando termine el audio.
    if (sentenceBuffer.trim()) {
      enqueueSentence(sentenceBuffer);
      sentenceBuffer = '';
    }
    void audioRunner.finally(() => {
      if (gateToken) {
        gate.finish(gateToken, signal?.aborted ? 'interrupted' : 'complete');
      } else {
        emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      }
    });

    return {
      rawText,
      text: rawText,
      audioChunks: [],
      usedMock: false,
      backend: 'stream',
      interrupted: Boolean(result.aborted)
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

    const tasksFormatted = (this.agent.tasks && this.agent.tasks.length > 0)
      ? this.agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? T('Completada', 'Done') : T('Pendiente', 'Pending')})`).join('\n')
      : T('No tenés tareas por el momento.', 'You have no tasks right now.');

    const lines = [
      turn.isContextualFollowup
        ? T(`Tu compañero dijo algo y te toca responder: "${turn.text}"`, `Your teammate said something and it's your turn to answer: "${turn.text}"`)
        : T(`El usuario dice: "${turn.text}"`, `The user says: "${turn.text}"`),
      ''
    ];

    // Sufijo corto (D2): las reglas de voz viven en el system §VOICE; acá
    // solo el puntero. Es el tramo que más pega en TTFT (va en CADA turno).
    if (turn.source === 'audio') {
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

    lines.push(T('Tus tareas actuales:', 'Your current tasks:'));
    lines.push(tasksFormatted);
    lines.push('');
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

    return lines.join('\n');
  }

  // TTS de una oración: Deepgram Aura primero si hay key (la elegida:
  // javier-es M / selena-es F), luego locales en el orden de Ajustes →
  // tts.engine (auto = Piper → Supertonic). Devuelve las partes de audio
  // (no emite chunks; el gate decide cuándo salen). Si nada responde, []
  // y speakSentence cae a Edge → voz del navegador.
  async generateAudioParts(text, emit, signal) {
    if (!text?.trim() || signal?.aborted) {
      return [];
    }

    if (getDeepgramKey()) {
      try {
        const dgParts = await synthesizeDeepgram(text, this.agent?.voice || 'M1');
        if (dgParts.length > 0) {
          return dgParts;
        }
      } catch {
        // Aura caído: cae a locales.
      }
    }

    // Locales en el orden del setting (auto/piper = Piper → Supertonic;
    // supertonic = Supertonic → Piper). Piper primero en AMBOS idiomas por
    // default: tiene voces inglesas (jenny F / lessac M) y cada oración en
    // inglés evita los ~2.4s de la nube Deepgram. El segundo motor es
    // respaldo del primero: el orden elige preferencia, no exclusividad.
    const voice = this.agent?.voice || 'M1';
    const localSynths = {
      piper: () => synthesizePiper(text, voice, { signal }),
      supertonic: () => synthesize(text, voice, { signal })
    };
    let lastError = null;
    for (const engine of ttsLocalOrder(getTtsEngine())) {
      try {
        const parts = await localSynths[engine]();
        if (parts.length > 0) {
          return parts;
        }
      } catch (error) {
        lastError = error;
      }
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

export function emptyAgentResponse() {
  return { rawText: '', text: '', audioChunks: [], usedMock: false };
}

// El prompt de charla sigue a la VOZ, no al oído: el oído es auto (el
// usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo. Con
// tts.language=en TODO el prompt (instrucción + turno + MODO VOZ) queda en
// inglés para no contaminar la respuesta; si no, español rioplatense.
// Sin store inicializado (tests) el default es 'es', comportamiento viejo.
export function promptIsEnglish() {
  return String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
}

// Reglas de idioma del prompt: inglés si tts.language empieza con 'en',
// español rioplatense si no. Sigue a la VOZ, no al oído: el oído es auto
// (el usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo.
// Sin store inicializado (tests) el default es 'es', comportamiento viejo.
function languageRules() {
  if (String(getTtsLanguage() || 'es').toLowerCase().startsWith('en')) {
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

  const conventionsBlock = context.conventionsSection
    ? [context.conventionsSection, '']
    : [];

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
    T('VOZ Y SALA (§VOICE):', 'VOICE & ROOM RULES (§VOICE):'),
    '',
    T('Persona real en una reunión, no un asistente: 1-2 frases, palabras simples, sin listas, sin tecnicismos, sin saludar en cada respuesta (saludo breve y cálido solo si te saludan). Explayate solo si piden detalle.', 'Real person in a meeting, not an assistant: 1-2 sentences, plain words, no lists, no tech jargon, no greeting every answer (brief warm reply only to greetings). Expand only if asked for detail.'),
    T('Todo lo que emitís SE ESCUCHA o SE VE en el acto: no hay borrador. Texto normal = HABLADO; si vas a tardar, emití PRIMERO un preámbulo de UNA frase con la ACCIÓN ("te lo busco, dame un segundo"), nunca tu proceso. Sin preámbulo si respondés directo.', 'Everything emitted IS HEARD or SEEN at once: no draft. Plain text = SPOKEN; if you\'ll take a while, emit FIRST a ONE-sentence preamble with the ACTION ("looking it up, one second"), never your process. No preamble when answering directly.'),
    T('[PIENSO]...[/PIENSO] = pensamiento privado, SIEMPRE con tags, antes o entre habla. [AVANCE]...[/AVANCE] = progreso que SE VE pero NO se habla, una línea ("revisando 3 archivos…"). Cada parte hablada debe tener sentido sola; si te interrumpen, NO repitas lo ya escuchado.', '[PIENSO]...[/PIENSO] = private thought, ALWAYS tagged, before or between speech. [AVANCE]...[/AVANCE] = progress SEEN but not spoken, one line ("reviewing 3 files…"). Spoken parts must stand alone; if interrupted, do NOT repeat what was heard.'),
    T('Nada que agregar, o un compañero ya lo dijo: respondé SILENCIO, única palabra.', 'Nothing to add, or a teammate already said it: answer SILENCIO, only word.'),
    T('Pedido explícito de Tito manda: si te pide abrir o hacer algo en su compu (pestaña, app, archivo, comando), lo HACÉS en el acto con run_cmd — jamás te niegues por "no interrumpir". Solo tu trabajo autónomo va en silencio sin tocar nada suyo. Corrés en Linux: URLs con `xdg-open <url>` (abre en Brave, el default); no existen `open -a` ni /Applications.', 'An explicit order from Tito wins: if he asks you to open or do anything on his computer (tab, app, file, command), you DO it at once with run_cmd — never refuse to "avoid interrupting". Only your autonomous work stays silent without touching anything of his. You run on Linux: URLs with `xdg-open <url>` (opens in Brave, the default); there is no `open -a` nor /Applications.'),
    '',
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
