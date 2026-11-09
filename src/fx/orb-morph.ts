// ═══════════════════════════════════════════════════════════════════════
// OrbMorph: partículas que FORMAN FIGURAS (Canvas 2D, cero dependencias).
//
// COMPOSICIÓN sobre OrbField, no fork: posee un OrbField interno sobre el
// mismo canvas y le delega TODO (agents/slots/theme/speaking/working/
// resize/start/stop/stats). Mientras todas las figuras sean 'sphere', el
// loop que corre es el upstream byte a byte. Cuando alguna esfera pide otra
// figura, se pausa el OrbField y corre el loop propio de morph — con la
// MISMA matemática de proyección (rotación, tilt, buckets de profundidad,
// followEnergy) para que la familia visual no cambie.
//
// Uso: drop-in donde hoy hay `new OrbField(canvas, {energy})`.
// ═══════════════════════════════════════════════════════════════════════

import {
  OrbAgent,
  OrbField,
  OrbSlot,
  OrbTheme,
  followEnergy,
  orbColorFromHue,
  particleCount,
  resolveOrbHues
} from '../lib/call-orbs.ts';
import {
  MorphShape,
  easeInOutCubic,
  generateShape,
  morphStep
} from './morph.ts';

// Estados visuales por agente (claves = protocolo orb.ts + work_event).
export type AgentVisualState = 'idle' | 'escuchando' | 'hablando' | 'pensando' | 'trabajando';

export const STATE_SHAPE: Record<AgentVisualState, MorphShape> = {
  idle: 'sphere',
  escuchando: 'ring',
  hablando: 'wave',
  pensando: 'torus',
  trabajando: 'cube'
};

export type OrbMorphOptions = {
  // Amplitud actual de la voz del agente que habla (0..1).
  energy: () => number;
  // Duración de la transición entre figuras (ms). Default 900.
  morphMs?: number;
};

const TAU = Math.PI * 2;
// Misma base de movimiento que call-orbs.ts (ver comentarios ahí):
// flotación ~7s, rotación una vuelta cada ~40s, tilt fijo.
const FLOAT_SPEED = 0.9;
const FLOAT_AMPLITUDE = 0.06;
const DRIFT_SPEED = 0.6;
const DRIFT_AMPLITUDE = 0.022;
const ROTATION_SPEED = 0.155;
const TILT = 0.42;
const JUMP_AMPLITUDE = 0.2;
const JUMP_SPEED = 6.5;
const ZOOM_AMPLITUDE = 0.07;
const BASE_RADIUS_RATIO = 0.78;
const DEPTH_ALPHA = [0.34, 0.52, 0.74, 1];
const BUCKETS = DEPTH_ALPHA.length;
const ORB_ALPHA_IDLE = 0.78;
const ORB_ALPHA_SPEAKING = 1;
const ORB_FOCUS_DIM = 0.62;
const ORB_FOCUS_WORKING = 0.9;
// Extras por figura (ver matriz shape×estado en research/visual-wow-plan.md).
const RING_PULSE_HZ = 2.2;
const RING_PULSE_AMP = 0.04;
const TORUS_SPIN = 2.5;
const WAVE_SPEED = 2.4;
const CUBE_TILT_SWING = 0.5;

type MorphOrb = {
  id: string;
  color: string;
  hue: number;
  shape: MorphShape;
  count: number;
  current: Float32Array;
  from: Float32Array;
  to: Float32Array;
  morphT0: number; // performance.now() del inicio, -1 = quieto
  slot: OrbSlot | null;
  phaseFloat: number;
  phaseRot: number;
  wavePhase: number;
  energy: number;
  target: number;
  focus: number;
};

export class OrbMorph {
  private field: OrbField;
  private ctx: CanvasRenderingContext2D | null;
  private options: OrbMorphOptions;
  private morphMs: number;
  private orbs: MorphOrb[] = [];
  private theme: OrbTheme = 'light';
  private speakingId = '';
  private workingIds = new Set<string>();
  private started = false;
  private raf = 0;
  private lastAt = 0;
  private clock = 0;
  private width = 0;
  private height = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private fpsValue = 0;

  constructor(canvas: HTMLCanvasElement, options: OrbMorphOptions) {
    this.options = options;
    this.morphMs = Math.max(120, options.morphMs ?? 900);
    this.field = new OrbField(canvas, { energy: options.energy });
    this.ctx = canvas.getContext('2d');
  }

  // Escape hatch: el OrbField interno (por si el main necesita algo crudo).
  get orbField(): OrbField {
    return this.field;
  }

  get prefersReducedMotion() {
    return this.field.prefersReducedMotion;
  }

  get running() {
    return this.field.running || this.raf !== 0;
  }

  // ── Delegación total al upstream ─────────────────────────────────────
  // Cada setter actualiza el OrbField Y el espejo de morph, así el cambio
  // de modo (sphere ↔ figuras) nunca pierde estado.

  setAgents(agents: OrbAgent[]) {
    this.field.setAgents(agents);
    const signature = agents.map((a) => a.id).join('|');
    const currentSig = this.orbs.map((o) => o.id).join('|');
    const hues = resolveOrbHues(agents.map((a) => a.color));
    if (signature === currentSig && this.orbs.length === agents.length) {
      agents.forEach((a, i) => { this.orbs[i].hue = hues[i]; this.orbs[i].color = orbColorFromHue(hues[i], this.theme); });
      return;
    }
    const previous = new Map(this.orbs.map((o) => [o.id, o]));
    this.orbs = agents.map((agent, index) => {
      const kept = previous.get(agent.id);
      if (kept) {
        kept.hue = hues[index];
        kept.color = orbColorFromHue(hues[index], this.theme);
        return kept;
      }
      const seed = (index * 2.117) % TAU;
      const empty = new Float32Array(0);
      return {
        id: agent.id,
        color: orbColorFromHue(hues[index], this.theme),
        hue: hues[index],
        shape: 'sphere' as MorphShape,
        count: 0,
        current: empty,
        from: empty,
        to: empty,
        morphT0: -1,
        slot: null,
        phaseFloat: (index * 1.371) % TAU,
        phaseRot: seed,
        wavePhase: 0,
        energy: 0,
        target: 0,
        focus: 1
      };
    });
    this.updateMode();
  }

  setSlots(slots: OrbSlot[]) {
    this.field.setSlots(slots);
    const byId = new Map(slots.map((s) => [s.id, s]));
    for (const orb of this.orbs) {
      const slot = byId.get(orb.id) || null;
      orb.slot = slot;
      if (!slot) continue;
      const count = particleCount(slot.r);
      if (count !== orb.count) {
        orb.count = count;
        orb.current = generateShape(orb.shape, count, { seed: orb.phaseRot, phase: orb.wavePhase });
        orb.from = orb.current.slice();
        orb.to = orb.current.slice();
        orb.morphT0 = -1;
      }
    }
    this.kick();
  }

  setTheme(theme: OrbTheme) {
    this.theme = theme;
    this.field.setTheme(theme);
    for (const orb of this.orbs) {
      orb.color = orbColorFromHue(orb.hue, theme);
    }
    this.kick();
  }

  setSpeaking(agentId: string) {
    this.speakingId = agentId;
    this.field.setSpeaking(agentId);
    this.kick();
  }

  setWorking(ids: string[]) {
    this.workingIds = new Set(ids);
    this.field.setWorking(ids);
    this.kick();
  }

  isWorking(agentId: string) {
    return this.field.isWorking(agentId);
  }

  resize(cssWidth: number, cssHeight: number) {
    this.field.resize(cssWidth, cssHeight);
    this.width = Math.max(1, Math.round(cssWidth));
    this.height = Math.max(1, Math.round(cssHeight));
    this.kick();
  }

  start() {
    this.started = true;
    this.updateMode();
  }

  stop() {
    this.started = false;
    this.field.stop();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.fpsValue = 0;
  }

  stats() {
    const base = this.field.stats();
    if (this.raf) {
      return {
        fps: Math.round(this.fpsValue),
        orbs: this.orbs.length,
        particles: this.orbs.reduce((t, o) => t + o.count, 0),
        mode: 'morph' as const
      };
    }
    return { ...base, mode: 'sphere' as const };
  }

  // ── Figuras ──────────────────────────────────────────────────────────

  // Cambia la figura global o de un agente. Con reduced-motion el cambio es
  // instantáneo (sin loop decorativo); si no, transiciona en morphMs.
  setShape(shape: MorphShape, agentId?: string) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const reduced = this.prefersReducedMotion;
    for (const orb of this.orbs) {
      if (agentId && orb.id !== agentId) continue;
      if (orb.shape === shape && orb.morphT0 < 0) continue;
      orb.shape = shape;
      if (orb.count === 0) continue;
      orb.from = orb.current.slice();
      orb.to = generateShape(shape, orb.count, { seed: orb.phaseRot, phase: orb.wavePhase });
      if (reduced) {
        orb.current = orb.to.slice();
        orb.from = orb.current.slice();
        orb.morphT0 = -1;
      } else {
        orb.morphT0 = now;
      }
    }
    this.updateMode();
    this.kick();
  }

  // Atajo estado → figura según STATE_SHAPE.
  setAgentState(agentId: string, state: AgentVisualState) {
    this.setShape(STATE_SHAPE[state], agentId);
  }

  getShape(agentId: string): MorphShape | null {
    return this.orbs.find((o) => o.id === agentId)?.shape ?? null;
  }

  // ── Cambio de modo ───────────────────────────────────────────────────
  // Solo un loop dibuja a la vez. Si nadie pide figuras, el OrbField corre
  // solo (comportamiento upstream intacto).

  private useMorph() {
    return this.orbs.some((o) => o.shape !== 'sphere' || o.morphT0 >= 0);
  }

  private updateMode() {
    if (!this.started) return;
    if (this.useMorph()) {
      this.field.stop();
      this.startMorphLoop();
    } else {
      this.stopMorphLoop();
      this.field.start();
    }
  }

  private startMorphLoop() {
    if (this.raf || !this.ctx) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.lastAt = performance.now();
    this.fpsFrames = 0;
    this.fpsSince = this.lastAt;
    this.raf = requestAnimationFrame(this.tick);
  }

  private stopMorphLoop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.fpsValue = 0;
  }

  private kick() {
    if (!this.started || !this.useMorph()) return;
    if (this.raf || !this.prefersReducedMotion) {
      if (!this.raf) this.startMorphLoop();
      return;
    }
    this.startMorphLoop();
  }

  private tick = (now: number) => {
    this.raf = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    this.clock += dt;
    const reduced = this.prefersReducedMotion;

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
      if (!orb.slot || orb.count === 0) continue;
      const speaking = orb.id === this.speakingId;
      const working = this.workingIds.has(orb.id);
      orb.target = speaking ? (reduced ? 1 : energy) : 0;
      orb.energy = followEnergy(orb.energy, orb.target, dt);
      const focusTarget = !this.speakingId || speaking
        ? 1
        : working ? ORB_FOCUS_WORKING : ORB_FOCUS_DIM;
      orb.focus = followEnergy(orb.focus, focusTarget, dt);
      if (Math.abs(orb.target - orb.energy) > 0.002 || Math.abs(focusTarget - orb.focus) > 0.002) {
        animating = true;
      }
      // Avance del morph.
      if (orb.morphT0 >= 0) {
        const t = (now - orb.morphT0) / this.morphMs;
        if (t >= 1) {
          orb.current = orb.to.slice();
          orb.from = orb.current.slice();
          orb.morphT0 = -1;
        } else {
          morphStep(orb.current, orb.from, orb.to, easeInOutCubic(t));
          animating = true;
        }
      }
      // La onda respira siempre (es su figura, no una transición).
      if (orb.shape === 'wave' && !reduced) {
        orb.wavePhase += dt * WAVE_SPEED * (0.5 + orb.energy);
        if (orb.morphT0 < 0) {
          orb.current = generateShape('wave', orb.count, { phase: orb.wavePhase });
        } else {
          orb.to = generateShape('wave', orb.count, { phase: orb.wavePhase });
        }
        animating = true;
      }
      this.drawOrb(ctx, orb);
    }

    if (!this.started) return;
    // Si el último morph terminó en sphere pura, volver al upstream.
    if (!this.useMorph()) {
      this.updateMode();
      return;
    }
    if (!reduced || animating) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.fpsValue = 0;
    }
  };

  private drawOrb(ctx: CanvasRenderingContext2D, orb: MorphOrb) {
    const slot = orb.slot;
    if (!slot) return;
    const reduced = this.prefersReducedMotion;
    const energy = orb.energy;
    const radius = slot.r * BASE_RADIUS_RATIO;
    let zoom = reduced ? 1 : 1 + ZOOM_AMPLITUDE * energy;
    let spin = ROTATION_SPEED;
    let tilt = TILT;
    let zScale = 1;
    // Extras por figura (la matriz del plan).
    if (orb.shape === 'ring' && !reduced) {
      zoom *= 1 + RING_PULSE_AMP * Math.sin(this.clock * TAU * RING_PULSE_HZ + orb.phaseFloat)
        + energy * 0.05;
    } else if (orb.shape === 'torus' && !reduced) {
      spin *= TORUS_SPIN;
      tilt += 0.18 * Math.sin(this.clock * 0.5 + orb.phaseFloat);
    } else if (orb.shape === 'cube' && !reduced) {
      tilt += CUBE_TILT_SWING * Math.sin(this.clock * 0.7 + orb.phaseFloat);
    } else if (orb.shape === 'wave') {
      // Hablando = la energy real modula la amplitud; en reposo, leve.
      zScale = reduced ? 1 : 0.35 + energy * 1.1;
    }
    const rotation = reduced ? orb.phaseRot : orb.phaseRot + this.clock * spin;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const cosTilt = Math.cos(tilt);
    const sinTilt = Math.sin(tilt);
    const cx = slot.cx + (reduced ? 0 : Math.sin(this.clock * DRIFT_SPEED + orb.phaseFloat * 1.3) * slot.r * DRIFT_AMPLITUDE);
    const cy = slot.cy + (reduced ? 0 : Math.sin(this.clock * FLOAT_SPEED + orb.phaseFloat) * slot.r * FLOAT_AMPLITUDE);
    const dot = Math.min(1.7, Math.max(0.6, slot.r * 0.015));
    const jump = reduced ? 0 : JUMP_AMPLITUDE * energy;
    const jumpClock = this.clock * JUMP_SPEED;

    // Proyección por partícula (igual que upstream: giro Y + tilt X).
    const count = orb.count;
    const pts = orb.current;
    const buckets: number[] = [];
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    const ss = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      const pz = pts[i * 3 + 2] * zScale;
      const x = px * cos + pz * sin;
      const zRot = pz * cos - px * sin;
      const y = py * cosTilt - zRot * sinTilt;
      const z = py * sinTilt + zRot * cosTilt;
      const w = jump > 0 ? jump * (0.55 + 0.45 * Math.sin(jumpClock + i * 0.7)) : 0;
      const scale = radius * (1 + w) * zoom;
      const depth = (z / 1.4 + 1) * 0.5; // figuras no unitarias: rango aprox
      xs[i] = cx + x * scale;
      ys[i] = cy + y * scale;
      ss[i] = dot * (0.7 + 0.55 * Math.min(1, Math.max(0, depth)));
      buckets.push(Math.min(BUCKETS - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, depth)) * BUCKETS))));
    }
    // Un fill() por bucket (igual que upstream: 4 pasadas, no N).
    const orbAlpha = (ORB_ALPHA_IDLE + (ORB_ALPHA_SPEAKING - ORB_ALPHA_IDLE) * energy) * orb.focus;
    ctx.fillStyle = orb.color;
    for (let b = 0; b < BUCKETS; b += 1) {
      ctx.beginPath();
      let drawn = false;
      for (let i = 0; i < count; i += 1) {
        if (buckets[i] !== b) continue;
        ctx.moveTo(xs[i] + ss[i], ys[i]);
        ctx.arc(xs[i], ys[i], ss[i], 0, TAU);
        drawn = true;
      }
      if (drawn) {
        ctx.globalAlpha = DEPTH_ALPHA[b] * orbAlpha;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
