import type { CompanyWork, MissionLive, MissionLiveHooks } from '../types.ts';
import { fetchAllWork, fetchLive } from './api.ts';
import { buildWorld } from './mapping.ts';
import { OfficeRenderer } from './renderer.ts';
import { OfficeSim } from './sim.ts';
import './office.css';

export interface MountOfficeOptions extends MissionLiveHooks {
  getWork?: () => Promise<CompanyWork[] | null>;
  getLive?: () => Promise<MissionLive | null>;
  onSelectProject?: (projectId: string | null) => void;
}

export interface OfficeHandle {
  destroy: () => void;
  refresh: () => Promise<void>;
  focusProject: (id?: string | null) => void;
}

export function mountOffice(container: HTMLElement, opts: MountOfficeOptions = {}): OfficeHandle {
  container.classList.add('mc-office-root');
  container.innerHTML = `
    <div class="mc-office-shell">
      <div class="mc-office-canvas-wrap">
        <canvas class="mc-office-canvas" aria-label="Pixel office view of projects and agents"></canvas>
        <div class="mc-office-hint">Click a project room to focus</div>
        <div class="mc-office-empty" hidden></div>
      </div>
      <aside class="mc-office-panel" aria-live="polite"></aside>
    </div>`;

  const canvas = container.querySelector('.mc-office-canvas') as HTMLCanvasElement;
  const panel = container.querySelector('.mc-office-panel') as HTMLElement;
  const hint = container.querySelector('.mc-office-hint') as HTMLElement;
  const empty = container.querySelector('.mc-office-empty') as HTMLElement;

  const renderer = new OfficeRenderer(canvas);
  const sim = new OfficeSim();
  let alive = true;
  let focused: string | null = null;
  let lastWorldSig = '';
  let lastWorks: CompanyWork[] = [];
  let lastLive: MissionLive | null = null;
  let raf = 0;
  let lastFrame = 0;
  let acc = 0;
  const SIM_DT = 1000 / 10;

  function renderPanel() {
    if (!focused) {
      const count = lastWorks.length;
      panel.innerHTML = `<div class="mc-office-panel-head"><strong>Office overview</strong></div>
        <p class="mc-dim">${count ? `${count} project${count === 1 ? '' : 's'} · click a room to focus` : 'No projects loaded yet'}</p>
        <p class="mc-dim">States: idle, working, speaking, blocked/waiting.</p>`;
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    const w = lastWorks.find((x) => x.company.id === focused);
    if (!w) {
      panel.innerHTML = `<button class="mc-office-back" type="button">← Overview</button><p class="mc-empty">Project not found.</p>`;
    } else {
      const tasks = w.goals.flatMap((g) => g.tasks || []);
      const active = tasks.filter((t) => /^(in_progress|doing|active|running)$/i.test(t.status)).length;
      const blocked = tasks.filter((t) => /^(blocked|failed|error)$/i.test(t.status) || t.blockedReason).length;
      const team = (w.team || []).map((m) => `<li><span class="mc-agent-dot" style="--c:${m.color || '#7491ff'}"></span>${escapeHtml(m.name)} <span class="mc-dim">${escapeHtml(m.title || m.role || '')}</span></li>`).join('');
      const goal = w.goals[0]?.title || '—';
      panel.innerHTML = `
        <button class="mc-office-back" type="button">← Overview</button>
        <div class="mc-office-panel-head"><strong>${escapeHtml(w.company.name)}</strong></div>
        <p class="mc-dim">Goal: ${escapeHtml(goal)}</p>
        <p class="mc-dim">Team ${w.team.length} · tasks ${tasks.length} · active ${active} · blocked ${blocked}</p>
        <ul class="mc-office-team">${team || '<li class="mc-dim">No team data</li>'}</ul>`;
    }
    panel.querySelector('.mc-office-back')?.addEventListener('click', () => focusProject(null));
  }

  function focusProject(id?: string | null) {
    focused = id ?? null;
    renderer.setFocus(focused);
    sim.setFocus(focused);
    renderPanel();
    opts.onSelectProject?.(focused);
  }

  function getSpeakers(): string[] {
    try { return opts.getLiveSpeakers?.() || []; } catch { return []; }
  }

  async function refresh() {
    if (!alive) return;
    const [live, works] = await Promise.all([
      opts.getLive ? opts.getLive() : fetchLive(),
      opts.getWork ? opts.getWork() : fetchAllWork()
    ]);
    if (!alive) return;
    lastLive = live;
    lastWorks = works || [];
    const sig = JSON.stringify({
      w: lastWorks.map((w) => ({ id: w.company.id, n: w.company.name, t: w.team.map((m) => m.id), g: w.goals.length })),
      l: (live?.live || []).map((m) => ({ id: m.meetingId, c: m.companyId, a: m.lastActiveAt, t: m.turnCount })),
      s: getSpeakers().sort()
    });
    if (sig !== lastWorldSig) {
      lastWorldSig = sig;
      const world = buildWorld(lastWorks, lastLive, getSpeakers());
      renderer.setWorld(world);
      sim.setWorld(world);
      renderPanel();
    } else {
      // still update transient speaker/blocked state
      const world = buildWorld(lastWorks, lastLive, getSpeakers());
      renderer.updateTransient(world);
      sim.updateTransient(world);
    }
    const hasProjects = lastWorks.length > 0;
    empty.hidden = hasProjects;
    empty.textContent = hasProjects ? '' : 'No projects/companies available yet.';
  }

  function onClick(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const hit = renderer.hitTest(x, y);
    if (hit) focusProject(hit === focused ? null : hit);
  }
  canvas.addEventListener('click', onClick);

  function loop(ts: number) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden) { lastFrame = ts; return; }
    if (!lastFrame) lastFrame = ts;
    const dt = Math.min(100, ts - lastFrame);
    lastFrame = ts;
    acc += dt;
    while (acc >= SIM_DT) { sim.tick(SIM_DT / 1000); acc -= SIM_DT; }
    renderer.setSimAgents(sim.getAgents());
    renderer.draw(ts / 1000);
  }

  void refresh();
  raf = requestAnimationFrame(loop);

  return {
    destroy: () => {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('click', onClick);
      renderer.destroy();
      container.classList.remove('mc-office-root');
      container.innerHTML = '';
    },
    refresh,
    focusProject
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
