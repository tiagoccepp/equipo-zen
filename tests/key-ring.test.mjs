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

test('fallo de cuota (429) enfría corto y escalonado, y se saltea', () => {
  const ring = new ApiKeyRing(['k1', 'k2']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 429: rate limit exceeded'));
  const first = key.cooldownUntil - Date.now();
  // Los 429 acá suelen ser concurrencia, no cuota agotada: castigo corto.
  assert.ok(first > 15 * 1000 && first <= 20 * 1000, `esperaba ~20s, fue ${first}ms`);
  assert.equal(ring.acquire().value, 'k2');

  // Reincidencia: el enfriamiento escala.
  ring.reportFailure(key, new Error('MiniMax HTTP 429: rate limit exceeded'));
  const second = key.cooldownUntil - Date.now();
  assert.ok(second > first, 'el segundo 429 debe enfriar más que el primero');
  assert.ok(second <= 45 * 1000);
});

test('fallo permanente (401) enfría 24 horas e inhabilita la clave', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 401: invalid api key'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 23 * 60 * 60 * 1000 && cooldown <= 24 * 60 * 60 * 1000);
  assert.equal(key.disabled, true);
  // Una clave rechazada de raíz sí deja al ring sin nada que ofrecer.
  assert.equal(ring.acquire(), null);
});

test('fallo genérico enfría pocos segundos', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('ECONNRESET'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 4 * 1000 && cooldown <= 8 * 1000, `esperaba ~8s, fue ${cooldown}ms`);
});

test('error de configuración de modelo NO enfría la clave', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('model MiniMax-X not found'));
  assert.equal(key.cooldownUntil, 0);
});

test('con todas en enfriamiento transitorio sigue entregando clave (modo degradado)', () => {
  // Antes esto devolvía null y TODOS los empleados fallaban a la vez: con una
  // sola clave, un 429 puntual dejaba la empresa muda.
  const ring = new ApiKeyRing(['k1', 'k2']);
  const k1 = ring.acquire();
  ring.reportFailure(k1, new Error('429 rate limit'));
  const k2 = ring.acquire();
  ring.reportFailure(k2, new Error('429 rate limit'));

  const degraded = ring.acquire();
  assert.ok(degraded, 'debe entregar una clave igual en vez de dejar la app muerta');
  assert.equal(degraded.disabled, false);

  ring.reportSuccess(k1);
  assert.equal(k1.failures, 0);
  assert.equal(k1.lastError, null);
  assert.equal(k1.cooldownUntil, 0);
});

test('sin claves configuradas devuelve null', () => {
  const ring = new ApiKeyRing([]);
  assert.equal(ring.acquire(), null);
  assert.equal(ring.hasKeys(), false);
});
