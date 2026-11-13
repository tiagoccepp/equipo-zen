// Minimized orb: SAME upstream OrbField, alive in a glass card.
// Click (without dragging) = talk, ⤢ = open Pablo, drag = move.
// V3 model-driven: orb is ALWAYS an orb; state only modulates vibration via
// energy (real audio level + per-state floor). No forced figures.
// Energy is real audio: the main window reports it via orb_report and
// it is read here with orb_poll (protocol states: idle/escuchando/hablando/pensando).

import { invoke } from '@tauri-apps/api/core';
import { OrbField } from './lib/call-orbs.ts';

const canvas = document.getElementById('orb-canvas') as HTMLCanvasElement;
const card = document.getElementById('orb-card') as HTMLElement;
const statusEl = document.getElementById('orb-status') as HTMLElement;
const micBtn = document.getElementById('micBtn') as HTMLButtonElement;

// Only the visible label is in English; the keys are Rust protocol.
const STATUS_LABEL: Record<string, string> = {
  idle: 'Pablo',
  escuchando: '● Listening',
  hablando: '♪ Speaking',
  pensando: '… Thinking'
};

let level = 0;
// V3: per-state vibration floor (mirror of STATE_VIBRATION in
// orb-morph.ts). The real level wins; the floor avoids a dead orb if
// main reports an active state with level 0 (e.g. thinking with no audio).
const VIB_FLOOR: Record<string, number> = {
  idle: 0,
  escuchando: 0.12,
  hablando: 0.3,
  pensando: 0.15,
  trabajando: 0.1
};
const field = new OrbField(canvas, { energy: () => level });
field.setTheme('dark');
field.setAgents([{ id: 'pablo', name: 'Pablo', color: '#38D1FF' }]);

function layout(): void {
  const r = canvas.getBoundingClientRect();
  const w = r.width || 148;
  const h = r.height || 148;
  field.resize(w, h);
  field.setSlots([{ id: 'pablo', cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 - 4 }]);
}
window.addEventListener('resize', layout);
layout();
field.start();

async function poll(): Promise<void> {
  try {
    const { estado, nivel } = await invoke<{ estado: string; nivel: number }>('orb_poll');
    const floor = VIB_FLOOR[estado] ?? 0;
    level = Math.max(0, Math.min(1, nivel || 0), floor);
    field.setSpeaking(estado === 'idle' ? '' : 'pablo');
    statusEl.textContent = STATUS_LABEL[estado] || 'Pablo';
    micBtn.classList.toggle('live', estado === 'escuchando');
  } catch {
    // Core not ready yet.
  }
}
window.setInterval(() => void poll(), 250);
void poll();

micBtn.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'toggle-mic' });
});
document.getElementById('expandBtn')?.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'expand' });
});

// Arrastre desde cualquier punto de la tarjeta (fondo glass incluido);
// click without dragging outside the buttons = talk (6px threshold).
let downAt: { x: number; y: number } | null = null;
let dragging = false;
card.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  downAt = { x: e.clientX, y: e.clientY };
  dragging = false;
});
window.addEventListener('pointermove', (e) => {
  if (!downAt || dragging) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) {
    dragging = true;
    downAt = null;
    void invoke('orb_drag');
  }
});
window.addEventListener('pointerup', (e) => {
  if (downAt && !dragging && !(e.target as HTMLElement).closest?.('button')) {
    void invoke('orb_command', { cmd: 'toggle-mic' });
  }
  downAt = null;
  dragging = false;
});
