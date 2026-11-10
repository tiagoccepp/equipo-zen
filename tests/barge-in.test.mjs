import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BARGE_IN, evaluateBargeIn, idleBargeInState, trimPreBuffer } from '../src/lib/barge-in.ts';

// The capture AudioWorklet sends 60 ms frames (16 kHz mono).
const FRAME_MS = 60;

// Real threshold with the default sensitivity (55): 0.062 - 0.55 * 0.052.
const START = 0.0334;
// Above this, a frame counts toward confirmation (1.4 × START ≈ 0.0468).
const LOUD = START * BARGE_IN.confirmRatio;

// RMS levels measured in the real pipeline (0..1 over 16-bit PCM):
//   quiet room with noiseSuppression   ~0.004
//   fan / air conditioning              ~0.020  (below the threshold)
//   agent echo through the speaker       ~0.040  (above the threshold, below 1.4×)
//   normal voice at 30 cm                0.09 – 0.18
//   door slam / knock on the table       0.60 in a single frame
const SALA = 0.004;
const VENTILADOR = 0.02;
const ECO_DEL_AGENTE = 0.04;
const PORTAZO = 0.6;

// Runs a strip of frames through the evaluator and returns the log. `atMs`
// is the moment the decision becomes available: the worklet delivers the
// frame only once it has finished recording it, so it is the END of the frame.
function reproducir(frames, opciones = {}) {
  const { agentSpeaking = true, userSpeaking = false, state = idleBargeInState() } = opciones;
  let actual = state;
  let elapsedMs = 0;
  const eventos = [];
  for (const frame of frames) {
    const rms = typeof frame === 'number' ? frame : frame.rms;
    const durationMs = typeof frame === 'number' ? FRAME_MS : (frame.durationMs ?? FRAME_MS);
    const decision = evaluateBargeIn(actual, {
      rms,
      durationMs,
      startThreshold: START,
      agentSpeaking: typeof frame === 'object' && 'agentSpeaking' in frame ? frame.agentSpeaking : agentSpeaking,
      userSpeaking
    });
    elapsedMs += durationMs;
    actual = decision.state;
    if (decision.duck) eventos.push({ tipo: 'duck', atMs: elapsedMs, rms });
    if (decision.interrupt) eventos.push({ tipo: 'interrupt', atMs: elapsedMs, rms });
    if (decision.reset) eventos.push({ tipo: 'reset', atMs: elapsedMs, rms });
  }
  return { eventos, state: actual, elapsedMs };
}

const primero = (eventos, tipo) => eventos.find((evento) => evento.tipo === tipo);
const contar = (eventos, tipo) => eventos.filter((evento) => evento.tipo === tipo).length;
const repetir = (valor, veces) => Array.from({ length: veces }, () => valor);

test('a mumbled "sorry—" ducks the agent volume but does not interrupt it', () => {
  // Under-the-breath interjection: attack, a strong 120 ms core, then it
  // fades out. The person did not keep talking, so the agent has to
  // restore the volume and continue its turn.
  const { eventos, state } = reproducir([
    ...repetir(SALA, 5),
    0.041, // "per-" starts weak: enough for duck, not to confirm
    0.098, // "-dón" core
    0.072,
    0.030, // goes quiet
    ...repetir(SALA, 6)
  ]);

  assert.equal(contar(eventos, 'interrupt'), 0, 'un carraspeo corto no puede cortar al agente');
  const duck = primero(eventos, 'duck');
  assert.ok(duck, 'igual hay que bajarle el volumen al agente');
  assert.equal(duck.atMs - 5 * FRAME_MS, FRAME_MS, 'el duck sale con el primer frame de voz, sin esperar nada');

  const reset = primero(eventos, 'reset');
  assert.ok(reset, 'al quedarse callada hay que devolver el volumen');
  // 240 ms of silence (2 frames below the threshold + 160 ms hysteresis).
  assert.ok(reset.atMs - 9 * FRAME_MS <= 240, `el volumen vuelve rápido (tardó ${reset.atMs - 9 * FRAME_MS} ms)`);
  assert.deepEqual(state, idleBargeInState(), 'y el estado queda limpio');
});

test('the person starts talking and holds their voice: cuts the agent off at ~360 ms', () => {
  // Real envelope of "sorry, hold on a second": soft attack, then
  // sustained voice energy near the microphone.
  const voz = [0.042, 0.104, 0.155, 0.121, 0.168, 0.132, 0.149, 0.118];
  const { eventos } = reproducir([...repetir(SALA, 3), ...voz]);

  const inicioVozMs = 3 * FRAME_MS; // the person opens their mouth here
  const duck = primero(eventos, 'duck');
  const interrupt = primero(eventos, 'interrupt');

  assert.ok(duck, 'el duck es inmediato');
  assert.equal(duck.atMs - inicioVozMs, FRAME_MS, 'el agente baja el volumen apenas llega el primer frame de voz');
  assert.ok(interrupt, 'la voz sostenida sí interrumpe');

  const latencia = interrupt.atMs - inicioVozMs;
  assert.ok(latencia >= BARGE_IN.confirmMs, `no puede cortar antes de ${BARGE_IN.confirmMs} ms (cortó a ${latencia} ms)`);
  assert.ok(latencia <= BARGE_IN.confirmMs + 2 * FRAME_MS, `tiene que cortar apenas confirma (cortó a ${latencia} ms)`);
});

test('constant background noise below the threshold does not touch the agent', () => {
  // 5 seconds of fan with micro-variations.
  const frames = Array.from({ length: 84 }, (_, index) => VENTILADOR + (index % 5) * 0.002);
  const { eventos, state } = reproducir(frames);

  assert.deepEqual(eventos, [], 'ni duck ni interrupt: el agente ni se entera');
  assert.deepEqual(state, idleBargeInState());
});

test('a sharp knock (door slam) is not enough to interrupt', () => {
  // A single very loud frame, then back to room silence.
  const { eventos, state } = reproducir([...repetir(SALA, 4), PORTAZO, ...repetir(SALA, 8)]);

  assert.equal(contar(eventos, 'interrupt'), 0, 'un transitorio no es una persona hablando');
  assert.equal(contar(eventos, 'duck'), 1, 'baja el volumen por las dudas…');
  assert.equal(contar(eventos, 'reset'), 1, '…y lo devuelve al ver que no siguió nadie');
  assert.deepEqual(state, idleBargeInState());
});

test("the agent's own echo through the speakers does not make it interrupt itself", () => {
  // Dangerous case: the speaker feeds the agent's voice back into the mic.
  // The echo is SUSTAINED (it lasts the whole turn) and sits just above the
  // start threshold, but below 1.4× the threshold. That is why the factor
  // exists: if we confirmed with the bare threshold, the agent would cut
  // itself off 250 ms into its own speech.
  const ecoSostenido = Array.from({ length: 50 }, (_, index) => ECO_DEL_AGENTE + (index % 3) * 0.002);
  assert.ok(ecoSostenido.every((rms) => rms > START && rms < LOUD), 'el eco vive entre el umbral y 1.4×');

  const { eventos, state } = reproducir(ecoSostenido);

  assert.equal(contar(eventos, 'interrupt'), 0, 'el agente nunca se interrumpe a sí mismo');
  assert.equal(state.loudMs, 0, 'el eco no acumula nada hacia la confirmación');
  assert.ok(contar(eventos, 'duck') > 0, 'sí baja el volumen, lo que además reduce el propio eco');
});

test('pauses between syllables do not erase the accumulation, a long silence does', () => {
  const conPausaCorta = reproducir([
    0.12, 0.14, // 120 ms of voice
    SALA, SALA, // 120 ms of air between words (< releaseMs)
    0.13, 0.15, 0.12 // keeps talking
  ]);
  assert.ok(primero(conPausaCorta.eventos, 'interrupt'), 'hablar entrecortado igual interrumpe');

  const conPausaLarga = reproducir([
    0.12, 0.14, // 120 ms of voice
    ...repetir(SALA, 5), // 300 ms of silence (> releaseMs): the duck released
    0.13, 0.15, 0.12 // starts again: the count restarts from zero
  ]);
  assert.equal(contar(conPausaLarga.eventos, 'interrupt'), 0, 'después de un silencio largo hay que sostener de nuevo');
  assert.ok(primero(conPausaLarga.eventos, 'reset'), 'y el volumen del agente volvió durante el silencio');
});

test('after interrupting, the state is clean for the next one', () => {
  // 4 frames of loud voice and the cut fires on the last one.
  const primeraVez = reproducir(repetir(0.14, BARGE_IN.confirmMs / FRAME_MS));
  const interrupt = primero(primeraVez.eventos, 'interrupt');

  assert.ok(interrupt);
  assert.deepEqual(primeraVez.state, idleBargeInState(), 'sin residuos del corte anterior');

  // From the cut on, the person holds the turn: the rest of their sentence is
  // no longer barge-in and must not dirty anything.
  const restoDeLaFrase = reproducir(repetir(0.15, 12), { state: primeraVez.state, userSpeaking: true });
  assert.deepEqual(restoDeLaFrase.state, idleBargeInState());

  // Another agent answers: a stray frame cannot cut it off.
  const siguiente = reproducir([PORTAZO, ...repetir(SALA, 5)], { state: restoDeLaFrase.state });
  assert.equal(contar(siguiente.eventos, 'interrupt'), 0, 'la próxima interrupción vuelve a exigir voz sostenida');
});

test("the accumulation does not survive the end of the agent's turn", () => {
  // The person starts talking just as the agent is finishing:
  // 180 ms accumulate and then the agent's audio ends on its own. That
  // remainder cannot stay stored to cut the next agent off with a single knock.
  const casiConfirmado = reproducir(repetir(0.14, 3));
  assert.equal(casiConfirmado.state.loudMs, 180);

  const agenteTerminó = reproducir([SALA, SALA], { state: casiConfirmado.state, agentSpeaking: false });
  assert.deepEqual(agenteTerminó.state, idleBargeInState(), 'se limpia al quedarse sin agente hablando');
  assert.ok(primero(agenteTerminó.eventos, 'reset'), 'y devuelve el volumen que había bajado');

  const agenteNuevo = reproducir([PORTAZO, SALA], { state: agenteTerminó.state });
  assert.equal(contar(agenteNuevo.eventos, 'interrupt'), 0, 'el agente nuevo no se come el resto del anterior');
});

test('while the person already holds the turn, barge-in is not evaluated', () => {
  const { eventos, state } = reproducir(repetir(0.2, 6), { userSpeaking: true });
  assert.equal(contar(eventos, 'interrupt'), 0, 'ya está grabando su turno: no hay a quién cortar');
  assert.equal(contar(eventos, 'duck'), 0);
  assert.deepEqual(state, idleBargeInState());
});

test('weird values (NaN, zero duration, invalid threshold) trigger nothing', () => {
  const decision = evaluateBargeIn(idleBargeInState(), {
    rms: Number.NaN,
    durationMs: Number.NaN,
    startThreshold: 0,
    agentSpeaking: true
  });
  assert.equal(decision.interrupt, false);
  assert.equal(decision.duck, false);
});

test('the pre-buffer keeps the whole confirmation window: the sentence arrives intact', () => {
  // Every frame lost from the pre-buffer is a piece of the first
  // word Whisper never sees.
  const frames = Array.from({ length: 40 }, (_, index) => ({ id: index, durationMs: FRAME_MS }));
  const guardados = trimPreBuffer(frames);
  const msGuardados = guardados.reduce((total, frame) => total + frame.durationMs, 0);

  assert.ok(
    msGuardados >= BARGE_IN.confirmMs + FRAME_MS,
    `hay que guardar al menos la ventana de confirmación (guardó ${msGuardados} ms)`
  );
  assert.equal(guardados.at(-1).id, 39, 'el frame más nuevo siempre queda');
  assert.deepEqual(guardados.map((frame) => frame.id), guardados.map((frame) => frame.id).sort((a, b) => a - b), 'en orden cronológico');
  assert.ok(guardados.length < frames.length, 'pero no se guarda todo el turno');
  assert.deepEqual(trimPreBuffer([]), [], 'sin frames no explota');
});
