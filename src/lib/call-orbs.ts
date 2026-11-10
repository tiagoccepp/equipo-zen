// ═══════════════════════════════════════════════════════════════════════
// Particle spheres for call mode.
//
// A single <canvas> draws ALL spheres (one per present employee) with one
// requestAnimationFrame. Each sphere is a point cloud on a unit sphere:
// projected orthographically, so whether it spins or jumps, the silhouette
// stays a circle. What changes is each particle's radius, never the overall
// shape.
//
// Two decisions worth explaining:
//
//  1. COLOR is harmonized in OKLCh: from each `agent.color` we keep only the
//     hue (H) and impose the same lightness and a very low chroma on all of
//     them. In HSL "same L" is not "same perceived brightness" (a yellow at
//     L=60% screams while a blue at L=60% sinks), and that difference is
//     exactly what makes six colors read like a traffic light. In OKLCh it
//     works: the spheres end up as a family of grays with a hint of hue
//     each. See ORB_TONE.
//
//  2. The canvas does NOT decide LAYOUT. Each sphere has a slot in the DOM
//     (a grid cell, with the employee's name below as real text) and the
//     canvas just draws inside the rectangle that cell occupies. That way
//     CSS resolves responsiveness, line breaks and centering, and the screen
//     reader reads names, not a drawing.
// ═══════════════════════════════════════════════════════════════════════

const TAU = Math.PI * 2;
// Golden angle: the step that spreads points (or hues) without clumping.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type OrbTheme = 'light' | 'dark';

export type OrbAgent = {
  id: string;
  name: string;
  // Employee's original color (#rrggbb). Harmonized in here.
  color: string;
};

// Where and how big each sphere goes, in CSS pixels relative to the canvas.
// Measured by the client on the DOM (getBoundingClientRect of each cell).
export type OrbSlot = {
  id: string;
  cx: number;
  cy: number;
  r: number;
};

// ── Color: one family, not a traffic light ────────────────────────────
// Fixed lightness and chroma per theme; only the hue survives from the
// employee's color. Values are chosen against the app tokens:
//   light → background #f5f3ed (L≈0.96): points at L=0.58 have plenty of contrast.
//   dark  → background #171913 (L≈0.22): points at L=0.76 read without glowing.
// The chroma (0.05) is deliberately silly: barely a hint of hue.
export const ORB_TONE: Record<OrbTheme, { l: number; c: number }> = {
  light: { l: 0.58, c: 0.062 },
  dark: { l: 0.76, c: 0.065 }
};

// Minimum hue separation between two spheres, in radians (~31°). Needed
// because the employee color is NOT unique: the CEO and contractors from old
// companies were assigned the company color, and two different templates may
// repeat palettes. With such low chroma, two hues less than 30° apart yield
// exactly the same gray.
const MIN_HUE_GAP = 0.55;

type Rgb = { r: number; g: number; b: number };

function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function parseHexColor(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex || '').trim());
  if (!match) {
    return null;
  }
  const digits = match[1].length === 3
    ? match[1].split('').map((digit) => digit + digit).join('')
    : match[1];
  return {
    r: parseInt(digits.slice(0, 2), 16) / 255,
    g: parseInt(digits.slice(2, 4), 16) / 255,
    b: parseInt(digits.slice(4, 6), 16) / 255
  };
}

// sRGB → OKLab (Björn Ottosson). The only transform that makes "same L"
// mean "same brightness" to the eye.
function rgbToOklab(rgb: Rgb) {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  };
}

function oklabToRgb(lab: { L: number; a: number; b: number }): Rgb {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);

  return {
    r: clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  };
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function toHex(rgb: Rgb) {
  const byte = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0');
  return `#${byte(rgb.r)}${byte(rgb.g)}${byte(rgb.b)}`;
}

// Hue (in radians) of the employee's color. null if the color is invalid or
// a pure gray: no hue to keep.
export function colorHue(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) {
    return null;
  }
  const lab = rgbToOklab(rgb);
  if (Math.sqrt(lab.a * lab.a + lab.b * lab.b) < 0.004) {
    return null;
  }
  return Math.atan2(lab.b, lab.a);
}

// One hue + the family's lightness and chroma = the point's final color.
export function orbColorFromHue(hue: number, theme: OrbTheme): string {
  const tone = ORB_TONE[theme];
  return toHex(oklabToRgb({
    L: tone.l,
    a: Math.cos(hue) * tone.c,
    b: Math.sin(hue) * tone.c
  }));
}

function hueDistance(a: number, b: number) {
  const diff = Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI);
  return diff;
}

// Spreads a call's hues: the first to arrive keeps its own as-is, and those
// landing too close to a taken one get shifted the minimum needed.
// Deterministic (same cast → same hues) and stable in team arrival order.
export function resolveOrbHues(colors: string[]): number[] {
  const taken: number[] = [];
  const free = (hue: number) => !taken.some((other) => hueDistance(hue, other) < MIN_HUE_GAP);

  // Last resort: the middle of the largest remaining gap. With 8 spheres the
  // wheel fragments and there may be NO spot at 0.55 from everyone; then the
  // right move is to spread as best as possible, not repeat a hue.
  const widestGap = () => {
    const sorted = [...taken].sort((a, b) => a - b);
    let best = sorted[0] + TAU - sorted[sorted.length - 1];
    let hue = (sorted[sorted.length - 1] + best / 2) % TAU;
    for (let index = 1; index < sorted.length; index += 1) {
      const gap = sorted[index] - sorted[index - 1];
      if (gap > best) {
        best = gap;
        hue = sorted[index - 1] + gap / 2;
      }
    }
    return hue % TAU;
  };

  return colors.map((color, index) => {
    // A gray (or a broken color) still needs its own hue: the golden
    // angle by position spreads those cases without clumping.
    const original = colorHue(color) ?? (index * GOLDEN_ANGLE) % TAU;
    const nearest = (hue: number) => taken.reduce((min, other) => Math.min(min, hueDistance(hue, other)), Infinity);

    // The nearest free gap is found by probing both sides, not always
    // in the same direction: that way the hue shifts as little as possible
    // (a red ends up as a neighboring muted red, not a green).
    let hue = original;
    let best = original;
    let bestDistance = nearest(original);
    for (let step = 1; step <= 40 && !free(hue); step += 1) {
      const offset = Math.ceil(step / 2) * MIN_HUE_GAP * 0.4 * (step % 2 === 1 ? 1 : -1);
      hue = (original + offset + TAU) % TAU;
      const distance = nearest(hue);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = hue;
      }
    }
    if (!free(hue)) {
      // Nothing free: pick what separates most, between the best candidate
      // near the original hue and the center of the largest remaining gap.
      const fallback = widestGap();
      hue = nearest(fallback) > bestDistance ? fallback : best;
    }
    taken.push(hue);
    return hue;
  });
}

// The employee's hue, with the family's lightness and chroma.
// An unreadable color (or pure gray) falls back to a theme neutral, never black.
export function harmonizeOrbColor(hex: string, theme: OrbTheme): string {
  const hue = colorHue(hex);
  if (hue === null) {
    return toHex(oklabToRgb({ L: ORB_TONE[theme].l, a: 0, b: 0 }));
  }
  return orbColorFromHue(hue, theme);
}

// ── Cloud geometry ───────────────────────────────────────────────────

// How many particles per sphere given its radius in CSS pixels. With 8 large
// spheres that's ~4,300 points per frame, drawn in 4 passes (one per depth
// bucket), not 4,300 fill() calls. Density matters: with half the points the
// cloud reads as a dotted circle, not a sphere.
export function particleCount(radius: number) {
  return Math.round(Math.min(720, Math.max(150, radius * 6.2)));
}

export type OrbParticle = {
  // Direction on the unit sphere (|u| = 1).
  ux: number;
  uy: number;
  uz: number;
  // Own radius inside the shell (0.72..1): gives the cloud volume.
  rad: number;
  // Jump offset, so particles don't all bounce together.
  phase: number;
};

// Deterministic stateless pseudo-random (the same sphere looks the same on
// every rebuild). It must be an avalanche hash, not the fractional part
// of an irrational: that option looks random but is still a linear sequence,
// and added to the golden angle it draws visible meridians on the sphere
// (seen in practice: clouds looked like melons).
function hashUnit(index: number, seed: number) {
  let hash = Math.imul((index | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(seed * 1e6) | 0, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967296;
}

// Fibonacci distribution (with jitter): points spread evenly over the
// sphere, without the clumped poles left by lat/long sampling.
export function sphereParticles(count: number, seed = 0): OrbParticle[] {
  const total = Math.max(1, Math.round(count));
  const particles: OrbParticle[] = [];
  for (let index = 0; index < total; index += 1) {
    // Pure Fibonacci draws visible spirals (moiré effect) on the sphere.
    // A small jitter in height and angle breaks that pattern and the cloud
    // goes from "mesh" to "dust" without losing the even spread.
    const uy = 1 - (2 * index + 1 + (hashUnit(index * 5 + 2, seed + 0.11) - 0.5) * 1.1) / total;
    const ring = Math.sqrt(Math.max(0, 1 - uy * uy));
    const theta = index * GOLDEN_ANGLE + seed + (hashUnit(index * 11 + 7, seed + 0.53) - 0.5) * 0.85;
    particles.push({
      ux: Math.cos(theta) * ring,
      uy,
      uz: Math.sin(theta) * ring,
      // Thick shell (72%..100% of radius): the edge stays defined and the
      // interior semi-transparent, which is what reads as a sphere rather
      // than a ring of dots.
      rad: 0.72 + 0.28 * hashUnit(index, seed),
      phase: hashUnit(index * 3 + 1, seed + 0.31) * TAU
    });
  }
  return particles;
}

// Amplitude tracking: rises fast (voice starts abruptly) and falls
// slowly (if it fell just as fast, particles would flicker on every
// voiceless consonant).
export function followEnergy(current: number, target: number, dt: number) {
  const rate = target > current ? 14 : 4.5;
  const step = Math.min(1, rate * Math.max(0, dt));
  return current + (target - current) * step;
}

// ── Motion ───────────────────────────────────────────────────────────
// At rest: a silent room. Floating has a ~7 s period and 6% of radius
// amplitude; rotation makes one turn every ~40 s.
const FLOAT_SPEED = 0.9;
const FLOAT_AMPLITUDE = 0.06;
const DRIFT_SPEED = 0.6;
const DRIFT_AMPLITUDE = 0.022;
const ROTATION_SPEED = 0.155;
const TILT = 0.42;

// When speaking: particles jump up to 20% of their radius and the whole
// sphere zooms 7%. The ceiling (1.2 × 1.07 ≈ 1.28) is what sets the base
// radius against the DOM-reserved slot, so nothing leaves its cell.
const JUMP_AMPLITUDE = 0.2;
const JUMP_SPEED = 6.5;
const ZOOM_AMPLITUDE = 0.07;
const BASE_RADIUS_RATIO = 0.78;

// Opacity per depth bucket: the cloud's back fades out and the front stays
// sharp. That's what makes a flat circle look like a volume.
const DEPTH_ALPHA = [0.34, 0.52, 0.74, 1];
const BUCKETS = DEPTH_ALPHA.length;

// Overall sphere opacity: at rest it breathes dimmed, when speaking it
// settles. With prefers-reduced-motion this is ALL the visible change.
const ORB_ALPHA_IDLE = 0.78;
const ORB_ALPHA_SPEAKING = 1;
// While someone speaks, the rest of the room steps back.
const ORB_FOCUS_DIM = 0.62;

// ── "Working" state ──────────────────────────────────────────────────
// An agent PRODUCING in the background doesn't speak, but must look alive:
// a thin arc slowly circling the sphere. It's deliberately different from
// speaking (which pulses with the voice) and deliberately slow — a fast spin
// at the screen's edge is noise, not information.
const WORK_ARC_SPEED = 0.85;
const WORK_ARC_SWEEP = TAU * 0.26;
const WORK_ARC_ALPHA = 0.55;
const WORK_ARC_WIDTH = 2;
const WORK_ARC_GAP = 1.1;
// Whoever works doesn't dim even while another speaks: stays in focus.
const ORB_FOCUS_WORKING = 0.9;

type Orb = {
  id: string;
  sourceColor: string;
  hue: number;
  color: string;
  particles: OrbParticle[];
  // Projection scratch: x, y, size per particle (reused every frame).
  projected: Float32Array;
  bucket: Uint8Array;
  slot: OrbSlot | null;
  phaseFloat: number;
  phaseRot: number;
  energy: number;
  target: number;
  // How much the sphere dims when ANOTHER speaks (1 = full). It's the only
  // visible change with prefers-reduced-motion, and in normal motion it helps
  // the eye go to whoever holds the floor.
  focus: number;
};

export type OrbFieldOptions = {
  // Current voice amplitude of the speaking agent (0..1).
  energy: () => number;
};

export class OrbField {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private options: OrbFieldOptions;
  private orbs: Orb[] = [];
  private theme: OrbTheme = 'light';
  private speakingId = '';
  // Who is producing RIGHT NOW, per the server's work_events.
  private workingIds = new Set<string>();
  private reduced = false;
  private raf = 0;
  private lastAt = 0;
  private clock = 0;
  private dpr = 1;
  private width = 0;
  private height = 0;
  // FPS measured over ~1 s windows (for reporting, not for deciding anything).
  private fpsFrames = 0;
  private fpsSince = 0;
  private fpsValue = 0;
  private reducedMedia: MediaQueryList | null = null;

  constructor(canvas: HTMLCanvasElement, options: OrbFieldOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = options;
    // The field lives as long as the page, so this listener is never
    // unhooked (the call opens and closes; the canvas is a single one).
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.reducedMedia.matches;
      this.reducedMedia.addEventListener('change', this.onReducedChange);
    }
  }

  private onReducedChange = (event: MediaQueryListEvent) => {
    this.reduced = event.matches;
    this.kick();
  };

  get prefersReducedMotion() {
    return this.reduced;
  }

  // Rebuilds the clouds only if the cast changed (id or color): without this,
  // every server message would restart the phases and the spheres would jump.
  // Those working in the background. Idempotent and cheap: called on every
  // work_event.
  setWorking(ids: string[]) {
    const siguiente = new Set(ids);
    if (siguiente.size === this.workingIds.size && [...siguiente].every((id) => this.workingIds.has(id))) {
      return;
    }
    this.workingIds = siguiente;
    // With reduced motion the loop is stopped when nothing travels: it must
    // be woken so the arc appears or disappears.
    this.kick();
  }

  isWorking(agentId: string) {
    return this.workingIds.has(agentId);
  }

  setAgents(agents: OrbAgent[]) {
    const signature = agents.map((agent) => `${agent.id}:${agent.color}`).join('|');
    const current = this.orbs.map((orb) => `${orb.id}:${orb.sourceColor}`).join('|');
    if (signature === current) {
      return;
    }

    const hues = resolveOrbHues(agents.map((agent) => agent.color));
    const previous = new Map(this.orbs.map((orb) => [orb.id, orb]));
    this.orbs = agents.map((agent, index) => {
      const kept = previous.get(agent.id);
      const hue = hues[index];
      if (kept && kept.sourceColor === agent.color && kept.hue === hue) {
        return kept;
      }
      return {
        id: agent.id,
        sourceColor: agent.color,
        hue,
        color: orbColorFromHue(hue, this.theme),
        particles: [],
        projected: new Float32Array(0),
        bucket: new Uint8Array(0),
        slot: null,
        // Each sphere floats and spins with its own offset: they never pulse in unison.
        phaseFloat: (index * 1.371) % TAU,
        phaseRot: (index * 2.117) % TAU,
        energy: 0,
        target: 0,
        focus: 1
      };
    });
    this.kick();
  }

  // DOM-measured positions. If the radius changed, the cloud is rebuilt with
  // the density matching that size.
  setSlots(slots: OrbSlot[]) {
    const byId = new Map(slots.map((slot) => [slot.id, slot]));
    for (const orb of this.orbs) {
      const slot = byId.get(orb.id) || null;
      const changed = !orb.slot || !slot || Math.abs(orb.slot.r - slot.r) > 0.5;
      orb.slot = slot;
      if (slot && (changed || orb.particles.length === 0)) {
        const count = particleCount(slot.r);
        orb.particles = sphereParticles(count, orb.phaseRot);
        orb.projected = new Float32Array(count * 3);
        orb.bucket = new Uint8Array(count);
      }
    }
    this.kick();
  }

  setTheme(theme: OrbTheme) {
    if (this.theme === theme) {
      return;
    }
    this.theme = theme;
    for (const orb of this.orbs) {
      orb.color = orbColorFromHue(orb.hue, theme);
    }
    this.kick();
  }

  setSpeaking(agentId: string) {
    if (this.speakingId === agentId) {
      return;
    }
    this.speakingId = agentId;
    this.kick();
  }

  resize(cssWidth: number, cssHeight: number) {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(cssWidth));
    const height = Math.max(1, Math.round(cssHeight));
    if (this.width === width && this.height === height && this.dpr === dpr) {
      return;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.kick();
  }

  start() {
    if (this.raf || !this.ctx || this.orbs.length === 0) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    this.lastAt = performance.now();
    this.fpsFrames = 0;
    this.fpsSince = this.lastAt;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.fpsValue = 0;
  }

  get running() {
    return this.raf !== 0;
  }

  stats() {
    return {
      fps: Math.round(this.fpsValue),
      orbs: this.orbs.length,
      particles: this.orbs.reduce((total, orb) => total + orb.particles.length, 0)
    };
  }

  // With reduced motion the loop turns off as soon as opacity reaches its
  // destination: nothing to animate until someone speaks. Any state change
  // turns it back on.
  private kick() {
    if (this.raf || !this.reduced) {
      return;
    }
    this.start();
  }

  private tick = (now: number) => {
    this.raf = 0;
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    // Clamped dt: if the tab was stuck, we don't want a jump.
    const dt = Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    this.clock += dt;

    this.fpsFrames += 1;
    if (now - this.fpsSince >= 1000) {
      this.fpsValue = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }

    const energy = Math.min(1, Math.max(0, this.options.energy() || 0));
    let animating = false;
    ctx.clearRect(0, 0, this.width, this.height);

    for (const orb of this.orbs) {
      const speaking = orb.id === this.speakingId;
      const working = this.workingIds.has(orb.id);
      // With reduced motion opacity does NOT follow amplitude: following the voice
      // there would be flicker, exactly what must be avoided. It rises once when
      // the turn starts and falls when it ends.
      orb.target = speaking ? (this.reduced ? 1 : energy) : 0;
      orb.energy = followEnergy(orb.energy, orb.target, dt);
      const focusTarget = !this.speakingId || speaking
        ? 1
        : working ? ORB_FOCUS_WORKING : ORB_FOCUS_DIM;
      orb.focus = followEnergy(orb.focus, focusTarget, dt);
      if (Math.abs(orb.target - orb.energy) > 0.002 || Math.abs(focusTarget - orb.focus) > 0.002) {
        animating = true;
      }
      this.drawOrb(ctx, orb);
      if (working) {
        this.drawWorkArc(ctx, orb);
        // The arc spins: while anyone works, the loop doesn't stop.
        animating = true;
      }
    }

    // In normal motion the loop is continuous (floating + rotation). In reduced
    // it only continues while opacity is traveling.
    if (!this.reduced || animating) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.fpsValue = 0;
    }
  };

  // The "producing" ring: an arc traveling the edge. With reduced motion
  // it doesn't spin — a full dotted ring remains, which communicates the
  // same thing without animation.
  private drawWorkArc(ctx: CanvasRenderingContext2D, orb: Orb) {
    const slot = orb.slot;
    if (!slot) {
      return;
    }
    const radio = slot.r * BASE_RADIUS_RATIO * 1.16;
    ctx.save();
    ctx.strokeStyle = orb.color;
    ctx.globalAlpha = WORK_ARC_ALPHA * orb.focus;
    ctx.lineWidth = WORK_ARC_WIDTH;
    ctx.lineCap = 'round';
    if (this.reduced) {
      ctx.setLineDash([WORK_ARC_WIDTH * 2, WORK_ARC_WIDTH * 3]);
      ctx.beginPath();
      ctx.arc(slot.cx, slot.cy, radio, 0, TAU);
      ctx.stroke();
    } else {
      const desde = (this.clock * WORK_ARC_SPEED + orb.phaseFloat) % TAU;
      ctx.beginPath();
      ctx.arc(slot.cx, slot.cy, radio, desde, desde + WORK_ARC_SWEEP);
      ctx.stroke();
      // A second opposing arc: reads as spinning, not as clipping.
      ctx.globalAlpha = WORK_ARC_ALPHA * 0.5 * orb.focus;
      ctx.beginPath();
      ctx.arc(slot.cx, slot.cy, radio + WORK_ARC_GAP, desde + Math.PI, desde + Math.PI + WORK_ARC_SWEEP * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawOrb(ctx: CanvasRenderingContext2D, orb: Orb) {
    const slot = orb.slot;
    if (!slot || orb.particles.length === 0) {
      return;
    }

    const energy = orb.energy;
    const reduced = this.reduced;
    const radius = slot.r * BASE_RADIUS_RATIO;
    const zoom = reduced ? 1 : 1 + ZOOM_AMPLITUDE * energy;
    const rotation = reduced ? orb.phaseRot : orb.phaseRot + this.clock * ROTATION_SPEED;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const cosTilt = Math.cos(TILT);
    const sinTilt = Math.sin(TILT);

    const cx = slot.cx + (reduced ? 0 : Math.sin(this.clock * DRIFT_SPEED + orb.phaseFloat * 1.3) * slot.r * DRIFT_AMPLITUDE);
    const cy = slot.cy + (reduced ? 0 : Math.sin(this.clock * FLOAT_SPEED + orb.phaseFloat) * slot.r * FLOAT_AMPLITUDE);
    const dot = Math.min(1.7, Math.max(0.6, slot.r * 0.015));
    const jump = reduced ? 0 : JUMP_AMPLITUDE * energy;
    const jumpClock = this.clock * JUMP_SPEED;

    // Pass 1: projection. A single trigonometry round, stored in the
    // sphere's scratch buffers.
    const particles = orb.particles;
    const projected = orb.projected;
    const buckets = orb.bucket;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      // Spin around the Y axis (the cloud's), then tilt around X.
      const x = particle.ux * cos + particle.uz * sin;
      const zRot = particle.uz * cos - particle.ux * sin;
      const y = particle.uy * cosTilt - zRot * sinTilt;
      const z = particle.uy * sinTilt + zRot * cosTilt;

      // EACH particle's radius pulses; the whole stays a circle.
      const wave = jump > 0 ? jump * (0.55 + 0.45 * Math.sin(jumpClock + particle.phase)) : 0;
      const scale = radius * particle.rad * (1 + wave) * zoom;

      const depth = (z + 1) * 0.5;
      const offset = index * 3;
      projected[offset] = cx + x * scale;
      projected[offset + 1] = cy + y * scale;
      projected[offset + 2] = dot * (0.7 + 0.55 * depth);
      buckets[index] = Math.min(BUCKETS - 1, Math.max(0, Math.floor(depth * BUCKETS)));
    }

    // Pass 2: one fill() per depth bucket. Four calls per sphere
    // instead of one per particle.
    const orbAlpha = (ORB_ALPHA_IDLE + (ORB_ALPHA_SPEAKING - ORB_ALPHA_IDLE) * energy) * orb.focus;
    ctx.fillStyle = orb.color;
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      ctx.beginPath();
      let drawn = false;
      for (let index = 0; index < particles.length; index += 1) {
        if (buckets[index] !== bucket) {
          continue;
        }
        const offset = index * 3;
        const size = projected[offset + 2];
        ctx.moveTo(projected[offset] + size, projected[offset + 1]);
        ctx.arc(projected[offset], projected[offset + 1], size, 0, TAU);
        drawn = true;
      }
      if (drawn) {
        ctx.globalAlpha = DEPTH_ALPHA[bucket] * orbAlpha;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Read hooks for fx/* (additive, 09/11, visual-wow track) ──────
  // READ ONLY: they change no field behavior. Main uses them to mirror
  // state (reactive mesh, glow, palette) without touching the loop.

  // Who holds the floor now ('' = nobody).
  getSpeakingId() {
    return this.speakingId;
  }

  // Per-sphere snapshot: smoothed energy, focus, flags. New object each time.
  snapshot(): OrbSnapshot[] {
    return this.orbs.map((orb) => ({
      id: orb.id,
      energy: orb.energy,
      focus: orb.focus,
      speaking: orb.id === this.speakingId,
      working: this.workingIds.has(orb.id)
    }));
  }
}

// One sphere's snapshot for external consumers (fx/mesh, main). Data only.
export type OrbSnapshot = {
  id: string;
  energy: number;
  focus: number;
  speaking: boolean;
  working: boolean;
};
