// F-01: voz non-blocking + backend cancelable — cascada con topes y abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeTtsOrdered, TTS_ENGINE_TIMEOUT_MS } from '../server/lib/agent-runtime.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('f01: orden + skip edge/sin-key + primer éxito gana', async () => {
  assert.ok(TTS_ENGINE_TIMEOUT_MS >= 5000, 'tope razonable');
  const tried = [];
  const r = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['edge', 'deepgram', 'piper', 'supertonic'],
    deepgramKey: '',
    runners: {
      piper: async () => { tried.push('piper'); return []; },
      supertonic: async () => { tried.push('supertonic'); return [{ data: 'x' }]; }
    }
  });
  assert.deepEqual(tried, ['piper', 'supertonic'], 'edge y deepgram-sin-key salteados');
  assert.equal(r.parts.length, 1);
  assert.equal(r.lastError, null, 'éxito limpia error');
});

test('f01: abort corta la cascada (siguiente motor ni se intenta)', async () => {
  const tried = [];
  const controller = new AbortController();
  const p = synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['piper', 'supertonic'],
    runners: {
      piper: async () => { tried.push('piper'); await tick(50); return []; },
      supertonic: async () => { tried.push('supertonic'); return [{ data: 'x' }]; }
    },
    signal: controller.signal
  });
  await tick(5);
  controller.abort();
  const r = await p;
  assert.deepEqual(r.parts, []);
  assert.equal(r.aborted, true);
  await tick(60);
  assert.deepEqual(tried, ['piper'], 'supertonic jamás arrancó');
});

test('f01: abort antes de empezar ni intenta', async () => {
  const controller = new AbortController();
  controller.abort();
  let tried = false;
  const r = await synthesizeTtsOrdered({
    text: 'h', voice: 'M1', order: ['piper'],
    runners: { piper: async () => { tried = true; return [{ data: 'x' }]; } },
    signal: controller.signal
  });
  assert.equal(tried, false);
  assert.equal(r.aborted, true);
});

test('f01: error local pasa al siguiente y queda lastError si todos fallan', async () => {
  const r = await synthesizeTtsOrdered({
    text: 'h', voice: 'M1', order: ['piper', 'supertonic'],
    runners: {
      piper: async () => { throw new Error('piper caído'); },
      supertonic: async () => { throw new Error('supertonic caído'); }
    }
  });
  assert.deepEqual(r.parts, []);
  assert.ok(String(r.lastError?.message || '').includes('supertonic'), 'último error local');
});
