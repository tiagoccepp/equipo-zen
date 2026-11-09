// Pablo — UI Lovable-oscura + loop de voz dinámico upstream
// (VAD continuo + barge-in + gate de audio + work-events).

import './app.css';
import { OrbField, type OrbAgent, type OrbSlot } from './lib/call-orbs.ts';
import { isTauri, tinvoke } from './lib/tauri.ts';
import {
  Client,
  decir,
  findOrCreatePabloSpace,
  firstProject,
  getSettings,
  listCompanies,
  resolveBase,
  saveSettings,
  type Agent,
  type PublicSettings
} from './client.ts';
import { BrowserSpeech, LiveMic, VoiceOut, computeEndpointing, hintTail, type TurnVoiceStats } from './voice.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`falta #${id}`);
  return el;
};

const greetEl = $('greet');
const statusEl = $('status');
const promptEl = $('prompt') as HTMLTextAreaElement;
const sendBtn = $('btn-send') as HTMLButtonElement;
const micBtn = $('btn-mic') as HTMLButtonElement;
const callBtn = $('btn-call') as HTMLButtonElement;
const voiceBtn = $('btn-voice') as HTMLButtonElement;
const streamEl = $('stream');
const cellsEl = $('orb-cells');
const canvas = $('orb-canvas') as HTMLCanvasElement;
const orbsBox = $('orbs');

const setStatus = (t: string): void => {
  statusEl.textContent = t;
};

// Pastilla de conexión del topbar (visual; no toca el protocolo WS).
const connEl = $('conn');
const connTextEl = $('conn-text');
function setConn(state: 'connecting' | 'live' | 'offline'): void {
  connEl.classList.toggle('live', state === 'live');
  connEl.classList.toggle('offline', state === 'offline');
  connTextEl.textContent = state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
}

function addMsg(who: string, text: string, cls = ''): void {
  const div = document.createElement('div');
  div.className = `msg ${cls}`.trim();
  const b = document.createElement('b');
  b.textContent = who;
  div.appendChild(b);
  div.appendChild(document.createTextNode(text));
  streamEl.appendChild(div);
  while (streamEl.childElementCount > 80) {
    streamEl.firstElementChild?.remove();
  }
  streamEl.scrollTop = streamEl.scrollHeight;
}

// ── Voz: salida + entrada continua ───────────────────────────────────
const voiceOut = new VoiceOut();
const browserSpeech = new BrowserSpeech();
let voiceOn = true;
let speakingAgent = '';
let audioSegment: { turnId: string; agentId: string; endReceived: boolean } | null = null;
let voiceSession = false;
let voiceGroup = false;

function agentSpeaking(): boolean {
  return voiceOut.isPlaying || audioSegment !== null;
}

// Turnos del agente en curso (turnId → {agentId, at}): cubren el
// PENSAMIENTO silencioso, que agentSpeaking() no ve (solo cubre audio en
// vuelo). Con hora para podar entradas rancias (un complete perdido no
// puede dejar interrupts fantasma para siempre).
const activeTurns = new Map<string, { agentId: string; at: number }>();
const ACTIVE_TURN_MAX_AGE_MS = 90000;

/** Saca turnos que el servidor ya no va a cerrar (completes perdidos). */
function pruneActiveTurns(): void {
  const now = Date.now();
  for (const [turnId, v] of activeTurns) {
    if (now - v.at > ACTIVE_TURN_MAX_AGE_MS) activeTurns.delete(turnId);
  }
}
// Turnos ya cortados: el audio que llegue tarde se descarta (stragglers).
const interruptedTurns = new Set<string>();
const MAX_INTERRUPTED = 30;

function noteInterrupted(turnId: string | undefined): void {
  if (!turnId || interruptedTurns.has(turnId)) return;
  interruptedTurns.add(turnId);
  while (interruptedTurns.size > MAX_INTERRUPTED) {
    const oldest = interruptedTurns.values().next().value;
    if (oldest === undefined) break;
    interruptedTurns.delete(oldest);
  }
}

/** Marca lo cortado localmente: el segmento en vuelo + todo lo que pensaba. */
function noteLocalInterrupt(): void {
  noteInterrupted(audioSegment?.turnId);
  for (const turnId of activeTurns.keys()) noteInterrupted(turnId);
}

/** Blancos del interrupt: audio en vuelo primero, después lo que pensaba. */
function interruptTargets(): Array<{ turnId?: string; agentId?: string }> {
  const out: Array<{ turnId?: string; agentId?: string }> = [];
  const seen = new Set<string>();
  const push = (turnId?: string, agentId?: string): void => {
    if (!turnId && !agentId) return;
    const key = `${turnId || ''}|${agentId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ turnId, agentId });
  };
  push(audioSegment?.turnId, audioSegment?.agentId);
  for (const [turnId, v] of activeTurns) push(turnId, v.agentId);
  return out;
}

function isInterruptedTurn(turnId: string | undefined): boolean {
  return !!turnId && interruptedTurns.has(turnId);
}

// Gracia de endpointing: una mini-pausa no cierra el turno.
const GRACE_MS = 1200;
let graceTimer: number | null = null;
let graceHint = '';
let audioEndSent = false;
// §3a fase 1: stats del turno en espera (salen al resolver la gracia,
// cuando ya se sabe si se reabrió habla) + historial de cortes.
let pendingTurnStats: TurnVoiceStats | null = null;
let turnHadInterrupt = false;
const bargeHistory: boolean[] = [];

/** Manda la telemetría pendiente con reopened + hintEnd. Siempre que hay datos. */
function flushTurnStats(reopened: boolean): void {
  if (!pendingTurnStats) return;
  const stats = pendingTurnStats;
  pendingTurnStats = null;
  const fresh = browserSpeech.latestUtterance() || graceHint;
  client.voiceStats({ ...stats, reopened, hintEnd: hintTail(fresh) });
}

/** Cierra el turno en el historial de cortes (últimos 2). */
function pushBargeHistory(): void {
  bargeHistory.push(turnHadInterrupt);
  while (bargeHistory.length > 2) bargeHistory.shift();
  turnHadInterrupt = false;
}
// Un solo interrupt por turno del usuario: el barge-in acústico y la
// confirmación de habla son dos caminos al mismo corte; sin esto el
// segundo manda un duplicado siempre.
let interruptSentForTurn = false;
// Corte sobre AUDIO en vuelo: exige habla más larga que sobre pensamiento
// (con audio hay eco; sin audio cualquier habla real es el usuario).
const CUT_OVER_AUDIO_MS = 1200;
let pendingCutTimer: number | null = null;

function cancelPendingCut(): void {
  if (pendingCutTimer !== null) {
    window.clearTimeout(pendingCutTimer);
    pendingCutTimer = null;
  }
}

/** Corte dirigido: audio en vuelo + turnos pensando. Una vez por turno. */
function cutAgent(): void {
  if (interruptSentForTurn) return;
  pruneActiveTurns();
  if (!agentSpeaking() && activeTurns.size === 0) return;
  const targets = interruptTargets();
  if (targets.length === 0) {
    client.interrupt(undefined, undefined);
  } else {
    for (const t of targets) client.interrupt(t.turnId, t.agentId);
  }
  noteLocalInterrupt();
  interruptSentForTurn = true;
  turnHadInterrupt = true;
  voiceOut.flush();
  voiceOut.restoreGain();
  speakingAgent = '';
  field.setSpeaking('');
  setStatus('Stopped — listening to you.');
}

function maybePlaybackComplete(): void {
  if (audioSegment?.endReceived && !voiceOut.isPlaying) {
    client.playbackComplete(audioSegment.turnId, audioSegment.agentId);
    if (speakingAgent === audioSegment.agentId) {
      speakingAgent = '';
      field.setSpeaking('');
    }
    audioSegment = null;
    if (!liveMic.userSpeaking) setStatus('Ready');
  }
}

voiceOut.onDrained = () => {
  maybePlaybackComplete();
};

const liveMic = new LiveMic({
  onChunk: (b64) => client.audioChunk(b64),
  onSpeechStart: () => {
    liveMic.resetBarge();
    // Dentro de la gracia se sigue el MISMO turno: los chunks siguen
    // fluyendo al mismo buffer del servidor, no se manda nada extra.
    if (graceTimer !== null) {
      window.clearTimeout(graceTimer);
      graceTimer = null;
      graceHint = '';
      // §3a: la gracia salvó un corte — el turno sigue, la telemetría sale
      // marcada y el historial de cortes espera al cierre real.
      flushTurnStats(true);
      setStatus('Recording…');
      return;
    }
    // Turno nuevo: el interrupt (si hace falta) lo manda onSpeechConfirmed
    // cuando el habla se sostiene — una tos o un "eh" que el VAD apenas
    // abre y minSpeechMs descarta jamás debe cortar al agente.
    interruptSentForTurn = false;
    turnHadInterrupt = false;
    voiceOut.flush();
    voiceOut.restoreGain();
    setStatus('Recording…');
  },
  onSpeechConfirmed: (ms) => {
    // Habla REAL (sostenida ≥ minSpeechMs). Sobre pensamiento silencioso
    // se corta ya (sin audio no hay eco: es el usuario seguro). Sobre
    // audio en vuelo se exigen 1200 ms totales: el barge-in acústico ya
    // corta lo fuerte a ~300 ms; esto cubre lo suave sin que un ruido
    // ambiente largo corte.
    if (interruptSentForTurn) return;
    pruneActiveTurns();
    if (!agentSpeaking() && activeTurns.size === 0) return;
    if (!agentSpeaking()) {
      cutAgent();
      return;
    }
    if (ms >= CUT_OVER_AUDIO_MS) {
      cutAgent();
      return;
    }
    cancelPendingCut();
    pendingCutTimer = window.setTimeout(() => {
      pendingCutTimer = null;
      if (liveMic.userSpeaking) cutAgent();
    }, CUT_OVER_AUDIO_MS - ms);
  },
  onTurnStats: (stats) => {
    // §3a: se guardan; salen al resolver la gracia (con reopened + hintEnd).
    pendingTurnStats = { ...stats };
  },
  onSpeechEnd: (hint) => {
    // Fin de habla: se marca el tiempo (TTFV); el cierre del turno espera
    // la gracia por si es una mini-pausa. El modelo decide si avisa,
    // responde por partes o calla; el sistema no emite voz propia.
    liveMic.resetBarge();
    cancelPendingCut();
    lastSpeechEndAt = performance.now();
    graceHint = hint;
    audioEndSent = false;
    setStatus('Finished?…');
    if (graceTimer !== null) window.clearTimeout(graceTimer);
    // §3a fase 2: gracia dinámica (frase completa + turno largo → corta).
    const s = pendingTurnStats;
    const graceMs = s
      ? computeEndpointing({
          speechMs: s.speechMs,
          hintEnd: hintTail(hint),
          floor: s.floor,
          maxRms: s.maxRms,
          recentBarge: bargeHistory.some(Boolean)
        }).graceMs
      : GRACE_MS;
    graceTimer = window.setTimeout(() => {
      graceTimer = null;
      if (audioEndSent) return;
      audioEndSent = true;
      pushBargeHistory();
      flushTurnStats(false);
      // Hint más fresco no-vacío: el actual del navegador o el guardado.
      const best = browserSpeech.latestUtterance() || graceHint;
      client.audioEnd(best);
      setStatus('Transcribing…');
    }, graceMs);
  },
  onDiscarded: () => {
    // Ruido descartado: igual sale la telemetría (no es un turno real,
    // no entra al historial de cortes).
    flushTurnStats(false);
    client.audioCancel('too_short', 0);
    setStatus('Noise skipped.');
    window.setTimeout(() => {
      if (voiceSession && statusEl.textContent === 'Noise skipped.') {
        setStatus(voiceGroup ? 'Everyone is listening' : 'Listening…');
      }
    }, 900);
  },
  onInterrupt: () => {
    // Barge-in acústico (rápido, durante audio): si la confirmación ya
    // cortó este turno, no duplicar.
    if (interruptSentForTurn) return;
    cancelPendingCut();
    interruptSentForTurn = true;
    turnHadInterrupt = true;
    client.interrupt(audioSegment?.turnId, audioSegment?.agentId);
    noteLocalInterrupt();
    voiceOut.flush();
    voiceOut.restoreGain();
    speakingAgent = '';
    field.setSpeaking('');
    addMsg('system', '⏵ Cut in — listening.', 'sys');
  },
  onDuck: (ducked) => {
    if (ducked) {
      voiceOut.duck();
      setStatus('Listening…');
    } else {
      voiceOut.restoreGain();
    }
  },
  isAgentSpeaking: agentSpeaking,
  hintText: () => browserSpeech.latestUtterance(),
  resetHint: () => browserSpeech.resetUtterance(),
  // §3a: el VAD alarga el cierre si el usuario viene peleando con los cortes.
  recentBarge: () => bargeHistory.some(Boolean)
});

// ── Orbes (upstream, tema dark) ──────────────────────────────────────
// Amplitud que mueve las partículas del que habla: audio REAL; 0 si le
// pisás la voz (barge); respiración sintética solo si nunca hubo audio.
function callEnergy(): number {
  if (!speakingAgent || liveMic.bargePhase !== 'idle') {
    return 0;
  }
  const level = voiceOut.level();
  if (level > 0.05) {
    return level;
  }
  if (voiceOut.levelAvailable) {
    return 0;
  }
  return 0.28 + 0.22 * Math.sin(performance.now() / 210);
}

const field = new OrbField(canvas, { energy: callEnergy });
field.setTheme('dark');

const agents = new Map<string, Agent>();
const working = new Set<string>();

function layoutOrbs(): void {
  const list = [...agents.values()].slice(0, 6);
  const n = Math.max(1, list.length);
  const w = orbsBox.clientWidth || 600;
  const h = orbsBox.clientHeight || 300;
  field.resize(w, h);
  const r = Math.max(46, Math.min(128, w / n / 2 - 14, h / 2 - 30));
  cellsEl.innerHTML = '';
  const orbAgents: OrbAgent[] = [];
  const slots: OrbSlot[] = [];
  const cellW = w / n;
  list.forEach((a, i) => {
    orbAgents.push({ id: a.id, name: a.name, color: a.color || '#38D1FF' });
    const cell = document.createElement('div');
    cell.className = 'orb-cell';
    const hole = document.createElement('div');
    hole.className = 'orb-hole';
    hole.style.width = `${r * 2}px`;
    hole.style.height = `${r * 2}px`;
    const name = document.createElement('div');
    name.className = 'orb-name';
    name.textContent = a.name;
    cell.appendChild(hole);
    cell.appendChild(name);
    cellsEl.appendChild(cell);
    slots.push({ id: a.id, cx: cellW * (i + 0.5), cy: h / 2 - 8, r });
  });
  if (list.length === 0) {
    orbAgents.push({ id: 'pablo', name: 'Pablo', color: '#38D1FF' });
    slots.push({ id: 'pablo', cx: w / 2, cy: h / 2 - 8, r: Math.min(128, h / 2 - 30) });
  }
  field.setAgents(orbAgents);
  field.setSlots(slots);
  field.start();
}

window.addEventListener('resize', layoutOrbs);

// ── Cliente ─────────────────────────────────────────────────────────
let lastSpeechEndAt = 0;
const turnText = new Map<string, string>();
const agentName = (id: string): string => agents.get(id)?.name || 'Pablo';

const client = new Client({
  onReady: (list, meetingId) => {
    agents.clear();
    for (const a of list) agents.set(a.id, a);
    if (meetingId && currentCompany && currentGoal) {
      try {
        window.localStorage.setItem(meetingKey(currentCompany, currentGoal), meetingId);
      } catch {
        // Sin storage: cada carga crea reunión nueva.
      }
    }
    const pablo = list.find((a) => a.role === 'ceo') || list[0];
    greetEl.textContent = pablo ? `How can I help? — ${pablo.name}` : 'How can I help?';
    setStatus(voiceSession ? 'Listening…' : 'Ready');
    setConn('live');
    layoutOrbs();
  },
  onUserText: (text, source) => {
    // Los avisos del sistema (ej. spawn_agent) llegaban como burbuja YOU:
    // se pintan como sys sin tocar el estado de trabajo.
    if (source === 'system') {
      addMsg('system', text, 'sys');
      return;
    }
    addMsg('you', text, 'me');
    setStatus('Working on it…');
  },
  onRoute: (names) => {
    const who = names.filter(Boolean);
    if (who.length > 1) setStatus(`Round: ${who.join(', ')}`);
  },
  onAgentStart: (agentId, turnId) => {
    turnText.set(agentId, '');
    if (turnId) activeTurns.set(turnId, { agentId, at: Date.now() });
  },
  onSpeakStart: (agentId) => {
    // Primera palabra audible del modelo: marca TTFV (voz) para telemetría.
    const dt = lastSpeechEndAt ? Math.round(performance.now() - lastSpeechEndAt) : -1;
    console.info(`[ttfv] ${agentName(agentId)} primera palabra a +${dt}ms del fin de habla`);
    (window as any).__lastTtfvMs = dt;
  },
  onProgress: (_agentId, text) => {
    // Avance del modelo: se ve, no se habla. Estado transitorio.
    setStatus(`…${text.slice(0, 80)}`);
  },
  onDelta: (agentId, delta) => {
    turnText.set(agentId, (turnText.get(agentId) || '') + delta);
  },
  onAgentEnd: (agentId, text, turnId) => {
    if (turnId) activeTurns.delete(turnId);
    const full = text || turnText.get(agentId) || '';
    turnText.delete(agentId);
    if (full.trim()) {
      addMsg(agentName(agentId).toLowerCase(), full);
    }
    // El subtítulo sigue al AUDIO, no al texto: si suena, no se limpia acá.
    if (!audioSegment && speakingAgent === agentId) {
      speakingAgent = '';
      field.setSpeaking('');
      if (!voiceSession) setStatus('Ready');
    }
  },
  onMp3: (b64, turnId) => {
    if (!voiceOn || isInterruptedTurn(turnId)) return;
    void voiceOut.unlock().then(() => voiceOut.playMp3(b64));
  },
  onPcm: (b64, rate, turnId) => {
    if (!voiceOn || isInterruptedTurn(turnId)) return;
    void voiceOut.unlock().then(() => voiceOut.enqueuePcm(b64, rate));
  },
  onAudioStart: (turnId, agentId) => {
    audioSegment = { turnId, agentId, endReceived: false };
    speakingAgent = agentId;
    field.setSpeaking(agentId);
    setStatus(`${agentName(agentId).toLowerCase()} speaking…`);
  },
  onAudioEnd: (turnId, agentId) => {
    if (audioSegment?.turnId === turnId && audioSegment?.agentId === agentId) {
      audioSegment.endReceived = true;
      maybePlaybackComplete();
    }
  },
  onAgentState: (agentId, state) => {
    if (state === 'speaking' && !audioSegment) {
      speakingAgent = agentId;
      field.setSpeaking(agentId);
    } else if ((state === 'idle' || state === 'interrupted') && speakingAgent === agentId && !audioSegment) {
      speakingAgent = '';
      field.setSpeaking('');
    }
  },
  onInterrupted: (agentId, turnId) => {
    if (turnId) {
      activeTurns.delete(turnId);
      noteInterrupted(turnId);
    }
    voiceOut.flush();
    voiceOut.restoreGain();
    audioSegment = null;
    if (!agentId || speakingAgent === agentId) {
      speakingAgent = '';
      field.setSpeaking('');
    }
    setStatus(voiceSession ? 'Listening…' : 'Ready');
  },
  onWorkEvent: (kind, agentId, event) => {
    // task_started → arco giratorio; task_done/blocked → fuera.
    if (kind === 'task_started' || kind === 'task_queued' || kind === 'comando' || kind === 'file_written' || kind === 'web') {
      if (agentId) working.add(agentId);
    } else if (kind === 'task_done' || kind === 'task_blocked') {
      if (agentId) working.delete(agentId);
    }
    field.setWorking([...working]);
    // Feed de actividad: que SE VEA que laburan.
    const who = String(event.agentName || agentName(agentId) || 'equipo');
    const str = (k: string): string => String(event[k] || '');
    if (kind === 'comando' && str('cmd')) {
      addMsg('tools', `⚙️ ${who} runs: ${str('cmd').slice(0, 120)}`, 'sys');
    } else if (kind === 'file_written' && str('path')) {
      addMsg('tools', `📝 ${who} ${event.edited ? 'edited' : 'wrote'}: ${str('path')}`, 'sys');
    } else if (kind === 'web' && str('url')) {
      addMsg('tools', `🌐 ${who} read: ${str('url').slice(0, 100)}`, 'sys');
    } else if (kind === 'task_started' && str('text')) {
      addMsg('tools', `▶️ ${who}: ${str('text').slice(0, 140)}`, 'sys');
    } else if (kind === 'task_done') {
      addMsg('tools', `✅ ${who} finished${str('summary') ? `: ${str('summary').slice(0, 160)}` : ''}`, 'sys');
    } else if (kind === 'task_blocked') {
      addMsg('tools', `⛔ ${who} blocked: ${str('reason').slice(0, 140)}`, 'sys');
    } else if (kind === 'build_ok') {
      addMsg('tools', `🔨 ${who}: build OK`, 'sys');
    } else if (kind === 'build_failed') {
      addMsg('tools', `🔨 ${who}: build failed`, 'sys');
    } else if (kind === 'task_queued' && str('text')) {
      addMsg('tools', `📋 ${who} queued: ${str('text').slice(0, 140)}`, 'sys');
    }
  },
  onLiveTranscript: (text) => {
    setStatus(`…${text.slice(-60)}`);
  },
  onAutoWorkChanged: (enabled) => {
    autoWorkOn = enabled;
    const btn = $('btn-autowork');
    btn.classList.toggle('on', enabled);
    btn.classList.toggle('off', !enabled);
    btn.setAttribute('aria-pressed', String(enabled));
  },
  onNoResponse: (note, turnId) => {
    if (turnId) activeTurns.delete(turnId);
    addMsg('system', note, 'sys');
    setStatus(voiceSession ? 'Listening…' : 'Ready');
  },
  onVoiceTranscript: (text, source) => {
    addMsg('you · voice', `${text}  [${source}]`, 'me');
    setStatus('Working on it…');
  },
  onTranscribeEmpty: () => {
    addMsg('system', "Didn't catch that — try again.", 'sys');
    setStatus(voiceSession ? 'Listening…' : 'Ready');
  },
  onError: (message) => {
    addMsg('system', message, 'sys');
  },
  onClose: () => {
    setStatus('Disconnected — retrying shortly');
    setConn('offline');
  }
});

// ── Sesión de voz continua ──────────────────────────────────────────
async function setVoiceSession(on: boolean, group: boolean): Promise<void> {
  if (on === voiceSession && group === voiceGroup) {
    return;
  }
  if (!on) {
    if (graceTimer !== null) {
      window.clearTimeout(graceTimer);
      graceTimer = null;
    }
    graceHint = '';
    flushTurnStats(false);
    liveMic.stop(true);
    browserSpeech.stop();
    client.audioStop();
    voiceSession = false;
    voiceGroup = false;
    micBtn.classList.remove('live');
    callBtn.classList.remove('live');
    setStatus('Ready');
    return;
  }
  voiceOut.flush();
  await voiceOut.unlock();
  client.audioPrepare();
  const ok = await liveMic.start();
  if (!ok) {
    addMsg('system', "Couldn't open the microphone.", 'sys');
    setStatus('Ready');
    return;
  }
  // El ASR del navegador (hint) sigue el idioma de escucha del servidor.
  let locale = 'en-US';
  try {
    const settings = await getSettings();
    locale = settings.stt.language.startsWith('en') ? 'en-US' : 'es-ES';
  } catch {
    // Sin backend: inglés por defecto.
  }
  browserSpeech.start(locale);
  voiceSession = true;
  voiceGroup = group;
  micBtn.classList.toggle('live', !group);
  callBtn.classList.toggle('live', group);
  setStatus(group ? 'Everyone is listening — go ahead' : 'Listening…');
}

micBtn.addEventListener('click', () => {
  void (voiceSession && !voiceGroup ? setVoiceSession(false, false) : setVoiceSession(true, false));
});
callBtn.addEventListener('click', () => {
  void (voiceSession && voiceGroup ? setVoiceSession(false, false) : setVoiceSession(true, true));
});

// ── Texto (corta el audio en vuelo, como upstream) ──────────────────
function submitPrompt(): void {
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  promptEl.style.height = 'auto';
  voiceOut.flush();
  void voiceOut.unlock();
  client.sendText(text);
}

sendBtn.addEventListener('click', submitPrompt);
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`;
});
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitPrompt();
  }
});

document.querySelectorAll('.chip[data-say]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const text = (chip as HTMLElement).dataset.say || '';
    if (!text) return;
    voiceOut.flush();
    void voiceOut.unlock();
    client.sendText(text);
  });
});

voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  client.setVoice(voiceOn);
  voiceBtn.classList.toggle('on', voiceOn);
  voiceBtn.classList.toggle('off', !voiceOn);
  voiceBtn.textContent = voiceOn ? '🔊 Voice' : '🔇 Muted';
  voiceBtn.setAttribute('aria-pressed', String(voiceOn));
  if (!voiceOn) {
    voiceOut.flush();
    audioSegment = null;
    speakingAgent = '';
    field.setSpeaking('');
  }
});

let autoWorkOn = true;
$('btn-autowork').addEventListener('click', () => {
  autoWorkOn = !autoWorkOn;
  client.setAutoWork(autoWorkOn);
  const btn = $('btn-autowork');
  btn.classList.toggle('on', autoWorkOn);
  btn.classList.toggle('off', !autoWorkOn);
  btn.setAttribute('aria-pressed', String(autoWorkOn));
});

$('btn-test-voice').addEventListener('click', () => {
  void (async () => {
    try {
      setStatus('Testing voice…');
      const b64 = await decir('Pablo here. Can you hear me clearly?');
      await voiceOut.unlock();
      await voiceOut.playMp3(b64);
      setStatus(voiceSession ? 'Listening…' : 'Ready');
    } catch (err) {
      addMsg('system', `Voice test failed: ${err instanceof Error ? err.message : 'error'}`, 'sys');
      setStatus(voiceSession ? 'Listening…' : 'Ready');
    }
  })();
});

// ── Empresas (opcional) ─────────────────────────────────────────────
let currentCompany = '';
let currentGoal = '';

function meetingKey(companyId: string, goalId: string): string {
  return `pablo.meeting.${companyId}.${goalId}`;
}

// Read-through: la clave vieja de Sofia se lee una vez y se re-graba en la nueva.
function readMeetingKey(companyId: string, goalId: string): string | undefined {
  try {
    const fresh = window.localStorage.getItem(meetingKey(companyId, goalId));
    if (fresh) return fresh;
    const legacy = window.localStorage.getItem(`sofia.meeting.${companyId}.${goalId}`);
    if (legacy) {
      window.localStorage.setItem(meetingKey(companyId, goalId), legacy);
      return legacy;
    }
  } catch {
    // Sin storage: cada carga crea reunión nueva.
  }
  return undefined;
}

function connectTo(companyId: string, goalId: string): void {
  currentCompany = companyId;
  currentGoal = goalId;
  const meetingId = readMeetingKey(companyId, goalId);
  client.connect(companyId, goalId, meetingId);
}

// El servidor devuelve el meetingId en meeting_ready: persistirlo acá.
// (Se engancha vía onReady la primera vez: el Client no lo expone, así que
// lo guardamos cuando el servidor lo mande en un evento futuro. Por ahora
// el hello sin meetingId crea o reutiliza por company+goal en el servidor.)
async function renderCompanies(): Promise<void> {
  const box = $('companies-list');
  box.innerHTML = '';
  const companies = await listCompanies().catch(() => []);
  for (const c of companies) {
    const btn = document.createElement('button');
    btn.textContent = c.name;
    btn.classList.toggle('active', c.id === currentCompany);
    btn.addEventListener('click', () => {
      void (async () => {
        const goalId = await firstProject(c.id).catch(() => null);
        if (!goalId) return;
        connectTo(c.id, goalId);
        setStatus(`Switched to ${c.name}…`);
        void renderCompanies();
      })();
    });
    box.appendChild(btn);
  }
}
document.querySelector('.companies')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderCompanies();
});

// ── Puente orbe desktop (solo Tauri) ────────────────────────────────
function orbState(): string {
  if (liveMic.userSpeaking) return 'escuchando';
  if (voiceSession) return 'escuchando';
  if (speakingAgent) return 'hablando';
  return 'idle';
}

if (isTauri()) {
  const tick = async () => {
    try {
      const cmd = await tinvoke<string | null>('main_poll');
      if (cmd === 'toggle-mic') {
        void (voiceSession ? setVoiceSession(false, false) : setVoiceSession(true, false));
      } else if (cmd === 'expand') {
        await tinvoke('expand_from_orb').catch(() => {});
      }
    } catch {
      // Núcleo aún no listo.
    }
    try {
      await tinvoke('orb_report', {
        nuevo: orbState(),
        nivel: voiceSession ? Math.max(liveMic.level, 0.15) : speakingAgent ? 0.7 : 0
      });
    } catch {
      // Idem.
    }
  };
  void tick();
  window.setInterval(() => void tick(), 500);
}

// ── Permisos de computadora (solo desktop) ────────────────────────────
const PERM_CAPS = ['pantalla', 'mouse', 'teclado'] as const;
const PERM_LEVELS = ['permitir', 'preguntar', 'bloquear'] as const;
const PERM_LABEL: Record<string, string> = {
  pantalla: '🖥️ View screen',
  mouse: '🖱️ Move & click',
  teclado: '⌨️ Keys & typing'
};
// Etiquetas visibles en inglés; los values siguen el protocolo Rust (CAPS/LEVELS).
const PERM_LEVEL_LABEL: Record<string, string> = {
  permitir: 'Allow',
  preguntar: 'Ask',
  bloquear: 'Block'
};

async function renderPerms(): Promise<void> {
  if (!isTauri()) return;
  const box = $('perms-box');
  box.hidden = false;
  const list = $('perms-list');
  list.innerHTML = '';
  const current: Record<string, string> = await tinvoke<Record<string, string>>('get_permissions').catch(() => ({}));
  for (const cap of PERM_CAPS) {
    const row = document.createElement('div');
    row.className = 'perm-row';
    const label = document.createElement('span');
    label.textContent = PERM_LABEL[cap];
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', PERM_LABEL[cap]);
    for (const lv of PERM_LEVELS) {
      const opt = document.createElement('option');
      opt.value = lv;
      opt.textContent = PERM_LEVEL_LABEL[lv] || lv;
      sel.appendChild(opt);
    }
    sel.value = current[cap] || 'preguntar';
    sel.addEventListener('change', () => {
      void tinvoke('set_permission', { cap, level: sel.value }).catch((err) => {
        addMsg('system', `Permission failed: ${String(err)}`, 'sys');
      });
    });
    row.appendChild(label);
    row.appendChild(sel);
    list.appendChild(row);
  }
}
document.querySelector('#perms-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderPerms();
});

// ── Ajustes (cerebro, oído, voz) ──────────────────────────────────────
const LLM_KEY_FIELD: Record<string, { field: string; label: string }> = {
  minimax: { field: 'llm.apiKey', label: '🔑 MiniMax key' },
  deepseek: { field: 'llm.deepseekKey', label: '🔑 DeepSeek key' },
  opencode: { field: 'llm.opencodeKey', label: '🔑 opencode key' },
  groq: { field: 'llm.groqKey', label: '🔑 Groq key' }
};

function settingRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'perm-row';
  const span = document.createElement('span');
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(control);
  return row;
}

function settingGroup(title: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'set-group';
  div.textContent = title;
  return div;
}

function settingSelect(options: string[], current: string, labels?: Record<string, string>): HTMLSelectElement {
  const sel = document.createElement('select');
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt;
    el.textContent = labels?.[opt] || opt;
    sel.appendChild(el);
  }
  sel.value = current;
  return sel;
}

function flashSaved(): void {
  const prev = statusEl.textContent;
  setStatus('Saved ✓');
  window.setTimeout(() => {
    if (statusEl.textContent === 'Saved ✓') setStatus(prev);
  }, 1200);
}

async function renderSettings(): Promise<void> {
  const box = $('settings-list');
  box.innerHTML = '';
  let s: PublicSettings;
  try {
    s = await getSettings();
  } catch {
    box.textContent = 'No backend.';
    return;
  }
  const save = (patch: Record<string, string>, rerender = false): void => {
    void saveSettings(patch)
      .then(() => {
        flashSaved();
        if (rerender) void renderSettings();
      })
      .catch((err) => addMsg('system', `Setting failed: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
  };

  box.appendChild(settingGroup('Brain'));
  const provLabels: Record<string, string> = {};
  for (const p of s.llm.providerOptions) provLabels[p.id] = p.label;
  const provSel = settingSelect(s.llm.providerOptions.map((p) => p.id), s.llm.provider, provLabels);
  provSel.setAttribute('aria-label', 'Reasoning provider');
  provSel.addEventListener('change', () => save({ 'llm.provider': provSel.value }, true));
  box.appendChild(settingRow('🧠 Provider', provSel));

  const modelSel = settingSelect(s.llm.modelOptions, s.llm.model);
  modelSel.setAttribute('aria-label', 'Model');
  modelSel.addEventListener('change', () => save({ 'llm.model': modelSel.value }));
  box.appendChild(settingRow('📦 Model', modelSel));

  const keyInfo = LLM_KEY_FIELD[s.llm.provider] || LLM_KEY_FIELD.opencode;
  const masked = s.llm.provider === 'minimax' ? s.llm.apiKeyMasked
    : s.llm.provider === 'deepseek' ? s.llm.deepseekKeyMasked
    : s.llm.provider === 'opencode' ? s.llm.opencodeKeyMasked : '';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = masked || 'Empty — paste the key';
  keyInput.setAttribute('aria-label', keyInfo.label);
  keyInput.addEventListener('change', () => {
    if (!keyInput.value) return;
    save({ [keyInfo.field]: keyInput.value });
    keyInput.value = '';
  });
  box.appendChild(settingRow(keyInfo.label, keyInput));

  box.appendChild(settingGroup('Hearing'));
  const sttSel = settingSelect(s.stt.providerOptions, s.stt.provider);
  sttSel.setAttribute('aria-label', 'Transcription provider');
  sttSel.addEventListener('change', () => save({ 'stt.provider': sttSel.value }));
  box.appendChild(settingRow('👂 Transcription', sttSel));

  const wSel = settingSelect(s.stt.whisperModelOptions, s.stt.whisperModel);
  wSel.setAttribute('aria-label', 'Local Whisper model');
  wSel.addEventListener('change', () => save({ 'stt.whisperModel': wSel.value }));
  box.appendChild(settingRow('📦 Local Whisper', wSel));

  const groqInput = document.createElement('input');
  groqInput.type = 'password';
  groqInput.placeholder = s.stt.groqKeyMasked || 'Empty';
  groqInput.setAttribute('aria-label', 'Groq STT key');
  groqInput.addEventListener('change', () => {
    if (!groqInput.value) return;
    save({ 'stt.groqKey': groqInput.value });
    groqInput.value = '';
  });
  box.appendChild(settingRow('🔑 Groq key', groqInput));

  const dgInput = document.createElement('input');
  dgInput.type = 'password';
  dgInput.placeholder = s.stt.deepgramKeyMasked || 'Empty';
  dgInput.setAttribute('aria-label', 'Deepgram key');
  dgInput.addEventListener('change', () => {
    if (!dgInput.value) return;
    save({ 'stt.deepgramKey': dgInput.value });
    dgInput.value = '';
  });
  box.appendChild(settingRow('🔑 Deepgram key', dgInput));

  const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'English', auto: 'Auto' };
  const sttLang = (s.stt.language === 'es' || s.stt.language === 'en' || s.stt.language === 'auto')
    ? s.stt.language
    : (s.stt.language.startsWith('en') ? 'en' : (s.stt.language.startsWith('auto') ? 'auto' : 'es'));
  const langSel = settingSelect(['auto', 'es', 'en'], sttLang, LANG_LABELS);
  langSel.setAttribute('aria-label', 'Listening language');
  langSel.addEventListener('change', () => save({ 'stt.language': langSel.value }));
  box.appendChild(settingRow('🗣️ Listening language', langSel));

  // Umbral de confianza STT (§2e): debajo reintenta una vez en Deepgram
  // (turno corto + key). El valor guardado manda aunque no esté en la lista.
  const CONF_LABELS: Record<string, string> = { '0.3': 'Bajo (0.3)', '0.4': 'Medio (0.4)', '0.55': 'Default (0.55)', '0.7': 'Alto (0.7)' };
  const confCur = String(s.stt.minConfidence ?? 0.55);
  const confOpts = Object.keys(CONF_LABELS).includes(confCur) ? Object.keys(CONF_LABELS) : [confCur, ...Object.keys(CONF_LABELS)];
  const confSel = settingSelect(confOpts, confCur, { ...CONF_LABELS, [confCur]: CONF_LABELS[confCur] || `Guardado (${confCur})` });
  confSel.setAttribute('aria-label', 'STT min confidence');
  confSel.addEventListener('change', () => save({ 'stt.minConfidence': confSel.value }));
  box.appendChild(settingRow('🎯 Min confidence', confSel));

  box.appendChild(settingGroup('Voice'));
  const ttsLangCur = (s.tts.language === 'es' || s.tts.language === 'en')
    ? s.tts.language
    : (s.tts.language.startsWith('en') ? 'en' : 'es');
  const ttsSel = settingSelect(['es', 'en'], ttsLangCur, LANG_LABELS);
  ttsSel.setAttribute('aria-label', 'Voice language');
  ttsSel.addEventListener('change', () => save({ 'tts.language': ttsSel.value }));
  box.appendChild(settingRow('🗣️ Voice language', ttsSel));
}
document.querySelector('#settings-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderSettings();
});
if (isTauri()) {
  $('perms-box').hidden = false;
}

// Debug: window.__pablo (para auditoría; __sofia queda como alias legacy).
(window as unknown as { __pablo: object; __sofia?: object }).__pablo = {
  client,
  voiceOut,
  liveMic,
  agents,
  get voiceOn() {
    return voiceOn;
  },
  get voiceSession() {
    return voiceSession;
  }
};
(window as unknown as { __pablo: object; __sofia?: object }).__sofia =
  (window as unknown as { __pablo: object }).__pablo;

// ── Arranque ────────────────────────────────────────────────────────
layoutOrbs();

(async () => {
  try {
    await resolveBase();
    const space = await findOrCreatePabloSpace();
    connectTo(space.companyId, space.goalId);
  } catch (err) {
    setStatus(`No backend: ${err instanceof Error ? err.message : 'error'}`);
  }
})();
