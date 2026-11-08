// Adaptador Sofia ↔ protocolo Equipo (WebSocket meetings + HTTP api).
// Habla el mismo backend que la UI clásica; solo cambia la cara.

import { desktopApiBase } from '../lib/tauri.ts';

let httpBase = '';

// Desktop empaquetado: el sidecar vive en puerto efímero. Resolver una
// vez en el arranque, antes del primer fetch (igual que la UI clásica).
export async function resolveBase(): Promise<void> {
  httpBase = await desktopApiBase();
}

export function apiBase(): string {
  return httpBase;
}

export interface SofiaAgent {
  id: string;
  name: string;
  title?: string;
  role?: string;
}

export interface BackendEvents {
  onReady: (agents: SofiaAgent[]) => void;
  onUserText: (text: string) => void;
  onRoute: (names: string[]) => void;
  onAgentStart: (agentId: string) => void;
  onDelta: (agentId: string, delta: string) => void;
  onAgentEnd: (agentId: string, text: string) => void;
  onMp3: (agentId: string, base64: string) => void;
  onPcm: (base64: string, rate: number) => void;
  onAudioStart: (agentId: string) => void;
  onAudioEnd: () => void;
  onNoResponse: (note: string) => void;
  onVoiceTranscript: (text: string, source: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(httpBase + path, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} en ${path}`);
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

export class SofiaBackend {
  private ws: WebSocket | null = null;
  private ev: BackendEvents;

  constructor(events: BackendEvents) {
    this.ev = events;
  }

  connect(companyId: string, goalId: string): void {
    this.close();
    const url = httpBase
      ? `${httpBase.replace(/^http/, 'ws')}/meeting`
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/meeting`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', companyId, goalId }));
    };
    ws.onmessage = (event) => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (message.type) {
        case 'meeting_ready':
          this.ev.onReady((message.agents || []) as SofiaAgent[]);
          break;
        case 'agents_updated':
          this.ev.onReady((message.agents || []) as SofiaAgent[]);
          break;
        case 'user_turn_received':
          if (message.text) this.ev.onUserText(String(message.text));
          break;
        case 'route_decision':
          this.ev.onRoute(((message.route?.targets || []) as Array<{ name?: string }>).map((t) => t.name || ''));
          break;
        case 'agent_turn_start':
          this.ev.onAgentStart(String(message.agentId || ''));
          break;
        case 'agent_transcript_delta':
          this.ev.onDelta(String(message.agentId || ''), String(message.delta || ''));
          break;
        case 'agent_audio_start':
          this.ev.onAudioStart(String(message.agentId || ''));
          break;
        case 'agent_audio_chunk':
          this.ev.onPcm(String(message.data || ''), parseRate(message.mimeType));
          break;
        case 'agent_audio_mp3':
          this.ev.onMp3(String(message.agentId || ''), String(message.data || ''));
          break;
        case 'agent_audio_end':
          this.ev.onAudioEnd();
          break;
        case 'agent_turn_complete':
          this.ev.onAgentEnd(String(message.agentId || ''), String(message.text || ''));
          break;
        case 'agent_silence':
          this.ev.onAgentEnd(String(message.agentId || ''), '');
          break;
        case 'no_agent_response':
          this.ev.onNoResponse(String(message.note || 'Nadie respondió.'));
          break;
        case 'user_audio_turn_final':
          if (message.text) this.ev.onVoiceTranscript(String(message.text), String(message.source || ''));
          break;
        case 'audio_transcription_empty':
          this.ev.onError('No te escuché; probá de nuevo.');
          break;
        case 'error':
          this.ev.onError(String(message.message || message.detail || 'Error.'));
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

  audioStart(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_start' }));
  }

  audioChunk(base64: string): void {
    this.ws?.send(JSON.stringify({ type: 'audio_chunk', data: base64, mimeType: 'audio/pcm;rate=16000' }));
  }

  audioEnd(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_end' }));
  }

  audioCancel(): void {
    this.ws?.send(JSON.stringify({ type: 'audio_cancel', reason: 'client_ptt_empty' }));
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
