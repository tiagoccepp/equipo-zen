// Low-risk polling helpers for UI views (visibility-aware, cheap signatures).

export interface PollHandle {
  stop: () => void;
  trigger: () => void;
}

/** True when the element is still in DOM and the document is visible. */
export function canPollElement(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  return el.isConnected;
}

/** Small stable signature for JSON-ish payloads to skip redundant renders. */
export function payloadSignature(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

/**
 * Start a visibility-aware interval. The callback runs immediately if requested,
 * then on interval ticks only when `shouldRun()` is true.
 */
export function startVisibilityInterval(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: { immediate?: boolean; shouldRun?: () => boolean } = {}
): PollHandle {
  const shouldRun = opts.shouldRun ?? (() => (typeof document === 'undefined' ? true : !document.hidden));
  let stopped = false;
  const trigger = () => {
    if (stopped || !shouldRun()) return;
    void fn();
  };
  if (opts.immediate) trigger();
  const timer = setInterval(trigger, Math.max(250, intervalMs));
  return {
    trigger,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}
