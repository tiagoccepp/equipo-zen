// Track A: manos browser_* sobre ~/agentes/bin/ab.
// CERO browser real: HOME temporal (sin agentes/bin/ab) + fake
// `agent-browser` en un PATH temporal con salidas canned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync,
  readdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sin proxy (misma razón que manos.test.mjs: Undici + stubs locales).
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

// HOME sin agentes/bin/ab → el lib cae al fallback `agent-browser` en
// PATH, donde vive el fake. (El ab real existe en el HOME verdadero.)
const TMPHOME = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-home-'));
const FAKEBIN = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-bin-'));
const ORIG_HOME = process.env.HOME;
const ORIG_PATH = process.env.PATH || '';
process.env.HOME = TMPHOME;
process.env.PATH = `${FAKEBIN}:${ORIG_PATH}`;

// Fake agent-browser: eco de sesión/env/argv + salidas canned.
// Triggers por argv: __SLEEP__ (cuelga 30s), __FAIL__ (exit 3 con
// "boom-fake" en stderr), __BIG__ (5000 chars por stdout).
// Si FAKE_LOG está seteado, vuelca cada argv ahí (para browser_shot,
// cuyo output no incluye el eco).
const FAKE_AB = `#!/bin/sh
echo "SESSION=\${AGENT_BROWSER_SESSION:-unset}"
echo "EXEC=\${AGENT_BROWSER_EXECUTABLE_PATH:-unset}"
echo "ARGS=\${AGENT_BROWSER_ARGS:-unset}"
echo "PROXY=\${http_proxy:-unset}/\${https_proxy:-unset}/\${HTTP_PROXY:-unset}/\${HTTPS_PROXY:-unset}"
if [ -n "$FAKE_LOG" ]; then
  for _a in "$@"; do echo "<$_a>" >> "$FAKE_LOG"; done
  echo "---" >> "$FAKE_LOG"
fi
_i=0
for _a in "$@"; do
  echo "ARG$_i=<$_a>"
  if [ "$_a" = "__SLEEP__" ]; then exec sleep 30; fi
  if [ "$_a" = "__FAIL__" ]; then echo "boom-fake" >&2; exit 3; fi
  if [ "$_a" = "__BIG__" ]; then awk 'BEGIN{for(i=0;i<5000;i++)printf "A"; print ""}'; fi
  _i=$((_i+1))
done
case "$1" in
  open) echo "OPEN-OK" ;;
  snapshot) echo 'SNAP-OK @e1 Button "Entrar"' ;;
  click) echo "CLICK-OK" ;;
  type) echo "TYPE-OK" ;;
  eval) echo "STDIN:"; cat -; echo "EVAL-OK" ;;
  screenshot) echo "SHOT-OK" ;;
  close) echo "CLOSE-OK" ;;
  *) echo "UNKNOWN-CMD" >&2; exit 2 ;;
esac
`;
writeFileSync(path.join(FAKEBIN, 'agent-browser'), FAKE_AB, { mode: 0o755 });

const manos = await import('../server/lib/manos.js');
const browser = await import('../server/lib/manos-browser.js');

const EMPRESA = 'acme';
const SLUG = 'demo';
mkdirSync(path.join(TMPWS, EMPRESA, SLUG), { recursive: true });
const ctx = { companyId: EMPRESA, slug: SLUG };

const REGISTRADAS = browser.registerBrowserTools();

test.after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  process.env.PATH = ORIG_PATH;
  delete process.env.FAKE_LOG;
  delete process.env.EQUIPO_AB_BIN;
  browser._resetBrowserTimeouts();
  rmSync(TMPWS, { recursive: true, force: true });
  rmSync(TMPHOME, { recursive: true, force: true });
  rmSync(FAKEBIN, { recursive: true, force: true });
});

function tool(name) {
  const t = manos.getTool(name);
  assert.ok(t, `${name} registrada`);
  return t;
}

// --- registro ---------------------------------------------------------------

test('las 7 browser_* registradas, con schemas', () => {
  const esperadas = {
    browser_open: ['url'],
    browser_snapshot: ['interactivas'],
    browser_click: ['ref'],
    browser_type: ['ref', 'texto'],
    browser_eval: ['js'],
    browser_shot: ['nombre'],
    browser_close: []
  };
  assert.deepEqual([...REGISTRADAS].sort(), Object.keys(esperadas).sort());
  for (const [name, props] of Object.entries(esperadas)) {
    const t = tool(name);
    for (const p of props) {
      assert.ok(t.parameters?.properties?.[p], `${name} tiene param ${p}`);
    }
  }
  // Idempotente: re-registrar no duplica ni rompe.
  browser.registerBrowserTools();
  for (const name of Object.keys(esperadas)) tool(name);
});

test('binario: fallback agent-browser sin ~/agentes/bin/ab + override EQUIPO_AB_BIN', () => {
  assert.equal(browser.resolveAbBin(), 'agent-browser');
  process.env.EQUIPO_AB_BIN = '/tmp/fake-ab-test';
  try {
    assert.equal(browser.resolveAbBin(), '/tmp/fake-ab-test');
  } finally {
    delete process.env.EQUIPO_AB_BIN;
  }
});

test('sesionPara: sanitiza agentId, default general', () => {
  assert.equal(browser.sesionPara('Pablo! #1'), 'pablo-1');
  assert.equal(browser.sesionPara('  A__B-2 '), 'a__b-2');
  assert.equal(browser.sesionPara(''), 'general');
  assert.equal(browser.sesionPara(undefined), 'general');
  assert.equal(browser.sesionPara('!!!'), 'general');
  assert.equal(browser.sesionPara('x'.repeat(100)).length, 40);
});

// --- sesión y env del hijo ---------------------------------------------------

test('sesión por agentId (sanitizado) y default general', async () => {
  const r1 = await tool('browser_snapshot').execute({}, { ...ctx, agentId: 'Pablo! #1' });
  assert.equal(r1.ok, true);
  assert.match(r1.output, /SESSION=equipo-pablo-1/);
  const r2 = await tool('browser_snapshot').execute({}, ctx);
  assert.equal(r2.ok, true);
  assert.match(r2.output, /SESSION=equipo-general/);
});

test('env del hijo: chrome fijo, --no-proxy-server, proxy strip', async () => {
  process.env.http_proxy = 'http://fake:1';
  process.env.https_proxy = 'http://fake:1';
  process.env.HTTP_PROXY = 'http://fake:1';
  process.env.HTTPS_PROXY = 'http://fake:1';
  try {
    const r = await tool('browser_snapshot').execute({}, ctx);
    assert.equal(r.ok, true);
    assert.match(r.output, /EXEC=\/usr\/bin\/google-chrome-stable/);
    assert.match(r.output, /ARGS=--no-proxy-server/);
    assert.match(r.output, /PROXY=unset\/unset\/unset\/unset/);
  } finally {
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  }
});

// --- argv sin shell -----------------------------------------------------------

test('argv sin shell: metacaracteres llegan como UN solo argumento', async () => {
  const nasty = 'a"; rm -rf /tmp/pwn; echo "x&y?q=1 2$d';
  const r = await tool('browser_type').execute({ ref: '@e1', texto: nasty }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes(`<${nasty}>`), 'texto intacto en un argv');
  assert.match(r.output, /TYPE-OK/);

  const url = 'https://x.com/buscar?q=hola mundo&n=1';
  const o = await tool('browser_open').execute({ url }, ctx);
  assert.equal(o.ok, true);
  assert.ok(o.output.includes(`<${url}>`), 'url con ? & y espacio intacta');
});

test('snapshot: -i solo con interactivas=true', async () => {
  const a = await tool('browser_snapshot').execute({ interactivas: true }, ctx);
  assert.equal(a.ok, true);
  assert.ok(a.output.includes('ARG1=<-i>'));
  const b = await tool('browser_snapshot').execute({}, ctx);
  assert.equal(b.ok, true);
  assert.ok(!b.output.includes('<-i>'));
  assert.match(b.output, /SNAP-OK/);
});

test('eval vía stdin: JS intacto + cap 2000ch', async () => {
  const js = 'document.title; "a\nb"; [1,2].length';
  const r = await tool('browser_eval').execute({ js }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('ARG1=<--stdin>'), 'usa --stdin');
  assert.ok(r.output.includes(js), 'js intacto vía stdin');

  const largo = await tool('browser_eval').execute({ js: 'x'.repeat(2001) }, ctx);
  assert.equal(largo.ok, false);
  assert.match(largo.error, /2000/);
});

// --- timeout / truncado / error -----------------------------------------------

test('timeout mata al hijo (default y open)', async () => {
  browser._setBrowserTimeouts({ defaultMs: 150, openMs: 150 });
  try {
    const r = await tool('browser_click').execute({ ref: '__SLEEP__' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout/);
    const o = await tool('browser_open').execute({ url: '__SLEEP__' }, ctx);
    assert.equal(o.ok, false);
    assert.match(r.error, /timeout/);
    assert.match(o.error, /timeout/);
  } finally {
    browser._resetBrowserTimeouts();
  }
});

test('truncado: salida gigante se recorta a 2000 (contrato output≤2000)', async () => {
  const r = await tool('browser_click').execute({ ref: '__BIG__' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.length <= 2000, `largo ${r.output.length} <= 2000`);
  assert.ok(!r.output.includes('CLICK-OK'), 'la cola quedó cortada');
  assert.match(r.output, /SESSION=equipo-general/);
});

test('error del hijo → {ok:false} con motivo', async () => {
  const r = await tool('browser_click').execute({ ref: '__FAIL__' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom-fake/);
});

test('close ok', async () => {
  const r = await tool('browser_close').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /CLOSE-OK/);
});

// --- validaciones ---------------------------------------------------------------

test('validaciones: args vacíos o largos → {ok:false}', async () => {
  const casos = [
    ['browser_open', {}],
    ['browser_open', { url: '   ' }],
    ['browser_open', { url: `https://x.com/${'a'.repeat(2100)}` }],
    ['browser_click', {}],
    ['browser_click', { ref: 'x'.repeat(501) }],
    ['browser_type', { ref: '@e1' }],
    ['browser_type', { texto: 'hola' }],
    ['browser_type', { ref: '@e1', texto: 'x'.repeat(4001) }],
    ['browser_eval', {}],
    ['browser_eval', { js: '  ' }]
  ];
  for (const [name, args] of casos) {
    const r = await tool(name).execute(args, ctx);
    assert.equal(r.ok, false, `${name} ${JSON.stringify(args).slice(0, 60)} debería fallar`);
    assert.ok(r.error, `${name} trae motivo`);
  }
});

// --- browser_shot (workspace) ---------------------------------------------------

test('browser_shot: default shots/browser-<ts>.png, crea carpeta', async () => {
  const r = await tool('browser_shot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /captura shots\/browser-.*\.png/);
  assert.ok(existsSync(path.join(TMPWS, EMPRESA, SLUG, 'shots')), 'crea shots/');
});

test('browser_shot: nombre custom → ab recibe path absoluto dentro del workspace', async () => {
  const logPath = path.join(TMPHOME, 'fake-args.log');
  process.env.FAKE_LOG = logPath;
  try {
    const r = await tool('browser_shot').execute({ nombre: 'shots/mi-foto' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.output, 'captura shots/mi-foto.png');
    const log = readFileSync(logPath, 'utf-8');
    const esperado = path.join(TMPWS, EMPRESA, SLUG, 'shots', 'mi-foto.png');
    assert.ok(log.includes(`<${esperado}>`), `ab recibe ${esperado}`);
  } finally {
    delete process.env.FAKE_LOG;
  }
});

test('browser_shot: escapes, absolutos, ocultos y ext rara → denegados', async () => {
  for (const nombre of ['../afuera.png', '/tmp/evil.png', '.oculto.png', 'shots/x.exe', 'a'.repeat(201)]) {
    const r = await tool('browser_shot').execute({ nombre }, ctx);
    assert.equal(r.ok, false, `${nombre.slice(0, 30)} denegado`);
  }
  const sinCtx = await tool('browser_shot').execute({}, {});
  assert.equal(sinCtx.ok, false);
  assert.match(sinCtx.error, /companyId/);
});

test('nunca throw: ctx vacío en las 7 devuelve contrato', async () => {
  for (const name of REGISTRADAS) {
    const r = await tool(name).execute({}, {});
    assert.equal(typeof r.ok, 'boolean', `${name} devuelve {ok}`);
    assert.equal(typeof r.output, 'string', `${name} devuelve output string`);
  }
});
