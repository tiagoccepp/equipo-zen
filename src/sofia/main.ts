// Sofia — HUD Jarvis sobre el backend Equipo.
// Orbe + estados + captura de lyns-voice (MIT, ver vendor/LYNS-LICENSE.MIT);
// el puente al backend es nuestro (backend.ts).

import './app/shell.css';
import './app/session/session.css';
import './app/terminal/terminal.css';

import { Avatar } from './avatar/Avatar';
import { AvatarController } from './avatar/AvatarController';
import { detectGpu } from './avatar/gpu';
import { THEME_PALETTES } from './config/config';
import { SttCapture } from './audio/SttCapture';
import { SessionPanel } from './app/session/SessionPanel';
import { deriveState, type VoiceSignals } from './integration/signals';
import { SofiaBackend, apiBase, findOrCreateSofiaSpace, listCompanies, resolveBase, type SofiaAgent } from './backend';
import { SofiaAudioOut } from './audio-out';

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const byId = (id: string): HTMLElement => {
  const el = $(id);
  if (!el) throw new Error(`falta #${id}`);
  return el;
};

function base64FromInt16(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function bootstrap(): Promise<void> {
  const root = $('avatar-root');
  if (!root) return;

  // ── Orbe ──────────────────────────────────────────────────────────
  const gpu = detectGpu();
  const avatar = new Avatar({ skin: 'reactor' });
  avatar.mount(root);
  const controller = new AvatarController({ avatar });
  controller.setPalette(THEME_PALETTES.cyan);
  avatar.start();

  const statusEl = $('status');
  if (statusEl) {
    statusEl.textContent = gpu.software ? 'sofia · lite: software gpu' : 'sofia · lista';
    statusEl.title = `WebGL: ${gpu.renderer}`;
  }

  // ── HUD ───────────────────────────────────────────────────────────
  const caption = byId('caption');
  const stateEl = byId('hud-state');
  const turnsEl = byId('hud-turns');
  const upEl = byId('hud-uptime');
  const actEl = byId('hud-activity');
  const transcriptEl = byId('hud-transcript');
  const waveSvg = byId('hud-wave');
  const waveLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  waveLine.setAttribute('class', 'wave-line');
  waveSvg.appendChild(waveLine);
  const micFab = byId('mic-fab') as HTMLButtonElement;
  const llamarBtn = byId('llamar-btn') as HTMLButtonElement;
  const empresasBtn = byId('empresas-btn') as HTMLButtonElement;
  const sessionLayer = byId('session-layer');
  const empresasLayer = byId('empresas-layer');

  const bootTime = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - bootTime) / 1000);
    upEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  let turns = 0;
  const agents = new Map<string, SofiaAgent>();
  const agentName = (id: string): string => agents.get(id)?.name || 'Sofia';
  const signals: VoiceSignals = { micActive: false, speaking: false, pendingResponse: false };
  let speakingCount = 0;

  const setCaption = (text: string): void => {
    caption.textContent = text;
  };
  const setState = (text: string): void => {
    stateEl.textContent = text;
  };
  const setActivity = (text: string): void => {
    actEl.textContent = text;
  };

  const addTranscript = (who: string, text: string): void => {
    const empty = transcriptEl.querySelector('.t-empty');
    if (empty) empty.remove();
    const line = document.createElement('div');
    line.className = 't-line';
    const b = document.createElement('b');
    b.textContent = `${who}: `;
    line.appendChild(b);
    line.appendChild(document.createTextNode(text));
    transcriptEl.appendChild(line);
    while (transcriptEl.childElementCount > 60) {
      transcriptEl.firstElementChild?.remove();
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  };

  const drawWave = (level: number): void => {
    const pts: string[] = [];
    const n = 48;
    for (let i = 0; i <= n; i += 1) {
      const x = (i / n) * 240;
      const y = 61 - Math.sin(i * 0.7) * level * 56;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    waveLine.setAttribute('points', pts.join(' '));
  };
  drawWave(0);

  // ── Panel de charla (texto como co-igual a la voz) ─────────────────
  const panel = new SessionPanel({
    x: 24,
    y: 120,
    width: 430,
    height: 380,
    title: 'SOFIA · CHARLA',
    onSubmit: (text) => {
      void audioOut.unlock();
      backend.sendText(text);
    },
    onFocus: () => {},
    onClose: () => {
      panel.el.style.display = 'none';
    }
  });
  sessionLayer.appendChild(panel.el);
  panel.el.style.display = 'none';

  // ── Audio ─────────────────────────────────────────────────────────
  const audioOut = new SofiaAudioOut();
  audioOut.onDrained = () => {
    speakingCount = 0;
    signals.speaking = false;
    controller.setState(deriveState(signals));
    setState('a la orden');
  };

  const capture = new SttCapture({
    onFrame: (frame) => {
      backend.audioChunk(base64FromInt16(frame));
    },
    onLevel: (level) => {
      controller.setMicLevel(level);
      drawWave(level);
    },
    onBands: (bands) => {
      controller.setMicBands(bands);
    }
  });

  let pttActive = false;
  const stopPtt = (): void => {
    if (!pttActive) return;
    pttActive = false;
    capture.stop();
    backend.audioEnd();
    signals.micActive = false;
    signals.pendingResponse = true;
    controller.setState(deriveState(signals));
    setState('procesando');
    setCaption('…');
    micFab.classList.remove('live');
  };

  const startPtt = async (group: boolean): Promise<void> => {
    if (pttActive) {
      stopPtt();
      return;
    }
    audioOut.stop();
    await audioOut.unlock();
    backend.audioStart();
    const ok = await capture.start();
    if (!ok) {
      setCaption('No pude abrir el micrófono, señor.');
      addTranscript('sistema', 'micrófono denegado o sin dispositivo');
      return;
    }
    pttActive = true;
    signals.micActive = true;
    signals.pendingResponse = false;
    controller.setState(deriveState(signals));
    setState(group ? 'escuchando a todos' : 'escuchando');
    setCaption(group ? 'Hablá, te escuchan todos.' : 'Hablá, señor.');
    micFab.classList.add('live');
  };

  micFab.addEventListener('click', () => void startPtt(false));
  llamarBtn.addEventListener('click', () => void startPtt(true));
  (byId('charla-btn') as HTMLButtonElement).addEventListener('click', () => {
    panel.el.style.display = panel.el.style.display === 'none' ? '' : 'none';
  });

  // ── Backend ───────────────────────────────────────────────────────
  const turnText = new Map<string, string>();
  const backend = new SofiaBackend({
    onReady: (list) => {
      agents.clear();
      for (const a of list) agents.set(a.id, a);
      const sofia = list.find((a) => a.role === 'ceo') || list[0];
      setCaption(sofia ? `A la orden, señor. Soy ${sofia.name}.` : 'A la orden, señor.');
    },
    onUserText: (text) => {
      turns += 1;
      turnsEl.textContent = String(turns);
      addTranscript('vos', text);
      panel.addLine('user', text);
      signals.pendingResponse = true;
      controller.setState(deriveState(signals));
      setState('procesando');
    },
    onRoute: (names) => {
      const who = names.filter(Boolean).join(', ');
      setActivity(names.length > 1 ? `ronda: ${who}` : who || 'sofia');
    },
    onAgentStart: (agentId) => {
      turnText.set(agentId, '');
      setActivity(`habla ${agentName(agentId).toLowerCase()}`);
    },
    onDelta: (agentId, delta) => {
      turnText.set(agentId, (turnText.get(agentId) || '') + delta);
    },
    onAgentEnd: (agentId, text) => {
      const full = text || turnText.get(agentId) || '';
      turnText.delete(agentId);
      if (!full.trim()) return;
      addTranscript(agentName(agentId).toLowerCase(), full);
      panel.addLine('narration', `${agentName(agentId)}: ${full}`);
      setCaption(full.length > 140 ? `${full.slice(0, 140)}…` : full);
      signals.pendingResponse = false;
      if (!audioOut.playing) {
        controller.setState(deriveState(signals));
        setState('a la orden');
      }
    },
    onMp3: (_agentId, base64) => {
      speakingCount += 1;
      signals.speaking = true;
      controller.setState(deriveState(signals));
      setState('hablando');
      void audioOut.playMp3(base64);
    },
    onPcm: (base64, rate) => {
      speakingCount += 1;
      signals.speaking = true;
      controller.setState(deriveState(signals));
      setState('hablando');
      void audioOut.enqueuePcm(base64, rate);
    },
    onAudioStart: () => {},
    onAudioEnd: () => {},
    onNoResponse: (note) => {
      setCaption(note);
      addTranscript('sistema', note);
      signals.pendingResponse = false;
      controller.setState(deriveState(signals));
      setState('a la orden');
    },
    onVoiceTranscript: (text, source) => {
      addTranscript('vos (voz)', `${text}  [${source}]`);
      panel.addLine('user', text);
    },
    onError: (message) => {
      setCaption(message);
      addTranscript('sistema', message);
    },
    onClose: () => {
      setCaption('Conexión perdida. Reintentá en unos segundos.');
      setState('desconectada');
    }
  });

  // ── Empresas (sección opcional) ───────────────────────────────────
  let empresasOpen = false;
  let currentCompany = '';
  const renderEmpresas = async (): Promise<void> => {
    const companies = await listCompanies().catch(() => []);
    empresasLayer.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'emp-panel';
    const head = document.createElement('div');
    head.className = 'emp-head';
    head.innerHTML = '<span>EMPRESAS</span>';
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar empresas');
    close.addEventListener('click', () => {
      empresasOpen = false;
      empresasLayer.hidden = true;
    });
    head.appendChild(close);
    box.appendChild(head);
    for (const c of companies) {
      const btn = document.createElement('button');
      btn.className = 'emp-item' + (c.id === currentCompany ? ' active' : '');
      btn.textContent = c.name;
      btn.addEventListener('click', () => {
        // Cambiar de contexto = re-hola; Sofia sigue siendo la cara.
        void (async () => {
          try {
            const res = await fetch(`${apiBase()}/api/companies/${encodeURIComponent(c.id)}/projects`);
            const data = (await res.json()) as { projects?: Array<{ id: string }> };
            const goalId = data.projects?.[0]?.id;
            if (!goalId) return;
            currentCompany = c.id;
            backend.connect(c.id, goalId);
            setCaption(`Con ${c.name}, señor.`);
            void renderEmpresas();
          } catch {
            // Sin red: queda donde estaba.
          }
        })();
      });
      box.appendChild(btn);
    }
    empresasLayer.appendChild(box);
  };
  empresasBtn.addEventListener('click', () => {
    empresasOpen = !empresasOpen;
    empresasLayer.hidden = !empresasOpen;
    if (empresasOpen) void renderEmpresas();
  });

  // ── Loop ──────────────────────────────────────────────────────────
  const loop = (ms: number): void => {
    const t = ms / 1000;
    if (signals.speaking) {
      const level = audioOut.level();
      if (level > 0.12) controller.pulse(level);
    }
    controller.tick(t);
    avatar.update(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  window.addEventListener('resize', () => {
    avatar.resize(root.clientWidth || 1, root.clientHeight || 1);
  });

  // ── Arranque: Sofia directo ───────────────────────────────────────
  setCaption('Conectando…');
  try {
    await resolveBase();
    const space = await findOrCreateSofiaSpace();
    currentCompany = space.companyId;
    backend.connect(space.companyId, space.goalId);
  } catch (err) {
    setCaption(`Sin backend: ${err instanceof Error ? err.message : 'error'}.`);
  }
}

void bootstrap();
