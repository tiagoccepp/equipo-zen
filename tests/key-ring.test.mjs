import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiKeyRing } from '../server/lib/key-ring.js';

test('acquire rotates round-robin', () => {
  const ring = new ApiKeyRing(['k1', 'k2', 'k3']);
  assert.equal(ring.acquire().value, 'k1');
  assert.equal(ring.acquire().value, 'k2');
  assert.equal(ring.acquire().value, 'k3');
  assert.equal(ring.acquire().value, 'k1');
});

test('quota failure (429) cools down short and staggered, and is skipped', () => {
  const ring = new ApiKeyRing(['k1', 'k2']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 429: rate limit exceeded'));
  const first = key.cooldownUntil - Date.now();
  // 429s here are usually concurrency, not exhausted quota: short penalty.
  assert.ok(first > 15 * 1000 && first <= 20 * 1000, `esperaba ~20s, fue ${first}ms`);
  assert.equal(ring.acquire().value, 'k2');

  // Repeat offense: the cooldown scales.
  ring.reportFailure(key, new Error('MiniMax HTTP 429: rate limit exceeded'));
  const second = key.cooldownUntil - Date.now();
  assert.ok(second > first, 'el segundo 429 debe enfriar más que el primero');
  assert.ok(second <= 45 * 1000);
});

test('permanent failure (401) cools down 24 hours and disables the key', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('MiniMax HTTP 401: invalid api key'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 23 * 60 * 60 * 1000 && cooldown <= 24 * 60 * 60 * 1000);
  assert.equal(key.disabled, true);
  // A key rejected at the root does leave the ring with nothing to offer.
  assert.equal(ring.acquire(), null);
});

test('generic failure cools down a few seconds', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('ECONNRESET'));
  const cooldown = key.cooldownUntil - Date.now();
  assert.ok(cooldown > 4 * 1000 && cooldown <= 8 * 1000, `esperaba ~8s, fue ${cooldown}ms`);
});

test('model config error does NOT cool down the key', () => {
  const ring = new ApiKeyRing(['k1']);
  const key = ring.acquire();
  ring.reportFailure(key, new Error('model MiniMax-X not found'));
  assert.equal(key.cooldownUntil, 0);
});

test('with all in transient cooldown it still hands out a key (degraded mode)', () => {
  // This used to return null and ALL employees failed at once: with a
  // single key, one stray 429 left the company mute.
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

test('no configured keys returns null', () => {
  const ring = new ApiKeyRing([]);
  assert.equal(ring.acquire(), null);
  assert.equal(ring.hasKeys(), false);
});
