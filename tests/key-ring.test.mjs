import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiKeyRing } from '../server/lib/key-ring.js';

test('acquire rota round-robin', () => {
  const ring = new ApiKeyRing(['k1', 'k2', 'k3']);
  assert.equal(ring.acquire().value, 'k1');
  assert.equal(ring.acquire().value, 'k2');
  assert.equal(ring.acquire().value, 'k3');
  assert.equal(ring.acquire().value, 'k1');
});

test('fallo de cuota (429) enfría ~1 hora y se saltea', () => {
  const ring = new ApiKeyRing(['k1', 'k2']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 429: rate limit exceeded'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 55 * 60 * 1000 && cooldown <= 60 * 60 * 1000);
  assert.equal(ring.acquire().value, 'k2');
  assert.equal(ring.acquire().value, 'k2');
});

test('fallo permanente enfría 24 horas', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 401: invalid api key'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 23 * 60 * 60 * 1000 && cooldown <= 24 * 60 * 60 * 1000);
});

test('fallo genérico enfría 45 segundos', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('ECONNRESET'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 40 * 1000 && cooldown <= 45 * 1000);
});

test('error de configuración de modelo NO enfría la clave', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('model MiniMax-X not found'));
  assert.equal(key.cooldownUntil, 0);
});

test('reportSuccess limpia fallos y todas-en-cooldown devuelve null', () => {
  const ring = new ApiKeyRing(['k1', 'k2']);
  const k1 = ring.acquire();
  ring.reportFailure(k1, new Error('429 rate limit'));
  const k2 = ring.acquire();
  ring.reportFailure(k2, new Error('429 rate limit'));
  assert.equal(ring.acquire(), null);
  ring.reportSuccess(k1);
  assert.equal(k1.failures, 0);
  assert.equal(k1.lastError, null);
});
