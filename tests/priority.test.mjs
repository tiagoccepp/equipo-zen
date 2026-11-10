import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginUserTurn,
  endUserTurn,
  hasLiveSession,
  isUserSpeaking,
  registerSession,
  resetTurnPriority,
  unregisterSession
} from '../server/lib/priority.js';

test('while a human turn is in flight, background work yields', () => {
  resetTurnPriority();
  assert.equal(isUserSpeaking(), false);

  beginUserTurn();
  assert.equal(isUserSpeaking(), true, 'la persona tiene prioridad');

  endUserTurn();
  // Cushion: just finished still has priority (people usually chain ideas).
  assert.equal(isUserSpeaking(), true);
  resetTurnPriority();
});

test('nested turns: priority is not released until all of them end', () => {
  resetTurnPriority();
  beginUserTurn();
  beginUserTurn();
  endUserTurn();
  assert.equal(isUserSpeaking(), true, 'queda un turno en vuelo');
  endUserTurn();
  resetTurnPriority();
  assert.equal(isUserSpeaking(), false);
});

test('with an open meeting the team works one at a time', () => {
  resetTurnPriority();
  assert.equal(hasLiveSession(), false);
  registerSession();
  assert.equal(hasLiveSession(), true);
  unregisterSession();
  assert.equal(hasLiveSession(), false);
  // Never drops below zero even if closed extra times.
  unregisterSession();
  assert.equal(hasLiveSession(), false);
});
