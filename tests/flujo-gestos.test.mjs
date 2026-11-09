// Motor de gestos T2a: protocolo [[gesto:NOMBRE]] + registro A (50 glifos).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GESTOS_A,
  SHAPE_NAMES,
  STATE_NAMES,
  VALID_GESTOS,
  isValidGesto,
  listGestos,
  parseGesto,
  registerGestos
} from '../server/lib/gestos.js';
import {
  GLYPHS_A,
  GLYPH_A_NAMES,
  foldGlyphName,
  listGlyphNames,
  lookupGlyph,
  lookupGlyphA,
  registerExtraGlyphs
} from '../src/fx/glyphs-a.ts';

// ── parseGesto ─────────────────────────────────────────────────────────

test('parse: tag simple → gesto + texto limpio', () => {
  const r = parseGesto('hola [[gesto:saludar]] cómo va');
  assert.equal(r.gesto, 'saludar');
  assert.equal(r.cleanText, 'hola cómo va');
});

test('parse: case-insensitive + espacios + tildes', () => {
  assert.equal(parseGesto('x [[GESTO:Saludar]] y').gesto, 'saludar');
  assert.equal(parseGesto('x [[gesto:Pulgar Arriba]] y').gesto, 'pulgar_arriba');
  assert.equal(parseGesto('x [[gesto:guiño]] y').gesto, 'guino');
  assert.equal(parseGesto('x [[gesto:  risa  ]] y').gesto, 'risa');
});

test('parse: múltiple → primer VÁLIDO gana, todos se limpian', () => {
  const r = parseGesto('a [[gesto:sonrisa]] b [[gesto:enojo]] c');
  assert.equal(r.gesto, 'sonrisa');
  assert.equal(r.cleanText, 'a b c');
  // Primero desconocido → se sigue buscando (el común "primer tag gana"
  // vale cuando todos son válidos).
  const r2 = parseGesto('a [[gesto:noexiste]] b [[gesto:calma]] c');
  assert.equal(r2.gesto, 'calma');
  assert.equal(r2.cleanText, 'a b c');
});

test('parse: ausente → null y texto intacto', () => {
  const r = parseGesto('hola mundo sin tags');
  assert.equal(r.gesto, null);
  assert.equal(r.cleanText, 'hola mundo sin tags');
});

test('parse: desconocido → null pero el tag se quita igual', () => {
  const r = parseGesto('hola [[gesto:zzz_nope]] mundo');
  assert.equal(r.gesto, null);
  assert.equal(r.cleanText, 'hola mundo');
});

test('parse: solo-tag → texto vacío; colapsa espacios', () => {
  assert.equal(parseGesto('[[gesto:saludar]]').cleanText, '');
  assert.equal(parseGesto('hola   [[gesto:saludar]]   mundo').cleanText, 'hola mundo');
});

test('parse: entradas raras no tiran', () => {
  assert.deepEqual(parseGesto(''), { gesto: null, cleanText: '' });
  assert.deepEqual(parseGesto(null), { gesto: null, cleanText: '' });
  assert.deepEqual(parseGesto(undefined), { gesto: null, cleanText: '' });
  assert.equal(parseGesto('[[gesto:]]').gesto, null);
  assert.equal(parseGesto('[[gesto:saludar]').gesto, null); // tag roto: no es tag
});

test('parse: figuras de estado también son gestos válidos', () => {
  assert.equal(parseGesto('x [[gesto:hablando]]').gesto, 'hablando');
  assert.equal(parseGesto('x [[gesto:cube]]').gesto, 'cube');
  assert.equal(parseGesto('x [[gesto:IDLE]]').gesto, 'idle');
});

// ── Registro backend ───────────────────────────────────────────────────

test('VALID_GESTOS: 100 (A+B) + 5 estados + 5 shapes', () => {
  assert.equal(GESTOS_A.length, 50);
  for (const n of GESTOS_A) assert.ok(VALID_GESTOS.has(n), `falta ${n}`);
  for (const n of [...STATE_NAMES, ...SHAPE_NAMES]) {
    assert.ok(VALID_GESTOS.has(n), `falta estado/shape ${n}`);
  }
  assert.equal(VALID_GESTOS.size, 100 + STATE_NAMES.length + SHAPE_NAMES.length);
});

test('registerGestos: suma B sin pisar A', () => {
  const before = VALID_GESTOS.size;
  const r = registerGestos(['fuego_boreal_zzz', 'saludar', 'agua_mansa_zzz']);
  assert.equal(r.added, 2);
  assert.deepEqual(r.skipped, ['saludar']);
  assert.equal(VALID_GESTOS.size, before + 2);
  assert.ok(isValidGesto('FUEGO_boreal_ZZZ'));
  assert.equal(parseGesto('x [[gesto:agua_mansa_zzz]]').gesto, 'agua_mansa_zzz');
  // Limpieza: no dejar basura para otros tests del archivo.
  VALID_GESTOS.delete('fuego_boreal_zzz');
  VALID_GESTOS.delete('agua_mansa_zzz');
  assert.ok(listGestos().length >= 60);
});

// ── Registro A (frontend, import directo vía type-stripping) ────────────

test('GLYPHS_A: 50 únicos, snake_case, con tags', () => {
  assert.equal(GLYPHS_A.length, 50);
  assert.equal(GLYPH_A_NAMES.length, 50);
  assert.equal(new Set(GLYPH_A_NAMES).size, 50);
  for (const g of GLYPHS_A) {
    assert.match(g.name, /^[a-z][a-z0-9_]*$/, `nombre raro: ${g.name}`);
    assert.ok(Array.isArray(g.tags) && g.tags.length >= 1, `sin tags: ${g.name}`);
    assert.equal(typeof g.points, 'function');
  }
});

test('cruce: GESTOS_A (backend) == GLYPH_A_NAMES (frontend)', () => {
  assert.deepEqual(new Set(GESTOS_A), new Set(GLYPH_A_NAMES));
});

test('lookup: case-insensitive, tildes, null si no existe', () => {
  assert.equal(lookupGlyphA('SALUDAR')?.name, 'saludar');
  assert.equal(lookupGlyph('Guiño')?.name, 'guino');
  assert.equal(lookupGlyph('pulgar arriba')?.name, 'pulgar_arriba');
  assert.equal(lookupGlyph('no_existe_zzz'), null);
  assert.equal(lookupGlyphA('no_existe_zzz'), null);
  assert.equal(foldGlyphName('  GUIÑO  '), 'guino');
});

test('registerExtraGlyphs: B no pisa A; lookupGlyph ve extras', () => {
  const fake = { name: 'saludar', tags: ['x'], points: () => new Float32Array(3) };
  const extra = {
    name: 'gesto_extra_zzz',
    tags: ['test'],
    points: (c) => new Float32Array(Math.max(1, Math.round(c)) * 3)
  };
  const r = registerExtraGlyphs([fake, extra]);
  assert.equal(r.added, 1);
  assert.deepEqual(r.skipped, ['saludar']);
  assert.equal(lookupGlyph('gesto_extra_zzz')?.name, 'gesto_extra_zzz');
  assert.ok(listGlyphNames().includes('gesto_extra_zzz'));
  assert.equal(lookupGlyph('saludar')?.tags.includes('x'), false); // A intacto
});

test('puntos: longitud, rango [-1,1], finitos (los 50)', () => {
  const COUNT = 240;
  for (const g of GLYPHS_A) {
    const pts = g.points(COUNT, 7);
    assert.ok(pts instanceof Float32Array, g.name);
    assert.equal(pts.length, COUNT * 3, `longitud ${g.name}`);
    for (let i = 0; i < pts.length; i += 1) {
      const v = pts[i];
      assert.ok(Number.isFinite(v), `${g.name}[${i}] no finito`);
      assert.ok(v >= -1 && v <= 1, `${g.name}[${i}]=${v} fuera de rango`);
    }
  }
});

test('puntos: deterministas por seed (los 50)', () => {
  for (const g of GLYPHS_A) {
    const a = g.points(120, 42);
    const b = g.points(120, 42);
    assert.deepEqual(a, b, `no determinista: ${g.name}`);
  }
});

test('puntos: seeds distintas → puntos distintos (los 50)', () => {
  for (const g of GLYPHS_A) {
    const a = g.points(120, 1);
    const b = g.points(120, 2);
    assert.notDeepEqual(a, b, `seed ignorada: ${g.name}`);
  }
});

test('puntos: counts chicos y grandes no tiran', () => {
  for (const g of GLYPHS_A) {
    assert.equal(g.points(1, 0).length, 3, g.name);
    assert.equal(g.points(720, 9).length, 720 * 3, g.name);
  }
});

// ── Cruce B (integración main): GESTOS_B == GLYPHS_B, 100 únicos ────────
import { GESTOS_B } from '../server/lib/gestos.js';
import { GLYPHS_B } from '../src/fx/glyphs-b.ts';

test('cruce: GESTOS_B (backend) == GLYPHS_B (frontend), A∩B=∅', () => {
  const namesB = GLYPHS_B.map((g) => g.name);
  assert.equal(namesB.length, 50);
  assert.deepEqual(new Set(GESTOS_B), new Set(namesB));
  const inter = GESTOS_A.filter((n) => GESTOS_B.includes(n));
  assert.deepEqual(inter, []);
  assert.ok(VALID_GESTOS.size >= 110); // 100 + 5 estados + 5 shapes
});

test('parse: gesto de B resuelve (backend valida los 100)', () => {
  const r = parseGesto('miren [[gesto:cohete]] despegamos');
  assert.equal(r.gesto, 'cohete');
  assert.equal(r.cleanText, 'miren despegamos');
  assert.ok(isValidGesto('mandala'));
  assert.ok(!isValidGesto('no_existe_zzz'));
});
