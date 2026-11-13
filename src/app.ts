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
import './integrations/integration.css';
import './fx/motion.css';
import { mountMotion, setSpeakingGlow } from './fx/motion.ts';
import { mountPalette } from './fx/palette.ts';
import { mountMesh } from './fx/mesh.ts';
import { isTauri, tinvoke } from './lib/tauri.ts';
import { renderRichMessage } from './lib/mermaid-inline.ts';
import { HeardTurn, type AudioTag } from './lib/heard-text.ts';
import { activeWord, buildCues } from './lib/karaoke.ts';
import { defaultFigureQueue, upsertFigure, type Figure } from './lib/figures-view.ts';
import { loadMermaidReal } from './lib/mermaid-inline.ts';
import { WorkingEarcon } from './lib/working-earcon.ts';
import { classifyInterruption, shouldCut } from './lib/turn-taking.ts';
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
type ViewName = 'console' | 'projects' | 'jobs' | 'manager' | 'settings';
const VIEW_ORDER: ViewName[] = ['console', 'projects', 'jobs', 'manager', 'settings'];
let currentView: ViewName = 'console';
let jobsMounted = false;
let managerMounted = false;
let projectsMcMounted = false;

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
  if (name === 'projects') {
    if (!projectsMcMounted) {
      const mc = document.getElementById('projects-mc');
      if (mc) {
        try {
          mountMissionControl(mc, {
            getLiveSpeakers: () => (speakingAgent ? [speakingAgent] : []),
            getVoiceActive: () => voiceSession
          });
          projectsMcMounted = true;
        } catch (err) {
          console.warn('[projects-mc] mount failed:', err);
        }
      }
    }
    void renderProjectsView();
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
  // Acciones del rail ("Manage"): navegan como si fueran tabs.
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.dataset.goto as ViewName;
      if (VIEW_ORDER.includes(target)) switchView(target);
    });
  });
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
  // QW-06: bloques ```mermaid se dibujan inline; sin fence, texto plano igual que antes.
  renderRichMessage(div, text);
  streamEl.appendChild(div);
  while (streamEl.childElementCount > 80) {
    streamEl.firstElementChild?.remove();
  }
  streamEl.scrollTop = streamEl.scrollHeight;
}

// QW-07: heard-text progresivo — el texto se revela al ritmo del audio.
// Clave por turno (el gate serializa el audio: un turno suena a la vez).
const HEARD_GRACE_MS = 1500;
const heardTurns = new Map<string, HeardTurn>();
const heardBubbles = new Map<string, HTMLElement>();
const heardFull = new Map<string, string>();
const heardAgent = new Map<string, string>();
const heardGrace = new Map<string, number>();
const heardRevealed = new Map<string, number>();
const heardDone = new Set<string>();
const heardKey = (turnId: string | undefined, agentId: string): string =>
  turnId || `agent:${agentId}`;

function trimStream(): void {
  while (streamEl.childElementCount > 80) {
    streamEl.firstElementChild?.remove();
  }
  streamEl.scrollTop = streamEl.scrollHeight;
}

// M-10: carril efímero — zona viva sobre el stream (máx 3 nodos, rota).
function ephemeralHost(): HTMLElement {
  let zone = document.getElementById('ephemeral');
  if (!zone) {
    zone = document.createElement('div');
    zone.id = 'ephemeral';
    zone.className = 'ephemeral';
    zone.setAttribute('aria-label', 'Actividad en vivo');
    streamEl.parentElement?.insertBefore(zone, streamEl);
  }
  while (zone.childElementCount >= 3) {
    zone.firstElementChild?.remove();
  }
  return zone as HTMLElement;
}

function heardShell(key: string, agentId: string): HTMLElement {
  let div = heardBubbles.get(key);
  if (div) return div;
  document.getElementById('stream-empty')?.remove();
  div = document.createElement('div');
  div.className = 'msg';
  const b = document.createElement('b');
  b.textContent = agentName(agentId).toLowerCase();
  div.appendChild(b);
  streamEl.appendChild(div);
  while (streamEl.childElementCount > 80) {
    streamEl.firstElementChild?.remove();
  }
  streamEl.scrollTop = streamEl.scrollHeight;
  heardBubbles.set(key, div);
  return div;
}

function heardFinalize(key: string): void {
  stopKaraoke(key);
  const timer = heardGrace.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    heardGrace.delete(key);
  }
  const agentId = heardAgent.get(key) || '';
  const full = stripGestoTags(heardFull.get(key) || turnText.get(agentId) || '');
  const turn = heardTurns.get(key);
  turn?.finalize(full);
  const div = heardBubbles.get(key);
  if (div) {
    if (full.trim()) {
      // Re-render final: reemplaza el revelado parcial (los diagramas
      // mermaid aparecen acá, no a mitad de una oración).
      div.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = agentName(agentId).toLowerCase();
      div.appendChild(b);
      renderRichMessage(div, full);
    } else {
      div.remove();
    }
  } else if (full.trim()) {
    // Sin audio: texto completo de una vez, igual que antes.
    addMsg(agentName(agentId).toLowerCase(), full);
  }
  heardTurns.delete(key);
  heardBubbles.delete(key);
  heardFull.delete(key);
  heardAgent.delete(key);
  heardRevealed.delete(key);
  heardDone.add(key);
  if (agentId) turnText.delete(agentId);
}

// F-08: karaoke — timer por turno (uno vivo a la vez).
const heardKaraoke = new Map<string, number>();
function stopKaraoke(key: string): void {
  const timer = heardKaraoke.get(key);
  if (timer !== undefined) {
    window.clearInterval(timer);
    heardKaraoke.delete(key);
  }
  const div = heardBubbles.get(key);
  div?.querySelectorAll('.k-on').forEach((el) => el.classList.remove('k-on'));
}

function heardChunkStarted(tag: unknown): void {
  const t = tag as AudioTag | null;
  if (!t || !Number.isFinite(t.sIdx)) return;
  const key = heardKey(t.turnId || undefined, t.agentId);
  let turn = heardTurns.get(key);
  if (!turn || turn.isEnded) return;
  workingEarcon.cancel(t.agentId); // Sonó voz: fuera el pendiente.
  const fresh = turn.observe(t);
  if (fresh.length === 0) return;
  const div = heardShell(key, t.agentId);
  let n = heardRevealed.get(key) || 0;
  const karaokeable = typeof t.sDurMs === 'number' && t.sDurMs > 0;
  for (const sentence of fresh) {
    const isCurrent = karaokeable && sentence === fresh[fresh.length - 1];
    if (isCurrent) {
      startKaraoke(key, div, sentence, { sDurMs: t.sDurMs as number, sTimes: t.sText && t.sTimes?.length === sentence.split(/\s+/).length ? t.sTimes : undefined }, n > 0);
    } else {
      div.appendChild(document.createTextNode(n > 0 ? ` ${sentence}` : sentence));
    }
    n += 1;
  }
  heardRevealed.set(key, n);
  streamEl.scrollTop = streamEl.scrollHeight;
}

function startKaraoke(key: string, div: HTMLElement, sentence: string, tag: { sDurMs: number; sTimes?: number[] }, leadSpace: boolean): void {
  stopKaraoke(key);
  const cue = buildCues(sentence, { durMs: tag.sDurMs, sTimes: tag.sTimes });
  if (cue.words.length === 0) {
    div.appendChild(document.createTextNode(leadSpace ? ` ${sentence}` : sentence));
    return;
  }
  const wrap = document.createElement('span');
  wrap.className = 'k-cue';
  const spans: HTMLElement[] = cue.words.map((w) => {
    const s = document.createElement('span');
    s.className = 'k-w';
    s.textContent = w;
    wrap.appendChild(s);
    const gap = document.createTextNode(' ');
    wrap.appendChild(gap);
    return s;
  });
  if (leadSpace) div.appendChild(document.createTextNode(' '));
  div.appendChild(wrap);
  const t0 = performance.now();
  let last = -2;
  const timer = window.setInterval(() => {
    const idx = activeWord(cue, performance.now() - t0);
    if (idx !== last) {
      last = idx;
      spans.forEach((s, i) => s.classList.toggle('k-on', i === idx));
    }
    if (idx === -1 && performance.now() - t0 > cue.durMs + 600) {
      stopKaraoke(key);
    }
  }, 100);
  heardKaraoke.set(key, timer);
}

// QW-09: earcon "trabajando" si en ~1s no hubo voz (solo con voz prendida).
const workingEarcon = new WorkingEarcon(
  (fn, ms) => window.setTimeout(fn, ms),
  (h) => window.clearTimeout(h as number),
  () => {
    if (voiceOn) {
      voiceOut.playWorkingEarcon();
    }
  }
);

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
// M-06: hint semántico del corte (qué dijo el usuario al cortar).
function cutHint(): { cls: string; text: string } {
  const text = browserSpeech.latestUtterance().slice(0, 120);
  return { cls: classifyInterruption(text), text };
}

function cutAgent(): void {
  if (interruptSentForTurn) return;
  pruneActiveTurns();
  if (!agentSpeaking() && activeTurns.size === 0) return;
  const hint = cutHint();
  const targets = interruptTargets();
  if (targets.length === 0) {
    client.interrupt(undefined, undefined, hint);
  } else {
    for (const t of targets) client.interrupt(t.turnId, t.agentId, hint);
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
    // QW-07: terminó de sonar → re-render final con el texto completo.
    heardFinalize(heardKey(audioSegment.turnId, audioSegment.agentId));
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

// QW-07: cada chunk agendado revela su oración en la burbuja del turno.
voiceOut.onChunkStart = (tag: unknown) => {
  heardChunkStarted(tag);
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
    // M-06: turn-taking semántico. Backchannel (mm, sí, dale) = NO cortar:
    // el agente sigue y el turno del usuario fluye normal. Contenido o stop
    // = cortar. Incierto = esperar texto hasta 600ms (fail-closed: corta).
    const clsNow = classifyInterruption(browserSpeech.latestUtterance());
    if (clsNow === 'backchannel') {
      return;
    }
    if (shouldCut(clsNow) && ms >= CUT_OVER_AUDIO_MS) {
      cutAgent();
      return;
    }
    if (shouldCut(clsNow)) {
      cancelPendingCut();
      pendingCutTimer = window.setTimeout(() => {
        pendingCutTimer = null;
        if (liveMic.userSpeaking) cutAgent();
      }, CUT_OVER_AUDIO_MS - ms);
      return;
    }
    cancelPendingCut();
    let waits = 0;
    const waitSemantic = (): void => {
      if (interruptSentForTurn || !liveMic.userSpeaking) {
        pendingCutTimer = null;
        return;
      }
      const cls = classifyInterruption(browserSpeech.latestUtterance());
      if (cls === 'backchannel') {
        pendingCutTimer = null;
        return; // era filler: no se corta.
      }
      waits += 1;
      if (shouldCut(cls) || waits >= 4 || ms + waits * 150 >= CUT_OVER_AUDIO_MS) {
        pendingCutTimer = null;
        cutAgent();
        return;
      }
      pendingCutTimer = window.setTimeout(waitSemantic, 150);
    };
    pendingCutTimer = window.setTimeout(waitSemantic, 150);
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
    // M-06: si ya se escucha un backchannel claro, no cortar.
    if (classifyInterruption(browserSpeech.latestUtterance()) === 'backchannel') {
      return;
    }
    cancelPendingCut();
    interruptSentForTurn = true;
    turnHadInterrupt = true;
    pruneActiveTurns();
    const targets = interruptTargets();
    const hint2 = cutHint();
    if (targets.length === 0) {
      client.interrupt(audioSegment?.turnId, audioSegment?.agentId, hint2);
    } else {
      for (const t of targets) client.interrupt(t.turnId, t.agentId, hint2);
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

// ── Rail de sesión: roster y estado por agente (chrome denso) ─────────
// El rail es la fuente de "quién está en la sala y qué hace"; el orbe sigue
// siendo la presencia. Si el rail no existe (HTML viejo), todo esto no-op.
const RAIL_STATE: Record<AgentVisualState, string> = {
  idle: 'idle',
  escuchando: 'listening',
  pensando: 'thinking',
  trabajando: 'working',
  hablando: 'speaking'
};

function railState(agentId: string, state: AgentVisualState): void {
  const row = document.querySelector(`#rail-people [data-agent-id="${agentId}"]`) as HTMLElement | null;
  if (!row) return;
  const label = RAIL_STATE[state] || 'idle';
  row.dataset.state = label;
  const st = row.querySelector('.st');
  if (st) st.textContent = label;
}

function refreshRuntime(): void {
  const ctxWorking = document.getElementById('ctx-working');
  if (ctxWorking) ctxWorking.textContent = String(working.size);
}

function setCtxMode(mode: string): void {
  const el = document.getElementById('ctx-mode');
  if (el) el.textContent = mode;
}

// Estado visible de un control del rail. Nunca toca textContent del botón
// (eso borraba label/estado en el chrome viejo).
function ctlState(btn: HTMLElement | null | undefined, label: string): void {
  const st = btn?.querySelector('.ctl-state');
  if (st) st.textContent = label;
  btn?.setAttribute('data-value', label);
}

function renderRail(): void {
  const host = document.getElementById('rail-people');
  if (!host) return;
  let list = [...agents.values()];
  if (isHomeSpace()) {
    const pablo = list.find(a => a.name.toLowerCase() === 'pablo' || a.role === 'ceo');
    list = pablo ? [pablo] : list.slice(0, 1);
  }
  const shown = list.slice(0, 8);
  const count = document.getElementById('rail-count');
  if (count) count.textContent = String(list.length);
  const ctxAgents = document.getElementById('ctx-agents');
  if (ctxAgents) ctxAgents.textContent = String(list.length);
  host.innerHTML = '';
  for (const a of shown) {
    const state = RAIL_STATE[visualStates.get(a.id) || 'idle'];
    const row = document.createElement('div');
    row.className = 'rail-row';
    row.dataset.agentId = a.id;
    row.dataset.state = state;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = a.name;
    const role = document.createElement('span');
    role.textContent = a.role || 'agent';
    who.append(name, role);
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = state;
    row.append(dot, who, st);
    host.append(row);
  }
  refreshRuntime();
}

function restState(agentId: string): AgentVisualState {
  if (working.has(agentId)) return 'trabajando';
  if (voiceSession) return 'escuchando';
  return 'idle';
}

function setVisual(agentId: string, state: AgentVisualState): void {
  // V3: el estado solo modula vibración/energía sutil, NUNCA la figura.
  visualStates.set(agentId, state);
  field.setAgentState(agentId, state);
  railState(agentId, state);
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
  renderRail();
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
  onUserText: (text, source, turnId) => {
    // Los avisos del sistema (ej. spawn_agent) llegaban como burbuja YOU:
    // se pintan como sys sin tocar el estado de trabajo.
    if (source === 'system') {
      addMsg('system', text, 'sys');
      return;
    }
    // Eco del turno optimista: ya está pintado, no duplicar.
    if (turnId && optimisticTurns.has(turnId)) {
      optimisticTurns.delete(turnId);
      markUserTurnRendered(turnId);
      return;
    }
    // Dedupe defensivo ante ecos/entregas repetidas del mismo turnId.
    if (markUserTurnRendered(turnId)) {
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
    // QW-07: estado de revelado por turno (muere en heardFinalize).
    const hkey = heardKey(turnId, agentId);
    heardDone.delete(hkey);
    heardTurns.set(hkey, new HeardTurn());
    workingEarcon.arm(agentId);
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
    // Baches de trabajo a mitad de turno: si no suena nada, avisar.
    if (!voiceOut.playing) workingEarcon.arm(_agentId);
    const args = argsPreview ? ` ${argsPreview.slice(0, 120)}` : '';
    addMsg('tools', `→ ${tool}${args}`, 'sys', argsPreview || tool);
  },
  onToolDone: (_agentId, tool, ok, ms, outputPreview) => {
    const out = outputPreview ? `: ${outputPreview.slice(0, 120)}` : '';
    const line = ok ? `ok ${tool} ${Math.round(ms)}ms${out}` : `fail ${tool}${out}`;
    addMsg('tools', line, 'sys', outputPreview || tool);
  },
  onDelta: (agentId, delta) => {
    turnText.set(agentId, (turnText.get(agentId) || '') + delta);
  },
  onAgentEnd: (agentId, text, turnId) => {
    if (turnId) activeTurns.delete(turnId);
    // QW-07: el texto completo se guarda; se muestra ahora solo si no hay
    // audio en juego (modo texto). Con audio, el revelado lo maneja el
    // playback y el final llega en maybePlaybackComplete / onInterrupted.
    const key = heardKey(turnId, agentId);
    // Ya finalizado (p.ej. se interrumpió antes del fin): no duplicar.
    if (!heardDone.has(key)) {
      heardFull.set(key, text || turnText.get(agentId) || '');
      heardAgent.set(key, agentId);
      if (!heardTurns.has(key)) heardTurns.set(key, new HeardTurn());
      const turn = heardTurns.get(key) as HeardTurn;
      if (turn.progressive || audioSegment) {
        // Audio en curso o ya revelando: el finalize lo hace el playback.
      } else if (!heardGrace.has(key)) {
        // Sin audio a la vista: gracia corta por si el TTS viene lento
        // (si el audio arranca dentro de la gracia, cancela y progresa).
        heardGrace.set(key, window.setTimeout(() => {
          heardGrace.delete(key);
          if (!heardTurns.get(key)?.progressive) heardFinalize(key);
        }, HEARD_GRACE_MS));
      }
    }
    workingEarcon.cancel(agentId);
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
  onMp3: (b64, turnId, tag) => {
    if (!voiceOn || isInterruptedTurn(turnId)) return;
    void voiceOut.unlock().then(() => voiceOut.playMp3(b64, tag ?? null));
  },
  onPcm: (b64, rate, turnId, tag) => {
    if (!voiceOn || isInterruptedTurn(turnId)) return;
    void voiceOut.unlock().then(() => voiceOut.enqueuePcm(b64, rate, tag ?? null));
  },
  onAudioStart: (turnId, agentId) => {
    // QW-07: llegó audio → cancela la gracia de texto-inmediato.
    const key = heardKey(turnId, agentId);
    const timer = heardGrace.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      heardGrace.delete(key);
    }
    // Bug de mensajes dobles: si el texto ya se finalizó (el TTS llegó
    // después de la gracia), el audio se reproduce igual pero NO se
    // reconstruye la burbuja ni se reabre el revelado.
    if (!heardDone.has(key)) {
      if (!heardTurns.has(key)) heardTurns.set(key, new HeardTurn());
      heardAgent.set(key, agentId);
    }
    workingEarcon.cancel(agentId);
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
  // M-02/M-10: figuras tipadas. Efímeras → zona viva (se reemplazan);
  // persistentes → stream. Key estable = upsert, no append.
  onFigure: (agentId, figure) => {
    try {
      const fig = figure as Figure;
      const host = fig?.ephemeral === true ? ephemeralHost() : streamEl;
      const ok = upsertFigure(host, fig, {
        loadMermaid: loadMermaidReal,
        setGlyph: (name) => field.setGlyph(agentId, name),
        deferHeavy: defaultFigureQueue.deferHeavy
      });
      if (ok && host === streamEl) {
        trimStream();
      }
    } catch (err) {
      console.warn('[figura] render falló:', err);
    }
  },
  onInterrupted: (agentId, turnId) => {
    if (turnId) {
      activeTurns.delete(turnId);
      noteInterrupted(turnId);
    }
    voiceOut.flush();
    voiceOut.restoreGain();
    workingEarcon.cancel();
    for (const k of [...heardKaraoke.keys()]) stopKaraoke(k);
    audioSegment = null;
    if (!agentId || speakingAgent === agentId) {
      speakingAgent = '';
      setSpeaking('');
    }
    if (agentId) setVisual(agentId, restState(agentId));
    // QW-07: al interrumpir se muestra todo (leer el resto es un feature).
    heardFinalize(heardKey(turnId, agentId || ''));
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
    refreshRuntime();
    // Feed de actividad: que SE VEA que laburan.
    const who = String(event.agentName || agentName(agentId) || 'equipo');
    const str = (k: string): string => String(event[k] || '');
    if (kind === 'comando' && str('cmd')) {
      addMsg('tools', `${who} runs: ${str('cmd').slice(0, 120)}`, 'sys');
    } else if (kind === 'file_written' && str('path')) {
      addMsg('tools', `${who} ${event.edited ? 'edited' : 'wrote'}: ${str('path')}`, 'sys');
    } else if (kind === 'web' && str('url')) {
      addMsg('tools', `${who} read: ${str('url').slice(0, 100)}`, 'sys');
    } else if (kind === 'task_started' && str('text')) {
      addMsg('tools', `${who}: ${str('text').slice(0, 140)}`, 'sys');
    } else if (kind === 'task_done') {
      addMsg('tools', `${who} finished${str('summary') ? `: ${str('summary').slice(0, 160)}` : ''}`, 'sys');
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
    // El source (mic/system) es metadata de debug: no va en la burbuja.
    void source;
    addMsg('you · voice', text, 'me');
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
    ctlState(micBtn, 'off');
    ctlState(callBtn, 'idle');
    voiceBtn.classList.add('off');
    voiceBtn.classList.remove('on');
    ctlState(voiceBtn, 'muted');
    setCtxMode('chat');
    // Los que solo escuchaban vuelven a idle (los busy conservan su vibración).
    for (const [id, state] of visualStates) {
      if (state === 'escuchando') setVisual(id, 'idle');
    }
    setStatus('Ready');
    return;
  }
  voiceOut.flush();
  await voiceOut.unlock();
  client.audioPrepare(group);
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
  ctlState(micBtn, group ? 'room' : 'open');
  ctlState(callBtn, group ? 'live' : 'ready');
  setCtxMode(group ? 'call' : 'voice');
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
// M-05: typing inmediato — la burbuja propia sale SIN esperar al servidor;
// el eco posterior con el mismo turnId se descarta (sin duplicados).
const optimisticTurns = new Set<string>();
// Dedupe defensivo: mismo turnId de usuario no se pinta dos veces
// (eco repetido, reentrega o correlación optimista fallida).
const renderedUserTurns = new Set<string>();
const MAX_RENDERED_USER_TURNS = 300;
function markUserTurnRendered(turnId: string | undefined): boolean {
  if (!turnId) return false;
  if (renderedUserTurns.has(turnId)) return true;
  renderedUserTurns.add(turnId);
  while (renderedUserTurns.size > MAX_RENDERED_USER_TURNS) {
    const oldest = renderedUserTurns.values().next().value;
    if (oldest === undefined) break;
    renderedUserTurns.delete(oldest);
  }
  return false;
}
function submitPrompt(steer = false): void {
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  promptEl.style.height = 'auto';
  voiceOut.flush();
  void voiceOut.unlock();
  const turnId = client.sendText(text, { steer });
  optimisticTurns.add(turnId);
  markUserTurnRendered(turnId);
  addMsg('you', text, 'me');
  setStatus(steer ? 'Redirecting…' : 'Working on it…');
}

sendBtn.addEventListener('click', () => submitPrompt());

// QW-08: atajos globales de teclado (a11y: todo lo central sin mouse).
// '/' enfoca el compositor, 'Escape' interrumpe el habla, 'Alt+M' alterna mic.
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const inField = !!target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable);
  if (e.key === 'Escape') {
    // Corta audio local + avisa al servidor (igual que barge-in).
    voiceOut.flush();
    client.interrupt(audioSegment?.turnId, speakingAgent || undefined);
    if (inField) (target as HTMLElement).blur();
    return;
  }
  if (inField || e.metaKey || e.ctrlKey) return;
  if (e.altKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    micBtn.click();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    promptEl.focus();
  }
});
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`;
});
promptEl.addEventListener('keydown', (e) => {
  // M-05: Ctrl/Cmd+Enter = steer (redirigir a mitad de turno).
  // Shift+Enter sigue siendo salto de línea (estándar).
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitPrompt(true);
    return;
  }
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
    const turnId = client.sendText(text);
    optimisticTurns.add(turnId);
    markUserTurnRendered(turnId);
    addMsg('you', text, 'me');
    setStatus('Working on it…');
  });
});

voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  client.setVoice(voiceOn);
  voiceBtn.classList.toggle('on', voiceOn);
  voiceBtn.classList.toggle('off', !voiceOn);
  ctlState(voiceBtn, voiceOn ? 'on' : 'muted');
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
  ctlState(btn, autoWorkOn ? 'on' : 'paused');
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
  setRailProject();
  const meetingId = readMeetingKey(companyId, goalId);
  client.connect(companyId, goalId, meetingId);
}

// Nombres legibles para el rail: se llenan al pintar los pickers de Settings.
const companyNames = new Map<string, string>();
const projectNames = new Map<string, string>();

function isHomeSpace(): boolean {
  const project = (projectNames.get(currentGoal) || '').toLowerCase();
  const company = (companyNames.get(currentCompany) || '').toLowerCase();
  return company === 'pablo' && (project === 'siempre' || project === 'always' || project === '');
}

function setRailProject(): void {
  const name = document.getElementById('rail-project-name');
  const meta = document.getElementById('rail-project-meta');
  const label = document.getElementById('rail-context-label');
  const workTitle = document.getElementById('work-title');
  const company = companyNames.get(currentCompany) || '';
  const project = projectNames.get(currentGoal) || '';
  const home = isHomeSpace();
  if (label) label.textContent = home ? 'Home' : 'Project';
  if (workTitle) workTitle.textContent = home ? 'Home' : (project || 'Project');
  if (name) name.textContent = home ? 'Pablo' : (project || (currentGoal ? 'Project' : 'No project'));
  if (meta) {
    if (home) meta.textContent = 'Personal assistant';
    else if (company && project) meta.textContent = company;
    else if (currentCompany) meta.textContent = company || 'Connected';
    else meta.textContent = 'Open Projects to start';
  }
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
    companyNames.set(c.id, c.name);
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
        void renderProjects();
      })();
    });
    box.appendChild(btn);
  }
}
document.querySelector('.companies')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderCompanies();
});


// J.A.B.S: Projects view (dedicated teams per project). Home stays personal.
async function renderProjectsView(): Promise<void> {
  const grid = document.getElementById('projects-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="projects-empty">Loading projects…</div>';
  if (!currentCompany) {
    grid.innerHTML = '<div class="projects-empty">No workspace yet. Open Settings to set up a company.</div>';
    return;
  }
  const data = await apiJson<{ projects: Array<{ id: string; title: string; slug?: string; stack?: string; access_level?: string; status?: string }> }>(
    `/api/companies/${encodeURIComponent(currentCompany)}/projects`
  ).catch(() => null);
  const projects = data?.projects || [];
  if (!projects.length) {
    grid.innerHTML = '<div class="projects-empty">No projects yet. Create one to spin up a dedicated team for complex work.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const p of projects) {
    projectNames.set(p.id, p.title);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'project-card' + (p.id === currentGoal ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'project-card-title';
    title.textContent = p.title;
    const meta = document.createElement('div');
    meta.className = 'project-card-meta';
    meta.textContent = [p.stack || 'project', p.access_level || 'auto'].join(' · ');
    card.append(title, meta);
    card.addEventListener('click', () => {
      connectTo(currentCompany, p.id);
      (document.getElementById('rail-context-label') as HTMLElement | null)!.textContent = 'Project';
      (document.getElementById('work-title') as HTMLElement | null)!.textContent = p.title;
      switchView('console');
      setStatus(`Opened ${p.title}.`);
      void renderProjectsView();
    });
    grid.appendChild(card);
  }
}
document.getElementById('projects-create')?.addEventListener('click', () => {
  void (async () => {
    const input = document.getElementById('projects-title') as HTMLInputElement | null;
    const title = input?.value.trim();
    if (!title || !currentCompany) return;
    try {
      const created = await apiJson<{ project: { id: string; title: string } }>(
        `/api/companies/${encodeURIComponent(currentCompany)}/projects`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }
      );
      if (input) input.value = '';
      projectNames.set(created.project.id, created.project.title);
      connectTo(currentCompany, created.project.id);
      (document.getElementById('rail-context-label') as HTMLElement | null)!.textContent = 'Project';
      (document.getElementById('work-title') as HTMLElement | null)!.textContent = created.project.title;
      switchView('console');
      setStatus(`Project ${created.project.title} created.`);
      void renderProjectsView();
      void renderProjects();
    } catch {
      setStatus('Could not create the project.');
    }
  })();
});

// E-02: Sección Proyectos — el proyecto es LA unidad de contexto.
async function renderProjects(): Promise<void> {
  const box = $('projects-list');
  box.innerHTML = '';
  if (!currentCompany) {
    box.textContent = 'Pick a company to see its projects.';
    return;
  }
  const data = await apiJson<{ projects: Array<{ id: string; title: string; slug: string }> }>(
    `/api/companies/${encodeURIComponent(currentCompany)}/projects`
  ).catch(() => null);
  for (const p of data?.projects || []) {
    projectNames.set(p.id, p.title);
    const row = document.createElement('div');
    row.className = 'project-row';
    const btn = document.createElement('button');
    btn.textContent = p.title;
    btn.classList.toggle('active', p.id === currentGoal);
    btn.addEventListener('click', () => {
      connectTo(currentCompany, p.id);
      setStatus(`Switched to ${p.title}…`);
      void renderProjects();
    });
    row.appendChild(btn);
    // E-22: nivel de acceso por proyecto.
    const sel = document.createElement('select');
    for (const lv of ['auto', 'reversibles', 'pedir-todo']) {
      const opt = document.createElement('option');
      opt.value = lv;
      opt.textContent = lv;
      sel.appendChild(opt);
    }
    sel.value = (p as { access_level?: string }).access_level || 'auto';
    sel.setAttribute('aria-label', `Nivel de acceso de ${p.title}`);
    sel.addEventListener('change', () => {
      void apiJson(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_level: sel.value })
      }).then(() => setStatus(`Nivel ${sel.value} en ${p.title}.`)).catch(() => setStatus('No se pudo cambiar.'));
    });
    row.appendChild(sel);
    box.appendChild(row);
  }
  if ((data?.projects || []).length === 0) {
    box.textContent = 'Sin proyectos — creá uno abajo.';
  }
}
document.getElementById('projects-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderProjects();
});
document.getElementById('project-create')?.addEventListener('click', () => {
  void (async () => {
    const input = document.getElementById('project-title') as HTMLInputElement;
    const title = input.value.trim();
    if (!title || !currentCompany) return;
    try {
      const created = await apiJson<{ project: { id: string; title: string } }>(
        `/api/companies/${encodeURIComponent(currentCompany)}/projects`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }
      );
      input.value = '';
      connectTo(currentCompany, created.project.id);
      setStatus(`Project ${created.project.title} created.`);
      void renderProjects();
    } catch {
      setStatus('No se pudo crear el proyecto.');
    }
  })();
});

// ── Puente orbe desktop (solo Tauri) ────────────────────────────────
function orbState(): string {
  if (liveMic.userSpeaking) return 'escuchando';
  if (voiceSession) return 'escuchando';
  if (speakingAgent) return 'hablando';
  // E-01: pensando sí se reporta (el protocolo Rust + orb.ts lo soportan;
  // antes esta rama no existía y el orbe nunca mostraba pensamiento).
  if (working.size > 0) return 'pensando';
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

// F-04: aprobaciones pendientes (agent tools) — aprobar/denegar por click.
async function renderApprovals(): Promise<void> {
  const box = $('approvals-list');
  box.innerHTML = '';
  const data = await apiJson<{ pending: Array<{ id: string; tool: string; args: unknown; agentId: string }> }>(
    '/api/approvals/pending'
  ).catch(() => null);
  const pendings = data?.pending || [];
  if (pendings.length === 0) {
    box.textContent = 'Sin pendientes.';
    return;
  }
  for (const p of pendings) {
    const row = document.createElement('div');
    row.className = 'perm-row';
    const label = document.createElement('span');
    label.textContent = `${p.tool} ${JSON.stringify(p.args || {}).slice(0, 100)}`;
    label.title = `pedida por ${p.agentId || '?'} (${p.id})`;
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Aprobar';
    okBtn.setAttribute('aria-label', `Aprobar ${p.tool}`);
    okBtn.addEventListener('click', () => {
      void apiJson(`/api/approvals/${encodeURIComponent(p.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: true })
      }).then(() => void renderApprovals()).catch(() => setStatus('No se pudo aprobar.'));
    });
    const noBtn = document.createElement('button');
    noBtn.textContent = 'Denegar';
    noBtn.setAttribute('aria-label', `Denegar ${p.tool}`);
    noBtn.addEventListener('click', () => {
      void apiJson(`/api/approvals/${encodeURIComponent(p.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: false })
      }).then(() => void renderApprovals()).catch(() => setStatus('No se pudo denegar.'));
    });
    row.appendChild(label);
    row.appendChild(okBtn);
    row.appendChild(noBtn);
    box.appendChild(row);
  }
}
document.querySelector('#approvals-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderApprovals();
});

// E-22: prohibiciones globales (deny absoluto, harness).
async function renderProhibitions(): Promise<void> {
  const box = $('prohib-list');
  box.innerHTML = '';
  const data = await apiJson<{ prohibitions: Array<{ id: number; kind: string; pattern: string; reason: string }> }>(
    '/api/prohibitions'
  ).catch(() => null);
  const rows = data?.prohibitions || [];
  if (rows.length === 0) {
    box.textContent = 'Sin prohibiciones.';
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'perm-row';
    const label = document.createElement('span');
    label.textContent = `${r.kind}: ${r.pattern}${r.reason ? ` (${r.reason})` : ''}`;
    const del = document.createElement('button');
    del.textContent = 'Quitar';
    del.setAttribute('aria-label', `Quitar prohibición ${r.pattern}`);
    del.addEventListener('click', () => {
      void apiJson(`/api/prohibitions/${r.id}`, { method: 'DELETE' })
        .then(() => void renderProhibitions()).catch(() => setStatus('No se pudo quitar.'));
    });
    row.appendChild(label);
    row.appendChild(del);
    box.appendChild(row);
  }
}
document.querySelector('#prohib-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderProhibitions();
});
document.getElementById('prohib-add')?.addEventListener('click', () => {
  void (async () => {
    const kind = (document.getElementById('prohib-kind') as HTMLSelectElement).value;
    const input = document.getElementById('prohib-pattern') as HTMLInputElement;
    if (!input.value.trim()) return;
    try {
      await apiJson('/api/prohibitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, pattern: input.value.trim() })
      });
      input.value = '';
      void renderProhibitions();
    } catch {
      setStatus('No se pudo prohibir.');
    }
  })();
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
    box.textContent = 'Backend unavailable. Check that the server is running.';
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

  const note = (text: string): HTMLDivElement => {
    const d = document.createElement('div');
    d.className = 'sidecar-note';
    d.textContent = text;
    return d;
  };

  // ── Brain (LLM) ──────────────────────────────────────────────────
  box.appendChild(settingGroup('Brain (LLM)'));
  box.appendChild(note('Configure reasoning providers and models. Changes apply immediately to new requests.'));

  const provLabels: Record<string, string> = {};
  for (const p of s.llm.providerOptions) provLabels[p.id] = p.label;
  const provSel = settingSelect(s.llm.providerOptions.map((p) => p.id), s.llm.provider, provLabels);
  provSel.setAttribute('aria-label', 'Reasoning provider');
  provSel.addEventListener('change', () => save({ 'llm.provider': provSel.value }, true));
  box.appendChild(settingRow('Active provider', provSel));

  const modelSel = settingSelect(s.llm.modelOptions, s.llm.model);
  modelSel.setAttribute('aria-label', 'Default model');
  modelSel.addEventListener('change', () => save({ 'llm.model': modelSel.value }));
  box.appendChild(settingRow('Default model', modelSel));

  const strongInput = document.createElement('input');
  strongInput.type = 'text';
  strongInput.placeholder = 'Strong model override (optional)';
  strongInput.value = (s.llm as any).strong || '';
  strongInput.setAttribute('aria-label', 'Strong model override');
  strongInput.addEventListener('change', () => save({ 'llm.strong': strongInput.value.trim() }));
  box.appendChild(settingRow('Strong model', strongInput));

  const fastInput = document.createElement('input');
  fastInput.type = 'text';
  fastInput.placeholder = 'Fast model override (optional)';
  fastInput.value = (s.llm as any).fast || '';
  fastInput.setAttribute('aria-label', 'Fast model override');
  fastInput.addEventListener('change', () => save({ 'llm.fast': fastInput.value.trim() }));
  box.appendChild(settingRow('Fast model', fastInput));

  const modelsInput = document.createElement('input');
  modelsInput.placeholder = 'Custom models (CSV, empty = curated list)';
  modelsInput.value = s.llm.customModels || '';
  modelsInput.setAttribute('aria-label', 'Custom models CSV');
  modelsInput.addEventListener('change', () => save({ 'llm.models': modelsInput.value }, true));
  box.appendChild(settingRow('Custom models', modelsInput));

  const foInput = document.createElement('input');
  foInput.placeholder = 'Failover order (CSV, e.g. opencode,groq,deepseek)';
  foInput.value = s.llm.failover || '';
  foInput.setAttribute('aria-label', 'Failover order CSV');
  foInput.addEventListener('change', () => save({ 'llm.failover': foInput.value }, true));
  box.appendChild(settingRow('Failover order', foInput));
  box.appendChild(note(`Effective failover: ${(s.llm.failoverResolved || []).join(' → ') || '—'}`));

  // All provider keys (professional: manage each provider without switching context)
  const keyDefs: Array<{ label: string; field: string; masked: string; set: boolean }> = [
    { label: 'MiniMax API key', field: 'llm.apiKey', masked: s.llm.apiKeyMasked, set: s.llm.apiKeySet },
    { label: 'DeepSeek API key', field: 'llm.deepseekKey', masked: s.llm.deepseekKeyMasked, set: s.llm.deepseekKeySet },
    { label: 'OpenCode API key', field: 'llm.opencodeKey', masked: s.llm.opencodeKeyMasked, set: s.llm.opencodeKeySet },
    { label: 'Groq API key', field: 'llm.groqKey', masked: s.llm.groqKeyMasked, set: s.llm.groqKeySet }
  ];
  for (const k of keyDefs) {
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.placeholder = k.masked || (k.set ? 'Set (hidden)' : 'Not set — paste key');
    inp.setAttribute('aria-label', k.label);
    inp.addEventListener('change', () => {
      if (!inp.value) return;
      save({ [k.field]: inp.value }, true);
      inp.value = '';
    });
    box.appendChild(settingRow(k.label, inp));
  }

  // ── Speech (STT) ─────────────────────────────────────────────────
  box.appendChild(settingGroup('Speech (STT)'));
  box.appendChild(note('Speech-to-text engines and models. Order controls fallback chain (comma-separated).'));

  const sttProvSel = settingSelect(s.stt.providerOptions, s.stt.provider);
  sttProvSel.setAttribute('aria-label', 'STT provider');
  sttProvSel.addEventListener('change', () => save({ 'stt.provider': sttProvSel.value }));
  box.appendChild(settingRow('STT provider', sttProvSel));

  const sttOrderInput = document.createElement('input');
  sttOrderInput.type = 'text';
  sttOrderInput.value = s.stt.order || '';
  sttOrderInput.placeholder = s.stt.orderDefault || 'parakeet,whisper,groq,deepgram';
  sttOrderInput.setAttribute('aria-label', 'STT engine order');
  sttOrderInput.spellcheck = false;
  sttOrderInput.addEventListener('change', () => save({ 'stt.order': sttOrderInput.value.trim() }));
  box.appendChild(settingRow('STT engine order', sttOrderInput));

  const whisperSel = settingSelect(s.stt.whisperModelOptions, s.stt.whisperModel);
  whisperSel.setAttribute('aria-label', 'Local Whisper model');
  whisperSel.addEventListener('change', () => save({ 'stt.whisperModel': whisperSel.value }));
  box.appendChild(settingRow('Whisper model (local)', whisperSel));

  const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'English', auto: 'Auto-detect' };
  const sttLang = (s.stt.language === 'es' || s.stt.language === 'en' || s.stt.language === 'auto')
    ? s.stt.language
    : (s.stt.language.startsWith('en') ? 'en' : (s.stt.language.startsWith('auto') ? 'auto' : 'es'));
  const langSel = settingSelect(['auto', 'es', 'en'], sttLang, LANG_LABELS);
  langSel.setAttribute('aria-label', 'Listening language');
  langSel.addEventListener('change', () => save({ 'stt.language': langSel.value }));
  box.appendChild(settingRow('Listening language', langSel));

  const CONF_LABELS: Record<string, string> = { '0.3': 'Low (0.3)', '0.4': 'Medium (0.4)', '0.55': 'Default (0.55)', '0.7': 'High (0.7)' };
  const confCur = String(s.stt.minConfidence ?? 0.55);
  const confOpts = Object.keys(CONF_LABELS).includes(confCur) ? Object.keys(CONF_LABELS) : [confCur, ...Object.keys(CONF_LABELS)];
  const confSel = settingSelect(confOpts, confCur, { ...CONF_LABELS, [confCur]: CONF_LABELS[confCur] || `Custom (${confCur})` });
  confSel.setAttribute('aria-label', 'STT min confidence');
  confSel.addEventListener('change', () => save({ 'stt.minConfidence': confSel.value }));
  box.appendChild(settingRow('Min confidence', confSel));

  const groqStt = document.createElement('input');
  groqStt.type = 'password';
  groqStt.placeholder = s.stt.groqKeyMasked || 'Not set';
  groqStt.setAttribute('aria-label', 'Groq STT key');
  groqStt.addEventListener('change', () => { if (!groqStt.value) return; save({ 'stt.groqKey': groqStt.value }, true); groqStt.value = ''; });
  box.appendChild(settingRow('Groq STT key', groqStt));

  const dgStt = document.createElement('input');
  dgStt.type = 'password';
  dgStt.placeholder = s.stt.deepgramKeyMasked || 'Not set';
  dgStt.setAttribute('aria-label', 'Deepgram key (STT/TTS)');
  dgStt.addEventListener('change', () => { if (!dgStt.value) return; save({ 'stt.deepgramKey': dgStt.value }, true); dgStt.value = ''; });
  box.appendChild(settingRow('Deepgram key', dgStt));

  // ── Voice (TTS) ──────────────────────────────────────────────────
  box.appendChild(settingGroup('Voice (TTS)'));
  box.appendChild(note('Text-to-speech engines and models. Order controls fallback chain.'));

  const ttsLangCur = (s.tts.language === 'es' || s.tts.language === 'en')
    ? s.tts.language : (s.tts.language.startsWith('en') ? 'en' : 'es');
  const ttsLangSel = settingSelect(['es', 'en'], ttsLangCur, { es: 'Español', en: 'English' });
  ttsLangSel.setAttribute('aria-label', 'Voice language');
  ttsLangSel.addEventListener('change', () => save({ 'tts.language': ttsLangSel.value }));
  box.appendChild(settingRow('Voice language', ttsLangSel));

  const engSel = settingSelect(s.tts.engineOptions || ['auto', 'piper', 'supertonic', 'deepgram', 'edge'], s.tts.engine || 'auto');
  engSel.setAttribute('aria-label', 'Preferred TTS engine');
  engSel.addEventListener('change', () => save({ 'tts.engine': engSel.value }));
  box.appendChild(settingRow('Preferred engine', engSel));

  const ttsOrderInput = document.createElement('input');
  ttsOrderInput.type = 'text';
  ttsOrderInput.value = s.tts.order || '';
  ttsOrderInput.placeholder = s.tts.orderDefault || 'deepgram,piper,supertonic,edge';
  ttsOrderInput.setAttribute('aria-label', 'TTS engine order');
  ttsOrderInput.spellcheck = false;
  ttsOrderInput.addEventListener('change', () => save({ 'tts.order': ttsOrderInput.value.trim() }));
  box.appendChild(settingRow('TTS engine order', ttsOrderInput));

  const ttsSpeed = document.createElement('input');
  ttsSpeed.type = 'number';
  ttsSpeed.min = '0.5'; ttsSpeed.max = '2'; ttsSpeed.step = '0.1';
  ttsSpeed.value = String(s.tts.speed ?? 1);
  ttsSpeed.setAttribute('aria-label', 'Speech speed');
  ttsSpeed.addEventListener('change', () => save({ 'tts.speed': ttsSpeed.value }));
  box.appendChild(settingRow('Speech speed', ttsSpeed));

  const piperUrlInp = document.createElement('input');
  piperUrlInp.type = 'text';
  piperUrlInp.value = s.tts.piperUrl || '';
  piperUrlInp.placeholder = 'http://127.0.0.1:7791';
  piperUrlInp.spellcheck = false;
  piperUrlInp.setAttribute('aria-label', 'Piper sidecar URL');
  piperUrlInp.addEventListener('change', () => save({ 'tts.piperUrl': piperUrlInp.value.trim() }));
  box.appendChild(settingRow('Piper URL', piperUrlInp));

  const supertonicUrlInp = document.createElement('input');
  supertonicUrlInp.type = 'text';
  supertonicUrlInp.value = s.tts.url || '';
  supertonicUrlInp.placeholder = 'Supertonic sidecar URL (optional)';
  supertonicUrlInp.spellcheck = false;
  supertonicUrlInp.setAttribute('aria-label', 'Supertonic sidecar URL');
  supertonicUrlInp.addEventListener('change', () => save({ 'tts.url': supertonicUrlInp.value.trim() }));
  box.appendChild(settingRow('Supertonic URL', supertonicUrlInp));

  const testVoiceBtn = document.createElement('button');
  testVoiceBtn.className = 'pill';
  testVoiceBtn.textContent = 'Test voice';
  testVoiceBtn.setAttribute('aria-label', 'Test voice output');
  testVoiceBtn.addEventListener('click', () => {
    testVoiceBtn.textContent = 'Speaking…';
    void (async () => {
      try {
        const audioB64 = await decir('Hello, this is a J.A.B.S voice test.');
        const audio = new Audio(`data:audio/mpeg;base64,${audioB64}`);
        await audio.play();
      } catch (err) {
        addMsg('system', `Voice test failed: ${err instanceof Error ? err.message : 'error'}`, 'sys');
      } finally {
        testVoiceBtn.textContent = 'Test voice';
      }
    })();
  });
  box.appendChild(settingRow('Voice test', testVoiceBtn));

  // ── Energy & Runtime ─────────────────────────────────────────────
  box.appendChild(settingGroup('Energy & Runtime'));
  const energyModeSel = settingSelect(['always-on', 'gate', 'manual'], s.energy?.mode || 'manual', {
    'always-on': 'Always on (start at boot)',
    gate: 'Gate (orb + wake word)',
    manual: 'Manual'
  });
  energyModeSel.setAttribute('aria-label', 'Energy mode');
  energyModeSel.addEventListener('change', () => {
    void apiJson('/api/energy/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: energyModeSel.value })
    }).then(() => { flashSaved(); void renderSettings(); })
      .catch(() => setStatus('Failed to change energy mode.'));
  });
  box.appendChild(settingRow('Energy mode', energyModeSel));

  const splitSel = settingSelect(['local', 'split'], s.split?.mode || 'local', { local: 'Local only', split: 'Split (offload to VPS)' });
  splitSel.setAttribute('aria-label', 'Split mode');
  splitSel.addEventListener('change', () => save({ 'split.mode': splitSel.value }, true));
  box.appendChild(settingRow('Compute mode', splitSel));

  const vpsInput = document.createElement('input');
  vpsInput.type = 'text';
  vpsInput.placeholder = 'https://your-vps (STT/TTS ports)';
  vpsInput.value = s.split?.vps || '';
  vpsInput.spellcheck = false;
  vpsInput.setAttribute('aria-label', 'VPS base URL');
  vpsInput.addEventListener('change', () => save({ 'split.vps': vpsInput.value.trim() }));
  box.appendChild(settingRow('VPS base URL', vpsInput));

  // ── Channels & Notifications ─────────────────────────────────────
  box.appendChild(settingGroup('Channels & Notifications'));
  const tg = s.channels?.telegram;
  if (tg) {
    const tgOn = document.createElement('input');
    tgOn.type = 'checkbox';
    tgOn.checked = tg.enabled;
    tgOn.setAttribute('aria-label', 'Telegram enabled');
    tgOn.addEventListener('change', () => save({ 'channels.telegram.enabled': String(tgOn.checked) }));
    box.appendChild(settingRow('Telegram enabled', tgOn));

    const tgToken = document.createElement('input');
    tgToken.type = 'password';
    tgToken.placeholder = tg.botTokenMasked || 'Bot token';
    tgToken.setAttribute('aria-label', 'Telegram bot token');
    tgToken.addEventListener('change', () => { if (!tgToken.value) return; save({ 'channels.telegram.botToken': tgToken.value }, true); tgToken.value = ''; });
    box.appendChild(settingRow('Telegram bot token', tgToken));

    const tgTito = document.createElement('input');
    tgTito.placeholder = 'Owner Telegram ID';
    tgTito.value = tg.titoId || '';
    tgTito.setAttribute('aria-label', 'Telegram owner ID');
    tgTito.addEventListener('change', () => save({ 'channels.telegram.titoId': tgTito.value.trim() }));
    box.appendChild(settingRow('Telegram owner ID', tgTito));

    const tgMode = settingSelect(['tito-only', 'allowlist'], tg.mode || 'tito-only', { 'tito-only': 'Owner only', allowlist: 'Allowlist' });
    tgMode.setAttribute('aria-label', 'Telegram access mode');
    tgMode.addEventListener('change', () => save({ 'channels.telegram.mode': tgMode.value }));
    box.appendChild(settingRow('Telegram access', tgMode));

    const tgAllow = document.createElement('input');
    tgAllow.type = 'text';
    tgAllow.placeholder = 'Allowed IDs (CSV)';
    tgAllow.value = tg.allow || '';
    tgAllow.setAttribute('aria-label', 'Telegram allowlist');
    tgAllow.addEventListener('change', () => save({ 'channels.telegram.allow': tgAllow.value.trim() }));
    box.appendChild(settingRow('Telegram allowlist', tgAllow));

    const tgAuto = document.createElement('input');
    tgAuto.type = 'checkbox';
    tgAuto.checked = (tg as any).autoRespond === 'true' || (tg as any).autoRespond === '1';
    tgAuto.setAttribute('aria-label', 'Telegram auto-respond');
    tgAuto.addEventListener('change', () => save({ 'channels.telegram.autoRespond': String(tgAuto.checked) }));
    box.appendChild(settingRow('Telegram auto-respond', tgAuto));
  }

  const wa = s.channels?.whatsapp;
  if (wa) {
    const waOn = document.createElement('input');
    waOn.type = 'checkbox';
    waOn.checked = wa.enabled;
    waOn.setAttribute('aria-label', 'WhatsApp enabled');
    waOn.addEventListener('change', () => save({ 'channels.whatsapp.enabled': String(waOn.checked) }));
    box.appendChild(settingRow('WhatsApp enabled', waOn));

    const waToken = document.createElement('input');
    waToken.type = 'password';
    waToken.placeholder = wa.tokenMasked || 'Access token';
    waToken.setAttribute('aria-label', 'WhatsApp token');
    waToken.addEventListener('change', () => { if (!waToken.value) return; save({ 'channels.whatsapp.token': waToken.value }, true); waToken.value = ''; });
    box.appendChild(settingRow('WhatsApp token', waToken));

    const waPhone = document.createElement('input');
    waPhone.type = 'text';
    waPhone.placeholder = 'Phone number ID';
    waPhone.value = wa.phoneId || '';
    waPhone.setAttribute('aria-label', 'WhatsApp phone ID');
    waPhone.addEventListener('change', () => save({ 'channels.whatsapp.phoneId': waPhone.value.trim() }));
    box.appendChild(settingRow('WhatsApp phone ID', waPhone));

    const waTito = document.createElement('input');
    waTito.type = 'text';
    waTito.placeholder = 'Owner WhatsApp ID';
    waTito.value = wa.titoId || '';
    waTito.setAttribute('aria-label', 'WhatsApp owner ID');
    waTito.addEventListener('change', () => save({ 'channels.whatsapp.titoId': waTito.value.trim() }));
    box.appendChild(settingRow('WhatsApp owner ID', waTito));

    const waMode = settingSelect(['tito-only', 'allowlist'], wa.mode || 'tito-only', { 'tito-only': 'Owner only', allowlist: 'Allowlist' });
    waMode.setAttribute('aria-label', 'WhatsApp access mode');
    waMode.addEventListener('change', () => save({ 'channels.whatsapp.mode': waMode.value }));
    box.appendChild(settingRow('WhatsApp access', waMode));

    const waAllow = document.createElement('input');
    waAllow.type = 'text';
    waAllow.placeholder = 'Allowed IDs (CSV)';
    waAllow.value = wa.allow || '';
    waAllow.setAttribute('aria-label', 'WhatsApp allowlist');
    waAllow.addEventListener('change', () => save({ 'channels.whatsapp.allow': waAllow.value.trim() }));
    box.appendChild(settingRow('WhatsApp allowlist', waAllow));
  }

  const notify = (s as any).notify || { channel: 'none', voice: false, to: '' };
  const notifChan = settingSelect(['none', 'telegram', 'whatsapp'], notify.channel || 'none', { none: 'None', telegram: 'Telegram', whatsapp: 'WhatsApp' });
  notifChan.setAttribute('aria-label', 'Notification channel');
  notifChan.addEventListener('change', () => save({ 'notify.channel': notifChan.value }));
  box.appendChild(settingRow('Notification channel', notifChan));

  const notifTo = document.createElement('input');
  notifTo.type = 'text';
  notifTo.placeholder = 'Notification recipient';
  notifTo.value = notify.to || '';
  notifTo.setAttribute('aria-label', 'Notification recipient');
  notifTo.addEventListener('change', () => save({ 'notify.to': notifTo.value.trim() }));
  box.appendChild(settingRow('Notification to', notifTo));

  const notifVoice = document.createElement('input');
  notifVoice.type = 'checkbox';
  notifVoice.checked = !!notify.voice;
  notifVoice.setAttribute('aria-label', 'Voice notifications');
  notifVoice.addEventListener('change', () => save({ 'notify.voice': String(notifVoice.checked) }));
  box.appendChild(settingRow('Voice notifications', notifVoice));

  // ── Audio devices ────────────────────────────────────────────────
  box.appendChild(settingGroup('Audio Devices'));
  const audioSel = s.audio || { output: 'default', input: 'default', followDefault: true };
  let audioDev = null;
  try { audioDev = await getAudioDevices(); } catch { audioDev = null; }

  const followBox = document.createElement('input');
  followBox.type = 'checkbox';
  followBox.checked = audioSel.followDefault !== false;
  followBox.setAttribute('aria-label', 'Follow system default audio');
  followBox.addEventListener('change', () => save({ 'audio.followDefault': followBox.checked ? 'true' : 'false' }, true));
  box.appendChild(settingRow('Follow system defaults', followBox));

  if (!audioDev) {
    box.appendChild(note('Audio devices unavailable (PipeWire not detected).'));
  } else {
    const sinks = audioDev.sinks || [];
    const sources = audioDev.sources || [];
    const withSaved = (list: Array<{ name: string }>, saved: string): string[] => {
      const names = list.map((d) => d.name);
      return saved && saved !== 'default' && !names.includes(saved) ? [saved, ...names] : names;
    };
    const labelsFor = (list: Array<{ name: string; description: string; isDefault: boolean }>, saved: string): Record<string, string> => {
      const labels: Record<string, string> = {};
      for (const d of list) labels[d.name] = `${d.description}${d.isDefault ? ' (system default)' : ''}`;
      if (saved && !labels[saved]) labels[saved] = 'Saved (not present)';
      return labels;
    };
    const outSel = settingSelect(withSaved(sinks, audioSel.output), audioSel.output || 'default', labelsFor(sinks, audioSel.output));
    outSel.setAttribute('aria-label', 'Audio output');
    outSel.disabled = followBox.checked;
    outSel.addEventListener('change', () => save({ 'audio.output': outSel.value }));
    box.appendChild(settingRow('Output device', outSel));

    const inSel = settingSelect(withSaved(sources, audioSel.input), audioSel.input || 'default', labelsFor(sources, audioSel.input));
    inSel.setAttribute('aria-label', 'Audio input');
    inSel.disabled = followBox.checked;
    inSel.addEventListener('change', () => save({ 'audio.input': inSel.value }));
    box.appendChild(settingRow('Input device', inSel));

    const effectiveDev = (list: typeof sinks, saved: string): (typeof sinks)[number] | undefined =>
      list.find((d) => d.name === saved) || list.find((d) => d.isDefault) || list[0];
    const volRow = (dev: { name: string; volume: number | null; muted: boolean | null } | undefined, label: string): void => {
      if (!dev) return;
      const wrap = document.createElement('div');
      wrap.style.display = 'flex'; wrap.style.gap = '8px'; wrap.style.alignItems = 'center';
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '100';
      slider.value = String(Math.round((dev.volume ?? 1) * 100));
      slider.setAttribute('aria-label', `${label} volume`); slider.style.flex = '1';
      slider.addEventListener('change', () => {
        void setAudioVolume(dev.name, Number(slider.value) / 100).then(() => flashSaved())
          .catch((err) => addMsg('system', `Volume failed: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
      });
      const mute = document.createElement('input');
      mute.type = 'checkbox'; mute.checked = dev.muted === true; mute.title = 'Mute';
      mute.setAttribute('aria-label', `${label} mute`);
      mute.addEventListener('change', () => {
        void setAudioMute(dev.name, mute.checked).then(() => flashSaved())
          .catch((err) => addMsg('system', `Mute failed: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
      });
      wrap.append(slider, mute);
      box.appendChild(settingRow(label, wrap));
    };
    volRow(effectiveDev(sinks, audioSel.output), 'Output volume');
    volRow(effectiveDev(sources, audioSel.input), 'Input volume');

    const testOutBtn = document.createElement('button');
    testOutBtn.className = 'pill';
    testOutBtn.textContent = 'Test output';
    testOutBtn.setAttribute('aria-label', 'Test audio output');
    testOutBtn.addEventListener('click', () => {
      const target = effectiveDev(sinks, audioSel.output)?.name || '';
      testOutBtn.textContent = 'Playing…';
      void testAudioOutput(followBox.checked ? '' : target)
        .then(() => { testOutBtn.textContent = 'Test output'; flashSaved(); })
        .catch((err) => {
          testOutBtn.textContent = 'Test output';
          addMsg('system', `Test tone failed: ${err instanceof Error ? err.message : 'error'}`, 'sys');
        });
    });
    box.appendChild(settingRow('Output test', testOutBtn));
  }

  // ── Sidecars ─────────────────────────────────────────────────────
  box.appendChild(settingGroup('Sidecars'));
  box.appendChild(note('Local STT/TTS service health. Status refreshes automatically while this panel is open.'));
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
  scRefresh.textContent = 'Refresh';
  scRefresh.setAttribute('aria-label', 'Refresh sidecar status');
  scRefresh.addEventListener('click', () => void renderSidecars(scWrap));
  scFoot.appendChild(scRefresh);
  box.appendChild(scFoot);
  void renderSidecars(scWrap);

  box.appendChild(note('Advanced controls (approvals, prohibitions, scheduler, MCP server config, project caps) are available via their dedicated panels/APIs.'));
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

// E-17: boot en modo gate → solo orbe (la ventana main se esconde;
// despierta con "Pablo" por voz o expandiendo el orbe).
void (async () => {
  try {
    if (!isTauri()) return;
    const s = await getSettings().catch(() => null);
    if (s?.energy?.mode === 'gate') {
      await tinvoke('toggle_main').catch(() => {});
      await tinvoke('show_orb').catch(() => {});
    }
  } catch {
    // Boot gate caído: arranca normal.
  }
})();
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

// ── Integrations: presence HUD/briefing, JABS pulse, 3D stage (lazy) ─
let presenceDispose: (() => void) | null = null;
let jabsDispose: (() => void) | null = null;
let sceneHandle: { destroy(): void; refresh(): Promise<void> } | null = null;
let sceneOpen = false;

async function initConsoleAmbientIntegrationsOnce(): Promise<void> {
  if (presenceDispose || jabsDispose) return;
  try {
    const mod = await import('./integrations/presence-jabs-integration.ts');
    const hudMount = document.getElementById('presence-hud-slot');
    const briefingMount = document.getElementById('presence-brief-slot') as HTMLElement | null;
    if (hudMount) {
      const p = await mod.mountConsolePresence({ hudMount, briefingMount: briefingMount ?? undefined });
      presenceDispose = p.dispose;
    }
    const pulseMount = document.querySelector('#jabs-slot .jabs-pulse-slot') as HTMLElement | null;
    const briefMount = document.querySelector('#jabs-slot .jabs-brief-slot') as HTMLElement | null;
    const nudgesMount = document.querySelector('#jabs-slot .jabs-nudges-slot') as HTMLElement | null;
    const actionsMount = document.querySelector('#jabs-slot .jabs-actions-slot') as HTMLElement | null;
    const jabsSlot = document.getElementById('jabs-slot');
    if (jabsSlot && (pulseMount || briefMount || nudgesMount || actionsMount)) {
      const j = await mod.mountJabsAmbient({
        pulseMount, briefMount, nudgesMount, actionsMount,
        companyId: currentCompany || null,
        onAction: (action: unknown) => {
          const a = action as { type?: string; payload?: any };
          if (a?.type === 'open.project' && a.payload?.companyId) {
            connectTo(String(a.payload.companyId), a.payload.goalId || currentGoal || '');
          } else if (a?.type === 'jump.meeting') {
            switchView('console');
          } else if (a?.type === 'start.project' || a?.type === 'switch.view.projects') {
            switchView('projects');
          } else if (a?.type === 'refresh.pulse') {
            // pulse self-refreshes; no-op
          } else {
            console.debug('[jabs action]', action);
          }
        }
      });
      jabsDispose = j.dispose;
    }
  } catch (err) {
    console.warn('[integrations] presence/jabs not mounted', err);
  }
}

async function toggleProjectStage(): Promise<void> {
  const mount = document.getElementById('project-scene-mount') as HTMLElement | null;
  const empty = document.getElementById('project-scene-empty') as HTMLElement | null;
  const btn = document.getElementById('btn-open-stage') as HTMLButtonElement | null;
  if (!mount) return;
  if (sceneOpen) {
    sceneHandle?.destroy();
    sceneHandle = null;
    sceneOpen = false;
    mount.hidden = true;
    if (empty) { empty.hidden = false; empty.textContent = 'No scene loaded. Open to view the project stage.'; }
    if (btn) btn.textContent = 'Open';
    return;
  }
  const projectId = currentGoal || currentCompany || 'home';
  mount.hidden = false;
  if (empty) { empty.hidden = true; }
  if (btn) btn.textContent = 'Close';
  try {
    const { mountProjectScene } = await import('./integrations/scene-integration.ts');
    sceneHandle = await mountProjectScene({ container: mount, projectId });
    sceneOpen = true;
  } catch (err) {
    console.warn('[stage] mount failed', err);
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Stage unavailable: ${err instanceof Error ? err.message : 'error'}`;
    }
    mount.hidden = true;
    if (btn) btn.textContent = 'Open';
    sceneOpen = false;
  }
}

document.getElementById('btn-open-stage')?.addEventListener('click', () => { void toggleProjectStage(); });

const idleInit = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
const scheduleIntegrations = () => idleInit ? idleInit(() => { void initConsoleAmbientIntegrationsOnce(); }, { timeout: 3000 }) : setTimeout(() => { void initConsoleAmbientIntegrationsOnce(); }, 1500);
scheduleIntegrations();

(async () => {
  try {
    await resolveBase();
    const space = await findOrCreatePabloSpace();
    connectTo(space.companyId, space.goalId);
  } catch (err) {
    setStatus(`No backend: ${err instanceof Error ? err.message : 'error'}`);
  }
})();
