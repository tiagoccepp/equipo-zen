// Orbe desktop: esfera de partículas (dirección Tito 07/11). Clic = hablar
// con el equipo, ⤢ = abrir la ventana. Arrastrable. 148x148 transparente.
import './orb.css';
import { invoke } from '@tauri-apps/api/core';

type Estado = 'idle' | 'escuchando' | 'hablando' | 'pensando';

const ARC: [number, number, number] = [56, 209, 255];
const N = 450;
const RADIO = 52;
const CX = 74;
const CY = 60;
const TILT = 0.42;
const ETIQUETA: Record<Estado, string> = {
  idle: 'Equipo',
  escuchando: 'Escuchando…',
  hablando: 'Hablando…',
  pensando: 'Pensando…'
};
const GIRO: Record<Estado, number> = {
  idle: 0.25,
  escuchando: 0.5,
  hablando: 0.35,
  pensando: 1.6
};

let estado: Estado = 'idle';
let nivel = 0;
let nivelSuave = 0;
let angulo = 0;
let ultimoT = 0;

// Esfera de Fibonacci: distribución uniforme de puntos.
const puntos: Array<[number, number, number, number]> = [];
for (let i = 0; i < N; i += 1) {
  const y = 1 - (i / (N - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const t = i * 2.399963;
  puntos.push([Math.cos(t) * r, y, Math.sin(t) * r, Math.asin(Math.max(-1, Math.min(1, y)))]);
}

const orb = document.getElementById('orb') as HTMLDivElement;
const canvas = document.getElementById('orbCanvas') as HTMLCanvasElement;
const etiqueta = document.getElementById('orbLabel') as HTMLSpanElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = 148 * DPR;
canvas.height = 148 * DPR;

function dibujar(t: number) {
  const dt = ultimoT ? Math.min((t - ultimoT) / 1000, 0.1) : 0.016;
  ultimoT = t;
  nivelSuave += (nivel - nivelSuave) * 0.2;
  if (!reduced) {
    angulo += GIRO[estado] * dt;
  }
  const w = canvas.width;
  const u = DPR;
  ctx.clearRect(0, 0, w, canvas.height);
  const cx = CX * u;
  const cy = CY * u;

  // Respiración / pulso según estado.
  let pulso = 0;
  if (estado === 'idle') {
    pulso = Math.sin(t / 1400) * 0.02;
  } else if (estado === 'escuchando') {
    pulso = Math.sin(t / 300) * 0.04;
  }
  const rBase = RADIO * u * (1 + pulso + nivelSuave * 0.1);

  const cosA = Math.cos(angulo);
  const sinA = Math.sin(angulo);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  for (let i = 0; i < N; i += 1) {
    const [x, y, z, lat] = puntos[i];
    // Giro Y + inclinación X fija.
    const x1 = x * cosA + z * sinA;
    const z1 = -x * sinA + z * cosA;
    const y2 = y * cosT - z1 * sinT;
    const z2 = y * sinT + z1 * cosT;
    const prof = (z2 + 1) / 2;

    // Onda al hablar: riza la esfera con el nivel de voz.
    let rr = rBase;
    if (estado === 'hablando' && !reduced) {
      rr *= 1 + Math.sin(lat * 5 + t / 150) * 0.09 * Math.max(nivelSuave, 0.35);
    }

    const tam = (0.7 + 1.5 * prof) * u;
    let alfa = 0.22 + 0.78 * prof;
    if (!reduced) {
      alfa *= 0.85 + 0.15 * Math.sin(t / 420 + i * 1.7);
    }
    ctx.fillStyle = `rgba(${ARC[0]}, ${ARC[1]}, ${ARC[2]}, ${alfa.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cx + x1 * rr, cy + y2 * rr, tam, 0, Math.PI * 2);
    ctx.fill();
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
