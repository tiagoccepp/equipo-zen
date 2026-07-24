import './styles.css';

import { parseServerMessage } from '../shared/protocol.ts';
import type {
  AgentTask as Task,
  KeyStatus,
  PublicAgent as Agent,
  RouteDecision,
  ServerMessage as MeetingMessage
} from '../shared/protocol.ts';

type TranscriptTurn = {
  id: string;
  kind: 'user' | 'agent' | 'system';
  speaker: string;
  agentId?: string;
  text: string;
  muted?: boolean;
};

type StatusAlert = {
  id: string;
  scope: string;
  tone: 'working' | 'ok' | 'error';
  message: string;
  timeout?: number;
};

type MicSettings = {
  sensitivity: number;
  endSilenceMs: number;
  minSpeechMs: number;
};

type MicMeter = {
  level: number;
  startThreshold: number;
  speaking: boolean;
};

const telemetryClientId = crypto.randomUUID();
let telemetrySeq = 0;
let inputTraceTimer = 0;
let speechTraceTimer = 0;
let micMeterRenderTimer = 0;
let voiceStatusTimer = 0;
let renderQueued = false;

const MIC_SETTINGS_STORAGE_KEY = 'reunion.micSettings.v1';
const DEFAULT_MIC_SETTINGS: MicSettings = {
  sensitivity: 55,
  endSilenceMs: 800,
  minSpeechMs: 600
};
const MIC_PRESETS: Record<string, MicSettings> = {
  ruido: { sensitivity: 18, endSilenceMs: 1080, minSpeechMs: 920 },
  normal: DEFAULT_MIC_SETTINGS,
  suave: { sensitivity: 78, endSilenceMs: 600, minSpeechMs: 360 }
};

function trace(type: string, payload: Record<string, unknown> = {}, turnId?: string) {
  const body = JSON.stringify({
    type,
    sessionId: state.sessionId || undefined,
    turnId,
    payload: {
      clientId: telemetryClientId,
      seq: telemetrySeq += 1,
      pageMs: Math.round(performance.now()),
      path: window.location.pathname,
      ...payload
    }
  });

  void fetch(`${backendHttpBase()}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: body.length < 60000
  }).catch(() => {
    // La telemetria es diagnostica; no debe afectar la reunion.
  });
}

function backendHttpBase() {
  const host = window.location.port === '5173'
    ? `${window.location.hostname}:8787`
    : window.location.host;
  return `${window.location.protocol}//${host}`;
}

class PcmAudioQueue {
  private context: AudioContext | null = null;
  private nextStart = 0;

  async enqueueBase64Pcm(base64: string, sampleRate: number) {
    const context = this.ensureContext();
    if (context.state === 'suspended') {
      await context.resume();
    }

    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, samples[index] / 32768));
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
  }

  stop() {
    this.context?.close();
    this.context = null;
    this.nextStart = 0;
  }

  private ensureContext() {
    if (this.context && this.context.state !== 'closed') {
      return this.context;
    }
    if (this.context) {
      void this.context.close();
    }
    this.context = new AudioContext({ sampleRate: 24000 });
    this.nextStart = this.context.currentTime;
    return this.context;
  }
}

class LiveMicrophoneStreamer {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private lastMeterAt = 0;
  private preBuffer: Array<{ data: string; durationMs: number }> = [];

  private sendMessage: (payload: unknown) => void;
  private onState: (label: string) => void;
  private onMeter: (meter: MicMeter) => void;

  constructor(
    sendMessage: (payload: unknown) => void,
    onState: (label: string) => void,
    onMeter: (meter: MicMeter) => void
  ) {
    this.sendMessage = sendMessage;
    this.onState = onState;
    this.onMeter = onMeter;
  }

  async start() {
    if (this.context) {
      return;
    }

    trace('audio_prepare_requested');
    this.sendMessage({ type: 'audio_prepare' });

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.context = new AudioContext({ sampleRate: 16000 });
    const workletUrl = URL.createObjectURL(new Blob([audioWorkletCode()], { type: 'text/javascript' }));
    await this.context.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'pcm-capture-processor');
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number; durationMs: number }>) => {
      this.handlePcmChunk(event.data);
    };
    this.source.connect(this.worklet);
    this.worklet.connect(this.mute);
    this.mute.connect(this.context.destination);
    trace('microphone_ready');
    this.onState('Escuchando audio real.');
  }

  stop() {
    trace('audio_stop_requested', { wasSpeaking: this.speaking });
    if (this.speaking) {
      const transcriptHint = state.browserSpeech?.latestUtterance() || state.clientSpeechText;
      trace('speech_ended_by_stop', { transcriptHint });
      this.sendMessage({ type: 'audio_end', transcriptHint });
    }
    this.sendMessage({ type: 'audio_stop' });
    this.worklet?.disconnect();
    this.mute?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.mute = null;
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.preBuffer = [];
    this.onMeter({ level: 0, startThreshold: micThresholds(state.micSettings).startThreshold, speaking: false });
    this.onState('');
  }

  private handlePcmChunk(chunk: { pcm: ArrayBuffer; rms: number; durationMs: number }) {
    const payload = {
      data: base64FromArrayBuffer(chunk.pcm),
      durationMs: chunk.durationMs
    };

    const settings = state.micSettings;
    const { startThreshold, continueThreshold } = micThresholds(settings);
    const endSilenceMs = settings.endSilenceMs;
    const now = performance.now();
    if (now - this.lastMeterAt > 180) {
      this.lastMeterAt = now;
      this.onMeter({ level: chunk.rms, startThreshold, speaking: this.speaking });
    }

    if (!this.speaking && state.speakingAgentId) {
      this.preBuffer = [];
      return;
    }

    if (!this.speaking) {
      this.preBuffer.push(payload);
      this.preBuffer = this.preBuffer.slice(-4);
      if (chunk.rms >= startThreshold) {
        this.speaking = true;
        this.silenceMs = 0;
        this.speechMs = 0;
        state.audio.stop();
        state.browserSpeech?.resetUtterance();
        state.clientSpeechText = '';
        trace('speech_started', {
          rms: Number(chunk.rms.toFixed(4)),
          startThreshold: Number(startThreshold.toFixed(4)),
          sensitivity: settings.sensitivity
        });
        this.sendMessage({ type: 'audio_start' });
        for (const buffered of this.preBuffer) {
          this.sendMessage({ type: 'audio_chunk', data: buffered.data, mimeType: 'audio/pcm;rate=16000' });
        }
        this.preBuffer = [];
        this.onState('Hablando...');
      }
      return;
    }

    this.sendMessage({ type: 'audio_chunk', data: payload.data, mimeType: 'audio/pcm;rate=16000' });
    this.speechMs += chunk.durationMs;
    if (chunk.rms < continueThreshold) {
      this.silenceMs += chunk.durationMs;
    } else {
      this.silenceMs = 0;
    }

    if (this.silenceMs >= endSilenceMs) {
      this.speaking = false;
      this.silenceMs = 0;
      this.onMeter({ level: chunk.rms, startThreshold, speaking: false });
      const transcriptHint = state.browserSpeech?.latestUtterance() || state.clientSpeechText;
      const speechMs = Math.round(this.speechMs);
      this.speechMs = 0;
      if (!transcriptHint && speechMs < settings.minSpeechMs) {
        trace('speech_discarded', {
          speechMs,
          minSpeechMs: settings.minSpeechMs,
          endSilenceMs,
          startThreshold: Number(startThreshold.toFixed(4))
        });
        this.sendMessage({ type: 'audio_cancel', reason: 'too_short', speechMs });
        state.clientSpeechText = '';
        state.browserSpeech?.resetUtterance();
        this.onState('Ruido descartado.');
        window.setTimeout(() => {
          if (state.recording && state.voiceStatus === 'Ruido descartado.') {
            state.voiceStatus = 'Audio Live conectado.';
            render();
          }
        }, 900);
        return;
      }
      trace('speech_ended', { transcriptHint, endSilenceMs, speechMs });
      this.sendMessage({ type: 'audio_end', transcriptHint });
      this.onState('Procesando audio...');
    }
  }
}

class BrowserSpeechRecognizer {
  private recognition: any = null;
  private active = false;
  private segments = new Map<number, string>();
  private utteranceStartIndex = 0;
  private maxSeenIndex = -1;
  private restartTimer = 0;

  private onTranscript: (text: string) => void;

  constructor(onTranscript: (text: string) => void) {
    this.onTranscript = onTranscript;
  }

  start() {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor || this.recognition) {
      return Boolean(SpeechRecognitionCtor);
    }

    this.active = true;
    this.recognition = new SpeechRecognitionCtor();
    this.recognition.lang = 'es-ES';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.onresult = (event: any) => this.handleResult(event);
    this.recognition.onerror = () => {
      // El audio PCM del backend queda como respaldo si el navegador no reconoce voz.
    };
    this.recognition.onend = () => {
      if (!this.active) {
        return;
      }
      window.clearTimeout(this.restartTimer);
      this.restartTimer = window.setTimeout(() => {
        try {
          this.recognition?.start();
        } catch {
          // Algunos navegadores rechazan start() si ya esta arrancando.
        }
      }, 250);
    };

    try {
      this.recognition.start();
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.active = false;
    window.clearTimeout(this.restartTimer);
    try {
      this.recognition?.stop();
    } catch {
      // Stop is best effort.
    }
    this.recognition = null;
    this.segments.clear();
    this.utteranceStartIndex = 0;
    this.maxSeenIndex = -1;
  }

  resetUtterance() {
    this.segments.clear();
    this.utteranceStartIndex = this.maxSeenIndex + 1;
    this.onTranscript('');
  }

  latestUtterance() {
    return Array.from(this.segments.entries())
      .filter(([index]) => index >= this.utteranceStartIndex)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private handleResult(event: any) {
    if (event.results.length <= this.utteranceStartIndex && event.resultIndex === 0) {
      this.utteranceStartIndex = 0;
      this.segments.clear();
    }

    for (let index = Math.max(event.resultIndex || 0, this.utteranceStartIndex); index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript?.trim();
      if (text) {
        this.segments.set(index, text);
        this.maxSeenIndex = Math.max(this.maxSeenIndex, index);
      }
    }

    this.onTranscript(this.latestUtterance());
  }
}

const state = {
  sessionId: '',
  socket: null as WebSocket | null,
  agents: [] as Agent[],
  model: '',
  connected: false,
  liveMode: false,
  recording: false,
  interimSpeech: '',
  voiceStatus: '',
  activeAudioTranscript: '',
  manualText: '',
  turns: [] as TranscriptTurn[],
  speakingAgentId: '',
  route: null as RouteDecision | null,
  keyStatus: [] as KeyStatus[],
  alerts: [] as StatusAlert[],
  microphone: null as LiveMicrophoneStreamer | null,
  browserSpeech: null as BrowserSpeechRecognizer | null,
  clientSpeechText: '',
  micSettings: loadMicSettings(),
  micMeter: { level: 0, startThreshold: micThresholds(loadMicSettings()).startThreshold, speaking: false } as MicMeter,
  turnStartedAt: new Map<string, number>(),
  agentStartedAt: new Map<string, number>(),
  audio: new PcmAudioQueue(),
  isSpawnOpen: false,
  selectedSpawnColor: '#2f6f73'
};

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('No se encontro #app.');
}
const app: HTMLDivElement = root;

connect();
render();
trace('page_loaded', {
  userAgent: navigator.userAgent,
  viewport: { width: window.innerWidth, height: window.innerHeight }
});

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsHost = window.location.port === '5173'
    ? `${window.location.hostname}:8787`
    : window.location.host;
  const socket = new WebSocket(`${protocol}://${wsHost}/meeting`);

  socket.addEventListener('open', () => {
    state.connected = true;
    trace('socket_open');
    render();
  });

  socket.addEventListener('close', () => {
    state.connected = false;
    state.speakingAgentId = '';
    trace('socket_close');
    render();
    window.setTimeout(connect, 1200);
  });

  socket.addEventListener('message', async (event) => {
    const message = parseServerMessage(event.data);
    if (!message) {
      trace('server_message_invalid', { raw: String(event.data).slice(0, 200) });
      return;
    }
    traceIncomingMessage(message);
    await handleServerMessage(message);
    render();
  });

  state.socket = socket;
}

async function handleServerMessage(message: MeetingMessage) {
  switch (message.type) {
    case 'agents_updated':
      state.agents = message.agents;
      break;

    case 'meeting_ready':
      state.sessionId = message.id;
      state.agents = message.agents;
      state.model = message.model;
      state.liveMode = message.liveMode;
      trace('meeting_ready', {
        model: message.model,
        liveMode: message.liveMode,
        agents: message.agents.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }))
      });
      state.turns.push({
        id: crypto.randomUUID(),
        kind: 'system',
        speaker: 'Sistema',
        text: message.liveMode
          ? 'Modo Live conectado. Julio y Tomasa responden por sesiones Gemini Live en el backend.'
          : 'Modo simulacion activo. Configura .env con tus claves Gemini para activar Live API.'
      });
      break;

    case 'meeting_reset':
      state.turns = [];
      state.route = null;
      state.activeAudioTranscript = '';
      state.clientSpeechText = '';
      state.turnStartedAt.clear();
      state.agentStartedAt.clear();
      state.browserSpeech?.resetUtterance();
      state.audio.stop();
      break;

    case 'user_turn_received':
      state.turnStartedAt.set(message.turnId, performance.now());
      state.turns.push({ id: message.turnId, kind: 'user', speaker: 'Tu', text: message.text });
      state.voiceStatus = message.source === 'audio' ? 'Orquestando respuesta...' : state.voiceStatus;
      break;

    case 'route_decision':
      state.route = message.route;
      if (message.route.targets.length === 0) {
        setVoiceStatus(state.recording ? 'Sin respuesta necesaria.' : '', 1200);
      }
      break;

    case 'no_agent_response':
      setVoiceStatus(state.recording ? 'Audio Live conectado.' : '', 0);
      break;

    case 'agent_turn_start':
      state.speakingAgentId = message.agentId;
      state.voiceStatus = '';
      state.agentStartedAt.set(`${message.turnId}-${message.agentId}`, performance.now());
      state.turns.push({
        id: `${message.turnId}-${message.agentId}`,
        kind: 'agent',
        speaker: agentName(message.agentId),
        agentId: message.agentId,
        text: ''
      });
      break;

    case 'agent_transcript_delta':
      appendAgentText(message.turnId, message.agentId, message.delta);
      break;

    case 'agent_audio_chunk':
      await state.audio.enqueueBase64Pcm(message.data, parseRate(message.mimeType || ''));
      break;

    case 'agent_turn_complete':
      state.speakingAgentId = '';
      state.keyStatus = message.keyStatus || [];
      trace('agent_visible_complete', {
        agentId: message.agentId,
        elapsedFromUserMs: elapsedFromMap(state.turnStartedAt, message.turnId),
        agentElapsedMs: elapsedFromMap(state.agentStartedAt, `${message.turnId}-${message.agentId}`),
        text: message.text,
        usedMock: message.usedMock
      }, message.turnId);
      if (!message.text?.trim()) {
        removeAgentTurn(message.turnId, message.agentId);
      } else {
        setAgentText(message.turnId, message.agentId, message.text);
      }
      break;

    case 'agent_silence':
      setVoiceStatus(state.recording ? 'Audio Live conectado.' : '', 0);
      break;

    case 'audio_listening_start':
      state.voiceStatus = 'Audio Live conectado.';
      break;

    case 'audio_listening_stop':
      state.voiceStatus = '';
      state.activeAudioTranscript = '';
      break;

    case 'user_audio_transcript_delta':
      state.activeAudioTranscript = message.text;
      break;

    case 'user_audio_turn_final':
      state.activeAudioTranscript = '';
      state.clientSpeechText = '';
      state.browserSpeech?.resetUtterance();
      state.voiceStatus =
        message.source === 'fallback'
          ? 'Audio transcripto.'
          : message.source === 'client'
            ? 'Audio reconocido.'
            : 'Audio Live transcripto.';
      break;

    case 'audio_transcription_status':
      state.voiceStatus = message.message;
      break;

    case 'audio_transcription_empty':
      state.voiceStatus = '';
      upsertAlert('audio-empty', 'Audio', message.message, 'error', 2600);
      break;

    case 'api_rotation_start':
      upsertAlert(`rotation-${message.scope}`, message.scope, message.message, 'working');
      break;

    case 'api_rotation_resolved':
      resolveAlertIfPresent(
        `rotation-${message.scope}`,
        message.scope,
        `${message.scope} recuperado.`
      );
      break;

    case 'api_rotation_failed':
      upsertAlert(`rotation-${message.scope}`, message.scope, `No se pudo recuperar ${message.scope}: ${message.message}`, 'error');
      break;

    case 'health':
      state.keyStatus = message.keys || [];
      break;

    case 'error':
      state.turns.push({
        id: crypto.randomUUID(),
        kind: 'system',
        speaker: 'Error',
        text: `${message.message} ${message.detail || ''}`.trim()
      });
      break;
  }
}

function traceIncomingMessage(message: MeetingMessage) {
  if (message.type === 'agent_audio_chunk') {
    return;
  }

  if (message.type === 'agent_transcript_delta') {
    trace('server_message_received', {
      type: message.type,
      agentId: message.agentId,
      deltaLength: message.delta.length
    }, message.turnId);
    return;
  }

  if (message.type === 'user_audio_transcript_delta') {
    trace('server_message_received', {
      type: message.type,
      text: message.text,
      length: message.text.length
    });
    return;
  }

  if (message.type === 'route_decision') {
    trace('server_message_received', {
      type: message.type,
      elapsedFromUserMs: elapsedFromMap(state.turnStartedAt, message.turnId),
      reason: message.route.reason,
      targets: message.route.targets.map((target) => ({
        agentId: target.agentId,
        name: target.name,
        score: target.score,
        directMention: target.directMention,
        matchedDomains: target.matchedDomains
      }))
    }, message.turnId);
    return;
  }

  if (message.type === 'agent_turn_start') {
    trace('server_message_received', {
      type: message.type,
      agentId: message.agentId,
      elapsedFromUserMs: elapsedFromMap(state.turnStartedAt, message.turnId)
    }, message.turnId);
    return;
  }

  if (message.type === 'agent_turn_complete') {
    trace('server_message_received', {
      type: message.type,
      agentId: message.agentId,
      text: message.text,
      usedMock: message.usedMock,
      elapsedFromUserMs: elapsedFromMap(state.turnStartedAt, message.turnId),
      agentElapsedMs: elapsedFromMap(state.agentStartedAt, `${message.turnId}-${message.agentId}`)
    }, message.turnId);
    return;
  }

  if (message.type === 'user_turn_received' || message.type === 'user_audio_turn_final') {
    trace('server_message_received', {
      type: message.type,
      text: message.text,
      source: message.source
    }, 'turnId' in message ? message.turnId : undefined);
    return;
  }

  trace('server_message_received', { ...message });
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <section class="workspace">
        <header class="topbar">
          <div>
            <div class="eyebrow">Mesa de trabajo</div>
            <h1>Reunión en vivo</h1>
          </div>
          <div style="display: flex; align-items: center; gap: 14px;">
            <button class="btn-sumar" id="btnSumarColaborador" type="button">
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>Sumar al Equipo</span>
            </button>
            <div class="status ${state.connected ? 'is-on' : ''}">
              <span></span>${state.connected ? 'Conectado' : 'Reconectando'}
            </div>
          </div>
        </header>

        ${renderAlerts()}

        <section class="agents" aria-label="Colaboradores en la mesa">
          ${state.agents.map(renderAgent).join('')}
        </section>

        <section class="meeting">
          <div class="transcript" id="transcript" aria-live="polite">
            ${state.turns.map(renderTurn).join('')}
          </div>
          <aside class="protocol">
            <h2>Orquestacion</h2>
            ${renderRoute()}
            ${renderKeys()}
          </aside>
        </section>

        <section class="composer">
          <div class="speech">
            <button class="icon-button ${state.recording ? 'danger' : ''}" id="micButton" title="${state.recording ? 'Detener voz' : 'Iniciar voz'}" aria-label="${state.recording ? 'Detener voz' : 'Iniciar voz'}">
              ${state.recording ? pauseIcon() : micIcon()}
            </button>
            <div class="speech-copy">
              <strong>${state.recording ? 'Conversacion activa' : 'Audio Live'}</strong>
              <span>${state.activeAudioTranscript || state.voiceStatus || speechSupportText()}</span>
            </div>
          </div>
          <form id="turnForm" class="turn-form">
            <textarea id="turnInput" rows="2" placeholder="Di o escribe: revisemos una arquitectura con un modelo de optimizacion...">${escapeHtml(state.manualText)}</textarea>
            <button class="send-button" type="submit" ${state.connected ? '' : 'disabled'}>
              ${sendIcon()}<span>Enviar</span>
            </button>
          </form>
          ${renderAudioTuning()}
          <div class="controls">
            <button class="text-button" id="resetButton" type="button">Reiniciar reunion</button>
            <button class="text-button" id="healthButton" type="button">Estado de claves</button>
          </div>
        </section>
      </section>
    </main>

    <div class="dialog-overlay ${state.isSpawnOpen ? 'is-open' : ''}"></div>
    <div class="dialog-content">
      <div class="dialog-header">
        <h2>Sumar al Equipo</h2>
        <button class="dialog-close-btn" aria-label="Cerrar">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <form id="spawnForm" style="display: contents;">
        <div class="dialog-body">
          <div class="form-group">
            <label for="spawnName">Nombre</label>
            <input type="text" id="spawnName" class="form-control" placeholder="Ej. Carlos" required />
          </div>
          
          <div class="form-group">
            <label for="spawnTitle">Rol / Especialidad</label>
            <input type="text" id="spawnTitle" class="form-control" placeholder="Ej. Especialista en Seguridad" required />
          </div>
          
          <div class="form-group">
            <label>Color de Firma</label>
            <div class="color-picker-grid">
              ${[
                '#2f6f73', '#8a5a2b', '#b74e39', '#4a7c59', '#344e41', '#5c5470'
              ].map(color => `
                <button type="button" class="color-option ${state.selectedSpawnColor === color ? 'is-selected' : ''}" 
                  style="background: ${color};" data-color="${color}"></button>
              `).join('')}
            </div>
          </div>
          
          <div class="form-group">
            <label for="spawnDomains">Áreas de Dominio (separadas por coma)</label>
            <input type="text" id="spawnDomains" class="form-control" placeholder="Ej. seguridad, encriptacion, auditoria" required />
          </div>
          
          <div class="form-group">
            <label for="spawnVoice">Voz en Vivo</label>
            <select id="spawnVoice" class="form-control">
              <option value="Charon">Macho Maduro (Charon)</option>
              <option value="Aoede" selected>Hembra Melódica (Aoede)</option>
              <option value="Fenrir">Macho Profundo (Fenrir)</option>
              <option value="Puck">Hembra Alegre (Puck)</option>
              <option value="Kore">Hembra Suave (Kore)</option>
            </select>
          </div>
          
          <div class="form-group">
            <label for="spawnStyle">Estilo de Habla</label>
            <textarea id="spawnStyle" class="form-control" placeholder="Ej. Preciso, formal y enfocado en la mitigación de riesgos."></textarea>
          </div>

          <div class="form-group">
            <label for="spawnTasks">Tareas Iniciales (una por línea)</label>
            <textarea id="spawnTasks" class="form-control" placeholder="Ej. Validar cifrado en endpoints&#10;Revisar accesos de base de datos"></textarea>
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-secondary" id="btnCancelarSpawn">Cancelar</button>
          <button type="submit" class="btn-primary">Sumar al Equipo</button>
        </div>
      </form>
    </div>
  `;

  app.querySelector<HTMLFormElement>('#turnForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitTurn();
  });

  app.querySelector<HTMLTextAreaElement>('#turnInput')?.addEventListener('input', (event) => {
    state.manualText = (event.target as HTMLTextAreaElement).value;
    window.clearTimeout(inputTraceTimer);
    inputTraceTimer = window.setTimeout(() => {
      trace('manual_input_changed', {
        length: state.manualText.length,
        text: state.manualText
      });
    }, 450);
  });

  app.querySelector<HTMLButtonElement>('#micButton')?.addEventListener('click', toggleLiveAudio);
  app.querySelector<HTMLButtonElement>('#resetButton')?.addEventListener('click', () => {
    trace('reset_clicked');
    send({ type: 'reset' });
  });
  app.querySelector<HTMLButtonElement>('#healthButton')?.addEventListener('click', () => {
    trace('health_clicked');
    send({ type: 'health' });
  });
  app.querySelectorAll<HTMLInputElement>('[data-mic-setting]').forEach((input) => {
    input.addEventListener('input', () => {
      updateMicSetting(input.dataset.micSetting || '', Number(input.value));
    });
  });
  app.querySelectorAll<HTMLButtonElement>('[data-mic-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      applyMicPreset(button.dataset.micPreset || 'normal');
    });
  });

  // Eventos de Gestión de Tareas y Spawn
  app.querySelector('#btnSumarColaborador')?.addEventListener('click', () => {
    state.isSpawnOpen = true;
    app.querySelector('.dialog-overlay')?.classList.add('is-open');
  });

  app.querySelectorAll('.dialog-close-btn, #btnCancelarSpawn, .dialog-overlay').forEach(el => {
    el.addEventListener('click', () => {
      state.isSpawnOpen = false;
      app.querySelector('.dialog-overlay')?.classList.remove('is-open');
    });
  });

  app.querySelectorAll('.color-option').forEach(btn => {
    btn.addEventListener('click', () => {
      app.querySelectorAll('.color-option').forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      state.selectedSpawnColor = (btn as HTMLButtonElement).dataset.color || '#2f6f73';
    });
  });

  app.querySelector('#spawnForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const name = (form.querySelector('#spawnName') as HTMLInputElement).value.trim();
    const title = (form.querySelector('#spawnTitle') as HTMLInputElement).value.trim();
    const domainsStr = (form.querySelector('#spawnDomains') as HTMLInputElement).value.trim();
    const voice = (form.querySelector('#spawnVoice') as HTMLSelectElement).value;
    const style = (form.querySelector('#spawnStyle') as HTMLTextAreaElement).value.trim();
    const tasksStr = (form.querySelector('#spawnTasks') as HTMLTextAreaElement).value.trim();

    if (!name || !title) return;

    const initialTasks = tasksStr ? tasksStr.split('\n').map(t => t.trim()).filter(Boolean) : [];
    const domains = domainsStr ? domainsStr.split(',').map(d => d.trim()).filter(Boolean) : [];

    const agentPayload = {
      name,
      title,
      color: state.selectedSpawnColor,
      aliases: [name.toLowerCase()],
      domains,
      boundaries: [],
      style,
      voice,
      initialTasks
    };

    send({
      type: 'spawn_agent',
      agent: agentPayload
    });

    state.isSpawnOpen = false;
    app.querySelector('.dialog-overlay')?.classList.remove('is-open');
    form.reset();
  });

  app.querySelectorAll('.task-checkbox').forEach(input => {
    input.addEventListener('change', (event) => {
      const checkbox = event.target as HTMLInputElement;
      const agentId = checkbox.dataset.agentId;
      const taskId = checkbox.dataset.taskId;
      if (agentId && taskId) {
        send({
          type: 'toggle_task',
          agentId,
          taskId,
          completed: checkbox.checked
        });
      }
    });
  });

  app.querySelectorAll('.task-delete-btn').forEach(btn => {
    btn.addEventListener('click', (event) => {
      let target = event.target as HTMLElement;
      while (target && !target.dataset.taskId) {
        target = target.parentElement as HTMLElement;
      }
      if (target) {
        const agentId = target.dataset.agentId;
        const taskId = target.dataset.taskId;
        if (agentId && taskId) {
          send({
            type: 'delete_task',
            agentId,
            taskId
          });
        }
      }
    });
  });

  app.querySelectorAll('.task-add-form').forEach(form => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const formEl = event.target as HTMLFormElement;
      const agentId = formEl.dataset.agentId;
      const input = formEl.querySelector('.task-add-input') as HTMLInputElement;
      const text = input.value.trim();
      if (agentId && text) {
        send({
          type: 'add_task',
          agentId,
          text
        });
        input.value = '';
      }
    });
  });

  const transcript = app.querySelector<HTMLDivElement>('#transcript');
  if (transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function renderAgent(agent: Agent) {
  const speaking = state.speakingAgentId === agent.id;
  const tasks = agent.tasks || [];
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return `
    <article class="agent ${speaking ? 'is-speaking' : ''}" style="--agent-color: ${agent.color}">
      <div class="agent-main">
        <div class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</div>
        <div class="agent-body">
          <div class="agent-head">
            <h2>${escapeHtml(agent.name)}</h2>
            <span>${speaking ? 'Hablando' : escapeHtml(agent.title)}</span>
          </div>
          <p>${escapeHtml(agent.domains.slice(0, 5).join(' · '))}</p>
        </div>
      </div>
      
      <div class="agent-tasks-container">
        <div class="tasks-progress-wrapper">
          <span class="tasks-progress-label">Tareas: ${completed}/${total}</span>
          <div class="tasks-progress-bar">
            <div class="tasks-progress-fill" style="width: ${percentage}%"></div>
          </div>
        </div>
        <div class="tasks-list">
          ${tasks.length === 0 
            ? '<p class="muted" style="font-size: 0.8rem; font-style: italic; margin: 4px 0 8px;">Sin tareas asignadas.</p>' 
            : tasks.map(task => `
              <div class="task-item ${task.completed ? 'is-completed' : ''}">
                <div class="task-checkbox-wrapper">
                  <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} 
                    data-agent-id="${agent.id}" data-task-id="${task.id}" />
                </div>
                <span class="task-text">${escapeHtml(task.text)}</span>
                <button class="task-delete-btn" title="Eliminar tarea" data-agent-id="${agent.id}" data-task-id="${task.id}">
                  <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
              </div>
            `).join('')}
        </div>
        <form class="task-add-form" data-agent-id="${agent.id}">
          <input type="text" class="task-add-input" placeholder="Sumar tarea al colaborador..." required />
          <button class="task-add-btn" type="submit">Sumar</button>
        </form>
      </div>
    </article>
  `;
}

function renderAlerts() {
  if (!state.alerts.length) {
    return '';
  }

  return `
    <section class="alerts" aria-live="polite">
      ${state.alerts.map((alert) => `
        <div class="alert ${alert.tone}">
          <strong>${escapeHtml(alert.scope)}</strong>
          <span>${escapeHtml(alert.message)}</span>
        </div>
      `).join('')}
    </section>
  `;
}

function renderAudioTuning() {
  const settings = state.micSettings;
  const thresholds = micThresholds(settings);
  const levelRatio = Math.min(1, state.micMeter.level / 0.16);
  const gateRatio = Math.min(1, thresholds.startThreshold / 0.16);
  const activePreset = activeMicPreset(settings);

  return `
    <section class="audio-tuning" aria-label="Ajustes de micrófono">
      <div class="audio-tuning-head">
        <h2>Micrófono</h2>
        <span>${state.micMeter.speaking ? 'voz activa' : 'en espera'}</span>
      </div>
      <div class="mic-presets" role="group" aria-label="Perfil de micrófono">
        ${Object.keys(MIC_PRESETS).map((preset) => `
          <button class="${activePreset === preset ? 'is-active' : ''}" type="button" data-mic-preset="${preset}">
            ${presetLabel(preset)}
          </button>
        `).join('')}
      </div>
      <div class="meter" style="--level: ${Math.round(levelRatio * 100)}%; --gate: ${Math.round(gateRatio * 100)}%">
        <div></div>
        <span></span>
      </div>
      <div class="tuning-grid">
        ${renderRangeControl('Sensibilidad', 'sensitivity', settings.sensitivity, 10, 90, 1, `${settings.sensitivity}%`)}
        ${renderRangeControl('Cierre', 'endSilenceMs', settings.endSilenceMs, 360, 1400, 40, `${settings.endSilenceMs} ms`)}
        ${renderRangeControl('Mínimo voz', 'minSpeechMs', settings.minSpeechMs, 240, 1200, 40, `${settings.minSpeechMs} ms`)}
      </div>
    </section>
  `;
}

function renderRangeControl(label: string, setting: keyof MicSettings, value: number, min: number, max: number, step: number, display: string) {
  return `
    <label class="range-control">
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(display)}</small></span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-mic-setting="${setting}">
    </label>
  `;
}

function renderTurn(turn: TranscriptTurn) {
  const color = turn.agentId ? state.agents.find((agent) => agent.id === turn.agentId)?.color : undefined;
  return `
    <article class="turn ${turn.kind}" ${color ? `style="--agent-color: ${color}"` : ''}>
      <div class="speaker">${escapeHtml(turn.speaker)}</div>
      <p>${escapeHtml(turn.text || '...')}</p>
    </article>
  `;
}

function renderRoute() {
  if (!state.route) {
    return '<p class="muted">El proximo turno mostrara a quien se le asigno la palabra.</p>';
  }

  if (state.route.targets.length === 0) {
    return `<p class="muted">${escapeHtml(state.route.reason)}</p>`;
  }

  return `
    <div class="route-list">
      ${state.route.targets.map((target) => `
        <div class="route-item">
          <strong>${escapeHtml(target.name)}</strong>
          <span>${target.directMention ? 'mencion directa' : 'dominio detectado'}</span>
          <small>${escapeHtml(target.matchedDomains.join(', ') || 'sin etiquetas')}</small>
        </div>
      `).join('')}
    </div>
  `;
}

function renderKeys() {
  if (!state.keyStatus.length) {
    return `<div class="key-box"><strong>${state.liveMode ? 'Claves listas' : 'Sin claves Live'}</strong><span>${escapeHtml(state.model)}</span></div>`;
  }

  return `
    <div class="key-list">
      ${state.keyStatus.map((key) => `
        <div class="key-row ${key.available ? 'ok' : 'wait'}">
          <strong>${escapeHtml(key.id)}</strong>
          <span>${key.available ? 'disponible' : `${key.cooldownSeconds}s`}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function submitTurn() {
  const text = state.manualText.trim();
  if (!text) {
    trace('manual_submit_ignored_empty');
    return;
  }
  trace('manual_turn_submitted', { text, length: text.length });
  state.manualText = '';
  state.interimSpeech = '';
  send({ type: 'user_turn', text });
}

function updateMicSetting(setting: string, value: number) {
  if (!(setting in state.micSettings) || !Number.isFinite(value)) {
    return;
  }

  state.micSettings = {
    ...state.micSettings,
    [setting]: value
  };
  state.micMeter = {
    ...state.micMeter,
    startThreshold: micThresholds(state.micSettings).startThreshold
  };
  saveMicSettings(state.micSettings);
  trace('mic_settings_changed', {
    setting,
    value,
    settings: state.micSettings,
    thresholds: micThresholds(state.micSettings)
  });
  render();
}

function applyMicPreset(preset: string) {
  const next = MIC_PRESETS[preset] || MIC_PRESETS.normal;
  state.micSettings = sanitizeMicSettings(next);
  state.micMeter = {
    ...state.micMeter,
    startThreshold: micThresholds(state.micSettings).startThreshold
  };
  saveMicSettings(state.micSettings);
  trace('mic_preset_applied', {
    preset,
    settings: state.micSettings,
    thresholds: micThresholds(state.micSettings)
  });
  render();
}

function send(payload: unknown) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    traceOutgoingPayload(payload);
    state.socket.send(JSON.stringify(payload));
  }
}

function traceOutgoingPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    trace('client_ws_send', { rawType: typeof payload });
    return;
  }

  const message = payload as { type?: string; text?: string; transcriptHint?: string; mimeType?: string };
  if (message.type === 'audio_chunk') {
    return;
  }

  if (message.type === 'user_turn') {
    trace('client_ws_send', {
      type: message.type,
      text: message.text,
      length: message.text?.length || 0
    });
    return;
  }

  if (message.type === 'audio_end') {
    trace('client_ws_send', {
      type: message.type,
      hasTranscriptHint: Boolean(message.transcriptHint),
      transcriptHint: message.transcriptHint || ''
    });
    return;
  }

  trace('client_ws_send', { ...message });
}

function upsertAlert(id: string, scope: string, message: string, tone: StatusAlert['tone'], timeout?: number) {
  trace('ui_alert', { id, scope, message, tone });
  const existing = state.alerts.find((alert) => alert.id === id);
  if (existing?.timeout) {
    window.clearTimeout(existing.timeout);
  }

  if (existing) {
    existing.scope = scope;
    existing.message = message;
    existing.tone = tone;
    existing.timeout = undefined;
  } else {
    state.alerts.push({ id, scope, message, tone });
  }

  if (timeout) {
    const alert = state.alerts.find((item) => item.id === id);
    if (alert) {
      alert.timeout = window.setTimeout(() => {
        state.alerts = state.alerts.filter((item) => item.id !== id);
        render();
      }, timeout);
    }
  }
}

function resolveAlertIfPresent(id: string, scope: string, message: string) {
  if (!state.alerts.some((alert) => alert.id === id)) {
    return;
  }
  upsertAlert(id, scope, message, 'ok', 1400);
}

async function toggleLiveAudio() {
  if (state.recording) {
    trace('audio_toggle_clicked', { action: 'stop' });
    state.recording = false;
    state.microphone?.stop();
    state.microphone = null;
    state.browserSpeech?.stop();
    state.browserSpeech = null;
    state.clientSpeechText = '';
    state.voiceStatus = '';
    state.activeAudioTranscript = '';
    render();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    trace('audio_toggle_failed', { reason: 'mediaDevices unavailable' });
    upsertAlert('microphone', 'Micrófono', 'Este navegador no permite capturar audio.', 'error');
    render();
    return;
  }

  try {
    trace('audio_toggle_clicked', { action: 'start' });
    state.recording = true;
    state.voiceStatus = 'Preparando audio Live...';
    render();
    state.browserSpeech = new BrowserSpeechRecognizer((text) => {
      state.clientSpeechText = text;
      if (text) {
        state.activeAudioTranscript = text;
      }
      window.clearTimeout(speechTraceTimer);
      speechTraceTimer = window.setTimeout(() => {
        trace('client_speech_interim', {
          text,
          length: text.length
        });
      }, 300);
      render();
    });
    state.browserSpeech.start();
    state.microphone = new LiveMicrophoneStreamer(send, (label) => {
      state.voiceStatus = label;
      render();
    }, (meter) => {
      state.micMeter = meter;
      window.clearTimeout(micMeterRenderTimer);
      micMeterRenderTimer = window.setTimeout(() => {
        scheduleRender();
      }, 80);
    });
    await state.microphone.start();
  } catch (error) {
    state.recording = false;
    state.microphone = null;
    state.browserSpeech?.stop();
    state.browserSpeech = null;
    state.clientSpeechText = '';
    state.voiceStatus = '';
    trace('microphone_start_failed', { error: getClientError(error) });
    upsertAlert('microphone', 'Micrófono', `No pude iniciar audio: ${getClientError(error)}`, 'error');
    render();
  }
}

function appendAgentText(turnId: string, agentId: string, delta: string) {
  const id = `${turnId}-${agentId}`;
  const turn = state.turns.find((item) => item.id === id);
  if (turn) {
    turn.text = `${turn.text}${delta}`;
  }
}

function setAgentText(turnId: string, agentId: string, text: string) {
  const id = `${turnId}-${agentId}`;
  const turn = state.turns.find((item) => item.id === id);
  if (turn) {
    turn.text = text;
  }
}

function removeAgentTurn(turnId: string, agentId: string) {
  const id = `${turnId}-${agentId}`;
  state.turns = state.turns.filter((turn) => turn.id !== id);
}

function agentName(agentId: string) {
  return state.agents.find((agent) => agent.id === agentId)?.name || agentId;
}

function elapsedFromMap(map: Map<string, number>, key: string) {
  const startedAt = map.get(key);
  return startedAt ? Math.round(performance.now() - startedAt) : null;
}

function speechSupportText() {
  return 'Pulsa para hablar; cada pausa envia audio directo a Gemini Live.';
}

function setVoiceStatus(message: string, timeoutMs = 0) {
  window.clearTimeout(voiceStatusTimer);
  state.voiceStatus = message;

  if (timeoutMs > 0) {
    voiceStatusTimer = window.setTimeout(() => {
      state.voiceStatus = state.recording ? 'Audio Live conectado.' : '';
      render();
    }, timeoutMs);
  }
}

function micThresholds(settings: MicSettings) {
  const sensitivity = clamp(settings.sensitivity, 10, 90);
  const startThreshold = 0.062 - (sensitivity / 100) * 0.052;
  return {
    startThreshold,
    continueThreshold: startThreshold * 0.55
  };
}

function loadMicSettings(): MicSettings {
  try {
    const raw = window.localStorage.getItem(MIC_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_MIC_SETTINGS };
    }
    return sanitizeMicSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MIC_SETTINGS };
  }
}

function saveMicSettings(settings: MicSettings) {
  try {
    window.localStorage.setItem(MIC_SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeMicSettings(settings)));
  } catch {
    // La configuracion de audio sigue funcionando aunque el navegador no persista localStorage.
  }
}

function sanitizeMicSettings(settings: Partial<MicSettings>): MicSettings {
  return {
    sensitivity: Math.round(clamp(Number(settings.sensitivity ?? DEFAULT_MIC_SETTINGS.sensitivity), 10, 90)),
    endSilenceMs: snapToStep(clamp(Number(settings.endSilenceMs ?? DEFAULT_MIC_SETTINGS.endSilenceMs), 360, 1400), 360, 40),
    minSpeechMs: snapToStep(clamp(Number(settings.minSpeechMs ?? DEFAULT_MIC_SETTINGS.minSpeechMs), 240, 1200), 240, 40)
  };
}

function activeMicPreset(settings: MicSettings) {
  const current = JSON.stringify(sanitizeMicSettings(settings));
  return Object.entries(MIC_PRESETS)
    .find(([, preset]) => JSON.stringify(sanitizeMicSettings(preset)) === current)?.[0] || '';
}

function presetLabel(preset: string) {
  const labels: Record<string, string> = {
    ruido: 'Ruido',
    normal: 'Normal',
    suave: 'Suave'
  };
  return labels[preset] || preset;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function snapToStep(value: number, min: number, step: number) {
  return min + Math.round((value - min) / step) * step;
}

function parseRate(mimeType: string) {
  const match = /rate=(\d+)/.exec(mimeType || '');
  return match ? Number(match[1]) : 24000;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function base64ToBytes(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64FromArrayBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function getClientError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function audioWorkletCode() {
  return `
    class PcmCaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buffer = [];
        this.targetRate = 16000;
      }

      process(inputs) {
        const input = inputs[0] && inputs[0][0];
        if (!input) return true;

        for (let i = 0; i < input.length; i += 1) {
          this.buffer.push(input[i]);
        }

        const sourceRate = sampleRate;
        const frameSize = Math.max(128, Math.round(sourceRate * 0.06));
        while (this.buffer.length >= frameSize) {
          const frame = this.buffer.splice(0, frameSize);
          const pcm = this.downsample(frame, sourceRate, this.targetRate);
          let sum = 0;
          for (let i = 0; i < pcm.length; i += 1) {
            const value = pcm[i] / 32768;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / Math.max(1, pcm.length));
          this.port.postMessage(
            { pcm: pcm.buffer, rms, durationMs: (pcm.length / this.targetRate) * 1000 },
            [pcm.buffer]
          );
        }
        return true;
      }

      downsample(samples, sourceRate, targetRate) {
        if (sourceRate === targetRate) {
          return this.floatTo16Bit(samples);
        }

        const ratio = sourceRate / targetRate;
        const outputLength = Math.floor(samples.length / ratio);
        const output = new Int16Array(outputLength);
        for (let i = 0; i < outputLength; i += 1) {
          const start = Math.floor(i * ratio);
          const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
          let total = 0;
          for (let j = start; j < end; j += 1) total += samples[j];
          const averaged = total / Math.max(1, end - start);
          output[i] = this.clampTo16Bit(averaged);
        }
        return output;
      }

      floatTo16Bit(samples) {
        const output = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) output[i] = this.clampTo16Bit(samples[i]);
        return output;
      }

      clampTo16Bit(sample) {
        const clamped = Math.max(-1, Math.min(1, sample));
        return clamped < 0 ? clamped * 32768 : clamped * 32767;
      }
    }

    registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
  `;
}

function micIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm7-4a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11Z"/></svg>`;
}

function pauseIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Zm8 0a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Z"/></svg>`;
}

function sendIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 20.3 22 12 3.7 3.7 3 10.2l10 1.8-10 1.8.7 6.5Z"/></svg>`;
}
