import { LIVE_MAX_SESSIONS_PER_KEY } from './config.js';
import { getErrorText } from './text.js';
import { isModelConfigurationError } from './gemini.js';

export class ApiKeyRing {
  constructor(keys) {
    this.keys = keys.map((value, index) => ({
      id: `key-${index + 1}`,
      value,
      cooldownUntil: 0,
      failures: 0,
      lastError: null,
      liveSessions: 0
    }));
    this.cursor = 0;
    this.telemetry = null;
  }

  // Slot para una sesión Live persistente: clave disponible con menos de
  // LIVE_MAX_SESSIONS_PER_KEY sesiones abiertas (elige la menos cargada).
  acquireForLive() {
    const now = Date.now();
    const candidates = this.keys
      .filter((key) => key.cooldownUntil <= now && key.liveSessions < LIVE_MAX_SESSIONS_PER_KEY)
      .sort((a, b) => a.liveSessions - b.liveSessions);
    const key = candidates[0] || null;
    if (key) {
      key.liveSessions += 1;
      this.logKey('live_slot_acquired', { keyId: key.id, liveSessions: key.liveSessions });
    } else {
      this.logKey('live_slot_unavailable', {
        keys: this.keys.map((k) => ({ keyId: k.id, liveSessions: k.liveSessions, cooling: k.cooldownUntil > now }))
      });
    }
    return key;
  }

  releaseLive(key) {
    if (!key) {
      return;
    }
    key.liveSessions = Math.max(0, key.liveSessions - 1);
    this.logKey('live_slot_released', { keyId: key.id, liveSessions: key.liveSessions });
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
    this.logKey('api_key_all_cooldown', { keys: cooldowns });
    return null;
  }

  reportFailure(key, error) {
    if (!key) {
      return;
    }

    const text = getErrorText(error);
    const modelConfiguration = isModelConfigurationError(text);
    const quota = /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(text);
    const permanent = /API_KEY_INVALID|PERMISSION_DENIED|SERVICE_DISABLED|has not been used in project|it is disabled|API has not been used/i.test(text);
    key.failures += 1;
    key.lastError = text.slice(0, 240);
    if (modelConfiguration) {
      this.logKey('api_key_model_error', { keyId: key.id, error: text.slice(0, 200), modelConfig: true });
      return;
    }
    const cooldownMs = permanent ? 24 * 60 * 60 * 1000 : quota ? 60 * 60 * 1000 : 45 * 1000;
    key.cooldownUntil = Date.now() + cooldownMs;

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
    this.logKey('api_key_success', { keyId: key.id });
  }

  snapshot() {
    const now = Date.now();
    return this.keys.map((key) => ({
      id: key.id,
      available: key.cooldownUntil <= now,
      cooldownSeconds: Math.max(0, Math.ceil((key.cooldownUntil - now) / 1000)),
      failures: key.failures,
      lastError: key.lastError
    }));
  }
}
