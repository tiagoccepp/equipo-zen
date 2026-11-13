// E-20: modo split local+VPS — app/Pablo local, lo pesado (STT/TTS) en VPS.
// Precedencia por servicio: ajuste explícito (settings/env) > split VPS >
// localhost. En split, el watchdog NO spawnea locales (monitor-only remoto).

export const SPLIT_PORTS = { parakeet: 7790, piper: 7791, whisper: 7789, supertonic: 7788 };

export function splitBase(settingsDb = null) {
  const fromDb = typeof settingsDb === 'function' ? settingsDb('split.vps') : null;
  const raw = String(fromDb || process.env.SPLIT_VPS || '').trim().replace(/\/+$/, '');
  return raw || null;
}

export function splitActive(settingsDb = null, mode = null) {
  const m = mode || String(typeof settingsDb === 'function' ? settingsDb('split.mode') : '') || '';
  return m.trim().toLowerCase() === 'split' && Boolean(splitBase(settingsDb));
}

// URL efectiva: explicit (ya resuelta) gana; si no y split activo, VPS+puerto.
export function sidecarUrl(name, explicitLocal, settingsDb = null) {
  const port = SPLIT_PORTS[name];
  const hasExplicit = explicitLocal && !isLocalhost(explicitLocal);
  if (hasExplicit) {
    return explicitLocal;
  }
  if (port && splitActive(settingsDb)) {
    return `${splitBase(settingsDb)}:${port}`;
  }
  return explicitLocal || `http://127.0.0.1:${port}`;
}

export function isLocalhost(url) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(url || ''));
}

// Specs efectivas: en split, sin spawn (remotos, solo monitoreo).
export function effectiveSpecs(specs, settingsDb = null) {
  if (!splitActive(settingsDb)) {
    return specs;
  }
  return (specs || []).map((s) => ({ ...s, spawn: null }));
}
