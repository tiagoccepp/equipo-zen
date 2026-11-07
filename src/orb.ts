// Orbe desktop: clic = hablar con el equipo, ⤢ = abrir la ventana.
// Arrastrable a cualquier borde. 148x148, fondo transparente.
import './orb.css';
import { invoke } from '@tauri-apps/api/core';

type Estado = 'idle' | 'escuchando' | 'hablando' | 'pensando';

const ARC = '#38D1FF';
const ETIQUETA: Record<Estado, string> = {
  idle: 'Equipo',
  escuchando: 'Escuchando…',
  hablando: 'Hablando…',
  pensando: 'Pensando…'
};

let estado: Estado = 'idle';
let nivel = 0;
let nivelSuave = 0;

const orb = document.getElementById('orb') as HTMLDivElement;
const canvas = document.getElementById('orbCanvas') as HTMLCanvasElement;
const etiqueta = document.getElementById('orbLabel') as HTMLSpanElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = 148 * DPR;
canvas.height = 148 * DPR;

function dibujar(t: number) {
  nivelSuave += (nivel - nivelSuave) * 0.2;
  const w = canvas.width;
  ctx.clearRect(0, 0, w, canvas.height);
  const cx = w / 2;
  const cy = w / 2 - 12 * DPR;
  const base = 44 * DPR;
  const respiro = estado === 'idle' ? Math.sin(t / 1400) * 0.03 : 0;
  const radio = base * (1 + respiro + nivelSuave * 0.12);

  // Halo.
  const halo = ctx.createRadialGradient(cx, cy, radio * 0.4, cx, cy, radio * 1.7);
  const glow = estado === 'idle' ? 0.22 : 0.4 + nivelSuave * 0.35;
  halo.addColorStop(0, `rgba(56, 209, 255, ${glow.toFixed(2)})`);
  halo.addColorStop(1, 'rgba(56, 209, 255, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, radio * 1.7, 0, Math.PI * 2);
  ctx.fill();

  // Núcleo translúcido: el cuerpo lo da el cristal glass3d de abajo.
  ctx.fillStyle = 'rgba(14, 19, 25, 0.28)';
  ctx.beginPath();
  ctx.arc(cx, cy, radio, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ARC;
  ctx.lineWidth = 2 * DPR;
  ctx.stroke();

  // Pulso interno.
  const pr = radio * (0.5 + nivelSuave * 0.3 + (estado === 'escuchando' ? Math.sin(t / 300) * 0.06 : 0));
  ctx.fillStyle = 'rgba(56, 209, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(pr, 4 * DPR), 0, Math.PI * 2);
  ctx.fill();

  // Anillo de escucha.
  if (estado === 'escuchando' && !reduced) {
    const fase = (t % 1600) / 1600;
    ctx.strokeStyle = `rgba(56, 209, 255, ${(0.7 * (1 - fase)).toFixed(2)})`;
    ctx.lineWidth = 2 * DPR;
    ctx.beginPath();
    ctx.arc(cx, cy, radio * (1 + fase * 0.5), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Aspas de pensamiento.
  if (estado === 'pensando' && !reduced) {
    ctx.strokeStyle = 'rgba(56, 209, 255, 0.9)';
    ctx.lineWidth = 3 * DPR;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i += 1) {
      const a0 = (t / 900 + (i * Math.PI * 2) / 3) % (Math.PI * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, radio * 1.18, a0, a0 + 0.7);
      ctx.stroke();
    }
  }

  if (!reduced) {
    requestAnimationFrame(dibujar);
  }
}

async function poll() {
  try {
    const r = await invoke<{ estado: Estado; nivel: number }>('orb_poll');
    if (r.estado !== estado && r.estado in ETIQUETA) {
      estado = r.estado;
      etiqueta.textContent = ETIQUETA[estado];
      orb.dataset.estado = estado;
    }
    nivel = Math.max(0, Math.min(1, r.nivel || 0));
  } catch {
    // El núcleo tarda en arrancar: se reintenta solo.
  }
}

let downX = 0;
let downY = 0;
let dragging = false;

orb.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
  dragging = false;
});

orb.addEventListener('pointermove', (e) => {
  if (e.buttons === 0 || dragging) {
    return;
  }
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) {
    dragging = true;
    void invoke('orb_drag');
  }
});

orb.addEventListener('pointerup', () => {
  if (dragging) {
    return;
  }
  void invoke('orb_command', { cmd: 'toggle-mic' });
});

orb.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    void invoke('orb_command', { cmd: 'toggle-mic' });
  }
});

document.getElementById('expandBtn')?.addEventListener('click', () => {
  void invoke('orb_command', { cmd: 'expand' });
});

dibujar(0);
void poll();
window.setInterval(poll, 500);
