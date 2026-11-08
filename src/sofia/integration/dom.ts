/**
 * DOM helpers shared by the integration layer.
 *
 * Security: any host- or user-derived string is written with `textContent`,
 * never `innerHTML`, so transcript/state text can never inject markup or script.
 */

export function safeSetText(element: HTMLElement | null, text: string): void {
  if (element) {
    element.textContent = text;
  }
}

/** Whether the user has requested reduced motion (a11y). Safe when matchMedia is absent. */
export function prefersReducedMotion(view?: Window | null): boolean {
  const w = view ?? (typeof window !== 'undefined' ? window : null);
  return Boolean(
    w && typeof w.matchMedia === 'function' && w.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
}
