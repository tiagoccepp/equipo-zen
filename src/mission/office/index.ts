import type { CompanyWork, MissionLive, MissionLiveHooks } from '../types.ts';
import { fetchAllWork, fetchLive } from './api.ts';
import { buildWorld, findRoom, type OfficeRoom } from './mapping.ts';
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

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stateBadge(state: string): string {
  const st = String(state || 'idle');
  const label = st === 'speaking' ? 'speaking' : st === 'working' ? 'working' : st === 'blocked' ? 'blocked' : st === 'offline' ? 'offline' : 'idle';
  return `<span class="mc-office-state mc-office-state-${esc(label)}">${esc(label)}</span>`;
}

function statusPill(text: string, tone: 'ok' | 'warn' | 'bad' | 'mute' = 'mute'): string {
  return `<span class="mc-office-pill mc-office-pill-${tone}">${esc(text)}</span>`;
}

export function mountOffice(container: HTMLElement, opts: MountOfficeOptions = {}): OfficeHandle {
  container.classList.add('mc-office-root');
  container.innerHTML = `
    <div class="mc-office-shell">
      <div class="mc-office-canvas-wrap">
        <canvas class="mc-office-canvas" aria-label="Pixel office view of projects and agents" tabindex="0"></canvas>
        <div class="mc-office-hint">Click a project office to open it and watch the team</div>
        <div class="mc-office-empty" hidden></div>
        <div class="mc-office-legend" aria-hidden="true">
          <span><i class="lg lg-idle"></i>idle</span>
          <span><i class="lg lg-working"></i>working</span>
          <span><i class="lg lg-speaking"></i>speaking</span>
          <span><i class="lg lg-blocked"></i>blocked</span>
          <span><i class="lg lg-offline"></i>offline</span>
        </div>
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

  function renderOverview() {
    const count = lastWorks.length;
    const liveCount = (lastLive?.live || []).length;
    const rooms = lastWorks.map((w) => {
      const tasks = (w.goals || []).flatMap((g) => g.tasks || []);
      const active = tasks.filter((t) => /^(in_progress|doing|active|running|started)$/i.test(String(t.status || ''))).length;
      const blocked = tasks.filter((t) => /^(blocked|failed|error|stuck)$/i.test(String(t.status || '')) || (t as any).blockedReason).length;
      const live = (lastLive?.live || []).some((m) => m && (m as any).companyId === w.company.id);
      return `<button class="mc-office-project-item" type="button" data-project-id="${esc(w.company.id)}">
        <span class="name">${esc(w.company.name)}</span>
        <span class="meta">${(w.team || []).length} agents · ${tasks.length} tasks${active ? ` · ${active} active` : ''}${blocked ? ` · ${blocked} blocked` : ''}${live ? ' · live' : ''}</span>
      </button>`;
    }).join('');
    panel.innerHTML = `<div class="mc-office-panel-head"><strong>Project Office</strong></div>
      <p class="mc-dim">${count ? `${count} project${count === 1 ? '' : 's'}${liveCount ? ` · ${liveCount} live meeting${liveCount === 1 ? '' : 's'}` : ''}. Open a room to see that team working live.` : 'No projects loaded yet.'}</p>
      ${rooms ? `<div class="mc-office-project-list">${rooms}</div>` : `<p class="mc-dim">When projects/companies are available, each one appears as its own office room with its team.</p>`}
      <div class="mc-office-footnote">States update from live meetings, speakers, and task activity. Click a project to watch its people work.</div>`;
    if (!focused) hint.textContent = 'Click a project office to open it and watch the team';
    hint.hidden = false;
    panel.querySelectorAll<HTMLElement>('[data-project-id]').forEach((el) => {
      el.addEventListener('click', () => focusProject(el.getAttribute('data-project-id')));
    });
  }

  function renderRoom(room: OfficeRoom | null) {
    if (!room) {
      panel.innerHTML = `<button class="mc-office-back" type="button">← All projects</button><p class="mc-empty">Project not found.</p>`;
      panel.querySelector('.mc-office-back')?.addEventListener('click', () => focusProject(null));
      return;
    }
    const teamRows = room.agents.map((m) => {
      const task = m.currentTask || m.label;
      return `<li class="mc-office-agent-row">
        <span class="mc-agent-dot" style="--c:${esc(m.color)}"></span>
        <span class="body"><strong>${esc(m.name)}</strong> <span class="mc-dim">${esc(m.title || '')}</span><br><span class="task">${esc(task)}</span></span>
        ${stateBadge(m.state)}
      </li>`;
    }).join('');

    const feed = room.activities.slice(0, 8).map((a) => {
      const st = String(a.status || '').toLowerCase();
      const tone = /blocked|failed|error|stuck/.test(st) || a.blockedReason ? 'bad' : /in_progress|doing|active|running|started/.test(st) ? 'ok' : /done|completed|success/.test(st) ? 'mute' : 'warn';
      const who = a.agentName ? `<span class="who">${esc(a.agentName)}</span>` : '';
      const reason = a.blockedReason ? `<div class="reason">Blocked: ${esc(a.blockedReason)}</div>` : '';
      return `<li class="mc-office-feed-item tone-${tone}">
        <div class="feed-top">${statusPill(a.status || 'pending', tone)} ${who}</div>
        <div class="feed-text">${esc(a.text || '(no description)')}</div>
        <div class="feed-meta mc-dim">${esc(a.goal)}</div>
        ${reason}
      </li>`;
    }).join('');

    const liveBits = [room.live ? statusPill('live meeting', 'ok') : statusPill('no live meeting', 'mute')];
    if (room.meetingStatus) liveBits.push(statusPill(room.meetingStatus, 'warn'));
    if (room.turnCount) liveBits.push(`<span class="mc-dim">${room.turnCount} turns</span>`);
    if (room.lastActiveAt) liveBits.push(`<span class="mc-dim">active ${esc(timeAgo(room.lastActiveAt))}</span>`);

    panel.innerHTML = `
      <button class="mc-office-back" type="button">← All projects</button>
      <div class="mc-office-panel-head"><strong>${esc(room.name)}</strong></div>
      <p class="mc-office-goal"><span class="label">Current goal</span>${esc(room.goal)}</p>
      <p class="mc-dim">${room.stats.total} tasks · ${room.stats.active} active · ${room.stats.blocked} blocked · ${room.stats.done} done · ${room.stats.pending} pending</p>
      <div class="mc-office-live-row">${liveBits.join(' ')}</div>
      <section class="mc-office-section-block">
        <h4>Team at work</h4>
        <ul class="mc-office-team">${teamRows || '<li class="mc-dim">No team members in this project yet.</li>'}</ul>
      </section>
      <section class="mc-office-section-block">
        <h4>Activity feed</h4>
        ${feed ? `<ul class="mc-office-feed">${feed}</ul>` : '<p class="mc-dim">No task activity reported yet. Agents are standing by.</p>'}
      </section>`;
    hint.textContent = `Watching ${room.name} · click room again or press Esc to return`;
    hint.hidden = false;
    panel.querySelector('.mc-office-back')?.addEventListener('click', () => focusProject(null));
  }

  function renderPanel() {
    if (!focused) { renderOverview(); return; }
    const world = buildWorld(lastWorks, lastLive, getSpeakers());
    renderRoom(findRoom(world, focused));
  }

  function focusProject(id?: string | null) {
    const next = id ?? null;
    focused = next;
    renderer.setFocus(focused);
    sim.setFocus(focused);
    renderPanel();
    opts.onSelectProject?.(focused);
    // "entering/opening" feel: briefly highlight the active project room/panel
    container.classList.remove('mc-office-focus-flash');
    if (focused) {
      void container.offsetWidth; // reflow to retrigger animation
      container.classList.add('mc-office-focus-flash');
      const world = buildWorld(lastWorks, lastLive, getSpeakers());
      const room = findRoom(world, focused);
      hint.textContent = room ? `Watching ${room.name} — ${room.stats.active} active, ${room.stats.blocked} blocked` : 'Watching project team';
      hint.hidden = false;
    } else {
      hint.textContent = 'Click a project office to open it and watch the team';
      hint.hidden = false;
    }
  }

  function getSpeakers(): string[] {
    try { return opts.getLiveSpeakers?.() || []; } catch { return []; }
  }

  async function refresh() {
    if (!alive) return;
    let live: MissionLive | null = null;
    let works: CompanyWork[] | null = null;
    try { live = opts.getLive ? await opts.getLive() : await fetchLive(); } catch { live = null; }
    try { works = opts.getWork ? await opts.getWork() : await fetchAllWork(); } catch { works = null; }
    if (!alive) return;
    lastLive = live;
    lastWorks = Array.isArray(works) ? works : [];
    const speakers = getSpeakers();
    const sig = JSON.stringify({
      w: lastWorks.map((w) => ({ id: w?.company?.id, n: w?.company?.name, t: (w?.team || []).map((m: any) => [m?.id, m?.name]), g: (w?.goals || []).map((g: any) => [g?.id, g?.status, (g?.tasks || []).length]) })),
      l: ((live as any)?.live || []).map((m: any) => ({ id: m?.meetingId, c: m?.companyId, a: m?.lastActiveAt, t: m?.turnCount, s: m?.status })),
      s: speakers.slice().sort()
    });
    const world = buildWorld(lastWorks, lastLive, speakers);
    if (sig !== lastWorldSig) {
      lastWorldSig = sig;
      renderer.setWorld(world);
      sim.setWorld(world);
    } else {
      renderer.updateTransient(world);
      sim.updateTransient(world);
    }
    renderPanel();
    const hasProjects = lastWorks.length > 0;
    empty.hidden = hasProjects;
    empty.textContent = hasProjects ? '' : 'No projects available yet. When companies and teams are loaded, each project appears as its own office room.';
  }

  function onClick(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const hit = renderer.hitTest(x, y);
    if (hit) focusProject(hit === focused ? null : hit);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && focused) { e.preventDefault(); focusProject(null); }
  }
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('keydown', onKey);

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
      canvas.removeEventListener('keydown', onKey);
      renderer.destroy();
      container.classList.remove('mc-office-root');
      container.innerHTML = '';
    },
    refresh,
    focusProject
  };
}

function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
