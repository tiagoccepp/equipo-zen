import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SpeculativeTurnController,
  createQuickPathState,
  endsWithTrailingConnector,
  hasTerminalPunctuation,
  isQuickPathEnabled,
  shouldPreempt
} from '../server/lib/quick-path.js';

test('quick path: disabled by default', () => {
  assert.equal(isQuickPathEnabled({}), false);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: '' }), false);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: '0' }), false);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: 'false' }), false);
});

test('quick path: enabled by env flag', () => {
  assert.equal(isQuickPathEnabled({ QUICK_PATH: '1' }), true);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: 'true' }), true);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: 'yes' }), true);
  assert.equal(isQuickPathEnabled({ QUICK_PATH: 'on' }), true);
});

test('quick path: heuristics detect terminal punctuation and short complete utterances', () => {
  assert.equal(hasTerminalPunctuation('Hola, ¿cómo estás?'), true);
  assert.equal(hasTerminalPunctuation('Listo.'), true);
  assert.equal(endsWithTrailingConnector('quiero que hagas'), false);
  assert.equal(endsWithTrailingConnector('quiero que hagas y'), true);
  assert.equal(endsWithTrailingConnector('I was thinking but'), true);

  assert.equal(shouldPreempt('Listo.'), true);
  assert.equal(shouldPreempt('dale'), true);
  assert.equal(shouldPreempt('ok gracias'), true);
  assert.equal(shouldPreempt('quiero que hagas y'), false);
  assert.equal(shouldPreempt(''), false);
});

test('quick path: long utterance without punctuation is conservative (no preempt)', () => {
  assert.equal(shouldPreempt('necesito que revises el documento completo antes de enviarlo mañana'), false);
});

test('speculative controller: buffers, commits in order, and clears active state', () => {
  const c = new SpeculativeTurnController();
  c.start('t1');
  assert.equal(c.isSpeculative('t1'), true);
  assert.equal(c.shouldBuffer('t1'), true);
  assert.equal(c.buffer('t1', { type: 'route_decision', turnId: 't1' }), true);
  assert.equal(c.buffer('t1', { type: 'agent_turn_complete', turnId: 't1', text: 'hola' }), true);

  const out = c.commit('t1');
  assert.deepEqual(out.map((e) => e.type), ['route_decision', 'agent_turn_complete']);
  assert.equal(c.isSpeculative('t1'), false);
  assert.equal(c.active, null);
});

test('speculative controller: discard drops buffered output and blocks commit', () => {
  const c = new SpeculativeTurnController();
  c.start('t2');
  c.buffer('t2', { type: 'agent_transcript_delta', turnId: 't2', delta: 'parcial' });
  const r = c.discard('t2', 'user_continued');
  assert.equal(r.ok, true);
  assert.equal(c.isSpeculative('t2'), false);
  assert.deepEqual(c.commit('t2'), []);
  assert.equal(c.active, null);
});

test('speculative controller: ignores other turn ids', () => {
  const c = new SpeculativeTurnController();
  c.start('t3');
  assert.equal(c.isSpeculative('other'), false);
  assert.equal(c.shouldBuffer('other'), false);
  assert.equal(c.buffer('other', { type: 'x' }), false);
  assert.deepEqual(c.commit('other'), []);
  assert.equal(c.discard('other').ok, false);
  assert.equal(c.active?.turnId, 't3');
});

test('quick path state: default shape', () => {
  const s = createQuickPathState();
  assert.equal(s.enabled, false);
  assert.equal(s.pendingSpeculative, null);
  assert.equal(s.discardedTurnId, null);
  assert.ok(s.speculative instanceof SpeculativeTurnController);
});
