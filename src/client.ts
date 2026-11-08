// Cliente Sofia ↔ backend Equipo (HTTP + WebSocket). Delgado: la UI vive en app.ts.

import { desktopApiBase } from './lib/tauri.ts';

export interface Agent {
  id: string;
  name: string;
  title?: string;
  role?: string;
  color?: string;
}

export interface ClientEvents {
  onReady: (agents: Agent[], meetingId?: string) => void;
  onUserText: (text: string) => void;
  onRoute: (names: string[]) => void;
  onAgentStart: (agentId: string) => void;
  onDelta: (agentId: string, delta: string) => void;
  onAgentEnd: (agentId: string, text: string) => void;
  onMp3: (base64: string) => void;
  onPcm: (base64: string, rate: number) => void;
  onAudioStart: (turnId: string, agentId: string) => void;
  onAudioEnd: (turnId: string, agentId: string) => void;
  onAgentState: (agentId: string, state: string) => void;
  onInterrupted: (agentId: string) => void;
  onWorkEvent: (kind: string, agentId: string) => void;
  onLiveTranscript: (text: string) => void;
  onNoResponse: (note: string) => void;
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

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(httpBase + path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function findOrCreateSofiaSpace(): Promise<{ companyId: string; goalId: string }> {
  const data = await apiJson<{ companies: Array<{ id: string; name: string }> }>('/api/companies');
  let company = (data.companies || []).find((c) => c.name === 'Sofia');
  if (!company) {
    const created = await apiJson<{ company: { id: string } }>('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'sofia' })
    });
    company = { id: created.company.id, name: 'Sofia' };
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

/** MP3 directo del servidor (Edge): para "probar voz" sin gastar turno LLM. */
export async function decir(texto: string): Promise<string> {
  const data = await apiJson<{ audio?: string }>(
    `/api/decir?texto=${encodeURIComponent(texto)}`
  );
  if (!data.audio) {
    throw new Error('sin audio');
  }
  return data.audio;
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
      // Sofia habla: sin esto el servidor jamás emite audio (voiceEnabled).
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
          if (m.text) this.ev.onUserText(String(m.text));
          break;
        case 'route_decision':
          this.ev.onRoute(((m.route?.targets || []) as Array<{ name?: string }>).map((t) => t.name || ''));
          break;
        case 'agent_turn_start':
          this.ev.onAgentStart(String(m.agentId || ''));
          break;
        case 'agent_transcript_delta':
          this.ev.onDelta(String(m.agentId || ''), String(m.delta || ''));
          break;
        case 'agent_audio_chunk':
          this.ev.onPcm(String(m.data || ''), parseRate(m.mimeType));
          break;
        case 'agent_audio_mp3':
          this.ev.onMp3(String(m.data || ''));
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
        case 'agent_interrupted':
        case 'turn_cancelled':
          this.ev.onInterrupted(String(m.agentId || ''));
          break;
        case 'work_event':
          this.ev.onWorkEvent(String(m.kind || (m as { event?: string }).event || ''), String((m as { agentId?: string }).agentId || ''));
          break;
        case 'user_audio_transcript_delta':
          if (m.delta || m.text) this.ev.onLiveTranscript(String(m.delta || m.text));
          break;
        case 'agent_turn_complete':
          this.ev.onAgentEnd(String(m.agentId || ''), String(m.text || ''));
          break;
        case 'agent_silence':
          this.ev.onAgentEnd(String(m.agentId || ''), '');
          break;
        case 'no_agent_response':
          this.ev.onNoResponse(String(m.note || 'Nadie respondió.'));
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

  sendText(text: string): void {
    this.ws?.send(JSON.stringify({ type: 'user_turn', text }));
  }

  setVoice(enabled: boolean): void {
    this.ws?.send(JSON.stringify({ type: 'set_voice', enabled }));
  }

  audioPrepare(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_prepare' }));
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

  interrupt(turnId?: string, agentId?: string): void {
    this.ws?.send(JSON.stringify({ type: 'interrupt', reason: 'barge_in', turnId, agentId }));
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
      // Ya cerrado.
    }
    this.ws = null;
  }
}

function parseRate(mimeType: unknown): number {
  const match = String(mimeType || '').match(/rate=(\d+)/);
  return match ? Number(match[1]) : 44100;
}
