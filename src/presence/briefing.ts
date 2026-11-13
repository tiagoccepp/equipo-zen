import { getLastSeen, markSeen, shouldShowReturnBriefing } from './presence.ts';
import type { Briefing } from './signals.ts';

export interface BriefingPanelController {
  element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  setBriefing(briefing: Briefing): void;
  destroy(): void;
}

function esc(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createBriefingPanel(opts: {
  mount: HTMLElement;
  now?: () => number;
}): BriefingPanelController {
  const now = opts.now || (() => Date.now());
  const root = document.createElement('section');
  root.className = 'presence-briefing';
  root.hidden = true;
  root.setAttribute('aria-label', 'Presence briefing');
  root.innerHTML = `
    <header class="pb-head">
      <div>
        <div class="pb-kicker">PRESENCE BRIEFING</div>
        <h2 class="pb-headline" data-pb="headline">All clear</h2>
        <div class="pb-since" data-pb="since">Since last check: unknown</div>
      </div>
      <button type="button" class="pb-close" data-pb="close" aria-label="Close briefing">Close</button>
    </header>
    <div class="pb-body">
      <section class="pb-section">
        <h3>Highlights</h3>
        <ul class="pb-list" data-pb="highlights"></ul>
      </section>
      <section class="pb-section">
        <h3>Blockers</h3>
        <ul class="pb-list pb-blockers" data-pb="blockers"></ul>
      </section>
      <section class="pb-section">
        <h3>Next actions</h3>
        <ul class="pb-list" data-pb="actions"></ul>
      </section>
    </div>
  `;
  opts.mount.appendChild(root);

  let opened = false;
  let current: Briefing | null = null;
  const headlineEl = root.querySelector('[data-pb="headline"]') as HTMLElement;
  const sinceEl = root.querySelector('[data-pb="since"]') as HTMLElement;
  const highlightsEl = root.querySelector('[data-pb="highlights"]') as HTMLUListElement;
  const blockersEl = root.querySelector('[data-pb="blockers"]') as HTMLUListElement;
  const actionsEl = root.querySelector('[data-pb="actions"]') as HTMLUListElement;
  const closeBtn = root.querySelector('[data-pb="close"]') as HTMLButtonElement;

  const renderList = (host: HTMLElement, items: string[], empty: string): void => {
    if (items.length === 0) {
      host.innerHTML = `<li class="pb-empty">${esc(empty)}</li>`;
      return;
    }
    host.innerHTML = items.map((item) => `<li>${esc(item)}</li>`).join('');
  };

  const renderBlockers = (items: Array<{ text: string; severity: 'low' | 'medium' | 'high' }>): void => {
    if (items.length === 0) {
      blockersEl.innerHTML = '<li class="pb-empty">No blockers</li>';
      return;
    }
    blockersEl.innerHTML = items
      .map((item) => `<li class="sev-${esc(item.severity)}"><span class="pb-sev">${esc(item.severity)}</span>${esc(item.text)}</li>`)
      .join('');
  };

  const render = (): void => {
    if (!current) return;
    headlineEl.textContent = current.headline;
    sinceEl.textContent = current.sinceLabel;
    renderList(highlightsEl, current.highlights, 'No highlights');
    renderBlockers(current.blockers);
    renderList(actionsEl, current.nextActions, 'No actions');
  };

  const close = (): void => {
    opened = false;
    root.hidden = true;
    markSeen(now());
  };

  const open = (): void => {
    opened = true;
    root.hidden = false;
  };

  const onClose = (): void => close();
  closeBtn.addEventListener('click', onClose);

  return {
    element: root,
    open,
    close,
    toggle(): void {
      if (opened) close();
      else open();
    },
    isOpen(): boolean {
      return opened;
    },
    setBriefing(briefing: Briefing): void {
      current = briefing;
      render();
    },
    destroy(): void {
      closeBtn.removeEventListener('click', onClose);
      root.remove();
    }
  };
}

export function showReturnBriefing(opts: {
  panel: BriefingPanelController;
  now?: () => number;
  lastSeenAt?: number | null;
}): boolean {
  const now = opts.now || (() => Date.now());
  const lastSeenAt = opts.lastSeenAt === undefined ? getLastSeen() : opts.lastSeenAt;
  if (!shouldShowReturnBriefing(lastSeenAt, now())) return false;
  opts.panel.open();
  return true;
}
