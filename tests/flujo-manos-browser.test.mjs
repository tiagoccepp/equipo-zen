// Track A: manos browser_* over ~/agentes/bin/ab.
// ZERO real browser: temp HOME (without agentes/bin/ab) + fake
// `agent-browser` on a temp PATH with canned outputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync,
  readdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No proxy (same reason as manos.test.mjs: Undici + local stubs).
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

// HOME without agentes/bin/ab → the lib falls back to `agent-browser` on
// PATH, where the fake lives. (The real ab exists in the true HOME.)
const TMPHOME = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-home-'));
const FAKEBIN = mkdtempSync(path.join(os.tmpdir(), 'manos-browser-bin-'));
const ORIG_HOME = process.env.HOME;
const ORIG_PATH = process.env.PATH || '';
process.env.HOME = TMPHOME;
process.env.PATH = `${FAKEBIN}:${ORIG_PATH}`;

// Fake agent-browser: session/env/argv echo + canned outputs.
// Argv triggers: __SLEEP__ (hangs 30s), __FAIL__ (exit 3 with
// "boom-fake" on stderr), __BIG__ (5000 chars on stdout).
// If FAKE_LOG is set, dumps each argv there (for browser_shot,
// whose output does not include the echo).
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

// --- registration -----------------------------------------------------------

test('all 7 browser_* registered, with schemas', () => {
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
  // Idempotent: re-registering neither duplicates nor breaks.
  browser.registerBrowserTools();
  for (const name of Object.keys(esperadas)) tool(name);
});

test('binary: agent-browser fallback without ~/agentes/bin/ab + EQUIPO_AB_BIN override', () => {
  assert.equal(browser.resolveAbBin(), 'agent-browser');
  process.env.EQUIPO_AB_BIN = '/tmp/fake-ab-test';
  try {
    assert.equal(browser.resolveAbBin(), '/tmp/fake-ab-test');
  } finally {
    delete process.env.EQUIPO_AB_BIN;
  }
});

test('sesionPara: sanitizes agentId, general default', () => {
  assert.equal(browser.sesionPara('Pablo! #1'), 'pablo-1');
  assert.equal(browser.sesionPara('  A__B-2 '), 'a__b-2');
  assert.equal(browser.sesionPara(''), 'general');
  assert.equal(browser.sesionPara(undefined), 'general');
  assert.equal(browser.sesionPara('!!!'), 'general');
  assert.equal(browser.sesionPara('x'.repeat(100)).length, 40);
});

// --- child session and env ---------------------------------------------------

test('session per agentId (sanitized) and general default', async () => {
  const r1 = await tool('browser_snapshot').execute({}, { ...ctx, agentId: 'Pablo! #1' });
  assert.equal(r1.ok, true);
  assert.match(r1.output, /SESSION=equipo-pablo-1/);
  const r2 = await tool('browser_snapshot').execute({}, ctx);
  assert.equal(r2.ok, true);
  assert.match(r2.output, /SESSION=equipo-general/);
});

test('child env: pinned chrome, --no-proxy-server, proxy strip', async () => {
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

// --- argv without shell -------------------------------------------------------

test('argv without shell: metacharacters arrive as ONE single argument', async () => {
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

test('snapshot: -i only with interactivas=true', async () => {
  const a = await tool('browser_snapshot').execute({ interactivas: true }, ctx);
  assert.equal(a.ok, true);
  assert.ok(a.output.includes('ARG1=<-i>'));
  const b = await tool('browser_snapshot').execute({}, ctx);
  assert.equal(b.ok, true);
  assert.ok(!b.output.includes('<-i>'));
  assert.match(b.output, /SNAP-OK/);
});

test('eval via stdin: intact JS + 2000ch cap', async () => {
  const js = 'document.title; "a\nb"; [1,2].length';
  const r = await tool('browser_eval').execute({ js }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('ARG1=<--stdin>'), 'usa --stdin');
  assert.ok(r.output.includes(js), 'js intacto vía stdin');

  const largo = await tool('browser_eval').execute({ js: 'x'.repeat(2001) }, ctx);
  assert.equal(largo.ok, false);
  assert.match(largo.error, /2000/);
});

// --- timeout / truncation / error -----------------------------------------------

test('timeout kills the child (default and open)', async () => {
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

test('truncation: giant output is cut to 2000 (output≤2000 contract)', async () => {
  const r = await tool('browser_click').execute({ ref: '__BIG__' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.length <= 2000, `largo ${r.output.length} <= 2000`);
  assert.ok(!r.output.includes('CLICK-OK'), 'la cola quedó cortada');
  assert.match(r.output, /SESSION=equipo-general/);
});

test('child error → {ok:false} with reason', async () => {
  const r = await tool('browser_click').execute({ ref: '__FAIL__' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom-fake/);
});

test('close ok', async () => {
  const r = await tool('browser_close').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /CLOSE-OK/);
});

// --- validations ---------------------------------------------------------------

test('validations: empty or long args → {ok:false}', async () => {
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

test('browser_shot: default shots/browser-<ts>.png, creates folder', async () => {
  const r = await tool('browser_shot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /captura shots\/browser-.*\.png/);
  assert.ok(existsSync(path.join(TMPWS, EMPRESA, SLUG, 'shots')), 'crea shots/');
});

test('browser_shot: custom nombre → ab receives absolute path inside the workspace', async () => {
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

test('browser_shot: escapes, absolutes, hidden and weird ext → denied', async () => {
  for (const nombre of ['../afuera.png', '/tmp/evil.png', '.oculto.png', 'shots/x.exe', 'a'.repeat(201)]) {
    const r = await tool('browser_shot').execute({ nombre }, ctx);
    assert.equal(r.ok, false, `${nombre.slice(0, 30)} denegado`);
  }
  const sinCtx = await tool('browser_shot').execute({}, {});
  assert.equal(sinCtx.ok, false);
  assert.match(sinCtx.error, /companyId/);
});

test('never throws: empty ctx on all 7 returns the contract', async () => {
  for (const name of REGISTRADAS) {
    const r = await tool(name).execute({}, {});
    assert.equal(typeof r.ok, 'boolean', `${name} devuelve {ok}`);
    assert.equal(typeof r.output, 'string', `${name} devuelve output string`);
  }
});
