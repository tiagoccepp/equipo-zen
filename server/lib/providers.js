// E-14: pool de proveedores — un ring por provider (lazy, settings-backed)
// + orden de failover. llm.js lo usa cuando el activo se agota.

import { LLM_PROVIDERS } from './config.js';
import { ApiKeyRing } from './key-ring.js';
import { getFailoverOrder, getLlmKeys } from './settings.js';

const rings = new Map();
let telemetrySink = null;

export function setProviderTelemetry(telemetry) {
  telemetrySink = telemetry || null;
  for (const ring of rings.values()) {
    ring.setTelemetry(telemetrySink);
  }
}

export function ringFor(providerId) {
  const provider = LLM_PROVIDERS[providerId];
  if (!provider) {
    return null;
  }
  let ring = rings.get(providerId);
  const keys = getLlmKeys(providerId);
  if (!ring) {
    ring = new ApiKeyRing(keys);
    ring.setTelemetry(telemetrySink);
    rings.set(providerId, ring);
    return ring;
  }
  // Re-sync barato: si cambiaron las keys, reemplazar.
  const current = (ring.keys || []).map((k) => k.value);
  if (current.length !== keys.length || current.some((k, i) => k !== keys[i])) {
    ring.setKeys(keys);
  }
  return ring;
}

// Orden efectivo con rings que tengan llaves.
export function failoverRings() {
  const out = [];
  for (const pid of getFailoverOrder()) {
    const ring = ringFor(pid);
    if (ring && ring.hasKeys()) {
      out.push({ providerId: pid, ring });
    }
  }
  return out;
}

export function __resetProviderPool() {
  rings.clear();
}
