// M-11: cola de renders pesados — un diagrama por tick idle (evita jank
// cuando un turno trae varios). Scheduler inyectable para tests.

export type IdleSchedule = (fn: () => void) => void;

export function createFigureQueue(schedule: IdleSchedule): { deferHeavy: IdleSchedule; depth: () => number } {
  const pending: Array<() => void> = [];
  let scheduled = false;
  const pump = (): void => {
    scheduled = false;
    const fn = pending.shift();
    if (!fn) return;
    try {
      fn();
    } catch {
      // Un render roto no traba la cola.
    }
    if (pending.length > 0 && !scheduled) {
      scheduled = true;
      schedule(pump);
    }
  };
  return {
    deferHeavy: (fn: () => void) => {
      pending.push(fn);
      if (!scheduled) {
        scheduled = true;
        schedule(pump);
      }
    },
    depth: () => pending.length
  };
}

function realIdleSchedule(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: 120 });
  } else {
    setTimeout(fn, 16);
  }
}

export const defaultFigureQueue = createFigureQueue(realIdleSchedule);
