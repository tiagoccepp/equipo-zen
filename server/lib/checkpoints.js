// A-09: resume markers + checkpoints + thrashing guard.
// Checkpoints: snapshots JSON por (scope,key) en workspace (reanudables).
// Thrashing: detectar reintentos idénticos en loop y frenar.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function checkpointsDir(companyId, slug, wsRoot = null) {
  const root = wsRoot || process.env.WORKSPACE_ROOT || '/tmp/equipo-workspace';
  const safe = (s) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return join(root, safe(companyId), safe(slug || 'general'), 'checkpoints');
}

export function saveCheckpoint({ companyId, slug, scope, key, state, wsRoot = null }) {
  const clean = `${String(scope || 'job').replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(key || 'main').replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 100);
  const dir = checkpointsDir(companyId, slug, wsRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${clean}.json`);
  const payload = { scope, key, state: state ?? null, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(payload, null, 1), 'utf-8');
  return file;
}

export function loadCheckpoint({ companyId, slug, scope, key, wsRoot = null }) {
  const clean = `${String(scope || 'job').replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(key || 'main').replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 100);
  try {
    const raw = readFileSync(join(checkpointsDir(companyId, slug, wsRoot), `${clean}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listCheckpoints({ companyId, slug, wsRoot = null } = {}) {
  try {
    return readdirSync(checkpointsDir(companyId, slug, wsRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// Thrashing guard: misma acción fallando N veces seguidas → frenar.
// Ventana deslizante de fallos consecutivos por key.
export function createThrashingGuard({ consecutive = 4 } = {}) {
  let lastKey = null;
  let streak = 0;
  return {
    // ok=true resetea; ok=false suma. Devuelve true si hay thrashing.
    push(key, ok) {
      if (ok) {
        if (key === lastKey) {
          streak = 0;
        }
        return false;
      }
      if (key === lastKey) {
        streak += 1;
      } else {
        lastKey = key;
        streak = 1;
      }
      return streak >= consecutive;
    },
    reset() {
      lastKey = null;
      streak = 0;
    }
  };
}
