import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUBE_HALF,
  MORPH_SHAPES,
  RING_RADIUS,
  TORUS_R,
  TORUS_TUBE,
  WAVE_AMP,
  WAVE_EXTENT,
  cube,
  easeInOutCubic,
  generateShape,
  morphStep,
  ring,
  smoothstep,
  sphere,
  text,
  torus,
  wave
} from '../src/fx/morph.ts';

// Las figuras de fx/morph son targets puros: N puntos en un cubo ~unitario.
// Lo que se prueba: counts exactos, determinismo por seed, puntos SOBRE la
// superficie que dicen ser, y morphStep como interpolación sana.

const SHAPES_NODOM = { sphere, torus, cube, wave, ring };

test('todos los generadores devuelven exactamente count*3 floats', () => {
  for (const [name, fn] of Object.entries(SHAPES_NODOM)) {
    for (const count of [1, 7, 150, 720]) {
      const pts = name === 'wave' ? fn(count, 1.2) : fn(count, 0.5);
      assert.equal(pts.length, count * 3, `${name}(${count})`);
      assert.ok(pts instanceof Float32Array, `${name} no es Float32Array`);
      for (const v of pts) assert.ok(Number.isFinite(v), `${name} tiene no-finitos`);
    }
  }
});

test('misma seed → mismos puntos; distinta seed → distintos', () => {
  for (const [name, fn] of Object.entries({ sphere, torus, cube, ring })) {
    const a = fn(200, 1.3);
    const b = fn(200, 1.3);
    assert.deepEqual(a, b, `${name} no es determinista`);
    const c = fn(200, 2.7);
    assert.notDeepEqual(a, c, `${name} ignora la seed`);
  }
  // wave es función de phase, no de seed.
  assert.deepEqual(wave(100, 0.4), wave(100, 0.4));
  assert.notDeepEqual(wave(100, 0.4), wave(100, 1.9));
});

test('sphere: puntos sobre la esfera unitaria, reparto parejo', () => {
  const pts = sphere(500, 2.117);
  let arriba = 0;
  for (let i = 0; i < 500; i += 1) {
    const n = Math.hypot(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    assert.ok(Math.abs(n - 1) < 1e-5, `|p|=${n}`);
    if (pts[i * 3 + 1] > 0) arriba += 1;
  }
  assert.ok(Math.abs(arriba - 250) < 25, `hemisferios: ${arriba}/500`);
});

test('torus: puntos sobre el tubo (distancia al anillo = tubo)', () => {
  const pts = torus(400, 0.8);
  for (let i = 0; i < 400; i += 1) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    const tube = Math.hypot(Math.hypot(x, y) - TORUS_R, z);
    assert.ok(Math.abs(tube - TORUS_TUBE) < 1e-3, `tubo=${tube}`);
  }
  assert.ok(TORUS_R + TORUS_TUBE < 1, 'el toro se sale del cubo unitario');
});

test('cube: puntos sobre las caras, las 6 caras presentes', () => {
  const pts = cube(600, 1.1);
  const faces = new Set();
  for (let i = 0; i < 600; i += 1) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    assert.ok(Math.abs(m - CUBE_HALF) < 1e-6, `max|coord|=${m}`);
    if (Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z)) faces.add(x > 0 ? '+x' : '-x');
    else if (Math.abs(y) >= Math.abs(z)) faces.add(y > 0 ? '+y' : '-y');
    else faces.add(z > 0 ? '+z' : '-z');
  }
  assert.equal(faces.size, 6, `caras cubiertas: ${[...faces].join(',')}`);
});

test('wave: grilla acotada, amplitud acotada, phase la mueve', () => {
  const a = wave(256, 0);
  for (let i = 0; i < 256; i += 1) {
    assert.ok(Math.abs(a[i * 3]) <= WAVE_EXTENT + 1e-6, 'x fuera de la grilla');
    assert.ok(Math.abs(a[i * 3 + 1]) <= WAVE_EXTENT + 1e-6, 'y fuera de la grilla');
    assert.ok(Math.abs(a[i * 3 + 2]) <= WAVE_AMP + 1e-6, `z=${a[i * 3 + 2]}`);
  }
  // La phase mueve la superficie pero no la grilla.
  const b = wave(256, 2);
  for (let i = 0; i < 256; i += 1) {
    assert.equal(a[i * 3], b[i * 3]);
    assert.equal(a[i * 3 + 1], b[i * 3 + 1]);
  }
  assert.notDeepEqual(a, b);
});

test('ring: círculo de radio fijo en el plano, casi plano', () => {
  const pts = ring(300, 0.3);
  for (let i = 0; i < 300; i += 1) {
    const r = Math.hypot(pts[i * 3], pts[i * 3 + 1]);
    assert.ok(Math.abs(r - RING_RADIUS) < 0.04, `radio=${r}`);
    assert.ok(Math.abs(pts[i * 3 + 2]) <= 0.03, `z=${pts[i * 3 + 2]}`);
  }
});

test('torus/cube/ring viven dentro del cubo [-1,1]', () => {
  for (const [name, fn] of Object.entries({ torus, cube, ring })) {
    const pts = fn(720, 4.4);
    for (const v of pts) {
      assert.ok(v >= -1 && v <= 1, `${name}: ${v} fuera de rango`);
    }
  }
});

test('morphStep: t=0 devuelve from, t=1 devuelve to (exactos)', () => {
  const from = sphere(120, 1);
  const to = torus(120, 1);
  const buf = new Float32Array(from.length);
  assert.deepEqual(morphStep(buf, from, to, 0), from);
  assert.deepEqual(morphStep(buf, from, to, 1), to);
  // t=0.5 con smoothstep(0.5)=0.5 es el punto medio exacto.
  morphStep(buf, from, to, 0.5);
  for (let i = 0; i < buf.length; i += 1) {
    assert.ok(Math.abs(buf[i] - (from[i] + to[i]) / 2) < 1e-6, `i=${i}`);
  }
});

test('morphStep: monótono (a más t, más cerca del destino)', () => {
  const from = cube(150, 2);
  const to = ring(150, 2);
  const buf = new Float32Array(from.length);
  const dist = (t) => {
    morphStep(buf, from, to, t);
    let acc = 0;
    for (let i = 0; i < buf.length; i += 1) acc += (buf[i] - to[i]) ** 2;
    return Math.sqrt(acc);
  };
  const d0 = dist(0);
  const d3 = dist(0.3);
  const d7 = dist(0.7);
  const d1 = dist(1);
  assert.ok(d0 > d3 && d3 > d7 && d7 > d1, `${d0} ${d3} ${d7} ${d1}`);
  assert.equal(d1, 0);
});

test('morphStep: longitudes distintas tiran RangeError', () => {
  const a = sphere(10, 0);
  const b = sphere(11, 0);
  assert.throws(() => morphStep(new Float32Array(30), a, b, 0.5), RangeError);
});

test('easings: [0,1], extremos exactos, monótonos', () => {
  for (const fn of [smoothstep, easeInOutCubic]) {
    assert.equal(fn(0), 0);
    assert.equal(fn(1), 1);
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = fn(t);
      assert.ok(v >= 0 && v <= 1, `${v} fuera de [0,1]`);
      assert.ok(v >= prev - 1e-12, 'no monótono');
      prev = v;
    }
    // Fuera de rango se clampéa, no se rompe.
    assert.equal(fn(-3), 0);
    assert.equal(fn(99), 1);
  }
});

test('generateShape despacha a cada figura', () => {
  assert.equal(MORPH_SHAPES.length, 5);
  for (const shape of MORPH_SHAPES) {
    const pts = generateShape(shape, 60, { seed: 1, phase: 0.5 });
    assert.equal(pts.length, 180, shape);
  }
  assert.deepEqual(generateShape('sphere', 50, { seed: 3 }), sphere(50, 3));
  assert.deepEqual(generateShape('wave', 49, { phase: 1 }), wave(49, 1));
});

test('text() sin DOM tira error claro (no rompe node)', () => {
  assert.equal(typeof document, 'undefined');
  assert.throws(() => text(100, 'hola'), /necesita DOM/);
});

test('count inválido tira, no devuelve basura', () => {
  assert.throws(() => sphere(NaN, 0), RangeError);
});
