import * as THREE from 'three';
import type { ScenePart, SceneSpec, SceneStep, Vec3 } from './spec.ts';

interface PartRecord {
  spec: ScenePart;
  mesh?: THREE.Mesh;
  group: THREE.Object3D;
  base: THREE.Vector3;
  explode: THREE.Vector3;
  labelEl?: HTMLDivElement;
  dimmable: THREE.Material[];
  baseOpacity: number[];
  baseEmissive: THREE.Color[];
}

interface CamState {
  theta: number;
  phi: number;
  radius: number;
  target: THREE.Vector3;
  fov: number;
}

export interface RenderOptions {
  container: HTMLElement;
  labelsLayer: HTMLElement;
  onExplode?: (t: number) => void;
  onStep?: (index: number, step: SceneStep | null) => void;
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function v3(a: Vec3 | undefined, d: Vec3 = [0, 0, 0]) {
  const x = a ?? d;
  return new THREE.Vector3(x[0] || 0, x[1] || 0, x[2] || 0);
}

function makeGeometry(part: ScenePart): THREE.BufferGeometry | null {
  const seg = Math.round(clamp(part.radialSegments ?? 28, 8, 64));
  switch (part.kind) {
    case 'box': {
      const s = part.size ?? [0.2, 0.2, 0.2];
      return new THREE.BoxGeometry(s[0], s[1], s[2]);
    }
    case 'plane': {
      const s = part.size ?? [0.4, 0.4, 0.001];
      return new THREE.PlaneGeometry(s[0], s[1]);
    }
    case 'cylinder': {
      return new THREE.CylinderGeometry(part.radius ?? 0.1, part.radius ?? 0.1, part.height ?? 0.2, seg);
    }
    case 'tube': {
      return new THREE.CylinderGeometry(part.radius ?? 0.1, part.radius ?? 0.1, part.height ?? 0.2, seg, 1, true);
    }
    case 'sphere': {
      return new THREE.SphereGeometry(part.radius ?? 0.12, seg, Math.max(8, Math.round(seg / 1.5)));
    }
    case 'cone': {
      return new THREE.ConeGeometry(part.radius ?? 0.1, part.height ?? 0.2, seg);
    }
    case 'torus': {
      const r = part.radius ?? 0.1;
      const tube = part.height ?? r * 0.3;
      return new THREE.TorusGeometry(r, tube, Math.max(8, Math.round(seg / 2)), seg);
    }
    case 'group':
      return null;
    default:
      return null;
  }
}

export class SceneRenderer {
  private container: HTMLElement;
  private labelsLayer: HTMLElement;
  private onExplode?: (t: number) => void;
  private onStep?: (index: number, step: SceneStep | null) => void;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  private parts = new Map<string, PartRecord>();
  private spec: SceneSpec | null = null;

  private raf = 0;
  private running = false;
  private needsRender = true;

  private explode = 0;
  private explodeFrom = 0;
  private explodeTo = 0;
  private explodeT0 = 0;
  private explodeDur = 0;

  private cam: CamState;
  private camAnim: { from: CamState; to: CamState; t0: number; dur: number } | null = null;

  private dragging = false;
  private dragMode: 'orbit' | 'pan' = 'orbit';
  private lastX = 0;
  private lastY = 0;

  private highlightSet: Set<string> | null = null;
  private steps: SceneStep[] = [];
  private stepIndex = -1;
  private playing = false;
  private stepTimer: number | null = null;
  private stepRunId = 0;

  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private visible = true;
  private hidden = typeof document !== 'undefined' ? document.hidden : false;

  constructor(opts: RenderOptions) {
    this.container = opts.container;
    this.labelsLayer = opts.labelsLayer;
    this.onExplode = opts.onExplode;
    this.onStep = opts.onStep;

    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 100);
    this.cam = { theta: Math.PI / 4, phi: 1.1, radius: 3, target: new THREE.Vector3(0, 0.1, 0), fov: 40 };
    this.applyCam();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#0e1013');
    this.scene.add(this.root);
    this.addLights();

    this.bindEvents();
    this.start();
  }

  private addLights() {
    const hemi = new THREE.HemisphereLight(0xdde8ff, 0x1a1d22, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd6ff, 0.45);
    fill.position.set(-3, 2, -2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9fd8c6, 0.35);
    rim.position.set(-1, 3, 4);
    this.scene.add(rim);
  }

  private bindEvents() {
    const el = this.renderer.domElement;
    const onDown = (e: PointerEvent) => {
      this.dragging = true;
      this.dragMode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragMode === 'orbit') {
        this.cam.theta -= dx * 0.006;
        this.cam.phi = clamp(this.cam.phi - dy * 0.006, 0.15, Math.PI - 0.15);
      } else {
        const s = this.cam.radius * 0.0016;
        const right = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        this.camera.getWorldDirection(right);
        right.crossVectors(right, up).normalize();
        this.cam.target.addScaledVector(right, -dx * s);
        this.cam.target.addScaledVector(up, dy * s);
      }
      this.needsRender = true;
    };
    const onUp = () => { this.dragging = false; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0012);
      this.cam.radius = clamp(this.cam.radius * f, 0.2, 80);
      this.needsRender = true;
    };
    const onContext = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);

    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        this.needsRender = true;
      }, { threshold: 0.01 });
      this.io.observe(this.container);
    }

    const onVis = () => {
      this.hidden = document.hidden;
      this.needsRender = true;
    };
    document.addEventListener('visibilitychange', onVis);

    (this as any)._cleanup = () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  private applyCam() {
    const c = this.cam;
    const sinPhi = Math.sin(c.phi);
    this.camera.position.set(
      c.target.x + c.radius * sinPhi * Math.cos(c.theta),
      c.target.y + c.radius * Math.cos(c.phi),
      c.target.z + c.radius * sinPhi * Math.sin(c.theta)
    );
    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(c.target);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    this.needsRender = true;
  }

  load(spec: SceneSpec) {
    this.stopPlayback();
    this.clearScene();
    this.spec = spec;
    this.steps = Array.isArray(spec.steps) ? [...spec.steps] : [];
    this.stepIndex = -1;

    const records: PartRecord[] = [];
    for (const p of spec.parts) {
      const g = new THREE.Group();
      g.position.set(p.position[0], p.position[1], p.position[2]);
      const rot = p.rotation ?? [0, 0, 0];
      g.rotation.set(rot[0], rot[1], rot[2]);

      const geom = makeGeometry(p);
      let mesh: THREE.Mesh | undefined;
      const dimmable: THREE.Material[] = [];
      const baseOpacity: number[] = [];
      const baseEmissive: THREE.Color[] = [];

      if (geom) {
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(p.color || '#8d949c'),
          metalness: clamp(p.metalness ?? 0.4, 0, 1),
          roughness: clamp(p.roughness ?? 0.5, 0, 1),
          transparent: (p.opacity ?? 1) < 1,
          opacity: clamp(p.opacity ?? 1, 0.05, 1),
          side: p.kind === 'plane' || p.kind === 'tube' ? THREE.DoubleSide : THREE.FrontSide
        });
        mesh = new THREE.Mesh(geom, mat);
        g.add(mesh);
        dimmable.push(mat);
        baseOpacity.push(mat.opacity);
        baseEmissive.push(mat.emissive.clone());
      }

      let labelEl: HTMLDivElement | undefined;
      if (p.label) {
        labelEl = document.createElement('div');
        labelEl.className = 'stage-label';
        labelEl.textContent = p.label;
        this.labelsLayer.appendChild(labelEl);
      }

      const rec: PartRecord = {
        spec: p,
        mesh,
        group: g,
        base: new THREE.Vector3(p.position[0], p.position[1], p.position[2]),
        explode: v3(p.explode, [0, 0, 0]),
        labelEl,
        dimmable,
        baseOpacity,
        baseEmissive
      };
      this.parts.set(p.id, rec);
      records.push(rec);
    }

    // Build hierarchy (parents). Children stay in their local group; parent group owns them.
    for (const rec of records) {
      const parentId = rec.spec.parent;
      if (parentId && this.parts.has(parentId)) {
        this.parts.get(parentId)!.group.add(rec.group);
      } else {
        this.root.add(rec.group);
      }
    }

    this.fitToSpec(spec);
    this.highlight(null);
    this.setExplodeImmediate(0);
    this.needsRender = true;
  }

  private fitToSpec(spec: SceneSpec) {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    if (!box.isEmpty()) {
      box.getSize(size);
      box.getCenter(center);
    } else {
      size.set(1, 1, 1);
      center.set(0, 0, 0);
    }
    const diag = Math.max(size.length(), 0.5);
    const cam = spec.camera;
    if (cam) {
      this.cam.target.set(cam.target[0], cam.target[1], cam.target[2]);
      const pos = new THREE.Vector3(cam.position[0], cam.position[1], cam.position[2]);
      const off = pos.clone().sub(this.cam.target);
      this.cam.radius = Math.max(0.2, off.length() || diag * 1.4);
      this.cam.phi = clamp(Math.acos(clamp(off.y / this.cam.radius, -1, 1)), 0.15, Math.PI - 0.15);
      this.cam.theta = Math.atan2(off.z, off.x || 1e-6);
      this.cam.fov = clamp(cam.fov ?? 40, 20, 100);
    } else {
      this.cam.target.copy(center);
      this.cam.radius = diag * 1.4;
      this.cam.theta = Math.PI / 4;
      this.cam.phi = 1.05;
      this.cam.fov = 40;
    }
    this.camera.near = Math.max(0.01, this.cam.radius / 200);
    this.camera.far = Math.max(50, this.cam.radius * 40);
    this.applyCam();
  }

  private clearScene() {
    for (const rec of this.parts.values()) {
      if (rec.labelEl?.parentNode) rec.labelEl.parentNode.removeChild(rec.labelEl);
      if (rec.mesh) {
        rec.mesh.geometry.dispose();
      }
      for (const m of rec.dimmable) m.dispose();
    }
    this.parts.clear();
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    this.labelsLayer.innerHTML = '';
  }

  setExplode(t: number, duration = 450) {
    const target = clamp(t, 0, 3);
    this.explodeFrom = this.explode;
    this.explodeTo = target;
    this.explodeT0 = performance.now();
    this.explodeDur = Math.max(0, duration);
    this.needsRender = true;
  }

  setExplodeImmediate(t: number) {
    this.explode = this.explodeFrom = this.explodeTo = clamp(t, 0, 3);
    this.explodeDur = 0;
    this.applyExplode();
    this.onExplode?.(this.explode);
    this.needsRender = true;
  }

  getExplode() {
    return this.explode;
  }

  private applyExplode() {
    for (const rec of this.parts.values()) {
      const e = rec.explode;
      rec.group.position.set(
        rec.base.x + e.x * this.explode,
        rec.base.y + e.y * this.explode,
        rec.base.z + e.z * this.explode
      );
    }
  }

  highlight(ids: string[] | null) {
    this.highlightSet = ids && ids.length ? new Set(ids) : null;
    for (const [id, rec] of this.parts) {
      const lit = !this.highlightSet || this.highlightSet.has(id);
      rec.dimmable.forEach((m, i) => {
        const mat = m as THREE.MeshStandardMaterial;
        mat.opacity = lit ? rec.baseOpacity[i] : Math.max(0.08, rec.baseOpacity[i] * 0.18);
        mat.transparent = mat.opacity < 0.999;
        if ('emissiveIntensity' in mat) (mat as any).emissiveIntensity = lit ? 0 : 0;
        mat.needsUpdate = true;
      });
      if (rec.labelEl) rec.labelEl.classList.toggle('is-dim', !lit);
    }
    this.needsRender = true;
  }

  focus(ids?: string[]) {
    const targets = ids && ids.length ? ids : [...this.parts.keys()];
    const box = new THREE.Box3();
    let any = false;
    for (const id of targets) {
      const rec = this.parts.get(id);
      if (!rec) continue;
      const b = new THREE.Box3().setFromObject(rec.group);
      if (!b.isEmpty()) { box.union(b); any = true; }
    }
    if (!any) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.max(size.length(), 0.3) * 1.6;
    this.animateCamera({ target: center, radius: dist }, 500);
  }

  private animateCamera(partial: Partial<CamState>, dur = 600) {
    const to: CamState = {
      theta: partial.theta ?? this.cam.theta,
      phi: partial.phi ?? this.cam.phi,
      radius: partial.radius ?? this.cam.radius,
      target: (partial.target ?? this.cam.target).clone(),
      fov: partial.fov ?? this.cam.fov
    };
    this.camAnim = {
      from: { theta: this.cam.theta, phi: this.cam.phi, radius: this.cam.radius, target: this.cam.target.clone(), fov: this.cam.fov },
      to,
      t0: performance.now(),
      dur: Math.max(0, dur)
    };
    this.needsRender = true;
  }

  goToStep(index: number) {
    if (!this.steps.length) return;
    const i = clamp(Math.round(index), 0, this.steps.length - 1);
    this.stepIndex = i;
    const step = this.steps[i];
    if (step.explode != null) this.setExplode(step.explode, 600);
    this.highlight(step.highlight ?? null);
    if (step.camera) {
      const pos = new THREE.Vector3(step.camera.position[0], step.camera.position[1], step.camera.position[2]);
      const tgt = new THREE.Vector3(step.camera.target[0], step.camera.target[1], step.camera.target[2]);
      const off = pos.clone().sub(tgt);
      const radius = Math.max(0.2, off.length());
      this.animateCamera({
        target: tgt,
        radius,
        phi: clamp(Math.acos(clamp(off.y / radius, -1, 1)), 0.15, Math.PI - 0.15),
        theta: Math.atan2(off.z, off.x || 1e-6),
        fov: clamp(step.camera.fov ?? this.cam.fov, 20, 100)
      }, 650);
    }
    this.onStep?.(i, step);
    this.needsRender = true;
  }

  getStepIndex() {
    return this.stepIndex;
  }

  playSteps(from = 0) {
    if (!this.steps.length) return;
    this.stopPlayback(false);
    this.playing = true;
    const run = ++this.stepRunId;
    const playAt = (i: number) => {
      if (!this.playing || run !== this.stepRunId) return;
      if (i >= this.steps.length) { this.playing = false; this.onStep?.(this.stepIndex, this.steps[this.stepIndex] ?? null); return; }
      this.goToStep(i);
      const dur = clamp(this.steps[i].duration ?? 4200, 400, 60000);
      this.stepTimer = window.setTimeout(() => playAt(i + 1), dur);
    };
    playAt(clamp(from, 0, this.steps.length - 1));
  }

  pauseSteps() {
    this.stopPlayback(false);
  }

  private stopPlayback(emit = true) {
    this.playing = false;
    this.stepRunId += 1;
    if (this.stepTimer != null) {
      window.clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    if (emit) this.onStep?.(this.stepIndex, this.steps[this.stepIndex] ?? null);
  }

  reset() {
    this.stopPlayback(false);
    this.stepIndex = -1;
    this.highlight(null);
    if (this.spec) this.fitToSpec(this.spec);
    this.setExplode(0, 500);
    this.onStep?.(-1, null);
  }

  private shouldTick() {
    return this.running && this.visible && !this.hidden;
  }

  private update(now: number) {
    let changed = false;
    if (this.explodeDur > 0) {
      const t = clamp((now - this.explodeT0) / this.explodeDur, 0, 1);
      const k = easeInOut(t);
      this.explode = lerp(this.explodeFrom, this.explodeTo, k);
      this.applyExplode();
      this.onExplode?.(this.explode);
      if (t >= 1) this.explodeDur = 0;
      changed = true;
    }
    if (this.camAnim) {
      const { from, to, t0, dur } = this.camAnim;
      const t = dur <= 0 ? 1 : clamp((now - t0) / dur, 0, 1);
      const k = easeInOut(t);
      this.cam.theta = lerp(from.theta, to.theta, k);
      this.cam.phi = lerp(from.phi, to.phi, k);
      this.cam.radius = lerp(from.radius, to.radius, k);
      this.cam.fov = lerp(from.fov, to.fov, k);
      this.cam.target.lerpVectors(from.target, to.target, k);
      if (t >= 1) this.camAnim = null;
      changed = true;
    }
    if (changed) this.needsRender = true;
  }

  private updateLabels() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const tmp = new THREE.Vector3();
    for (const rec of this.parts.values()) {
      if (!rec.labelEl) continue;
      rec.group.getWorldPosition(tmp);
      tmp.project(this.camera);
      const onScreen = tmp.z > -1 && tmp.z < 1;
      if (!onScreen) { rec.labelEl.style.display = 'none'; continue; }
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      rec.labelEl.style.display = '';
      rec.labelEl.style.left = `${x.toFixed(1)}px`;
      rec.labelEl.style.top = `${y.toFixed(1)}px`;
    }
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    if (!this.shouldTick()) return;
    this.update(now);
    if (!this.needsRender) return;
    this.applyCam();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.needsRender = false;
  };

  private start() {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose() {
    this.stopPlayback(false);
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.io?.disconnect();
    const cleanup = (this as any)._cleanup as (() => void) | undefined;
    cleanup?.();
    this.clearScene();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
