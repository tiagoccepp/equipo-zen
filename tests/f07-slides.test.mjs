// F-07: slides narradas — build, delays, figura slide (server+vista).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildClosingSlides, narrationMs, slideDelays } from '../server/lib/closing-slides.js';
import { figure } from '../server/lib/figures.js';
import { renderFigure } from '../src/lib/figures-view.ts';

function fakeEl(tag) {
  const e = {
    tag, children: [], className: '', textContent: '', innerHTML: '', style: {},
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      const cls = String(sel).replace(/^\./, '');
      const found = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (String(c.className || '').split(' ').includes(cls)) found.push(c);
          walk(c);
        }
      };
      walk(e);
      return found;
    }
  };
  return e;
}
const realDocument = globalThis.document;
globalThis.document = {
  createElement: (tag) => fakeEl(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: t, children: [] })
};
process.on('exit', () => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});
const ctx = { loadMermaid: async () => ({ render: async () => ({ svg: '<svg/>' }) }) };

test('f07: build agrupa título/decisiones/dueños + tope 5', () => {
  const slides = buildClosingSlides({
    goalTitle: 'Home nueva',
    decisions: ['Usar Astro', 'Azul primario'],
    tasksByOwner: [
      { name: 'Delfina', tasks: ['Diseñar', 'Probar'] },
      { name: 'Julio', tasks: ['Codear'] }
    ],
    taskCount: 3
  });
  assert.equal(slides.length, 4, 'título + decisiones + 2 dueños');
  assert.equal(slides[0].figure.kind, 'slide');
  assert.ok(slides[0].figure.title.includes('Home nueva'));
  assert.ok(slides[0].narration.includes('3 tareas'), slides[0].narration);
  assert.equal(slides[1].figure.bullets.length, 2);
  assert.ok(slides[2].narration.includes('Delfina'));
  const many = buildClosingSlides({
    goalTitle: 'X',
    tasksByOwner: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, tasks: ['t'] })),
    taskCount: 8
  });
  assert.ok(many.length <= 5, 'tope 5');
});

test('f07: delays monótonos acotados por narración', () => {
  const slides = [{ narration: 'hola mundo' }, { narration: 'x '.repeat(200) }];
  const d = slideDelays(slides);
  assert.deepEqual(d.length, 2);
  assert.equal(d[0], 0, 'primera inmediata');
  assert.ok(d[1] >= 2500 && d[1] <= 12000, `segunda acotada (${d[1]})`);
  assert.ok(narrationMs('') >= 2500, 'mínimo');
  assert.ok(narrationMs('w '.repeat(1000)) <= 12000, 'máximo');
});

test('f07: figura slide válida + render', () => {
  assert.equal(figure({ kind: 'slide', title: '', bullets: ['a'] }).ok, false);
  assert.equal(figure({ kind: 'slide', title: 'T', bullets: [] }).ok, false);
  assert.ok(figure({ kind: 'slide', title: 'T', bullets: ['a', 'b'] }).ok);
  const host = fakeEl('div');
  assert.equal(renderFigure(host, { kind: 'slide', title: 'Cierre', bullets: ['u', 'd'] }, ctx), true);
  assert.equal(host.children.length, 1);
  assert.equal(host.querySelectorAll('.fig-slide-list').length, 1);
  assert.equal(renderFigure(host, { kind: 'slide', title: '', bullets: [] }, ctx), false);
});
