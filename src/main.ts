import './styles.css';

import { parseServerMessage } from '../shared/protocol.ts';
import type {
  AgentTask as Task,
  KeyStatus,
  MeetingScenario,
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
const MEETING_ID_STORAGE_KEY = 'reunion.meetingId.v1';
const ASR_LOCALE_STORAGE_KEY = 'reunion.asrLocale.v1';
const ASR_LOCALES = ['es-ES', 'es-AR', 'es-MX', 'en-US'];

function loadAsrLocale(): string {
  try {
    const stored = window.localStorage.getItem(ASR_LOCALE_STORAGE_KEY);
    return stored && ASR_LOCALES.includes(stored) ? stored : 'es-ES';
  } catch {
    return 'es-ES';
  }
}

function saveAsrLocale(locale: string) {
  if (!ASR_LOCALES.includes(locale)) return;
  try {
    window.localStorage.setItem(ASR_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Sin persistencia; el valor vive en la sesión.
  }
  trace('asr_locale_changed', { locale });
}

function loadStoredMeetingId(): string | undefined {
  try {
    return window.localStorage.getItem(MEETING_ID_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function saveStoredMeetingId(meetingId: string) {
  try {
    window.localStorage.setItem(MEETING_ID_STORAGE_KEY, meetingId);
  } catch {
    // localStorage puede fallar en modo privado; la reunión sigue en memoria.
  }
}
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
  return '';
}

// Cola de reproducción PCM con contexto PERSISTENTE (nunca se cierra entre
// turnos), GainNode maestro para el ducking del barge-in, tracking de
// sources vivos para poder cortarlos en seco y callback onDrained para
// avisar playback_complete al servidor.
class PcmAudioQueue {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private nextStart = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  onDrained: (() => void) | null = null;

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
    source.connect(this.masterGain as GainNode);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.onDrained?.();
      }
    };
    const startAt = Math.max(context.currentTime + 0.02, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
  }

  get isPlaying() {
    return this.activeSources.size > 0;
  }

  // Corta TODO el audio pendiente sin cerrar el contexto (barge-in).
  flush() {
    for (const source of this.activeSources) {
      source.onended = null;
      try { source.stop(); } catch { /* ya detenido */ }
    }
    this.activeSources.clear();
    if (this.context) {
      this.nextStart = this.context.currentTime;
    }
  }

  duck() {
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(0.2, this.context.currentTime, 0.03);
    }
  }

  restoreGain() {
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(1, this.context.currentTime, 0.05);
    }
  }

  stop() {
    this.flush();
    void this.context?.suspend();
  }

  private ensureContext() {
    if (this.context && this.context.state !== 'closed') {
      return this.context;
    }
    this.context = new AudioContext({ sampleRate: 24000 });
    this.masterGain = this.context.createGain();
    this.masterGain.connect(this.context.destination);
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
  private bargeMs = 0;

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

    // Barge-in: mientras un agente habla, el micro sigue vivo. Al detectar
    // voz se baja el volumen del agente (duck, latencia cero) y si la voz
    // se sostiene ≥250 ms por encima de 1.4× el umbral, se interrumpe.
    if (!this.speaking && (state.audio.isPlaying || state.audioSegment)) {
      if (chunk.rms >= startThreshold) {
        state.audio.duck();
        if (chunk.rms >= startThreshold * 1.4) {
          this.bargeMs += chunk.durationMs;
        }
        if (this.bargeMs < 250) {
          this.preBuffer.push(payload);
          this.preBuffer = this.preBuffer.slice(-4);
          return;
        }
        // Confirmado: cortar al agente y dejar que el flujo normal de
        // inicio de habla procese este mismo chunk.
        this.bargeMs = 0;
        this.sendMessage({
          type: 'interrupt',
          reason: 'barge_in',
          turnId: state.audioSegment?.turnId,
          agentId: state.audioSegment?.agentId
        });
        state.audio.flush();
        state.audio.restoreGain();
        trace('barge_in_confirmed', { agentId: state.audioSegment?.agentId || null });
      } else if (this.bargeMs > 0) {
        // Falso positivo: restaurar volumen y seguir escuchando al agente.
        this.bargeMs = 0;
        state.audio.restoreGain();
      }
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
            markDirty('voice');
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
    this.recognition.lang = loadAsrLocale();
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

const initialMicSettings = loadMicSettings();

const state = {
  sessionId: '',
  meetingId: '',
  scenario: null as MeetingScenario | null,
  socket: null as WebSocket | null,
  agents: [] as Agent[],
  model: '',
  connected: false,
  liveMode: false,
  recording: false,
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
  micSettings: initialMicSettings,
  micMeter: { level: 0, startThreshold: micThresholds(initialMicSettings).startThreshold, speaking: false } as MicMeter,
  turnStartedAt: new Map<string, number>(),
  agentStartedAt: new Map<string, number>(),
  audio: new PcmAudioQueue(),
  audioSegment: null as { turnId: string; agentId: string; endReceived: boolean } | null,
  editingAgentId: null as string | null,
  selectedSpawnColor: '#2f6f73'
};

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('No se encontro #app.');
}
const app: HTMLDivElement = root;

// Reconexión con backoff exponencial + jitter. El socket previo se cierra
// antes de abrir otro; al reconectar se re-arma el micrófono si estaba
// activo y se reenvía hello (que reanuda la reunión persistida).
let reconnectAttempts = 0;
let reconnectTimer = 0;
let connecting = false;

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(15000, 500 * Math.pow(1.8, reconnectAttempts));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  const delay = Math.round(base + jitter);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, delay);
}

function connect() {
  if (connecting) return;
  connecting = true;

  if (state.socket) {
    const old = state.socket;
    state.socket = null;
    old.onopen = old.onclose = old.onmessage = old.onerror = null;
    try { old.close(); } catch { /* ya cerrado */ }
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/meeting`);

  socket.addEventListener('open', () => {
    connecting = false;
    reconnectAttempts = 0;
    state.connected = true;
    trace('socket_open');
    // hello inicializa la reunión: reanuda la guardada o crea una nueva.
    socket.send(JSON.stringify({ type: 'hello', meetingId: loadStoredMeetingId() }));
    if (state.recording) {
      // El servidor es nuevo: re-preparar el transcriptor y el ASR local.
      socket.send(JSON.stringify({ type: 'audio_prepare' }));
      state.browserSpeech?.start();
    }
    markDirty('connection', 'voice');
  });

  socket.addEventListener('close', () => {
    connecting = false;
    state.connected = false;
    state.speakingAgentId = '';
    trace('socket_close');
    markDirty('connection', 'agents', 'voice');
    scheduleReconnect();
  });

  socket.addEventListener('message', async (event) => {
    const message = parseServerMessage(event.data);
    if (!message) {
      trace('server_message_invalid', { raw: String(event.data).slice(0, 200) });
      return;
    }
    traceIncomingMessage(message);
    await handleServerMessage(message);
  });

  state.socket = socket;
}

async function handleServerMessage(message: MeetingMessage) {
  switch (message.type) {
    case 'agents_updated':
      state.agents = message.agents;
      markDirty('agents');
      break;

    case 'meeting_ready': {
      state.sessionId = message.id;
      state.meetingId = message.meetingId;
      state.scenario = message.scenario;
      state.agents = message.agents;
      state.model = message.model;
      state.liveMode = message.liveMode;
      saveStoredMeetingId(message.meetingId);
      trace('meeting_ready', {
        model: message.model,
        liveMode: message.liveMode,
        meetingId: message.meetingId,
        resumed: message.resumed,
        agents: message.agents.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }))
      });
      if (message.resumed && message.turns.length > 0) {
        state.turns = message.turns.map((turn) => ({
          id: turn.id,
          kind: turn.kind,
          speaker: turn.speaker,
          agentId: turn.agentId || undefined,
          text: turn.text
        }));
        transcriptReset();
      }
      const statusText = message.resumed
        ? 'Reunión retomada: se restauró la conversación, los agentes y las tareas.'
        : message.liveMode
          ? 'Reunión nueva en modo Live. Los agentes responden con Gemini en el backend.'
          : 'Reunión nueva en modo simulación. Configura .env con tus claves Gemini para activar Live API.';
      upsertAlert('meeting-status', 'Reunión', statusText, 'ok', 4000);
      markDirty('agents', 'scenario', 'keys', 'voice', 'route');
      break;
    }

    case 'scenario_updated':
      state.scenario = message.scenario;
      markDirty('scenario');
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
      transcriptReset();
      markDirty('route', 'voice');
      break;

    case 'user_turn_received': {
      state.turnStartedAt.set(message.turnId, performance.now());
      const turn: TranscriptTurn = {
        id: message.turnId,
        kind: message.source === 'system' ? 'system' : 'user',
        speaker: message.source === 'system' ? 'Sistema' : 'Tu',
        text: message.text
      };
      state.turns.push(turn);
      transcriptAppend(turn);
      state.voiceStatus = message.source === 'audio' ? 'Orquestando respuesta...' : state.voiceStatus;
      markDirty('voice');
      break;
    }

    case 'route_decision':
      state.route = message.route;
      if (message.route.targets.length === 0) {
        setVoiceStatus(state.recording ? 'Sin respuesta necesaria.' : '', 1200);
      }
      markDirty('route');
      break;

    case 'no_agent_response':
      setVoiceStatus(state.recording ? 'Audio Live conectado.' : '', 0);
      break;

    case 'agent_turn_start': {
      state.speakingAgentId = message.agentId;
      state.voiceStatus = '';
      state.agentStartedAt.set(`${message.turnId}-${message.agentId}`, performance.now());
      const turn: TranscriptTurn = {
        id: `${message.turnId}-${message.agentId}`,
        kind: 'agent',
        speaker: agentName(message.agentId),
        agentId: message.agentId,
        text: ''
      };
      state.turns.push(turn);
      transcriptAppend(turn);
      markDirty('agents', 'voice');
      break;
    }

    case 'agent_transcript_delta':
      appendAgentText(message.turnId, message.agentId, message.delta);
      break;

    case 'agent_audio_chunk':
      await state.audio.enqueueBase64Pcm(message.data, parseRate(message.mimeType || ''));
      break;

    case 'agent_audio_start':
      state.audioSegment = { turnId: message.turnId, agentId: message.agentId, endReceived: false };
      state.speakingAgentId = message.agentId;
      state.audio.onDrained = () => {
        const segment = state.audioSegment;
        if (segment?.endReceived) {
          send({ type: 'playback_complete', turnId: segment.turnId, agentId: segment.agentId });
          state.audioSegment = null;
          if (state.speakingAgentId === segment.agentId) {
            state.speakingAgentId = '';
          }
          markDirty('agents');
        }
      };
      markDirty('agents');
      break;

    case 'agent_audio_end':
      if (state.audioSegment?.turnId === message.turnId && state.audioSegment?.agentId === message.agentId) {
        state.audioSegment.endReceived = true;
        if (!state.audio.isPlaying) {
          send({ type: 'playback_complete', turnId: message.turnId, agentId: message.agentId });
          state.audioSegment = null;
          if (state.speakingAgentId === message.agentId) {
            state.speakingAgentId = '';
          }
          markDirty('agents');
        }
      }
      break;

    case 'agent_interrupted': {
      state.audio.flush();
      state.audio.restoreGain();
      if (message.turnId && message.agentId) {
        const id = `${message.turnId}-${message.agentId}`;
        const turn = state.turns.find((item) => item.id === id);
        if (turn && turn.text) {
          turn.text += ' …(interrumpido)';
          transcriptSetText(id, turn.text);
        }
      }
      state.audioSegment = null;
      state.speakingAgentId = '';
      markDirty('agents', 'voice');
      break;
    }

    case 'turn_cancelled':
      state.turns = state.turns.filter((turn) => {
        const stale = turn.kind === 'agent' && turn.id.startsWith(`${message.turnId}-`) && !turn.text;
        if (stale) {
          transcriptRemove(turn.id);
        }
        return !stale;
      });
      break;

    case 'agent_state':
      if (message.state === 'speaking' || message.state === 'thinking') {
        state.speakingAgentId = message.agentId;
      } else if (state.speakingAgentId === message.agentId && !state.audioSegment) {
        state.speakingAgentId = '';
      }
      markDirty('agents');
      break;

    case 'live_session_status':
      trace('live_session_status', { agentId: message.agentId, status: message.status });
      if (message.status === 'fallback') {
        upsertAlert(`live-${message.agentId}`, agentName(message.agentId), 'Sesión Live no disponible; usando streaming con TTS.', 'working', 3200);
      }
      break;

    case 'agent_turn_complete':
      if (!state.audioSegment || state.audioSegment.agentId !== message.agentId) {
        state.speakingAgentId = '';
      }
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
      markDirty('agents', 'keys');
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
      markDirty('voice');
      break;

    case 'user_audio_transcript_delta':
      state.activeAudioTranscript = message.text;
      markDirty('voice');
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
      markDirty('voice');
      break;

    case 'audio_transcription_status':
      state.voiceStatus = message.message;
      markDirty('voice');
      break;

    case 'audio_transcription_empty':
      state.voiceStatus = '';
      upsertAlert('audio-empty', 'Audio', message.message, 'error', 2600);
      markDirty('voice');
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
      markDirty('keys');
      break;

    case 'error': {
      const turn: TranscriptTurn = {
        id: crypto.randomUUID(),
        kind: 'system',
        speaker: 'Error',
        text: `${message.message} ${message.detail || ''}`.trim()
      };
      state.turns.push(turn);
      transcriptAppend(turn);
      break;
    }
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

// ── Render por regiones ─────────────────────────────────────────────────
// El shell se monta UNA vez; cada región se repinta solo cuando su dato
// cambió. El transcript es append-only con nodos vivos (los deltas de
// streaming mutan un text node, nunca innerHTML). Los inputs (composer,
// drawer, tareas) son estáticos: el foco y lo tipeado sobreviven a
// cualquier mensaje del servidor.

type Region =
  | 'connection'
  | 'alerts'
  | 'agents'
  | 'route'
  | 'keys'
  | 'voice'
  | 'micTuning'
  | 'micMeter'
  | 'scenario';

const dirtyRegions = new Set<Region>();

function markDirty(...regions: Region[]) {
  for (const region of regions) {
    dirtyRegions.add(region);
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(flushRender);
}

// Compat con los caminos que antes re-renderizaban toda la app.
function render() {
  markDirty('connection', 'alerts', 'agents', 'route', 'keys', 'voice', 'micTuning', 'micMeter', 'scenario');
}

function flushRender() {
  renderQueued = false;
  const regions = [...dirtyRegions];
  dirtyRegions.clear();
  for (const region of regions) {
    REGION_RENDERERS[region]();
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Falta el nodo #${id} del shell.`);
  }
  return el as T;
}

const REGION_RENDERERS: Record<Region, () => void> = {
  connection() {
    const el = byId<HTMLDivElement>('connectionStatus');
    el.className = `status ${state.connected ? 'is-on' : ''}`;
    el.innerHTML = `<span></span>${state.connected ? 'Conectado' : 'Reconectando'}`;
  },
  alerts() {
    byId('alerts').innerHTML = renderAlerts();
  },
  agents() {
    byId('agents').innerHTML = state.agents.map(renderAgent).join('');
  },
  route() {
    byId('routePanel').innerHTML = renderRoute();
  },
  keys() {
    byId('keysPanel').innerHTML = renderKeys();
  },
  voice() {
    const mic = byId<HTMLButtonElement>('micButton');
    mic.className = `icon-button ${state.recording ? 'danger' : ''}`;
    mic.title = state.recording ? 'Detener voz' : 'Iniciar voz';
    mic.setAttribute('aria-label', mic.title);
    mic.innerHTML = state.recording ? pauseIcon() : micIcon();
    byId('speechTitle').textContent = state.recording ? 'Conversacion activa' : 'Audio Live';
    byId('speechStatus').textContent = state.activeAudioTranscript || state.voiceStatus || speechSupportText();
    byId<HTMLButtonElement>('sendButton').disabled = !state.connected;
  },
  micTuning() {
    byId('micTuning').innerHTML = renderAudioTuning();
  },
  micMeter() {
    const meter = document.querySelector<HTMLElement>('#micTuning .meter');
    if (!meter) return;
    const thresholds = micThresholds(state.micSettings);
    meter.style.setProperty('--level', `${Math.round(Math.min(1, state.micMeter.level / 0.16) * 100)}%`);
    meter.style.setProperty('--gate', `${Math.round(Math.min(1, thresholds.startThreshold / 0.16) * 100)}%`);
    const headLabel = document.querySelector<HTMLElement>('#micTuning .audio-tuning-head span');
    if (headLabel) {
      headLabel.textContent = state.micMeter.speaking ? 'voz activa' : 'en espera';
    }
  },
  scenario() {
    byId('scenarioName').textContent = state.scenario?.name || 'Reunión en vivo';
    const input = byId<HTMLInputElement>('scenarioInput');
    if (document.activeElement !== input) {
      input.value = state.scenario?.text || '';
    }
  }
};

// ── Transcript append-only ──────────────────────────────────────────────

const transcriptNodes = new Map<string, { article: HTMLElement; text: HTMLParagraphElement }>();

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function transcriptAppend(turn: TranscriptTurn) {
  const container = byId<HTMLDivElement>('transcript');
  const stick = isNearBottom(container);
  const article = document.createElement('article');
  article.className = `turn ${turn.kind}`;
  const color = turn.agentId ? state.agents.find((agent) => agent.id === turn.agentId)?.color : undefined;
  if (color) {
    article.style.setProperty('--agent-color', color);
  }
  const speaker = document.createElement('div');
  speaker.className = 'speaker';
  speaker.textContent = turn.speaker;
  const text = document.createElement('p');
  text.textContent = turn.text || '...';
  article.append(speaker, text);
  container.append(article);
  transcriptNodes.set(turn.id, { article, text });
  if (stick) {
    container.scrollTop = container.scrollHeight;
  }
}

function transcriptSetText(id: string, value: string) {
  const node = transcriptNodes.get(id);
  if (!node) return;
  const container = byId<HTMLDivElement>('transcript');
  const stick = isNearBottom(container);
  node.text.textContent = value || '...';
  if (stick) {
    container.scrollTop = container.scrollHeight;
  }
}

function transcriptRemove(id: string) {
  transcriptNodes.get(id)?.article.remove();
  transcriptNodes.delete(id);
}

// Reconstruye el DOM del transcript desde state.turns (reset / resume).
function transcriptReset() {
  transcriptNodes.clear();
  byId<HTMLDivElement>('transcript').innerHTML = '';
  for (const turn of state.turns) {
    transcriptAppend(turn);
  }
}

// ── Shell estático + delegación de eventos ──────────────────────────────

function mountShell() {
  app.innerHTML = `
    <main class="shell">
      <section class="workspace">
        <header class="topbar">
          <div>
            <div class="eyebrow">Mesa de trabajo</div>
            <h1 id="scenarioName">Reunión en vivo</h1>
          </div>
          <div style="display: flex; align-items: center; gap: 14px;">
            <button class="text-button" data-action="open-meetings" type="button">Reuniones</button>
            <button class="btn-sumar" data-action="open-spawn" type="button">
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>Sumar al Equipo</span>
            </button>
            <div class="status" id="connectionStatus"><span></span>Reconectando</div>
          </div>
        </header>

        <form id="scenarioForm" class="scenario-bar">
          <label for="scenarioInput">Contexto</label>
          <input type="text" id="scenarioInput" placeholder="Objetivo o contexto de esta reunión..." />
          <button class="text-button" type="submit">Guardar</button>
        </form>

        <div id="alerts"></div>

        <section class="agents" id="agents" aria-label="Colaboradores en la mesa"></section>

        <section class="meeting">
          <div class="transcript" id="transcript" aria-live="polite"></div>
          <aside class="protocol">
            <h2>Orquestacion</h2>
            <div id="routePanel"></div>
            <div id="keysPanel"></div>
          </aside>
        </section>

        <section class="composer">
          <div class="speech">
            <button class="icon-button" id="micButton" data-action="toggle-mic" type="button" title="Iniciar voz" aria-label="Iniciar voz">${micIcon()}</button>
            <div class="speech-copy">
              <strong id="speechTitle">Audio Live</strong>
              <span id="speechStatus">${escapeHtml(speechSupportText())}</span>
            </div>
          </div>
          <form id="turnForm" class="turn-form">
            <textarea id="turnInput" rows="2" placeholder="Di o escribe: revisemos una arquitectura con un modelo de optimizacion..."></textarea>
            <button class="send-button" id="sendButton" type="submit" disabled>
              ${sendIcon()}<span>Enviar</span>
            </button>
          </form>
          <div id="micTuning"></div>
          <div class="controls">
            <button class="text-button" data-action="reset" type="button">Reiniciar reunion</button>
            <button class="text-button" data-action="health" type="button">Estado de claves</button>
          </div>
        </section>
      </section>
    </main>

    <div class="dialog-overlay" id="spawnOverlay" data-action="close-spawn"></div>
    <div class="dialog-content" id="spawnDialog">
      <div class="dialog-header">
        <h2 id="spawnDialogTitle">Sumar al Equipo</h2>
        <button class="dialog-close-btn" data-action="close-spawn" type="button" aria-label="Cerrar">
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
            <div class="color-picker-grid" id="spawnColors">
              ${['#2f6f73', '#8a5a2b', '#b74e39', '#4a7c59', '#344e41', '#5c5470'].map((color) => `
                <button type="button" class="color-option" data-action="select-color" style="background: ${color};" data-color="${color}"></button>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label for="spawnDomains">Áreas de Dominio (separadas por coma)</label>
            <input type="text" id="spawnDomains" class="form-control" placeholder="Ej. seguridad, encriptacion, auditoria" />
          </div>
          <div class="form-group">
            <label for="spawnAliases">Alias para el ruteo (separados por coma)</label>
            <input type="text" id="spawnAliases" class="form-control" placeholder="Ej. carlos, seguridad, seba" />
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
            <label for="spawnBoundaries">Límites (uno por línea)</label>
            <textarea id="spawnBoundaries" class="form-control" placeholder="Ej. No decide precios sin validar con el equipo"></textarea>
          </div>
          <div class="form-group" id="spawnTasksGroup">
            <label for="spawnTasks">Tareas Iniciales (una por línea)</label>
            <textarea id="spawnTasks" class="form-control" placeholder="Ej. Validar cifrado en endpoints&#10;Revisar accesos de base de datos"></textarea>
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-secondary" data-action="close-spawn">Cancelar</button>
          <button type="submit" class="btn-primary" id="spawnSubmitLabel">Sumar al Equipo</button>
        </div>
      </form>
    </div>

    <div class="dialog-overlay" id="meetingsOverlay" data-action="close-meetings"></div>
    <div class="dialog-content" id="meetingsDialog">
      <div class="dialog-header">
        <h2>Reuniones</h2>
        <button class="dialog-close-btn" data-action="close-meetings" type="button" aria-label="Cerrar">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="dialog-body" id="meetingsList">
        <p class="muted">Cargando reuniones...</p>
      </div>
    </div>

    <div class="dialog-overlay" id="memoryOverlay" data-action="close-memory"></div>
    <div class="dialog-content" id="memoryDialog">
      <div class="dialog-header">
        <h2 id="memoryDialogTitle">Memoria</h2>
        <button class="dialog-close-btn" data-action="close-memory" type="button" aria-label="Cerrar">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="dialog-body" id="memoryBody">
        <p class="muted">Cargando memoria...</p>
      </div>
    </div>
  `;

  const turnInput = byId<HTMLTextAreaElement>('turnInput');
  turnInput.addEventListener('input', () => {
    state.manualText = turnInput.value;
    window.clearTimeout(inputTraceTimer);
    inputTraceTimer = window.setTimeout(() => {
      trace('manual_input_changed', { length: state.manualText.length, text: state.manualText });
    }, 450);
  });
  turnInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitTurn();
    }
  });

  // Delegación: un listener por tipo de evento sobre contenedores estables.
  document.addEventListener('click', handleDelegatedClick);
  document.addEventListener('submit', handleDelegatedSubmit);
  document.addEventListener('change', handleDelegatedChange);
  document.addEventListener('input', handleDelegatedInput);
}

function handleDelegatedClick(event: Event) {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'toggle-mic':
      void toggleLiveAudio();
      break;
    case 'reset':
      trace('reset_clicked');
      send({ type: 'reset' });
      break;
    case 'health':
      trace('health_clicked');
      send({ type: 'health' });
      break;
    case 'open-spawn':
      openAgentDialog(null);
      break;
    case 'close-spawn':
      closeAgentDialog();
      break;
    case 'select-color': {
      document.querySelectorAll('#spawnColors .color-option').forEach((el) => el.classList.remove('is-selected'));
      target.classList.add('is-selected');
      state.selectedSpawnColor = target.dataset.color || '#2f6f73';
      break;
    }
    case 'edit-agent':
      openAgentDialog(target.dataset.agentId || null);
      break;
    case 'archive-agent':
      if (target.dataset.agentId && window.confirm('¿Archivar este agente? Sale de la mesa (su historial se conserva).')) {
        send({ type: 'archive_agent', agentId: target.dataset.agentId });
      }
      break;
    case 'toggle-agent-enabled': {
      const agent = state.agents.find((item) => item.id === target.dataset.agentId);
      if (agent) {
        send({ type: 'set_agent_enabled', agentId: agent.id, enabled: agent.enabled === false });
      }
      break;
    }
    case 'delete-task': {
      const agentId = target.dataset.agentId;
      const taskId = target.dataset.taskId;
      if (agentId && taskId) {
        send({ type: 'delete_task', agentId, taskId });
      }
      break;
    }
    case 'open-meetings':
      void openMeetingsDrawer();
      break;
    case 'close-meetings':
      byId('meetingsOverlay').classList.remove('is-open');
      break;
    case 'open-memory':
      if (target.dataset.agentId) {
        void openMemoryDrawer(target.dataset.agentId);
      }
      break;
    case 'close-memory':
      byId('memoryOverlay').classList.remove('is-open');
      break;
    case 'memory-edit': {
      const learningId = target.dataset.learningId;
      const current = target.dataset.content || '';
      const next = window.prompt('Editar aprendizaje:', current);
      if (learningId && next && next.trim() && next !== current) {
        void memoryAction(`/api/learnings/${learningId}`, 'PATCH', { content: next.trim() }, target.dataset.agentId || '');
      }
      break;
    }
    case 'memory-delete':
      if (target.dataset.learningId) {
        void memoryAction(`/api/learnings/${target.dataset.learningId}`, 'PATCH', { status: 'user_deleted' }, target.dataset.agentId || '');
      }
      break;
    case 'memory-forget-all':
      if (target.dataset.agentId && window.confirm('¿Olvidar TODO lo aprendido por este agente? (queda registrado en el changelog)')) {
        void memoryAction(`/api/agents/${target.dataset.agentId}/forget`, 'POST', {}, target.dataset.agentId);
      }
      break;
    case 'memory-toggle-learning':
      if (target.dataset.agentId) {
        void memoryAction(
          `/api/agents/${target.dataset.agentId}/learning-enabled`,
          'POST',
          { enabled: target.dataset.enabled !== 'true' },
          target.dataset.agentId
        );
      }
      break;
    case 'suggestion-apply':
      if (target.dataset.suggestionId) {
        void memoryAction(`/api/suggestions/${target.dataset.suggestionId}/apply`, 'POST', {}, target.dataset.agentId || '');
      }
      break;
    case 'suggestion-reject':
      if (target.dataset.suggestionId) {
        void memoryAction(`/api/suggestions/${target.dataset.suggestionId}/reject`, 'POST', {}, target.dataset.agentId || '');
      }
      break;
    case 'resume-meeting': {
      const meetingId = target.dataset.meetingId;
      if (meetingId) {
        saveStoredMeetingId(meetingId);
        byId('meetingsOverlay').classList.remove('is-open');
        state.turns = [];
        transcriptReset();
        state.socket?.close();
      }
      break;
    }
  }
}

function handleDelegatedSubmit(event: Event) {
  const form = event.target as HTMLFormElement;

  if (form.id === 'turnForm') {
    event.preventDefault();
    submitTurn();
    return;
  }

  if (form.id === 'scenarioForm') {
    event.preventDefault();
    const text = byId<HTMLInputElement>('scenarioInput').value.trim();
    send({ type: 'set_scenario', text });
    return;
  }

  if (form.id === 'spawnForm') {
    event.preventDefault();
    submitAgentDialog();
    return;
  }

  if (form.classList.contains('task-add-form')) {
    event.preventDefault();
    const agentId = form.dataset.agentId;
    const input = form.querySelector<HTMLInputElement>('.task-add-input');
    const text = input?.value.trim();
    if (agentId && text) {
      send({ type: 'add_task', agentId, text });
      if (input) input.value = '';
    }
  }
}

function handleDelegatedChange(event: Event) {
  const checkbox = event.target as HTMLInputElement;
  if (checkbox.classList?.contains('task-checkbox')) {
    const agentId = checkbox.dataset.agentId;
    const taskId = checkbox.dataset.taskId;
    if (agentId && taskId) {
      send({ type: 'toggle_task', agentId, taskId, completed: checkbox.checked });
    }
    return;
  }
  if (checkbox.id === 'asrLocale') {
    saveAsrLocale((checkbox as unknown as HTMLSelectElement).value);
  }
}

function handleDelegatedInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.dataset?.micSetting) {
    updateMicSetting(input.dataset.micSetting, Number(input.value));
  }
}

// ── Drawer de agente (crear/editar) ─────────────────────────────────────

function openAgentDialog(agentId: string | null) {
  state.editingAgentId = agentId;
  const agent = agentId ? state.agents.find((item) => item.id === agentId) : null;

  byId('spawnDialogTitle').textContent = agent ? `Editar a ${agent.name}` : 'Sumar al Equipo';
  byId('spawnSubmitLabel').textContent = agent ? 'Guardar cambios' : 'Sumar al Equipo';
  byId<HTMLInputElement>('spawnName').value = agent?.name || '';
  byId<HTMLInputElement>('spawnTitle').value = agent?.title || '';
  byId<HTMLInputElement>('spawnDomains').value = agent ? agent.domains.join(', ') : '';
  byId<HTMLInputElement>('spawnAliases').value = agent ? agent.aliases.join(', ') : '';
  byId<HTMLSelectElement>('spawnVoice').value = agent?.voice || 'Aoede';
  byId<HTMLTextAreaElement>('spawnStyle').value = agent?.style || '';
  byId<HTMLTextAreaElement>('spawnBoundaries').value = agent ? agent.boundaries.join('\n') : '';
  byId<HTMLTextAreaElement>('spawnTasks').value = '';
  byId('spawnTasksGroup').style.display = agent ? 'none' : '';

  state.selectedSpawnColor = agent?.color || '#2f6f73';
  document.querySelectorAll<HTMLElement>('#spawnColors .color-option').forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.color === state.selectedSpawnColor);
  });

  byId('spawnOverlay').classList.add('is-open');
}

function closeAgentDialog() {
  state.editingAgentId = null;
  byId('spawnOverlay').classList.remove('is-open');
  byId<HTMLFormElement>('spawnForm').reset();
}

function submitAgentDialog() {
  const name = byId<HTMLInputElement>('spawnName').value.trim();
  const title = byId<HTMLInputElement>('spawnTitle').value.trim();
  const domains = byId<HTMLInputElement>('spawnDomains').value.split(',').map((s) => s.trim()).filter(Boolean);
  const aliases = byId<HTMLInputElement>('spawnAliases').value.split(',').map((s) => s.trim()).filter(Boolean);
  const voice = byId<HTMLSelectElement>('spawnVoice').value;
  const style = byId<HTMLTextAreaElement>('spawnStyle').value.trim();
  const boundaries = byId<HTMLTextAreaElement>('spawnBoundaries').value.split('\n').map((s) => s.trim()).filter(Boolean);

  if (!name || !title) return;

  if (state.editingAgentId) {
    send({
      type: 'update_agent',
      agentId: state.editingAgentId,
      patch: { name, title, color: state.selectedSpawnColor, voice, style, domains, aliases, boundaries }
    });
  } else {
    const tasksStr = byId<HTMLTextAreaElement>('spawnTasks').value.trim();
    const initialTasks = tasksStr ? tasksStr.split('\n').map((t) => t.trim()).filter(Boolean) : [];
    send({
      type: 'spawn_agent',
      agent: {
        name,
        title,
        color: state.selectedSpawnColor,
        aliases: aliases.length ? aliases : [name.toLowerCase()],
        domains,
        boundaries,
        style,
        voice,
        initialTasks
      }
    });
  }

  closeAgentDialog();
}

// ── Drawer de reuniones ─────────────────────────────────────────────────

// ── Drawer de memoria (aprendizajes + sugerencias) ──────────────────────

const LEARNING_TYPE_LABELS: Record<string, string> = {
  user_preference: 'preferencia',
  correction: 'corrección',
  fact: 'dato',
  skill_note: 'nota'
};

async function memoryAction(path: string, method: string, body: Record<string, unknown>, agentId: string) {
  try {
    await fetch(`${backendHttpBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    // El drawer se refresca igual y muestra el estado real.
  }
  if (agentId) {
    await openMemoryDrawer(agentId);
  }
}

async function openMemoryDrawer(agentId: string) {
  const agent = state.agents.find((item) => item.id === agentId);
  byId('memoryDialogTitle').textContent = agent ? `Memoria de ${agent.name}` : 'Memoria';
  byId('memoryOverlay').classList.add('is-open');
  const body = byId('memoryBody');
  body.innerHTML = '<p class="muted">Cargando memoria...</p>';

  try {
    const [learningsRes, suggestionsRes] = await Promise.all([
      fetch(`${backendHttpBase()}/api/agents/${agentId}/learnings`).then((r) => r.json()),
      fetch(`${backendHttpBase()}/api/suggestions?status=pending`).then((r) => r.json())
    ]);
    const learnings = (learningsRes.learnings || []) as Array<{
      id: number; type: string; content: string; status: string;
      timesReinforced: number; lastReinforcedAt: string; agentId: string | null;
    }>;
    const active = learnings.filter((item) => item.status === 'active');
    const suggestions = ((suggestionsRes.suggestions || []) as Array<{
      id: number; agentId: string; kind: string; value: string;
    }>).filter((item) => item.agentId === agentId);
    const learningEnabled = Boolean(learningsRes.learningEnabled);

    body.innerHTML = `
      <div class="memory-toolbar">
        <button class="text-button" type="button" data-action="memory-toggle-learning" data-agent-id="${agentId}" data-enabled="${learningEnabled}">
          ${learningEnabled ? 'Aprendizaje: activado' : 'Aprendizaje: pausado'}
        </button>
        <button class="text-button danger" type="button" data-action="memory-forget-all" data-agent-id="${agentId}">Olvidar todo</button>
      </div>
      ${suggestions.length ? `
        <h3 class="memory-section-title">Sugerencias pendientes</h3>
        ${suggestions.map((suggestion) => `
          <div class="memory-row is-suggestion">
            <div class="memory-row-info">
              <span class="memory-badge">${escapeHtml(suggestion.kind.replace('_', ' '))}</span>
              <p>${escapeHtml(suggestion.value)}</p>
            </div>
            <div class="memory-row-actions">
              <button class="text-button" type="button" data-action="suggestion-apply" data-suggestion-id="${suggestion.id}" data-agent-id="${agentId}">Aplicar</button>
              <button class="text-button danger" type="button" data-action="suggestion-reject" data-suggestion-id="${suggestion.id}" data-agent-id="${agentId}">Rechazar</button>
            </div>
          </div>
        `).join('')}
      ` : ''}
      <h3 class="memory-section-title">Aprendizajes (${active.length})</h3>
      ${active.length === 0
        ? '<p class="muted">Todavía no aprendió nada. Corregilo o contale una preferencia durante la reunión y va a aparecer acá.</p>'
        : active.map((learning) => `
          <div class="memory-row">
            <div class="memory-row-info">
              <span class="memory-badge ${learning.type}">${LEARNING_TYPE_LABELS[learning.type] || learning.type}${learning.agentId === null ? ' · global' : ''}</span>
              <p>${escapeHtml(learning.content)}</p>
              <small>reforzado ×${learning.timesReinforced} · ${new Date(learning.lastReinforcedAt).toLocaleDateString()}</small>
            </div>
            <div class="memory-row-actions">
              <button class="text-button" type="button" data-action="memory-edit" data-learning-id="${learning.id}" data-agent-id="${agentId}" data-content="${escapeHtml(learning.content)}">Editar</button>
              <button class="text-button danger" type="button" data-action="memory-delete" data-learning-id="${learning.id}" data-agent-id="${agentId}">Borrar</button>
            </div>
          </div>
        `).join('')}
    `;
  } catch {
    body.innerHTML = '<p class="muted">No pude cargar la memoria del agente.</p>';
  }
}

async function openMeetingsDrawer() {
  byId('meetingsOverlay').classList.add('is-open');
  const list = byId('meetingsList');
  list.innerHTML = '<p class="muted">Cargando reuniones...</p>';
  try {
    const response = await fetch(`${backendHttpBase()}/api/meetings`);
    const data = await response.json() as { meetings: Array<{ id: string; title: string | null; scenario_name: string | null; status: string; last_active_at: string; turn_count: number; summary: string | null }> };
    if (!data.meetings.length) {
      list.innerHTML = '<p class="muted">Todavía no hay reuniones guardadas.</p>';
      return;
    }
    list.innerHTML = data.meetings.map((meeting) => `
      <div class="meeting-row ${meeting.id === state.meetingId ? 'is-current' : ''}">
        <div class="meeting-row-info">
          <strong>${escapeHtml(meeting.title || meeting.scenario_name || 'Reunión sin título')}</strong>
          <span>${new Date(meeting.last_active_at).toLocaleString()} · ${meeting.turn_count} turnos · ${meeting.status === 'active' ? 'activa' : 'cerrada'}</span>
          ${meeting.summary ? `<small>${escapeHtml(meeting.summary.slice(0, 140))}</small>` : ''}
        </div>
        ${meeting.id === state.meetingId
          ? '<span class="muted">actual</span>'
          : `<button class="text-button" data-action="resume-meeting" data-meeting-id="${meeting.id}" type="button">Retomar</button>`}
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<p class="muted">No pude cargar las reuniones.</p>';
  }
}

function renderAgent(agent: Agent) {
  const speaking = state.speakingAgentId === agent.id;
  const disabled = agent.enabled === false;
  const tasks = agent.tasks || [];
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return `
    <article class="agent ${speaking ? 'is-speaking' : ''} ${disabled ? 'is-disabled' : ''}" style="--agent-color: ${escapeHtml(agent.color)}">
      <div class="agent-main">
        <div class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</div>
        <div class="agent-body">
          <div class="agent-head">
            <h2>${escapeHtml(agent.name)}</h2>
            <span>${disabled ? 'En pausa' : speaking ? 'Hablando' : escapeHtml(agent.title)}</span>
          </div>
          <p>${escapeHtml(agent.domains.slice(0, 5).join(' · '))}</p>
        </div>
        <div class="agent-actions">
          <button class="agent-action-btn" type="button" data-action="open-memory" data-agent-id="${agent.id}" title="Memoria del agente">
            <svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7zm-3 16h6v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-1z"/></svg>
          </button>
          <button class="agent-action-btn" type="button" data-action="edit-agent" data-agent-id="${agent.id}" title="Editar agente">
            <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="agent-action-btn" type="button" data-action="toggle-agent-enabled" data-agent-id="${agent.id}" title="${disabled ? 'Reactivar en esta reunión' : 'Pausar en esta reunión'}">
            ${disabled
              ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
              : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'}
          </button>
          ${agent.origin === 'custom'
            ? `<button class="agent-action-btn danger" type="button" data-action="archive-agent" data-agent-id="${agent.id}" title="Archivar agente">
                <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>`
            : ''}
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
      <label class="range-control asr-locale">
        <span><strong>Idioma ASR</strong><small>reconocimiento local</small></span>
        <select id="asrLocale">
          ${ASR_LOCALES.map((locale) => `<option value="${locale}" ${loadAsrLocale() === locale ? 'selected' : ''}>${locale}</option>`).join('')}
        </select>
      </label>
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
  byId<HTMLTextAreaElement>('turnInput').value = '';
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
  markDirty('micTuning', 'micMeter');
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
  markDirty('micTuning', 'micMeter');
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
  markDirty('alerts');

  if (timeout) {
    const alert = state.alerts.find((item) => item.id === id);
    if (alert) {
      alert.timeout = window.setTimeout(() => {
        state.alerts = state.alerts.filter((item) => item.id !== id);
        markDirty('alerts');
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
        markDirty('micMeter');
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
    transcriptSetText(id, turn.text);
  }
}

function setAgentText(turnId: string, agentId: string, text: string) {
  const id = `${turnId}-${agentId}`;
  const turn = state.turns.find((item) => item.id === id);
  if (turn) {
    turn.text = text;
    transcriptSetText(id, text);
  }
}

function removeAgentTurn(turnId: string, agentId: string) {
  const id = `${turnId}-${agentId}`;
  state.turns = state.turns.filter((turn) => turn.id !== id);
  transcriptRemove(id);
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
      markDirty('voice');
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

// ── Bootstrap (al final: las regiones usan const no-hoisted) ────────────

mountShell();
render();
connect();
trace('page_loaded', {
  userAgent: navigator.userAgent,
  viewport: { width: window.innerWidth, height: window.innerHeight }
});
