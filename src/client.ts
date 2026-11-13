// Pablo client ↔ Equipo backend (HTTP + WebSocket). Thin: UI lives in app.ts.

import { desktopApiBase } from './lib/tauri.ts';
import { audioTagFromEvent, type AudioTag } from './lib/heard-text.ts';

export interface Agent {
  id: string;
  name: string;
  title?: string;
  role?: string;
  color?: string;
}

export interface ClientEvents {
  onReady: (agents: Agent[], meetingId?: string) => void;
  // source tells normal text apart from system notices ('X has joined').
  onUserText: (text: string, source?: string, turnId?: string) => void;
  onRoute: (names: string[]) => void;
  onAgentStart: (agentId: string, turnId?: string) => void;
  onSpeakStart: (agentId: string) => void;
  onProgress: (agentId: string, text: string) => void;
  // Live tool activity: compact feed, not main chat.
  onToolCall: (agentId: string, tool: string, argsPreview: string, turnId?: string) => void;
  onToolDone: (agentId: string, tool: string, ok: boolean, ms: number, outputPreview: string, turnId?: string) => void;
  onDelta: (agentId: string, delta: string) => void;
  onAgentEnd: (agentId: string, text: string, turnId?: string) => void;
  onMp3: (base64: string, turnId?: string, tag?: AudioTag | null) => void;
  onPcm: (base64: string, rate: number, turnId?: string, tag?: AudioTag | null) => void;
  onAudioStart: (turnId: string, agentId: string) => void;
  onAudioEnd: (turnId: string, agentId: string) => void;
  onAgentState: (agentId: string, state: string) => void;
  // Semantic gesture v2: the model asked to morph the orb into a glyph.
  onGesto: (agentId: string, gesto: string) => void;
  onFigure: (agentId: string, figure: unknown, turnId?: string) => void;
  onInterrupted: (agentId: string, turnId?: string) => void;
  onWorkEvent: (kind: string, agentId: string, event: Record<string, unknown>) => void;
  onLiveTranscript: (text: string) => void;
  onAutoWorkChanged: (enabled: boolean) => void;
  onNoResponse: (note: string, turnId?: string) => void;
  onVoiceTranscript: (text: string, source: string) => void;
  onTranscribeEmpty: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

let httpBase = '';

export async function resolveBase(): Promise<void> {
  httpBase = await desktopApiBase();
}

export function apiBase(): string {
  return httpBase;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(httpBase + path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function findOrCreatePabloSpace(): Promise<{ companyId: string; goalId: string }> {
  const data = await apiJson<{ companies: Array<{ id: string; name: string }> }>('/api/companies');
  // Legacy 'Sofia': the DB may still be unmigrated.
  let company = (data.companies || []).find((c) => c.name === 'Pablo' || c.name === 'Sofia');
  if (!company) {
    const created = await apiJson<{ company: { id: string } }>('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'pablo' })
    });
    company = { id: created.company.id, name: 'Pablo' };
  }
  const projects = await apiJson<{ projects: Array<{ id: string; title: string }> }>(
    `/api/companies/${encodeURIComponent(company.id)}/projects`
  );
  let project = (projects.projects || []).find((p) => p.title === 'Siempre') || projects.projects?.[0];
  if (!project) {
    const created = await apiJson<{ project: { id: string } }>(
      `/api/companies/${encodeURIComponent(company.id)}/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Siempre' })
      }
    );
    project = { id: created.project.id, title: 'Siempre' };
  }
  return { companyId: company.id, goalId: project.id };
}

export async function listCompanies(): Promise<Array<{ id: string; name: string }>> {
  const data = await apiJson<{ companies: Array<{ id: string; name: string }> }>('/api/companies');
  return data.companies || [];
}

export async function firstProject(companyId: string): Promise<string | null> {
  const data = await apiJson<{ projects: Array<{ id: string }> }>(
    `/api/companies/${encodeURIComponent(companyId)}/projects`
  );
  return data.projects?.[0]?.id || null;
}

/** Direct MP3 from the server (Edge): for "probar voz" without spending an LLM turn. */
export async function decir(texto: string): Promise<string> {
  const data = await apiJson<{ audio?: string }>(
    `/api/decir?texto=${encodeURIComponent(texto)}`
  );
  if (!data.audio) {
    throw new Error('no audio');
  }
  return data.audio;
}

export interface ProviderOption {
  id: string;
  label: string;
}

export interface PublicSettings {
  llm: {
    provider: string;
    providerOptions: ProviderOption[];
    apiKeySet: boolean;
    apiKeyMasked: string;
    deepseekKeySet: boolean;
    deepseekKeyMasked: string;
    opencodeKeySet: boolean;
    opencodeKeyMasked: string;
    groqKeySet: boolean;
    groqKeyMasked: string;
    model: string;
    modelOptions: string[];
    customModels: string;
    failover: string;
    failoverResolved: string[];
  };
  energy: { mode: string };
  split: { mode: string; vps: string };
  channels: {
    telegram: { enabled: boolean; botTokenSet: boolean; botTokenMasked: string; titoId: string; mode: string; allow: string; autoRespond: string };
    whatsapp: { enabled: boolean; tokenSet: boolean; tokenMasked: string; phoneId: string; titoId: string; mode: string; allow: string };
  };
  stt: {
    provider: string;
    providerOptions: string[];
    order: string;
    orderDefault: string;
    whisperModel: string;
    whisperModelOptions: string[];
    groqKeySet: boolean;
    groqKeyMasked: string;
    deepgramKeySet: boolean;
    deepgramKeyMasked: string;
    language: string;
    minConfidence: number;
  };
  tts: { engine: string; engineOptions: string[]; order: string; orderDefault: string; language: string; url: string; speed: number; piperUrl: string };
  audio: { output: string; input: string; followDefault: boolean };
}

export async function getSettings(): Promise<PublicSettings> {
  const data = await apiJson<{ settings: PublicSettings }>('/api/settings');
  return data.settings;
}

export async function saveSettings(patch: Record<string, string>): Promise<PublicSettings> {
  const data = await apiJson<{ settings: PublicSettings }>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  return data.settings;
}

// STT/TTS sidecar watchdog state (direct fetch, no WS).
// Mirrors server/lib/sidecars.js getSidecarStatus (read-only).
export interface SidecarStatus {
  name: string;
  status: string;
  downs: number;
  restartsLastHour: number;
  lastSpawnAt: string | null;
  elected?: boolean | null;
  autostart: boolean;
}

export async function getSidecars(): Promise<SidecarStatus[]> {
  const data = await apiJson<{ sidecars: SidecarStatus[] }>('/api/sidecars');
  return data.sidecars || [];
}

// Audio routing (PipeWire): mirrors server/lib/audio.js listDevices.
export interface AudioDevice {
  id: number;
  name: string;
  description: string;
  volume: number | null;
  muted: boolean | null;
  isDefault: boolean;
}

export interface AudioStream {
  id: number;
  nodeName: string;
  app: string;
  mediaClass: string;
  driverId: number | null;
}

export interface AudioDevices {
  sinks: AudioDevice[];
  sources: AudioDevice[];
  streams: AudioStream[];
  backend: string;
  available: boolean;
}

export async function getAudioDevices(): Promise<AudioDevices> {
  const data = await apiJson<{ devices: AudioDevices }>('/api/audio/devices');
  return data.devices;
}

export async function setAudioVolume(id: number | string, volume: number): Promise<void> {
  await apiJson('/api/audio/volume', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, volume })
  });
}

export async function setAudioMute(id: number | string, muted: boolean): Promise<void> {
  await apiJson('/api/audio/mute', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, muted })
  });
}

export async function testAudioOutput(sink?: string): Promise<void> {
  await apiJson('/api/audio/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sink: sink || '' })
  });
}

export class Client {
  private ws: WebSocket | null = null;
  private ev: ClientEvents;

  constructor(events: ClientEvents) {
    this.ev = events;
  }

  connect(companyId: string, goalId: string, meetingId?: string): void {
    this.close();
    const url = httpBase
      ? `${httpBase.replace(/^http/, 'ws')}/meeting`
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/meeting`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', companyId, goalId, meetingId: meetingId || undefined }));
      // Pablo speaks: without this the server never emits audio (voiceEnabled).
      ws.send(JSON.stringify({ type: 'set_voice', enabled: true }));
    };
    ws.onmessage = (event) => {
      let m: Record<string, any>;
      try {
        m = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (m.type) {
        case 'meeting_ready':
          this.ev.onReady((m.agents || []) as Agent[], String(m.meetingId || ''));
          break;
        case 'agents_updated':
          this.ev.onReady((m.agents || []) as Agent[]);
          break;
        case 'user_turn_received':
          if (m.text) this.ev.onUserText(String(m.text), typeof m.source === 'string' ? m.source : undefined, optStr(m.turnId));
          break;
        case 'route_decision':
          this.ev.onRoute(((m.route?.targets || []) as Array<{ name?: string }>).map((t) => t.name || ''));
          break;
        case 'agent_turn_start':
          this.ev.onAgentStart(String(m.agentId || ''), optStr(m.turnId));
          break;
        case 'agent_speak_start':
          this.ev.onSpeakStart(String(m.agentId || ''));
          break;
        case 'agent_progress':
          this.ev.onProgress(String(m.agentId || ''), String(m.text || ''));
          break;
        case 'agent_tool_call':
          this.ev.onToolCall(String(m.agentId || ''), String(m.tool || ''), String(m.argsPreview || ''), optStr(m.turnId));
          break;
        case 'agent_tool_done':
          this.ev.onToolDone(
            String(m.agentId || ''),
            String(m.tool || ''),
            Boolean(m.ok),
            Number(m.ms) || 0,
            String(m.outputPreview || ''),
            optStr(m.turnId)
          );
          break;
        case 'agent_transcript_delta':
          this.ev.onDelta(String(m.agentId || ''), String(m.delta || ''));
          break;
        case 'agent_audio_chunk':
          this.ev.onPcm(String(m.data || ''), parseRate(m.mimeType), optStr(m.turnId), audioTagFromEvent(m));
          break;
        case 'agent_audio_mp3':
          this.ev.onMp3(String(m.data || ''), optStr(m.turnId), audioTagFromEvent(m));
          break;
        case 'agent_audio_start':
          this.ev.onAudioStart(String(m.turnId || ''), String(m.agentId || ''));
          break;
        case 'agent_audio_end':
          this.ev.onAudioEnd(String(m.turnId || ''), String(m.agentId || ''));
          break;
        case 'agent_state':
          this.ev.onAgentState(String(m.agentId || ''), String(m.state || ''));
          break;
        case 'agent_gesto':
          if (m.gesto) this.ev.onGesto(String(m.agentId || ''), String(m.gesto));
          break;
        case 'agent_figure':
          if (m.figure) this.ev.onFigure(String(m.agentId || ''), m.figure, optStr(m.turnId));
          break;
        case 'agent_interrupted':
        case 'turn_cancelled':
          this.ev.onInterrupted(String(m.agentId || ''), optStr(m.turnId));
          break;
        case 'work_event':
          this.ev.onWorkEvent(String(m.kind || ''), String((m as { agentId?: string }).agentId || ''), m as Record<string, unknown>);
          break;
        case 'user_audio_transcript_delta':
          if (m.delta || m.text) this.ev.onLiveTranscript(String(m.delta || m.text));
          break;
        case 'auto_work_changed':
          this.ev.onAutoWorkChanged(Boolean(m.enabled));
          break;
        case 'agent_turn_complete':
          this.ev.onAgentEnd(String(m.agentId || ''), String(m.text || ''), optStr(m.turnId));
          break;
        case 'agent_silence':
          this.ev.onAgentEnd(String(m.agentId || ''), '', optStr(m.turnId));
          break;
        case 'no_agent_response':
          this.ev.onNoResponse(String(m.note || 'No one answered.'), optStr(m.turnId));
          break;
        case 'user_audio_turn_final':
          if (m.text) this.ev.onVoiceTranscript(String(m.text), String(m.source || ''));
          break;
        case 'audio_transcription_empty':
          this.ev.onTranscribeEmpty();
          break;
        case 'error':
          this.ev.onError(String(m.message || m.detail || 'Error.'));
          break;
        default:
          break;
      }
    };
    ws.onclose = () => this.ev.onClose();
  }

  // M-05: turnId de cliente para eco optimista + steer explícito.
  sendText(text: string, opts: { steer?: boolean } = {}): string {
    const turnId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`).slice(0, 16);
    this.ws?.send(JSON.stringify({
      type: 'user_turn',
      text,
      turnId,
      ...(opts.steer ? { steer: true } : {})
    }));
    return turnId;
  }

  setVoice(enabled: boolean): void {
    this.ws?.send(JSON.stringify({ type: 'set_voice', enabled }));
  }

  // E-06: group=true = llamada grupal (el servidor convoca a todos).
  audioPrepare(group = false): void {
    this.ws?.send(JSON.stringify({ type: 'audio_prepare', ...(group ? { group: true } : {}) }));
  }

  audioStart(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_start' }));
  }

  audioChunk(base64: string): void {
    this.ws?.send(JSON.stringify({ type: 'audio_chunk', data: base64, mimeType: 'audio/pcm;rate=16000' }));
  }

  audioEnd(hint?: string): void {
    this.ws?.send(JSON.stringify({ type: 'audio_end', transcriptHint: hint || undefined }));
  }

  audioCancel(reason: string, speechMs: number): void {
    this.ws?.send(JSON.stringify({ type: 'audio_cancel', reason, speechMs }));
  }

  audioStop(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_stop' }));
  }

  // M-06: hint semántico opcional {cls, text} para telemetría del servidor.
  interrupt(turnId?: string, agentId?: string, hint?: { cls: string; text: string }): void {
    this.ws?.send(JSON.stringify({ type: 'interrupt', reason: 'barge_in', turnId, agentId, ...(hint ? { hint } : {}) }));
  }

  /** Client voice telemetry (VAD/barge per turn): for tuning
   *  thresholds with real data instead of guessing. Fire-and-forget.
   *  §3a: mixed values (numbers + reopened:boolean + hintEnd:string). */
  voiceStats(stats: Record<string, number | string | boolean>): void {
    this.ws?.send(JSON.stringify({ type: 'client_stats', stats }));
  }

  playbackComplete(turnId: string, agentId: string): void {
    this.ws?.send(JSON.stringify({ type: 'playback_complete', turnId, agentId }));
  }

  setAutoWork(enabled: boolean): void {
    this.ws?.send(JSON.stringify({ type: 'set_auto_work', enabled }));
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
  }
}

function optStr(value: unknown): string | undefined {
  const s = String(value || '');
  return s ? s : undefined;
}

function parseRate(mimeType: unknown): number {
  const match = String(mimeType || '').match(/rate=(\d+)/);
  return match ? Number(match[1]) : 44100;
}
