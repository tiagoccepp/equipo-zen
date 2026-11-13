// QW-07: heard-text progresivo — el texto se revela al ritmo del audio.
// Server: sentenceAudioPlan + gate.sendChunk extra. Cliente: HeardTurn +
// audioTagFromEvent (.ts vía type-stripping). Cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpeakerGate, sentenceAudioPlan } from '../server/lib/turn-pipeline.js';
import { HeardTurn, audioTagFromEvent } from '../src/lib/heard-text.ts';

// ── sentenceAudioPlan ──
test('qw07: plan pcm — primer chunk lleva sIdx+sText, resto solo sIdx', () => {
  const parts = [
    { data: 'a', mimeType: 'audio/pcm;rate=24000' },
    { data: 'b', mimeType: 'audio/pcm;rate=24000' },
    { data: 'c', mimeType: 'audio/pcm;rate=24000' }
  ];
  const plan = sentenceAudioPlan({ kind: 'pcm', parts, sentence: 'Hola, ¿cómo estás?' }, 2);
  assert.equal(plan.kind, 'pcm');
  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks[0].extra, { sIdx: 2, sText: 'Hola, ¿cómo estás?' });
  assert.deepEqual(plan.chunks[1].extra, { sIdx: 2 });
  assert.deepEqual(plan.chunks[2].extra, { sIdx: 2 });
  assert.equal(plan.chunks[0].part.data, 'a', 'part intacta');
});

test('qw07: plan mp3 + nulos', () => {
  const plan = sentenceAudioPlan({ kind: 'mp3', mp3: { data: 'x' }, sentence: 'Corto.' }, 0);
  assert.deepEqual(plan, { kind: 'mp3', sIdx: 0, sText: 'Corto.' });
  assert.equal(sentenceAudioPlan(null, 0), null);
  assert.equal(sentenceAudioPlan(undefined, 5), null);
  const noText = sentenceAudioPlan({ kind: 'mp3' }, 1);
  assert.equal(noText.sText, '', 'sin sentence → string vacío, no crash');
});

// ── gate.sendChunk extra ──
function makeGate() {
  const events = [];
  const gate = new SpeakerGate({ emit: (e) => events.push(e) });
  return { gate, events };
}

test('qw07: gate pasa sIdx/sText y filtra claves arbitrarias', async () => {
  const { gate, events } = makeGate();
  const token = await gate.acquire('t1', 'a1', {});
  gate.sendChunk(token, 'AAAA', 'audio/pcm;rate=24000', { sIdx: 3, sText: 'Hola.', evil: 'x'.repeat(10) });
  gate.sendChunk(token, 'BBBB', 'audio/pcm;rate=24000', { sIdx: 3 });
  gate.sendChunk(token, 'CCCC', 'audio/pcm;rate=24000');
  const chunks = events.filter((e) => e.type === 'agent_audio_chunk');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].sIdx, 3);
  assert.equal(chunks[0].sText, 'Hola.');
  assert.ok(!('evil' in chunks[0]), 'claves arbitrarias no cruzan');
  assert.equal(chunks[1].sIdx, 3);
  assert.ok(!('sText' in chunks[1]), 'sin sText si no viene');
  assert.ok(!('sIdx' in chunks[2]), 'sin extra = evento igual que antes');
});

test('qw07: gate trunca sText largo y normaliza sIdx', async () => {
  const { gate, events } = makeGate();
  const token = await gate.acquire('t1', 'a1', {});
  gate.sendChunk(token, 'AAAA', null, { sIdx: 2.9, sText: 'z'.repeat(5000) });
  const c = events.find((e) => e.type === 'agent_audio_chunk');
  assert.equal(c.sIdx, 2);
  assert.equal(c.sText.length, 2000);
});

// ── HeardTurn ──
test('qw07: HeardTurn revela en orden al sonar cada oración', () => {
  const h = new HeardTurn();
  assert.equal(h.progressive, false);
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: 0, sText: 'Primera.' }), ['Primera.']);
  assert.equal(h.progressive, true);
  // Chunks siguientes de la misma oración: nada nuevo.
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: 0 }), []);
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: 1, sText: 'Segunda.' }), ['Segunda.']);
});

test('qw07: HeardTurn salta huecos (oración silenciosa se revela con la siguiente)', () => {
  const h = new HeardTurn();
  h.observe({ turnId: 't', agentId: 'a', sIdx: 0, sText: 'Una.' });
  // sIdx 1 nunca tuvo audio; al sonar sIdx 2, la 1 (desconocida) se salta
  // sin romper el orden y la 2 se revela.
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: 2, sText: 'Tres.' }), ['Tres.']);
});

test('qw07: HeardTurn tras finalize no revela + finalize devuelve full', () => {
  const h = new HeardTurn();
  h.observe({ turnId: 't', agentId: 'a', sIdx: 0, sText: 'Una.' });
  assert.equal(h.finalize('Una. Dos.'), 'Una. Dos.');
  assert.equal(h.isEnded, true);
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: 1, sText: 'Dos.' }), []);
});

test('qw07: HeardTurn tolera sIdx inválidos', () => {
  const h = new HeardTurn();
  assert.deepEqual(h.observe({ turnId: 't', agentId: 'a', sIdx: -5, sText: 'X.' }), ['X.']);
});

// ── audioTagFromEvent ──
test('qw07: audioTagFromEvent — válido, sin tag, inválido', () => {
  assert.deepEqual(
    audioTagFromEvent({ turnId: 't', agentId: 'a', sIdx: 2, sText: 'Hola.' }),
    { turnId: 't', agentId: 'a', sIdx: 2, sText: 'Hola.' }
  );
  assert.deepEqual(
    audioTagFromEvent({ turnId: 't', agentId: 'a', sIdx: 1 }),
    { turnId: 't', agentId: 'a', sIdx: 1 }
  );
  assert.equal(audioTagFromEvent({ turnId: 't', agentId: 'a' }), null, 'chunks viejos sin tag → null');
  assert.equal(audioTagFromEvent({ sIdx: -1 }), null);
  assert.equal(audioTagFromEvent({ sIdx: 'no-num' }), null);
});
