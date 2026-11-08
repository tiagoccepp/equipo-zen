// Sofia — UI Lovable-oscura + orbes upstream + backend Equipo.

import './app.css';
import { OrbField, type OrbAgent, type OrbSlot } from './lib/call-orbs.ts';
import { isTauri, tinvoke } from './lib/tauri.ts';
import {
  Client,
  apiBase,
  decir,
  findOrCreateSofiaSpace,
  firstProject,
  listCompanies,
  resolveBase,
  type Agent
} from './client.ts';
import { PttMic, VoiceOut } from './voice.ts';

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

// ── Voz ─────────────────────────────────────────────────────────────
const voiceOut = new VoiceOut();
let voiceOn = true;
let speakingAgent = '';

voiceOut.onDrained = () => {
  speakingAgent = '';
  field.setSpeaking('');
  if (!pttOn) setStatus('a la orden');
};

const mic = new PttMic({
  onFrame: (b64) => client.audioChunk(b64)
});
let pttOn = false;
let pttGroup = false;

// ── Orbes (código upstream verbatim, tema dark) ──────────────────────
const field = new OrbField(canvas, {
  energy: () => voiceOut.level()
});
field.setTheme('dark');

const agents = new Map<string, Agent>();
let sofiaId = '';

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
    orbAgents.push({ id: 'sofia', name: 'Sofia', color: '#38D1FF' });
    slots.push({ id: 'sofia', cx: w / 2, cy: h / 2 - 8, r: Math.min(128, h / 2 - 30) });
  }
  field.setAgents(orbAgents);
  field.setSlots(slots);
  // start() no arranca sin orbes: va DESPUÉS de setAgents (es idempotente).
  field.start();
}

window.addEventListener('resize', layoutOrbs);

// ── Cliente ─────────────────────────────────────────────────────────
const turnText = new Map<string, string>();
const agentName = (id: string): string => agents.get(id)?.name || 'Sofia';

const client = new Client({
  onReady: (list) => {
    agents.clear();
    for (const a of list) agents.set(a.id, a);
    const sofia = list.find((a) => a.role === 'ceo') || list[0];
    sofiaId = sofia?.id || '';
    greetEl.textContent = sofia ? `¿En qué te ayudo, señor? — ${sofia.name}` : '¿En qué te ayudo, señor?';
    setStatus('a la orden');
    layoutOrbs();
  },
  onUserText: (text) => {
    addMsg('vos', text, 'me');
    setStatus('procesando…');
  },
  onRoute: (names) => {
    const who = names.filter(Boolean);
    if (who.length > 1) setStatus(`ronda: ${who.join(', ')}`);
  },
  onAgentStart: (agentId) => {
    turnText.set(agentId, '');
    speakingAgent = agentId;
    field.setSpeaking(agentId);
    setStatus(`habla ${agentName(agentId).toLowerCase()}…`);
  },
  onDelta: (agentId, delta) => {
    turnText.set(agentId, (turnText.get(agentId) || '') + delta);
  },
  onAgentEnd: (agentId, text) => {
    const full = text || turnText.get(agentId) || '';
    turnText.delete(agentId);
    if (full.trim()) {
      addMsg(agentName(agentId).toLowerCase(), full);
    }
    if (!voiceOut.playing) {
      speakingAgent = '';
      field.setSpeaking('');
      setStatus('a la orden');
    }
  },
  onMp3: (b64) => {
    if (!voiceOn) return;
    void voiceOut.unlock().then(() => voiceOut.playMp3(b64));
  },
  onPcm: (b64, rate) => {
    if (!voiceOn) return;
    void voiceOut.unlock().then(() => voiceOut.enqueuePcm(b64, rate));
  },
  onNoResponse: (note) => {
    addMsg('sistema', note, 'sys');
    setStatus('a la orden');
  },
  onVoiceTranscript: (text, source) => {
    addMsg('vos · voz', `${text}  [${source}]`, 'me');
  },
  onTranscribeEmpty: () => {
    addMsg('sistema', 'No te escuché; probá de nuevo.', 'sys');
    setStatus('a la orden');
  },
  onError: (message) => {
    addMsg('sistema', message, 'sys');
  },
  onClose: () => {
    setStatus('desconectada — reintentá en unos segundos');
  }
});

// ── Acciones ────────────────────────────────────────────────────────
function submitPrompt(): void {
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  void voiceOut.unlock();
  client.sendText(text);
}

sendBtn.addEventListener('click', submitPrompt);
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
    void voiceOut.unlock();
    client.sendText(text);
  });
});

async function togglePtt(group: boolean): Promise<void> {
  if (pttOn) {
    stopPtt();
    return;
  }
  voiceOut.stop();
  await voiceOut.unlock();
  client.audioStart();
  const ok = await mic.start();
  if (!ok) {
    addMsg('sistema', 'No pude abrir el micrófono.', 'sys');
    return;
  }
  pttOn = true;
  pttGroup = group;
  micBtn.classList.toggle('live', !group);
  callBtn.classList.toggle('live', group);
  micBtn.setAttribute('aria-pressed', String(!group));
  setStatus(group ? 'te escuchan todos — tocá de nuevo para mandar' : 'escuchando — tocá de nuevo para mandar');
}

function stopPtt(): void {
  if (!pttOn) return;
  pttOn = false;
  mic.stop();
  client.audioEnd();
  micBtn.classList.remove('live');
  callBtn.classList.remove('live');
  setStatus('transcribiendo…');
}

micBtn.addEventListener('click', () => void togglePtt(false));
callBtn.addEventListener('click', () => void togglePtt(true));

voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  client.setVoice(voiceOn);
  voiceBtn.classList.toggle('on', voiceOn);
  voiceBtn.classList.toggle('off', !voiceOn);
  voiceBtn.textContent = voiceOn ? '🔊 voz' : '🔇 muda';
  voiceBtn.setAttribute('aria-pressed', String(voiceOn));
  if (!voiceOn) {
    voiceOut.stop();
    speakingAgent = '';
    field.setSpeaking('');
  }
});

$('btn-test-voice').addEventListener('click', () => {
  void (async () => {
    try {
      setStatus('probando voz…');
      const b64 = await decir('Atenta, señor. ¿Me escucha bien?');
      await voiceOut.unlock();
      await voiceOut.playMp3(b64);
      setStatus('a la orden');
    } catch (err) {
      addMsg('sistema', `Probar voz falló: ${err instanceof Error ? err.message : 'error'}`, 'sys');
      setStatus('a la orden');
    }
  })();
});

// ── Empresas (opcional) ─────────────────────────────────────────────
let currentCompany = '';
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
        currentCompany = c.id;
        client.connect(c.id, goalId);
        setStatus(`con ${c.name}…`);
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
  if (pttOn) return 'escuchando';
  if (speakingAgent) return 'hablando';
  return 'idle';
}

if (isTauri()) {
  const tick = async () => {
    try {
      const cmd = await tinvoke<string | null>('main_poll');
      if (cmd === 'toggle-mic') void togglePtt(false);
      else if (cmd === 'expand') await tinvoke('expand_from_orb').catch(() => {});
    } catch {
      // Núcleo aún no listo.
    }
    try {
      await tinvoke('orb_report', {
        nuevo: orbState(),
        nivel: pttOn ? mic.level : speakingAgent ? 0.7 : 0
      });
    } catch {
      // Idem.
    }
  };
  void tick();
  window.setInterval(() => void tick(), 500);
}

// ── Arranque ────────────────────────────────────────────────────────
layoutOrbs();

(async () => {
  try {
    await resolveBase();
    const space = await findOrCreateSofiaSpace();
    currentCompany = space.companyId;
    client.connect(space.companyId, space.goalId);
  } catch (err) {
    setStatus(`sin backend: ${err instanceof Error ? err.message : 'error'}`);
  }
})();
