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

test('mientras hay un turno humano en vuelo, el trabajo de fondo cede', () => {
  resetTurnPriority();
  assert.equal(isUserSpeaking(), false);

  beginUserTurn();
  assert.equal(isUserSpeaking(), true, 'la persona tiene prioridad');

  endUserTurn();
  // Colchón: recién terminado sigue teniendo prioridad (suele encadenar ideas).
  assert.equal(isUserSpeaking(), true);
  resetTurnPriority();
});

test('turnos anidados: la prioridad no se libera hasta que terminan todos', () => {
  resetTurnPriority();
  beginUserTurn();
  beginUserTurn();
  endUserTurn();
  assert.equal(isUserSpeaking(), true, 'queda un turno en vuelo');
  endUserTurn();
  resetTurnPriority();
  assert.equal(isUserSpeaking(), false);
});

test('con una reunión abierta el equipo trabaja de a uno', () => {
  resetTurnPriority();
  assert.equal(hasLiveSession(), false);
  registerSession();
  assert.equal(hasLiveSession(), true);
  unregisterSession();
  assert.equal(hasLiveSession(), false);
  // Nunca baja de cero aunque se cierre de más.
  unregisterSession();
  assert.equal(hasLiveSession(), false);
});
