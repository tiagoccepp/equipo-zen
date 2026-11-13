// M-11: deferred rendering — cola idle + skeleton. Scheduler falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFigureQueue } from '../src/lib/figure-queue.ts';

test('m11: un fn por tick, en orden FIFO', () => {
  const scheduled = [];
  const q = createFigureQueue((fn) => scheduled.push(fn));
  const ran = [];
  q.deferHeavy(() => ran.push('a'));
  q.deferHeavy(() => ran.push('b'));
  q.deferHeavy(() => ran.push('c'));
  assert.equal(q.depth(), 3);
  assert.equal(scheduled.length, 1, 'un solo pump agendado');
  scheduled.shift()();
  assert.deepEqual(ran, ['a']);
  assert.equal(q.depth(), 2);
  scheduled.shift()();
  scheduled.shift()();
  assert.deepEqual(ran, ['a', 'b', 'c']);
  assert.equal(q.depth(), 0);
});

test('m11: excepción no traba la cola + re-armado', () => {
  const scheduled = [];
  const q = createFigureQueue((fn) => scheduled.push(fn));
  const ran = [];
  q.deferHeavy(() => { throw new Error('boom'); });
  q.deferHeavy(() => ran.push('ok'));
  scheduled.shift()();
  scheduled.shift()();
  assert.deepEqual(ran, ['ok']);
  // Cola vacía: nuevo defer re-agenda.
  q.deferHeavy(() => ran.push('z'));
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(ran, ['ok', 'z']);
});

test('m11: skeleton en mountMermaid (clase + aria-busy)', async () => {
  const els = [];
  const fakeEl = (tag) => {
    const e = {
      tag, children: [], className: '', textContent: '', innerHTML: '',
      style: {}, attrs: {}, handlers: {},
      appendChild(c) { e.children.push(c); return c; },
      insertBefore(c, ref) {
        const i = ref ? e.children.indexOf(ref) : -1;
        if (i === -1) e.children.push(c);
        else e.children.splice(i, 0, c);
        return c;
      },
      remove() { e.removed = true; },
      addEventListener(ev, fn) { e.handlers[ev] = fn; },
      setAttribute(k, v) { e.attrs[k] = String(v); },
      classList: { add: (c) => { e.className = [e.className, c].filter(Boolean).join(' '); } },
      querySelector: () => null
    };
    els.push(e);
    return e;
  };
  const realDocument = globalThis.document;
  globalThis.document = {
    createElement: fakeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: t, children: [] })
  };
  try {
    const { mountMermaid } = await import('../src/lib/mermaid-inline.ts');
    const host = fakeEl('div');
    let ran = false;
    mountMermaid(host, 'graph TD', {
      loadMermaid: async () => ({ render: async () => ({ svg: '<svg/>' }) }),
      copy: async () => true,
      deferHeavy: (fn) => { ran = true; }
    });
    assert.equal(ran, true, 'render pesado pasa por deferHeavy');
    const skel = els.find((e) => String(e.className).includes('fig-skeleton'));
    assert.ok(skel, 'skeleton presente');
    assert.equal(skel.attrs['aria-busy'], 'true');
  } finally {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});
