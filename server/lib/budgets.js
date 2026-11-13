// A-08: budgets duros — topes estructurales anti-derrape.
// Recopila los existentes (turnos/deadline/rondas/reroute) y suma el que
// faltaba: PARALELO máximo de loops de tools (N agentes × tools a la vez
// derriten el box). Todo fail-closed con motivo.

// Presupuesto global de loops concurrentes.
export const MAX_PARALLEL_LOOPS = 3;
let activeLoops = 0;
const loopWaiters = [];

export function parallelLoops() {
  return activeLoops;
}

// Semáforo: resuelve con release() o lanza si se aborta.
export async function acquireLoopSlot({ signal = null } = {}) {
  if (signal?.aborted) {
    throw new Error('slot abortado antes de empezar');
  }
  if (activeLoops < MAX_PARALLEL_LOOPS) {
    activeLoops += 1;
    return releaseLoopSlot;
  }
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    loopWaiters.push(entry);
    signal?.addEventListener?.('abort', () => {
      const i = loopWaiters.indexOf(entry);
      if (i !== -1) {
        loopWaiters.splice(i, 1);
      }
      reject(new Error('slot abortado esperando turno'));
    }, { once: true });
  });
  activeLoops += 1;
  return releaseLoopSlot;
}

export function releaseLoopSlot() {
  activeLoops = Math.max(0, activeLoops - 1);
  const next = loopWaiters.shift();
  if (next) {
    next.resolve();
  }
}

// Profundidad de spawns anidados (E-04 a futuro; hoy el smoke no spawnea,
// pero el guard queda puesto: fail-closed estructural).
export const MAX_SPAWN_DEPTH = 2;
let spawnDepth = 0;

export function enterSpawn() {
  if (spawnDepth >= MAX_SPAWN_DEPTH) {
    return false;
  }
  spawnDepth += 1;
  return true;
}

export function exitSpawn() {
  spawnDepth = Math.max(0, spawnDepth - 1);
}

export function spawnDepthNow() {
  return spawnDepth;
}

export function __resetBudgets() {
  activeLoops = 0;
  loopWaiters.length = 0;
  spawnDepth = 0;
}
