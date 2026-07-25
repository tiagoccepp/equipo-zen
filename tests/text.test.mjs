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

test('las etiquetas de tarea no se ven mientras el agente habla', () => {
  // Llegan partidas entre deltas del stream, tal cual las manda el modelo.
  const filtro = createTagFilter();
  const deltas = ['Dale, ', 'lo armamos. ', '[TAREA_', 'CREAR: Bruno', ': hacer la landing]'];
  let visible = '';
  for (const delta of deltas) {
    visible += filtro.push(delta);
  }
  visible += filtro.flush();
  assert.equal(visible, 'Dale, lo armamos. ', 'la etiqueta nunca aparece en pantalla');
});

test('un corchete que no es etiqueta se muestra igual', () => {
  const filtro = createTagFilter();
  let visible = filtro.push('El presupuesto queda [entre 100 y 200] mil');
  visible += filtro.flush();
  assert.equal(visible, 'El presupuesto queda [entre 100 y 200] mil');
});

test('un corchete abierto que nunca cierra no se traga el final del mensaje', () => {
  const filtro = createTagFilter();
  let visible = filtro.push('Quedó pendiente [revisar');
  visible += filtro.flush();
  assert.equal(visible, 'Quedó pendiente [revisar');
});

test('los caracteres de otro alfabeto no llegan a la pantalla ni a la voz', () => {
  // Casos REALES que MiniMax dejó en el diario (~1% de las respuestas).
  assert.equal(
    stripForeignScript('Depende de qué tan在三 estén los tests'),
    'Depende de qué tan estén los tests'
  );
  assert.equal(
    stripForeignScript('¡Buenas! Acá，期待 a ver qué sale.'),
    '¡Buenas! Acá, a ver qué sale.'
  );
  // Se reemplaza por espacio, no por vacío: si no, dos palabras quedan pegadas.
  assert.equal(
    stripForeignScript('¿Qué的手臂们andan armando?'),
    '¿Qué andan armando?'
  );
});

test('el español normal no se toca', () => {
  const texto = 'Mañana revisamos el diseño: ¿te parece a las 10? Señalá los pendientes.';
  assert.equal(stripForeignScript(texto), texto);
  assert.equal(stripForeignScript(''), '');
});
