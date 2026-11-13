// M-10: doble carril — key/ephemeral server + upsert cliente.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decorateFigure, figureEvent } from '../server/lib/figures.js';
import { upsertFigure } from '../src/lib/figures-view.ts';

function fakeEl(tag) {
  const e = {
    tag, children: [], className: '', textContent: '', innerHTML: '', style: {},
    attrs: {}, handlers: {},
    get childrenLength() { return e.children.length; },
    appendChild(c) { e.children.push(c); c.parent = e; return c; },
    setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return e.attrs[k] ?? null; },
    replaceWith(n) {
      const p = e.parent;
      if (!p) return;
      const i = p.children.indexOf(e);
      if (i !== -1) { p.children[i] = n; n.parent = p; }
    },
    addEventListener(ev, fn) { e.handlers[ev] = fn; },
    querySelector(sel) {
      const cls = String(sel).replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children || []) {
          if (String(c.className || '').split(' ').includes(cls)) return c;
          const f = walk(c);
          if (f) return f;
        }
        return null;
      };
      return walk(e);
    }
  };
  Object.defineProperty(e, 'children', { value: e.children, writable: true });
  return e;
}

const realDocument = globalThis.document;
globalThis.document = {
  createElement: (tag) => fakeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: text, children: [] })
};
process.on('exit', () => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const ctx = { loadMermaid: async () => ({ render: async () => ({ svg: '<svg/>' }) }) };

test('m10: decorateFigure pasa key+ephemeral validados', () => {
  const ev = figureEvent('t', 'a', { kind: 'progress', pct: 10, key: 'job-1', ephemeral: true });
  assert.deepEqual(ev.figure, { kind: 'progress', pct: 10, label: '', key: 'job-1', ephemeral: true });
  const plain = figureEvent('t', 'a', { kind: 'progress', pct: 10 });
  assert.ok(!('key' in plain.figure) && !('ephemeral' in plain.figure));
  assert.equal(decorateFigure({ kind: 'notice', text: 'x' }, { key: 'k'.repeat(100) }).key.length, 64, 'key recortada');
  assert.ok(!('ephemeral' in decorateFigure({ kind: 'notice', text: 'x' }, { ephemeral: 'sí' })), 'solo true booleano');
});

test('m10: upsert sin key = append; con key = reemplaza', () => {
  const host = fakeEl('div');
  assert.equal(upsertFigure(host, { kind: 'progress', pct: 10, label: 'A' }, ctx), true);
  assert.equal(upsertFigure(host, { kind: 'progress', pct: 20, label: 'B' }, ctx), true);
  assert.equal(host.children.length, 2, 'sin key: dos nodos');
  assert.equal(upsertFigure(host, { kind: 'progress', pct: 30, label: 'C', key: 'job-1' }, ctx), true);
  assert.equal(host.children.length, 3, 'primera key: append + marca');
  assert.equal(upsertFigure(host, { kind: 'progress', pct: 60, label: 'D', key: 'job-1' }, ctx), true);
  assert.equal(host.children.length, 3, 'misma key: reemplaza, no crece');
  const labels = host.children.map((c) => {
    const lab = c.children.find((x) => x.className === 'fig-label');
    return lab?.textContent;
  });
  assert.ok(labels.some((l) => l && l.includes('60%')), `progreso actualizado: ${labels.join('|')}`);
  assert.ok(!labels.some((l) => l && l.includes('30%')), 'viejo reemplazado');
  assert.equal(upsertFigure(host, { kind: 'progress', pct: 90, label: 'E', key: 'job-2' }, ctx), true);
  assert.equal(host.children.length, 4, 'otra key: append');
});
