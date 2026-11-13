import { countBlockers, type Signal } from './signals.ts';

export interface HudSnapshot {
  agentsOnline?: number;
  agentsWorking?: number;
  queueDepth?: number;
  lastActivityAt?: number | null;
  latencyMs?: number | null;
  latencyOk?: boolean | null;
}

export interface HudController {
  element: HTMLElement;
  update(snapshot: HudSnapshot): void;
  setSignals(signals: Signal[]): void;
  setBriefingOpen(open: boolean): void;
  destroy(): void;
}

function fmtAge(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '--';
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function createPresenceHud(opts: {
  mount: HTMLElement;
  onBriefingToggle?: (open: boolean) => void;
  now?: () => number;
}): HudController {
  const now = opts.now || (() => Date.now());
  const root = document.createElement('div');
  root.className = 'presence-hud';
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <div class="ph-group ph-metrics">
      <span class="ph-item" title="Agents online"><span class="ph-k">AG</span><span class="ph-v" data-ph="online">0</span></span>
      <span class="ph-item" title="Agents working"><span class="ph-k">WK</span><span class="ph-v" data-ph="working">0</span></span>
      <span class="ph-item" title="Queue depth"><span class="ph-k">Q</span><span class="ph-v" data-ph="queue">0</span></span>
      <span class="ph-item" title="Last activity age"><span class="ph-k">AGE</span><span class="ph-v" data-ph="age">--</span></span>
    </div>
    <div class="ph-group ph-latency" title="Backend latency">
      <span class="ph-dot" data-ph="dot"></span>
      <span class="ph-ms" data-ph="ms">--</span>
    </div>
    <button type="button" class="ph-briefing" data-ph="briefing" aria-expanded="false" title="Briefing">
      <span class="ph-briefing-label">BRIEFING</span>
      <span class="ph-badge" data-ph="badge" hidden>0</span>
    </button>
  `;
  opts.mount.appendChild(root);

  let open = false;
  let lastAgeTs: number | null = null;
  const briefingBtn = root.querySelector('[data-ph="briefing"]') as HTMLButtonElement;
  const badgeEl = root.querySelector('[data-ph="badge"]') as HTMLElement;
  const onlineEl = root.querySelector('[data-ph="online"]') as HTMLElement;
  const workingEl = root.querySelector('[data-ph="working"]') as HTMLElement;
  const queueEl = root.querySelector('[data-ph="queue"]') as HTMLElement;
  const ageEl = root.querySelector('[data-ph="age"]') as HTMLElement;
  const dotEl = root.querySelector('[data-ph="dot"]') as HTMLElement;
  const msEl = root.querySelector('[data-ph="ms"]') as HTMLElement;

  const onClick = (): void => {
    open = !open;
    briefingBtn.setAttribute('aria-expanded', String(open));
    root.classList.toggle('briefing-open', open);
    opts.onBriefingToggle?.(open);
  };
  briefingBtn.addEventListener('click', onClick);

  return {
    element: root,
    update(snapshot: HudSnapshot): void {
      if (typeof snapshot.agentsOnline === 'number') onlineEl.textContent = String(snapshot.agentsOnline);
      if (typeof snapshot.agentsWorking === 'number') workingEl.textContent = String(snapshot.agentsWorking);
      if (typeof snapshot.queueDepth === 'number') queueEl.textContent = String(snapshot.queueDepth);
      if (snapshot.lastActivityAt !== undefined) lastAgeTs = snapshot.lastActivityAt;
      ageEl.textContent = fmtAge(lastAgeTs, now());
      if (snapshot.latencyMs === null || snapshot.latencyMs === undefined || !Number.isFinite(snapshot.latencyMs)) {
        msEl.textContent = '--';
        dotEl.dataset.state = 'unknown';
      } else {
        msEl.textContent = `${Math.round(snapshot.latencyMs)}ms`;
        const ok = snapshot.latencyOk ?? snapshot.latencyMs <= 400;
        dotEl.dataset.state = ok ? 'ok' : 'warn';
      }
    },
    setSignals(signals: Signal[]): void {
      const blockers = countBlockers(signals);
      if (blockers > 0) {
        badgeEl.hidden = false;
        badgeEl.textContent = String(blockers);
      } else {
        badgeEl.hidden = true;
        badgeEl.textContent = '0';
      }
    },
    setBriefingOpen(value: boolean): void {
      open = value;
      briefingBtn.setAttribute('aria-expanded', String(open));
      root.classList.toggle('briefing-open', open);
    },
    destroy(): void {
      briefingBtn.removeEventListener('click', onClick);
      root.remove();
    }
  };
}
