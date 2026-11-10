// ═══════════════════════════════════════════════════════════════════════
// Glyphs B: 50 name-shapes for the gesture protocol (track T2b).
//
// Each glyph is { name, tags, points }: points(count, seed) returns a flat
// Float32Array [x,y,z …] in the [-1,1] cube (same contract as fx/morph.ts),
// deterministic per seed. Pure logic: no DOM, runs in node and the webview.
//
// The Glyph type lives in glyphs-a.ts (T2a) and is imported, not redefined.
// Renderers use the combined index (glyphs-index.ts), not this file.
// spanish_snake names, ASCII (safe for the [[gesto:X]] protocol).
// ═══════════════════════════════════════════════════════════════════════

import type { Glyph } from './glyphs-a.ts';
import { mulberry32 } from './morph.ts';

type Rng = () => number;
type V3 = [number, number, number];
// Gen: one random point (with deterministic rng) from a primitive.
type Gen = (rng: Rng) => V3;
type Part = { w: number; gen: Gen };

const TAU = Math.PI * 2;
const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));
const zJit = (rng: Rng, amp = 0.03): number => (rng() - 0.5) * 2 * amp;
const P = (x: number, y: number, z: number): V3 => [clamp1(x), clamp1(y), clamp1(z)];

// ── 2D primitives (z = slight jitter) ─────────────────────────────────

const circ = (cx: number, cy: number, r: number, spread = 0): Gen => (rng) => {
  const t = rng() * TAU;
  const rr = r + (rng() - 0.5) * 2 * spread;
  return P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, zJit(rng));
};

const disc = (cx: number, cy: number, r: number): Gen => (rng) => {
  const t = rng() * TAU;
  const rr = Math.sqrt(rng()) * r;
  return P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, zJit(rng));
};

const ellO = (cx: number, cy: number, rx: number, ry: number): Gen => (rng) => {
  const t = rng() * TAU;
  return P(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, zJit(rng));
};

const ellF = (cx: number, cy: number, rx: number, ry: number): Gen => (rng) => {
  const t = rng() * TAU;
  const rr = Math.sqrt(rng());
  return P(cx + Math.cos(t) * rx * rr, cy + Math.sin(t) * ry * rr, zJit(rng));
};

const seg = (x1: number, y1: number, x2: number, y2: number, jit = 0.012): Gen => (rng) => {
  const t = rng();
  const jx = (rng() - 0.5) * 2 * jit;
  const jy = (rng() - 0.5) * 2 * jit;
  return P(x1 + (x2 - x1) * t + jx, y1 + (y2 - y1) * t + jy, zJit(rng));
};

// Polyline with point distribution proportional to each segment's length.
const path = (pts: readonly (readonly [number, number])[], jit = 0.012): Gen => {
  const segs: { x1: number; y1: number; x2: number; y2: number; len: number }[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1e-6;
    segs.push({ x1, y1, x2, y2, len });
    total += len;
  }
  const first = segs[0] ?? { x1: 0, y1: 0, x2: 0, y2: 0, len: 1 };
  return (rng) => {
    let pick = rng() * total;
    let s = first;
    for (const cand of segs) {
      pick -= cand.len;
      if (pick <= 0) {
        s = cand;
        break;
      }
    }
    const t = rng();
    const jx = (rng() - 0.5) * 2 * jit;
    const jy = (rng() - 0.5) * 2 * jit;
    return P(s.x1 + (s.x2 - s.x1) * t + jx, s.y1 + (s.y2 - s.y1) * t + jy, zJit(rng));
  };
};

const triF = (
  x1: number, y1: number, x2: number, y2: number, x3: number, y3: number
): Gen => (rng) => {
  let u = rng();
  let v = rng();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  const w = 1 - u - v;
  return P(u * x1 + v * x2 + w * x3, u * y1 + v * y2 + w * y3, zJit(rng));
};

const rectO = (cx: number, cy: number, w: number, h: number): Gen =>
  path([
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
    [cx - w / 2, cy - h / 2]
  ]);

const rectF = (cx: number, cy: number, w: number, h: number): Gen => (rng) =>
  P(cx + (rng() - 0.5) * w, cy + (rng() - 0.5) * h, zJit(rng));

const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Gen => (rng) => {
  const t = a0 + rng() * (a1 - a0);
  return P(cx + Math.cos(t) * r, cy + Math.sin(t) * r, zJit(rng));
};

const spokes = (cx: number, cy: number, r0: number, r1: number, n: number): Gen => (rng) => {
  const k = Math.floor(rng() * n);
  const t = (k / n) * TAU;
  const rr = r0 + rng() * (r1 - r0);
  return P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, zJit(rng));
};

const starO = (cx: number, cy: number, ro: number, ri: number, n: number): Gen => {
  const pts: [number, number][] = [];
  for (let k = 0; k < n * 2; k += 1) {
    const r = k % 2 === 0 ? ro : ri;
    const t = (k / (n * 2)) * TAU - Math.PI / 2;
    pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  const closed: [number, number][] = [...pts, pts[0] as [number, number]];
  return path(closed);
};

const halfDisc = (cx: number, cy: number, r: number, upper: boolean): Gen => (rng) => {
  for (let i = 0; i < 8; i += 1) {
    const t = rng() * TAU;
    const rr = Math.sqrt(rng()) * r;
    const x = cx + Math.cos(t) * rr;
    const y = cy + Math.sin(t) * rr;
    if (upper ? y >= cy : y <= cy) return P(x, y, zJit(rng));
  }
  return P(cx + r, cy, zJit(rng));
};

const crescent = (cx: number, cy: number, r: number, ox: number, oy: number, r2: number): Gen => (rng) => {
  for (let i = 0; i < 12; i += 1) {
    const t = rng() * TAU;
    const rr = Math.sqrt(rng()) * r;
    const x = cx + Math.cos(t) * rr;
    const y = cy + Math.sin(t) * rr;
    if (Math.hypot(x - (cx + ox), y - (cy + oy)) > r2) return P(x, y, zJit(rng));
  }
  return P(cx - r, cy, zJit(rng));
};

const sineRow = (
  x0: number, x1: number, y0: number, amp: number, waves: number, jit = 0.015
): Gen => (rng) => {
  const t = rng();
  return P(
    x0 + (x1 - x0) * t,
    y0 + Math.sin(t * TAU * waves) * amp + (rng() - 0.5) * 2 * jit,
    zJit(rng)
  );
};

// Bernoulli lemniscate (infinity). yScale lifts it: raw it's flat.
const lemni = (cx: number, cy: number, a: number, yScale = 1.6): Gen => (rng) => {
  const t = rng() * TAU;
  const d = 1 + Math.sin(t) * Math.sin(t);
  return P(
    cx + (a * Math.cos(t)) / d,
    cy + ((a * Math.sin(t) * Math.cos(t)) / d) * yScale,
    zJit(rng)
  );
};

const spiral = (cx: number, cy: number, r0: number, r1: number, turns: number): Gen => (rng) => {
  const t = rng();
  const rr = r0 + (r1 - r0) * t;
  const a = t * TAU * turns;
  return P(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, zJit(rng));
};

const gearO = (cx: number, cy: number, r: number, teeth: number, depth: number): Gen => (rng) => {
  const t = rng() * TAU;
  const tooth = Math.floor((t / TAU) * teeth) % 2 === 0 ? 1 : -1;
  const rr = r + tooth * depth;
  return P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr, zJit(rng));
};

// Weighted mix of generators within a single part.
const mix = (opts: readonly (readonly [number, Gen])[]): Gen => {
  const total = opts.reduce((s, [w]) => s + w, 0);
  return (rng) => {
    let pick = rng() * total;
    for (const [w, g] of opts) {
      pick -= w;
      if (pick <= 0) return g(rng);
    }
    return opts[opts.length - 1][1](rng);
  };
};

// ── Composition ─────────────────────────────────────────────────────
// Splits `count` points across parts by weight (exact split, no lost
// rounding) and seeds each part with (seed, index) so the result is
// deterministic.

function compose(parts: Part[]): (count: number, seed: number) => Float32Array {
  const total = parts.reduce((s, p) => s + p.w, 0);
  return (count: number, seed: number) => {
    const n = Math.max(1, Math.round(count));
    const out = new Float32Array(n * 3);
    const takes = parts.map((p) => Math.floor((p.w / total) * n));
    let rest = n - takes.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % takes.length, rest -= 1) {
      takes[i] += 1;
    }
    let offset = 0;
    parts.forEach((part, pi) => {
      const rng = mulberry32((((seed * 1e6) | 0) + pi * 7919 + 13) | 0);
      for (let k = 0; k < takes[pi] && offset < n; k += 1, offset += 1) {
        const [x, y, z] = part.gen(rng);
        out[offset * 3] = x;
        out[offset * 3 + 1] = y;
        out[offset * 3 + 2] = z;
      }
    });
    return out;
  };
}

const G = (name: string, tags: string[], parts: Part[]): Glyph => ({
  name,
  tags,
  points: compose(parts)
});

// ── 50 glyphs ───────────────────────────────────────────────────────
// Order: nature (7), food (6), tools (6), transport (6), sports (5),
// weather (6), music (4), tech (5), hands (3), abstract (2).

export const GLYPHS_B: Glyph[] = [
  // Nature —
  G('arbol', ['naturaleza', 'planta', 'verde'], [
    { w: 1, gen: seg(0, -0.8, 0, -0.2, 0.03) },
    {
      w: 4,
      gen: mix([
        [3, disc(0, 0.28, 0.34)],
        [2, disc(-0.24, 0.05, 0.24)],
        [2, disc(0.24, 0.05, 0.24)]
      ])
    }
  ]),
  G('pino', ['naturaleza', 'arbol', 'navidad'], [
    { w: 1, gen: seg(0, -0.8, 0, -0.35, 0.025) },
    {
      w: 4,
      gen: mix([
        [3, triF(-0.45, -0.35, 0.45, -0.35, 0, 0.15)],
        [2, triF(-0.33, -0.05, 0.33, -0.05, 0, 0.45)],
        [1, triF(-0.2, 0.2, 0.2, 0.2, 0, 0.62)]
      ])
    }
  ]),
  G('flor', ['naturaleza', 'planta', 'primavera'], [
    { w: 2, gen: disc(0, 0.2, 0.12) },
    {
      w: 3,
      gen: mix([
        [1, disc(0, 0.52, 0.15)],
        [1, disc(0.28, 0.36, 0.15)],
        [1, disc(0.28, 0.04, 0.15)],
        [1, disc(0, -0.12, 0.15)],
        [1, disc(-0.28, 0.04, 0.15)],
        [1, disc(-0.28, 0.36, 0.15)]
      ])
    },
    { w: 1, gen: seg(0, -0.27, 0, -0.85, 0.02) }
  ]),
  G('hoja', ['naturaleza', 'planta', 'otoño'], [
    { w: 2, gen: ellO(0, 0.05, 0.28, 0.5) },
    { w: 1, gen: seg(0, -0.45, 0, 0.55, 0.008) },
    { w: 1, gen: seg(0, -0.45, 0, -0.8, 0.015) }
  ]),
  G('montana', ['naturaleza', 'paisaje', 'nieve'], [
    { w: 3, gen: triF(-0.8, -0.5, 0, -0.5, -0.4, 0.55) },
    { w: 2, gen: triF(-0.1, -0.5, 0.8, -0.5, 0.35, 0.3) },
    { w: 1, gen: triF(-0.52, 0.28, -0.28, 0.28, -0.4, 0.55) },
    { w: 1, gen: seg(-0.8, -0.5, 0.8, -0.5, 0.01) }
  ]),
  G('ola_mar', ['naturaleza', 'agua', 'mar'], [
    { w: 2, gen: sineRow(-0.8, 0.8, 0.3, 0.12, 2) },
    { w: 2, gen: sineRow(-0.8, 0.8, 0, 0.12, 2) },
    { w: 2, gen: sineRow(-0.8, 0.8, -0.3, 0.12, 2) }
  ]),
  G('seta', ['naturaleza', 'hongo', 'bosque'], [
    { w: 3, gen: halfDisc(0, 0.3, 0.45, true) },
    { w: 2, gen: rectF(0, -0.25, 0.24, 0.6) },
    { w: 1, gen: mix([[1, disc(-0.18, 0.45, 0.05)], [1, disc(0.12, 0.55, 0.06)], [1, disc(0.25, 0.4, 0.04)]]) }
  ]),

  // Food —
  G('manzana', ['comida', 'fruta', 'salud'], [
    { w: 4, gen: disc(0, -0.05, 0.42) },
    { w: 1, gen: seg(0, 0.37, 0.06, 0.62, 0.015) },
    { w: 1, gen: ellF(0.2, 0.55, 0.13, 0.06) },
    { w: 1, gen: arc(-0.12, 0.05, 0.24, Math.PI * 0.55, Math.PI * 1.05) }
  ]),
  G('pizza', ['comida', 'italia', 'fiesta'], [
    { w: 4, gen: triF(0, 0.55, -0.55, -0.4, 0.55, -0.4) },
    { w: 2, gen: seg(-0.55, -0.4, 0.55, -0.4, 0.05) },
    {
      w: 2,
      gen: mix([
        [1, disc(-0.18, -0.05, 0.09)],
        [1, disc(0.15, 0.1, 0.09)],
        [1, disc(0.02, -0.22, 0.09)]
      ])
    }
  ]),
  G('mate', ['comida', 'mate', 'uruguay'], [
    { w: 3, gen: ellF(0, -0.18, 0.32, 0.38) },
    { w: 1, gen: ellO(0, 0.18, 0.28, 0.1) },
    { w: 1, gen: seg(0.04, 0.18, 0.3, 0.72, 0.015) },
    { w: 1, gen: disc(0.3, 0.74, 0.04) }
  ]),
  G('copa', ['comida', 'vino', 'brindis'], [
    { w: 3, gen: halfDisc(0, 0.45, 0.3, false) },
    { w: 1, gen: seg(-0.2, 0.38, 0.2, 0.38, 0.01) },
    { w: 1, gen: seg(0, 0.15, 0, -0.45, 0.015) },
    { w: 1, gen: seg(-0.25, -0.45, 0.25, -0.45, 0.015) }
  ]),
  G('helado', ['comida', 'postre', 'verano'], [
    { w: 2, gen: triF(-0.25, -0.05, 0.25, -0.05, 0, -0.7) },
    { w: 3, gen: disc(0, 0.28, 0.32) },
    { w: 1, gen: disc(0, 0.62, 0.07) }
  ]),
  G('dona', ['comida', 'postre', 'dulce'], [
    { w: 5, gen: circ(0, 0, 0.42, 0.13) },
    {
      w: 1,
      gen: mix([
        [1, disc(-0.2, 0.35, 0.035)],
        [1, disc(0.25, 0.2, 0.035)],
        [1, disc(-0.35, -0.1, 0.035)],
        [1, disc(0.1, -0.4, 0.035)],
        [1, disc(0.4, -0.15, 0.035)]
      ])
    }
  ]),

  // Tools —
  G('martillo', ['herramienta', 'construccion', 'golpe'], [
    { w: 2, gen: seg(0, -0.7, 0, 0.25, 0.03) },
    { w: 3, gen: rectF(0, 0.48, 0.7, 0.34) }
  ]),
  G('destornillador', ['herramienta', 'taller', 'reparacion'], [
    { w: 2, gen: rectF(0, -0.55, 0.24, 0.4) },
    { w: 3, gen: seg(0, -0.35, 0, 0.5, 0.02) },
    { w: 1, gen: seg(-0.08, 0.52, 0.08, 0.52, 0.02) }
  ]),
  G('tuerca', ['herramienta', 'metal', 'taller'], [
    { w: 3, gen: starO(0, 0, 0.45, 0.45, 6) },
    { w: 2, gen: circ(0, 0, 0.2) }
  ]),
  G('clavo', ['herramienta', 'metal', 'construccion'], [
    { w: 3, gen: seg(0, -0.55, 0, 0.5, 0.02) },
    { w: 1, gen: seg(-0.18, 0.5, 0.18, 0.5, 0.02) },
    { w: 1, gen: path([[-0.03, -0.55], [0, -0.72], [0.03, -0.55]]) }
  ]),
  G('pincel', ['herramienta', 'arte', 'pintura'], [
    { w: 2, gen: seg(0, -0.7, 0, 0.15, 0.025) },
    { w: 1, gen: rectO(0, 0.28, 0.22, 0.2) },
    { w: 2, gen: triF(-0.11, 0.38, 0.11, 0.38, 0, 0.72) }
  ]),
  G('engranaje', ['herramienta', 'maquina', 'sistema'], [
    { w: 4, gen: gearO(0, 0, 0.5, 16, 0.1) },
    { w: 2, gen: circ(0, 0, 0.2) },
    { w: 1, gen: spokes(0, 0, 0.2, 0.42, 4) }
  ]),

  // Transport —
  G('auto', ['transporte', 'vehiculo', 'calle'], [
    { w: 2, gen: rectO(0, -0.12, 1.3, 0.44) },
    { w: 2, gen: path([[-0.35, 0.1], [-0.2, 0.46], [0.25, 0.46], [0.4, 0.1]]) },
    { w: 2, gen: mix([[1, circ(-0.4, -0.44, 0.16)], [1, circ(0.4, -0.44, 0.16)]]) }
  ]),
  G('bicicleta', ['transporte', 'deporte', 'calle'], [
    { w: 3, gen: mix([[1, circ(-0.42, -0.2, 0.32)], [1, circ(0.42, -0.2, 0.32)]]) },
    { w: 2, gen: path([[-0.42, -0.2], [0, 0.28], [0.42, -0.2]]) },
    { w: 1, gen: mix([[1, seg(-0.1, 0.28, 0.1, 0.28, 0.01)], [1, seg(0.42, -0.2, 0.5, 0.15, 0.01)]]) }
  ]),
  G('avion', ['transporte', 'vuelo', 'viaje'], [
    { w: 3, gen: seg(-0.7, -0.05, 0.7, -0.05, 0.03) },
    { w: 2, gen: triF(-0.1, -0.05, 0.28, -0.05, -0.02, 0.45) },
    { w: 1, gen: triF(-0.7, -0.05, -0.48, -0.05, -0.62, 0.28) },
    { w: 1, gen: triF(-0.05, -0.08, 0.3, -0.08, 0.05, -0.4) }
  ]),
  G('barco', ['transporte', 'mar', 'viaje'], [
    { w: 2, gen: path([[-0.6, 0.05], [-0.35, -0.38], [0.35, -0.38], [0.6, 0.05]]) },
    { w: 1, gen: seg(0, 0.05, 0, 0.62, 0.015) },
    { w: 2, gen: triF(0.04, 0.08, 0.04, 0.58, 0.46, 0.08) },
    { w: 1, gen: sineRow(-0.7, 0.7, -0.55, 0.07, 3) }
  ]),
  G('cohete', ['transporte', 'espacio', 'futuro'], [
    { w: 3, gen: ellF(0, 0.08, 0.2, 0.48) },
    { w: 1, gen: disc(0, 0.22, 0.08) },
    {
      w: 1,
      gen: mix([
        [1, triF(-0.18, -0.2, -0.36, -0.55, -0.18, -0.45)],
        [1, triF(0.18, -0.2, 0.36, -0.55, 0.18, -0.45)]
      ])
    },
    { w: 1, gen: triF(-0.1, -0.4, 0.1, -0.4, 0, -0.8) }
  ]),
  G('ancla', ['transporte', 'mar', 'puerto'], [
    { w: 2, gen: seg(0, -0.3, 0, 0.58, 0.02) },
    { w: 1, gen: circ(0, 0.68, 0.1) },
    { w: 1, gen: seg(-0.3, 0.38, 0.3, 0.38, 0.015) },
    { w: 2, gen: arc(0, -0.02, 0.4, Math.PI * 1.1, Math.PI * 1.9) },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.4, -0.16, -0.28, 0.02, 0.015)],
        [1, seg(0.4, -0.16, 0.28, 0.02, 0.015)]
      ])
    }
  ]),

  // Sports —
  G('pelota', ['deporte', 'futbol', 'juego'], [
    { w: 3, gen: circ(0, 0, 0.5) },
    { w: 1, gen: circ(0, 0, 0.13) },
    { w: 2, gen: spokes(0, 0, 0.13, 0.5, 5) }
  ]),
  G('trofeo', ['deporte', 'premio', 'victoria'], [
    { w: 2, gen: path([[-0.25, 0.6], [-0.25, 0.12], [0, 0.05], [0.25, 0.12], [0.25, 0.6]]) },
    {
      w: 1,
      gen: mix([
        [1, arc(-0.25, 0.36, 0.14, Math.PI * 0.5, Math.PI * 1.5)],
        [1, arc(0.25, 0.36, 0.14, -Math.PI * 0.5, Math.PI * 0.5)]
      ])
    },
    { w: 1, gen: seg(0, 0.05, 0, -0.35, 0.02) },
    { w: 1, gen: seg(-0.25, -0.35, 0.25, -0.35, 0.025) },
    { w: 1, gen: seg(-0.18, -0.48, 0.18, -0.48, 0.025) }
  ]),
  G('medalla', ['deporte', 'premio', 'honor'], [
    { w: 3, gen: circ(0, -0.18, 0.3) },
    { w: 1, gen: starO(0, -0.18, 0.15, 0.06, 5) },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.13, 0.08, -0.26, 0.62, 0.015)],
        [1, seg(0.13, 0.08, 0.26, 0.62, 0.015)]
      ])
    }
  ]),
  G('raqueta', ['deporte', 'tenis', 'juego'], [
    { w: 2, gen: ellO(0, 0.28, 0.32, 0.4) },
    {
      w: 2,
      gen: mix([
        [1, seg(-0.2, 0.28, 0.2, 0.28, 0.006)],
        [1, seg(-0.24, 0.42, 0.24, 0.42, 0.006)],
        [1, seg(-0.24, 0.14, 0.24, 0.14, 0.006)],
        [1, seg(0, -0.08, 0, 0.64, 0.006)],
        [1, seg(-0.14, 0.0, -0.14, 0.56, 0.006)],
        [1, seg(0.14, 0.0, 0.14, 0.56, 0.006)]
      ])
    },
    { w: 1, gen: seg(0, -0.12, 0, -0.72, 0.03) }
  ]),
  G('pesa', ['deporte', 'fuerza', 'gym'], [
    { w: 1, gen: seg(-0.62, 0, 0.62, 0, 0.02) },
    {
      w: 3,
      gen: mix([
        [1, seg(-0.5, -0.32, -0.5, 0.32, 0.03)],
        [1, seg(-0.36, -0.24, -0.36, 0.24, 0.03)],
        [1, seg(0.36, -0.24, 0.36, 0.24, 0.03)],
        [1, seg(0.5, -0.32, 0.5, 0.32, 0.03)]
      ])
    }
  ]),

  // Weather —
  G('sol', ['clima', 'dia', 'calor'], [
    { w: 3, gen: disc(0, 0, 0.3) },
    { w: 3, gen: spokes(0, 0, 0.4, 0.66, 8) }
  ]),
  G('luna', ['clima', 'noche', 'sueño'], [
    { w: 5, gen: crescent(0, 0, 0.5, 0.28, 0.14, 0.42) },
    { w: 1, gen: starO(0.52, -0.42, 0.1, 0.04, 5) }
  ]),
  G('nube', ['clima', 'cielo', 'lluvia'], [
    {
      w: 5,
      gen: mix([
        [2, disc(-0.3, -0.02, 0.25)],
        [3, disc(0, 0.12, 0.32)],
        [2, disc(0.3, -0.02, 0.25)]
      ])
    },
    { w: 1, gen: seg(-0.48, -0.24, 0.48, -0.24, 0.02) }
  ]),
  G('gota', ['clima', 'agua', 'lluvia'], [
    { w: 3, gen: disc(0, -0.12, 0.32) },
    { w: 2, gen: triF(-0.27, 0.02, 0.27, 0.02, 0, 0.66) }
  ]),
  G('rayo', ['clima', 'tormenta', 'energia'], [
    { w: 5, gen: path([[0.18, 0.72], [-0.2, 0.05], [0.05, 0.05], [-0.15, -0.72]], 0.03) }
  ]),
  G('copo', ['clima', 'nieve', 'invierno'], [
    { w: 3, gen: spokes(0, 0, 0.06, 0.62, 6) },
    { w: 1, gen: circ(0, 0, 0.08) },
    {
      w: 2,
      gen: mix([
        [1, seg(-0.31, 0.18, -0.2, 0.24, 0.008)],
        [1, seg(-0.31, 0.18, -0.26, 0.06, 0.008)],
        [1, seg(0.31, 0.18, 0.2, 0.24, 0.008)],
        [1, seg(0.31, 0.18, 0.26, 0.06, 0.008)],
        [1, seg(0, -0.36, -0.09, -0.26, 0.008)],
        [1, seg(0, -0.36, 0.09, -0.26, 0.008)],
        [1, seg(-0.31, -0.18, -0.2, -0.24, 0.008)],
        [1, seg(0.31, -0.18, 0.2, -0.24, 0.008)],
        [1, seg(0, 0.36, -0.09, 0.26, 0.008)],
        [1, seg(0, 0.36, 0.09, 0.26, 0.008)]
      ])
    }
  ]),

  // Music —
  G('nota', ['musica', 'cancion', 'sonido'], [
    { w: 2, gen: ellF(0.12, -0.38, 0.18, 0.13) },
    { w: 2, gen: seg(0.29, -0.33, 0.29, 0.5, 0.015) },
    { w: 1, gen: path([[0.29, 0.5], [0.08, 0.38], [0.02, 0.18]], 0.015) }
  ]),
  G('tambor', ['musica', 'ritmo', 'percusion'], [
    { w: 2, gen: ellO(0, 0.3, 0.45, 0.15) },
    {
      w: 2,
      gen: mix([
        [1, seg(-0.45, 0.3, -0.45, -0.3, 0.012)],
        [1, seg(0.45, 0.3, 0.45, -0.3, 0.012)]
      ])
    },
    { w: 1, gen: ellO(0, -0.3, 0.45, 0.15) },
    { w: 1, gen: path([[-0.45, 0.1], [-0.22, -0.1], [0, 0.1], [0.22, -0.1], [0.45, 0.1]], 0.01) },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.3, 0.42, -0.15, 0.68, 0.012)],
        [1, seg(0.3, 0.42, 0.15, 0.68, 0.012)],
        [1, disc(-0.15, 0.7, 0.04)],
        [1, disc(0.15, 0.7, 0.04)]
      ])
    }
  ]),
  G('guitarra', ['musica', 'cuerdas', 'rock'], [
    { w: 2, gen: disc(0, -0.36, 0.28) },
    { w: 1, gen: disc(0, 0.02, 0.19) },
    { w: 1, gen: disc(0, -0.32, 0.07) },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.05, 0.15, -0.05, 0.62, 0.008)],
        [1, seg(0.05, 0.15, 0.05, 0.62, 0.008)]
      ])
    },
    { w: 1, gen: rectO(0, 0.7, 0.18, 0.14) }
  ]),
  G('parlante', ['musica', 'sonido', 'audio'], [
    { w: 2, gen: rectO(-0.1, 0, 0.62, 1.0) },
    { w: 2, gen: circ(-0.1, -0.18, 0.19) },
    { w: 1, gen: circ(-0.1, 0.28, 0.1) },
    {
      w: 1,
      gen: mix([
        [1, arc(0.35, 0, 0.18, -Math.PI / 3, Math.PI / 3)],
        [1, arc(0.35, 0, 0.32, -Math.PI / 3, Math.PI / 3)]
      ])
    }
  ]),

  // Tech —
  G('chip', ['tech', 'cpu', 'hardware'], [
    { w: 2, gen: rectO(0, 0, 0.5, 0.5) },
    { w: 1, gen: rectO(0, 0, 0.2, 0.2) },
    {
      w: 2,
      gen: mix([
        [1, seg(-0.15, 0.25, -0.15, 0.5, 0.01)],
        [1, seg(0, 0.25, 0, 0.5, 0.01)],
        [1, seg(0.15, 0.25, 0.15, 0.5, 0.01)],
        [1, seg(-0.15, -0.25, -0.15, -0.5, 0.01)],
        [1, seg(0, -0.25, 0, -0.5, 0.01)],
        [1, seg(0.15, -0.25, 0.15, -0.5, 0.01)],
        [1, seg(-0.25, -0.15, -0.5, -0.15, 0.01)],
        [1, seg(-0.25, 0, -0.5, 0, 0.01)],
        [1, seg(-0.25, 0.15, -0.5, 0.15, 0.01)],
        [1, seg(0.25, -0.15, 0.5, -0.15, 0.01)],
        [1, seg(0.25, 0, 0.5, 0, 0.01)],
        [1, seg(0.25, 0.15, 0.5, 0.15, 0.01)]
      ])
    }
  ]),
  G('antena', ['tech', 'radio', 'señal'], [
    {
      w: 2,
      gen: mix([
        [1, seg(-0.3, -0.6, 0, 0.5, 0.015)],
        [1, seg(0.3, -0.6, 0, 0.5, 0.015)]
      ])
    },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.2, -0.28, 0.2, -0.28, 0.01)],
        [1, seg(-0.12, 0.02, 0.12, 0.02, 0.01)],
        [1, seg(-0.06, 0.28, 0.06, 0.28, 0.01)]
      ])
    },
    {
      w: 1,
      gen: mix([
        [1, arc(0, 0.5, 0.2, Math.PI * 0.15, Math.PI * 0.85)],
        [1, arc(0, 0.5, 0.36, Math.PI * 0.15, Math.PI * 0.85)]
      ])
    },
    { w: 1, gen: disc(0, 0.56, 0.045) }
  ]),
  G('satelite', ['tech', 'espacio', 'comunicacion'], [
    { w: 2, gen: rectO(0, 0, 0.3, 0.3) },
    {
      w: 2,
      gen: mix([
        [1, rectO(-0.52, 0, 0.38, 0.55)],
        [1, rectO(0.52, 0, 0.38, 0.55)]
      ])
    },
    {
      w: 1,
      gen: mix([
        [1, seg(-0.33, 0, -0.15, 0, 0.015)],
        [1, seg(0.15, 0, 0.33, 0, 0.015)],
        [1, seg(-0.52, -0.1, -0.52, 0.1, 0.008)],
        [1, seg(0.52, -0.1, 0.52, 0.1, 0.008)]
      ])
    },
    { w: 1, gen: arc(0, -0.32, 0.14, Math.PI * 1.1, Math.PI * 1.9) }
  ]),
  G('robot', ['tech', 'ia', 'futuro'], [
    { w: 2, gen: rectO(0, 0.18, 0.6, 0.5) },
    {
      w: 1,
      gen: mix([
        [1, disc(-0.15, 0.24, 0.06)],
        [1, disc(0.15, 0.24, 0.06)]
      ])
    },
    { w: 1, gen: seg(-0.12, 0.02, 0.12, 0.02, 0.015) },
    { w: 1, gen: seg(0, 0.43, 0, 0.66, 0.012) },
    { w: 1, gen: disc(0, 0.7, 0.045) },
    { w: 1, gen: rectO(0, -0.5, 0.8, 0.3) }
  ]),
  G('bateria', ['tech', 'energia', 'carga'], [
    { w: 3, gen: rectO(-0.05, 0, 0.7, 0.4) },
    { w: 1, gen: rectO(0.4, 0, 0.1, 0.18) },
    {
      w: 2,
      gen: mix([
        [1, seg(-0.25, -0.12, -0.25, 0.12, 0.02)],
        [1, seg(-0.1, -0.12, -0.1, 0.12, 0.02)],
        [1, seg(0.05, -0.12, 0.05, 0.12, 0.02)]
      ])
    }
  ]),

  // Hands —
  G('dedos_cruzados', ['mano', 'suerte', 'deseo'], [
    { w: 3, gen: disc(0, -0.32, 0.28) },
    { w: 2, gen: seg(-0.05, -0.08, -0.05, 0.5, 0.025) },
    { w: 2, gen: seg(-0.22, 0.28, 0.12, 0.16, 0.025) },
    { w: 1, gen: seg(0.2, -0.25, 0.32, 0.0, 0.025) }
  ]),
  G('saludo_vulcano', ['mano', 'saludo', 'scifi'], [
    { w: 2, gen: disc(0, -0.32, 0.26) },
    {
      w: 4,
      gen: mix([
        [1, seg(-0.14, -0.1, -0.3, 0.48, 0.022)],
        [1, seg(-0.05, -0.06, -0.12, 0.56, 0.022)],
        [1, seg(0.05, -0.06, 0.12, 0.56, 0.022)],
        [1, seg(0.14, -0.1, 0.3, 0.48, 0.022)]
      ])
    },
    { w: 1, gen: seg(0.2, -0.28, 0.38, -0.06, 0.022) }
  ]),
  G('mano_rock', ['mano', 'rock', 'musica'], [
    { w: 3, gen: disc(0, -0.28, 0.26) },
    { w: 1, gen: disc(0, -0.05, 0.13) },
    { w: 2, gen: seg(-0.15, -0.08, -0.24, 0.5, 0.025) },
    { w: 2, gen: seg(0.15, -0.08, 0.26, 0.46, 0.025) }
  ]),

  // Abstract —
  G('mandala', ['simbolo', 'calma', 'arte'], [
    { w: 2, gen: circ(0, 0, 0.52) },
    { w: 2, gen: circ(0, 0, 0.32) },
    { w: 2, gen: spokes(0, 0, 0.32, 0.52, 12) },
    { w: 1, gen: disc(0, 0, 0.08) }
  ]),
  G('espiral', ['simbolo', 'crecimiento', 'galaxia'], [
    { w: 5, gen: spiral(0, 0, 0.04, 0.72, 3) }
  ])
];
