import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanAgentText,
  getMentionIndex,
  includesTerm,
  isGreetingTurn,
  isSilenceResponse,
  normalize,
  stripTaskTags
} from '../server/lib/text.js';

test('normalize quita acentos y puntuación pero conserva ?', () => {
  assert.equal(normalize('¿Qué opinás, Julió?'), 'que opinas julio?');
  assert.equal(normalize('ÑANDÚ crítico'), 'nandu critico');
});

test('cleanAgentText limpia fences y prefijo de nombre, conserva tags', () => {
  assert.equal(cleanAgentText('```json\nJulio: dale, lo reviso\n```', 'Julio'), 'dale, lo reviso');
  assert.equal(cleanAgentText('SILENCIO [TAREA_CREAR: revisar stock]'), 'SILENCIO [TAREA_CREAR: revisar stock]');
  assert.equal(cleanAgentText('Tomasa: anotado'), 'anotado');
});

test('stripTaskTags remueve todos los tags', () => {
  assert.equal(stripTaskTags('dale [TAREA_CREAR: una] listo [TAREA_COMPLETAR: #1]'), 'dale listo');
});

test('isSilenceResponse solo matchea silencio exacto', () => {
  assert.equal(isSilenceResponse('SILENCIO'), true);
  assert.equal(isSilenceResponse('Silencio.'), true);
  assert.equal(isSilenceResponse('SILENCIO, nada que agregar'), false);
});

test('getMentionIndex exige límites de palabra', () => {
  assert.equal(getMentionIndex(normalize('la sistemática de ventas'), ['sistema']), -1);
  assert.ok(getMentionIndex(normalize('el sistema de ventas'), ['sistema']) >= 0);
  assert.ok(getMentionIndex(normalize('¿Julio?'), ['julio']) >= 0);
  assert.equal(getMentionIndex(normalize('julieta llegó'), ['julio']), -1);
});

test('includesTerm: dominios con límites de palabra y multi-palabra', () => {
  assert.equal(includesTerm(normalize('necesito una api rápida'), 'api'), true);
  assert.equal(includesTerm(normalize('rapidez ante todo'), 'api'), false);
  assert.equal(includesTerm(normalize('la base de datos anda lenta'), 'base de datos'), true);
  assert.equal(includesTerm(normalize('¿cómo va el stock?'), 'stock'), true);
});

test('isGreetingTurn distingue saludo puro de saludo con tema', () => {
  assert.equal(isGreetingTurn(normalize('hola equipo')), true);
  assert.equal(isGreetingTurn(normalize('hola, ¿cómo va el deploy?')), false);
});
