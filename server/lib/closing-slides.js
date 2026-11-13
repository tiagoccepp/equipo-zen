// F-07: slides narradas de cierre — resumen visual + voz por slide.
// buildClosingSlides agrupa (título/decisiones/tareas/siguiente); cada slide
// trae su narración; el gate serializa el audio y las figuras salen con
// delays estimados del habla (150wpm). Puro y testeable.

export const SLIDE_MAX_BULLETS = 6;
export const SLIDE_MS_PER_WORD = 400;
export const SLIDE_MIN_MS = 2500;
export const SLIDE_MAX_MS = 12000;

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function narrationMs(text) {
  const ms = words(text) * SLIDE_MS_PER_WORD;
  return Math.min(SLIDE_MAX_MS, Math.max(SLIDE_MIN_MS, ms));
}

// Delays acumulados de emisión por slide (relativos al inicio).
export function slideDelays(slides) {
  const delays = [];
  let acc = 0;
  for (const s of slides || []) {
    delays.push(acc);
    acc += narrationMs(s?.narration || '');
  }
  return delays;
}

export function buildClosingSlides({ goalTitle, decisions = [], tasksByOwner = [], taskCount = 0, english = false } = {}) {
  const T = (es, en) => (english ? en : es);
  const slides = [];
  const title = String(goalTitle || T('Cierre de reunión', 'Meeting wrap-up')).slice(0, 120);

  slides.push({
    figure: {
      kind: 'slide',
      title,
      bullets: [
        T(`${taskCount} tarea(s) al proyecto`, `${taskCount} task(s) to the project`),
        T(`${tasksByOwner.length} dueño(s) asignado(s)`, `${tasksByOwner.length} owner(s) assigned`)
      ]
    },
    narration: T(
      `Cerramos: ${title}. Quedan ${taskCount} tareas repartidas entre ${tasksByOwner.length} dueños.`,
      `Wrapping up: ${title}. ${taskCount} tasks across ${tasksByOwner.length} owners.`
    )
  });

  if (decisions.length > 0) {
    const items = decisions.slice(0, SLIDE_MAX_BULLETS);
    slides.push({
      figure: { kind: 'slide', title: T('Decisiones', 'Decisions'), bullets: items },
      narration: T(
        `Decisiones: ${items.join('. ')}.`,
        `Decisions: ${items.join('. ')}.`
      )
    });
  }

  for (const owner of tasksByOwner.slice(0, 4)) {
    const items = (owner.tasks || []).slice(0, SLIDE_MAX_BULLETS);
    if (items.length === 0) {
      continue;
    }
    slides.push({
      figure: { kind: 'slide', title: String(owner.name).slice(0, 60), bullets: items },
      narration: T(
        `${owner.name} queda con: ${items.join('. ')}.`,
        `${owner.name} takes: ${items.join('. ')}.`
      )
    });
  }
  if (slides.length > 5) {
    slides.length = 5;
  }
  return slides;
}
