// Mission Control — per-card fetch. Each getter returns `null` on failure
// (down endpoint, HTTP !ok, broken JSON): the card shows "—", the rest lives.

import type {
  AudioDevices,
  AudioSettings,
  CompanyWork,
  ConnectivityStatus,
  MissionGoal,
  MissionLive,
  MissionTask,
  SalaSettings,
  SidecarState,
  TelemetryAnalysis
} from './types.ts';
import { apiBase } from '../client.ts';
import { pickCompany } from './format.ts';

async function getJson<T>(path: string): Promise<T | null> {
  try {
    // Dynamic apiBase() per call: in the packaged app the backend lives on an
    // ephemeral port (without this every fetch went to tauri:// and each card was —).
    const res = await fetch(apiBase() + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchLive(): Promise<MissionLive | null> {
  const data = await getJson<MissionLive>('/api/mission/live');
  if (!data || !Array.isArray(data.live)) {
    return null;
  }
  return data;
}

interface CompanyRow {
  id: string;
  name: string;
}

export async function fetchWork(): Promise<CompanyWork | null> {
  const list = await getJson<{ companies: CompanyRow[] }>('/api/companies');
  const company = list && Array.isArray(list.companies) ? pickCompany(list.companies) : null;
  if (!company) {
    return null;
  }
  const work = await getJson<{
    company: { id: string; name: string };
    team: CompanyWork['team'];
    goals: Array<{
      id: string;
      title: string;
      status: string;
      tasks?: Array<{
        id: string;
        text: string;
        status: string;
        agentId?: string | null;
        blockedReason?: string | null;
      }>;
    }>;
  }>(`/api/companies/${encodeURIComponent(company.id)}/work`);
  if (!work || !work.company || !Array.isArray(work.goals)) {
    return null;
  }
  const goals: MissionGoal[] = work.goals.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    tasks: (Array.isArray(g.tasks) ? g.tasks : []).map(
      (t): MissionTask => ({
        id: t.id,
        text: t.text,
        status: t.status,
        agentId: t.agentId ?? null,
        blockedReason: t.blockedReason ?? null
      })
    )
  }));
  return { company: work.company, team: Array.isArray(work.team) ? work.team : [], goals };
}

export async function fetchSidecars(): Promise<SidecarState[] | null> {
  const data = await getJson<{ sidecars: SidecarState[] }>('/api/sidecars');
  if (!data || !Array.isArray(data.sidecars)) {
    return null;
  }
  return data.sidecars;
}

/** Connectivity monitor (TC 09/11): snapshot of the server's 30s probe. */
export async function fetchConnectivity(): Promise<ConnectivityStatus | null> {
  const data = await getJson<ConnectivityStatus>('/api/connectivity');
  if (!data || !Array.isArray(data.checks)) {
    return null;
  }
  return data;
}

export async function fetchLatency(): Promise<TelemetryAnalysis | null> {
  const data = await getJson<TelemetryAnalysis>('/api/telemetry/analysis');
  if (!data || typeof data.totalEvents !== 'number') {
    return null;
  }
  return data;
}

interface PublicSettingsWire {
  settings?: {
    tts?: { engine?: string };
    stt?: { provider?: string };
    sala?: {
      v1?: boolean;
      v2?: boolean;
      groupchat?: boolean;
      timeoutMs?: number;
      agentTimeoutMs?: number;
      sop?: string;
    };
  };
}

interface SettingsStatusWire {
  tts?: { healthy?: boolean };
  stt?: { localHealthy?: boolean };
}

export async function fetchSala(): Promise<SalaSettings | null> {
  const data = await getJson<PublicSettingsWire>('/api/settings');
  const sala = data?.settings?.sala;
  if (!sala) {
    return null;
  }
  return {
    v1: sala.v1 === true,
    v2: sala.v2 === true,
    groupchat: sala.groupchat === true,
    timeoutMs: typeof sala.timeoutMs === 'number' ? sala.timeoutMs : 0,
    agentTimeoutMs: typeof sala.agentTimeoutMs === 'number' ? sala.agentTimeoutMs : 0,
    sop: typeof sala.sop === 'string' ? sala.sop : ''
  };
}

export async function fetchAudio(): Promise<AudioSettings | null> {
  const [settings, status] = await Promise.all([
    getJson<PublicSettingsWire>('/api/settings'),
    getJson<SettingsStatusWire>('/api/settings/status')
  ]);
  const ttsEngine = settings?.settings?.tts?.engine;
  const sttProvider = settings?.settings?.stt?.provider;
  if (!ttsEngine && !sttProvider) {
    return null;
  }
  return {
    ttsEngine: ttsEngine || '—',
    sttProvider: sttProvider || '—',
    ttsHealthy: typeof status?.tts?.healthy === 'boolean' ? status.tts.healthy : null,
    sttHealthy: typeof status?.stt?.localHealthy === 'boolean' ? status.stt.localHealthy : null
  };
}

export async function fetchAudioDevices(): Promise<AudioDevices | null> {
  const data = await getJson<{ devices?: { sinks?: unknown; sources?: unknown } }>('/api/audio/devices');
  const sinks = data?.devices?.sinks;
  const sources = data?.devices?.sources;
  if (!Array.isArray(sinks) || !Array.isArray(sources)) {
    return null;
  }
  return { sinks: sinks as AudioDevices['sinks'], sources: sources as AudioDevices['sources'] };
}

export interface LocalDevices {
  inputs: number;
  outputs: number;
}

/** Local counts (empty labels without permission); null if the API is missing. */
export async function fetchLocalDevices(): Promise<LocalDevices | null> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return null;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = 0;
    let outputs = 0;
    for (const d of devices) {
      if (d.kind === 'audioinput') {
        inputs += 1;
      } else if (d.kind === 'audiooutput') {
        outputs += 1;
      }
    }
    return { inputs, outputs };
  } catch {
    return null;
  }
}
