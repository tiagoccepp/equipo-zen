// ═══════════════════════════════════════════════════════════════════════
// Glyphs A: 1/2 repertoire of the gesture engine (T2a, Phase 2).
//
// PURE logic: no DOM, no canvas, no imports (zero dependencies so node
// imports it directly in tests via type-stripping and vite bundles it
// without cycles). Erasable syntax only (tsconfig requires it).
//
// Point contract (same as fx/morph.ts): flat Float32Array [x,y,z, …],
// each axis in [-1,1]. Deterministic: same (count, seed) → same points.
// The renderer scales them by the slot radius.
//
// T2b coordination: this file defines the `interface Glyph` (single one).
// glyphs-b.ts imports the type from here (does NOT redefine it) and
// glyphs-index.ts combines A+B and calls `registerExtraGlyphs(GLYPHS_B)`
// at load. Renderers (orb-morph/orb3d) use `lookupGlyph` from THIS file,
// which already queries A + registered extras. Main must import the index in app.ts.
// ═══════════════════════════════════════════════════════════════════════

export interface Glyph {
  name: string;
  tags: string[];
  points: (count: number, seed: number) => Float32Array;
}

const TAU = Math.PI * 2;

type Rng = () => number;
type Pt2 = [number, number];

// ── Deterministic random (local copy: zero imports on purpose) ─────

function hashStr(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Name normalization (mirror of server/lib/gestos.js) ──────────
// Lowercase + no accents/ñ→n + spaces→underscore. "GUIÑO", "guino" and
// "Guiño" all resolve to the `guiño` glyph.

export function foldGlyphName(name: string): string {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

// ── Sampling primitives (everything pushes n*3 numbers into `out`) ───

// Splits `count` across weights with exact remainder (the sum GIVES count).
function split(count: number, weights: number[]): number[] {
  const total = Math.max(0, Math.round(count));
  if (total === 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - out.reduce((a, b) => a + b, 0);
  let i = 0;
  while (rest > 0) {
    out[i % out.length] += 1;
    rest -= 1;
    i += 1;
  }
  return out;
}

// Applies [weight, fill] over the total count.
function parts(out: number[], rng: Rng, count: number, defs: Array<[number, (n: number) => void]>): void {
  const counts = split(count, defs.map((d) => d[0]));
  defs.forEach((d, i) => d[1](counts[i] ?? 0));
}

function seg(out: number[], rng: Rng, x1: number, y1: number, x2: number, y2: number, n: number, j = 0.012): void {
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push(
      x1 + (x2 - x1) * t + (rng() - 0.5) * 2 * j,
      y1 + (y2 - y1) * t + (rng() - 0.5) * 2 * j,
      (rng() - 0.5) * 2 * j
    );
  }
}

function poly(out: number[], rng: Rng, pts: Pt2[], n: number, j = 0.012, closed = false): void {
  if (pts.length < 2 || n === 0) return;
  const seq: Pt2[] = closed ? [...pts, pts[0] as Pt2] : pts;
  const lens: number[] = [];
  for (let i = 0; i + 1 < seq.length; i += 1) {
    const a = seq[i] as Pt2;
    const b = seq[i + 1] as Pt2;
    lens.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const counts = split(n, lens);
  for (let i = 0; i + 1 < seq.length; i += 1) {
    const a = seq[i] as Pt2;
    const b = seq[i + 1] as Pt2;
    seg(out, rng, a[0], a[1], b[0], b[1], counts[i] ?? 0, j);
  }
}

function arc(out: number[], rng: Rng, cx: number, cy: number, r: number, a0: number, a1: number, n: number, j = 0.012): void {
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = a0 + (a1 - a0) * t;
    out.push(
      cx + Math.cos(a) * r + (rng() - 0.5) * 2 * j,
      cy + Math.sin(a) * r + (rng() - 0.5) * 2 * j,
      (rng() - 0.5) * 2 * j
    );
  }
}

function circ(out: number[], rng: Rng, cx: number, cy: number, r: number, n: number, j = 0.012): void {
  arc(out, rng, cx, cy, r, 0, TAU, n, j);
}

function ellip(out: number[], rng: Rng, cx: number, cy: number, rx: number, ry: number, n: number, j = 0.012): void {
  for (let i = 0; i < n; i += 1) {
    const a = (i / Math.max(1, n)) * TAU;
    out.push(
      cx + Math.cos(a) * rx + (rng() - 0.5) * 2 * j,
      cy + Math.sin(a) * ry + (rng() - 0.5) * 2 * j,
      (rng() - 0.5) * 2 * j
    );
  }
}

function disc(out: number[], rng: Rng, cx: number, cy: number, r: number, n: number, j = 0.02): void {
  for (let i = 0; i < n; i += 1) {
    const a = rng() * TAU;
    const rr = r * Math.sqrt(rng());
    out.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, (rng() - 0.5) * 2 * j);
  }
}

function dot(out: number[], rng: Rng, cx: number, cy: number, cz: number, n: number, s = 0.05): void {
  for (let i = 0; i < n; i += 1) {
    out.push(
      cx + (rng() + rng() + rng() - 1.5) * s,
      cy + (rng() + rng() + rng() - 1.5) * s,
      cz + (rng() + rng() + rng() - 1.5) * s * 0.5
    );
  }
}

function blob3(out: number[], rng: Rng, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const u = rng() * 2 - 1;
    const a = rng() * TAU;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const rr = Math.cbrt(rng());
    out.push(cx + s * Math.cos(a) * rr * rx, cy + u * rr * ry, cz + s * Math.sin(a) * rr * rz);
  }
}

function heart(out: number[], rng: Rng, cx: number, cy: number, s: number, n: number, j = 0.012): void {
  for (let i = 0; i < n; i += 1) {
    const t = (i / Math.max(1, n)) * TAU;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    out.push(
      cx + (x / 17) * s + (rng() - 0.5) * 2 * j,
      cy + (y / 17) * s + (rng() - 0.5) * 2 * j,
      (rng() - 0.5) * 2 * j
    );
  }
}

function star5(out: number[], rng: Rng, cx: number, cy: number, r: number, n: number, j = 0.012): void {
  const pts: Pt2[] = [];
  for (let k = 0; k < 10; k += 1) {
    const rr = k % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  poly(out, rng, pts, n, j, true);
}

function lemni(out: number[], rng: Rng, cx: number, cy: number, s: number, n: number, j = 0.012): void {
  for (let i = 0; i < n; i += 1) {
    const t = (i / Math.max(1, n)) * TAU;
    const d = 1 + Math.sin(t) * Math.sin(t);
    out.push(
      cx + (s * Math.cos(t)) / d + (rng() - 0.5) * 2 * j,
      cy + (s * Math.sin(t) * Math.cos(t)) / d + (rng() - 0.5) * 2 * j,
      (rng() - 0.5) * 2 * j
    );
  }
}

// Radial rays (lamp, sun): n is split across the given angles.
function rays(out: number[], rng: Rng, cx: number, cy: number, r0: number, r1: number, angles: number[], n: number, j = 0.01): void {
  const counts = split(n, angles.map(() => 1));
  angles.forEach((a, i) => {
    seg(out, rng, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, counts[i] ?? 0, j);
  });
}

// ── Factory ─────────────────────────────────────────────────────────

function makeGlyph(name: string, tags: string[], draw: (out: number[], rng: Rng, count: number) => void): Glyph {
  const salt = hashStr(name);
  return {
    name,
    tags,
    points: (count: number, seed: number): Float32Array => {
      const total = Math.max(1, Math.round(count));
      if (!Number.isFinite(total)) {
        throw new RangeError(`fx/glyphs-a ${name}: invalid count (${count})`);
      }
      const rng = mulberry32(((seed | 0) ^ salt) | 0);
      const out: number[] = [];
      draw(out, rng, total);
      const arr = new Float32Array(total * 3);
      for (let i = 0; i < total * 3; i += 1) {
        const v = i < out.length ? (out[i] as number) : 0;
        arr[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      return arr;
    }
  };
}

// ── 50 glyphs (spanish_snake names, unique in A; see T2a report) ─────
// Families: 12 hands · 10 faces · 12 symbols · 10 objects · 6 letters.

export const GLYPHS_A: Glyph[] = [
  // — Hands —
  makeGlyph('saludar', ['mano', 'gesto', 'hola'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => disc(out, rng, 0, -0.35, 0.28, n)],
      [3, (n) => {
        const cs = split(n, [1, 1, 1, 1]);
        seg(out, rng, -0.18, -0.18, -0.32, 0.5, cs[0] ?? 0);
        seg(out, rng, -0.06, -0.15, -0.1, 0.58, cs[1] ?? 0);
        seg(out, rng, 0.06, -0.15, 0.12, 0.58, cs[2] ?? 0);
        seg(out, rng, 0.18, -0.18, 0.34, 0.5, cs[3] ?? 0);
      }],
      [1, (n) => seg(out, rng, 0.2, -0.35, 0.52, -0.08, n)]
    ]);
  }),
  makeGlyph('aplaudir', ['mano', 'gesto', 'festejo'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => disc(out, rng, -0.32, -0.05, 0.26, n)],
      [2, (n) => disc(out, rng, 0.32, -0.05, 0.26, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        arc(out, rng, -0.32, -0.05, 0.44, Math.PI * 0.55, Math.PI * 1.45, cs[0] ?? 0);
        arc(out, rng, 0.32, -0.05, 0.44, -Math.PI * 0.45, Math.PI * 0.45, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('pulgar_arriba', ['mano', 'gesto', 'ok', 'bien'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => blob3(out, rng, 0, -0.32, 0, 0.36, 0.3, 0.24, n)],
      [2, (n) => {
        const cs = split(n, [1, 1]);
        seg(out, rng, 0.04, -0.15, 0.08, 0.55, cs[0] ?? 0);
        seg(out, rng, 0.16, -0.15, 0.2, 0.55, cs[1] ?? 0);
      }],
      [1, (n) => dot(out, rng, 0.14, 0.62, 0, n, 0.06)]
    ]);
  }),
  makeGlyph('paz', ['mano', 'gesto', 'victoria'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => seg(out, rng, -0.02, -0.35, -0.28, 0.52, n)],
      [2, (n) => seg(out, rng, -0.02, -0.35, 0.28, 0.52, n)],
      [1, (n) => disc(out, rng, 0, -0.5, 0.18, n)]
    ]);
  }),
  makeGlyph('puno', ['mano', 'gesto', 'fuerza'], (out, rng, count) => {
    parts(out, rng, count, [
      [4, (n) => blob3(out, rng, 0, -0.08, 0, 0.45, 0.4, 0.3, n)],
      [1, (n) => {
        const cs = split(n, [1, 1, 1, 1]);
        dot(out, rng, -0.27, 0.3, 0, cs[0] ?? 0, 0.055);
        dot(out, rng, -0.09, 0.34, 0, cs[1] ?? 0, 0.055);
        dot(out, rng, 0.09, 0.34, 0, cs[2] ?? 0, 0.055);
        dot(out, rng, 0.27, 0.3, 0, cs[3] ?? 0, 0.055);
      }]
    ]);
  }),
  makeGlyph('mano_abierta', ['mano', 'gesto', 'alto'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => disc(out, rng, 0, -0.28, 0.3, n)],
      [4, (n) => {
        const cs = split(n, [1, 1, 1, 1, 1]);
        seg(out, rng, -0.22, -0.1, -0.42, 0.4, cs[0] ?? 0);
        seg(out, rng, -0.11, -0.05, -0.2, 0.56, cs[1] ?? 0);
        seg(out, rng, 0, -0.03, 0, 0.6, cs[2] ?? 0);
        seg(out, rng, 0.11, -0.05, 0.2, 0.56, cs[3] ?? 0);
        seg(out, rng, 0.22, -0.1, 0.42, 0.4, cs[4] ?? 0);
      }]
    ]);
  }),
  makeGlyph('senalar', ['mano', 'gesto', 'indicar'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => disc(out, rng, 0, -0.42, 0.26, n)],
      [2, (n) => seg(out, rng, 0.02, -0.2, 0.05, 0.6, n)],
      [1, (n) => dot(out, rng, 0.05, 0.72, 0, n, 0.05)]
    ]);
  }),
  makeGlyph('ok_mano', ['mano', 'gesto', 'ok', 'bien'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => circ(out, rng, 0, -0.15, 0.28, n)],
      [2, (n) => {
        const cs = split(n, [1, 1, 1]);
        seg(out, rng, -0.1, 0.1, -0.18, 0.6, cs[0] ?? 0);
        seg(out, rng, 0, 0.13, 0, 0.65, cs[1] ?? 0);
        seg(out, rng, 0.1, 0.1, 0.18, 0.6, cs[2] ?? 0);
      }]
    ]);
  }),
  makeGlyph('abrazo', ['gesto', 'carino', 'apoyo'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => arc(out, rng, -0.42, 0, 0.5, -1.2, 1.2, n)],
      [2, (n) => arc(out, rng, 0.42, 0, 0.5, Math.PI - 1.2, Math.PI + 1.2, n)],
      [1, (n) => dot(out, rng, 0, 0, 0, n, 0.08)]
    ]);
  }),
  makeGlyph('chocar_las_cinco', ['mano', 'gesto', 'festejo'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => disc(out, rng, -0.48, 0, 0.24, n)],
      [2, (n) => {
        const cs = split(n, [1, 1, 1, 1, 1]);
        const ys = [-0.2, -0.1, 0, 0.1, 0.2];
        ys.forEach((y, i) => seg(out, rng, -0.24, y, 0.12, y, cs[i] ?? 0));
      }],
      [1, (n) => star5(out, rng, 0.52, 0, 0.18, n)]
    ]);
  }),
  makeGlyph('adios', ['mano', 'gesto', 'chau'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => disc(out, rng, 0, -0.35, 0.28, n)],
      [3, (n) => {
        const cs = split(n, [1, 1, 1, 1]);
        seg(out, rng, 0.18, -0.18, 0.32, 0.5, cs[0] ?? 0);
        seg(out, rng, 0.06, -0.15, 0.1, 0.58, cs[1] ?? 0);
        seg(out, rng, -0.06, -0.15, -0.12, 0.58, cs[2] ?? 0);
        seg(out, rng, -0.18, -0.18, -0.34, 0.5, cs[3] ?? 0);
      }],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        arc(out, rng, -0.5, 0.1, 0.2, -0.9, 0.9, cs[0] ?? 0);
        arc(out, rng, -0.5, 0.1, 0.34, -0.9, 0.9, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('contar', ['mano', 'gesto', 'numero'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, -0.4, -0.5, 0.4, -0.5, n)],
      [1, (n) => seg(out, rng, -0.2, -0.45, -0.2, 0.3, n)],
      [1, (n) => seg(out, rng, 0, -0.45, 0, 0.5, n)],
      [1, (n) => seg(out, rng, 0.2, -0.45, 0.2, 0.4, n)]
    ]);
  }),

  // — Faces —
  makeGlyph('sonrisa', ['cara', 'feliz', 'alegria'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => arc(out, rng, 0, -0.05, 0.38, Math.PI * 1.15, Math.PI * 1.85, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.25, 0.2, 0, cs[0] ?? 0, 0.055);
        dot(out, rng, 0.25, 0.2, 0, cs[1] ?? 0, 0.055);
      }]
    ]);
  }),
  makeGlyph('risa', ['cara', 'feliz', 'jaja'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => arc(out, rng, 0, -0.08, 0.42, Math.PI * 1.1, Math.PI * 1.9, n)],
      [1, (n) => disc(out, rng, 0, -0.3, 0.13, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        arc(out, rng, -0.25, 0.22, 0.1, Math.PI * 0.15, Math.PI * 0.85, cs[0] ?? 0);
        arc(out, rng, 0.25, 0.22, 0.1, Math.PI * 0.15, Math.PI * 0.85, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('guino', ['cara', 'gesto', 'picardia'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [1, (n) => dot(out, rng, -0.25, 0.2, 0, n, 0.055)],
      [1, (n) => seg(out, rng, 0.13, 0.2, 0.37, 0.2, n)],
      [2, (n) => arc(out, rng, 0, -0.1, 0.3, Math.PI * 1.2, Math.PI * 1.8, n)]
    ]);
  }),
  makeGlyph('sorpresa', ['cara', 'asombro', 'wow'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => circ(out, rng, 0, -0.3, 0.16, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.25, 0.22, 0, cs[0] ?? 0, 0.09);
        dot(out, rng, 0.25, 0.22, 0, cs[1] ?? 0, 0.09);
      }]
    ]);
  }),
  makeGlyph('tristeza', ['cara', 'triste', 'pena'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => arc(out, rng, 0, -0.62, 0.4, Math.PI * 0.15, Math.PI * 0.85, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.25, 0.2, 0, cs[0] ?? 0, 0.055);
        dot(out, rng, 0.25, 0.2, 0, cs[1] ?? 0, 0.055);
      }]
    ]);
  }),
  makeGlyph('enojo', ['cara', 'enojado', 'furia'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        seg(out, rng, -0.42, 0.46, -0.1, 0.3, cs[0] ?? 0);
        seg(out, rng, 0.42, 0.46, 0.1, 0.3, cs[1] ?? 0);
      }],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.22, 0.12, 0, cs[0] ?? 0, 0.055);
        dot(out, rng, 0.22, 0.12, 0, cs[1] ?? 0, 0.055);
      }],
      [1, (n) => seg(out, rng, -0.2, -0.4, 0.2, -0.4, n)]
    ]);
  }),
  makeGlyph('calma', ['cara', 'sereno', 'zen'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        seg(out, rng, -0.37, 0.2, -0.13, 0.2, cs[0] ?? 0);
        seg(out, rng, 0.13, 0.2, 0.37, 0.2, cs[1] ?? 0);
      }],
      [1, (n) => seg(out, rng, -0.15, -0.3, 0.15, -0.3, n)]
    ]);
  }),
  makeGlyph('enamorado', ['cara', 'amor', 'corazon'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => {
        const cs = split(n, [1, 1]);
        heart(out, rng, -0.25, 0.2, 0.13, cs[0] ?? 0);
        heart(out, rng, 0.25, 0.2, 0.13, cs[1] ?? 0);
      }],
      [2, (n) => arc(out, rng, 0, -0.05, 0.38, Math.PI * 1.15, Math.PI * 1.85, n)]
    ]);
  }),
  makeGlyph('llanto', ['cara', 'triste', 'lagrima'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.25, 0.2, 0, cs[0] ?? 0, 0.055);
        dot(out, rng, 0.25, 0.2, 0, cs[1] ?? 0, 0.055);
      }],
      [1, (n) => {
        const cs = split(n, [1, 1, 1, 1]);
        seg(out, rng, -0.25, 0.05, -0.25, -0.2, cs[0] ?? 0);
        seg(out, rng, 0.25, 0.05, 0.25, -0.2, cs[1] ?? 0);
        dot(out, rng, -0.25, -0.28, 0, cs[2] ?? 0, 0.05);
        dot(out, rng, 0.25, -0.28, 0, cs[3] ?? 0, 0.05);
      }],
      [1, (n) => arc(out, rng, 0, -0.62, 0.35, Math.PI * 0.2, Math.PI * 0.8, n)]
    ]);
  }),
  makeGlyph('verguenza', ['cara', 'timido', 'rubor'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [2, (n) => arc(out, rng, 0.1, -0.05, 0.3, Math.PI * 1.2, Math.PI * 1.8, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        disc(out, rng, -0.42, -0.15, 0.09, cs[0] ?? 0);
        disc(out, rng, 0.42, -0.15, 0.09, cs[1] ?? 0);
      }],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        dot(out, rng, -0.18, 0.2, 0, cs[0] ?? 0, 0.05);
        dot(out, rng, 0.32, 0.2, 0, cs[1] ?? 0, 0.05);
      }]
    ]);
  }),

  // — Symbols —
  makeGlyph('corazon', ['simbolo', 'amor', 'like'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => heart(out, rng, 0, -0.05, 0.82, n)],
      [1, (n) => heart(out, rng, 0, -0.05, 0.42, n)]
    ]);
  }),
  makeGlyph('estrella', ['simbolo', 'festejo', 'top'], (out, rng, count) => {
    parts(out, rng, count, [
      [6, (n) => star5(out, rng, 0, 0, 0.7, n)],
      [1, (n) => dot(out, rng, 0, 0, 0, n, 0.07)]
    ]);
  }),
  makeGlyph('check', ['simbolo', 'ok', 'listo'], (out, rng, count) => {
    poly(out, rng, [[-0.55, -0.05], [-0.15, -0.45], [0.6, 0.45]], count);
  }),
  makeGlyph('cruz', ['simbolo', 'error', 'no'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, -0.45, -0.45, 0.45, 0.45, n)],
      [1, (n) => seg(out, rng, 0.45, -0.45, -0.45, 0.45, n)]
    ]);
  }),
  makeGlyph('pregunta', ['simbolo', 'duda', 'ayuda'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => arc(out, rng, 0, 0.3, 0.35, -1.2, 3.5, n)],
      [1, (n) => seg(out, rng, 0.13, -0.03, 0.1, -0.3, n)],
      [1, (n) => dot(out, rng, 0.1, -0.55, 0, n, 0.06)]
    ]);
  }),
  makeGlyph('exclamacion', ['simbolo', 'alerta', 'atencion'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => seg(out, rng, 0, 0.55, 0, -0.25, n)],
      [1, (n) => dot(out, rng, 0, -0.55, 0, n, 0.07)]
    ]);
  }),
  makeGlyph('flecha_arriba', ['simbolo', 'flecha', 'subir'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, 0, -0.6, 0, 0.35, n)],
      [1, (n) => poly(out, rng, [[-0.28, 0.1], [0, 0.45], [0.28, 0.1]], n)]
    ]);
  }),
  makeGlyph('flecha_abajo', ['simbolo', 'flecha', 'bajar'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, 0, 0.6, 0, -0.35, n)],
      [1, (n) => poly(out, rng, [[-0.28, -0.1], [0, -0.45], [0.28, -0.1]], n)]
    ]);
  }),
  makeGlyph('flecha_derecha', ['simbolo', 'flecha', 'seguir'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, -0.6, 0, 0.35, 0, n)],
      [1, (n) => poly(out, rng, [[0.1, 0.28], [0.45, 0], [0.1, -0.28]], n)]
    ]);
  }),
  makeGlyph('flecha_izquierda', ['simbolo', 'flecha', 'volver'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, 0.6, 0, -0.35, 0, n)],
      [1, (n) => poly(out, rng, [[-0.1, 0.28], [-0.45, 0], [-0.1, -0.28]], n)]
    ]);
  }),
  makeGlyph('infinito', ['simbolo', 'eterno', 'loop'], (out, rng, count) => {
    lemni(out, rng, 0, 0, 0.85, count);
  }),
  makeGlyph('circulo', ['simbolo', 'cero', 'anillo'], (out, rng, count) => {
    parts(out, rng, count, [
      [6, (n) => circ(out, rng, 0, 0, 0.7, n)],
      [1, (n) => dot(out, rng, 0, 0, 0, n, 0.06)]
    ]);
  }),

  // — Objects —
  makeGlyph('taza', ['objeto', 'cafe', 'pausa'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.32, -0.5], [0.32, -0.5], [0.32, 0.2], [-0.32, 0.2]], n, 0.012, true)],
      [1, (n) => arc(out, rng, 0.32, -0.15, 0.2, -1.2, 1.2, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        poly(out, rng, [[-0.1, 0.35], [-0.05, 0.5], [-0.1, 0.65]], cs[0] ?? 0);
        poly(out, rng, [[0.12, 0.35], [0.17, 0.5], [0.12, 0.65]], cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('libro', ['objeto', 'leer', 'estudio'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.4, -0.5], [0.4, -0.5], [0.4, 0.5], [-0.4, 0.5]], n, 0.012, true)],
      [1, (n) => seg(out, rng, 0, -0.5, 0, 0.5, n)],
      [1, (n) => seg(out, rng, -0.28, -0.35, -0.28, 0.35, n)]
    ]);
  }),
  makeGlyph('llave', ['objeto', 'abrir', 'acceso'], (out, rng, count) => {
    parts(out, rng, count, [
      [2, (n) => circ(out, rng, 0, 0.45, 0.2, n)],
      [2, (n) => seg(out, rng, 0, 0.25, 0, -0.6, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        seg(out, rng, 0, -0.3, 0.22, -0.3, cs[0] ?? 0);
        seg(out, rng, 0, -0.5, 0.22, -0.5, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('candado', ['objeto', 'seguro', 'cerrar'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.35, -0.55], [0.35, -0.55], [0.35, 0.05], [-0.35, 0.05]], n, 0.012, true)],
      [2, (n) => arc(out, rng, 0, 0.05, 0.28, 0, Math.PI, n)],
      [1, (n) => dot(out, rng, 0, -0.25, 0, n, 0.06)]
    ]);
  }),
  makeGlyph('lampara', ['objeto', 'idea', 'luz'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, -0.05, 0.35, n)],
      [1, (n) => {
        const cs = split(n, [1, 1, 1]);
        seg(out, rng, -0.12, -0.38, -0.12, -0.55, cs[0] ?? 0);
        seg(out, rng, 0.12, -0.38, 0.12, -0.55, cs[1] ?? 0);
        seg(out, rng, -0.12, -0.55, 0.12, -0.55, cs[2] ?? 0);
      }],
      [2, (n) => rays(out, rng, 0, -0.05, 0.5, 0.68, [0.5, 1.05, 1.57, 2.1, 2.65], n)]
    ]);
  }),
  makeGlyph('regalo', ['objeto', 'festejo', 'sorpresa'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.4, -0.5], [0.4, -0.5], [0.4, 0.15], [-0.4, 0.15]], n, 0.012, true)],
      [1, (n) => seg(out, rng, 0, -0.5, 0, 0.15, n)],
      [1, (n) => seg(out, rng, -0.45, 0.15, 0.45, 0.15, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        arc(out, rng, -0.12, 0.3, 0.12, 0, Math.PI, cs[0] ?? 0);
        arc(out, rng, 0.12, 0.3, 0.12, 0, Math.PI, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('campana', ['objeto', 'aviso', 'alerta'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => arc(out, rng, 0, -0.2, 0.4, 0, Math.PI, n)],
      [1, (n) => seg(out, rng, -0.42, -0.2, 0.42, -0.2, n)],
      [1, (n) => dot(out, rng, 0, -0.45, 0, n, 0.06)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        arc(out, rng, -0.56, -0.1, 0.14, -1, 1, cs[0] ?? 0);
        arc(out, rng, 0.56, -0.1, 0.14, Math.PI - 1, Math.PI + 1, cs[1] ?? 0);
      }]
    ]);
  }),
  makeGlyph('reloj', ['objeto', 'hora', 'tiempo'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => circ(out, rng, 0, 0, 0.6, n)],
      [1, (n) => {
        const cs = split(n, [1, 1]);
        seg(out, rng, 0, 0, 0, 0.35, cs[0] ?? 0);
        seg(out, rng, 0, 0, 0.28, -0.1, cs[1] ?? 0);
      }],
      [1, (n) => {
        const cs = split(n, [1, 1, 1, 1]);
        dot(out, rng, 0, 0.5, 0, cs[0] ?? 0, 0.04);
        dot(out, rng, 0.5, 0, 0, cs[1] ?? 0, 0.04);
        dot(out, rng, 0, -0.5, 0, cs[2] ?? 0, 0.04);
        dot(out, rng, -0.5, 0, 0, cs[3] ?? 0, 0.04);
      }]
    ]);
  }),
  makeGlyph('carta', ['objeto', 'mensaje', 'mail'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.5, -0.32], [0.5, -0.32], [0.5, 0.32], [-0.5, 0.32]], n, 0.012, true)],
      [2, (n) => poly(out, rng, [[-0.5, 0.32], [0, -0.05], [0.5, 0.32]], n)]
    ]);
  }),
  makeGlyph('microfono', ['objeto', 'voz', 'hablar'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => disc(out, rng, 0, 0.3, 0.28, n)],
      [2, (n) => seg(out, rng, 0, 0.02, 0, -0.5, n)],
      [1, (n) => seg(out, rng, -0.2, -0.5, 0.2, -0.5, n)]
    ]);
  }),

  // — Letters —
  makeGlyph('letra_a', ['letra', 'alfabeto'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[-0.35, -0.6], [0, 0.6], [0.35, -0.6]], n)],
      [1, (n) => seg(out, rng, -0.2, -0.15, 0.2, -0.15, n)]
    ]);
  }),
  makeGlyph('letra_e', ['letra', 'alfabeto'], (out, rng, count) => {
    parts(out, rng, count, [
      [3, (n) => poly(out, rng, [[0.35, 0.6], [-0.3, 0.6], [-0.3, -0.6], [0.35, -0.6]], n)],
      [1, (n) => seg(out, rng, -0.3, 0, 0.25, 0, n)]
    ]);
  }),
  makeGlyph('letra_o', ['letra', 'alfabeto'], (out, rng, count) => {
    ellip(out, rng, 0, 0, 0.4, 0.6, count);
  }),
  makeGlyph('letra_t', ['letra', 'alfabeto'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, -0.35, 0.6, 0.35, 0.6, n)],
      [2, (n) => seg(out, rng, 0, 0.6, 0, -0.6, n)]
    ]);
  }),
  makeGlyph('letra_v', ['letra', 'alfabeto'], (out, rng, count) => {
    poly(out, rng, [[-0.35, 0.6], [0, -0.6], [0.35, 0.6]], count);
  }),
  makeGlyph('letra_x', ['letra', 'alfabeto'], (out, rng, count) => {
    parts(out, rng, count, [
      [1, (n) => seg(out, rng, -0.3, -0.6, 0.3, 0.6, n)],
      [1, (n) => seg(out, rng, 0.3, -0.6, -0.3, 0.6, n)]
    ]);
  })
];

// ── Registry ────────────────────────────────────────────────────────

export const GLYPH_A_NAMES: string[] = GLYPHS_A.map((g) => g.name);

const BY_NAME_A = new Map<string, Glyph>();
for (const g of GLYPHS_A) BY_NAME_A.set(foldGlyphName(g.name), g);

// T2b extras (glyphs-index.ts registers GLYPHS_B here at load).
const EXTRAS = new Map<string, Glyph>();

// Registers extra glyphs (B). Never overwrites A on collision: A wins and
// the colliding name is reported in the `skipped` count (main resolves it).
export function registerExtraGlyphs(glyphs: Glyph[]): { added: number; skipped: string[] } {
  let added = 0;
  const skipped: string[] = [];
  for (const g of glyphs) {
    const key = foldGlyphName(g.name);
    if (BY_NAME_A.has(key) || EXTRAS.has(key)) {
      skipped.push(g.name);
      continue;
    }
    EXTRAS.set(key, g);
    added += 1;
  }
  return { added, skipped };
}

export function lookupGlyphA(name: string): Glyph | null {
  return BY_NAME_A.get(foldGlyphName(name)) ?? null;
}

// Full lookup: A + B extras. Case-insensitive, tolerates accents/spaces.
export function lookupGlyph(name: string): Glyph | null {
  const key = foldGlyphName(name);
  return BY_NAME_A.get(key) ?? EXTRAS.get(key) ?? null;
}

export function listGlyphNames(): string[] {
  return [...GLYPH_A_NAMES, ...[...EXTRAS.values()].map((g) => g.name)];
}
