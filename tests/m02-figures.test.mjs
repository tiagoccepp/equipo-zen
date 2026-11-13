// M-02: showFigure tipado — validación server + render cliente (DOM falso).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { figure, figureEvent, glyphFigure, FIGURE_KINDS } from '../server/lib/figures.js';
import { renderFigure } from '../src/lib/figures-view.ts';

function fakeEl(tag) {
  const e = {
    tag, children: [], className: '', textContent: '', innerHTML: '', style: {},
    attrs: {},
    handlers: {},
    appendChild(c) { e.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = ref ? e.children.indexOf(ref) : -1;
      if (i === -1) e.children.push(c);
      else e.children.splice(i, 0, c);
      return c;
    },
    remove() { e.removed = true; },
    addEventListener(ev, fn) { e.handlers[ev] = fn; },
    classList: {
      add: (c) => { e.className = [e.className, c].filter(Boolean).join(' '); }
    },
    setAttribute(k, v) { e.attrs[k] = String(v); },
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
  return e;
}

const realDocument = globalThis.document;
afterEach(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});
function installFakeDoc() {
  globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, children: [] })
  };
}

test('m02: kinds válidos + rechazos por kind', () => {
  assert.deepEqual([...FIGURE_KINDS].sort(), ['chart', 'checklist', 'diagram', 'glyph', 'notice', 'progress', 'slide', 'widget']);
  assert.equal(figure({ kind: 'invento' }).ok, false);
  assert.equal(figure({}).ok, false);
  assert.equal(figure({ kind: 'diagram' }).ok, false, 'sin code');
  assert.equal(figure({ kind: 'progress', pct: 101 }).ok, false);
  assert.equal(figure({ kind: 'progress', pct: -1 }).ok, false);
  assert.equal(figure({ kind: 'checklist', items: [] }).ok, false);
  assert.equal(figure({ kind: 'checklist', items: [{ text: '' }] }).ok, false);
  assert.equal(figure({ kind: 'notice', tone: 'x', text: 'h' }).ok, false);
  assert.equal(figure({ kind: 'notice', text: '' }).ok, false);
  assert.equal(figure({ kind: 'glyph' }).ok, false);
  assert.ok(figure({ kind: 'diagram', code: 'graph TD' }).ok);
  assert.ok(figure({ kind: 'progress', pct: 50, label: 'Mitad' }).ok);
  assert.ok(figure({ kind: 'checklist', items: [{ text: 'a', done: true }] }).ok);
  assert.ok(figure({ kind: 'notice', tone: 'warn', text: 'cuidado' }).ok);
  assert.ok(figure({ kind: 'glyph', name: 'pulso' }).ok);
});

test('m02: topes anti-inundación', () => {
  assert.equal(figure({ kind: 'diagram', code: 'x'.repeat(21000) }).ok, false);
  assert.equal(figure({ kind: 'checklist', items: Array.from({ length: 31 }, (_, i) => ({ text: `i${i}` })) }).ok, false);
  const p = figure({ kind: 'progress', pct: 33.6 });
  assert.equal(p.figure.pct, 34, 'pct redondeado');
});

test('m02: figureEvent + glyphFigure', () => {
  const ev = figureEvent('t1', 'a1', { kind: 'notice', text: 'hola' });
  assert.deepEqual(ev, { type: 'agent_figure', turnId: 't1', agentId: 'a1', figure: { kind: 'notice', tone: 'info', text: 'hola' } });
  assert.equal(figureEvent('t', 'a', { kind: 'x' }), null, 'inválido → null');
  assert.ok(glyphFigure('pulso').ok);
});

test('m02: render progress/checklist/notice en DOM', () => {
  installFakeDoc();
  const host = fakeEl('div');
  const ctx = { loadMermaid: async () => ({ render: async () => ({ svg: '<svg/>' }) }) };
  assert.equal(renderFigure(host, { kind: 'progress', pct: 40, label: 'Subiendo' }, ctx), true);
  const bar = host.querySelector('.fig-bar');
  assert.equal(bar.attrs.role, 'progressbar');
  assert.equal(bar.attrs['aria-valuenow'], '40');
  assert.ok(host.querySelector('.fig-label').textContent.includes('40%'));
  assert.equal(renderFigure(host, { kind: 'checklist', items: [{ text: 'a', done: true }, { text: 'b', done: false }] }, ctx), true);
  assert.equal(host.querySelector('.fig-check').children.length, 2);
  assert.equal(renderFigure(host, { kind: 'notice', tone: 'bad', text: 'falló X' }, ctx), true);
  assert.ok(host.querySelector('.fig-tone-bad'), 'tono en clase');
  assert.equal(renderFigure(host, { kind: 'diagram' }, ctx), false, 'sin code no dibuja');
  assert.equal(renderFigure(host, { kind: 'x' }, ctx), false);
});

test('m02: render diagram monta mermaid + glyph delega', async () => {
  installFakeDoc();
  const host = fakeEl('div');
  let glyph = null;
  const ctx = {
    loadMermaid: async () => ({ render: async () => ({ svg: '<svg>D</svg>' }) }),
    setGlyph: (n) => { glyph = n; }
  };
  assert.equal(renderFigure(host, { kind: 'diagram', code: 'graph TD' }, ctx), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(host.querySelector('.mmd'), 'usa mountMermaid');
  const n0 = host.children.length;
  assert.equal(renderFigure(host, { kind: 'glyph', name: 'pulso' }, ctx), true);
  assert.equal(glyph, 'pulso');
  assert.equal(host.children.length, n0, 'glyph no ocupa stream');
});
