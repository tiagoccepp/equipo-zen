import './styles.css';

import { VOICES, VOICE_LABELS, parseServerMessage } from '../shared/protocol.ts';
import type {
  KeyStatus,
  MeetingScenario,
  PublicAgent as Agent,
  PublicCompany as Company,
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
  // Toast accionable: un botón que dispara un data-action del delegador.
  action?: { label: string; action: string; goalId?: string; path?: string };
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

type CompanyTemplate = {
  id: string;
  name: string;
  industry: string;
  emoji: string;
  color: string;
  scenario: string;
  teamSize: number;
  team: Array<{ name: string; title: string }>;
};

type MeetingListItem = {
  id: string;
  title: string | null;
  scenario_name: string | null;
  status: string;
  last_active_at: string;
  turn_count: number;
  summary: string | null;
};

type SettingsData = {
  llm: {
    provider: string;
    apiKeySet: boolean;
    apiKeyMasked: string;
    model: string;
    modelOptions: string[];
  };
  stt: {
    provider: 'local' | 'groq' | 'browser';
    providerOptions: string[];
    whisperModel: string;
    whisperModelOptions: string[];
    groqKeySet: boolean;
    groqKeyMasked: string;
    language: string;
  };
  tts: {
    engine: string;
    language: string;
    url: string;
  };
};

type SettingsStatus = {
  llm: { configured: boolean; model: string };
  tts: { engine: string; healthy: boolean };
  stt: { provider: string; localHealthy: boolean; groqConfigured: boolean };
};

// ── Supervisión del trabajo (tareas, proyectos, organigrama, actividad) ──

type WorkTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'noted';

type WorkComment = {
  id: string;
  authorId: string;
  kind: 'nota' | 'aprobacion' | 'cambios' | string;
  text: string;
  createdAt: string;
};

type WorkTask = {
  id: string;
  text: string;
  status: WorkTaskStatus | string;
  kind?: string;
  agentId: string | null;
  reviewerId?: string | null;
  reviewStatus?: 'pendiente' | 'aprobado' | 'cambios' | null;
  parentTaskId?: string | null;
  resultSummary: string | null;
  blockedReason: string | null;
  runCount: number;
  comments?: WorkComment[];
};

// Un archivo del entorno aislado del proyecto (index.html viene primero).
type WorkFile = {
  path: string;
  size: number;
  url: string;
};

type WorkGoal = {
  id: string;
  title: string;
  description: string;
  status: string;
  kind?: 'proyecto' | 'acuerdo' | string;
  slug?: string;
  url?: string | null;
  files?: WorkFile[];
  created_at?: string;
  completed_at?: string | null;
  tasks: WorkTask[];
};

type WorkMember = {
  id: string;
  name: string;
  title: string;
  color: string;
  role?: 'ceo' | 'contratista' | 'worker' | null;
  managerId?: string | null;
};

type WorkRun = {
  id: number;
  task_id: string;
  agent_id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: string | null;
  artifacts: string[];
};

type WorkData = {
  company: { id: string; name: string };
  team: WorkMember[];
  goals: WorkGoal[];
  runs: WorkRun[];
  comments?: Array<WorkComment & { taskId: string }>;
  workspaceUrl: string;
};

type WorkFeedItem = {
  key: string;
  at: number;
  icon: string;
  html: string;
};

// Solo los entregables llegan a producir archivos; el resto queda registrado.
const TASK_KIND_LABEL: Record<string, string> = {
  decision: 'acuerdo',
  seguimiento: 'seguimiento',
  revision: 'revisión',
  contratacion: 'contratación'
};

// ── Secciones del workspace ─────────────────────────────────────────────
// El área principal está paginada: cada sección es un tabpanel propio y
// solo se pinta la que está visible.

type WsSection = 'meeting' | 'tasks' | 'projects' | 'org' | 'activity';

const WS_SECTIONS: Array<{ id: WsSection; label: string; tab: string; pane: string }> = [
  { id: 'meeting', label: 'Reunión', tab: 'tabMeeting', pane: 'meetingView' },
  { id: 'tasks', label: 'Tareas', tab: 'tabTasks', pane: 'tasksView' },
  { id: 'projects', label: 'Proyectos', tab: 'tabProjects', pane: 'projectsView' },
  { id: 'org', label: 'Organigrama', tab: 'tabOrg', pane: 'orgView' },
  { id: 'activity', label: 'Actividad', tab: 'tabActivity', pane: 'activityView' }
];

// Columnas del tablero de tareas. `pending`, `in_progress` y `done` se
// muestran siempre (aunque estén vacías) para que la lectura sea estable;
// `blocked` y `noted` aparecen solo cuando tienen algo.
const TASK_COLUMNS: Array<{ status: string; label: string; always: boolean }> = [
  { status: 'pending', label: 'En cola', always: true },
  { status: 'in_progress', label: 'En curso', always: true },
  { status: 'blocked', label: 'Bloqueada', always: false },
  { status: 'done', label: 'Hecha', always: true },
  { status: 'noted', label: 'Acuerdo', always: false }
];

const REVIEW_LABEL: Record<string, string> = {
  pendiente: 'En revisión',
  aprobado: 'Aprobado',
  cambios: 'Cambios pedidos'
};

const VIEWPORTS: Array<{ id: 'desktop' | 'tablet' | 'mobile'; label: string; width: string }> = [
  { id: 'desktop', label: 'Escritorio', width: 'todo el ancho' },
  { id: 'tablet', label: 'Tablet', width: '820 px' },
  { id: 'mobile', label: 'Móvil', width: '390 px' }
];

type ClosingSummary = {
  producesWork: boolean;
  goalTitle: string;
  goalDescription: string;
  assignments: Array<{ agentId: string; agentName: string; tasks: Array<{ text: string; kind: string }> }>;
  hires: Array<{ need: string }>;
};

const telemetryClientId = crypto.randomUUID();
let telemetrySeq = 0;
let inputTraceTimer = 0;
let speechTraceTimer = 0;
let micMeterRenderTimer = 0;
let voiceStatusTimer = 0;
let renderQueued = false;

const MIC_SETTINGS_STORAGE_KEY = 'reunion.micSettings.v1';
const ASR_LOCALE_STORAGE_KEY = 'reunion.asrLocale.v1';
const LAST_COMPANY_STORAGE_KEY = 'sim.companyId.v1';
const MEETING_STORAGE_PREFIX = 'sim.meetingId.';
const ASR_LOCALES = ['es-ES', 'es-AR', 'es-MX', 'en-US'];

const DEFAULT_VOICE = 'M4';
const AGENT_COLORS = ['#2f6f73', '#8a5a2b', '#b74e39', '#4a7c59', '#5c5470', '#15618a', '#c2255c', '#f08c00'];
const COMPANY_COLORS = ['#2f6f73', '#4c6ef5', '#e8590c', '#0ca678', '#8a5a2b', '#5c5470', '#c2255c', '#1971c2'];
const VOICE_READY = 'Te escucho: hablá cuando quieras.';

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

function loadLastCompanyId(): string {
  try {
    return window.localStorage.getItem(LAST_COMPANY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveLastCompanyId(companyId: string) {
  try {
    window.localStorage.setItem(LAST_COMPANY_STORAGE_KEY, companyId);
  } catch {
    // localStorage puede fallar en modo privado; la sesión sigue en memoria.
  }
}

function clearLastCompanyId(companyId: string) {
  try {
    if (window.localStorage.getItem(LAST_COMPANY_STORAGE_KEY) === companyId) {
      window.localStorage.removeItem(LAST_COMPANY_STORAGE_KEY);
    }
    window.localStorage.removeItem(`${MEETING_STORAGE_PREFIX}${companyId}`);
  } catch {
    // Best effort.
  }
}

function loadStoredMeetingId(companyId: string): string | undefined {
  if (!companyId) return undefined;
  try {
    return window.localStorage.getItem(`${MEETING_STORAGE_PREFIX}${companyId}`) || undefined;
  } catch {
    return undefined;
  }
}

function saveStoredMeetingId(companyId: string, meetingId: string) {
  if (!companyId) return;
  try {
    window.localStorage.setItem(`${MEETING_STORAGE_PREFIX}${companyId}`, meetingId);
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

// Captura de micrófono con VAD local. Mientras hay habla, los frames PCM
// (16 kHz mono) viajan al servidor como audio_chunk: allá los transcribe
// Whisper (local o Groq, según Ajustes). El SpeechRecognition del
// navegador sigue corriendo en paralelo y su texto va como transcriptHint
// en audio_end (red de seguridad). Acá además vive el gate de voz
// (inicio/fin de habla por RMS), el medidor y el barge-in con ducking.
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
  // Últimos frames previos al arranque del habla: se mandan al detectar voz
  // para no perder el ataque de la primera palabra.
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
    this.onState(VOICE_READY);
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
        // Flush del pre-buffer: el chunk actual ya está incluido.
        for (const buffered of this.preBuffer) {
          this.sendMessage({ type: 'audio_chunk', data: buffered.data, mimeType: 'audio/pcm;rate=16000' });
        }
        this.preBuffer = [];
        this.onState('Grabando tu turno…');
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
            state.voiceStatus = VOICE_READY;
            markDirty('voice');
          }
        }, 900);
        return;
      }
      trace('speech_ended', { transcriptHint, endSilenceMs, speechMs });
      this.sendMessage({ type: 'audio_end', transcriptHint });
      this.onState('Procesando…');
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
      // El VAD sigue enmarcando el turno; sin hint el servidor pide reintento.
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
  view: 'home' as 'home' | 'workspace',
  companies: [] as Company[],
  companiesLoading: false,
  companiesError: false,
  templates: [] as CompanyTemplate[],
  templatesLoaded: false,
  selectedTemplateId: '',
  newCompanyTab: 'templates' as 'templates' | 'scratch',
  scratchColor: COMPANY_COLORS[0],
  creatingCompany: false,
  company: null as Company | null,
  companyId: loadLastCompanyId(),
  mode: 'mock' as 'stream' | 'mock',
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
  selectedSpawnColor: AGENT_COLORS[0],
  openTaskPanels: new Set<string>(),
  wsSection: 'meeting' as WsSection,
  sectionDots: new Set<WsSection>(),
  workData: null as WorkData | null,
  workError: false,
  workActive: false,
  workEvents: [] as WorkFeedItem[],
  // Tablero de tareas: filtros por empleado y por estado.
  taskFilterAgent: '',
  taskFilterStatus: '',
  // Navegador integrado: proyecto y archivo abiertos + ancho simulado.
  projectId: '',
  projectFile: '',
  projectViewport: 'desktop' as 'desktop' | 'tablet' | 'mobile',
  projectReloads: 0,
  // Web recién terminada esperando que el /work confirme dónde vive.
  pendingPreview: null as { taskId: string; path: string; agentName: string; at: number } | null,
  closingSummary: null as ClosingSummary | null,
  endingMeeting: false,
  settings: null as SettingsData | null,
  settingsStatus: null as SettingsStatus | null,
  settingsSaving: false
};

// Dirty tracking de Ajustes: clave del backend → valor que eligió el usuario
// y todavía no guardó. Solo lo que está acá viaja en el PUT.
const settingsPending = new Map<string, string>();
let settingsBaseline: Record<string, string> = {};
const SETTINGS_SECRET_KEYS = new Set(['llm.apiKey', 'stt.groqKey']);
const SETTINGS_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'pt', label: 'Português' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Deutsch' }
];

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('No se encontro #app.');
}
const app: HTMLDivElement = root;

// ── Conexión WebSocket ──────────────────────────────────────────────────
// Reconexión con backoff exponencial + jitter, SOLO mientras la vista
// activa es el workspace. Al volver al home el socket se cierra en
// silencio (sin reintentos). hello lleva companyId + meetingId por empresa.

let reconnectAttempts = 0;
let reconnectTimer = 0;
let connecting = false;

function scheduleReconnect() {
  if (reconnectTimer || state.view !== 'workspace') return;
  const base = Math.min(15000, 500 * Math.pow(1.8, reconnectAttempts));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  const delay = Math.round(base + jitter);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, delay);
}

function detachSocket() {
  const old = state.socket;
  state.socket = null;
  if (old) {
    old.onopen = old.onclose = old.onmessage = old.onerror = null;
    try { old.close(); } catch { /* ya cerrado */ }
  }
}

// Cierra el socket sin disparar la reconexión (cambio de empresa / home).
function closeSocketSilently() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  connecting = false;
  reconnectAttempts = 0;
  detachSocket();
  state.connected = false;
}

function reconnectNow() {
  closeSocketSilently();
  // Pequeño respiro para que el servidor procese el cierre de la sesión
  // anterior antes del nuevo hello (libera la reunión para reanudarla).
  window.setTimeout(() => connect(), 140);
  markDirty('connection');
}

function connect() {
  if (state.view !== 'workspace') return;
  if (connecting) return;
  connecting = true;

  detachSocket();

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/meeting`);

  socket.onopen = () => {
    if (state.socket !== socket) return;
    connecting = false;
    reconnectAttempts = 0;
    state.connected = true;
    trace('socket_open', { companyId: state.companyId });
    // hello abre/reanuda una reunión DE ESTA EMPRESA.
    socket.send(JSON.stringify({
      type: 'hello',
      companyId: state.companyId || undefined,
      meetingId: loadStoredMeetingId(state.companyId)
    }));
    if (state.recording) {
      // El servidor es nuevo: re-preparar el transcriptor y el ASR local.
      socket.send(JSON.stringify({ type: 'audio_prepare' }));
      state.browserSpeech?.start();
    }
    markDirty('connection', 'voice');
  };

  socket.onclose = () => {
    if (state.socket !== socket) return;
    connecting = false;
    state.connected = false;
    state.speakingAgentId = '';
    trace('socket_close');
    markDirty('connection', 'agents', 'voice');
    scheduleReconnect();
  };

  socket.onmessage = async (event) => {
    if (state.socket !== socket) return;
    const message = parseServerMessage(event.data);
    if (!message) {
      trace('server_message_invalid', { raw: String(event.data).slice(0, 200) });
      return;
    }
    traceIncomingMessage(message);
    await handleServerMessage(message);
  };

  state.socket = socket;
}

// ── Navegación entre vistas ─────────────────────────────────────────────

function resetMeetingLocalState() {
  state.sessionId = '';
  state.meetingId = '';
  state.scenario = null;
  state.agents = [];
  state.turns = [];
  state.route = null;
  state.keyStatus = [];
  state.speakingAgentId = '';
  state.activeAudioTranscript = '';
  state.clientSpeechText = '';
  state.audioSegment = null;
  state.turnStartedAt.clear();
  state.agentStartedAt.clear();
  state.openTaskPanels.clear();
  state.browserSpeech?.resetUtterance();
  state.audio.stop();
  transcriptReset();
}

function enterCompany(companyId: string, seed?: Company | null) {
  state.view = 'workspace';
  state.companyId = companyId;
  if (seed) {
    state.company = seed;
  } else if (state.company?.id !== companyId) {
    state.company = null;
  }
  saveLastCompanyId(companyId);
  resetMeetingLocalState();
  closeSocketSilently();
  // El estado de supervisión es por empresa: arranca limpio.
  state.wsSection = 'meeting';
  state.sectionDots.clear();
  state.workData = null;
  state.workError = false;
  state.workActive = false;
  state.workEvents = [];
  state.closingSummary = null;
  state.endingMeeting = false;
  state.taskFilterAgent = '';
  state.taskFilterStatus = '';
  state.projectId = '';
  state.projectFile = '';
  state.projectReloads = 0;
  state.pendingPreview = null;
  projectTextCache.clear();
  lastFrameKey = '';
  workHtmlCache.clear();
  syncWorkPolling();
  markDirty('view', 'company', 'connection', 'scenario', 'agents', 'route', 'keys', 'voice', 'micTuning', 'work');
  trace('company_entered', { companyId });
  connect();
}

function leaveToHome() {
  if (state.recording) {
    stopVoiceCapture();
  }
  state.audio.stop();
  closeSocketSilently();
  closeModal('closeMeetingModal');
  state.view = 'home';
  syncWorkPolling();
  markDirty('view', 'connection', 'home');
  trace('back_to_home');
  void loadCompanies();
}

async function loadCompanies() {
  state.companiesLoading = true;
  state.companiesError = false;
  markDirty('home');
  try {
    const data = await apiJson<{ companies: Company[] }>('/api/companies');
    state.companies = data.companies || [];
  } catch {
    state.companiesError = true;
  }
  state.companiesLoading = false;
  markDirty('home');
}

// ── Mensajes del servidor ───────────────────────────────────────────────

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
      state.company = message.company;
      state.companyId = message.company.id;
      state.mode = message.mode === 'mock' || (!message.mode && !message.liveMode) ? 'mock' : 'stream';
      saveLastCompanyId(message.company.id);
      saveStoredMeetingId(message.company.id, message.meetingId);
      trace('meeting_ready', {
        model: message.model,
        liveMode: message.liveMode,
        meetingId: message.meetingId,
        companyId: message.company.id,
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
        ? 'Reunión retomada: se restauró la conversación, el equipo y las tareas.'
        : state.mode === 'mock'
          ? 'Reunión nueva en modo demo: los agentes responden simulados (sin claves API).'
          : 'Reunión nueva: el equipo está en la mesa.';
      upsertAlert('meeting-status', state.company.name, statusText, 'ok', 4000);
      // Un cierre pendiente no sobrevive a una sesión nueva del servidor.
      state.endingMeeting = false;
      state.closingSummary = null;
      closeModal('closeMeetingModal');
      // Sondeo del trabajo: si hay metas activas, se muestra el aviso
      // "El equipo está trabajando" y el organigrama queda precargado.
      void refreshWork();
      markDirty('view', 'company', 'agents', 'scenario', 'keys', 'voice', 'route', 'work');
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

    case 'meeting_closing_summary':
      state.endingMeeting = false;
      state.closingSummary = {
        producesWork: message.producesWork !== false,
        goalTitle: message.goalTitle,
        goalDescription: message.goalDescription,
        assignments: message.assignments || [],
        hires: message.hires || []
      };
      resolveAlertIfPresent('closing', 'Cierre de reunión', 'Repaso listo: revisalo y confirmá.');
      openClosingModal();
      markDirty('work');
      break;

    case 'work_event':
      handleWorkEvent(message);
      break;

    case 'user_turn_received': {
      state.turnStartedAt.set(message.turnId, performance.now());
      const turn: TranscriptTurn = {
        id: message.turnId,
        kind: message.source === 'system' ? 'system' : 'user',
        speaker: message.source === 'system' ? 'Sistema' : 'Vos',
        text: message.text
      };
      state.turns.push(turn);
      transcriptAppend(turn);
      state.voiceStatus = message.source === 'audio' ? 'Orquestando respuesta…' : state.voiceStatus;
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
      setVoiceStatus(state.recording ? VOICE_READY : '', 0);
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
        upsertAlert(`live-${message.agentId}`, agentName(message.agentId), 'Voz en tiempo real no disponible; usando streaming con TTS.', 'working', 3200);
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
      setVoiceStatus(state.recording ? VOICE_READY : '', 0);
      break;

    case 'audio_listening_start':
      state.voiceStatus = VOICE_READY;
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

    case 'user_audio_turn_final': {
      state.activeAudioTranscript = '';
      state.clientSpeechText = '';
      state.browserSpeech?.resetUtterance();
      const sourceLabels: Record<string, string> = {
        local: 'Transcripto con Whisper local.',
        groq: 'Transcripto con Groq.',
        client: 'Reconocido por el navegador.'
      };
      state.voiceStatus = sourceLabels[message.source] || 'Turno de voz enviado.';
      markDirty('voice');
      break;
    }

    case 'audio_transcription_status':
      state.voiceStatus = message.message;
      markDirty('voice');
      break;

    case 'audio_transcription_empty':
      state.voiceStatus = '';
      upsertAlert('audio-empty', 'Voz', message.message, 'error', 2600);
      markDirty('voice');
      break;

    case 'api_rotation_start':
      upsertAlert(`rotation-${message.scope}`, message.scope, message.message, 'working');
      break;

    case 'api_rotation_resolved':
      systemicScopes.delete(message.scope);
      if (systemicScopes.size === 0) {
        resolveAlertIfPresent('llm-systemic', 'Modelo', 'Conexión con el modelo recuperada.');
      }
      resolveAlertIfPresent(
        `rotation-${message.scope}`,
        message.scope,
        `${message.scope} recuperado.`
      );
      break;

    case 'api_rotation_failed':
      // Un problema de infraestructura (clave, cuota, servicio caído) golpea a
      // TODO el equipo a la vez: se muestra una sola alerta con el conteo, no
      // una pared de rojos idénticos, uno por empleado.
      if (isSystemicFailure(message.message)) {
        systemicScopes.add(message.scope);
        state.alerts = state.alerts.filter((alert) => !alert.id.startsWith('rotation-'));
        const affected = systemicScopes.size;
        upsertAlert(
          'llm-systemic',
          'Modelo',
          `${message.message}${affected > 1 ? ` (afecta a ${affected} empleados)` : ''}`,
          'error'
        );
      } else {
        upsertAlert(`rotation-${message.scope}`, message.scope, `No se pudo recuperar ${message.scope}: ${message.message}`, 'error');
      }
      break;

    case 'health':
      state.keyStatus = message.keys || [];
      markDirty('keys');
      break;

    case 'error': {
      if (state.endingMeeting) {
        state.endingMeeting = false;
        markDirty('work');
      }
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
// drawers, tareas) son estáticos: el foco y lo tipeado sobreviven a
// cualquier mensaje del servidor.

type Region =
  | 'view'
  | 'home'
  | 'company'
  | 'connection'
  | 'alerts'
  | 'agents'
  | 'route'
  | 'keys'
  | 'voice'
  | 'micTuning'
  | 'micMeter'
  | 'scenario'
  | 'work';

const dirtyRegions = new Set<Region>();

function markDirty(...regions: Region[]) {
  for (const region of regions) {
    dirtyRegions.add(region);
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(flushRender);
}

// Compat con los caminos que re-renderizan toda la app.
function render() {
  markDirty('view', 'home', 'company', 'connection', 'alerts', 'agents', 'route', 'keys', 'voice', 'micTuning', 'micMeter', 'scenario', 'work');
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
  view() {
    byId('viewHome').hidden = state.view !== 'home';
    byId('viewWorkspace').hidden = state.view !== 'workspace';
    document.title = state.view === 'workspace' && state.company
      ? `${state.company.name} — Equipo`
      : 'Equipo — Simulaciones';
  },
  home() {
    byId('companiesGrid').innerHTML = renderCompanies();
  },
  company() {
    const company = state.company;
    byId('wsTile').textContent = company?.emoji || '🏢';
    byId('wsName').textContent = company?.name || 'Cargando…';
    byId('wsIndustry').textContent = company?.industry || '';
    byId('viewWorkspace').style.setProperty('--company-color', company?.color || 'var(--accent)');
    const badge = byId('modeBadge');
    badge.hidden = state.mode !== 'mock';
  },
  connection() {
    const el = byId<HTMLDivElement>('connectionStatus');
    el.className = `status ${state.connected ? 'is-on' : ''}`;
    el.innerHTML = `<span aria-hidden="true"></span>${state.connected ? 'Conectado' : 'Conectando…'}`;
    syncEndMeetingButton();
  },
  alerts() {
    byId('alerts').innerHTML = renderAlerts();
  },
  agents() {
    const container = byId('agents');
    container.innerHTML = state.agents.length
      ? state.agents.map(renderAgent).join('')
      : '<p class="muted side-empty">Cargando el equipo…</p>';
  },
  route() {
    byId('routePanel').innerHTML = renderRoute();
  },
  keys() {
    byId('keysPanel').innerHTML = renderKeys();
  },
  voice() {
    const mic = byId<HTMLButtonElement>('micButton');
    mic.classList.toggle('is-recording', state.recording);
    mic.setAttribute('aria-pressed', String(state.recording));
    const label = state.recording ? 'Apagar el micrófono' : 'Hablar con el equipo (activar micrófono)';
    mic.title = label;
    mic.setAttribute('aria-label', label);
    mic.innerHTML = state.recording ? stopIcon() : micIcon();
    const status = byId('speechStatus');
    status.textContent = state.activeAudioTranscript
      ? `“${state.activeAudioTranscript}”`
      : state.voiceStatus;
    status.classList.toggle('is-live', Boolean(state.activeAudioTranscript));
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
    const input = byId<HTMLInputElement>('scenarioInput');
    if (document.activeElement !== input) {
      input.value = state.scenario?.text || '';
    }
  },
  work() {
    syncEndMeetingButton();
    const active = state.wsSection;
    // El puntito avisa novedades solo en las secciones que no estás mirando.
    const dots = new Set(state.sectionDots);
    if (state.workActive) {
      dots.add('tasks');
    }
    for (const section of WS_SECTIONS) {
      const isActive = section.id === active;
      const tab = byId<HTMLButtonElement>(section.tab);
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
      byId(section.pane).hidden = !isActive;
      const dot = document.getElementById(`${section.tab}Dot`);
      if (dot) {
        dot.hidden = isActive || !dots.has(section.id);
      }
    }
    byId('workNotice').hidden = !(state.workActive && active === 'meeting');
    if (active === 'tasks') {
      renderTasksSection();
    } else if (active === 'projects') {
      renderProjectsSection();
    } else if (active === 'org') {
      setWorkHtml('orgChart', renderOrgChart());
    } else if (active === 'activity') {
      setWorkHtml('workFeedList', renderWorkFeed());
    }
  }
};

// ── Transcript append-only ──────────────────────────────────────────────

const transcriptNodes = new Map<string, { article: HTMLElement; text: HTMLParagraphElement }>();

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function syncTranscriptEmpty() {
  byId('transcriptEmpty').hidden = byId('transcriptList').childElementCount > 0;
}

function transcriptAppend(turn: TranscriptTurn) {
  const container = byId<HTMLDivElement>('transcript');
  const list = byId<HTMLDivElement>('transcriptList');
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
  text.textContent = turn.text || '…';
  article.append(speaker, text);
  list.append(article);
  transcriptNodes.set(turn.id, { article, text });
  syncTranscriptEmpty();
  if (stick) {
    container.scrollTop = container.scrollHeight;
  }
}

function transcriptSetText(id: string, value: string) {
  const node = transcriptNodes.get(id);
  if (!node) return;
  const container = byId<HTMLDivElement>('transcript');
  const stick = isNearBottom(container);
  node.text.textContent = value || '…';
  if (stick) {
    container.scrollTop = container.scrollHeight;
  }
}

function transcriptRemove(id: string) {
  transcriptNodes.get(id)?.article.remove();
  transcriptNodes.delete(id);
  syncTranscriptEmpty();
}

// Reconstruye el DOM del transcript desde state.turns (reset / resume).
function transcriptReset() {
  transcriptNodes.clear();
  byId<HTMLDivElement>('transcriptList').innerHTML = '';
  for (const turn of state.turns) {
    transcriptAppend(turn);
  }
  syncTranscriptEmpty();
}

// ── Modales accesibles (overlay + Escape + foco) ────────────────────────

const modalStack: string[] = [];
let modalReturnFocus: HTMLElement | null = null;

function openModal(id: string) {
  const modal = byId(id);
  if (!modalStack.includes(id)) {
    modalStack.push(id);
  }
  if (modalStack.length === 1) {
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  modal.classList.add('is-open');
  const panel = modal.querySelector<HTMLElement>('.modal-panel');
  window.setTimeout(() => {
    const target = panel?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
      || panel?.querySelector<HTMLElement>('button');
    target?.focus();
  }, 40);
}

function closeModal(id: string) {
  byId(id).classList.remove('is-open');
  const index = modalStack.indexOf(id);
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
  if (modalStack.length === 0 && modalReturnFocus?.isConnected) {
    modalReturnFocus.focus();
    modalReturnFocus = null;
  }
}

function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) {
    closeModal(top);
  }
}

// ── Shell estático + delegación de eventos ──────────────────────────────

function mountShell() {
  app.innerHTML = `
    <div class="view view-home" id="viewHome">
      <div class="home-inner">
        <header class="home-head">
          <div class="home-head-top">
            <p class="eyebrow">Equipo · simulador de empresas</p>
            <button class="btn ghost sm" data-action="open-settings" type="button" title="Claves, voz y transcripción">${gearIcon()}Ajustes</button>
          </div>
          <h1>Simulaciones</h1>
          <p class="lead">Cada empresa es un mundo aparte: su equipo, sus reuniones y su memoria. Entrá a una para conversar por voz o texto con sus empleados.</p>
        </header>
        <section id="companiesGrid" class="companies" aria-label="Tus simulaciones"></section>
      </div>
    </div>

    <div class="view view-workspace" id="viewWorkspace" hidden>
      <div class="ws-inner">
        <header class="wsbar">
          <button class="btn ghost back-btn" data-action="go-home" type="button">← Simulaciones</button>
          <div class="ws-identity">
            <span class="company-tile sm" id="wsTile" aria-hidden="true">🏢</span>
            <div class="ws-titles">
              <h1 id="wsName">Cargando…</h1>
              <p id="wsIndustry"></p>
            </div>
          </div>
          <div class="ws-tools">
            <span class="mode-badge" id="modeBadge" hidden title="Sin claves API: los agentes responden simulados">Demo</span>
            <div class="status" id="connectionStatus" role="status"><span aria-hidden="true"></span>Conectando…</div>
            <button class="btn ghost" data-action="open-meetings" type="button">Reuniones</button>
            <button class="icon-btn" data-action="open-settings" type="button" aria-label="Ajustes" title="Ajustes">${gearIcon()}</button>
            <button class="icon-btn" data-action="open-company-edit" type="button" aria-label="Editar empresa" title="Editar empresa">${pencilIcon()}</button>
            <button class="icon-btn danger" data-action="archive-company" type="button" aria-label="Archivar empresa" title="Archivar empresa">${archiveIcon()}</button>
          </div>
        </header>

        <div class="goalbar">
          <form id="scenarioForm" class="goal-form">
            <label class="goal-label" for="scenarioInput">Objetivo de la reunión</label>
            <input type="text" id="scenarioInput" placeholder="¿Qué quieren resolver hoy? (opcional)" />
            <button class="btn ghost sm" type="submit">Guardar</button>
          </form>
          <button class="btn ghost sm" data-action="reset" type="button" title="Cierra esta reunión (queda en el historial) y abre una nueva">Nueva reunión</button>
          <button class="btn primary sm end-meeting-btn" id="endMeetingBtn" data-action="end-meeting" type="button" disabled title="La CEO repasa lo asignado y, si confirmás, el equipo se pone a trabajar de verdad">Finalizar reunión</button>
        </div>

        <div class="ws-layout">
          <aside class="ws-side">
            <section class="side-section" aria-labelledby="teamTitle">
              <div class="side-head">
                <h2 id="teamTitle">Equipo</h2>
                <button class="btn ghost sm" data-action="open-spawn" type="button">+ Sumar</button>
              </div>
              <div id="agents" class="agents"></div>
            </section>
            <details class="side-panel" id="orchestrationPanel">
              <summary>
                <h2>Orquestación</h2>
                ${chevronIcon()}
              </summary>
              <div class="side-panel-body">
                <div id="routePanel"></div>
                <div id="keysPanel"></div>
                <button class="btn ghost sm" data-action="health" type="button">Actualizar estado de claves</button>
              </div>
            </details>
          </aside>

          <main class="ws-main">
            <div class="ws-tabs" id="wsTabs" role="tablist" aria-label="Secciones del workspace">
              ${WS_SECTIONS.map((section) => `
                <button role="tab" type="button" class="ws-tab${section.id === 'meeting' ? ' is-active' : ''}"
                  id="${section.tab}" aria-selected="${section.id === 'meeting'}" aria-controls="${section.pane}"
                  tabindex="${section.id === 'meeting' ? '0' : '-1'}"
                  data-action="ws-tab" data-tab="${section.id}">${section.label}<span class="tab-dot" id="${section.tab}Dot" hidden aria-hidden="true"></span></button>
              `).join('')}
            </div>

            <section class="ws-pane" id="meetingView" role="tabpanel" aria-labelledby="tabMeeting">
              <h2 class="sr-only">Conversación</h2>
              <button class="work-notice" id="workNotice" data-action="open-work-tab" type="button" hidden>
                <span class="live-dot" aria-hidden="true"></span>
                <span>El equipo está trabajando en segundo plano — ver Tareas</span>
              </button>
              <div class="transcript" id="transcript" tabindex="-1">
                <div class="transcript-empty" id="transcriptEmpty">
                  <p class="empty-title">La mesa está lista</p>
                  <p>Escribí abajo o activá el micrófono para arrancar la reunión. Podés nombrar a un empleado para dirigirte a esa persona.</p>
                </div>
                <div class="transcript-list" id="transcriptList" aria-live="polite"></div>
              </div>
              <section class="composer" aria-label="Mandar un mensaje al equipo">
                <p class="speech-status" id="speechStatus"></p>
                <form id="turnForm" class="turn-form">
                  <button class="mic-btn" id="micButton" data-action="toggle-mic" type="button" aria-pressed="false" aria-label="Hablar con el equipo (activar micrófono)" title="Hablar con el equipo (activar micrófono)">${micIcon()}</button>
                  <textarea id="turnInput" rows="1" placeholder="Escribile al equipo… (Enter envía · Shift+Enter, salto de línea)" aria-label="Mensaje para el equipo"></textarea>
                  <button class="send-btn" id="sendButton" type="submit" disabled>${sendIcon()}<span>Enviar</span></button>
                </form>
                <details class="mic-details" id="micDetails">
                  <summary>Ajustes de micrófono ${chevronIcon()}</summary>
                  <div id="micTuning"></div>
                </details>
              </section>
            </section>

            <section class="ws-pane work-pane" id="tasksView" role="tabpanel" aria-labelledby="tabTasks" hidden>
              <h2 class="sr-only">Tareas por proyecto</h2>
              <div class="tasks-toolbar">
                <label class="tfilter" for="taskFilterAgent">
                  <span>Empleado</span>
                  <select class="form-control sm" id="taskFilterAgent"><option value="">Todo el equipo</option></select>
                </label>
                <label class="tfilter" for="taskFilterStatus">
                  <span>Estado</span>
                  <select class="form-control sm" id="taskFilterStatus">
                    <option value="">Todos los estados</option>
                    ${TASK_COLUMNS.map((column) => `<option value="${column.status}">${column.label}</option>`).join('')}
                  </select>
                </label>
                <span class="tasks-count" id="tasksCount" role="status"></span>
              </div>
              <div id="tasksBoard"></div>
            </section>

            <section class="ws-pane projects-pane" id="projectsView" role="tabpanel" aria-labelledby="tabProjects" hidden>
              <h2 class="sr-only">Proyectos y navegador integrado</h2>
              <div class="projects-layout">
                <aside class="projects-side" aria-labelledby="projectsSideTitle">
                  <div class="work-col-head">
                    <h3 id="projectsSideTitle">Proyectos</h3>
                    <a class="btn ghost sm" id="workspaceLink" href="#" target="_blank" rel="noopener" hidden>Carpeta ↗</a>
                  </div>
                  <div id="projectsList" class="projects-list"></div>
                </aside>
                <section class="browser" aria-labelledby="browserTitle">
                  <h3 class="sr-only" id="browserTitle">Navegador integrado</h3>
                  <div class="browser-chrome" id="browserChrome"></div>
                  <div class="browser-stage" id="browserStage" data-viewport="desktop">
                    <iframe class="browser-frame" id="browserFrame" title="Vista previa del proyecto" sandbox="allow-same-origin" hidden></iframe>
                    <pre class="browser-text" id="browserText" tabindex="0" hidden></pre>
                    <div class="browser-empty" id="browserEmpty"></div>
                  </div>
                </section>
              </div>
            </section>

            <section class="ws-pane work-pane" id="orgView" role="tabpanel" aria-labelledby="tabOrg" hidden>
              <h2 class="sr-only">Organigrama del equipo</h2>
              <div class="work-col">
                <div class="work-col-head">
                  <h3 id="orgTitle">Organigrama</h3>
                  <span class="work-col-hint">estado en vivo · cada 5 s</span>
                </div>
                <div id="orgChart"></div>
              </div>
            </section>

            <section class="ws-pane work-pane" id="activityView" role="tabpanel" aria-labelledby="tabActivity" hidden>
              <h2 class="sr-only">Actividad de la empresa</h2>
              <div class="work-col">
                <div class="work-col-head">
                  <h3 id="workActivityTitle">Canal de la empresa</h3>
                  <span class="work-col-hint">quién le dijo qué a quién</span>
                </div>
                <div id="workFeedList" class="work-feed"></div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>

    <div class="toasts" id="alerts" aria-live="polite"></div>

    <div class="modal center" id="newCompanyModal">
      <div class="modal-backdrop" data-action="close-new-company"></div>
      <section class="modal-panel wide" role="dialog" aria-modal="true" aria-labelledby="newCompanyTitle">
        <header class="modal-head">
          <h2 id="newCompanyTitle">Nueva simulación</h2>
          <button class="icon-btn" data-action="close-new-company" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <div class="tabs" role="tablist" aria-label="Cómo crear la empresa">
          <button role="tab" type="button" id="tabTemplates" class="tab is-active" aria-selected="true" aria-controls="templateForm" data-action="nc-tab" data-tab="templates">Desde plantilla</button>
          <button role="tab" type="button" id="tabScratch" class="tab" aria-selected="false" aria-controls="scratchForm" data-action="nc-tab" data-tab="scratch">Desde cero</button>
        </div>
        <form id="templateForm" class="modal-form" role="tabpanel" aria-labelledby="tabTemplates">
          <div class="modal-body">
            <div id="templateList" class="template-list" aria-label="Plantillas disponibles"></div>
            <div class="form-field">
              <label for="templateName">Nombre de tu empresa <span class="hint-inline">(opcional)</span></label>
              <input type="text" id="templateName" class="form-control" maxlength="80" placeholder="Dejalo vacío para usar el de la plantilla" />
            </div>
          </div>
          <footer class="modal-foot">
            <button type="button" class="btn ghost" data-action="close-new-company">Cancelar</button>
            <button type="submit" class="btn primary">Crear simulación</button>
          </footer>
        </form>
        <form id="scratchForm" class="modal-form" role="tabpanel" aria-labelledby="tabScratch" hidden>
          <div class="modal-body">
            <div class="form-field">
              <label for="scratchName">Nombre</label>
              <input type="text" id="scratchName" class="form-control" maxlength="80" placeholder="Ej. Panadería La Espiga" required />
            </div>
            <div class="form-row">
              <div class="form-field">
                <label for="scratchIndustry">Industria</label>
                <input type="text" id="scratchIndustry" class="form-control" maxlength="80" placeholder="Ej. Gastronomía" />
              </div>
              <div class="form-field emoji-field">
                <label for="scratchEmoji">Emoji</label>
                <input type="text" id="scratchEmoji" class="form-control" maxlength="4" placeholder="🏢" />
              </div>
            </div>
            <div class="form-field">
              <span class="field-label" id="scratchColorLabel">Color</span>
              <div class="swatches" id="scratchColors" role="group" aria-labelledby="scratchColorLabel">
                ${COMPANY_COLORS.map((color, index) => `
                  <button type="button" class="swatch ${index === 0 ? 'is-selected' : ''}" data-action="nc-pick-color" data-color="${color}" style="--swatch: ${color}" aria-label="Color ${color}" aria-pressed="${index === 0 ? 'true' : 'false'}"></button>
                `).join('')}
              </div>
            </div>
            <div class="form-field">
              <label for="scratchScenario">Escenario</label>
              <textarea id="scratchScenario" class="form-control" maxlength="2000" rows="4" placeholder="¿A qué se dedica la empresa? ¿Qué está pasando? Este contexto lo conocen todos los empleados."></textarea>
            </div>
          </div>
          <footer class="modal-foot">
            <button type="button" class="btn ghost" data-action="close-new-company">Cancelar</button>
            <button type="submit" class="btn primary">Crear empresa</button>
          </footer>
        </form>
      </section>
    </div>

    <div class="modal center" id="companyEditModal">
      <div class="modal-backdrop" data-action="close-company-edit"></div>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="companyEditTitle">
        <header class="modal-head">
          <h2 id="companyEditTitle">Editar empresa</h2>
          <button class="icon-btn" data-action="close-company-edit" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <form id="companyEditForm" class="modal-form">
          <div class="modal-body">
            <div class="form-field">
              <label for="companyEditName">Nombre</label>
              <input type="text" id="companyEditName" class="form-control" maxlength="80" required />
            </div>
            <div class="form-field">
              <label for="companyEditIndustry">Industria</label>
              <input type="text" id="companyEditIndustry" class="form-control" maxlength="80" />
            </div>
            <div class="form-field">
              <label for="companyEditScenario">Escenario de la empresa</label>
              <textarea id="companyEditScenario" class="form-control" maxlength="2000" rows="5"></textarea>
              <p class="hint">Es el contexto de fondo que conocen todos los empleados. El objetivo puntual de cada reunión se define en la barra del workspace.</p>
            </div>
          </div>
          <footer class="modal-foot">
            <button type="button" class="btn ghost" data-action="close-company-edit">Cancelar</button>
            <button type="submit" class="btn primary">Guardar cambios</button>
          </footer>
        </form>
      </section>
    </div>

    <div class="modal drawer" id="agentModal">
      <div class="modal-backdrop" data-action="close-spawn"></div>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="spawnDialogTitle">
        <header class="modal-head">
          <h2 id="spawnDialogTitle">Sumar al equipo</h2>
          <button class="icon-btn" data-action="close-spawn" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <form id="spawnForm" class="modal-form">
          <div class="modal-body">
            <p class="role-note" id="spawnRoleNote" hidden></p>
            <div class="form-field">
              <label for="spawnName">Nombre</label>
              <input type="text" id="spawnName" class="form-control" maxlength="40" placeholder="Ej. Carlos" required />
            </div>
            <div class="form-field">
              <label for="spawnTitle">Rol / especialidad</label>
              <input type="text" id="spawnTitle" class="form-control" maxlength="80" placeholder="Ej. Especialista en seguridad" required />
            </div>
            <div class="form-field">
              <span class="field-label" id="spawnColorLabel">Color de firma</span>
              <div class="swatches" id="spawnColors" role="group" aria-labelledby="spawnColorLabel">
                ${AGENT_COLORS.map((color) => `
                  <button type="button" class="swatch" data-action="select-color" data-color="${color}" style="--swatch: ${color}" aria-label="Color ${color}" aria-pressed="false"></button>
                `).join('')}
              </div>
            </div>
            <div class="form-field">
              <label for="spawnSkills">Skills (para el ruteo)</label>
              <input type="text" id="spawnSkills" class="form-control" placeholder="Ej. seguridad, encriptación, auditoría" />
              <p class="hint">Separadas por coma. Cuando la conversación toca estos temas, este empleado toma la palabra.</p>
            </div>
            <div class="form-field">
              <label for="spawnAliases">Alias <span class="hint-inline">(separados por coma)</span></label>
              <input type="text" id="spawnAliases" class="form-control" placeholder="Ej. carlos, seguridad, segu" />
            </div>
            <div class="form-field">
              <label for="spawnVoice">Voz</label>
              <select id="spawnVoice" class="form-control">
                ${VOICES.map((voice) => `<option value="${voice}" ${voice === DEFAULT_VOICE ? 'selected' : ''}>${escapeHtml(VOICE_LABELS[voice])}</option>`).join('')}
              </select>
            </div>
            <div class="form-field">
              <label for="spawnStyle">Estilo de habla</label>
              <textarea id="spawnStyle" class="form-control" maxlength="500" rows="3" placeholder="Ej. Preciso, formal y enfocado en la mitigación de riesgos."></textarea>
            </div>
            <div class="form-field">
              <label for="spawnKnowledge">Conocimientos del puesto</label>
              <textarea id="spawnKnowledge" class="form-control" maxlength="2000" rows="4" placeholder="Lo que esta persona sabe de la empresa: sistemas, historia, números, mañas del rubro…"></textarea>
              <p class="hint">Conocimiento propio del empleado (máx. 2000 caracteres). Lo usa para responder con detalle real.</p>
            </div>
            <div class="form-field">
              <label for="spawnBoundaries">Límites <span class="hint-inline">(uno por línea)</span></label>
              <textarea id="spawnBoundaries" class="form-control" rows="3" placeholder="Ej. No decide precios sin validar con el equipo"></textarea>
            </div>
            <div class="form-field" id="spawnTasksGroup">
              <label for="spawnTasks">Tareas iniciales <span class="hint-inline">(una por línea)</span></label>
              <textarea id="spawnTasks" class="form-control" rows="3" placeholder="Ej. Validar cifrado en endpoints&#10;Revisar accesos a la base"></textarea>
            </div>
          </div>
          <footer class="modal-foot">
            <button type="button" class="btn ghost" data-action="close-spawn">Cancelar</button>
            <button type="submit" class="btn primary" id="spawnSubmitLabel">Sumar al equipo</button>
          </footer>
        </form>
      </section>
    </div>

    <div class="modal center" id="closeMeetingModal">
      <div class="modal-backdrop" data-action="close-close-meeting"></div>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="closeMeetingTitle">
        <header class="modal-head">
          <h2 id="closeMeetingTitle">Cerrar la reunión</h2>
          <button class="icon-btn" data-action="close-close-meeting" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <div class="modal-body" id="closeMeetingBody"></div>
        <footer class="modal-foot">
          <button type="button" class="btn ghost" data-action="close-close-meeting">Seguir conversando</button>
          <button type="button" class="btn primary" id="confirmCloseBtn" data-action="confirm-end-meeting">Confirmar y ponerlos a trabajar</button>
        </footer>
      </section>
    </div>

    <div class="modal drawer" id="meetingsModal">
      <div class="modal-backdrop" data-action="close-meetings"></div>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="meetingsTitle">
        <header class="modal-head">
          <h2 id="meetingsTitle">Reuniones</h2>
          <button class="icon-btn" data-action="close-meetings" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <div class="modal-body" id="meetingsList">
          <p class="muted">Cargando reuniones…</p>
        </div>
      </section>
    </div>

    <div class="modal drawer" id="memoryModal">
      <div class="modal-backdrop" data-action="close-memory"></div>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="memoryDialogTitle">
        <header class="modal-head">
          <h2 id="memoryDialogTitle">Memoria</h2>
          <button class="icon-btn" data-action="close-memory" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <div class="modal-body" id="memoryBody">
          <p class="muted">Cargando memoria…</p>
        </div>
      </section>
    </div>

    <div class="modal center" id="settingsModal">
      <div class="modal-backdrop" data-action="close-settings"></div>
      <section class="modal-panel wide settings-panel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <header class="modal-head">
          <div class="settings-head-title">
            ${gearIcon()}
            <div>
              <h2 id="settingsTitle">Ajustes</h2>
              <p class="settings-head-sub">Claves de API y datos privados: todo queda en tu máquina.</p>
            </div>
          </div>
          <button class="icon-btn" data-action="close-settings" type="button" aria-label="Cerrar">${closeIcon()}</button>
        </header>
        <form id="settingsForm" class="modal-form">
          <div class="modal-body settings-body" id="settingsBody">
            <p class="muted">Cargando ajustes…</p>
          </div>
          <footer class="modal-foot settings-foot">
            <span class="save-status" id="settingsSaveStatus" role="status" aria-live="polite"></span>
            <button type="button" class="btn ghost" data-action="close-settings">Cerrar</button>
            <button type="submit" class="btn primary" id="settingsSaveBtn" disabled>Guardar cambios</button>
          </footer>
        </form>
      </section>
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalStack.length > 0) {
      event.preventDefault();
      closeTopModal();
    }
  });
  // Árbol del organigrama: flechas / Home / End mueven el foco entre nodos.
  document.addEventListener('keydown', handleOrgKeydown);
  // Pestañas del workspace: patrón ARIA de tablist (flechas + Home/End).
  document.addEventListener('keydown', handleWsTabsKeydown);
  // El polling del panel de trabajo se pausa cuando la pestaña no se ve.
  document.addEventListener('visibilitychange', syncWorkPolling);
  // El estado abierto/cerrado de las tareas por agente sobrevive a los
  // re-render de la región (toggle no burbujea: se captura).
  document.addEventListener('toggle', (event) => {
    const details = event.target as HTMLDetailsElement | null;
    const agentId = details?.dataset?.agentTasks;
    if (details && agentId) {
      if (details.open) {
        state.openTaskPanels.add(agentId);
      } else {
        state.openTaskPanels.delete(agentId);
      }
    }
  }, true);
}

function handleDelegatedClick(event: Event) {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    // ── Home ──
    case 'enter-company': {
      const companyId = target.dataset.companyId;
      if (companyId) {
        enterCompany(companyId, state.companies.find((company) => company.id === companyId) || null);
      }
      break;
    }
    case 'retry-companies':
      void loadCompanies();
      break;
    case 'open-new-company':
      void openNewCompanyModal();
      break;
    case 'close-new-company':
      closeModal('newCompanyModal');
      break;
    case 'nc-tab':
      applyNewCompanyTab(target.dataset.tab === 'scratch' ? 'scratch' : 'templates');
      break;
    case 'nc-pick-template':
      state.selectedTemplateId = target.dataset.templateId || '';
      renderTemplateList();
      break;
    case 'nc-pick-color': {
      state.scratchColor = target.dataset.color || COMPANY_COLORS[0];
      document.querySelectorAll<HTMLElement>('#scratchColors .swatch').forEach((el) => {
        const selected = el.dataset.color === state.scratchColor;
        el.classList.toggle('is-selected', selected);
        el.setAttribute('aria-pressed', String(selected));
      });
      break;
    }

    // ── Workspace: empresa ──
    case 'go-home':
      leaveToHome();
      break;
    case 'open-company-edit':
      openCompanyEditModal();
      break;
    case 'close-company-edit':
      closeModal('companyEditModal');
      break;
    case 'archive-company':
      void archiveCurrentCompany();
      break;

    // ── Workspace: reunión ──
    case 'toggle-mic':
      void toggleLiveAudio();
      break;
    case 'reset':
      trace('reset_clicked');
      send({ type: 'reset' });
      break;
    case 'end-meeting':
      if (!state.connected || state.endingMeeting) break;
      state.endingMeeting = true;
      trace('end_meeting_clicked');
      send({ type: 'end_meeting' });
      upsertAlert('closing', 'Cierre de reunión', 'La CEO está preparando el repaso de lo asignado…', 'working');
      markDirty('work');
      break;
    case 'confirm-end-meeting':
      trace('end_meeting_confirmed');
      send({ type: 'confirm_end_meeting' });
      state.closingSummary = null;
      closeModal('closeMeetingModal');
      setWsSection('tasks');
      upsertAlert('work-start', 'Equipo', 'Cierre confirmado: el equipo ya está trabajando en segundo plano.', 'ok', 4200);
      break;
    case 'close-close-meeting':
      closeModal('closeMeetingModal');
      break;
    case 'ws-tab':
      setWsSection(sectionFromTab(target.dataset.tab));
      break;
    case 'open-work-tab':
      setWsSection('tasks');
      byId('tabTasks').focus();
      break;
    case 'work-retry':
      void refreshWork();
      break;

    // ── Workspace: tareas y proyectos ──
    case 'clear-task-filters':
      state.taskFilterAgent = '';
      state.taskFilterStatus = '';
      byId<HTMLSelectElement>('taskFilterAgent').value = '';
      byId<HTMLSelectElement>('taskFilterStatus').value = '';
      markDirty('work');
      break;
    case 'select-project':
      selectProject(target.dataset.goalId || '', target.dataset.filePath || '');
      break;
    case 'open-preview':
      dismissAlert(target.dataset.alertId || '');
      selectProject(target.dataset.goalId || '', target.dataset.filePath || '');
      setWsSection('projects');
      break;
    case 'browser-reload':
      state.projectReloads += 1;
      projectTextCache.clear();
      markDirty('work');
      break;
    case 'browser-viewport': {
      const viewport = target.dataset.viewport;
      if (viewport === 'desktop' || viewport === 'tablet' || viewport === 'mobile') {
        state.projectViewport = viewport;
        markDirty('work');
      }
      break;
    }
    case 'health':
      trace('health_clicked');
      send({ type: 'health' });
      break;
    case 'mic-preset':
      applyMicPreset(target.dataset.micPreset || 'normal');
      break;

    // ── Workspace: equipo ──
    case 'open-spawn':
      openAgentDialog(null);
      break;
    case 'close-spawn':
      closeAgentDialog();
      break;
    case 'select-color': {
      state.selectedSpawnColor = target.dataset.color || AGENT_COLORS[0];
      document.querySelectorAll<HTMLElement>('#spawnColors .swatch').forEach((el) => {
        const selected = el.dataset.color === state.selectedSpawnColor;
        el.classList.toggle('is-selected', selected);
        el.setAttribute('aria-pressed', String(selected));
      });
      break;
    }
    case 'edit-agent':
      openAgentDialog(target.dataset.agentId || null);
      break;
    case 'archive-agent':
      if (target.dataset.agentId && window.confirm('¿Archivar este empleado? Sale de la mesa (su historial se conserva).')) {
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

    // ── Ajustes ──
    case 'open-settings':
      void openSettingsModal();
      break;
    case 'close-settings':
      closeModal('settingsModal');
      break;
    case 'settings-retry':
      void refreshSettings();
      break;
    case 'settings-clear-key':
      void clearSettingsKey(target.dataset.key || '');
      break;
    case 'toggle-secret':
      toggleSecretVisibility(target);
      break;

    // ── Drawers ──
    case 'open-meetings':
      void openMeetingsDrawer();
      break;
    case 'close-meetings':
      closeModal('meetingsModal');
      break;
    case 'open-memory':
      if (target.dataset.agentId) {
        void openMemoryDrawer(target.dataset.agentId);
      }
      break;
    case 'close-memory':
      closeModal('memoryModal');
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
      if (target.dataset.agentId && window.confirm('¿Olvidar TODO lo aprendido por este empleado? (queda registrado en el changelog)')) {
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
      if (meetingId && state.companyId) {
        saveStoredMeetingId(state.companyId, meetingId);
        closeModal('meetingsModal');
        resetMeetingLocalState();
        markDirty('agents', 'route', 'keys', 'voice', 'scenario');
        reconnectNow();
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
    upsertAlert('scenario-saved', 'Objetivo', 'Objetivo de la reunión guardado.', 'ok', 1800);
    return;
  }

  if (form.id === 'spawnForm') {
    event.preventDefault();
    submitAgentDialog();
    return;
  }

  if (form.id === 'templateForm') {
    event.preventDefault();
    void submitTemplateForm(form);
    return;
  }

  if (form.id === 'scratchForm') {
    event.preventDefault();
    void submitScratchForm(form);
    return;
  }

  if (form.id === 'companyEditForm') {
    event.preventDefault();
    void submitCompanyEdit(form);
    return;
  }

  if (form.id === 'settingsForm') {
    event.preventDefault();
    void saveSettings();
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
  if (checkbox.id === 'browserFileSelect') {
    state.projectFile = (checkbox as unknown as HTMLSelectElement).value;
    markDirty('work');
    return;
  }
  if (checkbox.id === 'taskFilterAgent' || checkbox.id === 'taskFilterStatus') {
    const value = (checkbox as unknown as HTMLSelectElement).value;
    if (checkbox.id === 'taskFilterAgent') {
      state.taskFilterAgent = value;
    } else {
      state.taskFilterStatus = value;
    }
    markDirty('work');
    return;
  }
  if (checkbox.classList?.contains('task-checkbox')) {
    const agentId = checkbox.dataset.agentId;
    const taskId = checkbox.dataset.taskId;
    if (agentId && taskId) {
      send({ type: 'toggle_task', agentId, taskId, completed: checkbox.checked });
    }
    return;
  }
  if (checkbox.dataset?.settingKey) {
    onSettingsFieldChange(checkbox as HTMLInputElement | HTMLSelectElement);
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
    return;
  }
  if (input.dataset?.settingKey) {
    onSettingsFieldChange(input);
  }
}

// ── Home: tarjetas de empresas ──────────────────────────────────────────

function renderCompanies() {
  if (state.companiesLoading && state.companies.length === 0) {
    return '<p class="muted grid-note">Cargando simulaciones…</p>';
  }
  if (state.companiesError && state.companies.length === 0) {
    return `
      <div class="grid-note">
        <p class="muted">No pude cargar las simulaciones. ¿Está corriendo el servidor?</p>
        <button class="btn ghost sm" data-action="retry-companies" type="button">Reintentar</button>
      </div>
    `;
  }

  const lastCompanyId = loadLastCompanyId();
  const cards = state.companies.map((company) => {
    const team = company.teamSize ?? 0;
    const meetings = company.meetingCount ?? 0;
    return `
      <button type="button" class="company-card" data-action="enter-company" data-company-id="${escapeHtml(company.id)}">
        <span class="company-tile" style="--company-color: ${escapeHtml(company.color)}" aria-hidden="true">${escapeHtml(company.emoji)}</span>
        <span class="company-card-body">
          <span class="company-name">${escapeHtml(company.name)}</span>
          <span class="company-industry">${escapeHtml(company.industry || 'Sin industria')}</span>
          <span class="company-meta">${team} ${team === 1 ? 'empleado' : 'empleados'} · ${meetings} ${meetings === 1 ? 'reunión' : 'reuniones'}</span>
          <span class="company-when">${escapeHtml(relativeTime(company.lastActiveAt))}</span>
        </span>
        ${company.id === lastCompanyId ? '<span class="company-flag">Última visitada</span>' : ''}
      </button>
    `;
  }).join('');

  const emptyHint = state.companies.length === 0
    ? '<p class="muted grid-note">Todavía no hay simulaciones. Creá la primera: elegí una plantilla con equipo armado o empezá desde cero.</p>'
    : '';

  return `
    ${emptyHint}
    <div class="companies-grid">
      ${cards}
      <button type="button" class="company-card is-new" data-action="open-new-company">
        <span class="company-tile is-new" aria-hidden="true">+</span>
        <span class="company-card-body">
          <span class="company-name">Nueva simulación</span>
          <span class="company-industry">Desde una plantilla o desde cero</span>
        </span>
      </button>
    </div>
  `;
}

// ── Modal: nueva simulación ─────────────────────────────────────────────

async function openNewCompanyModal() {
  applyNewCompanyTab('templates');
  byId<HTMLInputElement>('templateName').value = '';
  byId<HTMLFormElement>('scratchForm').reset();
  state.scratchColor = COMPANY_COLORS[0];
  document.querySelectorAll<HTMLElement>('#scratchColors .swatch').forEach((el, index) => {
    el.classList.toggle('is-selected', index === 0);
    el.setAttribute('aria-pressed', String(index === 0));
  });
  openModal('newCompanyModal');

  if (!state.templatesLoaded) {
    byId('templateList').innerHTML = '<p class="muted">Cargando plantillas…</p>';
    try {
      const data = await apiJson<{ templates: CompanyTemplate[] }>('/api/company-templates');
      state.templates = data.templates || [];
      state.templatesLoaded = true;
      if (!state.selectedTemplateId && state.templates.length > 0) {
        state.selectedTemplateId = state.templates[0].id;
      }
    } catch {
      byId('templateList').innerHTML = '<p class="muted">No pude cargar las plantillas. Probá la pestaña “Desde cero”.</p>';
      return;
    }
  }
  renderTemplateList();
}

function applyNewCompanyTab(tab: 'templates' | 'scratch') {
  state.newCompanyTab = tab;
  const templatesTab = byId<HTMLButtonElement>('tabTemplates');
  const scratchTab = byId<HTMLButtonElement>('tabScratch');
  templatesTab.classList.toggle('is-active', tab === 'templates');
  scratchTab.classList.toggle('is-active', tab === 'scratch');
  templatesTab.setAttribute('aria-selected', String(tab === 'templates'));
  scratchTab.setAttribute('aria-selected', String(tab === 'scratch'));
  byId('templateForm').hidden = tab !== 'templates';
  byId('scratchForm').hidden = tab !== 'scratch';
}

function renderTemplateList() {
  const list = byId('templateList');
  if (!state.templatesLoaded) return;
  if (state.templates.length === 0) {
    list.innerHTML = '<p class="muted">No hay plantillas disponibles.</p>';
    return;
  }
  list.innerHTML = state.templates.map((template) => `
    <button type="button" class="template-card ${template.id === state.selectedTemplateId ? 'is-selected' : ''}"
      data-action="nc-pick-template" data-template-id="${escapeHtml(template.id)}"
      aria-pressed="${template.id === state.selectedTemplateId ? 'true' : 'false'}">
      <span class="template-tile" style="--company-color: ${escapeHtml(template.color)}" aria-hidden="true">${escapeHtml(template.emoji)}</span>
      <span class="template-info">
        <span class="template-name">${escapeHtml(template.name)}</span>
        <span class="template-industry">${escapeHtml(template.industry)}</span>
        <span class="template-scenario">${escapeHtml(template.scenario)}</span>
        <span class="template-team">${template.team.map((member) => `${escapeHtml(member.name)} — ${escapeHtml(member.title)}`).join(' · ')}</span>
      </span>
    </button>
  `).join('');
}

async function submitTemplateForm(form: HTMLFormElement) {
  if (state.creatingCompany || !state.selectedTemplateId) return;
  const name = byId<HTMLInputElement>('templateName').value.trim();
  await createCompany(form, { templateId: state.selectedTemplateId, name: name || undefined });
}

async function submitScratchForm(form: HTMLFormElement) {
  if (state.creatingCompany) return;
  const name = byId<HTMLInputElement>('scratchName').value.trim();
  if (!name) {
    upsertAlert('company-create', 'Nueva simulación', 'La empresa necesita un nombre.', 'error', 2600);
    return;
  }
  await createCompany(form, {
    name,
    industry: byId<HTMLInputElement>('scratchIndustry').value.trim(),
    emoji: byId<HTMLInputElement>('scratchEmoji').value.trim() || '🏢',
    color: state.scratchColor,
    scenario: byId<HTMLTextAreaElement>('scratchScenario').value.trim()
  });
}

async function createCompany(form: HTMLFormElement, payload: Record<string, unknown>) {
  state.creatingCompany = true;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const data = await apiJson<{ company: Company }>('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    trace('company_created', { companyId: data.company.id, templateId: payload.templateId || null });
    closeModal('newCompanyModal');
    upsertAlert('company-create', data.company.name, 'Simulación creada. Entrando…', 'ok', 2600);
    enterCompany(data.company.id, data.company);
  } catch (error) {
    upsertAlert('company-create', 'Nueva simulación', `No pude crear la empresa: ${getClientError(error)}`, 'error', 4200);
  } finally {
    state.creatingCompany = false;
    if (submit) submit.disabled = false;
  }
}

// ── Modal: editar / archivar empresa ────────────────────────────────────

function openCompanyEditModal() {
  const company = state.company;
  if (!company) return;
  byId<HTMLInputElement>('companyEditName').value = company.name;
  byId<HTMLInputElement>('companyEditIndustry').value = company.industry || '';
  byId<HTMLTextAreaElement>('companyEditScenario').value = company.scenario || '';
  openModal('companyEditModal');
}

async function submitCompanyEdit(form: HTMLFormElement) {
  if (!state.companyId) return;
  const name = byId<HTMLInputElement>('companyEditName').value.trim();
  if (!name) {
    upsertAlert('company-edit', 'Empresa', 'El nombre no puede quedar vacío.', 'error', 2600);
    return;
  }
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const data = await apiJson<{ company: Company }>(`/api/companies/${encodeURIComponent(state.companyId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        industry: byId<HTMLInputElement>('companyEditIndustry').value.trim(),
        scenario: byId<HTMLTextAreaElement>('companyEditScenario').value
      })
    });
    state.company = data.company;
    closeModal('companyEditModal');
    upsertAlert('company-edit', data.company.name, 'Empresa actualizada. Reabriendo la reunión con el contexto nuevo…', 'ok', 3200);
    markDirty('company');
    trace('company_updated', { companyId: data.company.id });
    // Reconectar para que la sesión tome el escenario/nombre nuevos.
    reconnectNow();
  } catch (error) {
    upsertAlert('company-edit', 'Empresa', `No pude guardar: ${getClientError(error)}`, 'error', 4200);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function archiveCurrentCompany() {
  const company = state.company;
  if (!company) return;
  const confirmed = window.confirm(`¿Archivar "${company.name}"? La simulación sale del listado (sus datos se conservan).`);
  if (!confirmed) return;
  try {
    await apiJson(`/api/companies/${encodeURIComponent(company.id)}/archive`, { method: 'POST' });
    clearLastCompanyId(company.id);
    upsertAlert('company-archive', company.name, 'Simulación archivada.', 'ok', 2600);
    trace('company_archived', { companyId: company.id });
    leaveToHome();
  } catch (error) {
    upsertAlert('company-archive', 'Empresa', `No pude archivar: ${getClientError(error)}`, 'error', 4200);
  }
}

// ── Drawer de empleado (crear/editar) ───────────────────────────────────

function openAgentDialog(agentId: string | null) {
  state.editingAgentId = agentId;
  const agent = agentId ? state.agents.find((item) => item.id === agentId) : null;

  byId('spawnDialogTitle').textContent = agent ? `Editar a ${agent.name}` : 'Sumar al equipo';
  byId('spawnSubmitLabel').textContent = agent ? 'Guardar cambios' : 'Sumar al equipo';
  const roleNote = byId('spawnRoleNote');
  if (agent?.role === 'ceo') {
    roleNote.hidden = false;
    roleNote.innerHTML = '<span aria-hidden="true">👑</span> <strong>CEO</strong> — dirige la empresa, reparte el trabajo y cierra las reuniones con el repaso final.';
  } else if (agent?.role === 'contratista') {
    roleNote.hidden = false;
    roleNote.innerHTML = '<span aria-hidden="true">🤝</span> <strong>Contratista de talento</strong> — cuando falta una habilidad en el equipo, contrata a la persona ideal y le asigna su primera tarea.';
  } else {
    roleNote.hidden = true;
    roleNote.textContent = '';
  }
  byId<HTMLInputElement>('spawnName').value = agent?.name || '';
  byId<HTMLInputElement>('spawnTitle').value = agent?.title || '';
  byId<HTMLInputElement>('spawnSkills').value = agent ? agent.domains.join(', ') : '';
  byId<HTMLInputElement>('spawnAliases').value = agent ? agent.aliases.join(', ') : '';
  const voiceSelect = byId<HTMLSelectElement>('spawnVoice');
  voiceSelect.value = agent?.voice && (VOICES as readonly string[]).includes(agent.voice) ? agent.voice : DEFAULT_VOICE;
  byId<HTMLTextAreaElement>('spawnStyle').value = agent?.style || '';
  byId<HTMLTextAreaElement>('spawnKnowledge').value = agent?.knowledge || '';
  byId<HTMLTextAreaElement>('spawnBoundaries').value = agent ? agent.boundaries.join('\n') : '';
  byId<HTMLTextAreaElement>('spawnTasks').value = '';
  byId('spawnTasksGroup').hidden = Boolean(agent);

  state.selectedSpawnColor = agent?.color || AGENT_COLORS[0];
  document.querySelectorAll<HTMLElement>('#spawnColors .swatch').forEach((el) => {
    const selected = el.dataset.color === state.selectedSpawnColor;
    el.classList.toggle('is-selected', selected);
    el.setAttribute('aria-pressed', String(selected));
  });

  openModal('agentModal');
}

function closeAgentDialog() {
  state.editingAgentId = null;
  closeModal('agentModal');
  byId<HTMLFormElement>('spawnForm').reset();
}

function submitAgentDialog() {
  const name = byId<HTMLInputElement>('spawnName').value.trim();
  const title = byId<HTMLInputElement>('spawnTitle').value.trim();
  const domains = byId<HTMLInputElement>('spawnSkills').value.split(',').map((s) => s.trim()).filter(Boolean);
  const aliases = byId<HTMLInputElement>('spawnAliases').value.split(',').map((s) => s.trim()).filter(Boolean);
  const voice = byId<HTMLSelectElement>('spawnVoice').value;
  const style = byId<HTMLTextAreaElement>('spawnStyle').value.trim();
  const knowledge = byId<HTMLTextAreaElement>('spawnKnowledge').value.trim();
  const boundaries = byId<HTMLTextAreaElement>('spawnBoundaries').value.split('\n').map((s) => s.trim()).filter(Boolean);

  if (!name || !title) return;

  if (state.editingAgentId) {
    send({
      type: 'update_agent',
      agentId: state.editingAgentId,
      patch: { name, title, color: state.selectedSpawnColor, voice, style, knowledge, domains, aliases, boundaries }
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
        knowledge,
        style,
        voice,
        initialTasks
      }
    });
  }

  closeAgentDialog();
}

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
  openModal('memoryModal');
  const body = byId('memoryBody');
  body.innerHTML = '<p class="muted">Cargando memoria…</p>';

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
        <button class="btn ghost sm" type="button" data-action="memory-toggle-learning" data-agent-id="${agentId}" data-enabled="${learningEnabled}" aria-pressed="${learningEnabled}">
          ${learningEnabled ? 'Aprendizaje: activado' : 'Aprendizaje: pausado'}
        </button>
        <button class="btn ghost sm danger" type="button" data-action="memory-forget-all" data-agent-id="${agentId}">Olvidar todo</button>
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
              <button class="btn ghost sm" type="button" data-action="suggestion-apply" data-suggestion-id="${suggestion.id}" data-agent-id="${agentId}">Aplicar</button>
              <button class="btn ghost sm danger" type="button" data-action="suggestion-reject" data-suggestion-id="${suggestion.id}" data-agent-id="${agentId}">Rechazar</button>
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
              <button class="btn ghost sm" type="button" data-action="memory-edit" data-learning-id="${learning.id}" data-agent-id="${agentId}" data-content="${escapeHtml(learning.content)}">Editar</button>
              <button class="btn ghost sm danger" type="button" data-action="memory-delete" data-learning-id="${learning.id}" data-agent-id="${agentId}">Borrar</button>
            </div>
          </div>
        `).join('')}
    `;
  } catch {
    body.innerHTML = '<p class="muted">No pude cargar la memoria del empleado.</p>';
  }
}

// ── Drawer de reuniones (historial de la empresa) ───────────────────────

async function openMeetingsDrawer() {
  byId('meetingsTitle').textContent = state.company ? `Reuniones de ${state.company.name}` : 'Reuniones';
  openModal('meetingsModal');
  const list = byId('meetingsList');
  list.innerHTML = '<p class="muted">Cargando reuniones…</p>';
  try {
    const query = state.companyId ? `?companyId=${encodeURIComponent(state.companyId)}` : '';
    const data = await apiJson<{ meetings: MeetingListItem[] }>(`/api/meetings${query}`);
    if (!data.meetings.length) {
      list.innerHTML = '<p class="muted">Todavía no hay reuniones guardadas en esta empresa. Cuando cierres una con “Nueva reunión”, va a quedar acá para retomarla.</p>';
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
          ? '<span class="muted current-tag">actual</span>'
          : `<button class="btn ghost sm" data-action="resume-meeting" data-meeting-id="${escapeHtml(meeting.id)}" type="button">Retomar</button>`}
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<p class="muted">No pude cargar las reuniones.</p>';
  }
}

// ── Modal de Ajustes (claves de API y datos privados) ───────────────────
// Tres secciones (Cerebro / Oído / Voz) con estado desde /api/settings y
// /api/settings/status. Dirty tracking en settingsPending: el PUT lleva
// SOLO lo que el usuario cambió; los inputs de clave vacíos nunca pisan
// una clave guardada (para eso está “Quitar clave”, que manda '').

const SETTINGS_SECRET_INPUT_IDS: Record<string, string> = {
  'llm.apiKey': 'setLlmKey',
  'stt.groqKey': 'setGroqKey'
};

async function openSettingsModal() {
  settingsPending.clear();
  state.settingsSaving = false;
  byId('settingsBody').innerHTML = '<p class="muted">Cargando ajustes…</p>';
  setSettingsSaveStatus('');
  syncSettingsSaveButton();
  openModal('settingsModal');
  trace('settings_opened', { view: state.view });
  await refreshSettings();
}

async function refreshSettings() {
  try {
    const [settingsData, statusData] = await Promise.all([
      apiJson<{ settings: SettingsData }>('/api/settings'),
      apiJson<SettingsStatus>('/api/settings/status')
    ]);
    state.settings = settingsData.settings;
    state.settingsStatus = statusData;
    renderSettingsBody();
  } catch (error) {
    byId('settingsBody').innerHTML = `
      <div class="grid-note">
        <p class="muted">No pude cargar los ajustes. ¿Está corriendo el servidor?</p>
        <button class="btn ghost sm" data-action="settings-retry" type="button">Reintentar</button>
      </div>
    `;
    trace('settings_load_failed', { error: getClientError(error) });
  }
}

// Valor efectivo de un campo: lo que el usuario cambió (sin guardar) o lo
// guardado. Así un re-render nunca pisa una edición en curso.
function settingsValue(key: string, fallback: string) {
  return settingsPending.get(key) ?? fallback;
}

function sttChipInfo(provider: string): { tone: 'ok' | 'warn' | 'err' | 'off'; text: string } {
  const status = state.settingsStatus;
  if (provider === 'browser') {
    return { tone: 'off', text: 'Reconocimiento del navegador' };
  }
  if (provider === 'groq') {
    if (settingsPending.has('stt.groqKey')) {
      return { tone: 'ok', text: 'Clave lista — guardá los cambios' };
    }
    return status?.stt.groqConfigured
      ? { tone: 'ok', text: 'Clave de Groq guardada ✓' }
      : { tone: 'warn', text: 'Falta la clave de Groq' };
  }
  return status?.stt.localHealthy
    ? { tone: 'ok', text: 'Whisper local activo ✓' }
    : { tone: 'err', text: 'Whisper local no responde' };
}

function renderSttProviderCard(value: string, title: string, description: string, selected: string) {
  return `
    <label class="radio-card">
      <input type="radio" name="settingsSttProvider" value="${value}" data-setting-key="stt.provider" ${selected === value ? 'checked' : ''} />
      <span class="radio-card-body">
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(description)}</small>
      </span>
    </label>
  `;
}

function renderLanguageOptions(current: string) {
  const known = SETTINGS_LANGUAGES.some((lang) => lang.value === current);
  return [
    ...(known ? [] : [`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`]),
    ...SETTINGS_LANGUAGES.map((lang) => `
      <option value="${lang.value}" ${lang.value === current ? 'selected' : ''}>${lang.label} (${lang.value})</option>
    `)
  ].join('');
}

function renderSettingsBody() {
  const settings = state.settings;
  const status = state.settingsStatus;
  if (!settings) {
    return;
  }

  settingsBaseline = {
    'llm.model': settings.llm.model,
    'stt.provider': settings.stt.provider,
    'stt.whisperModel': settings.stt.whisperModel,
    'stt.language': settings.stt.language,
    'tts.language': settings.tts.language
  };

  const llmConfigured = status?.llm.configured ?? settings.llm.apiKeySet;
  const model = settingsValue('llm.model', settings.llm.model);
  const provider = settingsValue('stt.provider', settings.stt.provider);
  const whisperModel = settingsValue('stt.whisperModel', settings.stt.whisperModel);
  const sttLanguage = settingsValue('stt.language', settings.stt.language);
  const ttsLanguage = settingsValue('tts.language', settings.tts.language);
  const sttChip = sttChipInfo(provider);

  byId('settingsBody').innerHTML = `
    <section class="settings-section" aria-labelledby="setLlmTitle">
      <header class="settings-section-head">
        <span class="settings-icon" aria-hidden="true">🧠</span>
        <div class="settings-section-titles">
          <h3 id="setLlmTitle">Cerebro <span class="settings-sub">· procesamiento de lenguaje</span></h3>
          <p class="settings-desc">Los empleados piensan con MiniMax.</p>
        </div>
        ${llmConfigured
          ? '<span class="status-chip ok">Configurado ✓</span>'
          : '<span class="status-chip warn">Falta la clave — los empleados responden en modo simulación</span>'}
      </header>
      <div class="settings-fields">
        <div class="form-field">
          <label for="setLlmKey">Clave de API de MiniMax</label>
          <div class="secret-row">
            <input type="password" id="setLlmKey" class="form-control" data-setting-key="llm.apiKey"
              autocomplete="off" spellcheck="false"
              placeholder="${settings.llm.apiKeySet
                ? `${escapeHtml(settings.llm.apiKeyMasked)} (guardada — escribí para reemplazarla)`
                : 'Pegá acá tu clave de MiniMax'}" />
            <button type="button" class="icon-btn reveal-btn" data-action="toggle-secret" data-target="setLlmKey" aria-label="Mostrar clave" aria-pressed="false" title="Mostrar clave">${eyeIcon()}</button>
            ${settings.llm.apiKeySet ? '<button type="button" class="btn ghost sm danger" data-action="settings-clear-key" data-key="llm.apiKey">Quitar clave</button>' : ''}
          </div>
          <p class="hint">Con esta clave los empleados piensan de verdad. Sin ella, responden en modo simulación.</p>
        </div>
        <div class="form-field">
          <label for="setLlmModel">Modelo</label>
          <select id="setLlmModel" class="form-control" data-setting-key="llm.model">
            ${settings.llm.modelOptions.map((option) => `<option value="${escapeHtml(option)}" ${option === model ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="setSttTitle">
      <header class="settings-section-head">
        <span class="settings-icon" aria-hidden="true">🎙️</span>
        <div class="settings-section-titles">
          <h3 id="setSttTitle">Oído <span class="settings-sub">· transcripción de tu voz</span></h3>
          <p class="settings-desc">Lo que decís se convierte en texto con Whisper, el modelo open source de OpenAI.</p>
        </div>
        <span class="status-chip ${sttChip.tone}" id="sttChip">${escapeHtml(sttChip.text)}</span>
      </header>
      <div class="settings-fields">
        <div class="radio-cards" role="radiogroup" aria-label="Quién transcribe tu voz">
          ${renderSttProviderCard('local', 'Whisper local', 'Corre en tu máquina. Privado y gratis.', provider)}
          ${renderSttProviderCard('groq', 'Groq', 'Whisper en la nube de Groq: más rápido, necesita clave.', provider)}
          ${renderSttProviderCard('browser', 'Navegador', 'Reconocimiento del navegador; requiere Chrome.', provider)}
        </div>
        <div class="form-field" id="sttLocalExtra" ${provider === 'local' ? '' : 'hidden'}>
          <label for="setWhisperModel">Modelo de Whisper</label>
          <select id="setWhisperModel" class="form-control" data-setting-key="stt.whisperModel">
            ${settings.stt.whisperModelOptions.map((option) => `<option value="${escapeHtml(option)}" ${option === whisperModel ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>
          <p class="hint">Más grande = más preciso y más lento. “small” es un buen equilibrio.</p>
        </div>
        <div class="form-field" id="sttGroqExtra" ${provider === 'groq' ? '' : 'hidden'}>
          <label for="setGroqKey">Clave de API de Groq</label>
          <div class="secret-row">
            <input type="password" id="setGroqKey" class="form-control" data-setting-key="stt.groqKey"
              autocomplete="off" spellcheck="false"
              placeholder="${settings.stt.groqKeySet
                ? `${escapeHtml(settings.stt.groqKeyMasked)} (guardada — escribí para reemplazarla)`
                : 'Pegá acá tu clave de Groq (gsk_…)'}" />
            <button type="button" class="icon-btn reveal-btn" data-action="toggle-secret" data-target="setGroqKey" aria-label="Mostrar clave" aria-pressed="false" title="Mostrar clave">${eyeIcon()}</button>
            ${settings.stt.groqKeySet ? '<button type="button" class="btn ghost sm danger" data-action="settings-clear-key" data-key="stt.groqKey">Quitar clave</button>' : ''}
          </div>
        </div>
        <div class="form-field" id="sttLangField" ${provider === 'browser' ? 'hidden' : ''}>
          <label for="setSttLang">Idioma de transcripción</label>
          <select id="setSttLang" class="form-control" data-setting-key="stt.language">
            ${renderLanguageOptions(sttLanguage)}
          </select>
        </div>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="setTtsTitle">
      <header class="settings-section-head">
        <span class="settings-icon" aria-hidden="true">🔊</span>
        <div class="settings-section-titles">
          <h3 id="setTtsTitle">Voz <span class="settings-sub">· cómo hablan los empleados</span></h3>
          <p class="settings-desc">Las voces se generan con Supertonic, 100% local.</p>
        </div>
        ${status?.tts.healthy
          ? '<span class="status-chip ok">Supertonic activo ✓</span>'
          : '<span class="status-chip err">Supertonic no responde</span>'}
      </header>
      <div class="settings-fields">
        <div class="form-field">
          <label for="setTtsLang">Idioma de las voces</label>
          <select id="setTtsLang" class="form-control" data-setting-key="tts.language">
            ${renderLanguageOptions(ttsLanguage)}
          </select>
          <p class="hint">Cada empleado elige su propia voz en su editor (panel Equipo → lápiz).</p>
        </div>
      </div>
    </section>

    <p class="settings-privacy"><span aria-hidden="true">🔒</span>Tus claves se guardan solo en la base local de esta app (SQLite en tu máquina). Nunca salen de acá salvo hacia el proveedor correspondiente.</p>
  `;

  // Los valores tipeados en inputs secretos nunca van al HTML: se reponen acá.
  for (const [key, inputId] of Object.entries(SETTINGS_SECRET_INPUT_IDS)) {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const pendingValue = settingsPending.get(key);
    if (input && pendingValue) {
      input.value = pendingValue;
    }
  }
  syncSettingsSaveButton();
}

function onSettingsFieldChange(el: HTMLInputElement | HTMLSelectElement) {
  const key = el.dataset.settingKey || '';
  if (!key || !state.settings) {
    return;
  }
  if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) {
    return;
  }

  if (SETTINGS_SECRET_KEYS.has(key)) {
    const typed = el.value.trim();
    if (typed) {
      settingsPending.set(key, typed);
    } else {
      // Vacío = dejar la clave guardada como está (borrar es “Quitar clave”).
      settingsPending.delete(key);
    }
  } else if (el.value !== (settingsBaseline[key] ?? '')) {
    settingsPending.set(key, el.value);
  } else {
    settingsPending.delete(key);
  }

  if (key === 'stt.provider') {
    syncSttConditionalFields(el.value);
  }
  if (key === 'stt.groqKey') {
    syncSttChip();
  }
  setSettingsSaveStatus('');
  syncSettingsSaveButton();
}

function syncSttConditionalFields(provider: string) {
  byId('sttLocalExtra').hidden = provider !== 'local';
  byId('sttGroqExtra').hidden = provider !== 'groq';
  byId('sttLangField').hidden = provider === 'browser';
  syncSttChip();
}

function syncSttChip() {
  const chip = document.getElementById('sttChip');
  if (!chip || !state.settings) {
    return;
  }
  const provider = settingsValue('stt.provider', state.settings.stt.provider);
  const info = sttChipInfo(provider);
  chip.className = `status-chip ${info.tone}`;
  chip.textContent = info.text;
}

function syncSettingsSaveButton() {
  const button = document.getElementById('settingsSaveBtn') as HTMLButtonElement | null;
  if (!button) {
    return;
  }
  button.disabled = settingsPending.size === 0 || state.settingsSaving;
  button.textContent = state.settingsSaving ? 'Guardando…' : 'Guardar cambios';

  const statusEl = document.getElementById('settingsSaveStatus');
  if (!statusEl || state.settingsSaving) {
    return;
  }
  if (settingsPending.size > 0 && !statusEl.textContent) {
    statusEl.className = 'save-status';
    statusEl.textContent = settingsPending.size === 1
      ? '1 cambio sin guardar'
      : `${settingsPending.size} cambios sin guardar`;
  } else if (settingsPending.size === 0 && statusEl.textContent?.includes('sin guardar')) {
    statusEl.textContent = '';
  }
}

function setSettingsSaveStatus(message: string, tone: 'ok' | 'error' | '' = '') {
  const statusEl = document.getElementById('settingsSaveStatus');
  if (!statusEl) {
    return;
  }
  statusEl.className = `save-status${tone === 'ok' ? ' is-ok' : tone === 'error' ? ' is-error' : ''}`;
  statusEl.textContent = message;
}

async function saveSettings() {
  if (settingsPending.size === 0 || state.settingsSaving) {
    return;
  }
  state.settingsSaving = true;
  syncSettingsSaveButton();
  setSettingsSaveStatus('Guardando…');
  const patch = Object.fromEntries(settingsPending);
  try {
    const data = await apiJson<{ applied: string[]; settings: SettingsData }>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: patch })
    });
    state.settings = data.settings;
    settingsPending.clear();
    trace('settings_saved', { keys: data.applied });
    try {
      state.settingsStatus = await apiJson<SettingsStatus>('/api/settings/status');
    } catch {
      // El guardado ya está hecho; los chips quedan con el último estado conocido.
    }
    state.settingsSaving = false;
    renderSettingsBody();
    setSettingsSaveStatus('Cambios guardados ✓', 'ok');
    upsertAlert('settings', 'Ajustes', 'Cambios guardados: aplican al instante, sin reiniciar.', 'ok', 2600);
  } catch (error) {
    state.settingsSaving = false;
    setSettingsSaveStatus(`No pude guardar: ${getClientError(error)}`, 'error');
    trace('settings_save_failed', { error: getClientError(error) });
  }
  syncSettingsSaveButton();
}

async function clearSettingsKey(key: string) {
  if (!SETTINGS_SECRET_KEYS.has(key)) {
    return;
  }
  const label = key === 'llm.apiKey' ? 'la clave de MiniMax' : 'la clave de Groq';
  const confirmed = window.confirm(`¿Quitar ${label} guardada en esta app? Si existe una clave en el archivo .env se vuelve a usar esa.`);
  if (!confirmed) {
    return;
  }
  try {
    const data = await apiJson<{ settings: SettingsData }>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { [key]: '' } })
    });
    state.settings = data.settings;
    settingsPending.delete(key);
    trace('settings_key_cleared', { key });
    try {
      state.settingsStatus = await apiJson<SettingsStatus>('/api/settings/status');
    } catch {
      // Chips con el último estado conocido.
    }
    renderSettingsBody();
    setSettingsSaveStatus('Clave quitada.', 'ok');
    const input = document.getElementById(SETTINGS_SECRET_INPUT_IDS[key]) as HTMLInputElement | null;
    input?.focus();
  } catch (error) {
    setSettingsSaveStatus(`No pude quitar la clave: ${getClientError(error)}`, 'error');
  }
}

function toggleSecretVisibility(button: HTMLElement) {
  const input = document.getElementById(button.dataset.target || '') as HTMLInputElement | null;
  if (!input) {
    return;
  }
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(show));
  const label = show ? 'Ocultar clave' : 'Mostrar clave';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = show ? eyeOffIcon() : eyeIcon();
}

// ── Tarjetas de empleados ───────────────────────────────────────────────

function renderAgent(agent: Agent) {
  const speaking = state.speakingAgentId === agent.id;
  const disabled = agent.enabled === false;
  const tasks = agent.tasks || [];
  const total = tasks.length;
  const completed = tasks.filter((task) => task.completed).length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const skills = agent.domains.slice(0, 4);
  const extraSkills = agent.domains.length - skills.length;
  const tasksOpen = state.openTaskPanels.has(agent.id);

  return `
    <article class="agent ${speaking ? 'is-speaking' : ''} ${disabled ? 'is-disabled' : ''}" style="--agent-color: ${escapeHtml(agent.color)}">
      <div class="agent-top">
        <span class="agent-avatar" aria-hidden="true">${escapeHtml(agent.name.slice(0, 1))}</span>
        <div class="agent-id">
          <h3>${escapeHtml(agent.name)}${roleBadgeHtml(agent.role)}</h3>
          <p class="agent-role">${escapeHtml(agent.title)}</p>
        </div>
        ${disabled
          ? '<span class="agent-state paused">En pausa</span>'
          : speaking
            ? '<span class="agent-state speaking"><span class="pulse-dot" aria-hidden="true"></span>Hablando…</span>'
            : ''}
      </div>
      <div class="agent-chips">
        ${skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('')}
        ${extraSkills > 0 ? `<span class="chip more">+${extraSkills}</span>` : ''}
        ${agent.knowledge ? `<span class="chip knowledge" title="Tiene conocimientos propios del puesto">${bookIcon()}saber propio</span>` : ''}
      </div>
      <div class="agent-foot">
        <details class="agent-tasks" data-agent-tasks="${escapeHtml(agent.id)}" ${tasksOpen ? 'open' : ''}>
          <summary>
            <span class="tasks-label">Tareas ${completed}/${total}</span>
            <span class="progress" aria-hidden="true"><span style="width: ${percentage}%"></span></span>
            ${chevronIcon()}
          </summary>
          <div class="tasks-list">
            ${tasks.length === 0
              ? '<p class="muted tasks-empty">Sin tareas asignadas.</p>'
              : tasks.map((task) => `
                <div class="task-item ${task.completed ? 'is-completed' : ''}">
                  <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}
                    data-agent-id="${escapeHtml(agent.id)}" data-task-id="${escapeHtml(task.id)}"
                    aria-label="Marcar tarea: ${escapeHtml(task.text)}" />
                  <span class="task-text">${escapeHtml(task.text)}</span>
                  <button class="task-delete-btn" type="button" data-action="delete-task" aria-label="Eliminar tarea: ${escapeHtml(task.text)}" data-agent-id="${escapeHtml(agent.id)}" data-task-id="${escapeHtml(task.id)}">
                    ${trashIcon()}
                  </button>
                </div>
              `).join('')}
          </div>
          <form class="task-add-form" data-agent-id="${escapeHtml(agent.id)}">
            <input type="text" class="task-add-input" placeholder="Nueva tarea…" aria-label="Nueva tarea para ${escapeHtml(agent.name)}" required />
            <button class="btn ghost sm" type="submit">Sumar</button>
          </form>
        </details>
        <div class="agent-actions">
          <button class="icon-btn sm" type="button" data-action="open-memory" data-agent-id="${escapeHtml(agent.id)}" aria-label="Memoria de ${escapeHtml(agent.name)}" title="Memoria">${brainIcon()}</button>
          <button class="icon-btn sm" type="button" data-action="edit-agent" data-agent-id="${escapeHtml(agent.id)}" aria-label="Editar a ${escapeHtml(agent.name)}" title="Editar">${pencilIcon()}</button>
          <button class="icon-btn sm" type="button" data-action="toggle-agent-enabled" data-agent-id="${escapeHtml(agent.id)}" aria-label="${disabled ? `Reactivar a ${escapeHtml(agent.name)}` : `Pausar a ${escapeHtml(agent.name)}`}" title="${disabled ? 'Reactivar en esta reunión' : 'Pausar en esta reunión'}">
            ${disabled ? playIcon() : pauseIcon()}
          </button>
          ${agent.origin === 'custom'
            ? `<button class="icon-btn sm danger" type="button" data-action="archive-agent" data-agent-id="${escapeHtml(agent.id)}" aria-label="Archivar a ${escapeHtml(agent.name)}" title="Archivar">${trashIcon()}</button>`
            : ''}
        </div>
      </div>
    </article>
  `;
}

// ── Paneles auxiliares ──────────────────────────────────────────────────

function renderAlerts() {
  if (!state.alerts.length) {
    return '';
  }

  return state.alerts.map((alert) => `
    <div class="alert ${alert.tone}" role="status">
      <div class="alert-copy">
        <strong>${escapeHtml(alert.scope)}</strong>
        <span>${escapeHtml(alert.message)}</span>
      </div>
      ${alert.action ? `<button class="alert-action" type="button"
        data-action="${escapeHtml(alert.action.action)}"
        data-alert-id="${escapeHtml(alert.id)}"
        data-goal-id="${escapeHtml(alert.action.goalId || '')}"
        data-file-path="${escapeHtml(alert.action.path || '')}">${escapeHtml(alert.action.label)}</button>` : ''}
    </div>
  `).join('');
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
        <h3>Micrófono</h3>
        <span>${state.micMeter.speaking ? 'voz activa' : 'en espera'}</span>
      </div>
      <div class="mic-presets" role="group" aria-label="Perfil de micrófono">
        ${Object.keys(MIC_PRESETS).map((preset) => `
          <button class="${activePreset === preset ? 'is-active' : ''}" type="button" data-action="mic-preset" data-mic-preset="${preset}" aria-pressed="${activePreset === preset}">
            ${presetLabel(preset)}
          </button>
        `).join('')}
      </div>
      <div class="meter" style="--level: ${Math.round(levelRatio * 100)}%; --gate: ${Math.round(gateRatio * 100)}%" aria-hidden="true">
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

function renderRoute() {
  if (!state.route) {
    return '<p class="muted">Acá vas a ver a quién se le asigna la palabra en cada turno.</p>';
  }

  if (state.route.targets.length === 0) {
    return `<p class="muted">${escapeHtml(state.route.reason)}</p>`;
  }

  return `
    <div class="route-list">
      ${state.route.targets.map((target) => `
        <div class="route-item">
          <strong>${escapeHtml(target.name)}</strong>
          <span>${target.directMention ? 'mención directa' : 'dominio detectado'}</span>
          <small>${escapeHtml(target.matchedDomains.join(', ') || 'sin etiquetas')}</small>
        </div>
      `).join('')}
    </div>
  `;
}

function renderKeys() {
  if (state.mode === 'mock') {
    return '<div class="key-box"><strong>Modo demo</strong><span>Sin claves API: los agentes responden simulados. Configurá .env para activar el modelo real.</span></div>';
  }

  if (!state.keyStatus.length) {
    return `<div class="key-box"><strong>Claves listas</strong><span>${escapeHtml(state.model)}</span></div>`;
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

// ── Supervisión: organigrama, feed de trabajo y cierre de reunión ───────
// Fuente de verdad durable: GET /api/companies/:id/work (polling cada 5 s
// mientras el panel está visible). Los work_event del WS dan la inmediatez:
// pintan un ítem efímero en el feed y disparan un refresh corto. Al fusionar,
// lo derivado del endpoint pisa lo efímero (misma clave semántica).

let workPollTimer = 0;
let workEventRefreshTimer = 0;
let workRefreshInFlight = false;
const workHtmlCache = new Map<string, string>();

function roleBadgeHtml(role?: string | null) {
  if (role === 'ceo') {
    return ' <span class="role-badge ceo" title="Dirige la empresa y reparte el trabajo"><span aria-hidden="true">👑</span>CEO</span>';
  }
  if (role === 'contratista') {
    return ' <span class="role-badge contratista" title="Suma gente nueva cuando falta una habilidad"><span aria-hidden="true">🤝</span>Contratista</span>';
  }
  return '';
}

function syncEndMeetingButton() {
  const button = document.getElementById('endMeetingBtn') as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = !state.connected || state.endingMeeting;
  button.textContent = state.endingMeeting ? 'Preparando cierre…' : 'Finalizar reunión';
}

function sectionFromTab(tab?: string): WsSection {
  return WS_SECTIONS.some((section) => section.id === tab) ? (tab as WsSection) : 'meeting';
}

function setWsSection(section: WsSection) {
  if (state.wsSection === section) return;
  state.wsSection = section;
  state.sectionDots.delete(section);
  trace('ws_section_changed', { section });
  markDirty('work');
  syncWorkPolling();
}

// Patrón ARIA de tablist: flechas mueven el foco y activan la sección.
function handleWsTabsKeydown(event: KeyboardEvent) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const origin = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.ws-tab') : null;
  if (!origin || !document.getElementById('wsTabs')?.contains(origin)) return;
  event.preventDefault();
  const index = WS_SECTIONS.findIndex((section) => section.tab === origin.id);
  if (index < 0) return;
  const next = event.key === 'ArrowRight'
    ? (index + 1) % WS_SECTIONS.length
    : event.key === 'ArrowLeft'
      ? (index - 1 + WS_SECTIONS.length) % WS_SECTIONS.length
      : event.key === 'Home'
        ? 0
        : WS_SECTIONS.length - 1;
  setWsSection(WS_SECTIONS[next].id);
  byId(WS_SECTIONS[next].tab).focus();
}

// Polling SOLO mientras una sección que lo necesita está visible (Tareas,
// Proyectos, Organigrama o Actividad + documento visible). Con la Reunión
// arriba alcanza con los work_event del WS. Al arrancar hace un fetch ya.
function syncWorkPolling() {
  const shouldPoll = state.view === 'workspace'
    && state.wsSection !== 'meeting'
    && document.visibilityState === 'visible';
  if (shouldPoll && !workPollTimer) {
    workPollTimer = window.setInterval(() => {
      void refreshWork();
    }, 5000);
    void refreshWork();
  } else if (!shouldPoll && workPollTimer) {
    window.clearInterval(workPollTimer);
    workPollTimer = 0;
  }
}

async function refreshWork() {
  const companyId = state.companyId;
  if (!companyId || workRefreshInFlight) return;
  workRefreshInFlight = true;
  try {
    const data = await apiJson<WorkData>(`/api/companies/${encodeURIComponent(companyId)}/work`);
    if (state.companyId !== companyId) return;
    state.workData = data;
    state.workError = false;
    state.workActive = data.goals.some((goal) => goal.status === 'active'
      && goal.tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'));
    resolvePendingPreview();
  } catch {
    if (state.companyId === companyId) {
      state.workError = true;
    }
  } finally {
    workRefreshInFlight = false;
  }
  markDirty('work');
}

// Debounce corto tras cada work_event: el endpoint confirma lo que el WS
// anticipó (y trae lo que el WS no cuenta, como el estado de las metas).
function scheduleWorkRefresh() {
  window.clearTimeout(workEventRefreshTimer);
  workEventRefreshTimer = window.setTimeout(() => {
    if (state.view === 'workspace') {
      void refreshWork();
    }
  }, 450);
}

function handleWorkEvent(event: { kind: string; [key: string]: unknown }) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const name = text(event.agentName);
  const taskId = text(event.taskId) || String(event.taskId ?? '');
  let item: Omit<WorkFeedItem, 'at'> | null = null;

  switch (event.kind) {
    case 'task_started':
      item = {
        key: `start-${taskId}`,
        icon: '🔨',
        html: `<strong>${escapeHtml(name)}</strong> empezó: ${escapeHtml(clip(text(event.text), 160))}`
      };
      break;
    case 'file_written': {
      const path = text(event.path);
      item = {
        key: `file-${taskId}-${path}`,
        icon: '📄',
        html: `<strong>${escapeHtml(name)}</strong> escribió ${artifactLinkHtml(path)}`
      };
      notePreviewCandidate(taskId, [path], name);
      break;
    }
    case 'task_done': {
      const artifacts = Array.isArray(event.artifacts) ? event.artifacts.map(String) : [];
      item = {
        key: `done-${taskId}`,
        icon: '✅',
        html: `<strong>${escapeHtml(name)}</strong> terminó: ${escapeHtml(clip(text(event.summary), 220))}${artifactLinksHtml(artifacts)}`
      };
      notePreviewCandidate(taskId, artifacts, name);
      break;
    }
    case 'task_blocked':
      item = {
        key: `blocked-${taskId}`,
        icon: '⛔',
        html: `<strong>${escapeHtml(name)}</strong> quedó bloqueado: ${escapeHtml(clip(text(event.reason), 200))}`
      };
      break;
    case 'task_retry':
      item = {
        key: `retry-${taskId}`,
        icon: '🔁',
        html: `A <strong>${escapeHtml(name)}</strong> le falló un intento; la tarea vuelve a la cola.`
      };
      break;
    case 'agent_hired': {
      const by = text(event.by);
      const title = text(event.title);
      item = {
        key: `done-${taskId}`,
        icon: '🧑‍💼',
        html: `<strong>${escapeHtml(by)}</strong> contrató a <strong>${escapeHtml(name)}</strong> (${escapeHtml(title)})`
      };
      upsertAlert(`hired-${text(event.agentId)}`, 'Contratación', `${by} contrató a ${name} (${title}).`, 'ok', 5200);
      break;
    }
    case 'goal_done': {
      const title = text(event.title);
      item = {
        key: `goal-${text(event.goalId)}`,
        icon: '🎯',
        html: `Meta cumplida: <strong>${escapeHtml(title)}</strong>`
      };
      upsertAlert('goal-done', 'Meta cumplida', title || 'El equipo terminó todo lo asignado.', 'ok', 6000);
      break;
    }

    // ── Colaboración entre compañeros ──
    case 'review_requested':
      item = {
        key: `review-req-${text(event.targetTaskId) || taskId}`,
        icon: '👀',
        html: `<strong>${escapeHtml(name)}</strong> va a revisar el trabajo de <strong>${escapeHtml(text(event.authorName))}</strong>`
      };
      break;
    case 'review_done': {
      const approved = text(event.verdict) !== 'cambios';
      item = {
        key: `review-${taskId}`,
        icon: approved ? '👍' : '✋',
        html: `<strong>${escapeHtml(name)}</strong> ${approved ? 'aprobó' : 'pidió cambios sobre'} el trabajo de <strong>${escapeHtml(text(event.authorName))}</strong>${text(event.comment) ? `: <span class="feed-quote">${escapeHtml(clip(text(event.comment), 240))}</span>` : ''}`
      };
      break;
    }
    case 'changes_requested':
      item = {
        key: `changes-${taskId}`,
        icon: '🔧',
        html: `<strong>${escapeHtml(name)}</strong> va a aplicar los cambios que pidió <strong>${escapeHtml(text(event.reviewerName))}</strong>`
      };
      break;
  }

  if (item) {
    state.workEvents = [{ ...item, at: Date.now() }, ...state.workEvents].slice(0, 120);
  }
  if (event.kind === 'task_started' || event.kind === 'file_written') {
    state.workActive = true;
  }
  markDirty('work');
  scheduleWorkRefresh();
}

// ── Navegador integrado: abrir la web recién terminada ──────────────────
// El evento trae la ruta relativa al proyecto pero no el proyecto: se
// anota como pendiente y se resuelve cuando el /work confirma en qué meta
// vive esa tarea (llega por el refresh con debounce del propio evento).

function notePreviewCandidate(taskId: string, paths: string[], agentName: string) {
  const html = paths.map(String).find((path) => /\.html?$/i.test(path));
  if (!html || !taskId) return;
  state.pendingPreview = { taskId, path: html.replace(/^\/+/, ''), agentName, at: Date.now() };
}

function resolvePendingPreview() {
  const pending = state.pendingPreview;
  const data = state.workData;
  if (!pending || !data) return;
  // Si en 90 s el endpoint nunca ubicó la tarea, dejamos de esperar.
  if (Date.now() - pending.at > 90000) {
    state.pendingPreview = null;
    return;
  }
  const goal = data.goals.find((item) => item.tasks.some((task) => task.id === pending.taskId));
  if (!goal || goal.kind === 'acuerdo') return;
  const files = goal.files || [];
  const file = files.find((item) => item.path === pending.path)
    || files.find((item) => /\.html?$/i.test(item.path));
  if (!file) return;
  state.pendingPreview = null;
  openProjectPreview(goal.id, file.path, pending.agentName);
}

// No robamos el foco si estás escribiendo (o dictando) en el composer:
// en ese caso queda el toast accionable + el puntito en la pestaña.
function composerIsBusy() {
  return document.activeElement === document.getElementById('turnInput')
    || state.manualText.trim().length > 0
    || state.recording;
}

function openProjectPreview(goalId: string, path: string, agentName: string) {
  state.projectId = goalId;
  state.projectFile = path;
  state.projectReloads += 1;
  if (composerIsBusy()) {
    state.sectionDots.add('projects');
    upsertAlert(
      'web-ready',
      'Listo',
      `${agentName || 'El equipo'} terminó la web.`,
      'ok',
      14000,
      { label: 'Ver', action: 'open-preview', goalId, path }
    );
    markDirty('work');
    return;
  }
  setWsSection('projects');
  markDirty('work');
}

function selectProject(goalId: string, path: string) {
  if (goalId) {
    if (goalId !== state.projectId) {
      state.projectFile = '';
    }
    state.projectId = goalId;
  }
  if (path) {
    state.projectFile = path;
  }
  markDirty('work');
}

function workspaceBaseUrl() {
  return state.workData?.workspaceUrl || (state.companyId ? `/workspace/${encodeURIComponent(state.companyId)}/` : '');
}

function artifactLinkHtml(path: string) {
  const base = workspaceBaseUrl();
  const clean = String(path || '').replace(/^\/+/, '');
  if (!base || !clean) {
    return escapeHtml(clean || path);
  }
  return `<a class="artifact-link" href="${escapeHtml(base + encodeURI(clean))}" target="_blank" rel="noopener">${escapeHtml(clean)}</a>`;
}

function artifactLinksHtml(artifacts: unknown) {
  const list = Array.isArray(artifacts) ? artifacts.map(String).filter(Boolean).slice(0, 6) : [];
  if (list.length === 0) return '';
  return `<span class="feed-artifacts">${list.map((path) => artifactLinkHtml(path)).join('')}</span>`;
}

// Fusión del feed: primero lo derivado de /work (runs + metas cumplidas,
// durable y con resúmenes autoritativos), después los eventos efímeros del
// WS que todavía no aparecieron en el endpoint. Claves semánticas evitan
// duplicados; el orden final es cronológico descendente.
function buildFeedItems(): WorkFeedItem[] {
  const items = new Map<string, WorkFeedItem>();
  const addIfAbsent = (entry: WorkFeedItem) => {
    if (!items.has(entry.key)) {
      items.set(entry.key, entry);
    }
  };

  const data = state.workData;
  if (data) {
    const taskById = new Map<string, WorkTask>();
    for (const goal of data.goals) {
      for (const task of goal.tasks) {
        taskById.set(task.id, task);
      }
    }
    const memberById = new Map(data.team.map((member) => [member.id, member]));
    const nameOf = (agentId?: string | null) =>
      (agentId && memberById.get(agentId)?.name) || 'un compañero';

    for (const run of data.runs) {
      const member = memberById.get(run.agent_id);
      const runName = member?.name || run.agent_id;
      const task = taskById.get(run.task_id);
      const startedAt = Date.parse(run.started_at) || Date.now();
      const isReview = task?.kind === 'revision';
      const reviewedName = isReview && task?.parentTaskId
        ? nameOf(taskById.get(task.parentTaskId)?.agentId)
        : '';

      if (run.ended_at) {
        const endedAt = Date.parse(run.ended_at) || startedAt;
        if (run.status === 'ok') {
          const hiring = member?.role === 'contratista' || task?.kind === 'contratacion';
          if (isReview) {
            // Se fusiona con el review_done del WS (misma clave semántica).
            const approved = !/cambios/i.test(run.summary || '');
            addIfAbsent({
              key: `review-${run.task_id}`,
              at: endedAt,
              icon: approved ? '👍' : '✋',
              html: `<strong>${escapeHtml(runName)}</strong> ${approved ? 'aprobó' : 'pidió cambios sobre'} el trabajo de <strong>${escapeHtml(reviewedName)}</strong>`
            });
          } else {
            addIfAbsent({
              key: `done-${run.task_id}`,
              at: endedAt,
              icon: hiring ? '🧑‍💼' : '✅',
              html: `<strong>${escapeHtml(runName)}</strong> ${hiring ? '' : 'terminó: '}${escapeHtml(clip(run.summary || 'Tarea completada.', 220))}${artifactLinksHtml(run.artifacts)}`
            });
          }
        } else if (run.status === 'blocked') {
          addIfAbsent({
            key: `blocked-${run.task_id}`,
            at: endedAt,
            icon: '⛔',
            html: `<strong>${escapeHtml(runName)}</strong> quedó bloqueado: ${escapeHtml(clip(run.summary || 'sin detalle', 200))}`
          });
        } else {
          addIfAbsent({
            key: `retry-${run.task_id}`,
            at: endedAt,
            icon: '🔁',
            html: `A <strong>${escapeHtml(runName)}</strong> le falló un intento; la tarea vuelve a la cola.`
          });
        }
      }
      addIfAbsent({
        key: `start-${run.task_id}`,
        at: startedAt,
        icon: isReview ? '👀' : '🔨',
        html: isReview
          ? `<strong>${escapeHtml(runName)}</strong> se puso a revisar el trabajo de <strong>${escapeHtml(reviewedName)}</strong>`
          : `<strong>${escapeHtml(runName)}</strong> empezó: ${escapeHtml(clip(task?.text || 'una tarea', 160))}`
      });
    }

    // Veredictos con su comentario: el ida y vuelta real entre compañeros.
    for (const comment of data.comments || []) {
      const task = taskById.get(comment.taskId);
      const author = nameOf(comment.authorId);
      const target = nameOf(task?.agentId);
      const verb = comment.kind === 'aprobacion'
        ? 'aprobó el trabajo de'
        : comment.kind === 'cambios'
          ? 'le pidió cambios a'
          : 'le comentó a';
      addIfAbsent({
        key: `comment-${comment.id}`,
        at: Date.parse(comment.createdAt) || Date.now(),
        icon: comment.kind === 'cambios' ? '✋' : comment.kind === 'aprobacion' ? '👍' : '💬',
        html: `<strong>${escapeHtml(author)}</strong> ${verb} <strong>${escapeHtml(target)}</strong>: <span class="feed-quote">${escapeHtml(clip(comment.text.replace(/\s*\n+\s*/g, ' · '), 260))}</span>`
      });
    }

    for (const goal of data.goals) {
      if (goal.status === 'done' && goal.kind !== 'acuerdo') {
        addIfAbsent({
          key: `goal-${goal.id}`,
          at: Date.parse(goal.completed_at || goal.created_at || '') || Date.now(),
          icon: '🎯',
          html: `Meta cumplida: <strong>${escapeHtml(goal.title)}</strong>`
        });
      }
    }
  }

  for (const event of state.workEvents) {
    addIfAbsent(event);
  }

  return [...items.values()].sort((a, b) => b.at - a.at).slice(0, 80);
}

// Pinta cada bloque del panel solo si su HTML cambió (conserva el foco y
// evita reconstruir DOM en cada tick del polling).
function setWorkHtml(id: string, html: string) {
  if (workHtmlCache.get(id) === html) return;
  const el = byId(id);
  const active = document.activeElement;
  const wasInside = active instanceof HTMLElement && el.contains(active);
  const focusedAgentId = wasInside ? active.getAttribute('data-agent-id') : null;
  const focusedId = wasInside && active.id ? active.id : '';
  workHtmlCache.set(id, html);
  el.innerHTML = html;
  // El foco vuelve al mismo control (el selector de archivos, por ejemplo).
  if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
  if (id === 'orgChart') {
    const nodes = el.querySelectorAll<HTMLElement>('[data-org-node]');
    nodes.forEach((node) => { node.tabIndex = -1; });
    const restored = focusedAgentId
      ? el.querySelector<HTMLElement>(`[data-org-node][data-agent-id="${CSS.escape(focusedAgentId)}"]`)
      : null;
    const roving = restored || nodes[0] || null;
    if (roving) {
      roving.tabIndex = 0;
    }
    if (restored) {
      restored.focus();
    }
  }
}

// ── Sección Tareas: tablero por proyecto ────────────────────────────────

function workMember(agentId?: string | null): WorkMember | null {
  if (!agentId) return null;
  return state.workData?.team.find((member) => member.id === agentId) || null;
}

function memberChipHtml(agentId?: string | null, fallback = 'Sin asignar') {
  const member = workMember(agentId);
  if (!member) {
    return `<span class="who who-empty">${escapeHtml(fallback)}</span>`;
  }
  return `<span class="who" style="--agent-color: ${escapeHtml(member.color || '#5c5470')}">
    <span class="who-avatar" aria-hidden="true">${escapeHtml(member.name.slice(0, 1))}</span>${escapeHtml(member.name)}
  </span>`;
}

function multiline(value: string) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function taskMatchesFilters(task: WorkTask) {
  if (state.taskFilterAgent && task.agentId !== state.taskFilterAgent) return false;
  if (state.taskFilterStatus && task.status !== state.taskFilterStatus) return false;
  return true;
}

// El <select> de empleados vive en el shell: se repuebla solo si cambió el
// equipo, así cambiar el filtro no le roba el foco al usuario.
function syncTaskFilterOptions() {
  const select = byId<HTMLSelectElement>('taskFilterAgent');
  const team = state.workData?.team || [];
  const signature = team.map((member) => `${member.id}:${member.name}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.innerHTML = `<option value="">Todo el equipo</option>${team
      .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`)
      .join('')}`;
  }
  if (select.value !== state.taskFilterAgent) {
    select.value = state.taskFilterAgent;
    // Si el empleado filtrado ya no está en el equipo, volvemos a "todos".
    if (select.value !== state.taskFilterAgent) {
      state.taskFilterAgent = '';
      select.value = '';
    }
  }
  const statusSelect = byId<HTMLSelectElement>('taskFilterStatus');
  if (statusSelect.value !== state.taskFilterStatus) {
    statusSelect.value = state.taskFilterStatus;
  }
}

function renderTasksSection() {
  syncTaskFilterOptions();
  setWorkHtml('tasksBoard', renderTasksBoard());
  const data = state.workData;
  const count = data
    ? data.goals.reduce((total, goal) => total + goal.tasks.filter(taskMatchesFilters).length, 0)
    : 0;
  const filtered = Boolean(state.taskFilterAgent || state.taskFilterStatus);
  byId('tasksCount').textContent = data
    ? `${count} ${count === 1 ? 'tarea' : 'tareas'}${filtered ? ' con el filtro puesto' : ''}`
    : '';
}

function reviewChipHtml(task: WorkTask) {
  if (!task.reviewStatus) return '';
  const label = REVIEW_LABEL[task.reviewStatus] || task.reviewStatus;
  const reviewer = workMember(task.reviewerId);
  const suffix = reviewer ? ` · ${reviewer.name}` : '';
  return `<span class="review-chip ${escapeHtml(task.reviewStatus)}">${escapeHtml(label)}${escapeHtml(suffix)}</span>`;
}

function taskCardHtml(task: WorkTask): string {
  const member = workMember(task.agentId);
  const kind = task.kind && task.kind !== 'entregable'
    ? `<span class="task-kind">${escapeHtml(TASK_KIND_LABEL[task.kind] || task.kind)}</span>`
    : '';
  const comments = (task.comments || []).slice(0, 4);
  return `
    <article class="tcard" style="--agent-color: ${escapeHtml(member?.color || '#5c5470')}">
      <p class="tcard-text">${escapeHtml(task.text)}</p>
      <div class="tcard-meta">
        ${memberChipHtml(task.agentId)}
        ${kind}
        ${reviewChipHtml(task)}
        ${task.runCount > 1 ? `<span class="tcard-runs" title="Intentos">${task.runCount} intentos</span>` : ''}
      </div>
      ${task.status === 'done' && task.resultSummary
        ? `<p class="tcard-result">${escapeHtml(clip(task.resultSummary, 320))}</p>`
        : ''}
      ${task.status === 'blocked' && task.blockedReason
        ? `<p class="tcard-reason">${escapeHtml(clip(task.blockedReason, 280))}</p>`
        : ''}
      ${comments.length ? `<div class="tcard-comments">${comments.map((comment) => `
        <div class="tcomment ${escapeHtml(comment.kind)}">
          <span class="tcomment-head">${memberChipHtml(comment.authorId, 'Compañero')}<span class="tcomment-kind">${escapeHtml(
            comment.kind === 'aprobacion' ? 'aprobó' : comment.kind === 'cambios' ? 'pidió cambios' : 'comentó'
          )}</span></span>
          <span class="tcomment-text">${multiline(clip(comment.text, 420))}</span>
        </div>
      `).join('')}</div>` : ''}
    </article>
  `;
}

function goalStatusChipHtml(goal: WorkGoal) {
  if (goal.kind === 'acuerdo') {
    return '<span class="task-chip noted">Acuerdo</span>';
  }
  return `<span class="task-chip ${goal.status === 'done' ? 'done' : 'in_progress'}">${goal.status === 'done' ? 'Cumplido' : 'Activo'}</span>`;
}

function renderTasksBoard(): string {
  const data = state.workData;
  if (!data) {
    return state.workError
      ? '<div class="grid-note"><p class="muted">No pude cargar las tareas.</p><button class="btn ghost sm" data-action="work-retry" type="button">Reintentar</button></div>'
      : '<p class="muted">Cargando el tablero…</p>';
  }
  if (data.goals.length === 0) {
    return `
      <div class="ws-empty">
        <span class="ws-empty-icon" aria-hidden="true">🗂️</span>
        <h3>Todavía no hay tareas</h3>
        <p>Las tareas salen de las reuniones: charlá con el equipo, repartí trabajo y tocá <strong>Finalizar reunión</strong>. Cuando confirmes el cierre, cada proyecto aparece acá con su tablero.</p>
        <button class="btn ghost sm" type="button" data-action="ws-tab" data-tab="meeting">Ir a la reunión</button>
      </div>
    `;
  }

  const goals = sortedGoals(data.goals);
  const cards = goals.map((goal) => {
    const tasks = goal.tasks.filter(taskMatchesFilters);
    if (tasks.length === 0) return '';
    const htmlFile = (goal.files || []).find((file) => /\.html?$/i.test(file.path));
    const columns = TASK_COLUMNS.map((column) => {
      const inColumn = tasks.filter((task) => task.status === column.status);
      if (inColumn.length === 0 && !column.always) return '';
      return `
        <section class="tcol" aria-label="${escapeHtml(column.label)} — ${escapeHtml(goal.title)}">
          <header class="tcol-head">
            <span class="task-chip ${escapeHtml(column.status)}">${column.status === 'in_progress' ? '<span class="live-dot" aria-hidden="true"></span>' : ''}${escapeHtml(column.label)}</span>
            <span class="tcol-count">${inColumn.length}</span>
          </header>
          <div class="tcol-body">
            ${inColumn.length
              ? inColumn.map(taskCardHtml).join('')
              : '<p class="tcol-empty">Nada por acá.</p>'}
          </div>
        </section>
      `;
    }).join('');

    return `
      <article class="project-board">
        <header class="project-board-head">
          <span class="goal-icon" aria-hidden="true">${goal.kind === 'acuerdo' ? '🤝' : '🎯'}</span>
          <div class="goal-card-titles">
            <strong>${escapeHtml(goal.title)}</strong>
            ${goal.description ? `<p>${escapeHtml(clip(goal.description, 220))}</p>` : ''}
          </div>
          ${goalStatusChipHtml(goal)}
          ${htmlFile ? `<button class="btn ghost sm" type="button" data-action="open-preview" data-goal-id="${escapeHtml(goal.id)}" data-file-path="${escapeHtml(htmlFile.path)}">Ver el sitio</button>` : ''}
        </header>
        <div class="tboard">${columns}</div>
      </article>
    `;
  }).join('');

  if (!cards) {
    return `
      <div class="ws-empty">
        <span class="ws-empty-icon" aria-hidden="true">🔍</span>
        <h3>Ninguna tarea con ese filtro</h3>
        <p>Probá con otro empleado u otro estado.</p>
        <button class="btn ghost sm" type="button" data-action="clear-task-filters">Limpiar filtros</button>
      </div>
    `;
  }
  return cards;
}

// ── Sección Proyectos: lista + navegador integrado ──────────────────────

const projectTextCache = new Map<string, string>();
const projectTextLoading = new Set<string>();
let lastFrameKey = '';

function sortedGoals(goals: WorkGoal[]): WorkGoal[] {
  return [...goals].sort((a, b) => {
    const rank = (goal: WorkGoal) => (goal.kind === 'acuerdo' ? 2 : goal.status === 'active' ? 0 : 1);
    return rank(a) - rank(b)
      || (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0);
  });
}

function currentGoal(): WorkGoal | null {
  const goals = state.workData ? sortedGoals(state.workData.goals) : [];
  if (goals.length === 0) return null;
  return goals.find((goal) => goal.id === state.projectId) || goals[0];
}

function currentFile(goal: WorkGoal | null): WorkFile | null {
  const files = goal?.files || [];
  if (files.length === 0) return null;
  return files.find((file) => file.path === state.projectFile) || files[0];
}

function formatBytes(size: number) {
  if (!size) return '';
  return size < 1024 ? `${size} B` : `${Math.round(size / 1024)} kB`;
}

function renderProjectsSection() {
  const link = byId<HTMLAnchorElement>('workspaceLink');
  const url = state.workData?.workspaceUrl;
  link.hidden = !url;
  if (url) {
    link.href = url;
  }
  setWorkHtml('projectsList', renderProjectsList());
  setWorkHtml('browserChrome', renderBrowserChrome());
  syncBrowserStage();
}

function renderProjectsList(): string {
  const data = state.workData;
  if (!data) {
    return state.workError
      ? '<div class="grid-note"><p class="muted">No pude cargar los proyectos.</p><button class="btn ghost sm" data-action="work-retry" type="button">Reintentar</button></div>'
      : '<p class="muted">Cargando los proyectos…</p>';
  }
  const goals = sortedGoals(data.goals);
  if (goals.length === 0) {
    return '<p class="muted side-empty">Todavía no hay proyectos. Salen de las reuniones que cerrás con tareas.</p>';
  }
  const active = currentGoal();
  return goals.map((goal) => {
    const files = goal.files || [];
    const done = goal.tasks.filter((task) => task.status === 'done').length;
    const isActive = goal.id === active?.id;
    return `
      <button class="project-row${isActive ? ' is-selected' : ''}" type="button"
        data-action="select-project" data-goal-id="${escapeHtml(goal.id)}"
        aria-current="${isActive ? 'true' : 'false'}">
        <span class="project-row-icon" aria-hidden="true">${goal.kind === 'acuerdo' ? '🤝' : '🌐'}</span>
        <span class="project-row-main">
          <span class="project-row-title">${escapeHtml(goal.title)}</span>
          <span class="project-row-sub">${goal.kind === 'acuerdo'
            ? 'Acuerdo · sin archivos'
            : `${files.length} ${files.length === 1 ? 'archivo' : 'archivos'} · ${done}/${goal.tasks.length} tareas`}</span>
        </span>
        ${goal.status === 'active' && goal.kind !== 'acuerdo' ? '<span class="live-dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }).join('');
}

function renderBrowserChrome(): string {
  const goal = currentGoal();
  if (!goal || goal.kind === 'acuerdo') {
    return '';
  }
  const files = goal.files || [];
  const file = currentFile(goal);
  const viewportButtons = VIEWPORTS.map((viewport) => `
    <button class="vp-btn${state.projectViewport === viewport.id ? ' is-active' : ''}" type="button"
      data-action="browser-viewport" data-viewport="${viewport.id}"
      aria-pressed="${state.projectViewport === viewport.id}"
      title="Ver el sitio a ${escapeHtml(viewport.width)}">${escapeHtml(viewport.label)}</button>
  `).join('');

  return `
    <div class="browser-bar">
      <div class="browser-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="browser-url" title="${escapeHtml(file?.url || '')}">${escapeHtml(file ? `${goal.slug || 'general'}/${file.path}` : 'sin archivos todavía')}</span>
      <button class="icon-btn sm" type="button" data-action="browser-reload" aria-label="Recargar la vista" title="Recargar la vista" ${file ? '' : 'disabled'}>↻</button>
      <a class="icon-btn sm${file ? '' : ' is-disabled'}" href="${escapeHtml(file?.url || '#')}" target="_blank" rel="noopener" aria-label="Abrir en una pestaña nueva" title="Abrir en una pestaña nueva">↗</a>
    </div>
    <div class="browser-tools">
      ${files.length > 1 ? `
        <label class="browser-files">
          <span class="sr-only">Archivo del proyecto</span>
          <select class="form-control sm" id="browserFileSelect">
            ${files.map((item) => `<option value="${escapeHtml(item.path)}"${item.path === file?.path ? ' selected' : ''}>${escapeHtml(item.path)}${item.size ? ` · ${escapeHtml(formatBytes(item.size))}` : ''}</option>`).join('')}
          </select>
        </label>
      ` : `<span class="browser-single">${escapeHtml(file ? formatBytes(file.size) || file.path : '')}</span>`}
      <div class="vp-group" role="group" aria-label="Ancho de la vista">${viewportButtons}</div>
    </div>
  `;
}

// El <iframe> es un nodo estable del shell: solo se le toca el src cuando
// realmente cambia (recargarlo en cada tick del polling haría parpadear).
function syncBrowserStage() {
  const frame = byId<HTMLIFrameElement>('browserFrame');
  const pre = byId<HTMLPreElement>('browserText');
  const empty = byId<HTMLDivElement>('browserEmpty');
  const stage = byId<HTMLDivElement>('browserStage');
  stage.dataset.viewport = state.projectViewport;

  const goal = currentGoal();
  const showEmpty = (html: string) => {
    frame.hidden = true;
    pre.hidden = true;
    empty.hidden = false;
    if (empty.innerHTML !== html) {
      empty.innerHTML = html;
    }
    if (frame.getAttribute('src')) {
      frame.removeAttribute('src');
      lastFrameKey = '';
    }
  };

  if (!goal) {
    showEmpty(state.workData
      ? `<div class="ws-empty">
          <span class="ws-empty-icon" aria-hidden="true">🌐</span>
          <h3>Sin proyectos todavía</h3>
          <p>Cuando el equipo termine una web, se abre acá adentro sin salir de la app.</p>
        </div>`
      : '<p class="muted">Cargando…</p>');
    return;
  }

  if (goal.kind === 'acuerdo') {
    const noted = goal.tasks.filter((task) => task.status === 'noted' || task.kind === 'decision');
    showEmpty(`
      <article class="acta">
        <span class="eyebrow">Acta de acuerdo</span>
        <h3>${escapeHtml(goal.title)}</h3>
        ${goal.description ? `<p class="acta-desc">${multiline(goal.description)}</p>` : ''}
        ${(noted.length ? noted : goal.tasks).length ? `<ul class="acta-list">${(noted.length ? noted : goal.tasks)
          .map((task) => `<li>${escapeHtml(task.text)}${task.agentId ? ` <span class="acta-who">— ${escapeHtml(workMember(task.agentId)?.name || '')}</span>` : ''}</li>`)
          .join('')}</ul>` : '<p class="muted">Sin puntos anotados.</p>'}
        <p class="hint">De este acuerdo no sale nada para construir: queda registrado y nadie se pone a producir.</p>
      </article>
    `);
    return;
  }

  const file = currentFile(goal);
  if (!file) {
    showEmpty(`
      <div class="ws-empty">
        <span class="ws-empty-icon" aria-hidden="true">⏳</span>
        <h3>${escapeHtml(goal.title)}</h3>
        <p>El equipo todavía no escribió ningún archivo en este proyecto. En cuanto lo haga, aparece acá.</p>
      </div>
    `);
    return;
  }

  const isHtml = /\.html?$/i.test(file.path);
  // La clave incluye el tamaño y el contador de recargas: si el agente
  // reescribe el archivo, el iframe vuelve a pedirlo (sin caché vieja).
  const key = `${file.url}::${file.size}::${state.projectReloads}`;

  if (isHtml) {
    pre.hidden = true;
    empty.hidden = true;
    frame.hidden = false;
    frame.title = `Vista previa de ${file.path} — ${goal.title}`;
    if (lastFrameKey !== key) {
      lastFrameKey = key;
      const separator = file.url.includes('?') ? '&' : '?';
      frame.src = `${file.url}${separator}v=${encodeURIComponent(`${file.size}-${state.projectReloads}`)}`;
    }
    return;
  }

  // No-HTML: se muestra el contenido como texto plano, sin iframe.
  frame.hidden = true;
  empty.hidden = true;
  pre.hidden = false;
  const cached = projectTextCache.get(key);
  if (cached !== undefined) {
    if (pre.textContent !== cached) {
      pre.textContent = cached;
    }
    return;
  }
  pre.textContent = 'Cargando el archivo…';
  if (projectTextLoading.has(key)) return;
  projectTextLoading.add(key);
  void fetch(file.url)
    .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
    .then((text) => {
      projectTextCache.set(key, text.slice(0, 200000));
    })
    .catch(() => {
      projectTextCache.set(key, 'No pude leer este archivo.');
    })
    .finally(() => {
      projectTextLoading.delete(key);
      markDirty('work');
    });
}

function renderOrgChart(): string {
  const data = state.workData;
  if (!data) {
    return state.workError
      ? '<div class="grid-note"><p class="muted">No pude cargar el organigrama.</p><button class="btn ghost sm" data-action="work-retry" type="button">Reintentar</button></div>'
      : '<p class="muted">Cargando el organigrama…</p>';
  }
  if (data.team.length === 0) {
    return '<p class="muted">Sin equipo todavía.</p>';
  }

  const ids = new Set(data.team.map((member) => member.id));
  const rank = (member: WorkMember) => (member.role === 'ceo' ? 0 : member.role === 'contratista' ? 1 : 2);
  const sorted = [...data.team].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const children = new Map<string, WorkMember[]>();
  const roots: WorkMember[] = [];
  for (const member of sorted) {
    if (member.managerId && member.managerId !== member.id && ids.has(member.managerId)) {
      children.set(member.managerId, [...(children.get(member.managerId) || []), member]);
    } else {
      roots.push(member);
    }
  }

  const activeTasks = data.goals.filter((goal) => goal.status === 'active').flatMap((goal) => goal.tasks);
  const allTasks = data.goals.flatMap((goal) => goal.tasks);
  const seen = new Set<string>();

  const renderNode = (member: WorkMember, level: number): string => {
    if (seen.has(member.id)) return '';
    seen.add(member.id);
    const kids = children.get(member.id) || [];
    const working = activeTasks.find((task) => task.agentId === member.id && task.status === 'in_progress');
    const blocked = activeTasks.find((task) => task.agentId === member.id && task.status === 'blocked');
    const queued = activeTasks.filter((task) => task.agentId === member.id && task.status === 'pending').length;
    const doneCount = allTasks.filter((task) => task.agentId === member.id && task.status === 'done').length;

    let statusHtml: string;
    let statusLabel: string;
    if (working) {
      statusLabel = `Trabajando: ${working.text}`;
      statusHtml = `<span class="org-status working"><span class="live-dot" aria-hidden="true"></span>Trabajando: ${escapeHtml(clip(working.text, 76))}</span>`;
    } else if (blocked) {
      statusLabel = `Bloqueado${blocked.blockedReason ? `: ${blocked.blockedReason}` : ''}`;
      statusHtml = `<span class="org-status blocked" title="${escapeHtml(blocked.blockedReason || '')}">Bloqueado${blocked.blockedReason ? `: ${escapeHtml(clip(blocked.blockedReason, 64))}` : ''}</span>`;
    } else {
      statusLabel = 'En reunión';
      statusHtml = '<span class="org-status idle">En reunión</span>';
    }
    if (queued > 0) {
      statusHtml += `<span class="org-queue">${queued} en cola</span>`;
      statusLabel += ` · ${queued} en cola`;
    }

    const roleLabel = member.role === 'ceo' ? 'CEO' : member.role === 'contratista' ? 'Contratista' : '';
    const aria = `${member.name}, ${member.title}${roleLabel ? ` (${roleLabel})` : ''}. ${statusLabel}. ${doneCount} tareas completadas.`;

    return `
      <li role="treeitem" aria-level="${level}"${kids.length ? ' aria-expanded="true"' : ''}>
        <div class="org-node${working ? ' is-working' : ''}${!working && blocked ? ' is-blocked' : ''}"
          data-org-node data-agent-id="${escapeHtml(member.id)}" tabindex="-1"
          style="--agent-color: ${escapeHtml(member.color || '#5c5470')}" aria-label="${escapeHtml(aria)}">
          <span class="org-avatar" aria-hidden="true">${escapeHtml(member.name.slice(0, 1))}</span>
          <span class="org-node-main">
            <span class="org-name">${escapeHtml(member.name)}${roleBadgeHtml(member.role)}</span>
            <span class="org-title">${escapeHtml(member.title)}</span>
            <span class="org-status-line">${statusHtml}</span>
          </span>
          ${doneCount > 0 ? `<span class="org-done" title="Tareas completadas">✓ ${doneCount}</span>` : ''}
        </div>
        ${kids.length ? `<ul role="group">${kids.map((kid) => renderNode(kid, level + 1)).join('')}</ul>` : ''}
      </li>
    `;
  };

  return `<ul class="org-tree" role="tree" aria-label="Jerarquía del equipo">${roots.map((root) => renderNode(root, 1)).join('')}</ul>`;
}

function renderWorkFeed(): string {
  const items = buildFeedItems();
  if (items.length === 0) {
    return `
      <div class="ws-empty">
        <span class="ws-empty-icon" aria-hidden="true">📣</span>
        <h3>El canal está en silencio</h3>
        <p>Acá se ve quién le dijo qué a quién: quién arrancó una tarea, quién revisó el trabajo de quién y con qué comentario, qué archivos se escribieron y a quién se contrató. Empieza cuando confirmás el cierre de una reunión con tareas.</p>
      </div>
    `;
  }
  return items.map((item) => `
    <div class="feed-item">
      <span class="feed-icon" aria-hidden="true">${item.icon}</span>
      <span class="feed-text">${item.html}</span>
      <time class="feed-time" datetime="${new Date(item.at).toISOString()}">${shortTime(item.at)}</time>
    </div>
  `).join('');
}

function handleOrgKeydown(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const origin = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-org-node]') : null;
  const chart = document.getElementById('orgChart');
  if (!origin || !chart?.contains(origin)) return;
  const nodes = [...chart.querySelectorAll<HTMLElement>('[data-org-node]')];
  const index = nodes.indexOf(origin);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown'
    ? nodes[Math.min(nodes.length - 1, index + 1)]
    : event.key === 'ArrowUp'
      ? nodes[Math.max(0, index - 1)]
      : event.key === 'Home'
        ? nodes[0]
        : nodes[nodes.length - 1];
  if (next && next !== origin) {
    origin.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }
}

// Modal de validación del cierre: la meta, quién hace qué y qué se va a
// contratar. Confirmar manda confirm_end_meeting; "Seguir conversando"
// solo cierra el modal.
function openClosingModal() {
  const summary = state.closingSummary;
  if (!summary) return;
  const agentById = (id: string) => state.agents.find((agent) => agent.id === id);
  byId('closeMeetingBody').innerHTML = `
    <p class="close-intro">${summary.producesWork
      ? 'Esto es lo que el equipo entendió de la reunión. Si está bien, confirmá y se ponen a trabajar en segundo plano; si falta algo, seguí conversando.'
      : 'De esta reunión no sale nada para construir: quedan los acuerdos anotados en el historial de la empresa. Nadie se pone a producir.'}</p>
    <section class="close-goal" aria-label="Meta de la reunión">
      <span class="eyebrow">${summary.producesWork ? 'Proyecto' : 'Acuerdo'}</span>
      <h3>${escapeHtml(summary.goalTitle)}</h3>
      ${summary.goalDescription ? `<p>${escapeHtml(summary.goalDescription)}</p>` : ''}
    </section>
    <section class="close-assignments" aria-label="Asignaciones por empleado">
      <span class="eyebrow">${summary.producesWork ? 'Quién hace qué' : 'Qué quedó anotado'}</span>
      ${summary.assignments.length ? summary.assignments.map((assignment) => `
        <article class="assign-card" style="--agent-color: ${escapeHtml(agentById(assignment.agentId)?.color || state.company?.color || '#31655a')}">
          <span class="org-avatar" aria-hidden="true">${escapeHtml(assignment.agentName.slice(0, 1))}</span>
          <div class="assign-info">
            <strong>${escapeHtml(assignment.agentName)}${roleBadgeHtml(agentById(assignment.agentId)?.role)}</strong>
            <ul>${assignment.tasks.map((task) => `<li>${escapeHtml(task.text)}${task.kind && task.kind !== 'entregable' ? ` <span class="task-kind">${escapeHtml(TASK_KIND_LABEL[task.kind] || task.kind)}</span>` : ''}</li>`).join('')}</ul>
          </div>
        </article>
      `).join('') : '<p class="muted">No quedaron tareas pendientes asignadas. Podés confirmar igual (la reunión se archiva) o volver y repartir trabajo.</p>'}
    </section>
    ${summary.hires.length ? `
      <section class="close-hires" aria-label="Contrataciones detectadas">
        <span class="eyebrow">Se va a contratar</span>
        ${summary.hires.map((hire) => `<div class="hire-row"><span aria-hidden="true">🧑‍💼</span><span>${escapeHtml(hire.need)}</span></div>`).join('')}
        <p class="hint">El contratista va a crear a la persona ideal para cada necesidad y le va a asignar su primera tarea.</p>
      </section>
    ` : ''}
  `;
  byId('confirmCloseBtn').textContent = summary.producesWork
    ? 'Confirmar y ponerlos a trabajar'
    : 'Confirmar y cerrar';
  openModal('closeMeetingModal');
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Acciones del composer ───────────────────────────────────────────────

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

  const message = payload as { type?: string; text?: string; transcriptHint?: string };
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

// Empleados afectados por la falla sistémica en curso (se limpia al recuperarse).
const systemicScopes = new Set<string>();

function isSystemicFailure(message: string): boolean {
  return /clave|api key|cuota|quota|rate.?limit|429|401|sin conexion|sin conexión|no configurad/i.test(message || '');
}

function upsertAlert(
  id: string,
  scope: string,
  message: string,
  tone: StatusAlert['tone'],
  timeout?: number,
  action?: StatusAlert['action']
) {
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
    existing.action = action;
  } else {
    state.alerts.push({ id, scope, message, tone, action });
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

function dismissAlert(id: string) {
  if (!id) return;
  const alert = state.alerts.find((item) => item.id === id);
  if (!alert) return;
  if (alert.timeout) {
    window.clearTimeout(alert.timeout);
  }
  state.alerts = state.alerts.filter((item) => item.id !== id);
  markDirty('alerts');
}

function resolveAlertIfPresent(id: string, scope: string, message: string) {
  if (!state.alerts.some((alert) => alert.id === id)) {
    return;
  }
  upsertAlert(id, scope, message, 'ok', 1400);
}

// ── Captura de voz ──────────────────────────────────────────────────────

function stopVoiceCapture() {
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
}

async function toggleLiveAudio() {
  if (state.recording) {
    stopVoiceCapture();
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
    state.voiceStatus = 'Preparando el micrófono…';
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
    const asrSupported = state.browserSpeech.start();
    if (!asrSupported) {
      upsertAlert('asr', 'Voz', 'Este navegador no tiene reconocimiento de voz local; los turnos de voz pueden salir vacíos.', 'working', 4600);
    }
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

// ── Helpers de transcript/estado ────────────────────────────────────────

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

function setVoiceStatus(message: string, timeoutMs = 0) {
  window.clearTimeout(voiceStatusTimer);
  state.voiceStatus = message;

  if (timeoutMs > 0) {
    voiceStatusTimer = window.setTimeout(() => {
      state.voiceStatus = state.recording ? VOICE_READY : '';
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

function relativeTime(iso?: string) {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'activa recién';
  if (minutes < 60) return `activa hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `activa hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `activa hace ${days} ${days === 1 ? 'día' : 'días'}`;
  return `última actividad: ${date.toLocaleDateString()}`;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendHttpBase()}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
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

// ── Íconos ──────────────────────────────────────────────────────────────

function micIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm7-4a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11Z"/></svg>`;
}

function stopIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
}

function pauseIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Zm8 0a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Z"/></svg>`;
}

function playIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
}

function sendIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 20.3 22 12 3.7 3.7 3 10.2l10 1.8-10 1.8.7 6.5Z"/></svg>`;
}

function pencilIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
}

function trashIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
}

function archiveIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.54 5.23 19.15 3.55A1.98 1.98 0 0 0 17.6 3H6.4c-.6 0-1.16.2-1.55.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27ZM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5ZM5.12 5l.81-1h12l.94 1H5.12Z"/></svg>`;
}

function brainIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7zm-3 16h6v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-1z"/></svg>`;
}

function bookIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 2H8a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h11a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Zm-1 16H8a1 1 0 0 0-1 1V5a1 1 0 0 1 1-1h9v14Z"/></svg>`;
}

function closeIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
}

function gearIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96c-.5-.38-1.04-.7-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.21.1.48.01.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"/></svg>`;
}

function eyeIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5ZM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>`;
}

function eyeOffIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.82 11.82 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7ZM2.71 3.16a1 1 0 0 0-1.42 1.41l1.97 1.97A11.77 11.77 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.52 0 2.98-.3 4.32-.82l2.72 2.72a1 1 0 0 0 1.42-1.42L2.71 3.16ZM12 17a5 5 0 0 1-5-5c0-.77.18-1.5.49-2.14l1.57 1.57a3 3 0 0 0 3.51 3.51l1.57 1.57c-.64.31-1.37.49-2.14.49Z"/></svg>`;
}

function chevronIcon() {
  return `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;
}

// ── Bootstrap (al final: las regiones usan const no-hoisted) ────────────

mountShell();
render();
void loadCompanies();
trace('page_loaded', {
  userAgent: navigator.userAgent,
  viewport: { width: window.innerWidth, height: window.innerHeight }
});
