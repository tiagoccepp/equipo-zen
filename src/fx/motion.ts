// ═══════════════════════════════════════════════════════════════════════
// fx/motion.ts — helpers mínimos para motion.css. Sin dependencias, con
// cleanup. Todo es transform/opacity; con prefers-reduced-motion el CSS ya
// anula las transiciones, acá solo se evita observar al pedo.
// ═══════════════════════════════════════════════════════════════════════

export type MotionHandle = {
  dispose: () => void;
};

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Marca [data-reveal] con .fx-in cuando entran al viewport (una sola vez).
// Llamar después de cada render que agregue tarjetas; dispose() suelta todo.
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

// Glow de "está hablando" en la celda del agente (data-speaking="true").
export function setSpeakingGlow(cell: HTMLElement | null, speaking: boolean) {
  if (!cell) return;
  cell.dataset.speaking = speaking ? 'true' : 'false';
}

// Transición entre vistas: la visible sale, la nueva entra. Dura ~200ms.
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
    // Dos frames para que el navegador pinte el estado inicial antes de animar.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      show.classList.add('fx-in');
      window.setTimeout(() => show.classList.remove('fx-enter', 'fx-in'), 240);
    }));
  }
}
