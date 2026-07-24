// Protocolo WebSocket compartido entre server (Node, type-stripping nativo)
// y cliente (Vite). Única fuente de verdad: todo tipo de mensaje nuevo se
// declara acá y se valida acá.

export const GEMINI_VOICES = ['Charon', 'Aoede', 'Fenrir', 'Puck', 'Kore'] as const;
export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export const LIMITS = {
  turnText: 4000,
  agentName: 40,
  agentTitle: 80,
  agentStyle: 500,
  listItems: 12,
  listItemLength: 60,
  boundaryLength: 200,
  initialTasks: 20,
  taskText: 300,
  audioChunkBase64: 262144,
  transcriptHint: 2000,
  maxAgents: 8
} as const;

export interface AgentTask {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
}

export interface PublicAgent {
  id: string;
  name: string;
  title: string;
  color: string;
  domains: string[];
  aliases: string[];
  boundaries: string[];
  style: string;
  voice: string;
  tasks: AgentTask[];
}

export interface RouteTarget {
  agentId: string;
  name: string;
  score: number;
  directMention: boolean;
  mentionIndex?: number;
  matchedDomains: string[];
}

export interface RouteDecision {
  closing?: boolean;
  greeting?: boolean;
  groupAddressed?: boolean;
  responses: Array<{ agentId: string; name: string; text: string }>;
  targets: RouteTarget[];
  reason: string;
}

export interface KeyStatus {
  id: string;
  available: boolean;
  cooldownSeconds: number;
  failures: number;
  lastError: string | null;
}

export interface SpawnAgentPayload {
  name: string;
  title: string;
  color?: string;
  aliases?: string[] | string;
  domains?: string[] | string;
  boundaries?: string[] | string;
  style?: string;
  voice?: string;
  initialTasks?: string[];
}

export type ClientMessage =
  | { type: 'user_turn'; text: string }
  | { type: 'audio_prepare' }
  | { type: 'audio_start' }
  | { type: 'audio_chunk'; data: string; mimeType?: string }
  | { type: 'audio_end'; transcriptHint?: string }
  | { type: 'audio_cancel'; reason?: string; speechMs?: number }
  | { type: 'audio_stop' }
  | { type: 'reset' }
  | { type: 'health' }
  | { type: 'spawn_agent'; agent: SpawnAgentPayload }
  | { type: 'add_task'; agentId: string; text: string }
  | { type: 'toggle_task'; agentId: string; taskId: string; completed: boolean }
  | { type: 'delete_task'; agentId: string; taskId: string };

export type ServerMessage =
  | { type: 'meeting_ready'; id: string; agents: PublicAgent[]; model: string; liveMode: boolean }
  | { type: 'meeting_reset' }
  | { type: 'meeting_warmup_start' }
  | { type: 'meeting_warmup_complete'; ok: boolean; failures: number }
  | { type: 'agents_updated'; agents: PublicAgent[] }
  | { type: 'user_turn_received'; turnId: string; text: string; source: 'text' | 'audio' | 'system' }
  | { type: 'route_decision'; turnId: string; route: RouteDecision }
  | { type: 'no_agent_response'; turnId: string; note: string }
  | { type: 'agent_turn_start'; turnId: string; agentId: string }
  | { type: 'agent_transcript_delta'; turnId: string; agentId: string; delta: string }
  | { type: 'agent_audio_chunk'; turnId: string; agentId: string; data: string; mimeType?: string }
  | {
      type: 'agent_turn_complete';
      turnId: string;
      agentId: string;
      text: string;
      usedMock?: boolean;
      keyStatus?: KeyStatus[];
    }
  | { type: 'agent_silence'; turnId: string; agentId: string; reason: string }
  | { type: 'audio_listening_start' }
  | { type: 'audio_listening_stop' }
  | { type: 'user_audio_transcript_delta'; delta: string; text: string }
  | { type: 'user_audio_turn_final'; text: string; source: 'live' | 'fallback' | 'client' }
  | { type: 'audio_transcription_status'; message: string }
  | { type: 'audio_transcription_empty'; message: string }
  | { type: 'api_rotation_start'; scope: string; message: string; turnId?: string; agentId?: string }
  | { type: 'api_rotation_resolved'; scope: string; keyId: string; model?: string; turnId?: string; agentId?: string }
  | { type: 'api_rotation_failed'; scope: string; message: string; turnId?: string; agentId?: string }
  | { type: 'health'; keys: KeyStatus[]; memory: { turns: number; lastTurns: unknown[] } }
  | { type: 'error'; message: string; detail?: string; turnId?: string };

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cappedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length > max) {
    return null;
  }
  return value;
}

function optionalCappedString(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  return cappedString(value, max);
}

function toStringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (!items) {
    return null;
  }
  const clean = items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (clean.length > maxItems || clean.some((item) => item.length > maxLength)) {
    return null;
  }
  return clean;
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'JSON inválido.' };
    }
  }

  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'Mensaje sin tipo.' };
  }

  switch (value.type) {
    case 'user_turn': {
      const text = cappedString(value.text, LIMITS.turnText);
      if (text === null) {
        return { ok: false, error: `Texto de turno inválido o mayor a ${LIMITS.turnText} caracteres.` };
      }
      return { ok: true, message: { type: 'user_turn', text } };
    }

    case 'audio_prepare':
    case 'audio_start':
    case 'audio_stop':
    case 'reset':
    case 'health':
      return { ok: true, message: { type: value.type } };

    case 'audio_chunk': {
      const data = cappedString(value.data, LIMITS.audioChunkBase64);
      if (data === null || data.length === 0) {
        return { ok: false, error: 'Chunk de audio inválido o demasiado grande.' };
      }
      const mimeType = optionalCappedString(value.mimeType, 80);
      if (mimeType === null) {
        return { ok: false, error: 'mimeType inválido.' };
      }
      return { ok: true, message: { type: 'audio_chunk', data, mimeType } };
    }

    case 'audio_end': {
      const transcriptHint = optionalCappedString(value.transcriptHint, LIMITS.transcriptHint);
      if (transcriptHint === null) {
        return { ok: false, error: 'transcriptHint demasiado largo.' };
      }
      return { ok: true, message: { type: 'audio_end', transcriptHint } };
    }

    case 'audio_cancel': {
      const reason = optionalCappedString(value.reason, 80);
      if (reason === null) {
        return { ok: false, error: 'reason inválido.' };
      }
      const speechMs = typeof value.speechMs === 'number' && Number.isFinite(value.speechMs)
        ? value.speechMs
        : undefined;
      return { ok: true, message: { type: 'audio_cancel', reason, speechMs } };
    }

    case 'spawn_agent': {
      if (!isRecord(value.agent)) {
        return { ok: false, error: 'Falta el objeto agent.' };
      }
      const agent = value.agent;
      const name = cappedString(agent.name, LIMITS.agentName);
      const title = cappedString(agent.title, LIMITS.agentTitle);
      if (!name || !name.trim() || !title || !title.trim()) {
        return { ok: false, error: 'Faltan campos obligatorios para crear el agente.' };
      }
      const style = optionalCappedString(agent.style, LIMITS.agentStyle);
      if (style === null) {
        return { ok: false, error: `El estilo supera ${LIMITS.agentStyle} caracteres.` };
      }
      const color = optionalCappedString(agent.color, 20);
      if (color === null || (color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(color))) {
        return { ok: false, error: 'Color inválido.' };
      }
      const voice = optionalCappedString(agent.voice, 30);
      if (voice === null || (voice !== undefined && !(GEMINI_VOICES as readonly string[]).includes(voice))) {
        return { ok: false, error: `Voz inválida. Opciones: ${GEMINI_VOICES.join(', ')}.` };
      }
      const aliases = toStringList(agent.aliases, LIMITS.listItems, LIMITS.listItemLength);
      const domains = toStringList(agent.domains, LIMITS.listItems, LIMITS.listItemLength);
      const boundaries = toStringList(agent.boundaries, LIMITS.listItems, LIMITS.boundaryLength);
      if (!aliases || !domains || !boundaries) {
        return { ok: false, error: 'Listas de alias/dominios/límites inválidas o demasiado largas.' };
      }
      const initialTasksRaw = agent.initialTasks === undefined || agent.initialTasks === null
        ? []
        : Array.isArray(agent.initialTasks)
          ? agent.initialTasks
          : null;
      if (initialTasksRaw === null || initialTasksRaw.length > LIMITS.initialTasks) {
        return { ok: false, error: 'Lista de tareas iniciales inválida.' };
      }
      const initialTasks: string[] = [];
      for (const task of initialTasksRaw) {
        const clean = cappedString(task, LIMITS.taskText);
        if (clean === null) {
          return { ok: false, error: `Cada tarea inicial debe ser texto de hasta ${LIMITS.taskText} caracteres.` };
        }
        if (clean.trim()) {
          initialTasks.push(clean.trim());
        }
      }
      return {
        ok: true,
        message: {
          type: 'spawn_agent',
          agent: { name: name.trim(), title: title.trim(), color, aliases, domains, boundaries, style, voice, initialTasks }
        }
      };
    }

    case 'add_task': {
      const agentId = cappedString(value.agentId, 80);
      const text = cappedString(value.text, LIMITS.taskText);
      if (!agentId || !text || !text.trim()) {
        return { ok: false, error: 'Tarea inválida.' };
      }
      return { ok: true, message: { type: 'add_task', agentId, text } };
    }

    case 'toggle_task': {
      const agentId = cappedString(value.agentId, 80);
      const taskId = cappedString(value.taskId, 80);
      if (!agentId || !taskId) {
        return { ok: false, error: 'Referencia de tarea inválida.' };
      }
      return { ok: true, message: { type: 'toggle_task', agentId, taskId, completed: Boolean(value.completed) } };
    }

    case 'delete_task': {
      const agentId = cappedString(value.agentId, 80);
      const taskId = cappedString(value.taskId, 80);
      if (!agentId || !taskId) {
        return { ok: false, error: 'Referencia de tarea inválida.' };
      }
      return { ok: true, message: { type: 'delete_task', agentId, taskId } };
    }

    default:
      return { ok: false, error: `Tipo de mensaje desconocido: ${String(value.type).slice(0, 40)}.` };
  }
}

// El cliente es permisivo: tipos desconocidos pasan (forward-compat para que
// el servidor pueda estrenar mensajes antes de que el cliente los conozca).
export function parseServerMessage(raw: unknown): (ServerMessage & Record<string, unknown>) | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  return value as ServerMessage & Record<string, unknown>;
}
