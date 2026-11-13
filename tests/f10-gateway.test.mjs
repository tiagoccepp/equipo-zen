// F-10: gateway registry + widget sandbox + personas de voz.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetWsRegistry,
  wsRegister,
  wsStats,
  wsStaleIds,
  wsUnregister,
  wsUpdate
} from '../server/lib/ws-registry.js';
import { sanitizeWidgetHtml, widgetDoc } from '../src/lib/widget-sandbox.ts';
import { auditPersonaCoverage, personaAllEngines, personaFor } from '../server/lib/voice-personas.js';
import { figure } from '../server/lib/figures.js';
import { renderWidget } from '../src/lib/widget-sandbox.ts';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { initSettings } from '../server/lib/settings.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
afterEach(() => { db.clear(); __resetWsRegistry(); });

function fakeEl(tag) {
  const e = {
    tag, children: [], className: '', attrs: {}, srcdoc: '',
    appendChild(c) { e.children.push(c); return c; },
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
globalThis.document = { createElement: (tag) => fakeEl(tag) };
process.on('exit', () => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

test('f10: registry cuenta/agrupa/detecta stale', () => {
  const a = wsRegister({ companyId: 'c1' });
  const b = wsRegister({ companyId: 'c1' });
  wsRegister({ companyId: 'c2' });
  let s = wsStats();
  assert.equal(s.connections, 3);
  assert.deepEqual(s.byCompany, { c1: 2, c2: 1 });
  wsUpdate(a, { meetingId: 'm1' });
  assert.ok(wsUnregister(b));
  s = wsStats();
  assert.equal(s.connections, 2);
  assert.deepEqual(wsStaleIds(10 * 60 * 1000), [], 'recientes no stale');
});

test('f10: sanitize quita scripts/handlers/javascript/iframes', () => {
  assert.equal(sanitizeWidgetHtml('<p>hola</p>'), '<p>hola</p>', 'seguro intacto');
  assert.ok(!sanitizeWidgetHtml('<script>alert(1)</script><p>x</p>').includes('script'));
  assert.ok(!sanitizeWidgetHtml('<p onclick="evil()">x</p>').includes('onclick'));
  assert.ok(!sanitizeWidgetHtml('<a href="javascript:evil()">x</a>').includes('javascript:'));
  assert.ok(!sanitizeWidgetHtml('<iframe src="x"></iframe>').includes('iframe'));
  assert.ok(!sanitizeWidgetHtml('<form><input></form>').includes('<form'));
  assert.ok(sanitizeWidgetHtml('x'.repeat(20000)).length <= 8192, 'tope');
  const doc = widgetDoc({ title: '<b>T</b>', html: '<p>ok</p>' });
  assert.ok(doc.includes('&lt;b&gt;'), 'título escapado');
  assert.ok(doc.includes('<p>ok</p>'));
});

test('f10: kind widget valida + render iframe sandbox', () => {
  assert.equal(figure({ kind: 'widget', html: '' }).ok, false);
  assert.equal(figure({ kind: 'widget', html: '<script>x</script>' }).ok, false, 'solo-script = nada mostrable');
  const ok = figure({ kind: 'widget', title: 'R', html: '<p>dato</p>', height: 9999 });
  assert.equal(ok.ok, true);
  assert.equal(ok.figure.height, 600, 'altura topada');
  const host = fakeEl('div');
  assert.equal(renderWidget(host, { title: 'R', html: '<p>dato</p>' }), true);
  const frame = host.querySelector('.fig-widget-frame');
  assert.ok(frame, 'iframe montado');
  assert.equal(frame.attrs.sandbox, '', 'sandbox estricto');
  assert.ok(frame.srcdoc.includes('<p>dato</p>'));
  assert.ok(frame.srcdoc.includes('<h3>R</h3>'));
  assert.equal(renderWidget(host, { html: '<script>x</script>' }), false, 'vacío sanitizado no monta');
});

test('f10: personas resuelven en los 4 motores para todo el roster', () => {
  db.set('tts.language', 'es');
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const voices = store.listAgents({ companyId: company.id }).map((a) => a.voice);
  assert.ok(voices.length >= 2);
  const audit = auditPersonaCoverage(voices);
  assert.deepEqual(audit.missing, [], `cobertura total (${JSON.stringify(audit.missing)})`);
  assert.equal(audit.ok, true);
  const p = personaAllEngines('F1');
  assert.ok(p.piper && p.supertonic === 'F1' && p.edge && p.deepgram, JSON.stringify(p));
  assert.equal(personaFor('Charon', 'supertonic'), 'M1', 'legacy migra');
  assert.equal(personaFor('M9', 'supertonic'), 'M1', 'desconocida cae a M1');
  assert.equal(personaFor('M1', 'invento'), null);
  store.close();
});
