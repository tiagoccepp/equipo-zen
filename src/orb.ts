// Orbe desktop: LA MISMA esfera de partículas del modo llamada
// (upstream call-orbs.ts verbatim). Clic = hablar, ⤢ = abrir Sofia.

import { invoke } from '@tauri-apps/api/core';
import { OrbField } from './lib/call-orbs.ts';

const canvas = document.getElementById('orb-canvas') as HTMLCanvasElement;

let level = 0;
const field = new OrbField(canvas, { energy: () => level });
field.setTheme('dark');
field.setAgents([{ id: 'sofia', name: 'Sofia', color: '#38D1FF' }]);

function layout(): void {
  const w = window.innerWidth || 148;
  const h = window.innerHeight || 148;
  field.resize(w, h);
  const r = Math.min(w, h) / 2 - 8;
  field.setSlots([{ id: 'sofia', cx: w / 2, cy: h / 2, r }]);
}
window.addEventListener('resize', layout);
layout();
field.start();

async function poll(): Promise<void> {
  try {
    const { estado, nivel } = await invoke<{ estado: string; nivel: number }>('orb_poll');
    level = Math.max(0, Math.min(1, nivel || 0));
    field.setSpeaking(estado === 'hablando' || estado === 'escuchando' ? 'sofia' : '');
  } catch {
    // Núcleo aún no listo.
  }
}
window.setInterval(() => void poll(), 250);
void poll();

let downAt = 0;
canvas.addEventListener('pointerdown', () => {
  downAt = Date.now();
});
canvas.addEventListener('pointerup', (e) => {
  // Arrastre = mover; clic corto = hablar.
  if (Date.now() - downAt > 220) return;
  e.preventDefault();
  void invoke('orb_command', { cmd: 'toggle-mic' });
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 1 && Date.now() - downAt > 220) {
    void invoke('orb_drag');
  }
});

document.getElementById('expandBtn')?.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'expand' });
});
