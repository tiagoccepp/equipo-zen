import { apiBase } from '../client.ts';
import type { SceneEnvelope, SceneSpec, SceneStep } from './spec.ts';
import { SceneRenderer } from './renderer.ts';

export interface MountStageOptions {
  container: HTMLElement;
  spec?: SceneSpec;
  projectId?: string;
  onStep?: (index: number, step: SceneStep | null) => void;
}

export interface StageHandle {
  setSpec(spec: SceneSpec): void;
  setExplode(t: number): void;
  highlight(ids: string[] | null): void;
  focus(ids?: string[]): void;
  play(): void;
  pause(): void;
  reset(): void;
  goToStep(index: number): void;
  dispose(): void;
}

export function mountStage(opts: MountStageOptions): StageHandle {
  const { container } = opts;
  container.classList.add('stage-root');

  const canvasHost = document.createElement('div');
  canvasHost.className = 'stage-canvas';
  const labels = document.createElement('div');
  labels.className = 'stage-labels';
  container.append(canvasHost, labels);

  const hud = document.createElement('div');
  hud.className = 'stage-hud';
  const infoPanel = document.createElement('div');
  infoPanel.className = 'stage-panel';
  const titleEl = document.createElement('h2');
  titleEl.className = 'stage-title';
  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'stage-subtitle';
  infoPanel.append(titleEl, subtitleEl);
  hud.append(infoPanel);
  container.appendChild(hud);

  const controls = document.createElement('div');
  controls.className = 'stage-controls';

  const left = document.createElement('div');
  left.className = 'stage-panel';
  const buttons = document.createElement('div');
  buttons.className = 'stage-buttons';

  const btnAssemble = button('Assemble');
  const btnExplode = button('Explode');
  const btnPlay = button('Play');
  const btnReset = button('Reset');
  buttons.append(btnAssemble, btnExplode, btnPlay, btnReset);

  const row = document.createElement('div');
  row.className = 'stage-row';
  const label = document.createElement('span');
  label.textContent = 'Explode';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '0';
  const value = document.createElement('span');
  value.textContent = '0%';
  row.append(label, slider, value);

  const legend = document.createElement('div');
  legend.className = 'stage-legend';

  left.append(buttons, row, legend);

  const right = document.createElement('div');
  right.className = 'stage-panel';
  const stepsWrap = document.createElement('div');
  stepsWrap.className = 'stage-steps';
  right.appendChild(stepsWrap);

  controls.append(left, right);
  container.appendChild(controls);

  let currentSpec: SceneSpec | null = null;

  const renderer = new SceneRenderer({
    container: canvasHost,
    labelsLayer: labels,
    onExplode: (t) => {
      const pct = Math.round((t / 1) * 100);
      slider.value = String(clampPct(pct));
      value.textContent = `${clampPct(pct)}%`;
    },
    onStep: (index, step) => {
      updateActiveStep(index);
      opts.onStep?.(index, step);
      btnPlay.classList.toggle('is-active', index >= 0);
      btnPlay.textContent = index >= 0 ? 'Pause' : 'Play';
    }
  });

  function clampPct(p: number) { return Math.max(0, Math.min(100, p)); }

  function button(text: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stage-btn';
    b.textContent = text;
    return b;
  }

  function updateActiveStep(active: number) {
    const nodes = stepsWrap.querySelectorAll('.stage-step');
    nodes.forEach((n, i) => n.classList.toggle('is-active', i === active));
  }

  function renderSteps(spec: SceneSpec) {
    stepsWrap.innerHTML = '';
    const steps = spec.steps || [];
    steps.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'stage-step';
      const t = document.createElement('p');
      t.className = 'stage-step-title';
      t.textContent = `${i + 1}. ${s.title}`;
      const b = document.createElement('p');
      b.className = 'stage-step-body';
      b.textContent = s.body;
      el.append(t, b);
      el.addEventListener('click', () => renderer.goToStep(i));
      stepsWrap.appendChild(el);
    });
    updateActiveStep(-1);
  }

  function renderLegend(spec: SceneSpec) {
    legend.innerHTML = '';
    for (const item of spec.legend || []) {
      const row = document.createElement('span');
      row.className = 'stage-legend-item';
      const sw = document.createElement('span');
      sw.className = 'stage-swatch';
      sw.style.background = item.color;
      row.append(sw, document.createTextNode(item.label));
      legend.appendChild(row);
    }
  }

  function setSpec(spec: SceneSpec) {
    currentSpec = spec;
    titleEl.textContent = spec.title || '3D scene';
    subtitleEl.textContent = spec.subtitle || '';
    subtitleEl.style.display = spec.subtitle ? '' : 'none';
    renderLegend(spec);
    renderSteps(spec);
    renderer.load(spec);
    slider.value = '0';
    value.textContent = '0%';
  }

  btnAssemble.addEventListener('click', () => renderer.setExplode(0, 500));
  btnExplode.addEventListener('click', () => renderer.setExplode(1, 600));
  btnReset.addEventListener('click', () => renderer.reset());
  btnPlay.addEventListener('click', () => {
    if (btnPlay.textContent === 'Pause') {
      renderer.pauseSteps();
      btnPlay.textContent = 'Play';
      btnPlay.classList.remove('is-active');
    } else {
      renderer.playSteps(renderer.getStepIndex() >= 0 ? renderer.getStepIndex() : 0);
      btnPlay.textContent = 'Pause';
      btnPlay.classList.add('is-active');
    }
  });
  slider.addEventListener('input', () => {
    const t = Number(slider.value) / 100;
    renderer.setExplode(t, 80);
    value.textContent = `${slider.value}%`;
  });

  if (opts.spec) setSpec(opts.spec);

  return {
    setSpec,
    setExplode: (t: number) => renderer.setExplode(t, 400),
    highlight: (ids) => renderer.highlight(ids),
    focus: (ids) => renderer.focus(ids),
    play: () => renderer.playSteps(0),
    pause: () => renderer.pauseSteps(),
    reset: () => renderer.reset(),
    goToStep: (i) => renderer.goToStep(i),
    dispose: () => {
      renderer.dispose();
      container.innerHTML = '';
      container.classList.remove('stage-root');
    }
  };
}

function sceneUrl(path: string, params?: Record<string, string | undefined>) {
  const base = apiBase();
  const url = new URL(base + path, base ? undefined : window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
  }
  return base ? url.toString() : url.pathname + url.search;
}

export async function fetchLatestScene(projectId?: string): Promise<SceneEnvelope | null> {
  const res = await fetch(sceneUrl('/api/scene/latest', { projectId }), { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`scene latest failed: ${res.status}`);
  const data = (await res.json()) as { scene?: SceneEnvelope };
  return data.scene ?? null;
}

export async function fetchSceneList(projectId?: string, n = 20): Promise<SceneEnvelope[]> {
  const res = await fetch(sceneUrl('/api/scene/list', { projectId, n: String(n) }), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`scene list failed: ${res.status}`);
  const data = (await res.json()) as { scenes?: SceneEnvelope[] };
  return data.scenes ?? [];
}

export async function postScene(spec: SceneSpec, projectId?: string): Promise<SceneEnvelope> {
  const res = await fetch(sceneUrl('/api/scene'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ projectId, spec })
  });
  const data = (await res.json().catch(() => ({}))) as { scene?: SceneEnvelope; error?: string };
  if (!res.ok || !data.scene) throw new Error(data.error || `scene post failed: ${res.status}`);
  return data.scene;
}
