// Orbe minimizado: esfera upstream + mini-UI glass.
// 🎤 = hablar (toggle voz), ⤢ = abrir Sofia, arrastrar = mover.

import { invoke } from '@tauri-apps/api/core';
import { OrbField } from './lib/call-orbs.ts';

const canvas = document.getElementById('orb-canvas') as HTMLCanvasElement;
const statusEl = document.getElementById('orb-status') as HTMLElement;
const micBtn = document.getElementById('micBtn') as HTMLButtonElement;

let level = 0;
const field = new OrbField(canvas, { energy: () => level });
field.setTheme('dark');
field.setAgents([{ id: 'sofia', name: 'Sofia', color: '#38D1FF' }]);

function layout(): void {
  const r = canvas.getBoundingClientRect();
  const w = r.width || 176;
  const h = r.height || 176;
  field.resize(w, h);
  field.setSlots([{ id: 'sofia', cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 - 6 }]);
}
window.addEventListener('resize', layout);
layout();
field.start();

const STATUS_LABEL: Record<string, string> = {
  idle: 'sofia',
  escuchando: '● escuchando',
  hablando: '♪ hablando'
};

async function poll(): Promise<void> {
  try {
    const { estado, nivel } = await invoke<{ estado: string; nivel: number }>('orb_poll');
    level = Math.max(0, Math.min(1, nivel || 0));
    field.setSpeaking(estado === 'hablando' || estado === 'escuchando' ? 'sofia' : '');
    statusEl.textContent = STATUS_LABEL[estado] || 'sofia';
    micBtn.classList.toggle('live', estado === 'escuchando');
  } catch {
    // Núcleo aún no listo.
  }
}
window.setInterval(() => void poll(), 250);
void poll();

micBtn.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'toggle-mic' });
});
// Clic en la esfera = hablar; arrastrar = mover (umbral 6px).
let downAt: { x: number; y: number } | null = null;
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  dragging = false;
});
window.addEventListener('pointermove', (e) => {
  if (!downAt || dragging) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) {
    dragging = true;
    void invoke('orb_drag');
  }
});
window.addEventListener('pointerup', () => {
  if (downAt && !dragging) {
    void invoke('orb_command', { cmd: 'toggle-mic' });
  }
  downAt = null;
});
document.getElementById('expandBtn')?.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'expand' });
});

// Arrastre desde la esfera (fondo transparente, sin card).
