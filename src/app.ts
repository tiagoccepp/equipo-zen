// Sofia — UI Lovable-oscura + loop de voz dinámico upstream
// (VAD continuo + barge-in + gate de audio + work-events).

import './app.css';
import { OrbField, type OrbAgent, type OrbSlot } from './lib/call-orbs.ts';
import { isTauri, tinvoke } from './lib/tauri.ts';
import {
  Client,
  decir,
  findOrCreateSofiaSpace,
  firstProject,
  getSettings,
  listCompanies,
  resolveBase,
  saveSettings,
  type Agent,
  type PublicSettings
} from './client.ts';
import { BrowserSpeech, LiveMic, VoiceOut } from './voice.ts';

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

function maybePlaybackComplete(): void {
  if (audioSegment?.endReceived && !voiceOut.isPlaying) {
    client.playbackComplete(audioSegment.turnId, audioSegment.agentId);
    if (speakingAgent === audioSegment.agentId) {
      speakingAgent = '';
      field.setSpeaking('');
    }
    audioSegment = null;
    if (!liveMic.userSpeaking) setStatus('a la orden');
  }
}

voiceOut.onDrained = () => {
  maybePlaybackComplete();
};

const liveMic = new LiveMic({
  onChunk: (b64) => client.audioChunk(b64),
  onSpeechStart: () => {
    // Arrancar un turno corta lo que sonaba (igual que upstream).
    voiceOut.flush();
    voiceOut.restoreGain();
    setStatus('grabando tu turno…');
  },
  onSpeechEnd: (hint) => {
    // Acuse instantáneo (0ms, audio local pre-cargado): Sofia confirma que
    // escuchó mientras el servidor transcribe + piensa + sintetiza. Solo 1:1;
    // en grupo el acuse con voz de sistema confundiría (¿quién habló?).
    if (voiceSession && !voiceGroup) {
      voiceOut.playPreamble();
    }
    client.audioEnd(hint);
    setStatus('transcribiendo…');
  },
  onDiscarded: () => {
    client.audioCancel('too_short', 0);
    setStatus('ruido descartado.');
    window.setTimeout(() => {
      if (voiceSession && statusEl.textContent === 'ruido descartado.') {
        setStatus(voiceGroup ? 'te escuchan todos' : 'te escucho…');
      }
    }, 900);
  },
  onInterrupt: () => {
    client.interrupt(audioSegment?.turnId, audioSegment?.agentId);
    voiceOut.flush();
    voiceOut.restoreGain();
    speakingAgent = '';
    field.setSpeaking('');
    addMsg('sistema', '⏵ la cortaste — te escucha.', 'sys');
  },
  onDuck: (ducked) => {
    if (ducked) {
      voiceOut.duck();
      setStatus('te escucho…');
    } else {
      voiceOut.restoreGain();
    }
  },
  isAgentSpeaking: agentSpeaking,
  hintText: () => browserSpeech.latestUtterance(),
  resetHint: () => browserSpeech.resetUtterance()
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
    orbAgents.push({ id: 'sofia', name: 'Sofia', color: '#38D1FF' });
    slots.push({ id: 'sofia', cx: w / 2, cy: h / 2 - 8, r: Math.min(128, h / 2 - 30) });
  }
  field.setAgents(orbAgents);
  field.setSlots(slots);
  field.start();
}

window.addEventListener('resize', layoutOrbs);

// ── Cliente ─────────────────────────────────────────────────────────
const turnText = new Map<string, string>();
const agentName = (id: string): string => agents.get(id)?.name || 'Sofia';

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
    const sofia = list.find((a) => a.role === 'ceo') || list[0];
    greetEl.textContent = sofia ? `¿En qué te ayudo, señor? — ${sofia.name}` : '¿En qué te ayudo, señor?';
    setStatus(voiceSession ? 'te escucho…' : 'a la orden');
    layoutOrbs();
  },
  onUserText: (text) => {
    addMsg('vos', text, 'me');
    setStatus('orquestando respuesta…');
  },
  onRoute: (names) => {
    const who = names.filter(Boolean);
    if (who.length > 1) setStatus(`ronda: ${who.join(', ')}`);
  },
  onAgentStart: (agentId) => {
    turnText.set(agentId, '');
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
    // El subtítulo sigue al AUDIO, no al texto: si suena, no se limpia acá.
    if (!audioSegment && speakingAgent === agentId) {
      speakingAgent = '';
      field.setSpeaking('');
      if (!voiceSession) setStatus('a la orden');
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
  onAudioStart: (turnId, agentId) => {
    audioSegment = { turnId, agentId, endReceived: false };
    speakingAgent = agentId;
    field.setSpeaking(agentId);
    setStatus(`habla ${agentName(agentId).toLowerCase()}…`);
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
  onInterrupted: (agentId) => {
    voiceOut.flush();
    voiceOut.restoreGain();
    audioSegment = null;
    if (!agentId || speakingAgent === agentId) {
      speakingAgent = '';
      field.setSpeaking('');
    }
    setStatus(voiceSession ? 'te escucho…' : 'a la orden');
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
      addMsg('tools', `⚙️ ${who} ejecuta: ${str('cmd').slice(0, 120)}`, 'sys');
    } else if (kind === 'file_written' && str('path')) {
      addMsg('tools', `📝 ${who} ${event.edited ? 'editó' : 'escribió'}: ${str('path')}`, 'sys');
    } else if (kind === 'web' && str('url')) {
      addMsg('tools', `🌐 ${who} leyó: ${str('url').slice(0, 100)}`, 'sys');
    } else if (kind === 'task_started' && str('text')) {
      addMsg('tools', `▶️ ${who}: ${str('text').slice(0, 140)}`, 'sys');
    } else if (kind === 'task_done') {
      addMsg('tools', `✅ ${who} terminó${str('summary') ? `: ${str('summary').slice(0, 160)}` : ''}`, 'sys');
    } else if (kind === 'task_blocked') {
      addMsg('tools', `⛔ ${who} bloqueado: ${str('reason').slice(0, 140)}`, 'sys');
    } else if (kind === 'build_ok') {
      addMsg('tools', `🔨 ${who}: build OK`, 'sys');
    } else if (kind === 'build_failed') {
      addMsg('tools', `🔨 ${who}: build falló`, 'sys');
    } else if (kind === 'task_queued' && str('text')) {
      addMsg('tools', `📋 ${who} encoló: ${str('text').slice(0, 140)}`, 'sys');
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
  onNoResponse: (note) => {
    addMsg('sistema', note, 'sys');
    setStatus(voiceSession ? 'te escucho…' : 'a la orden');
  },
  onVoiceTranscript: (text, source) => {
    addMsg('vos · voz', `${text}  [${source}]`, 'me');
    setStatus('orquestando respuesta…');
  },
  onTranscribeEmpty: () => {
    addMsg('sistema', 'No te escuché; probá de nuevo.', 'sys');
    setStatus(voiceSession ? 'te escucho…' : 'a la orden');
  },
  onError: (message) => {
    addMsg('sistema', message, 'sys');
  },
  onClose: () => {
    setStatus('desconectada — reintentá en unos segundos');
  }
});

// ── Sesión de voz continua ──────────────────────────────────────────
async function setVoiceSession(on: boolean, group: boolean): Promise<void> {
  if (on === voiceSession && group === voiceGroup) {
    return;
  }
  if (!on) {
    liveMic.stop(true);
    browserSpeech.stop();
    client.audioStop();
    voiceSession = false;
    voiceGroup = false;
    micBtn.classList.remove('live');
    callBtn.classList.remove('live');
    setStatus('a la orden');
    return;
  }
  voiceOut.flush();
  await voiceOut.unlock();
  client.audioPrepare();
  const ok = await liveMic.start();
  if (!ok) {
    addMsg('sistema', 'No pude abrir el micrófono.', 'sys');
    setStatus('a la orden');
    return;
  }
  browserSpeech.start();
  voiceSession = true;
  voiceGroup = group;
  // Pre-carga del acuse: un fetch, se decodifica una vez, dura toda la sesión.
  if (!group) {
    void voiceOut.primePreamble('/audio/preamble.mp3');
  }
  micBtn.classList.toggle('live', !group);
  callBtn.classList.toggle('live', group);
  setStatus(group ? 'te escuchan todos — hablá nomás' : 'te escucho…');
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
  voiceBtn.textContent = voiceOn ? '🔊 voz' : '🔇 muda';
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
      setStatus('probando voz…');
      const b64 = await decir('Atenta, señor. ¿Me escucha bien?');
      await voiceOut.unlock();
      await voiceOut.playMp3(b64);
      setStatus(voiceSession ? 'te escucho…' : 'a la orden');
    } catch (err) {
      addMsg('sistema', `Probar voz falló: ${err instanceof Error ? err.message : 'error'}`, 'sys');
      setStatus(voiceSession ? 'te escucho…' : 'a la orden');
    }
  })();
});

// ── Empresas (opcional) ─────────────────────────────────────────────
let currentCompany = '';
let currentGoal = '';

function meetingKey(companyId: string, goalId: string): string {
  return `sofia.meeting.${companyId}.${goalId}`;
}

function connectTo(companyId: string, goalId: string): void {
  currentCompany = companyId;
  currentGoal = goalId;
  const meetingId = window.localStorage.getItem(meetingKey(companyId, goalId)) || undefined;
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
  pantalla: '🖥️ ver pantalla',
  mouse: '🖱️ mover/click',
  teclado: '⌨️ teclas/escribir'
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
      opt.textContent = lv;
      sel.appendChild(opt);
    }
    sel.value = current[cap] || 'preguntar';
    sel.addEventListener('change', () => {
      void tinvoke('set_permission', { cap, level: sel.value }).catch((err) => {
        addMsg('sistema', `Permiso falló: ${String(err)}`, 'sys');
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
  minimax: { field: 'llm.apiKey', label: '🔑 clave MiniMax' },
  deepseek: { field: 'llm.deepseekKey', label: '🔑 clave DeepSeek' },
  opencode: { field: 'llm.opencodeKey', label: '🔑 clave opencode' },
  groq: { field: 'llm.groqKey', label: '🔑 clave Groq' }
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
  setStatus('ajuste guardado ✓');
  window.setTimeout(() => {
    if (statusEl.textContent === 'ajuste guardado ✓') setStatus(prev);
  }, 1200);
}

async function renderSettings(): Promise<void> {
  const box = $('settings-list');
  box.innerHTML = '';
  let s: PublicSettings;
  try {
    s = await getSettings();
  } catch {
    box.textContent = 'Sin backend.';
    return;
  }
  const save = (patch: Record<string, string>, rerender = false): void => {
    void saveSettings(patch)
      .then(() => {
        flashSaved();
        if (rerender) void renderSettings();
      })
      .catch((err) => addMsg('sistema', `Ajuste falló: ${err instanceof Error ? err.message : 'error'}`, 'sys'));
  };

  box.appendChild(settingGroup('Cerebro'));
  const provLabels: Record<string, string> = {};
  for (const p of s.llm.providerOptions) provLabels[p.id] = p.label;
  const provSel = settingSelect(s.llm.providerOptions.map((p) => p.id), s.llm.provider, provLabels);
  provSel.setAttribute('aria-label', 'Proveedor de razonamiento');
  provSel.addEventListener('change', () => save({ 'llm.provider': provSel.value }, true));
  box.appendChild(settingRow('🧠 proveedor', provSel));

  const modelSel = settingSelect(s.llm.modelOptions, s.llm.model);
  modelSel.setAttribute('aria-label', 'Modelo');
  modelSel.addEventListener('change', () => save({ 'llm.model': modelSel.value }));
  box.appendChild(settingRow('📦 modelo', modelSel));

  const keyInfo = LLM_KEY_FIELD[s.llm.provider] || LLM_KEY_FIELD.opencode;
  const masked = s.llm.provider === 'minimax' ? s.llm.apiKeyMasked
    : s.llm.provider === 'deepseek' ? s.llm.deepseekKeyMasked
    : s.llm.provider === 'opencode' ? s.llm.opencodeKeyMasked : '';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = masked || 'vacía — pegá la clave';
  keyInput.setAttribute('aria-label', keyInfo.label);
  keyInput.addEventListener('change', () => {
    if (!keyInput.value) return;
    save({ [keyInfo.field]: keyInput.value });
    keyInput.value = '';
  });
  box.appendChild(settingRow(keyInfo.label, keyInput));

  box.appendChild(settingGroup('Oído'));
  const sttSel = settingSelect(s.stt.providerOptions, s.stt.provider);
  sttSel.setAttribute('aria-label', 'Proveedor de transcripción');
  sttSel.addEventListener('change', () => save({ 'stt.provider': sttSel.value }));
  box.appendChild(settingRow('👂 transcripción', sttSel));

  const wSel = settingSelect(s.stt.whisperModelOptions, s.stt.whisperModel);
  wSel.setAttribute('aria-label', 'Modelo Whisper local');
  wSel.addEventListener('change', () => save({ 'stt.whisperModel': wSel.value }));
  box.appendChild(settingRow('📦 whisper local', wSel));

  const groqInput = document.createElement('input');
  groqInput.type = 'password';
  groqInput.placeholder = s.stt.groqKeyMasked || 'vacía';
  groqInput.setAttribute('aria-label', 'Clave Groq STT');
  groqInput.addEventListener('change', () => {
    if (!groqInput.value) return;
    save({ 'stt.groqKey': groqInput.value });
    groqInput.value = '';
  });
  box.appendChild(settingRow('🔑 clave Groq', groqInput));

  const dgInput = document.createElement('input');
  dgInput.type = 'password';
  dgInput.placeholder = s.stt.deepgramKeyMasked || 'vacía';
  dgInput.setAttribute('aria-label', 'Clave Deepgram');
  dgInput.addEventListener('change', () => {
    if (!dgInput.value) return;
    save({ 'stt.deepgramKey': dgInput.value });
    dgInput.value = '';
  });
  box.appendChild(settingRow('🔑 clave Deepgram', dgInput));

  const langInput = document.createElement('input');
  langInput.type = 'text';
  langInput.value = s.stt.language;
  langInput.setAttribute('aria-label', 'Idioma de escucha');
  langInput.addEventListener('change', () => save({ 'stt.language': langInput.value.trim() || 'es' }));
  box.appendChild(settingRow('🗣️ idioma oído', langInput));

  box.appendChild(settingGroup('Voz'));
  const ttsLang = document.createElement('input');
  ttsLang.type = 'text';
  ttsLang.value = s.tts.language;
  ttsLang.setAttribute('aria-label', 'Idioma de voz');
  ttsLang.addEventListener('change', () => save({ 'tts.language': ttsLang.value.trim() || 'es' }));
  box.appendChild(settingRow('🗣️ idioma voz', ttsLang));
}
document.querySelector('#settings-box')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) void renderSettings();
});
if (isTauri()) {
  $('perms-box').hidden = false;
}

// Debug: window.__sofia (para auditoría).
(window as unknown as { __sofia: object }).__sofia = {
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

// ── Arranque ────────────────────────────────────────────────────────
layoutOrbs();

(async () => {
  try {
    await resolveBase();
    const space = await findOrCreateSofiaSpace();
    connectTo(space.companyId, space.goalId);
  } catch (err) {
    setStatus(`sin backend: ${err instanceof Error ? err.message : 'error'}`);
  }
})();
