import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRM_SPEECH_MS,
  END_SILENCE_BASE_MS,
  END_SILENCE_FAST_MS,
  END_SILENCE_SLOW_MS,
  GRACE_BASE_MS,
  GRACE_FAST_MS,
  MIC_NORMAL,
  computeEndpointing,
  endsFunctional,
  isTerminalHint
} from '../src/voice.ts';
import { CaptureTranscriberRuntime, isJunkTranscript } from '../server/lib/transcriber.js';
import { telemetry } from '../server/lib/telemetry.js';

// STT fluency (09/11): the owner speaks and the system cuts/lags. These tests
// cover the diagnostic fixes with evidence (see the turn report).

test('fluency: junk does NOT eat repeated affirmations (rioplatense emphasis)', () => {
  for (const t of ['sí sí', 'si si', 'no no', 'dale dale', 'ya ya', 'ok ok', 'bien bien', 'claro claro', 'bueno bueno', 'gracias gracias', 'chau chau', 'vale vale', 'sí sí sí sí']) {
    assert.equal(isJunkTranscript(t), false, t);
  }
});

test('fluency: junk DOES eat noise, grunts, and hallucinations', () => {
  for (const t of ['', 'a', 'y', 'eh', 'ah', 'mmm', 'oh', 'shh', 'hmm', 'ehem', 'mmm mmm', 'eh eh', 'eh eh eh eh', 'you you', 'thank you', 'thank you thank you', 'silencio', 'música', 'suscríbete']) {
    assert.equal(isJunkTranscript(t), true, t);
  }
});

test('fluency: junk lets short normal real speech through', () => {
  for (const t of ['sí', 'no', 'dale', 'che', 'hola', 'gracias', 'chau', 'qué', 'a ver', 'no sé', 'sí, dale', 'no, pará', 'contame más', 'posta?']) {
    assert.equal(isJunkTranscript(t), false, t);
  }
});

test('fluency: repeating the same sentence in different turns comes out twice', async () => {
  const finals = [];
  const rt = new CaptureTranscriberRuntime({
    emit: () => {},
    onTranscript: (t) => finals.push(t)
  });
  rt.finalize('dale', 'local');
  rt.endAudio({ transcriptHint: '' }); // new turn: resets the dedup
  rt.finalize('dale', 'local');
  assert.deepEqual(finals, ['dale', 'dale']);
  // Wait for endAudio's empty processTurn to release busy (Silero ~200ms).
  for (let i = 0; i < 100 && rt.busy; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rt.busy, false);
});

test('fluency: endAudio emits turn telemetry (audio_turn_stt)', async () => {
  telemetry.reset();
  const rt = new CaptureTranscriberRuntime({ emit: () => {}, onTranscript: () => {} });
  rt.endAudio({ transcriptHint: '' });
  await rt.processTurn([], '');
  const events = telemetry.list(50).filter((e) => e.type === 'audio_turn_stt');
  assert.ok(events.length >= 1, 'falta evento audio_turn_stt');
  assert.equal(typeof events.at(-1).payload.secs, 'number');
});

test('fluency: endpointing constants (conservative latency trim 13/11)', () => {
  assert.equal(MIC_NORMAL.minSpeechMs, 250); // discard: hears short syllables
  assert.equal(CONFIRM_SPEECH_MS, 600); // confirmation: coughing does not interrupt
  assert.equal(END_SILENCE_SLOW_MS, 900);
  assert.equal(GRACE_BASE_MS, 850);
  assert.equal(END_SILENCE_BASE_MS, 720);
  assert.equal(END_SILENCE_FAST_MS, 520);
  assert.equal(GRACE_FAST_MS, 500);
});

test('fluency: computeEndpointing short turn → slow (do not cut)', () => {
  const d = computeEndpointing({ speechMs: 400, hintEnd: '', floor: 0.01, maxRms: 0.09, recentBarge: false });
  assert.deepEqual(d, { endSilenceMs: 900, graceMs: 850 });
});

test('fluency: computeEndpointing long turn + complete sentence + clear → fast', () => {
  const d = computeEndpointing({ speechMs: 3000, hintEnd: 'contame más.', floor: 0.01, maxRms: 0.09, recentBarge: false });
  assert.deepEqual(d, { endSilenceMs: 520, graceMs: 500 });
});

test('fluency: computeEndpointing doubt (functional / barge / noise) → slow', () => {
  const base = { speechMs: 3000, hintEnd: 'contame', floor: 0.01, maxRms: 0.09, recentBarge: false };
  assert.deepEqual(computeEndpointing({ ...base, hintEnd: 'pasame el' }), { endSilenceMs: 900, graceMs: 850 }); // funcional
  assert.deepEqual(computeEndpointing({ ...base, recentBarge: true }), { endSilenceMs: 900, graceMs: 850 }); // cutoffs
  assert.deepEqual(computeEndpointing({ ...base, floor: 0.035 }), { endSilenceMs: 900, graceMs: 850 }); // piso alto
  assert.ok(endsFunctional('pasame el'));
  assert.ok(isTerminalHint('gracias'));
  assert.ok(isTerminalHint('sí'));
  assert.ok(!isTerminalHint('pasame el'));
});
