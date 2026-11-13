// QW-06: Mermaid inline validado (error accionable + copiar código).
// Frontend (.ts vía type-stripping) + filtro de voz server-side. Cero red.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  copyText,
  mermaidErrorInfo,
  mountMermaid,
  renderRichMessage,
  splitSegments
} from '../src/lib/mermaid-inline.ts';
import { createMermaidSpeechFilter } from '../server/lib/text.js';

// ── DOM falso mínimo ──
function fakeEl(tag) {
  const e = {
    tag,
    children: [],
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    attrs: {},
    setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return e.attrs[k] ?? null; },
    classList: {
      add: (c) => { e.className = [e.className, c].filter(Boolean).join(' '); },
      remove: (c) => { e.className = String(e.className).split(' ').filter((x) => x !== c).join(' '); },
      contains: (c) => String(e.className).split(' ').includes(c)
    },
    removed: false,
    handlers: {},
    appendChild(c) { e.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = ref ? e.children.indexOf(ref) : -1;
      if (i === -1) e.children.push(c);
      else e.children.splice(i, 0, c);
      return c;
    },
    remove() { e.removed = true; },
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
    },
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
    },
    addEventListener(ev, fn) { e.handlers[ev] = fn; },
    select() { e.selected = true; },
    click() { return e.handlers.click?.(); }
  };
  return e;
}

const realDocument = globalThis.document;
function installFakeDoc() {
  const body = fakeEl('body');
  globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body,
    execCommand: () => true
  };
  return body;
}
afterEach(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ── splitSegments ──
test('qw06: splitSegments — texto plano intacto, bloques extraídos', () => {
  assert.deepEqual(splitSegments('hola mundo'), [{ t: 'text', text: 'hola mundo' }]);
  const segs = splitSegments('Mirá:\n```mermaid\ngraph TD\nA-->B\n```\nListo.');
  assert.deepEqual(segs, [
    { t: 'text', text: 'Mirá:\n' },
    { t: 'mmd', code: 'graph TD\nA-->B' },
    { t: 'text', text: '\nListo.' }
  ]);
});

test('qw06: splitSegments — fence sin cerrar queda como texto', () => {
  const segs = splitSegments('texto\n```mermaid\ngraph TD\nA-->B');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].t, 'text');
  assert.ok(segs[0].text.includes('```mermaid'));
});

test('qw06: splitSegments — mayúsculas/espacios y fence no-mermaid intacto', () => {
  const segs = splitSegments('```MERMAID\ngraph TD\n```');
  assert.deepEqual(segs, [{ t: 'mmd', code: 'graph TD' }]);
  const js = splitSegments('```js\nconst a = 1;\n```');
  assert.deepEqual(js, [{ t: 'text', text: '```js\nconst a = 1;\n```' }]);
});

test('qw06: splitSegments — dos bloques', () => {
  const segs = splitSegments('a\n```mermaid\nX\n```\nb\n```mermaid\nY\n```\nc');
  assert.deepEqual(segs.map((s) => s.t), ['text', 'mmd', 'text', 'mmd', 'text']);
  assert.equal(segs[1].code, 'X');
  assert.equal(segs[3].code, 'Y');
});

// ── mermaidErrorInfo ──
test('qw06: error accionable — línea + causa + arreglo', () => {
  const code = 'graph TD\nA-->\nB-->C';
  const info = mermaidErrorInfo(new Error('Parse error on line 2:\nExpecting SQE'), code);
  assert.ok(info.title.includes('línea 2'), info.title);
  assert.ok(info.detail.includes('A-->'), info.detail);
  assert.ok(info.hint.length > 20, 'hint accionable');
  const unknown = mermaidErrorInfo(new Error('Unknown diagram type: foo'), 'foo');
  assert.ok(unknown.hint.includes('graph TD'), unknown.hint);
});

// ── mountMermaid ──
test('qw06: mountMermaid éxito — inyecta SVG + botón copiar', async () => {
  installFakeDoc();
  const host = fakeEl('div');
  const code = 'graph TD\nA-->B';
  mountMermaid(host, code, {
    loadMermaid: async () => ({ render: async () => ({ svg: '<svg>DIAGRAMA</svg>' }) }),
    copy: async () => true
  });
  assert.equal(host.children.length, 1, 'box montado sync');
  await tick();
  const box = host.children[0];
  const svgWrap = box.querySelector('.mmd-svg');
  assert.ok(svgWrap, 'wrap svg existe');
  assert.ok(svgWrap.innerHTML.includes('<svg>'), 'svg inyectado');
  assert.ok(box.querySelector('.mmd-copy'), 'botón copiar en éxito');
  assert.equal(box.querySelectorAll('.mmd-loading').filter((n) => !n.removed).length, 0, 'loading fuera');
});

test('qw06: mountMermaid error — caja accionable + copiar llama clipboard', async () => {
  installFakeDoc();
  const host = fakeEl('div');
  const code = 'graph TD\nA-->';
  let copied = null;
  mountMermaid(host, code, {
    loadMermaid: async () => ({
      render: async () => { throw new Error('Parse error on line 2: boom'); }
    }),
    copy: async (t) => { copied = t; return true; }
  });
  await tick();
  const box = host.children[0];
  assert.ok(box.className.includes('mmd-error'), 'marca de error');
  const title = box.querySelector('.mmd-title');
  assert.ok(title.textContent.includes('línea 2'), title.textContent);
  assert.ok(box.querySelector('.mmd-hint').textContent.length > 10, 'hint visible');
  assert.ok(box.querySelector('.mmd-detail').textContent.includes('boom'), 'detalle crudo');
  const btn = box.querySelector('.mmd-copy');
  assert.ok(btn, 'botón copiar en error');
  await btn.click();
  assert.equal(copied, code, 'copia el código exacto');
  assert.ok(btn.textContent.includes('Copiado'), 'feedback visual');
});

test('qw06: mountMermaid vacío — error sin llamar a mermaid', async () => {
  installFakeDoc();
  const host = fakeEl('div');
  let loaded = false;
  mountMermaid(host, '   \n  ', {
    loadMermaid: async () => { loaded = true; throw new Error('no debe cargar'); },
    copy: async () => true
  });
  await tick();
  assert.equal(loaded, false);
  assert.ok(host.children[0].className.includes('mmd-error'));
});

// ── renderRichMessage ──
test('qw06: renderRichMessage sin fence — un solo text node (idéntico a antes)', () => {
  installFakeDoc();
  const div = fakeEl('div');
  renderRichMessage(div, 'hola mundo');
  assert.equal(div.children.length, 1);
  assert.equal(div.children[0].textContent, 'hola mundo');
});

test('qw06: renderRichMessage con fence — texto + diagrama', async () => {
  installFakeDoc();
  const div = fakeEl('div');
  renderRichMessage(div, 'Mirá:\n```mermaid\ngraph TD\n```\nFin.', {
    loadMermaid: async () => ({ render: async () => ({ svg: '<svg/>' }) }),
    copy: async () => true
  });
  await tick();
  assert.equal(div.children.length, 3, 'texto + box + texto');
  assert.equal(div.children[0].textContent, 'Mirá:\n');
  assert.equal(div.children[1].className, 'mmd');
  assert.equal(div.children[2].textContent, '\nFin.');
});

test('qw06: copyText fallback sin navigator.clipboard', async () => {
  installFakeDoc();
  const realNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  try {
    assert.equal(await copyText('código'), true, 'execCommand fallback');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true });
  }
});

// ── Filtro de voz server-side ──
test('qw06: filtro voz — bloque completo se habla sin el código', () => {
  const f = createMermaidSpeechFilter();
  const out = f('Te muestro el flujo:\n```mermaid\ngraph TD\nA-->B\n```\n¿Se entiende?') + f.flush();
  assert.ok(out.includes('Te muestro'), out);
  assert.ok(out.includes('¿Se entiende?'), out);
  assert.ok(!out.includes('graph TD'), out);
  assert.ok(!out.includes('-->'), out);
});

test('qw06: filtro voz — fences partidos entre deltas', () => {
  const f = createMermaidSpeechFilter();
  let out = '';
  out += f('Mirá esto: ```');
  out += f('mermaid\ngraph TD\nA-->');
  out += f('B\n``');
  out += f('`\nListo.');
  out += f.flush();
  assert.ok(out.includes('Mirá esto'), out);
  assert.ok(out.includes('Listo.'), out);
  assert.ok(!out.includes('graph'), out);
  assert.ok(!out.includes('```'), out);
});

test('qw06: filtro voz — otros fences pasan intactos, texto normal intacto', () => {
  const f = createMermaidSpeechFilter();
  const js = f('Ejemplo:\n```js\nconst a = 1;\n```\nFin.') + f.flush();
  assert.ok(js.includes('const a = 1'), js);
  const g = createMermaidSpeechFilter();
  assert.equal(g('Hola, ¿cómo estás?') + g.flush(), 'Hola, ¿cómo estás?');
});

test('qw06: filtro voz — bloque sin cerrar al final no se habla', () => {
  const f = createMermaidSpeechFilter();
  const out = f('Mirá:\n```mermaid\ngraph TD\nA-->B') + f.flush();
  assert.ok(out.includes('Mirá'), out);
  assert.ok(!out.includes('graph TD'), out);
});
