// ═══════════════════════════════════════════════════════════════════════
// Generadores de figuras para partículas + interpolación.
//
// Lógica PURA: sin DOM, sin canvas, sin side effects (salvo text(), que
// necesita rasterizar una fuente y tira si no hay document). Corre en node
// para los tests y en la webview para los renderers (orb-morph.ts 2D,
// orb3d.ts three.js).
//
// Los puntos son Float32Array plano [x,y,z, x,y,z, …], en un cubo ~unitario
// ([-1,1] por eje). El renderer los escala por el radio de cada slot, igual
// que OrbField escala sus direcciones unitarias.
// ═══════════════════════════════════════════════════════════════════════

export type MorphShape = 'sphere' | 'torus' | 'cube' | 'wave' | 'ring';

export const MORPH_SHAPES: MorphShape[] = ['sphere', 'torus', 'cube', 'wave', 'ring'];

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// ── Aleatorio determinista ─────────────────────────────────────────────
// Dos herramientas, mismo contrato (misma seed → mismos puntos):
//   hashUnit(i, seed): sin estado, para repartos indexados (Fibonacci).
//   mulberry32(seed): con estado, para rellenos secuenciales.

// Misma idea que call-orbs.ts: hash con avalancha, no secuencias lineales
// (lineal + ángulo dorado dibuja meridianos / muaré visible).
function hashUnit(index: number, seed: number) {
  let hash = Math.imul((index | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(seed * 1e6) | 0, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967296;
}

export function mulberry32(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkCount(count: number) {
  const total = Math.max(1, Math.round(count));
  if (!Number.isFinite(total) || total < 1) {
    throw new RangeError(`fx/morph: count inválido (${count})`);
  }
  return total;
}

// ── Figuras ────────────────────────────────────────────────────────────

// Esfera unitaria: Fibonacci + temblor (idea de call-orbs.ts). Puntos SOBRE
// la superficie (|p| = 1): es un target de morph, el volumen lo da el
// renderer con rotación + buckets de profundidad.
export function sphere(count: number, seed = 0): Float32Array {
  const total = checkCount(count);
  const out = new Float32Array(total * 3);
  for (let i = 0; i < total; i += 1) {
    const uy = 1 - (2 * i + 1 + (hashUnit(i * 5 + 2, seed + 0.11) - 0.5) * 1.1) / total;
    const ring = Math.sqrt(Math.max(0, 1 - uy * uy));
    const theta = i * GOLDEN_ANGLE + seed + (hashUnit(i * 11 + 7, seed + 0.53) - 0.5) * 0.85;
    const x = Math.cos(theta) * ring;
    const z = Math.sin(theta) * ring;
    // Normalizar: el temblor en uy puede dejar |p| ≠ 1 por redondeo.
    const inv = 1 / (Math.hypot(x, uy, z) || 1);
    out[i * 3] = x * inv;
    out[i * 3 + 1] = uy * inv;
    out[i * 3 + 2] = z * inv;
  }
  return out;
}

// Toro de frente (anillo en el plano XY, tubo de radio fijo). R + r < 1
// para que no se salga del slot del renderer.
export const TORUS_R = 0.6;
export const TORUS_TUBE = 0.32;

export function torus(count: number, seed = 0): Float32Array {
  const total = checkCount(count);
  const out = new Float32Array(total * 3);
  for (let i = 0; i < total; i += 1) {
    const u = ((i + hashUnit(i * 3 + 1, seed + 0.7)) / total) * TAU;
    const v = i * GOLDEN_ANGLE * 2.399 + seed * 3.1 + (hashUnit(i * 7 + 5, seed + 0.2) - 0.5) * 0.6;
    const tube = TORUS_R + TORUS_TUBE * Math.cos(v);
    out[i * 3] = tube * Math.cos(u);
    out[i * 3 + 1] = tube * Math.sin(u);
    out[i * 3 + 2] = TORUS_TUBE * Math.sin(v);
  }
  return out;
}

// Cubo: puntos sobre las 6 caras, repartidos por índice (cara = i % 6).
// Lado 0.58: la esquina queda en ~1.0, igual que la esfera unitaria.
export const CUBE_HALF = 0.58;

export function cube(count: number, seed = 0): Float32Array {
  const total = checkCount(count);
  const out = new Float32Array(total * 3);
  const h = CUBE_HALF;
  for (let i = 0; i < total; i += 1) {
    const face = i % 6;
    const a = (hashUnit(i * 2 + 1, seed + 0.31) - 0.5) * 2 * h;
    const b = (hashUnit(i * 2 + 2, seed + 0.77) - 0.5) * 2 * h;
    let x = a;
    let y = b;
    let z = h;
    if (face === 1) z = -h;
    else if (face === 2) { x = h; y = a; z = b; }
    else if (face === 3) { x = -h; y = a; z = b; }
    else if (face === 4) { x = a; y = h; z = b; }
    else if (face === 5) { x = a; y = -h; z = b; }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

// Onda: grilla sobre el plano XY de frente, z = interferencia de dos senos.
// `phase` la anima (el renderer la avanza con el tiempo; hablando → además
// escala la amplitud con la energy real).
export const WAVE_EXTENT = 0.9;
export const WAVE_AMP = 0.24;

export function wave(count: number, phase = 0): Float32Array {
  const total = checkCount(count);
  const out = new Float32Array(total * 3);
  const n = Math.ceil(Math.sqrt(total));
  for (let i = 0; i < total; i += 1) {
    const gx = (i % n) / Math.max(1, n - 1);
    const gy = Math.floor(i / n) / Math.max(1, n - 1);
    const x = (gx - 0.5) * 2 * WAVE_EXTENT;
    const y = (gy - 0.5) * 2 * WAVE_EXTENT;
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = WAVE_AMP * Math.sin(x * 3.1 + phase) * Math.cos(y * 2.6 + phase * 0.8);
  }
  return out;
}

// Anillo de frente (círculo en XY): el estado "escuchando". El pulso lo pone
// el renderer (escala), el target es un círculo quieto con temblor mínimo.
export const RING_RADIUS = 0.8;

export function ring(count: number, seed = 0): Float32Array {
  const total = checkCount(count);
  const out = new Float32Array(total * 3);
  for (let i = 0; i < total; i += 1) {
    const t = ((i + 0.5 + (hashUnit(i * 3 + 9, seed + 0.4) - 0.5) * 0.6) / total) * TAU;
    const rad = RING_RADIUS + (hashUnit(i * 5 + 3, seed + 0.9) - 0.5) * 0.05;
    out[i * 3] = Math.cos(t) * rad;
    out[i * 3 + 1] = Math.sin(t) * rad;
    out[i * 3 + 2] = (hashUnit(i * 7 + 1, seed + 0.15) - 0.5) * 0.05;
  }
  return out;
}

// Texto rasterizado: muestrea píxeles opacos de un canvas offscreen y los
// reparte. NECESITA DOM (fuentes + canvas): en node tira error claro.
export function text(count: number, value: string): Float32Array {
  if (typeof document === 'undefined') {
    throw new Error('fx/morph text(): necesita DOM (document undefined, ej. en node)');
  }
  const label = (value || '').trim();
  if (!label) {
    throw new Error('fx/morph text(): string vacío');
  }
  const total = checkCount(count);
  const W = 160;
  const H = 56;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('fx/morph text(): sin contexto 2d');
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.min(44, Math.floor(300 / Math.max(1, label.length)))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.slice(0, 24), W / 2, H / 2 + 1);
  const data = ctx.getImageData(0, 0, W, H).data;
  const hits: number[] = [];
  for (let p = 0; p < W * H; p += 1) {
    if (data[p * 4] > 128) hits.push(p);
  }
  const out = new Float32Array(total * 3);
  if (hits.length === 0) {
    return sphere(total, label.length); // fallback: la fuente no pintó nada
  }
  const rand = mulberry32(label.length * 7919 + total);
  for (let i = 0; i < total; i += 1) {
    const p = hits[Math.floor(rand() * hits.length)];
    const px = p % W;
    const py = Math.floor(p / W);
    out[i * 3] = (px / W - 0.5) * 2 * WAVE_EXTENT;
    out[i * 3 + 1] = -(py / H - 0.5) * 2 * (WAVE_EXTENT * (H / W)) * 1.4;
    out[i * 3 + 2] = 0;
  }
  return out;
}

export type ShapeOptions = {
  seed?: number;
  phase?: number;
  text?: string;
};

// Dispatcher: el renderer pide "torus con N puntos" sin importar cada fn.
export function generateShape(shape: MorphShape, count: number, opts: ShapeOptions = {}): Float32Array {
  switch (shape) {
    case 'sphere': return sphere(count, opts.seed ?? 0);
    case 'torus': return torus(count, opts.seed ?? 0);
    case 'cube': return cube(count, opts.seed ?? 0);
    case 'wave': return wave(count, opts.phase ?? 0);
    case 'ring': return ring(count, opts.seed ?? 0);
  }
}

// ── Interpolación ──────────────────────────────────────────────────────

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

// smoothstep: arranca y frena suave (derivada 0 en ambos extremos).
export function smoothstep(t: number) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeInOutCubic(t: number) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Interpola from → to con smoothstep y escribe en `buf` (que se devuelve).
// Pura salvo por el buffer destino explícito: mismo input → mismo output.
export function morphStep(buf: Float32Array, from: Float32Array, to: Float32Array, t: number): Float32Array {
  if (from.length !== to.length || buf.length !== from.length) {
    throw new RangeError(
      `fx/morph morphStep: longitudes distintas (buf=${buf.length} from=${from.length} to=${to.length})`
    );
  }
  const s = smoothstep(t);
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = from[i] + (to[i] - from[i]) * s;
  }
  return buf;
}
