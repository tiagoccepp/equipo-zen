import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessInterruption,
  assessTurnCompletion,
  classifyInterruption,
  shouldCut
} from '../src/lib/turn-taking.ts';
import {
  BARGE_IN,
  classifyBargeInSignal,
  evaluateBargeIn,
  idleBargeInState
} from '../src/lib/barge-in.ts';
import {
  assessEndOfTurn,
  classifyUserInterruption,
  isBackchannelUtterance
} from '../server/lib/turn-pipeline.js';

const START = 0.0334;
const FRAME_MS = 60;
const LOUD = START * BARGE_IN.confirmRatio;
const SALA = 0.004;

const repetir = (valor, veces) => Array.from({ length: veces }, () => valor);
function reproducir(frames, opciones = {}) {
  const { agentSpeaking = true, userSpeaking = false, state = idleBargeInState() } = opciones;
  let actual = state;
  let eventos = [];
  for (const frame of frames) {
    const rms = typeof frame === 'number' ? frame : frame.rms;
    const durationMs = typeof frame === 'number' ? FRAME_MS : (frame.durationMs ?? FRAME_MS);
    const d = evaluateBargeIn(actual, {
      rms,
      durationMs,
      startThreshold: START,
      agentSpeaking: typeof frame === 'object' && 'agentSpeaking' in frame ? frame.agentSpeaking : agentSpeaking,
      userSpeaking,
      backchannelLikely: opciones.backchannelLikely
    });
    actual = d.state;
    if (d.duck) eventos.push('duck');
    if (d.interrupt) eventos.push('interrupt');
    if (d.reset) eventos.push('reset');
    if (d.isBackchannelSuppressed) eventos.push('suppressed');
  }
  return { eventos, state: actual };
}

test('t2 interruption: backchannels ES/EN are non-interrupting with signals', () => {
  for (const t of ['ajá', 'aja', 'dale', 'mm', 'mmm', 'ok', 'sí', 'si', 'claro', 'yeah', 'uh-huh', 'got it', 'ya veo']) {
    const a = assessInterruption(t);
    assert.equal(a.isBackchannel, true, t);
    assert.equal(a.shouldInterrupt, false, t);
    assert.equal(a.interruptStrength, 0, t);
    assert.equal(classifyInterruption(t), 'backchannel', t);
    assert.equal(shouldCut(classifyInterruption(t)), false, t);
  }
});

test('t2 interruption: real commands and substantive speech interrupt', () => {
  for (const t of ['pará', 'para', 'esperá', 'wait', 'hold on', 'basta', 'no no']) {
    const a = assessInterruption(t);
    assert.equal(a.isBackchannel, false, t);
    assert.equal(a.shouldInterrupt, true, t);
    assert.ok(a.interruptStrength >= 0.9, `${t} strength ${a.interruptStrength}`);
  }
  for (const t of ['cambiá el color a azul', 'no, mejor en rojo', 'explicame los precios']) {
    const a = assessInterruption(t);
    assert.equal(a.class, 'content', t);
    assert.equal(a.shouldInterrupt, true, t);
    assert.ok(a.interruptStrength >= 0.5 && a.interruptStrength <= 1, `${t} strength ${a.interruptStrength}`);
  }
});

test('t2 interruption: short ambiguous noise does not hard-interrupt', () => {
  for (const t of ['', 'e', 'eh', 'ah']) {
    const a = assessInterruption(t);
    assert.equal(a.shouldInterrupt, false, JSON.stringify(t));
    assert.equal(a.isBackchannel, false, JSON.stringify(t));
  }
});

test('t2 turn completion: terminal punctuation and silence imply likely complete', () => {
  const done = assessTurnCompletion({ text: 'Gracias, eso era todo.', silenceMs: 800, endSilenceMs: 700 });
  assert.equal(done.likelyComplete, true);
  assert.equal(done.trailingConnector, false);
  assert.equal(done.terminalPunctuation, true);
  assert.ok(done.confidence >= 0.8);
});

test('t2 turn completion: trailing connector is conservative (not complete)', () => {
  for (const t of ['quiero que', 'te llamo porque', 'lo hago con', 'and then I']) {
    const a = assessTurnCompletion({ text: t, silenceMs: 1200, endSilenceMs: 700 });
    assert.equal(a.likelyComplete, false, t);
    assert.equal(a.trailingConnector, true, t);
  }
});

test('t2 turn completion: long utterance without punctuation stays conservative', () => {
  const a = assessTurnCompletion({
    text: 'necesito que revises el informe y después me digas si falta algo importante',
    silenceMs: 900,
    endSilenceMs: 700
  });
  assert.equal(a.likelyComplete, false);
  assert.ok(a.confidence > 0);
});

test('t2 turn completion: short answer with silence can be complete', () => {
  const a = assessTurnCompletion({ text: 'gracias', silenceMs: 900, endSilenceMs: 700 });
  assert.equal(a.likelyComplete, true);
});

test('t2 barge-in: acoustic confirmation is suppressed for likely backchannel', () => {
  const voz = [0.042, 0.104, 0.155, 0.121, 0.168, 0.132, 0.149, 0.118];
  const normal = reproducir([...repetir(SALA, 3), ...voz]);
  assert.ok(normal.eventos.includes('interrupt'), 'real speech should interrupt');

  const back = reproducir([...repetir(SALA, 3), ...voz], { backchannelLikely: true });
  assert.equal(back.eventos.includes('interrupt'), false, 'backchannel must not hard-interrupt');
  assert.ok(back.eventos.includes('suppressed') || back.eventos.includes('duck'), 'should duck/suppress instead');
});

test('t2 barge-in signal helper exposes pipeline signals', () => {
  const bc = classifyBargeInSignal({ acousticInterrupt: true, acousticStrength: 1, transcript: 'ajá', isBackchannel: true });
  assert.deepEqual(bc, { isBackchannel: true, likelyComplete: false, interruptStrength: 0, shouldInterrupt: false });
  const real = classifyBargeInSignal({ acousticInterrupt: false, acousticStrength: 0.8, transcript: 'pará un momento', isBackchannel: false });
  assert.equal(real.isBackchannel, false);
  assert.equal(real.shouldInterrupt, true);
  assert.ok(real.interruptStrength >= 0.6);
});

test('t2 turn-pipeline helpers classify backchannel vs interruption', () => {
  assert.equal(isBackchannelUtterance('ajá'), true);
  assert.equal(isBackchannelUtterance('dale'), true);
  assert.equal(isBackchannelUtterance('mm'), true);
  assert.equal(isBackchannelUtterance('pará'), false);

  const bc = classifyUserInterruption('ok', { agentSpeaking: true });
  assert.equal(bc.isBackchannel, true);
  assert.equal(bc.shouldInterrupt, false);
  assert.equal(bc.interruptStrength, 0);

  const stop = classifyUserInterruption('esperá', { agentSpeaking: true });
  assert.equal(stop.isBackchannel, false);
  assert.equal(stop.shouldInterrupt, true);
  assert.equal(stop.interruptStrength, 1);

  const content = classifyUserInterruption('cambiá el plan', { agentSpeaking: true });
  assert.equal(content.isBackchannel, false);
  assert.equal(content.shouldInterrupt, true);
  assert.ok(content.interruptStrength > 0.5);
});

test('t2 turn-pipeline end-of-turn assessment is conservative', () => {
  const trailing = assessEndOfTurn({ text: 'te decía que', silenceMs: 1000, endSilenceMs: 700 });
  assert.equal(trailing.likelyComplete, false);
  assert.equal(trailing.trailingConnector, true);

  const done = assessEndOfTurn({ text: 'Listo, gracias.', silenceMs: 900, endSilenceMs: 700 });
  assert.equal(done.likelyComplete, true);
  assert.equal(done.terminalPunctuation, true);
  assert.ok(done.confidence >= 0.8);
});
