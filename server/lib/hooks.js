// F-06: hooks determinísticos — Pre/PostToolUse + Notification.
// Corren SIEMPRE (no dependen del modelo): validan, observan, hablan.
// Aislados: timeout + errores propios jamás rompen el turno.

export const HOOK_EVENTS = ['preToolUse', 'postToolUse', 'notification', 'sessionStart'];
export const HOOK_TIMEOUT_MS = 3000;

const registry = new Map(HOOK_EVENTS.map((e) => [e, []]));
let hookSeq = 0;

export function registerHook(event, fn, { name = null, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  if (!HOOK_EVENTS.includes(event)) {
    throw new Error(`hook desconocido: ${event} (válidos: ${HOOK_EVENTS.join(', ')})`);
  }
  if (typeof fn !== 'function') {
    throw new Error('registerHook necesita fn');
  }
  hookSeq += 1;
  const entry = { id: `hook-${hookSeq}`, name: name || `hook-${hookSeq}`, fn, timeoutMs };
  registry.get(event).push(entry);
  return entry.id;
}

export function unregisterHook(id) {
  for (const list of registry.values()) {
    const i = list.findIndex((h) => h.id === id);
    if (i !== -1) {
      list.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function listHooks(event = null) {
  if (event) {
    return [...(registry.get(event) || [])].map((h) => ({ id: h.id, name: h.name }));
  }
  return Object.fromEntries([...registry].map(([e, l]) => [e, l.map((h) => ({ id: h.id, name: h.name }))]));
}

function withHookTimeout(promise, ms, name) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hook ${name} timeout ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// Corre los hooks del evento en orden. Devuelve {results, errors} —
// results: [{id, name, value}] (value = lo que devolvió, si no fue undefined).
export async function runHooks(event, payload = {}) {
  const results = [];
  const errors = [];
  for (const hook of registry.get(event) || []) {
    try {
      const value = await withHookTimeout(
        Promise.resolve().then(() => hook.fn(payload)),
        hook.timeoutMs,
        hook.name
      );
      if (value !== undefined) {
        results.push({ id: hook.id, name: hook.name, value });
      }
    } catch (error) {
      errors.push({ id: hook.id, name: hook.name, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return { results, errors };
}

// Builtin: guardián de secretos — bloquea args con pinta de clave.
// (sk-*, AKIA*, ghp_, xoxb-, passwords=..., hex largo entre comillas.)
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{8,}/,
  /AKIA[A-Z0-9]{12,}/,
  /ghp_[a-zA-Z0-9]{8,}/,
  /gho_[a-zA-Z0-9]{8,}/,
  /xox[bap]-[a-zA-Z0-9-]{6,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /["']?[a-zA-Z0-9_-]*(password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?[^"'\s]{6,}/i,
  /\bpasswords?\s+(es|:|=)\s*\S{4,}/i,
  /\bcontrase[ñn]a\s*[:=]?\s*\S{4,}/i
];

export function looksLikeSecret(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return SECRET_PATTERNS.some((re) => re.test(s));
}

export function secretsGuardHook({ tool, args }) {
  if (tool === 'mcp_search' || tool === 'now' || tool === 'task_list' || tool === 'plan_status') {
    return undefined; // Lecturas inocuas: ni mirar.
  }
  if (looksLikeSecret(args)) {
    return { block: true, reason: 'posible secreto en argumentos (las claves no van en tools)' };
  }
  return undefined;
}

let builtinsRegistered = false;
export function registerBuiltinHooks() {
  if (builtinsRegistered) {
    return;
  }
  builtinsRegistered = true;
  registerHook('preToolUse', secretsGuardHook, { name: 'secrets-guard' });
}

export function __resetHooks() {
  for (const list of registry.values()) {
    list.length = 0;
  }
  builtinsRegistered = false;
  hookSeq = 0;
}
