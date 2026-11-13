// M-03: chart-spec segura — validación + SVG puro (sin DOM para el SVG).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { figure } from '../server/lib/figures.js';
import { chartSvg } from '../src/lib/figures-view.ts';

test('m03: chart válido (values y series)', () => {
  const a = figure({ kind: 'chart', chartType: 'bar', title: 'Ventas', labels: ['E', 'F'], values: [10, 20] });
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(a.figure.series, [{ name: '', values: [10, 20] }]);
  const b = figure({
    kind: 'chart', chartType: 'line', labels: ['E', 'F'],
    series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [3, 4] }]
  });
  assert.equal(b.ok, true, b.error);
  assert.equal(b.figure.series.length, 2);
});

test('m03: rechazos (tipo, largos, números, pie multi-serie)', () => {
  assert.equal(figure({ kind: 'chart', chartType: 'radar', labels: ['a'], values: [1] }).ok, false);
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: [], values: [] }).ok, false);
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: ['a', 'b'], values: [1] }).ok, false, 'largo mismatch');
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: ['a'], values: ['x'] }).ok, false, 'no-número');
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: ['a'], values: [Infinity] }).ok, false);
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: [''], values: [1] }).ok, false, 'label vacío');
  assert.equal(figure({ kind: 'chart', chartType: 'bar', labels: ['a'] }).ok, false, 'sin values ni series');
  assert.equal(figure({
    kind: 'chart', chartType: 'pie', labels: ['a', 'b'],
    series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, 4] }]
  }).ok, false, 'pie multi-serie');
  assert.equal(figure({
    kind: 'chart', chartType: 'bar', labels: Array.from({ length: 13 }, (_, i) => `l${i}`),
    values: Array.from({ length: 13 }, () => 1)
  }).ok, false, 'tope labels');
});

test('m03: SVG bar/line/pie con formas esperadas', () => {
  const bar = chartSvg({ kind: 'chart', chartType: 'bar', labels: ['E', 'F'], series: [{ name: '', values: [10, 20] }] });
  assert.ok(bar.startsWith('<svg'), 'svg');
  assert.equal((bar.match(/<rect /g) || []).length, 2, '2 barras');
  const line = chartSvg({ kind: 'chart', chartType: 'line', labels: ['E', 'F'], series: [{ name: 's', values: [1, 2] }] });
  assert.ok(line.includes('<polyline'), 'polilínea');
  const pie = chartSvg({ kind: 'chart', chartType: 'pie', labels: ['A', 'B'], series: [{ name: '', values: [1, 3] }] });
  assert.equal((pie.match(/<path /g) || []).length, 2, '2 porciones');
  assert.ok(pie.includes('role="img"'), 'a11y');
});

test('m03: etiquetas escapadas (cero inyección)', () => {
  const svg = chartSvg({
    kind: 'chart', chartType: 'bar', title: '"><script>alert(1)</script>',
    labels: ['<img src=x onerror=y>'], series: [{ name: '', values: [5] }]
  });
  assert.ok(!svg.includes('<script>'), 'sin script');
  assert.ok(!svg.includes('<img'), 'sin tag');
  assert.ok(svg.includes('&lt;img'), 'escapado');
  assert.ok(!svg.includes('onerror=y>'), 'atributo roto neutralizado');
});
