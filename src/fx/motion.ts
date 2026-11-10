// ═══════════════════════════════════════════════════════════════════════
// fx/motion.ts — minimal helpers for motion.css. No dependencies, with
// cleanup. Everything is transform/opacity; with prefers-reduced-motion the
// CSS already cancels transitions, here we just avoid observing pointlessly.
// ═══════════════════════════════════════════════════════════════════════

export type MotionHandle = {
  dispose: () => void;
};

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Marks [data-reveal] with .fx-in when they enter the viewport (once only).
// Call after every render that adds cards; dispose() releases everything.
export function mountMotion(root: ParentNode = document): MotionHandle {
  const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]:not(.fx-in)')];
  if (els.length === 0 || typeof IntersectionObserver === 'undefined' || reducedMotion()) {
    for (const el of els) el.classList.add('fx-in');
    return { dispose: () => {} };
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('fx-in');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12 });
  for (const el of els) io.observe(el);
  return { dispose: () => io.disconnect() };
}

// "Speaking" glow on the agent cell (data-speaking="true").
export function setSpeakingGlow(cell: HTMLElement | null, speaking: boolean) {
  if (!cell) return;
  cell.dataset.speaking = speaking ? 'true' : 'false';
}

// View transition: the visible one exits, the new one enters. Takes ~200ms.
export function swapViews(hide: HTMLElement | null, show: HTMLElement | null) {
  if (reducedMotion()) {
    if (hide) hide.hidden = true;
    if (show) {
      show.hidden = false;
      show.classList.add('fx-in');
    }
    return;
  }
  if (hide) {
    hide.classList.add('fx-leave');
    window.setTimeout(() => {
      hide.hidden = true;
      hide.classList.remove('fx-leave');
    }, 220);
  }
  if (show) {
    show.hidden = false;
    show.classList.add('fx-enter');
    // Two frames so the browser paints the initial state before animating.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      show.classList.add('fx-in');
      window.setTimeout(() => show.classList.remove('fx-enter', 'fx-in'), 240);
    }));
  }
}
