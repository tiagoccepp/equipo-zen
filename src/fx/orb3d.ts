// ═══════════════════════════════════════════════════════════════════════
// Orb3D: MISMA API que OrbMorph pero con three.js Points (opt-in).
//
// El import de three es DINÁMICO (solo se carga si se usa), vía la factory
// async `createOrb3D`. Si no hay WebGL2, la factory tira un Error claro y
// el main usa OrbMorph (Canvas 2D garantizado).
//
// El morph es en CPU por frame (≤8 esferas × 720 pts: trivial) y se sube
// como BufferAttribute; nada de shaders custom que depurar en la webview.
// V3 (09/11, modelo-manda): los ESTADOS ya no piden figuras (todo esfera);
// solo modulan vibración. setGlyph intacto — única vía de figuras.
// ═══════════════════════════════════════════════════════════════════════

import {
  OrbAgent,
  OrbSlot,
  OrbTheme,
  followEnergy,
  orbColorFromHue,
  parseHexColor,
  particleCount,
  resolveOrbHues
} from '../lib/call-orbs.ts';
import {
  MorphShape,
  easeInOutCubic,
  generateShape,
  morphStep
} from './morph.ts';
import { AgentVisualState, STATE_SHAPE, STATE_VIBRATION } from './orb-morph.ts';
import { lookupGlyph } from './glyphs-a.ts';
import type * as THREE from 'three';

export type { AgentVisualState };
export { STATE_SHAPE, STATE_VIBRATION };
export type { MorphShape };

export type Orb3DOptions = {
  energy: () => number;
  morphMs?: number;
};

export type WebGLProbe = {
  ok: boolean;
  renderer: string;
  error: string;
};

// Sonda SIN three (barata): el main la llama para decidir Orb3D vs OrbMorph.
// Usa un canvas temporal: jamás toca el canvas real (pedir dos contextos
// distintos sobre el mismo canvas es un error).
export function probeWebGL2(): WebGLProbe {
  try {
    if (typeof document === 'undefined') {
      return { ok: false, renderer: '', error: 'sin DOM' };
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      return { ok: false, renderer: '', error: 'getContext(webgl2) devolvió null' };
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '')
      : String(gl.getParameter(gl.RENDERER) || '');
    // Contexto temporal: se pierde solo al soltar la referencia.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, renderer, error: '' };
  } catch (error) {
    return { ok: false, renderer: '', error: String(error) };
  }
}

const TAU = Math.PI * 2;
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
const ORB_ALPHA_IDLE = 0.78;
const ORB_ALPHA_SPEAKING = 1;
const ORB_FOCUS_DIM = 0.62;
const ORB_FOCUS_WORKING = 0.9;
const RING_PULSE_HZ = 2.2;
const RING_PULSE_AMP = 0.04;
const TORUS_SPIN = 2.5;
const WAVE_SPEED = 2.4;
const CUBE_TILT_SWING = 0.5;

type Points3D = {
  id: string;
  color: string;
  hue: number;
  shape: MorphShape;
  glyph: string | null; // T2a: glifo activo (null = figura clásica)
  count: number;
  current: Float32Array;
  from: Float32Array;
  to: Float32Array;
  morphT0: number;
  slot: OrbSlot | null;
  phaseFloat: number;
  phaseRot: number;
  wavePhase: number;
  energy: number;
  target: number;
  focus: number;
  vibe: number; // V3: vibración por estado (0..1), nunca cambia figura
  points: THREE.Points | null;
  geometry: THREE.BufferGeometry | null;
  material: THREE.PointsMaterial | null;
};

// Target de morph glyph-aware (T2a, espejo de orb-morph.ts).
function orbTargetPoints(shape: MorphShape, glyph: string | null, count: number, seed: number, phase: number): Float32Array {
  if (glyph) {
    const found = lookupGlyph(glyph);
    if (found) return found.points(count, seed);
  }
  return generateShape(shape, count, { seed, phase });
}

export class Orb3D {
  private T: typeof THREE;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private options: Orb3DOptions;
  private morphMs: number;
  private orbs: Points3D[] = [];
  private theme: OrbTheme = 'light';
  private speakingId = '';
  private workingIds = new Set<string>();
  private reduced = false;
  private reducedMedia: MediaQueryList | null = null;
  private started = false;
  private raf = 0;
  private lastAt = 0;
  private clock = 0;
  private width = 0;
  private height = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private fpsValue = 0;
  private disposed = false;

  // No construir directo: usar createOrb3D (detecta WebGL2 + import dinámico).
  constructor(
    canvas: HTMLCanvasElement,
    options: Orb3DOptions,
    three: typeof THREE,
    renderer: THREE.WebGLRenderer
  ) {
    this.T = three;
    this.options = options;
    this.morphMs = Math.max(120, options.morphMs ?? 900);
    this.renderer = renderer;
    this.scene = new three.Scene();
    // Cámara ortho con Y hacia abajo = píxeles CSS directos, igual que 2D.
    this.camera = new three.OrthographicCamera(0, 1, -1, 0, -10, 10);
    this.camera.position.z = 5;
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

  get running() {
    return this.raf !== 0;
  }

  setAgents(agents: OrbAgent[]) {
    const signature = agents.map((a) => `${a.id}:${a.color}`).join('|');
    const currentSig = this.orbs.map((o) => `${o.id}:${o.color}`).join('|');
    if (signature === currentSig) return;
    const hues = resolveOrbHues(agents.map((a) => a.color));
    const previous = new Map(this.orbs.map((o) => [o.id, o]));
    for (const orb of this.orbs) {
      if (!agents.some((a) => a.id === orb.id)) this.destroyOrb(orb);
    }
    this.orbs = agents.map((agent, index) => {
      const kept = previous.get(agent.id);
      if (kept && agents.some((a) => a.id === kept.id)) {
        kept.hue = hues[index];
        kept.color = orbColorFromHue(hues[index], this.theme);
        return kept;
      }
      const empty = new Float32Array(0);
      return {
        id: agent.id,
        color: orbColorFromHue(hues[index], this.theme),
        hue: hues[index],
        shape: 'sphere' as MorphShape,
        glyph: null,
        count: 0,
        current: empty,
        from: empty,
        to: empty,
        morphT0: -1,
        slot: null,
        phaseFloat: (index * 1.371) % TAU,
        phaseRot: (index * 2.117) % TAU,
        wavePhase: 0,
        energy: 0,
        target: 0,
        focus: 1,
        vibe: 0,
        points: null,
        geometry: null,
        material: null
      };
    });
    this.kick();
  }

  setSlots(slots: OrbSlot[]) {
    const byId = new Map(slots.map((s) => [s.id, s]));
    for (const orb of this.orbs) {
      const slot = byId.get(orb.id) || null;
      orb.slot = slot;
      if (!slot) continue;
      const count = particleCount(slot.r);
      if (count !== orb.count) {
        orb.count = count;
        orb.current = orbTargetPoints(orb.shape, orb.glyph, count, orb.phaseRot, orb.wavePhase);
        orb.from = orb.current.slice();
        orb.to = orb.current.slice();
        orb.morphT0 = -1;
        this.buildPoints(orb);
      }
    }
    this.kick();
  }

  setTheme(theme: OrbTheme) {
    if (this.theme === theme) return;
    this.theme = theme;
    for (const orb of this.orbs) {
      orb.color = orbColorFromHue(orb.hue, theme);
    }
    this.kick();
  }

  setSpeaking(agentId: string) {
    if (this.speakingId === agentId) return;
    this.speakingId = agentId;
    this.kick();
  }

  setWorking(ids: string[]) {
    this.workingIds = new Set(ids);
    this.kick();
  }

  isWorking(agentId: string) {
    return this.workingIds.has(agentId);
  }

  resize(cssWidth: number, cssHeight: number) {
    const w = Math.max(1, Math.round(cssWidth));
    const h = Math.max(1, Math.round(cssHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = 0;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  start() {
    if (this.disposed) return;
    this.started = true;
    this.kick();
  }

  stop() {
    this.started = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.fpsValue = 0;
  }

  stats() {
    return {
      fps: Math.round(this.fpsValue),
      orbs: this.orbs.length,
      particles: this.orbs.reduce((t, o) => t + o.count, 0),
      mode: 'webgl' as const
    };
  }

  setShape(shape: MorphShape, agentId?: string) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    for (const orb of this.orbs) {
      if (agentId && orb.id !== agentId) continue;
      if (orb.shape === shape && orb.morphT0 < 0 && orb.glyph === null) continue;
      orb.shape = shape;
      orb.glyph = null; // T2a: setShape vuelve a figura clásica (limpia glifo)
      if (orb.count === 0) continue;
      orb.from = orb.current.slice();
      orb.to = generateShape(shape, orb.count, { seed: orb.phaseRot, phase: orb.wavePhase });
      if (this.reduced) {
        orb.current = orb.to.slice();
        orb.from = orb.current.slice();
        orb.morphT0 = -1;
      } else {
        orb.morphT0 = now;
      }
    }
    this.kick();
  }

  // V3 modelo-manda: estado → vibración, NUNCA figura (espejo de OrbMorph).
  // setShape limpia el glifo; setAgentState NO (el glifo del modelo intacto).
  setAgentState(agentId: string, state: AgentVisualState) {
    const vibe = STATE_VIBRATION[state] ?? 0;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    for (const orb of this.orbs) {
      if (orb.id !== agentId) continue;
      orb.vibe = vibe;
      if (orb.shape !== 'sphere') {
        if (orb.glyph === null && orb.count > 0) {
          orb.shape = 'sphere';
          orb.from = orb.current.slice();
          orb.to = generateShape('sphere', orb.count, { seed: orb.phaseRot, phase: orb.wavePhase });
          if (this.reduced) {
            orb.current = orb.to.slice();
            orb.from = orb.current.slice();
            orb.morphT0 = -1;
          } else {
            orb.morphT0 = now;
          }
        } else {
          orb.shape = 'sphere';
        }
      }
    }
    this.kick();
  }

  getShape(agentId: string): MorphShape | null {
    return this.orbs.find((o) => o.id === agentId)?.shape ?? null;
  }

  // ── Glifos (T2a: motor de gestos, espejo de OrbMorph) ─────────────────
  // Mismo contrato: morph al glifo, fallback a esfera si el nombre no
  // resuelve, nunca tira. V3: setAgentState NO limpia el glifo.
  setGlyph(agentId: string, glyphName: string | null) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const reduced = this.reduced;
    const glyph = glyphName ? lookupGlyph(glyphName) : null;
    for (const orb of this.orbs) {
      if (orb.id !== agentId) continue;
      if (!glyph) {
        if (orb.glyph === null && orb.morphT0 < 0) continue;
        orb.glyph = null;
        if (orb.count === 0) continue;
        orb.from = orb.current.slice();
        orb.to = generateShape(orb.shape, orb.count, { seed: orb.phaseRot, phase: orb.wavePhase });
      } else {
        if (orb.glyph === glyph.name && orb.morphT0 < 0) continue;
        orb.glyph = glyph.name;
        if (orb.count === 0) continue;
        orb.from = orb.current.slice();
        orb.to = glyph.points(orb.count, orb.phaseRot);
      }
      if (reduced) {
        orb.current = orb.to.slice();
        orb.from = orb.current.slice();
        orb.morphT0 = -1;
      } else {
        orb.morphT0 = now;
      }
    }
    this.kick();
  }

  getGlyph(agentId: string): string | null {
    return this.orbs.find((o) => o.id === agentId)?.glyph ?? null;
  }

  dispose() {
    this.stop();
    this.disposed = true;
    for (const orb of this.orbs) this.destroyOrb(orb);
    this.orbs = [];
    this.reducedMedia?.removeEventListener('change', this.onReducedChange);
    this.renderer.dispose();
  }

  // ── Internos ─────────────────────────────────────────────────────────

  private buildPoints(orb: Points3D) {
    this.destroyOrbPoints(orb);
    if (orb.count === 0) return;
    const geometry = new this.T.BufferGeometry();
    geometry.setAttribute('position', new this.T.BufferAttribute(new Float32Array(orb.count * 3), 3));
    geometry.setAttribute('color', new this.T.BufferAttribute(new Float32Array(orb.count * 3), 3));
    const material = new this.T.PointsMaterial({
      size: 1.2,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: false
    });
    const points = new this.T.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = this.orbs.indexOf(orb);
    points.userData['orbId'] = orb.id;
    this.scene.add(points);
    orb.geometry = geometry;
    orb.material = material;
    orb.points = points;
  }

  private destroyOrbPoints(orb: Points3D) {
    if (orb.points) this.scene.remove(orb.points);
    orb.geometry?.dispose();
    orb.material?.dispose();
    orb.points = null;
    orb.geometry = null;
    orb.material = null;
  }

  private destroyOrb(orb: Points3D) {
    this.destroyOrbPoints(orb);
  }

  private kick() {
    if (!this.started || this.raf || this.disposed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.lastAt = performance.now();
    this.fpsFrames = 0;
    this.fpsSince = this.lastAt;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed || !this.started) return;
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
    let animating = this.workingIds.size > 0;
    for (const orb of this.orbs) {
      if (!orb.slot || orb.count === 0 || !orb.points) continue;
      const speaking = orb.id === this.speakingId;
      const working = this.workingIds.has(orb.id);
      orb.target = speaking ? (this.reduced ? 1 : energy) : 0;
      orb.energy = followEnergy(orb.energy, orb.target, dt);
      const focusTarget = !this.speakingId || speaking
        ? 1
        : working ? ORB_FOCUS_WORKING : ORB_FOCUS_DIM;
      orb.focus = followEnergy(orb.focus, focusTarget, dt);
      if (Math.abs(orb.target - orb.energy) > 0.002 || Math.abs(focusTarget - orb.focus) > 0.002) {
        animating = true;
      }
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
      // T2a: la onda respira salvo que haya un glifo activo (el glifo manda).
      if (orb.shape === 'wave' && !this.reduced && orb.glyph === null) {
        orb.wavePhase += dt * WAVE_SPEED * (0.5 + orb.energy);
        if (orb.morphT0 < 0) {
          orb.current = generateShape('wave', orb.count, { phase: orb.wavePhase });
        } else {
          orb.to = generateShape('wave', orb.count, { phase: orb.wavePhase });
        }
        animating = true;
      }
      this.writeOrb(orb);
      if (orb.material) {
        orb.material.opacity = (ORB_ALPHA_IDLE + (ORB_ALPHA_SPEAKING - ORB_ALPHA_IDLE) * orb.energy) * orb.focus;
      }
    }

    this.renderer.render(this.scene, this.camera);
    if (!this.reduced || animating) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.fpsValue = 0;
    }
  };

  // Proyección CPU idéntica a la 2D → mismos píxeles (salvo AA de cada lado).
  private writeOrb(orb: Points3D) {
    const slot = orb.slot;
    const geometry = orb.geometry;
    if (!slot || !geometry) return;
    const reduced = this.reduced;
    const energy = orb.energy;
    const vibe = orb.vibe ?? 0; // V3: vibración por estado
    const drive = Math.max(energy, vibe * 0.8);
    const radius = slot.r * BASE_RADIUS_RATIO;
    let zoom = reduced ? 1 : 1 + ZOOM_AMPLITUDE * drive;
    if (!reduced && vibe > 0) {
      zoom *= 1 + vibe * 0.05 * Math.sin(this.clock * 9 + orb.phaseFloat);
    }
    let spin = ROTATION_SPEED;
    let tilt = TILT;
    let zScale = 1;
    if (orb.shape === 'ring' && !reduced) {
      zoom *= 1 + RING_PULSE_AMP * Math.sin(this.clock * TAU * RING_PULSE_HZ + orb.phaseFloat)
        + energy * 0.05;
    } else if (orb.shape === 'torus' && !reduced) {
      spin *= TORUS_SPIN;
      tilt += 0.18 * Math.sin(this.clock * 0.5 + orb.phaseFloat);
    } else if (orb.shape === 'cube' && !reduced) {
      tilt += CUBE_TILT_SWING * Math.sin(this.clock * 0.7 + orb.phaseFloat);
    } else if (orb.shape === 'wave') {
      zScale = reduced ? 1 : 0.35 + energy * 1.1;
    }
    const rotation = reduced ? orb.phaseRot : orb.phaseRot + this.clock * spin;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const cosTilt = Math.cos(tilt);
    const sinTilt = Math.sin(tilt);
    const cx = slot.cx + (reduced ? 0 : Math.sin(this.clock * DRIFT_SPEED + orb.phaseFloat * 1.3) * slot.r * DRIFT_AMPLITUDE);
    const cy = slot.cy + (reduced ? 0 : Math.sin(this.clock * FLOAT_SPEED + orb.phaseFloat) * slot.r * FLOAT_AMPLITUDE);
    const jump = reduced ? 0 : JUMP_AMPLITUDE * drive;
    const jumpClock = this.clock * JUMP_SPEED;
    const jx = !reduced && vibe > 0 ? Math.sin(this.clock * 31 + orb.phaseFloat * 3) * slot.r * vibe * 0.012 : 0;
    const jy = !reduced && vibe > 0 ? Math.cos(this.clock * 27 + orb.phaseFloat * 2) * slot.r * vibe * 0.012 : 0;

    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = geometry.getAttribute('color') as THREE.BufferAttribute;
    const base = parseHexColor(orb.color) ?? { r: 0.5, g: 0.5, b: 0.5 };
    const pts = orb.current;
    for (let i = 0; i < orb.count; i += 1) {
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      const pz = pts[i * 3 + 2] * zScale;
      const x = px * cos + pz * sin;
      const zRot = pz * cos - px * sin;
      const y = py * cosTilt - zRot * sinTilt;
      const z = py * sinTilt + zRot * cosTilt;
      const w = jump > 0 ? jump * (0.55 + 0.45 * Math.sin(jumpClock + i * 0.7)) : 0;
      const scale = radius * (1 + w) * zoom;
      const depth = Math.min(1, Math.max(0, (z / 1.4 + 1) * 0.5));
      pos.setXYZ(i, cx + jx + x * scale, -((cy + jy) + y * scale), depth * 2 - 1);
      // Buckets de profundidad 2D ≈ sombreado por vértice (4 escalones).
      const shade = [0.34, 0.52, 0.74, 1][Math.min(3, Math.floor(depth * 4))];
      col.setXYZ(i, base.r * shade, base.g * shade, base.b * shade);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    if (orb.material) {
      orb.material.size = Math.min(1.7, Math.max(0.6, slot.r * 0.015)) * this.renderer.getPixelRatio();
    }
  }
}

// Factory: detecta WebGL2, importa three dinámico, construye. Si algo falla,
// el Error le dice al main exactamente por qué (y que use OrbMorph).
export async function createOrb3D(
  canvas: HTMLCanvasElement,
  options: Orb3DOptions
): Promise<Orb3D> {
  const probe = probeWebGL2();
  if (!probe.ok) {
    throw new Error(`Orb3D necesita WebGL2 (${probe.error}). Usar OrbMorph (Canvas 2D).`);
  }
  let three: typeof THREE;
  try {
    three = await import('three');
  } catch (error) {
    throw new Error(`Orb3D no pudo cargar three (${String(error)}). Usar OrbMorph (Canvas 2D).`);
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new three.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (error) {
    throw new Error(`Orb3D no pudo crear el renderer (${String(error)}). Usar OrbMorph (Canvas 2D).`);
  }
  return new Orb3D(canvas, options, three, renderer);
}
