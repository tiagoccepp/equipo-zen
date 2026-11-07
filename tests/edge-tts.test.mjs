import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeMp3, mapVoiceToEdge } from '../server/lib/edge-tts.js';
import { transcribeWithFallback } from '../server/lib/stt.js';

test('edge voice map: M* → Álvaro, F* → Elvira, resto → Álvaro', () => {
  assert.equal(mapVoiceToEdge('M1'), 'es-ES-AlvaroNeural');
  assert.equal(mapVoiceToEdge('M4'), 'es-ES-AlvaroNeural');
  assert.equal(mapVoiceToEdge('F1'), 'es-ES-ElviraNeural');
  assert.equal(mapVoiceToEdge('F5'), 'es-ES-ElviraNeural');
  assert.equal(mapVoiceToEdge(''), 'es-ES-AlvaroNeural');
  assert.equal(mapVoiceToEdge(undefined), 'es-ES-AlvaroNeural');
});

test('mp3 magic: ID3 y frame-sync pasan, basura no', () => {
  assert.equal(looksLikeMp3(Buffer.from([0x49, 0x44, 0x33, 0x04])), true);
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true);
  assert.equal(looksLikeMp3(Buffer.from([0x00, 0x01, 0x02, 0x03])), false);
  assert.equal(looksLikeMp3(Buffer.alloc(0)), false);
  assert.equal(looksLikeMp3(null), false);
});

const ok = (text) => async () => text;
const boom = async () => {
  throw new Error('x');
};

test('stt: proveedor local ok', async () => {
  const r = await transcribeWithFallback({ wavBase64: 'AAA', hint: 'hola', provider: 'local', groqKey: '', localFn: ok('hola local'), groqFn: boom });
  assert.deepEqual(r, { text: 'hola local', source: 'local' });
});

test('stt: local falla + hay key → groq automático', async () => {
  const r = await transcribeWithFallback({ wavBase64: 'AAA', hint: '', provider: 'local', groqKey: 'gsk-x', localFn: boom, groqFn: ok('hola groq') });
  assert.deepEqual(r, { text: 'hola groq', source: 'groq' });
});

test('stt: todo falla + hay hint → client', async () => {
  const r = await transcribeWithFallback({ wavBase64: 'AAA', hint: 'hola hint', provider: 'local', groqKey: '', localFn: boom, groqFn: boom });
  assert.deepEqual(r, { text: 'hola hint', source: 'client' });
});

test('stt: todo falla sin hint → lanza', async () => {
  await assert.rejects(() => transcribeWithFallback({ wavBase64: 'AAA', hint: '', provider: 'local', groqKey: '', localFn: boom, groqFn: boom }));
});

test('stt: provider browser sin hint + hay key → groq', async () => {
  const r = await transcribeWithFallback({ wavBase64: 'AAA', hint: '', provider: 'browser', groqKey: 'gsk-x', localFn: boom, groqFn: ok('hola groq') });
  assert.deepEqual(r, { text: 'hola groq', source: 'groq' });
});
