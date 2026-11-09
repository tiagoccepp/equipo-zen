// Protocolo WebSocket compartido entre server (Node, type-stripping nativo)
// y cliente (Vite). Única fuente de verdad: todo tipo de mensaje nuevo se
// declara acá y se valida acá.

export const VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'] as const;
export type VoiceName = (typeof VOICES)[number];

export const VOICE_LABELS: Record<VoiceName, string> = {
  M1: 'Martín (grave y sereno)',
  M2: 'Bruno (canchero)',
  M3: 'Ricardo (maduro)',
  M4: 'Andrés (neutro)',
  M5: 'Facundo (enérgico)',
  F1: 'Tomasa (cálida)',
  F2: 'Valentina (clara)',
  F3: 'Carla (vendedora)',
  F4: 'Sofía (suave)',
  F5: 'Marta (precisa)'
};

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
  knowledge?: string;
  style: string;
  voice: string;
  tasks: AgentTask[];
  origin?: 'builtin' | 'custom';
  enabled?: boolean;
  learningEnabled?: boolean;
  role?: 'ceo' | 'contratista' | 'worker';
  managerId?: string | null;
}

export interface MeetingScenario {
  name: string | null;
  text: string | null;
}

// Qué clase de tarea es: solo 'entregable' (y sus derivadas de proceso)
// llega a producir archivos; los acuerdos quedan registrados sin trabajo.
export type TaskKind = 'entregable' | 'decision' | 'seguimiento' | 'revision' | 'refinamiento';

export interface PublicCompany {
  id: string;
  name: string;
  industry: string;
  emoji: string;
  color: string;
  scenario: string;
  status?: string;
  teamSize?: number;
  meetingCount?: number;
  lastActiveAt?: string;
}

export interface PublicTurn {
  id: string;
  kind: 'user' | 'agent' | 'system';
  speaker: string;
  agentId?: string | null;
  text: string;
}

export interface AgentPatch {
  name?: string;
  title?: string;
  color?: string;
  voice?: string;
  style?: string;
  aliases?: string[];
  domains?: string[];
  boundaries?: string[];
  knowledge?: string;
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
  knowledge?: string;
  style?: string;
  voice?: string;
  initialTasks?: string[];
}

export type ClientMessage =
  | { type: 'hello'; meetingId?: string; companyId?: string; goalId?: string }
  | { type: 'interrupt'; turnId?: string; agentId?: string; reason: 'barge_in' | 'manual'; playedMs?: number }
  | { type: 'playback_complete'; turnId: string; agentId: string }
  | { type: 'user_turn'; text: string }
  | { type: 'audio_prepare' }
  | { type: 'audio_start' }
  | { type: 'audio_chunk'; data: string; mimeType?: string }
  | { type: 'audio_end'; transcriptHint?: string }
  | { type: 'audio_cancel'; reason?: string; speechMs?: number }
  | { type: 'audio_stop' }
  // Telemetría de voz del cliente (VAD/barge por turno): sin este case el
  // servidor respondía error en cada turno de voz.
  | { type: 'client_stats'; stats: Record<string, number> }
  // El cliente declara si QUIERE voz. Fuera del modo llamada no la quiere: sin
  // esto el servidor sintetizaba en todos los turnos igual, gastaba Supertonic
  // y serializaba las respuestas por el SpeakerGate para un audio que nadie oía.
  | { type: 'set_voice'; enabled: boolean }
  // ¿El equipo arranca solo apenas se reparte una tarea en la reunión?
  | { type: 'set_auto_work'; enabled: boolean }
  | { type: 'reset' }
  | { type: 'health' }
  | { type: 'spawn_agent'; agent: SpawnAgentPayload }
  | { type: 'update_agent'; agentId: string; patch: AgentPatch }
  | { type: 'archive_agent'; agentId: string }
  | { type: 'set_agent_enabled'; agentId: string; enabled: boolean }
  | { type: 'set_scenario'; text: string }
  | { type: 'end_meeting' }
  | { type: 'confirm_end_meeting' }
  // Poner al equipo a trabajar SIN cerrar la reunión: se usa lo que ya
  // tienen asignado; si no hay tareas, no pasa nada.
  | { type: 'start_work' }
  | { type: 'add_task'; agentId: string; text: string }
  | { type: 'toggle_task'; agentId: string; taskId: string; completed: boolean }
  | { type: 'delete_task'; agentId: string; taskId: string };

export type ServerMessage =
  | {
      type: 'meeting_ready';
      id: string;
      meetingId: string;
      resumed: boolean;
      company: PublicCompany;
      // El proyecto en el que vive la reunión: acota el contexto que reciben
      // los agentes y es la clave con la que el cliente guarda la reunión.
      project?: { id: string; title: string; slug: string; brief: string; stack: string } | null;
      agents: PublicAgent[];
      scenario: MeetingScenario;
      turns: PublicTurn[];
      model: string;
      liveMode: boolean;
      mode?: 'live' | 'stream' | 'mock';
      agentBackends?: Record<string, string>;
    }
  | { type: 'auto_work_changed'; enabled: boolean }
  | { type: 'meeting_reset' }
  | { type: 'scenario_updated'; scenario: MeetingScenario }
  | {
      type: 'meeting_closing_summary';
      // false = la reunión no genera nada para construir: solo quedan acuerdos.
      producesWork: boolean;
      goalTitle: string;
      goalDescription: string;
      assignments: Array<{
        agentId: string;
        agentName: string;
        tasks: Array<{ text: string; kind: TaskKind }>;
      }>;
      // El equipo es fijo: en vez de contratar, se refuerza a quien ya está.
      refinements: Array<{ agentName: string; need: string }>;
    }
  | { type: 'work_event'; kind: string; [key: string]: unknown }
  | {
      type: 'work_started';
      // 0 = nadie tenía nada asignado; el botón no hace nada y se avisa.
      tasks: number;
      goalTitle: string | null;
      note: string;
    }
  | { type: 'meeting_warmup_start' }
  | { type: 'meeting_warmup_complete'; ok: boolean; failures: number }
  | { type: 'agents_updated'; agents: PublicAgent[] }
  | { type: 'user_turn_received'; turnId: string; text: string; source: 'text' | 'audio' | 'system' }
  | { type: 'route_decision'; turnId: string; route: RouteDecision }
  | { type: 'no_agent_response'; turnId: string; note: string }
  | { type: 'agent_turn_start'; turnId: string; agentId: string }
  | { type: 'agent_speak_start'; turnId: string; agentId: string }
  | { type: 'agent_progress'; turnId: string; agentId: string; text: string }
  | { type: 'agent_transcript_delta'; turnId: string; agentId: string; delta: string; seq?: number }
  | { type: 'agent_audio_chunk'; turnId: string; agentId: string; data: string; mimeType?: string; seq?: number }
  | { type: 'agent_audio_mp3'; turnId: string; agentId: string; data: string; mimeType?: string }
  | { type: 'agent_audio_start'; turnId: string; agentId: string; sampleRate: number }
  | { type: 'agent_audio_end'; turnId: string; agentId: string; reason: 'complete' | 'interrupted' | 'error'; sentMs: number }
  | { type: 'agent_interrupted'; turnId?: string; agentId?: string }
  | { type: 'turn_cancelled'; turnId: string; reason: 'superseded' | 'barge_in' }
  | { type: 'agent_state'; agentId: string; state: 'idle' | 'thinking' | 'speaking' | 'interrupted' }
  | { type: 'live_session_status'; agentId: string; status: 'open' | 'closed' | 'resumed' | 'fallback'; keyId?: string }
  | {
      type: 'agent_turn_complete';
      turnId: string;
      agentId: string;
      text: string;
      usedMock?: boolean;
      backend?: 'live' | 'stream' | 'mock';
      interrupted?: boolean;
      keyStatus?: KeyStatus[];
    }
  | { type: 'agent_silence'; turnId: string; agentId: string; reason: string }
  | { type: 'audio_listening_start' }
  | { type: 'audio_listening_stop' }
  | { type: 'user_audio_transcript_delta'; delta: string; text: string }
  | { type: 'user_audio_turn_final'; text: string; source: 'local' | 'groq' | 'client' | 'live' | 'fallback' }
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
    case 'set_voice':
      return { ok: true, message: { type: 'set_voice', enabled: Boolean(value.enabled) } };

    case 'set_auto_work':
      return { ok: true, message: { type: 'set_auto_work', enabled: Boolean(value.enabled) } };

    case 'hello': {
      const meetingId = optionalCappedString(value.meetingId, 40);
      const companyId = optionalCappedString(value.companyId, 40);
      // El proyecto en el que se abre la reunión: sin esto el validador lo
      // descartaba en silencio y la reunión nacía huérfana.
      const goalId = optionalCappedString(value.goalId, 40);
      if (meetingId === null || companyId === null || goalId === null) {
        return { ok: false, error: 'hello inválido.' };
      }
      return { ok: true, message: { type: 'hello', meetingId, companyId, goalId } };
    }

    case 'interrupt': {
      const reason = value.reason === 'barge_in' || value.reason === 'manual' ? value.reason : 'manual';
      const turnId = optionalCappedString(value.turnId, 40);
      const agentId = optionalCappedString(value.agentId, 80);
      if (turnId === null || agentId === null) {
        return { ok: false, error: 'interrupt inválido.' };
      }
      const playedMs = typeof value.playedMs === 'number' && Number.isFinite(value.playedMs)
        ? Math.max(0, value.playedMs)
        : undefined;
      return { ok: true, message: { type: 'interrupt', turnId, agentId, reason, playedMs } };
    }

    case 'playback_complete': {
      const turnId = cappedString(value.turnId, 40);
      const agentId = cappedString(value.agentId, 80);
      if (!turnId || !agentId) {
        return { ok: false, error: 'playback_complete requiere turnId y agentId.' };
      }
      return { ok: true, message: { type: 'playback_complete', turnId, agentId } };
    }

    case 'update_agent': {
      const agentId = cappedString(value.agentId, 80);
      if (!agentId || !isRecord(value.patch)) {
        return { ok: false, error: 'update_agent requiere agentId y patch.' };
      }
      const raw = value.patch;
      const patch: AgentPatch = {};
      if (raw.name !== undefined) {
        const name = cappedString(raw.name, LIMITS.agentName);
        if (!name || !name.trim()) return { ok: false, error: 'Nombre inválido.' };
        patch.name = name.trim();
      }
      if (raw.title !== undefined) {
        const title = cappedString(raw.title, LIMITS.agentTitle);
        if (!title || !title.trim()) return { ok: false, error: 'Título inválido.' };
        patch.title = title.trim();
      }
      if (raw.style !== undefined) {
        const style = cappedString(raw.style, LIMITS.agentStyle);
        if (style === null) return { ok: false, error: `El estilo supera ${LIMITS.agentStyle} caracteres.` };
        patch.style = style;
      }
      if (raw.knowledge !== undefined) {
        const knowledge = cappedString(raw.knowledge, 2000);
        if (knowledge === null) return { ok: false, error: 'Los conocimientos superan 2000 caracteres.' };
        patch.knowledge = knowledge;
      }
      if (raw.color !== undefined) {
        const color = cappedString(raw.color, 20);
        if (!color || !/^#[0-9a-fA-F]{3,8}$/.test(color)) return { ok: false, error: 'Color inválido.' };
        patch.color = color;
      }
      if (raw.voice !== undefined) {
        const voice = cappedString(raw.voice, 30);
        if (!voice || !(VOICES as readonly string[]).includes(voice)) {
          return { ok: false, error: `Voz inválida. Opciones: ${VOICES.join(', ')}.` };
        }
        patch.voice = voice;
      }
      for (const field of ['aliases', 'domains', 'boundaries'] as const) {
        if (raw[field] !== undefined) {
          const maxLength = field === 'boundaries' ? LIMITS.boundaryLength : LIMITS.listItemLength;
          const list = toStringList(raw[field], LIMITS.listItems, maxLength);
          if (!list) return { ok: false, error: `Lista de ${field} inválida o demasiado larga.` };
          patch[field] = list;
        }
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'El patch no tiene cambios válidos.' };
      }
      return { ok: true, message: { type: 'update_agent', agentId, patch } };
    }

    case 'archive_agent': {
      const agentId = cappedString(value.agentId, 80);
      if (!agentId) {
        return { ok: false, error: 'archive_agent requiere agentId.' };
      }
      return { ok: true, message: { type: 'archive_agent', agentId } };
    }

    case 'set_agent_enabled': {
      const agentId = cappedString(value.agentId, 80);
      if (!agentId) {
        return { ok: false, error: 'set_agent_enabled requiere agentId.' };
      }
      return { ok: true, message: { type: 'set_agent_enabled', agentId, enabled: Boolean(value.enabled) } };
    }

    case 'end_meeting':
    case 'confirm_end_meeting':
    case 'start_work':
      return { ok: true, message: { type: value.type } };

    case 'set_scenario': {
      const text = cappedString(value.text, 2000);
      if (text === null) {
        return { ok: false, error: 'El escenario supera 2000 caracteres.' };
      }
      return { ok: true, message: { type: 'set_scenario', text } };
    }

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

    case 'client_stats': {
      // Telemetría VAD del cliente: record chico de números finitos.
      if (!isRecord(value.stats)) {
        return { ok: false, error: 'client_stats requiere stats.' };
      }
      const keys = Object.keys(value.stats);
      if (keys.length > 20) {
        return { ok: false, error: 'client_stats con demasiadas claves.' };
      }
      const stats: Record<string, number> = {};
      for (const key of keys) {
        if (cappedString(key, 64) === null) {
          return { ok: false, error: 'client_stats con clave inválida.' };
        }
        const num = (value.stats as Record<string, unknown>)[key];
        if (typeof num !== 'number' || !Number.isFinite(num)) {
          return { ok: false, error: 'client_stats solo acepta números finitos.' };
        }
        stats[key] = num;
      }
      return { ok: true, message: { type: 'client_stats', stats } };
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
      const knowledge = optionalCappedString(agent.knowledge, 2000);
      if (knowledge === null) {
        return { ok: false, error: 'Los conocimientos superan 2000 caracteres.' };
      }
      const color = optionalCappedString(agent.color, 20);
      if (color === null || (color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(color))) {
        return { ok: false, error: 'Color inválido.' };
      }
      const voice = optionalCappedString(agent.voice, 30);
      if (voice === null || (voice !== undefined && !(VOICES as readonly string[]).includes(voice))) {
        return { ok: false, error: `Voz inválida. Opciones: ${VOICES.join(', ')}.` };
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
          agent: { name: name.trim(), title: title.trim(), color, aliases, domains, boundaries, knowledge, style, voice, initialTasks }
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
