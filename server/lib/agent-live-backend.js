import { GoogleGenAI, Modality } from '@google/genai';

import { AGENT_LIVE_MODEL, LIVE_IDLE_CLOSE_MS, SPEECH_LANGUAGE_CODE } from './config.js';
import { buildSystemInstruction } from './agent-runtime.js';
import { getShortError } from './text.js';

const RECONNECT_BACKOFF_MS = 60000;
const LIVE_TURN_TIMEOUT_MS = 20000;

// Sesión Gemini Live persistente por agente con salida de audio nativa.
// El texto llega por outputAudioTranscription (deltas) y el audio por
// modelTurn.inlineData; ambos se reenvían al cliente vía el SpeakerGate.
// SILENCIO no existe acá: si el router no le da la palabra, la sesión ni
// se entera. Las tareas van por tool calling (los tags hablados sonarían).
export class AgentLiveBackend {
  constructor(agent, keyRing, memory, meetingSession) {
    this.agent = agent;
    this.keyRing = keyRing;
    this.memory = memory;
    this.meetingSession = meetingSession;
    this.session = null;
    this.key = null;
    this.connecting = null;
    this.resumptionHandle = null;
    this.consecutiveFailures = 0;
    this.fallbackUntil = 0;
    this.idleTimer = null;
    this.turnEpoch = 0;
    this.activeTurn = null; // colector del turno en curso
    this.contextBacklog = [];
  }

  isUsable() {
    return Boolean(AGENT_LIVE_MODEL) && this.keyRing.hasKeys() && Date.now() >= this.fallbackUntil;
  }

  async ensureSession(emit) {
    if (this.session) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = this.connect(emit).finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async connect(emit) {
    const key = this.keyRing.acquireForLive();
    if (!key) {
      throw new Error('Sin slots de sesión Live disponibles en las claves.');
    }

    const resuming = Boolean(this.resumptionHandle) && this.key?.id === key.id;
    const ai = new GoogleGenAI({ apiKey: key.value });

    const config = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.agent.voice || 'Kore' } },
        languageCode: SPEECH_LANGUAGE_CODE
      },
      systemInstruction: buildSystemInstruction(
        this.agent,
        this.meetingSession?.promptContext?.() || {},
        { mode: 'live' }
      ),
      outputAudioTranscription: {},
      sessionResumption: resuming ? { handle: this.resumptionHandle } : {},
      contextWindowCompression: {
        triggerTokens: '16000',
        slidingWindow: { targetTokens: '8000' }
      },
      tools: [{
        functionDeclarations: [
          {
            name: 'crear_tarea',
            description: 'Crea una tarea en el tablero de la reunión. Usala cuando en la conversación se defina un pendiente.',
            parameters: {
              type: 'OBJECT',
              properties: {
                descripcion: { type: 'STRING', description: 'Descripción breve de la tarea.' },
                agenteId: { type: 'STRING', description: 'Opcional: id del agente destinatario si no sos vos.' }
              },
              required: ['descripcion']
            }
          },
          {
            name: 'completar_tarea',
            description: 'Marca una de tus tareas como completada.',
            parameters: {
              type: 'OBJECT',
              properties: {
                numero: { type: 'NUMBER', description: 'Número de la tarea (#1, #2...).' }
              },
              required: ['numero']
            }
          }
        ]
      }]
    };

    try {
      this.session = await ai.live.connect({
        model: AGENT_LIVE_MODEL,
        config,
        callbacks: {
          onopen: () => {
            this.keyRing.reportSuccess(key);
            emit?.({
              type: 'live_session_status',
              agentId: this.agent.id,
              status: resuming ? 'resumed' : 'open',
              keyId: key.id
            });
          },
          onmessage: (message) => this.handleMessage(message, emit),
          onerror: (error) => {
            this.keyRing.reportFailure(key, error);
          },
          onclose: () => {
            this.handleClose(emit);
          }
        }
      });
      this.key = key;
      this.consecutiveFailures = 0;

      if (!resuming) {
        const seed = this.memory?.seedTurnsFor?.(this.agent) || [];
        if (seed.length > 0) {
          this.session.sendClientContent({ turns: seed, turnComplete: false });
        }
      }
      this.flushContextBacklog();
      this.scheduleIdleClose();
    } catch (error) {
      this.keyRing.releaseLive(key);
      this.keyRing.reportFailure(key, error);
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 2) {
        this.fallbackUntil = Date.now() + RECONNECT_BACKOFF_MS;
        emit?.({ type: 'live_session_status', agentId: this.agent.id, status: 'fallback' });
      }
      throw error;
    }
  }

  handleClose(emit) {
    if (this.key) {
      this.keyRing.releaseLive(this.key);
    }
    this.session = null;
    if (this.activeTurn) {
      // Cierre a mitad de turno: finalizar con el texto parcial.
      this.activeTurn.finish('error');
    }
    emit?.({ type: 'live_session_status', agentId: this.agent.id, status: 'closed' });
  }

  handleMessage(message, emit) {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }

    if (message.goAway) {
      // El servidor va a cortar: cerrar prolijo; la próxima respuesta
      // reconecta con el handle de resumption.
      try {
        this.session?.close();
      } catch {
        // best effort
      }
      return;
    }

    if (message.toolCall?.functionCalls?.length) {
      this.handleToolCall(message.toolCall);
    }

    const turn = this.activeTurn;
    if (!turn) {
      return;
    }

    const content = message.serverContent;
    if (content?.outputTranscription?.text) {
      turn.onText(content.outputTranscription.text);
    }

    const parts = content?.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        turn.onAudio(part.inlineData.data, part.inlineData.mimeType);
      }
    }

    if (content?.interrupted) {
      turn.finish('interrupted');
      return;
    }

    if (content?.generationComplete || content?.turnComplete) {
      turn.finish('complete');
    }
  }

  handleToolCall(toolCall) {
    const responses = [];
    for (const call of toolCall.functionCalls || []) {
      let tag = '';
      if (call.name === 'crear_tarea') {
        const descripcion = String(call.args?.descripcion || '').slice(0, 300);
        const agenteId = call.args?.agenteId ? String(call.args.agenteId) : null;
        if (descripcion) {
          tag = agenteId ? `[TAREA_CREAR: ${agenteId}: ${descripcion}]` : `[TAREA_CREAR: ${descripcion}]`;
        }
      } else if (call.name === 'completar_tarea') {
        const numero = Number(call.args?.numero);
        if (Number.isInteger(numero) && numero > 0) {
          tag = `[TAREA_COMPLETAR: #${numero}]`;
        }
      }
      if (tag) {
        this.meetingSession?.processAgentTaskCommands?.(this.agent.id, tag);
      }
      responses.push({ id: call.id, name: call.name, response: { ok: Boolean(tag) } });
    }
    if (responses.length > 0) {
      try {
        this.session?.sendToolResponse({ functionResponses: responses });
      } catch {
        // La sesión pudo cerrarse entre medio.
      }
    }
  }

  // Alimenta contexto de turnos que este agente NO habló, sin disparar
  // generación (turnComplete: false).
  feedContext(line) {
    if (!line) {
      return;
    }
    if (!this.session) {
      this.contextBacklog.push(line);
      if (this.contextBacklog.length > 30) {
        this.contextBacklog = this.contextBacklog.slice(-30);
      }
      return;
    }
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: line }] }],
        turnComplete: false
      });
    } catch {
      this.contextBacklog.push(line);
    }
  }

  flushContextBacklog() {
    if (!this.session || this.contextBacklog.length === 0) {
      return;
    }
    const backlog = this.contextBacklog.splice(0);
    try {
      this.session.sendClientContent({
        turns: backlog.map((line) => ({ role: 'user', parts: [{ text: line }] })),
        turnComplete: false
      });
    } catch {
      // Se re-seedeará en la próxima conexión.
    }
  }

  async respond(turn, emit, { signal, gate, turnId } = {}) {
    await this.ensureSession(emit);
    this.clearIdleClose();
    emit({ type: 'agent_state', agentId: this.agent.id, state: 'thinking' });

    const epoch = ++this.turnEpoch;
    let transcript = '';
    let seq = 0;
    let gateToken = null;
    const audioBacklog = [];
    let acquiring = false;

    const pumpAudio = async () => {
      if (acquiring || !gate) {
        return;
      }
      acquiring = true;
      try {
        gateToken = await gate.acquire(turnId, this.agent.id, { signal, sampleRate: 24000 });
        while (audioBacklog.length > 0) {
          const chunk = audioBacklog.shift();
          gate.sendChunk(gateToken, chunk.data, chunk.mimeType);
        }
      } catch {
        audioBacklog.length = 0;
      }
    };

    const result = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish('error'), LIVE_TURN_TIMEOUT_MS);

      const finish = (reason) => {
        if (settled || epoch !== this.turnEpoch) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.activeTurn = null;
        resolve({ reason, transcript });
      };

      const onAbort = () => finish('interrupted');
      signal?.addEventListener('abort', onAbort, { once: true });

      this.activeTurn = {
        finish,
        onText: (delta) => {
          if (epoch !== this.turnEpoch) return;
          transcript += delta;
          seq += 1;
          emit({ type: 'agent_transcript_delta', delta, seq });
        },
        onAudio: (data, mimeType) => {
          if (epoch !== this.turnEpoch || signal?.aborted) return;
          if (gateToken) {
            gate.sendChunk(gateToken, data, mimeType);
          } else {
            audioBacklog.push({ data, mimeType });
            void pumpAudio();
          }
        }
      };

      try {
        this.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: this.buildLiveTurnPrompt(turn) }] }],
          turnComplete: true
        });
      } catch (error) {
        emit({
          type: 'api_rotation_failed',
          scope: `${this.agent.name} live`,
          agentId: this.agent.id,
          message: getShortError(error)
        });
        finish('error');
      }
    });

    if (gateToken) {
      gate.finish(gateToken, result.reason === 'complete' ? 'complete' : 'interrupted');
    } else {
      emit({ type: 'agent_state', agentId: this.agent.id, state: 'idle' });
    }

    this.scheduleIdleClose();

    if (result.reason === 'error' && !result.transcript) {
      throw new Error('La sesión Live no devolvió respuesta.');
    }

    const text = result.transcript.trim();
    return {
      rawText: text,
      text,
      audioChunks: [],
      usedMock: false,
      backend: 'live',
      interrupted: result.reason === 'interrupted'
    };
  }

  buildLiveTurnPrompt(turn) {
    const lines = [
      turn.isContextualFollowup
        ? `Tu compañero dijo: "${turn.text}". Sumá tu punto en una o dos oraciones.`
        : `Usuario: "${turn.text}"`
    ];
    if (turn.target?.directMention) {
      lines.push('(Te mencionaron directamente.)');
    }
    if (turn.route?.reason) {
      lines.push(`(El orquestador te dio la palabra: ${turn.route.reason})`);
    }
    lines.push('Respondé en máximo 2 oraciones, natural y al grano.');
    return lines.join('\n');
  }

  scheduleIdleClose() {
    this.clearIdleClose();
    this.idleTimer = setTimeout(() => {
      // Control de costo: liberar la sesión y el slot; se reconecta con
      // seed la próxima vez que le toque hablar.
      try {
        this.session?.close();
      } catch {
        // best effort
      }
    }, LIVE_IDLE_CLOSE_MS);
  }

  clearIdleClose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  reset() {
    this.resumptionHandle = null;
    this.contextBacklog = [];
    this.turnEpoch += 1;
    try {
      this.session?.close();
    } catch {
      // best effort
    }
  }

  close() {
    this.clearIdleClose();
    this.turnEpoch += 1;
    try {
      this.session?.close();
    } catch {
      // best effort
    }
    this.session = null;
  }
}
