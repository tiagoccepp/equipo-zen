// Orbe minimizado: MISMO OrbField upstream, vivo en tarjeta glass.
// Clic (sin arrastrar) = hablar, ⤢ = abrir Pablo, arrastrar = mover.
// V3 modelo-manda: orbe SIEMPRE orbe; el estado solo modula vibración via
// energía (nivel de audio real + piso por estado). Sin figuras forzadas.
// La energía es audio real: la ventana main la reporta vía orb_report y
// acá se lee con orb_poll (estados del protocolo: idle/escuchando/hablando/pensando).

import { invoke } from '@tauri-apps/api/core';
import { OrbField } from './lib/call-orbs.ts';

const canvas = document.getElementById('orb-canvas') as HTMLCanvasElement;
const card = document.getElementById('orb-card') as HTMLElement;
const statusEl = document.getElementById('orb-status') as HTMLElement;
const micBtn = document.getElementById('micBtn') as HTMLButtonElement;

// Solo la etiqueta visible va en inglés; las claves son protocolo Rust.
const STATUS_LABEL: Record<string, string> = {
  idle: 'Pablo',
  escuchando: '● Listening',
  hablando: '♪ Speaking',
  pensando: '… Thinking'
};

let level = 0;
// V3: piso de vibración por estado (espejo de STATE_VIBRATION en
// orb-morph.ts). El nivel real manda; el piso evita un orbe muerto si el
// main reporta un estado activo con nivel 0 (ej. pensando sin audio).
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
    // Núcleo aún no listo.
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
// clic sin arrastre fuera de los botones = hablar (umbral 6px).
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
