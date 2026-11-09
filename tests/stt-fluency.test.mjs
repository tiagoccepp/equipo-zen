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

// Fluidez STT (09/11): el dueño habla y el sistema corta/tarda. Estos tests
// cubren los fixes de diagnóstico con evidencia (ver reporte del turno).

test('fluidez: junk NO come afirmaciones repetidas (énfasis rioplatense)', () => {
  for (const t of ['sí sí', 'si si', 'no no', 'dale dale', 'ya ya', 'ok ok', 'bien bien', 'claro claro', 'bueno bueno', 'gracias gracias', 'chau chau', 'vale vale', 'sí sí sí sí']) {
    assert.equal(isJunkTranscript(t), false, t);
  }
});

test('fluidez: junk SÍ come ruido, gruñidos y alucinaciones', () => {
  for (const t of ['', 'a', 'y', 'eh', 'ah', 'mmm', 'oh', 'shh', 'hmm', 'ehem', 'mmm mmm', 'eh eh', 'eh eh eh eh', 'you you', 'thank you', 'thank you thank you', 'silencio', 'música', 'suscríbete']) {
    assert.equal(isJunkTranscript(t), true, t);
  }
});

test('fluidez: junk deja pasar habla real corta y normal', () => {
  for (const t of ['sí', 'no', 'dale', 'che', 'hola', 'gracias', 'chau', 'qué', 'a ver', 'no sé', 'sí, dale', 'no, pará', 'contame más', 'posta?']) {
    assert.equal(isJunkTranscript(t), false, t);
  }
});

test('fluidez: repetir la misma frase en turnos distintos sale dos veces', async () => {
  const finals = [];
  const rt = new CaptureTranscriberRuntime({
    emit: () => {},
    onTranscript: (t) => finals.push(t)
  });
  rt.finalize('dale', 'local');
  rt.endAudio({ transcriptHint: '' }); // turno nuevo: resetea el dedup
  rt.finalize('dale', 'local');
  assert.deepEqual(finals, ['dale', 'dale']);
  // Esperar que el processTurn vacío de endAudio libere busy (Silero ~200 ms).
  for (let i = 0; i < 100 && rt.busy; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rt.busy, false);
});

test('fluidez: endAudio emite telemetría de turno (audio_turn_stt)', async () => {
  telemetry.reset();
  const rt = new CaptureTranscriberRuntime({ emit: () => {}, onTranscript: () => {} });
  rt.endAudio({ transcriptHint: '' });
  await rt.processTurn([], '');
  const events = telemetry.list(50).filter((e) => e.type === 'audio_turn_stt');
  assert.ok(events.length >= 1, 'falta evento audio_turn_stt');
  assert.equal(typeof events.at(-1).payload.secs, 'number');
});

test('fluidez: constantes de endpointing (lento/gracia recortados 09/11)', () => {
  assert.equal(MIC_NORMAL.minSpeechMs, 250); // descarte: oye sílabas cortas
  assert.equal(CONFIRM_SPEECH_MS, 600); // confirmación: la tos no interrumpe
  assert.equal(END_SILENCE_SLOW_MS, 900);
  assert.equal(GRACE_BASE_MS, 1000);
  assert.equal(END_SILENCE_BASE_MS, 800);
  assert.equal(END_SILENCE_FAST_MS, 575);
  assert.equal(GRACE_FAST_MS, 600);
});

test('fluidez: computeEndpointing turno corto → lento (no cortar)', () => {
  const d = computeEndpointing({ speechMs: 400, hintEnd: '', floor: 0.01, maxRms: 0.09, recentBarge: false });
  assert.deepEqual(d, { endSilenceMs: 900, graceMs: 1000 });
});

test('fluidez: computeEndpointing turno largo + frase completa + claro → rápido', () => {
  const d = computeEndpointing({ speechMs: 3000, hintEnd: 'contame más.', floor: 0.01, maxRms: 0.09, recentBarge: false });
  assert.deepEqual(d, { endSilenceMs: 575, graceMs: 600 });
});

test('fluidez: computeEndpointing duda (funcional / barge / ruido) → lento', () => {
  const base = { speechMs: 3000, hintEnd: 'contame', floor: 0.01, maxRms: 0.09, recentBarge: false };
  assert.deepEqual(computeEndpointing({ ...base, hintEnd: 'pasame el' }).endSilenceMs, 900); // funcional
  assert.deepEqual(computeEndpointing({ ...base, recentBarge: true }).endSilenceMs, 900); // cortes
  assert.deepEqual(computeEndpointing({ ...base, floor: 0.035 }).endSilenceMs, 900); // piso alto
  assert.ok(endsFunctional('pasame el'));
  assert.ok(isTerminalHint('gracias'));
  assert.ok(isTerminalHint('sí'));
  assert.ok(!isTerminalHint('pasame el'));
});
