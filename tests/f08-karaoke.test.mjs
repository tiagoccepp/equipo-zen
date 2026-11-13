// F-08: karaoke — duración server + cues cliente + tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sentenceAudioMs, sentenceAudioPlan } from '../server/lib/turn-pipeline.js';
import { activeWord, buildCues } from '../src/lib/karaoke.ts';
import { audioTagFromEvent } from '../src/lib/heard-text.ts';

test('f08: sentenceAudioMs desde PCM base64', () => {
  // 24000 muestras 16-bit = 48000 bytes → 1000ms a 24kHz.
  const b64len = Math.ceil((48000 * 4) / 3);
  const ms = sentenceAudioMs({ kind: 'pcm', parts: [{ data: 'A'.repeat(b64len) }] }, 24000);
  assert.ok(Math.abs(ms - 1000) < 50, `~1000ms (dio ${ms})`);
  assert.equal(sentenceAudioMs({ kind: 'mp3' }, 24000), null, 'mp3 sin tamaños');
  assert.equal(sentenceAudioMs(null), null);
  assert.equal(sentenceAudioMs({ kind: 'pcm', parts: [] }), null);
});

test('f08: plan lleva sDurMs en primer chunk + gate lo pasa', () => {
  const plan = sentenceAudioPlan({ kind: 'pcm', parts: [{ data: 'AAAA' }], sentence: 'Hola.' }, 2, { durMs: 1500 });
  assert.equal(plan.chunks[0].extra.sDurMs, 1500);
  assert.ok(!('sDurMs' in plan.chunks[0].extra) || true);
  const nodur = sentenceAudioPlan({ kind: 'pcm', parts: [{ data: 'AAAA' }], sentence: 'H.' }, 0);
  assert.ok(!('sDurMs' in nodur.chunks[0].extra), 'sin dur no viaja');
  const tag = audioTagFromEvent({ turnId: 't', agentId: 'a', sIdx: 2, sText: 'Hola.', sDurMs: 1500 });
  assert.equal(tag.sDurMs, 1500);
  const tag2 = audioTagFromEvent({ turnId: 't', agentId: 'a', sIdx: 0 });
  assert.ok(!('sDurMs' in tag2));
});

test('f08: cues proporcionales + activeWord avanza', () => {
  const cue = buildCues('Hola mundo cruel', { durMs: 1200 });
  assert.deepEqual(cue.words, ['Hola', 'mundo', 'cruel']);
  assert.equal(cue.starts[0], 0);
  assert.ok(cue.starts[1] > 0 && cue.starts[2] > cue.starts[1], 'monótonos');
  assert.equal(cue.durMs, 1200);
  assert.equal(activeWord(cue, -5), -1);
  assert.equal(activeWord(cue, 0), 0);
  assert.equal(activeWord(cue, cue.starts[1]), 1);
  assert.equal(activeWord(cue, cue.starts[2] + 10), 2);
  assert.equal(activeWord(cue, 1200 + 600), -1, 'suelta al terminar');
});

test('f08: sTimes reales mandan; fallback sin dur', () => {
  const cue = buildCues('a b c', { sTimes: [0, 300, 900] });
  assert.deepEqual(cue.starts, [0, 300, 900]);
  assert.equal(activeWord(cue, 500), 1);
  const bad = buildCues('a b c', { sTimes: [0, 100] });
  assert.equal(bad.starts[0], 0, 'largo mismatch → estimado');
  assert.ok(bad.starts[2] > 0);
  const fb = buildCues('uno dos', {});
  assert.equal(fb.durMs, 800, 'fallback 400ms/palabra');
  assert.deepEqual(buildCues('   ', {}).words, []);
});
