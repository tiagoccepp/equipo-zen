// Tests for the verbal-expression layer (expressive.js): tag catalog, prompt
// rules, parser (text + events), TTS delivery mapping, anti-abuse policy and
// transcript normalization. Pure module, no disk/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPRESSION_TAGS,
  expressionInstructions,
  parseExpressions,
  applyDelivery,
  createExpressionPolicy,
  normalizeForTranscript
} from '../server/lib/expressive.js';

// ── Catálogo ──────────────────────────────────────────────────────────

test('EXPRESSION_TAGS has the expected delivery and sound groups', () => {
  assert.deepEqual(Object.keys(EXPRESSION_TAGS.delivery).sort(), ['emphasis', 'fast', 'slow', 'soft']);
  assert.deepEqual(
    Object.keys(EXPRESSION_TAGS.sound).sort(),
    ['a_ver', 'breath', 'bueno', 'claro', 'dale', 'eh', 'laugh', 'mm', 'sigh']
  );
  assert.ok(Object.isFrozen(EXPRESSION_TAGS));
});

// ── parseExpressions ──────────────────────────────────────────────────

test('parse removes [tag] and <tag> and reports ordered events', () => {
  const input = 'Che [laugh] mirá <slow> esto';
  const { text, events } = parseExpressions(input);
  assert.equal(text, 'Che mirá esto');
  assert.deepEqual(events, [
    { kind: 'sound', name: 'laugh', index: input.indexOf('[laugh]') },
    { kind: 'delivery', name: 'slow', index: input.indexOf('<slow>') }
  ]);
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i - 1].index < events[i].index, 'events ordenados por index');
  }
});

test('parse is case-insensitive and returns canonical lowercase names', () => {
  const { text, events } = parseExpressions('[LAUGH] Dale <Soft>');
  assert.equal(text, 'Dale');
  assert.deepEqual(
    events.map((event) => `${event.kind}:${event.name}`),
    ['sound:laugh', 'delivery:soft']
  );
});

test('unknown tags stay literal and generate no event', () => {
  const { text, events } = parseExpressions('Hola [divertido] y <div> fin [laugh]');
  assert.equal(text, 'Hola [divertido] y <div> fin');
  assert.deepEqual(events, [{ kind: 'sound', name: 'laugh', index: 'Hola [divertido] y <div> fin [laugh]'.indexOf('[laugh]') }]);
});

test('null, undefined, empty and whitespace-only input are safe', () => {
  for (const value of [null, undefined, '', '   ', '\n\t ']) {
    const parsed = parseExpressions(value);
    assert.equal(parsed.text, '');
    assert.deepEqual(parsed.events, []);
  }
});

test('unclosed or mismatched brackets do not break the parser', () => {
  assert.deepEqual(parseExpressions('Hola [laugh'), { text: 'Hola [laugh', events: [] });
  assert.deepEqual(parseExpressions('Che <slow'), { text: 'Che <slow', events: [] });
  assert.deepEqual(parseExpressions('Hola [laugh> fin'), { text: 'Hola [laugh> fin', events: [] });
  assert.deepEqual(parseExpressions('[laugh'), { text: '[laugh', events: [] });
});

test('repeated tags remove cleanly and keep one event each', () => {
  const { text, events } = parseExpressions('[laugh][laugh] Ya voy');
  assert.equal(text, 'Ya voy');
  assert.equal(events.filter((event) => event.name === 'laugh').length, 2);
  assert.equal(text.includes('[laugh]'), false);
});

test('cleanup removes double spaces and spaces before punctuation', () => {
  assert.equal(parseExpressions('Hola [laugh] , ¿qué tal?').text, 'Hola, ¿qué tal?');
  assert.equal(parseExpressions('Listo  [slow]   vamos.').text, 'Listo vamos.');
  assert.equal(parseExpressions('[laugh]').text, '');
});

test('removing a glued tag inserts a space instead of joining words', () => {
  assert.equal(parseExpressions('hola[laugh]mundo').text, 'hola mundo');
});

// ── applyDelivery ─────────────────────────────────────────────────────

test('applyDelivery maps the first delivery tag and strips every tag', () => {
  const cases = [
    ['[slow] Vamos', '-10%', '+0%', 'Vamos'],
    ['[fast] Vamos', '+10%', '+0%', 'Vamos'],
    ['[soft] Te escucho', '+0%', '-12%', 'Te escucho'],
    ['[emphasis] Eso mismo', '+0%', '+8%', 'Eso mismo']
  ];
  for (const [input, rate, volume, text] of cases) {
    assert.deepEqual(applyDelivery(input), { text, rate, volume });
  }
});

test('applyDelivery uses only the first delivery tag and removes sounds too', () => {
  const result = applyDelivery('[laugh] [slow] [fast] hola');
  assert.deepEqual(result, { text: 'hola', rate: '-10%', volume: '+0%' });
});

test('applyDelivery defaults to neutral rate and volume', () => {
  assert.deepEqual(applyDelivery('Texto sin etiquetas'), { text: 'Texto sin etiquetas', rate: '+0%', volume: '+0%' });
  assert.deepEqual(applyDelivery(null), { text: '', rate: '+0%', volume: '+0%' });
});

// ── createExpressionPolicy ────────────────────────────────────────────

test('policy limits sounds to one every two turns by default', () => {
  const policy = createExpressionPolicy();
  assert.equal(policy.allow('sound', 0), true);
  assert.equal(policy.record('laugh', 0), true);
  assert.equal(policy.allow('sound', 1), false);
  assert.equal(policy.allow('sound', 2), true);
  assert.equal(policy.record('bueno', 2), true);
  assert.equal(policy.allow('sound', 3), false);
  assert.equal(policy.allow('sound', 4), true);
});

test('policy honors a custom soundGap and rejects a repeated sound', () => {
  const policy = createExpressionPolicy({ soundGap: 3 });
  policy.record('laugh', 0);
  assert.equal(policy.allow('sound', 2), false);
  assert.equal(policy.allow('sound', 3), true);
  assert.equal(policy.allow('sound', 3, 'laugh'), false);
  assert.equal(policy.allow('sound', 3, 'bueno'), true);
});

test('policy caps delivery tags per turn and resets per turn', () => {
  const policy = createExpressionPolicy();
  assert.equal(policy.allow('delivery', 1), true);
  policy.record('slow', 1);
  assert.equal(policy.allow('delivery', 1), true);
  policy.record('soft', 1);
  assert.equal(policy.allow('delivery', 1), false);
  assert.equal(policy.allow('delivery', 2), true);

  const strict = createExpressionPolicy({ deliveryPerTurn: 1 });
  strict.record('emphasis', 0);
  assert.equal(strict.allow('delivery', 0), false);
});

test('policy rejects unknown kinds/tags and reports stats', () => {
  const policy = createExpressionPolicy();
  assert.equal(policy.allow('magic', 0), false);
  assert.equal(policy.record('nope', 0), false);
  assert.equal(policy.record('laugh', 0), true);
  assert.equal(policy.record('[slow]', 0), true);
  assert.equal(policy.stats().sounds, 1);
  assert.equal(policy.stats().deliveries, 1);
  assert.equal(policy.stats().total, 2);
  assert.equal(policy.stats().byTag.laugh, 1);
  assert.equal(policy.stats().lastSound, 'laugh');
  assert.equal(policy.stats().deliveriesByTurn[0], 1);

  policy.reset();
  assert.equal(policy.stats().total, 0);
  assert.deepEqual(policy.stats().byTag, {});
  assert.equal(policy.allow('sound', 0), true);
});

// ── expressionInstructions ────────────────────────────────────────────

test('instructions include the key rules and the tag catalog', () => {
  const block = expressionInstructions();
  for (const needle of [
    'Máximo 1 etiqueta por turno',
    '[laugh]',
    'rioplatense',
    'tool calls',
    'emergencia',
    'Nunca dos muletillas iguales seguidas',
    'No inventes datos',
    'es-UY'
  ]) {
    assert.ok(block.includes(needle), `falta: ${needle}`);
  }
});

test('instructions respect an allowed subset and an empty allow-list', () => {
  const only = expressionInstructions({ allowed: ['laugh'] });
  assert.ok(only.includes('[laugh]'));
  assert.equal(only.includes('[sigh]'), false);
  assert.equal(only.includes('[soft]'), false);
  assert.match(only, /Solo podés usar/);

  const none = expressionInstructions({ allowed: [] });
  assert.match(none, /no uses etiquetas/i);
  assert.equal(none.includes('[laugh]'), false);

  const bracketed = expressionInstructions({ allowed: ['[laugh]', '<slow>'] });
  assert.ok(bracketed.includes('[laugh]'));
  assert.ok(bracketed.includes('[slow]'));
  assert.equal(bracketed.includes('[sigh]'), false);
});

test('instructions switch to English when language starts with en', () => {
  const block = expressionInstructions({ language: 'en-US' });
  assert.ok(block.includes('en-US'));
  assert.ok(block.includes('[laugh]'));
  assert.match(block, /At most 1 tag per turn/);
});

// ── normalizeForTranscript ────────────────────────────────────────────

test('normalizeForTranscript strips tags and tidies spacing', () => {
  assert.equal(normalizeForTranscript('Hola [laugh]  <slow> mundo'), 'Hola mundo');
  assert.equal(normalizeForTranscript(null), '');
  assert.equal(normalizeForTranscript('Uno [laugh] , dos.'), 'Uno, dos.');
  assert.equal(normalizeForTranscript('[divertido] queda'), '[divertido] queda');
});

// ── Rendimiento (regex lineal, sin backtracking catastrófico) ─────────

test('long tag-heavy strings parse in linear time', () => {
  const many = '[laugh]'.repeat(5000); // 10k corchetes
  const started = Date.now();
  const parsed = parseExpressions(many);
  const elapsed = Date.now() - started;
  assert.equal(parsed.events.length, 5000);
  assert.equal(parsed.text, '');
  assert.ok(elapsed < 2000, `parseExpressions tardó ${elapsed}ms`);

  const nails = '['.repeat(50000);
  const startedNails = Date.now();
  const nailing = parseExpressions(nails);
  const elapsedNails = Date.now() - startedNails;
  assert.equal(nailing.text.length, 50000);
  assert.deepEqual(nailing.events, []);
  assert.ok(elapsedNails < 1000, `corchetes sin cerrar tardaron ${elapsedNails}ms`);
});
