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
, createTagFilter, stripForeignScript } from '../server/lib/text.js';

test('normalize strips accents and punctuation but keeps ?', () => {
  assert.equal(normalize('¿Qué opinás, Julió?'), 'que opinas julio?');
  assert.equal(normalize('ÑANDÚ crítico'), 'nandu critico');
});

test('cleanAgentText cleans fences and name prefix, keeps tags', () => {
  assert.equal(cleanAgentText('```json\nJulio: dale, lo reviso\n```', 'Julio'), 'dale, lo reviso');
  assert.equal(cleanAgentText('SILENCIO [TAREA_CREAR: revisar stock]'), 'SILENCIO [TAREA_CREAR: revisar stock]');
  assert.equal(cleanAgentText('Tomasa: anotado'), 'anotado');
});

test('stripTaskTags removes all tags', () => {
  assert.equal(stripTaskTags('dale [TAREA_CREAR: una] listo [TAREA_COMPLETAR: #1]'), 'dale listo');
});

test('isSilenceResponse only matches exact silence', () => {
  assert.equal(isSilenceResponse('SILENCIO'), true);
  assert.equal(isSilenceResponse('Silencio.'), true);
  assert.equal(isSilenceResponse('SILENCIO, nada que agregar'), false);
});

test('getMentionIndex requires word boundaries', () => {
  assert.equal(getMentionIndex(normalize('la sistemática de ventas'), ['sistema']), -1);
  assert.ok(getMentionIndex(normalize('el sistema de ventas'), ['sistema']) >= 0);
  assert.ok(getMentionIndex(normalize('¿Julio?'), ['julio']) >= 0);
  assert.equal(getMentionIndex(normalize('julieta llegó'), ['julio']), -1);
});

test('includesTerm: domains with word boundaries and multi-word', () => {
  assert.equal(includesTerm(normalize('necesito una api rápida'), 'api'), true);
  assert.equal(includesTerm(normalize('rapidez ante todo'), 'api'), false);
  assert.equal(includesTerm(normalize('la base de datos anda lenta'), 'base de datos'), true);
  assert.equal(includesTerm(normalize('¿cómo va el stock?'), 'stock'), true);
});

test('isGreetingTurn distinguishes pure greeting from greeting with topic', () => {
  assert.equal(isGreetingTurn(normalize('hola equipo')), true);
  assert.equal(isGreetingTurn(normalize('hola, ¿cómo va el deploy?')), false);
});

test('task tags are not seen while the agent speaks', () => {
  // They arrive split across stream deltas, just as the model sends them.
  const filtro = createTagFilter();
  const deltas = ['Dale, ', 'lo armamos. ', '[TAREA_', 'CREAR: Bruno', ': hacer la landing]'];
  let visible = '';
  for (const delta of deltas) {
    visible += filtro.push(delta);
  }
  visible += filtro.flush();
  assert.equal(visible, 'Dale, lo armamos. ', 'la etiqueta nunca aparece en pantalla');
});

test('a bracket that is not a tag still shows', () => {
  const filtro = createTagFilter();
  let visible = filtro.push('El presupuesto queda [entre 100 y 200] mil');
  visible += filtro.flush();
  assert.equal(visible, 'El presupuesto queda [entre 100 y 200] mil');
});

test('an open bracket that never closes does not swallow the end of the message', () => {
  const filtro = createTagFilter();
  let visible = filtro.push('Quedó pendiente [revisar');
  visible += filtro.flush();
  assert.equal(visible, 'Quedó pendiente [revisar');
});

test('characters from another alphabet reach neither the screen nor the voice', () => {
  // REAL cases MiniMax left in the journal (~1% of replies).
  assert.equal(
    stripForeignScript('Depende de qué tan在三 estén los tests'),
    'Depende de qué tan estén los tests'
  );
  assert.equal(
    stripForeignScript('¡Buenas! Acá，期待 a ver qué sale.'),
    '¡Buenas! Acá, a ver qué sale.'
  );
  // Replaced by a space, not by empty: otherwise two words stick together.
  assert.equal(
    stripForeignScript('¿Qué的手臂们andan armando?'),
    '¿Qué andan armando?'
  );
});

test('normal Spanish is untouched', () => {
  const texto = 'Mañana revisamos el diseño: ¿te parece a las 10? Señalá los pendientes.';
  assert.equal(stripForeignScript(texto), texto);
  assert.equal(stripForeignScript(''), '');
});
