import { getErrorText } from './text.js';

export class ApiKeyRing {
  constructor(keys) {
    this.keys = keys.map((value, index) => ({
      id: `key-${index + 1}`,
      value,
      cooldownUntil: 0,
      failures: 0,
      lastError: null,
      disabled: false
    }));
    this.cursor = 0;
    this.telemetry = null;
  }

  // Reemplaza las claves en caliente (cuando el usuario las cambia desde
  // Ajustes) conservando la instancia compartida.
  setKeys(keys) {
    this.keys = keys.map((value, index) => ({
      id: `key-${index + 1}`,
      value,
      cooldownUntil: 0,
      failures: 0,
      lastError: null,
      disabled: false
    }));
    this.cursor = 0;
    this.logKey('api_keys_replaced', { count: keys.length });
  }


  setTelemetry(telemetryInstance) {
    this.telemetry = telemetryInstance;
  }

  logKey(type, payload) {
    if (this.telemetry) {
      this.telemetry.add({ type, source: 'server', payload });
    }
  }

  hasKeys() {
    return this.keys.length > 0;
  }

  size() {
    return this.keys.length;
  }

  acquire() {
    if (!this.hasKeys()) {
      this.logKey('api_key_acquire_failed', { reason: 'no_keys_configured' });
      return null;
    }

    const now = Date.now();
    for (let attempts = 0; attempts < this.keys.length; attempts += 1) {
      const index = (this.cursor + attempts) % this.keys.length;
      const candidate = this.keys[index];
      if (candidate.cooldownUntil <= now) {
        this.cursor = (index + 1) % this.keys.length;
        this.logKey('api_key_acquired', {
          keyId: candidate.id,
          keyIndex: index,
          failures: candidate.failures,
          remaining: this.keys.filter(k => k.cooldownUntil <= now).length - 1
        });
        return candidate;
      }
    }

    const cooldowns = this.keys.map(k => ({
      keyId: k.id,
      cooldownSeconds: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
      failures: k.failures
    }));

    // Modo degradado: una clave en enfriamiento transitorio (timeout, 5xx,
    // rate limit puntual) NO puede dejar la app muerta — con una sola clave
    // eso significaba que TODOS los agentes fallaban a la vez. Solo las
    // claves rechazadas de raíz (401) quedan realmente fuera de juego.
    const usable = this.keys.filter((key) => !key.disabled);
    if (usable.length > 0) {
      const candidate = usable.reduce((best, key) => (key.cooldownUntil < best.cooldownUntil ? key : best));
      this.logKey('api_key_degraded_use', {
        keyId: candidate.id,
        waitingSeconds: Math.max(0, Math.ceil((candidate.cooldownUntil - now) / 1000)),
        keys: cooldowns
      });
      return candidate;
    }

    this.logKey('api_key_all_cooldown', { keys: cooldowns, disabled: true });
    return null;
  }

  reportFailure(key, error) {
    if (!key) {
      return;
    }

    const text = getErrorText(error);
    const modelConfiguration = /model.*(not found|invalid|does not exist)/i.test(text);
    const quota = /429|rate.?limit|quota|insufficient.?balance|1008/i.test(text);
    const permanent = /401|invalid api key|api key.*invalid|unauthorized|1004/i.test(text);
    key.failures += 1;
    key.lastError = text.slice(0, 240);
    if (modelConfiguration) {
      this.logKey('api_key_model_error', { keyId: key.id, error: text.slice(0, 200), modelConfig: true });
      return;
    }
    // Enfriamientos cortos y escalonados: los 429 de MiniMax suelen ser por
    // concurrencia (una reunión + el equipo trabajando), no por cuota agotada;
    // castigarlos con una hora dejaba la empresa muda. Solo un 401 inhabilita
    // la clave de verdad (esa sí hay que cambiarla en Ajustes).
    const quotaLadder = [20 * 1000, 45 * 1000, 90 * 1000, 5 * 60 * 1000];
    const cooldownMs = permanent
      ? 24 * 60 * 60 * 1000
      : quota
        ? quotaLadder[Math.min(key.failures - 1, quotaLadder.length - 1)]
        : 8 * 1000;
    key.cooldownUntil = Date.now() + cooldownMs;
    key.disabled = permanent;

    this.logKey('api_key_failure', {
      keyId: key.id,
      failures: key.failures,
      error: text.slice(0, 200),
      quota,
      permanent,
      cooldownMs,
      cooldownSeconds: Math.ceil(cooldownMs / 1000)
    });
  }

  reportSuccess(key) {
    if (!key) {
      return;
    }
    key.failures = 0;
    key.lastError = null;
    key.disabled = false;
    key.cooldownUntil = 0;
    this.logKey('api_key_success', { keyId: key.id });
  }

  snapshot() {
    const now = Date.now();
    return this.keys.map((key) => ({
      id: key.id,
      available: key.cooldownUntil <= now,
      disabled: Boolean(key.disabled),
      cooldownSeconds: Math.max(0, Math.ceil((key.cooldownUntil - now) / 1000)),
      failures: key.failures,
      lastError: key.lastError
    }));
  }
}
