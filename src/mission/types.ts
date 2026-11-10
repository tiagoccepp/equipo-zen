// Mission Control — tipos (solo lectura de endpoints existentes + /api/mission/live).

export interface LiveTeamMember {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  color?: string | null;
}

export interface LiveMeeting {
  meetingId: string;
  companyId: string;
  companyName: string;
  goalTitle: string | null;
  status: string;
  turnCount: number;
  lastActiveAt: string | null;
  team: LiveTeamMember[];
}

export interface MissionLive {
  live: LiveMeeting[];
}

export interface MissionTask {
  id: string;
  text: string;
  status: string;
  agentId?: string | null;
  blockedReason?: string | null;
}

export interface MissionGoal {
  id: string;
  title: string;
  status: string;
  tasks: MissionTask[];
}

export interface CompanyWork {
  company: { id: string; name: string };
  team: LiveTeamMember[];
  goals: MissionGoal[];
}

export interface SidecarState {
  name: string;
  status: string;
  downs: number;
  restartsLastHour: number;
  lastSpawnAt: string | null;
  autostart: boolean;
}

export interface TelemetryAnalysis {
  totalEvents: number;
  userTurns: number;
  audioTurns: number;
  textTurns: number;
  routeDecisions: number;
  noAgentResponses: number;
  agentCompletions: number;
  avgVisibleResponseMs: number | null;
  maxVisibleResponseMs: number | null;
  avgAgentResponseMs: number | null;
  maxAgentResponseMs: number | null;
}

export interface SalaSettings {
  v1: boolean;
  v2: boolean;
  groupchat: boolean;
  timeoutMs: number;
  agentTimeoutMs: number;
  sop: string;
}

export interface AudioSettings {
  ttsEngine: string;
  sttProvider: string;
  ttsHealthy: boolean | null;
  sttHealthy: boolean | null;
}

export interface AudioNode {
  id: number;
  name: string;
  description: string;
  volume: number | null;
  muted: boolean | null;
  isDefault: boolean;
}

export interface AudioDevices {
  sinks: AudioNode[];
  sources: AudioNode[];
}

/** Estado vivo que solo el cliente (WS) conoce; el main lo inyecta. */
export interface MissionLiveHooks {
  /** Ids de agentes hablando ahora mismo (vacío = nadie / desconocido). */
  getLiveSpeakers?: () => string[];
  /** true si hay sesión de voz activa. */
  getVoiceActive?: () => boolean;
}

/** Monitor de conectividad (TC 09/11): snapshot de GET /api/connectivity. */
export interface ConnectivityCheck {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface ConnectivityStatus {
  online: boolean;
  status: 'online' | 'degraded' | 'offline';
  checks: ConnectivityCheck[];
  ts: number;
}
