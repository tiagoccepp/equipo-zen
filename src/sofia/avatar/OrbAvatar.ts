/**
 * Adapter: drives the vendored MIT Q orb (src/avatar/orb, a
 * self-contained Three.js renderer) through our `ControllableAvatar` seam, so the
 * four-state machine, mood, and the entire voice loop drive it with ZERO changes.
 * It is a drop-in for the `avatarFactory` in `tauriAdapter` (same surface the SVG
 * `HoloOrb` exposed).
 *
 * The orb is STATE-target driven (it eases toward a `QStateTarget`) and
 * exposes a live `setIntensityOverride` (energy) + `pulse`. Our `AvatarController`
 * pushes continuous scalars (`params.amplitude` / `params.speed`, glow). We bridge
 * them: `params.speed` is constant per state (idle 0.5 / listening 0.9 / speaking
 * 1.2 / thinking 2.5), so we map it to the matching orb state target (set only on
 * change, to avoid the renderer's per-call pulse), and feed `params.amplitude`
 * (which already folds in the mic level and word-boundary impulses) as the live
 * energy override every frame. Result: the core swells with the voice, thinking
 * spins up, speaking flares -- all from the existing controller output.
 */

import { createRenderer, type Renderer } from './orb/renderer';
import {
  SIZE_PRESETS,
  type QStateTarget,
  type QSizePreset,
  type QPaletteValues,
} from './orb/states';
import { detectGpu } from './gpu';
import type { AvatarOptions } from './Avatar';
import type { PaletteConfig } from '../config/config';
import type { DeformationParams } from './deformation';

export type Activity = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Orb state targets for our four activity states (energy is overridden live).
 * Tuned BOLDER than the library defaults for full-window use: higher `bloom`
 * (drives halo size/opacity + ring brightness + inner-core glow), bigger
 * `coreScale`, fuller `ringSpread`, brighter `filamentOpacity`.
 */
const ORB_STATES: Record<Activity, QStateTarget> = {
  idle: {
    energy: 0.9,
    rotationSpeed: 0.5,
    particleSpeed: 0.62,
    shellRadius: 1.0,
    ringSpread: 0.98,
    filamentOpacity: 0.52,
    coreScale: 1.06,
    bloom: 0.9,
  },
  listening: {
    energy: 1.2,
    rotationSpeed: 0.78,
    particleSpeed: 1.36,
    shellRadius: 1.08,
    ringSpread: 1.08,
    filamentOpacity: 0.74,
    coreScale: 1.18,
    bloom: 1.12,
  },
  thinking: {
    energy: 1.25,
    rotationSpeed: 1.42,
    particleSpeed: 1.32,
    shellRadius: 1.08,
    ringSpread: 1.1,
    filamentOpacity: 0.72,
    coreScale: 1.16,
    bloom: 1.12,
  },
  speaking: {
    energy: 1.35,
    rotationSpeed: 0.98,
    particleSpeed: 1.26,
    shellRadius: 1.12,
    ringSpread: 1.2,
    filamentOpacity: 0.82,
    coreScale: 1.28,
    bloom: 1.32,
  },
};

/** Full-window immersive preset: fill the frame, dense particles/filaments. */
const IMMERSIVE_PRESET: QSizePreset = {
  ...SIZE_PRESETS.hero,
  sceneScale: 1.05,
  particleCount: 1000,
  filamentCount: 120,
  ringSegments: 200,
  dpr: 2,
  minDpr: 1.25,
};

/**
 * Light preset for software-WebGL machines (no GPU acceleration: SwiftShader /
 * WARP / Remote Desktop / a VM). When every pixel is rasterized on the CPU a
 * full-window orb pegs all cores, so this cuts particles/filaments, drops to
 * DPR 1, and (with antialias off + a 20fps cap, both set in `mount`) keeps the
 * orb smooth without saturating the machine.
 */
const LITE_PRESET: QSizePreset = {
  ...SIZE_PRESETS.hero,
  sceneScale: 1.05,
  particleCount: 280,
  filamentCount: 36,
  ringSegments: 96,
  dpr: 1,
  minDpr: 1,
};

/**
 * Per-backend render budget. The orb's render loop is otherwise uncapped, so on
 * any machine a healthy GPU still ran it at full refresh with DPR up to 2 (4x the
 * fragment work of DPR 1) -- capping FPS, the filament-update stride, and the DPR
 * ceiling is the main CPU win; software mode degrades further. `setPaused` (wired
 * to visibilitychange in tauriAdapter) stops it entirely when the window is hidden.
 */
interface RenderBudget {
  preset: QSizePreset;
  targetFps: number;
  filamentFrameStride: number;
  dprCeiling: number;
  antialias: boolean;
}

const RENDER_BUDGETS: Record<'gpu' | 'software', RenderBudget> = {
  gpu: { preset: IMMERSIVE_PRESET, targetFps: 30, filamentFrameStride: 2, dprCeiling: 1.5, antialias: true },
  software: { preset: LITE_PRESET, targetFps: 20, filamentFrameStride: 3, dprCeiling: 1, antialias: false },
};

/** params.speed (constant per state) -> activity. Thresholds sit between the values. */
export function activityFromSpeed(speed: number): Activity {
  if (speed < 0.7) return 'idle';
  if (speed < 1.05) return 'listening';
  if (speed < 1.6) return 'speaking';
  return 'thinking';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Lighten a 0xRRGGBB toward white by t in [0,1]. */
function lighten(hex: number, t: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const mix = (c: number): number => Math.round(c + (255 - c) * t);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** Darken a 0xRRGGBB toward black by t in [0,1]. */
function darken(hex: number, t: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const mix = (c: number): number => Math.round(c * (1 - t));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

function rgbaString(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff}, ${alpha})`;
}

/**
 * Bridge a PaletteConfig (app-level theme) to a QPaletteValues (orb-internal)
 * using the idle-state colors. Used for the initial mount palette so the orb
 * starts in the correct theme without waiting for the first controller tick.
 */
export function themeToPalette(palette: PaletteConfig): QPaletteValues {
  return paletteFromColors(palette.idleRim, palette.idleCore);
}

/**
 * Build a Q orb palette from the controller's rim/core hex (which already
 * encode the per-state color and any mood tint). `rim` is the dominant neon
 * (primary), `core` the deeper tone (secondary); the hot center burns toward
 * white, and the reduced-motion CSS fallback gradient is derived to match.
 */
export function paletteFromColors(rim: number, core: number): QPaletteValues {
  const hot = lighten(rim, 0.78);
  return {
    core: hot,
    primary: rim,
    secondary: core,
    tertiary: lighten(rim, 0.4),
    deep: darken(core, 0.55),
    fallback: `radial-gradient(circle at 50% 50%, ${rgbaString(hot, 0.96)} 0%, ${rgbaString(
      rim,
      0.82,
    )} 18%, ${rgbaString(core, 0.42)} 48%, ${rgbaString(darken(core, 0.55), 0.2)} 72%, rgba(0,0,0,0) 84%)`,
  };
}

export class OrbAvatar {
  beforeRender: ((time: number) => void) | null = null;
  reducedMotion = false;
  readonly params: DeformationParams = { amplitude: 0.12, frequency: 1.1, speed: 0.5 };
  idleRotationSpeed = 0.15;

  /** Recorder the controller writes; the orb self-animates, so these are unused. */
  readonly mesh = {
    rotation: { x: 0, y: 0, z: 0 },
    scale: {
      x: 1,
      y: 1,
      z: 1,
      set(x: number, y: number, z: number): void {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    },
  };

  readonly ready: Promise<void> = Promise.resolve();

  private readonly canvas: HTMLCanvasElement;
  private orb: Renderer | null = null;
  private container: HTMLElement | null = null;
  private rafId = 0;
  private startTimeMs: number | null = null;
  private activity: Activity | null = null;
  private disposed = false;
  private lastRim = -1;
  private lastCore = -1;
  private pendingPalette: QPaletteValues | null = null;
  private readonly initialPaletteValues: QPaletteValues | undefined;

  constructor(options: AvatarOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.initialPaletteValues = options.initialPalette;
  }

  // --- ControllableAvatar -------------------------------------------------

  setParams(next: Partial<DeformationParams>): void {
    if (next.amplitude !== undefined) this.params.amplitude = next.amplitude;
    if (next.frequency !== undefined) this.params.frequency = next.frequency;
    if (next.speed !== undefined) this.params.speed = next.speed;
  }

  /** Glow is expressed through the orb's per-state bloom; kept for interface parity. */
  setGlow(_value: number): void {
    /* no-op: bloom comes from the orb state target */
  }

  /**
   * Drive the orb palette from the controller's per-state + mood colors (idle
   * navy/slate -> listening/speaking bright blue, plus mood tints). The
   * controller emits these every frame, but `setPalette` rebuilds a halo texture,
   * so we only flag a change here and apply it once per frame in `applyToOrb`,
   * and only when the hex actually changed.
   */
  setColors(rim: number, core: number): void {
    if (rim === this.lastRim && core === this.lastCore) return;
    this.lastRim = rim;
    this.lastCore = core;
    this.pendingPalette = paletteFromColors(rim, core);
  }

  // --- Avatar lifecycle (used by attachTauri) -----------------------------

  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.canvas);

    // Probe the WebGL backend once. Software rendering (SwiftShader / WARP, common
    // under Remote Desktop, a VM, or a blocklisted/broken GPU driver) rasterizes
    // the full-window orb on the CPU and pegs every core, so degrade to the light
    // preset when there is no real GPU. Log the renderer either way for diagnosis.
    const gpu = detectGpu();
    console.info(`[orb] WebGL renderer: ${gpu.renderer}${gpu.software ? ' -> software, using lite mode' : ''}`);

    const budget = gpu.software ? RENDER_BUDGETS.software : RENDER_BUDGETS.gpu;
    const dpr = clamp(window.devicePixelRatio || 1, budget.preset.minDpr, budget.dprCeiling);
    this.orb = createRenderer({
      canvas: this.canvas,
      preset: budget.preset,
      dpr,
      targetFps: budget.targetFps,
      filamentFrameStride: budget.filamentFrameStride,
      antialias: budget.antialias,
      initialState: ORB_STATES.idle,
      initialPalette: this.initialPaletteValues ?? 'cyan',
    });
    this.activity = 'idle';
  }

  resize(_width: number, _height: number): void {
    // The orb reads its canvas's own client size, which CSS sizes to the window.
    this.orb?.resize();
  }

  start(): void {
    if (this.rafId !== 0 || this.disposed) return;
    // stop() pauses the renderer's own loop; resume it so start() is symmetric
    // (otherwise a visibility-driven stop -> start would leave the orb frozen).
    this.orb?.setPaused(false);
    const loop = (nowMs: number): void => {
      this.rafId = requestAnimationFrame(loop);
      this.startTimeMs ??= nowMs;
      // The controller's tick expects SECONDS; rAF hands us ms.
      this.beforeRender?.((nowMs - this.startTimeMs) / 1000);
      this.applyToOrb();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.orb?.setPaused(true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.orb?.dispose();
    this.orb = null;
    if (this.container && this.canvas.parentNode === this.container) {
      this.canvas.remove();
    }
    this.container = null;
  }

  // --- Bridge -------------------------------------------------------------

  /** Push the controller's current scalars onto the orb (called after each tick). */
  private applyToOrb(): void {
    if (!this.orb) return;
    // Apply a queued palette change once per frame (setColors only flags it).
    if (this.pendingPalette) {
      this.orb.setPalette(this.pendingPalette);
      this.pendingPalette = null;
    }
    const next = activityFromSpeed(this.params.speed);
    if (next !== this.activity) {
      this.activity = next;
      this.orb.setState(this.calmed(ORB_STATES[next]));
    }
    // amplitude already folds in mic level (listening) + word impulses (speaking).
    const calm = this.reducedMotion ? 0.55 : 1;
    this.orb.setIntensityOverride(clamp(0.9 + this.params.amplitude * 1.2 * calm, 0.65, 2.0));
  }

  /** Gentle the rotation/particle motion when the user prefers reduced motion. */
  private calmed(target: QStateTarget): QStateTarget {
    if (!this.reducedMotion) return target;
    return {
      ...target,
      rotationSpeed: target.rotationSpeed * 0.4,
      particleSpeed: target.particleSpeed * 0.5,
      bloom: target.bloom * 0.85,
    };
  }
}
