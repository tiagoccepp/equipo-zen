// Pablo — UI Lovable-oscura + loop de voz dinámico upstream
// (VAD continuo + barge-in + gate de audio + work-events).

import './app.css';
import type { OrbAgent, OrbSlot } from './lib/call-orbs.ts';
import { OrbMorph, type AgentVisualState } from './fx/orb-morph.ts';
import { createOrb3D, probeWebGL2, type Orb3D } from './fx/orb3d.ts';
// Glifos B (T2b): side-effect que registra los 50 en el lookup de A.
import './fx/glyphs-index.ts';
import { mountJobs } from './jobs/view.ts';
import { mountManager } from './manager/view.ts';
import './manager/manager.css';
import { mountMissionControl } from './mission/view.ts';
import './mission/mission.css';
import './fx/motion.css';
import { mountMotion, setSpeakingGlow } from './fx/motion.ts';
import { mountPalette } from './fx/palette.ts';
import { mountMesh } from './fx/mesh.ts';
import { isTauri, tinvoke } from './lib/tauri.ts';
import {
  Client,
  apiJson,
  decir,
  findOrCreatePabloSpace,
  firstProject,
  getAudioDevices,
  getSettings,
  getSidecars,
  listCompanies,
  resolveBase,
  saveSettings,
  setAudioMute,
  setAudioVolume,
  testAudioOutput,
  type Agent,
  type PublicSettings,
  type SidecarStatus
} from './client.ts';
import { BrowserSpeech, LiveMic, VoiceOut, computeEndpointing, hintTail, type TurnVoiceStats } from './voice.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`falta #${id}`);
  return el;
};

// Pelado defensivo de tags [[...]] (el backend ya limpia; esto cubre
// mocks y textos viejos para que nunca se vean literales en el chat).
const stripGestoTags = (s: string): string => s.replace(/\[\[[^\]]*\]\]/g, '');

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

// ── Vistas (T3 minimal: 1 columna, tabs + hash) ─────────────────────────
// #view-jobs y #view-manager los monta main (T4/T5); acá solo switch + tabs.
type ViewName = 'console' | 'jobs' | 'manager' | 'settings';
const VIEW_ORDER: ViewName[] = ['console', 'jobs', 'manager', 'settings'];
let currentView: ViewName = 'console';
let jobsMounted = false;
let managerMounted = false;

function switchView(name: ViewName): void {
  if (!VIEW_ORDER.includes(name)) name = 'console';
  currentView = name;
  for (const v of VIEW_ORDER) {
    document.getElementById(`view-${v}`)?.toggleAttribute('hidden', v !== name);
  }
  document.querySelectorAll('.tabs [data-view]').forEach((btn) => {
    const on = (btn as HTMLElement).dataset.view === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    (btn as HTMLButtonElement).tabIndex = on ? 0 : -1;
  });
  try {
    history.replaceState(null, '', `#/${name}`);
  } catch {
    // Sin history (file://, webview vieja): las vistas igual andan.
  }
  // Montaje perezoso v2 (integración main): jobs/manager se montan una
  // sola vez al visitar su tab (boot rápido, fetch con apiBase correcto).
  if (name === 'jobs' && !jobsMounted) {
    const el = document.getElementById('view-jobs');
    if (el) {
      try {
        mountJobs(el, { fetchJson: (path: string, init?: RequestInit) => apiJson(path, init) });
        jobsMounted = true;
      } catch (err) {
        console.warn('[jobs] mount falló:', err);
      }
    }
  }
  if (name === 'manager' && !managerMounted) {
    const el = document.getElementById('view-manager');
    if (el) {
      try {
        mountManager(el, { fetchJson: (path: string, init?: RequestInit) => apiJson(path, init) });
        managerMounted = true;
      } catch (err) {
        console.warn('[manager] mount falló:', err);
      }
    }
  }
  if (name === 'console') {
    // El canvas vuelve a tener tamaño: re-layout vía el listener existente.
    window.dispatchEvent(new Event('resize'));
  }
}

function initViews(): void {
  const nav = document.querySelector('.tabs') as HTMLElement | null;
  nav?.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView((btn as HTMLElement).dataset.view as ViewName));
  });
  // Roving tabindex: ←/→ se mueven entre tabs, el foco entra con Tab.
  nav?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = VIEW_ORDER.indexOf(currentView);
    const next = VIEW_ORDER[(idx + (e.key === 'ArrowRight' ? 1 : VIEW_ORDER.length - 1)) % VIEW_ORDER.length];
    switchView(next);
    (nav.querySelector(`[data-view="${next}"]`) as HTMLButtonElement | null)?.focus();
  });
  const hash = window.location.hash.replace(/^#\/?/, '') as ViewName;
  switchView(VIEW_ORDER.includes(hash) ? hash : 'console');
}

function addMsg(who: string, text: string, cls = '', title = ''): void {
  // Primer mensaje real: fuera el empty-state honesto del HTML.
  document.getElementById('stream-empty')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${cls}`.trim();
  if (title) div.title = title;
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

// Gracia de endpointing: una mini-pausa no cierra el turno. 1000 ms,
// alineada con GRACE_BASE_MS de voice.ts (09/11: la espera VAD+gracia era
// el 85% del stop→transcript; 1200 sobraba).
const GRACE_MS = 1000;
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
  setSpeaking('');
  setStatus('Stopped — listening to you.');
}

function maybePlaybackComplete(): void {
  if (audioSegment?.endReceived && !voiceOut.isPlaying) {
    client.playbackComplete(audioSegment.turnId, audioSegment.agentId);
    if (speakingAgent === audioSegment.agentId) {
      speakingAgent = '';
      setSpeaking('');
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
    // Barge-in acústico (rápido, durante audio): corta TODOS los turnos
    // en vuelo (segmento + pensamientos), no solo el segmento actual —
    // si no, las frases siguientes del agente seguían sonando y parecía
    // que interrumpir "no funcionaba". Si la confirmación ya cortó,
    // no duplicar.
    if (interruptSentForTurn) return;
    cancelPendingCut();
    interruptSentForTurn = true;
    turnHadInterrupt = true;
    pruneActiveTurns();
    const targets = interruptTargets();
    if (targets.length === 0) {
      client.interrupt(audioSegment?.turnId, audioSegment?.agentId);
    } else {
      for (const t of targets) client.interrupt(t.turnId, t.agentId);
    }
    noteLocalInterrupt();
    voiceOut.flush();
    voiceOut.restoreGain();
    speakingAgent = '';
    setSpeaking('');
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

// Renderer de orbes: OrbMorph (2D) pinta ya; si hay WebGL2 se sube a Orb3D.
// V3 modelo-manda: `visualStates` es la fuente de verdad para re-aplicar
// VIBRACIÓN por estado tras el swap (orbe siempre orbe; figuras solo vía
// setGlyph cuando el modelo emite [[gesto:X]]).
type OrbRenderer = OrbMorph | Orb3D;
let field: OrbRenderer = new OrbMorph(canvas, { energy: callEnergy });
field.setTheme('dark');
let orbMode: 'morph' | 'webgl' = 'morph';
const visualStates = new Map<string, AgentVisualState>();

const agents = new Map<string, Agent>();
const working = new Set<string>();

function restState(agentId: string): AgentVisualState {
  if (working.has(agentId)) return 'trabajando';
  if (voiceSession) return 'escuchando';
  return 'idle';
}

function setVisual(agentId: string, state: AgentVisualState): void {
  // V3: el estado solo modula vibración/energía sutil, NUNCA la figura.
  visualStates.set(agentId, state);
  field.setAgentState(agentId, state);
}
// Debug V3 (auditoría visual, espejo de window.__pablo): permite forzar
// estados desde consola/e2e para verificar orbe-siempre-orbe.
(window as unknown as { __setVisual?: typeof setVisual }).__setVisual = setVisual;

// Wrapper único de speaking: orbe + glow + vibración (fx). Todo cambio de
// "quién habla" pasa por acá para que nada quede prendido a medias.
let lastSpeaking = '';
function glowSpeaking(agentId: string): void {
  cellsEl.querySelectorAll('[data-speaking]').forEach((el) => setSpeakingGlow(el as HTMLElement, false));
  if (!agentId) return;
  const cell = cellsEl.querySelector(`[data-agent-id="${agentId}"]`) as HTMLElement | null;
  if (cell) setSpeakingGlow(cell, true);
}
function setSpeaking(agentId: string): void {
  field.setSpeaking(agentId);
  glowSpeaking(agentId);
  if (lastSpeaking && lastSpeaking !== agentId) {
    setVisual(lastSpeaking, restState(lastSpeaking));
  }
  if (agentId) setVisual(agentId, 'hablando');
  lastSpeaking = agentId;
}

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
    cell.dataset.agentId = a.id;
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

// ── 3D vivo: si hay WebGL2, el canvas 2D se reemplaza por uno fresco con
// Orb3D (mismo slot, misma energía, orbe siempre orbe + vibración). Si algo
// falla, OrbMorph sigue (fallback silencioso + log).
async function upgradeTo3D(): Promise<void> {
  const probe = probeWebGL2();
  if (!probe.ok) {
    console.info(`[orb] morph 2D: sin WebGL2 (${probe.error})`);
    return;
  }
  try {
    const replacement = document.createElement('canvas');
    replacement.id = canvas.id;
    canvas.replaceWith(replacement);
    const orb3d = await createOrb3D(replacement, { energy: callEnergy });
    field.stop();
    orb3d.setTheme('dark');
    field = orb3d;
    orbMode = 'webgl';
    layoutOrbs();
    glowSpeaking(lastSpeaking);
    if (lastSpeaking) field.setSpeaking(lastSpeaking);
    field.setWorking([...working]);
    for (const [id, state] of visualStates) field.setAgentState(id, state);
    console.info(`[orb] webgl 3D: ${probe.renderer || 'renderer desconocido'}`);
  } catch (err) {
    console.info(`[orb] morph 2D: Orb3D no disponible (${String(err)})`);
  }
}

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
    const n = list.length;
    greetEl.textContent = n === 0
      ? 'Team console — no agents'
      : `${pablo?.name || 'Team'} · ${n} agent${n === 1 ? '' : 's'} ready`;
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
    // Pensamiento silencioso: vibración leve. Cuando rompa a hablar,
    // setSpeaking sube la vibración (orbe siempre orbe, V3).
    if (agentId !== speakingAgent) setVisual(agentId, 'pensando');
  },
  onSpeakStart: (agentId) => {
    // Primera palabra audible del modelo: marca TTFV (voz) para telemetría.
    const dt = lastSpeechEndAt ? Math.round(performance.now() - lastSpeechEndAt) : -1;
    console.info(`[ttfv] ${agentName(agentId)} primera palabra a +${dt}ms del fin de habla`);
    (window as any).__lastTtfvMs = dt;
  },
  onProgress: (agentId, text) => {
    // Avance del modelo: se ve, no se habla. Estado transitorio.
    setStatus(`…${text.slice(0, 80)}`);
    if (agentId && agentId !== speakingAgent && !working.has(agentId)) {
      setVisual(agentId, 'pensando');
    }
  },
  // Actividad de tools: 1 línea compacta por evento en el feed (sys),
  // nunca en el chat principal. El preview completo va en title.
  onToolCall: (_agentId, tool, argsPreview) => {
    const args = argsPreview ? ` ${argsPreview.slice(0, 120)}` : '';
    addMsg('tools', `🔧 ${tool}${args}`, 'sys', argsPreview || tool);
  },
  onToolDone: (_agentId, tool, ok, ms, outputPreview) => {
    const out = outputPreview ? `: ${outputPreview.slice(0, 120)}` : '';
    const line = ok ? `✅ ${tool} done in ${Math.round(ms)}ms${out}` : `❌ ${tool} failed${out}`;
    addMsg('tools', line, 'sys', outputPreview || tool);
  },
  onDelta: (agentId, delta) => {
    turnText.set(agentId, (turnText.get(agentId) || '') + delta);
  },
  onAgentEnd: (agentId, text, turnId) => {
    if (turnId) activeTurns.delete(turnId);
    // Cinturón + tirantes: el backend pela los tags, pero si alguno llega
    // (mock, replay viejo), no se muestra literal en el chat.
    const full = stripGestoTags(text || turnText.get(agentId) || '');
    turnText.delete(agentId);
    if (full.trim()) {
      addMsg(agentName(agentId).toLowerCase(), full);
    }
    // El subtítulo sigue al AUDIO, no al texto: si suena, no se limpia acá.
    if (!audioSegment && speakingAgent === agentId) {
      speakingAgent = '';
      setSpeaking('');
      if (!voiceSession) setStatus('Ready');
    }
    // Fin del turno de texto: si no está hablando, vuelve al reposo real
    // (baja la vibración de "pensando" que puso onAgentStart).
    if (agentId !== speakingAgent) setVisual(agentId, restState(agentId));
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
    setSpeaking(agentId);
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
      setSpeaking(agentId);
    } else if ((state === 'idle' || state === 'interrupted') && speakingAgent === agentId && !audioSegment) {
      speakingAgent = '';
      setSpeaking('');
    }
  },
  // Gesto v2: el backend ya peló el tag del texto/habla; acá solo morphéa.
  // Gesto inválido = lookup null = setGlyph ignora (nunca rompe la vista).
  onGesto: (agentId, gesto) => {
    try {
      field.setGlyph(agentId, gesto);
    } catch (err) {
      console.warn('[gesto] setGlyph falló:', err);
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
      setSpeaking('');
    }
    if (agentId) setVisual(agentId, restState(agentId));
    setStatus(voiceSession ? 'Listening…' : 'Ready');
  },
  onWorkEvent: (kind, agentId, event) => {
    // task_started → arco giratorio; task_done/blocked → fuera.
    if (kind === 'task_started' || kind === 'task_queued' || kind === 'comando' || kind === 'file_written' || kind === 'web') {
      if (agentId) {
        working.add(agentId);
        if (agentId !== speakingAgent) setVisual(agentId, 'trabajando');
      }
    } else if (kind === 'task_done' || kind === 'task_blocked') {
      if (agentId) {
        working.delete(agentId);
        if (agentId !== speakingAgent) setVisual(agentId, restState(agentId));
      }
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
    // Los que solo escuchaban vuelven a idle (los busy conservan su vibración).
    for (const [id, state] of visualStates) {
      if (state === 'escuchando') setVisual(id, 'idle');
    }
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
    locale = settings.stt.language.startsWith('es') ? 'es-ES' : 'en-US';
  } catch {
    // Sin backend: inglés por defecto.
  }
  browserSpeech.start(locale);
  voiceSession = true;
  voiceGroup = group;
  micBtn.classList.toggle('live', !group);
  callBtn.classList.toggle('live', group);
  // Mic abierto: vibración de escucha en los libres (hablando/trabajando conservan la suya).
  const ids = agents.size > 0 ? [...agents.keys()] : ['pablo'];
  for (const id of ids) {
    if (id !== speakingAgent && !working.has(id)) setVisual(id, 'escuchando');
  }
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
    setSpeaking('');
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
  // TG orbe-mini: Tauri 2 no emite evento de minimizado; se detecta con
  // isMinimized() en este tick y se avisa SOLO en transiciones.
  let wasMinimized = false;
  let minCheck: (() => Promise<boolean>) | null = null;
  const tick = async () => {
    try {
      if (!minCheck) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        minCheck = () => w.isMinimized();
      }
      const minimized = await minCheck().catch(() => false);
      if (minimized !== wasMinimized) {
        wasMinimized = minimized;
        await tinvoke(minimized ? 'main_minimized' : 'main_restored').catch(() => {});
      }
    } catch {
      // Núcleo aún no listo.
    }
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

  // Orden de la cadena STT (stt.order): CSV de motores, aplica en caliente.
  // Vacío = default según provider. Motores: parakeet, whisper, groq, deepgram.
  const orderInput = document.createElement('input');
  orderInput.type = 'text';
  orderInput.value = s.stt.order || '';
  orderInput.placeholder = s.stt.orderDefault || 'parakeet,groq,deepgram';
  orderInput.setAttribute('aria-label', 'STT engine order');
  orderInput.spellcheck = false;
  orderInput.addEventListener('change', () => save({ 'stt.order': orderInput.value.trim() }));
  box.appendChild(settingRow('🔀 STT order', orderInput));
  const sttNote = document.createElement('div');
  sttNote.className = 'sidecar-note';
  sttNote.textContent = 'Motores: parakeet, whisper, groq, deepgram — solo los listados se intentan, en orden.';
  box.appendChild(sttNote);

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

  // Motor TTS local preferido (auto = Piper → Supertonic; el 2º respalda).
  const engSel = settingSelect(s.tts.engineOptions || ['auto', 'piper', 'supertonic'], s.tts.engine || 'auto');
  engSel.setAttribute('aria-label', 'TTS engine');
  engSel.addEventListener('change', () => save({ 'tts.engine': engSel.value }));
  box.appendChild(settingRow('🔊 TTS engine', engSel));

  // Orden de la cascada TTS (tts.order): CSV de motores, aplica en caliente.
  // Vacío = default legacy (Deepgram-con-key → locales → Edge). Solo los
  // listados se intentan, en orden: el elegido manda, el resto out.
  const ttsOrderInput = document.createElement('input');
  ttsOrderInput.type = 'text';
  ttsOrderInput.value = s.tts.order || '';
  ttsOrderInput.placeholder = s.tts.orderDefault || 'deepgram,piper,supertonic,edge';
  ttsOrderInput.setAttribute('aria-label', 'TTS engine order');
  ttsOrderInput.spellcheck = false;
  ttsOrderInput.addEventListener('change', () => save({ 'tts.order': ttsOrderInput.value.trim() }));
  box.appendChild(settingRow('🔀 TTS order', ttsOrderInput));
  const ttsNote = document.createElement('div');
  ttsNote.className = 'sidecar-note';
  ttsNote.textContent = 'Motores: piper, supertonic, deepgram, edge — solo los listados se intentan, en orden.';
  box.appendChild(ttsNote);

  // ── Audio: routing PipeWire (salida/entrada) ──────────────────────
  // followDefault on = los streams siguen al sistema (selects off).
  // Volumen/mute son vivos e independientes del routing: siempre activos.
  box.appendChild(settingGroup('Audio'));
  const audioSel = s.audio || { output: 'default', input: 'default', followDefault: true };
  // (audio fns: import estático arriba; el dinámico duplicaba el chunk core).
  let audioDev = null;
  try {
    audioDev = await getAudioDevices();
  } catch {
    audioDev = null;
  }
  const followBox = document.createElement('input');
  followBox.type = 'checkbox';
  followBox.checked = audioSel.followDefault !== false;
  followBox.setAttribute('aria-label', 'Follow system default audio');
  followBox.addEventListener('change', () =>
    save({ 'audio.followDefault': followBox.checked ? 'true' : 'false' }, true));
  box.appendChild(settingRow('🔀 Follow system default', followBox));
  if (!audioDev) {
    const note = document.createElement('div');
    note.className = 'sidecar-note';
    note.textContent = 'Audio devices unavailable — is PipeWire running on this machine?';
    box.appendChild(note);
  } else {
    const sinks = audioDev.sinks || [];
    const sources = audioDev.sources || [];
    const withSaved = (list: Array<{ name: string; description: string }>, saved: string): string[] => {
      const names = list.map((d) => d.name);
      return saved && saved !== 'default' && !names.includes(saved) ? [saved, ...names] : names;
    };
    const labelsFor = (list: Array<{ name: string; description: string; isDefault: boolean }>, kind: string): Record<string, string> => {
      const labels: Record<string, string> = {};
      for (const d of list) labels[d.name] = `${d.description}${d.isDefault ? ' (system default)' : ''}`;
      return { ...labels, [kind]: `Saved (not present)` };
    };
    const outSel = settingSelect(withSaved(sinks, audioSel.output), audioSel.output || 'default', labelsFor(sinks, audioSel.output));
    outSel.setAttribute('aria-label', 'Audio output');
    outSel.disabled = followBox.checked;
    outSel.addEventListener('change', () => save({ 'audio.output': outSel.value }));
    box.appendChild(settingRow('🔈 Output', outSel));
    const inSel = settingSelect(withSaved(sources, audioSel.input), audioSel.input || 'default', labelsFor(sources, audioSel.input));
    inSel.setAttribute('aria-label', 'Audio input');
    inSel.disabled = followBox.checked;
    inSel.addEventListener('change', () => save({ 'audio.input': inSel.value }));
    box.appendChild(settingRow('🎙️ Input', inSel));
    // Volumen/mute del efectivo: guardado si existe, si no el default.
    const effective = (list: typeof sinks, saved: string): (typeof sinks)[number] | undefined =>
      list.find((d) => d.name === saved) || list.find((d) => d.isDefault) || list[0];
    const volRow = (dev: { name: string; volume: number | null; muted: boolean | null } | undefined, label: string): void => {
      if (!dev) return;
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.gap = '8px';
      wrap.style.alignItems = 'center';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round((dev.volume ?? 1) * 100));
      slider.setAttribute('aria-label', `${label} volume`);
      slider.style.flex = '1';
      slider.addEventListener('change', () => {
        void setAudioVolume(dev.name, Number(slider.value) / 100)
          .then(() => flashSaved())
          .catch((err) => addMsg('system', `Volume failed: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
      });
      const mute = document.createElement('input');
      mute.type = 'checkbox';
      mute.checked = dev.muted === true;
      mute.title = 'Mute';
      mute.setAttribute('aria-label', `${label} mute`);
      mute.addEventListener('change', () => {
        void setAudioMute(dev.name, mute.checked)
          .then(() => flashSaved())
          .catch((err) => addMsg('system', `Mute failed: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
      });
      wrap.append(slider, mute);
      box.appendChild(settingRow(label, wrap));
    };
    volRow(effective(sinks, audioSel.output), '🎚️ Out volume');
    volRow(effective(sources, audioSel.input), '🎚️ In volume');
    const testBtn = document.createElement('button');
    testBtn.className = 'pill';
    testBtn.textContent = '🔔 Probar salida';
    testBtn.setAttribute('aria-label', 'Test audio output');
    testBtn.addEventListener('click', () => {
      const target = effective(sinks, audioSel.output)?.name || '';
      testBtn.textContent = '🔔…';
      void testAudioOutput(followBox.checked ? '' : target)
        .then(() => { testBtn.textContent = '🔔 Probar salida'; flashSaved(); })
        .catch((err) => {
          testBtn.textContent = '🔔 Probar salida';
          addMsg('system', `Test tone failed: ${err instanceof Error ? err.message : 'error'}`, 'sys');
        });
    });
    box.appendChild(settingRow('🔔 Test', testBtn));
  }

  // Sidecars: estado del watchdog STT/TTS (GET directo, sin WS).
  box.appendChild(settingGroup('Sidecars'));
  const scWrap = document.createElement('div');
  scWrap.id = 'sidecars-list';
  scWrap.className = 'sidecars';
  const scLoading = document.createElement('div');
  scLoading.className = 'sidecar-note';
  scLoading.textContent = 'Loading sidecars…';
  scWrap.appendChild(scLoading);
  box.appendChild(scWrap);
  const scFoot = document.createElement('div');
  scFoot.className = 'sidecars-foot';
  const scRefresh = document.createElement('button');
  scRefresh.className = 'pill';
  scRefresh.textContent = '↻ Refresh';
  scRefresh.setAttribute('aria-label', 'Refresh sidecar status');
  scRefresh.addEventListener('click', () => void renderSidecars(scWrap));
  scFoot.appendChild(scRefresh);
  box.appendChild(scFoot);
  void renderSidecars(scWrap);
}

// ── Sidecars: 1 fila por sidecar (dot + métricas del watchdog) ─────────
// Auto-refresh cada 20s SOLO con Ajustes abierto; al cerrar se limpia.
let sidecarTimer: number | null = null;
const SIDECAR_REFRESH_MS = 20000;

function sidecarRow(s: SidecarStatus): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'sidecar-row';
  const dot = document.createElement('span');
  // status del server: 'up' | 'down' | 'unknown' (watchdog aún sin tick).
  const cls = s.status === 'up' ? 'up' : s.status === 'down' ? 'down' : 'unknown';
  dot.className = `sidecar-dot ${cls}`;
  dot.title = s.status;
  const name = document.createElement('span');
  name.className = 'sidecar-name';
  name.textContent = s.name;
  const meta = document.createElement('span');
  meta.className = 'sidecar-meta';
  meta.textContent =
    `${s.status} · downs ${s.downs} · restarts/h ${s.restartsLastHour} · autostart ${s.autostart ? 'on' : 'off'}`;
  row.append(dot, name, meta);
  return row;
}

async function renderSidecars(wrap: HTMLElement): Promise<void> {
  // Sin loading intermedio en cada refresh: el contenido viejo queda hasta
  // que el fetch resuelve (evita flicker en el auto-refresh de 20s).
  let list: SidecarStatus[];
  try {
    list = await getSidecars();
  } catch {
    wrap.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'sidecar-note';
    err.textContent = 'Sidecars unavailable — is the backend running?';
    wrap.appendChild(err);
    return;
  }
  wrap.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidecar-note';
    empty.textContent = 'No sidecars configured.';
    wrap.appendChild(empty);
    return;
  }
  for (const s of list) wrap.appendChild(sidecarRow(s));
}

function stopSidecarRefresh(): void {
  if (sidecarTimer !== null) {
    window.clearInterval(sidecarTimer);
    sidecarTimer = null;
  }
}

function startSidecarRefresh(): void {
  stopSidecarRefresh();
  sidecarTimer = window.setInterval(() => {
    // El contenedor se rebusca en cada tick: renderSettings lo recrea.
    const box = document.getElementById('settings-box') as HTMLDetailsElement | null;
    const el = document.getElementById('sidecars-list');
    if (!box?.open || !el) return;
    void renderSidecars(el);
  }, SIDECAR_REFRESH_MS);
}
document.querySelector('#settings-box')?.addEventListener('toggle', (e) => {
  const open = (e.target as HTMLDetailsElement).open;
  if (open) {
    void renderSettings();
    startSidecarRefresh();
  } else {
    stopSidecarRefresh();
  }
});
// T3: Companies y Settings arrancan abiertos en su vista → render inicial
// sin esperar el primer toggle (que ya no llega solo).
{
  const companiesBox = document.querySelector('.companies') as HTMLDetailsElement | null;
  if (companiesBox?.open) void renderCompanies();
  const settingsBox = document.getElementById('settings-box') as HTMLDetailsElement | null;
  if (settingsBox?.open) {
    void renderSettings();
    startSidecarRefresh();
  }
}
if (isTauri()) {
  $('perms-box').hidden = false;
}

// ── FX + Mission Control (integración main) ──────────────────────────
mountMotion();
{
  const meshCanvas = document.createElement('canvas');
  meshCanvas.id = 'fx-mesh';
  meshCanvas.setAttribute('aria-hidden', 'true');
  meshCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:.5';
  document.body.prepend(meshCanvas);
  const shell = document.querySelector('.shell') as HTMLElement | null;
  if (shell) {
    shell.style.position = 'relative';
    shell.style.zIndex = '1';
  }
  const mesh = mountMesh(meshCanvas, { energy: callEnergy });
  const sizeMesh = (): void => mesh.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', sizeMesh);
  sizeMesh();
}
// ── Command bar Ctrl+K (T3): vistas, voz, jobs, MCP ────────────────────
// helpers de acciones (usan estado existente; sin tocar región visual).
function newMeeting(): void {
  if (!currentCompany || !currentGoal) {
    setStatus('No company yet — pick one in Settings first.');
    switchView('settings');
    return;
  }
  try {
    window.localStorage.removeItem(meetingKey(currentCompany, currentGoal));
  } catch {
    // Sin storage: el servidor igual crea reunión nueva sin meetingId.
  }
  switchView('console');
  client.connect(currentCompany, currentGoal);
  setStatus('New meeting started…');
}

async function mcpReconnect(): Promise<void> {
  setStatus('Reconnecting MCP…');
  try {
    const res = await fetch('/api/mcp/reconnect', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus('MCP reconnect requested ✓');
  } catch (err) {
    setStatus('MCP reconnect not available yet');
    addMsg('system', `MCP reconnect failed: ${err instanceof Error ? err.message : 'error'}`, 'sys');
  }
}

function openMission(): void {
  switchView('settings');
  const box = document.getElementById('settings-box') as HTMLDetailsElement | null;
  if (box) {
    box.open = true;
    document.getElementById('mission-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

const palette = mountPalette({
  actions: [
    { id: 'go-console', label: 'Go to Console', group: 'Views', kbd: '1' },
    { id: 'go-jobs', label: 'Go to Jobs', group: 'Views', kbd: '2' },
    { id: 'go-manager', label: 'Go to Manager', group: 'Views', kbd: '3' },
    { id: 'go-settings', label: 'Go to Settings', group: 'Views', kbd: '4' },
    { id: 'mic', label: 'Mic on/off', group: 'Voice', hint: 'voice session' },
    { id: 'call', label: 'Group call on/off', group: 'Voice', hint: 'everyone listens' },
    { id: 'voice', label: 'Spoken replies on/off', group: 'Voice', hint: 'mute output' },
    { id: 'voice-check', label: 'Voice check', group: 'Voice', hint: 'test playback' },
    { id: 'new-meeting', label: 'New meeting', group: 'Session', hint: 'fresh round' },
    { id: 'jobs-recent', label: 'Recent jobs', group: 'Session', hint: 'history + replay' },
    { id: 'mcp-reconnect', label: 'Reconnect MCP', group: 'Session', hint: 'retry servers' },
    { id: 'mission', label: 'Open Mission Control', group: 'Session', hint: 'dashboard' }
  ],
  onAction: (id) => {
    if (id === 'go-console') switchView('console');
    else if (id === 'go-jobs') switchView('jobs');
    else if (id === 'go-manager') switchView('manager');
    else if (id === 'go-settings') switchView('settings');
    else if (id === 'mic') micBtn.click();
    else if (id === 'call') callBtn.click();
    else if (id === 'voice') voiceBtn.click();
    else if (id === 'voice-check') $('btn-test-voice').click();
    else if (id === 'new-meeting') newMeeting();
    else if (id === 'jobs-recent') switchView('jobs');
    else if (id === 'mcp-reconnect') void mcpReconnect();
    else if (id === 'mission') openMission();
  }
});
$('btn-palette').addEventListener('click', () => palette.toggle());
initViews();
{
  const settingsBox = document.getElementById('settings-box');
  if (settingsBox) {
    const section = document.createElement('section');
    section.className = 'setting-group';
    const title = document.createElement('h3');
    title.textContent = 'Mission Control';
    const mcEl = document.createElement('div');
    mcEl.id = 'mission-list';
    section.appendChild(title);
    section.appendChild(mcEl);
    settingsBox.appendChild(section);
    mountMissionControl(mcEl, {
      getLiveSpeakers: () => (speakingAgent ? [speakingAgent] : []),
      getVoiceActive: () => voiceSession
    });
  }
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
  },
  get orbMode() {
    return orbMode;
  }
};
(window as unknown as { __pablo: object; __sofia?: object }).__sofia =
  (window as unknown as { __pablo: object }).__pablo;

// ── Arranque ────────────────────────────────────────────────────────
layoutOrbs();
// 3D diferido (opt 09/11 #7): three.js = 85% del bundle y se parseaba en
// cada boot. El 2D arranca al instante; el upgrade a WebGL corre idle.
const idleCall = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
if (idleCall) {
  idleCall(() => { void upgradeTo3D(); }, { timeout: 4000 });
} else {
  window.setTimeout(() => { void upgradeTo3D(); }, 1200);
}

(async () => {
  try {
    await resolveBase();
    const space = await findOrCreatePabloSpace();
    connectTo(space.companyId, space.goalId);
  } catch (err) {
    setStatus(`No backend: ${err instanceof Error ? err.message : 'error'}`);
  }
})();
