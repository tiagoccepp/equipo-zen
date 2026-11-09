// Track B: MCP config por archivo + env merge + proxy strip.
// Sigue el patrón fake-server de tests/mcp.test.mjs (JSON-RPC stdio, fixture temporal).

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { McpClient, buildMcpEnv } from '../server/lib/mcp.js';
import { getMcpTools, callMcpTool, readMcpConfig, shutdown } from '../server/lib/manos-mcp.js';

const ENV_SERVERS = 'PABLO_MCP_SERVERS';
const ENV_TIMEOUT = 'PABLO_MCP_TIMEOUT_MS';
const NODE = process.execPath;
const PROXY_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];

// Fake server: initialize + list (echo, sumar) + call con eco de args Y de env.
// El call devuelve dos líneas: "eco:{args}" y "ENV:{json con vars selectas}".
const FAKE_SERVER = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05', capabilities: {},
      serverInfo: { name: 'fake-cfg', version: '1.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Repite el texto',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'sumar', description: 'Suma dos números',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    ]}});
  } else if (method === 'tools/call') {
    const seen = {
      TEST_MCP_FOO: process.env.TEST_MCP_FOO ?? null,
      http_proxy: process.env.http_proxy ?? null,
      https_proxy: process.env.https_proxy ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? null,
    };
    send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: 'eco:' + JSON.stringify(params.arguments) + '\\nENV:' + JSON.stringify(seen) }],
    }});
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'método desconocido' } });
  }
});
`;

let fixture;
let tmpHome;
let saved = {};

function setServers(entries) {
  process.env[ENV_SERVERS] = JSON.stringify(entries);
}

function fakeEntry(serverName, extra = {}) {
  return { name: serverName, cmd: NODE, args: [fixture], ...extra };
}

function writeHomeConfig(objOrRaw) {
  const cfgDir = join(tmpHome, '.config');
  mkdirSync(cfgDir, { recursive: true });
  const p = join(cfgDir, 'equipo-mcp.json');
  writeFileSync(p, typeof objOrRaw === 'string' ? objOrRaw : JSON.stringify(objOrRaw));
  return p;
}

function clearHomeConfig() {
  try { rmSync(join(tmpHome, '.config', 'equipo-mcp.json'), { force: true }); } catch {}
}

function parseEnvLine(output) {
  const line = output.split('\n').find((l) => l.startsWith('ENV:'));
  assert.ok(line, `sin línea ENV en output: ${output}`);
  return JSON.parse(line.slice(4));
}

before(() => {
  for (const k of [ENV_SERVERS, ENV_TIMEOUT, 'HOME', 'NODE_USE_ENV_PROXY', 'TEST_MCP_FOO', ...PROXY_VARS]) {
    saved[k] = process.env[k];
  }
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-test-'));
  fixture = join(dir, 'fake-mcp-server.mjs');
  writeFileSync(fixture, FAKE_SERVER);
  tmpHome = mkdtempSync(join(tmpdir(), 'mcp-cfg-home-'));
  process.env.HOME = tmpHome;
});

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await shutdown();
});

afterEach(async () => {
  delete process.env[ENV_SERVERS];
  delete process.env[ENV_TIMEOUT];
  delete process.env.TEST_MCP_FOO;
  delete process.env.NODE_USE_ENV_PROXY;
  for (const k of PROXY_VARS) delete process.env[k];
  process.env.HOME = tmpHome;
  clearHomeConfig();
  await shutdown();
});

test('fallback archivo: HOME temporal con config válido -> readMcpConfig + getMcpTools', async () => {
  // Sin env, con archivo válido.
  writeHomeConfig([fakeEntry('file')]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'file');
  const tools = await getMcpTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp_file_echo', 'mcp_file_sumar']);
});

test('env tiene prioridad sobre archivo', async () => {
  writeHomeConfig([fakeEntry('file')]);
  setServers([fakeEntry('env')]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'env');
  const tools = await getMcpTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp_env_echo', 'mcp_env_sumar']);
});

test('archivo ausente o inválido -> [] sin throw', async () => {
  // Ausente.
  assert.deepEqual(readMcpConfig(), []);
  assert.deepEqual(await getMcpTools(), []);
  // JSON inválido.
  writeHomeConfig('esto no es json {{{');
  assert.deepEqual(readMcpConfig(), []);
  // No-array.
  writeHomeConfig({ no: 'array' });
  assert.deepEqual(readMcpConfig(), []);
});

test('merge env: entry.env llega al hijo (vía env)', async () => {
  setServers([fakeEntry('wenv', { env: { TEST_MCP_FOO: 'hola-env' } })]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0].env, { TEST_MCP_FOO: 'hola-env' });
  const res = await callMcpTool('mcp_wenv_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.TEST_MCP_FOO, 'hola-env');
});

test('merge env: entry.env llega al hijo (vía archivo)', async () => {
  writeHomeConfig([fakeEntry('fenv', { env: { TEST_MCP_FOO: 'desde-archivo' } })]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0].env, { TEST_MCP_FOO: 'desde-archivo' });
  const res = await callMcpTool('mcp_fenv_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.TEST_MCP_FOO, 'desde-archivo');
});

test('proxy strip: hijo no ve proxies del padre + NODE_USE_ENV_PROXY=0', async () => {
  process.env.http_proxy = 'http://padre:8080';
  process.env.https_proxy = 'http://padre:8080';
  process.env.HTTP_PROXY = 'http://padre:8080';
  process.env.HTTPS_PROXY = 'http://padre:8080';
  // Padre NO define NODE_USE_ENV_PROXY; el hijo debe ver '0'.
  setServers([fakeEntry('px', { env: { TEST_MCP_FOO: 'con-proxy-padre' } })]);
  const res = await callMcpTool('mcp_px_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.http_proxy, null);
  assert.equal(seen.https_proxy, null);
  assert.equal(seen.HTTP_PROXY, null);
  assert.equal(seen.HTTPS_PROXY, null);
  assert.equal(seen.NODE_USE_ENV_PROXY, '0');
  // Y el merge de entry.env sigue funcionando con strip activo.
  assert.equal(seen.TEST_MCP_FOO, 'con-proxy-padre');
});

test('buildMcpEnv unitario: strip + merge + entry gana', async () => {
  process.env.http_proxy = 'http://padre:8080';
  process.env.HTTP_PROXY = 'http://padre:8080';
  const base = buildMcpEnv(undefined);
  assert.equal(base.http_proxy, undefined);
  assert.equal(base.HTTP_PROXY, undefined);
  assert.equal(base.NODE_USE_ENV_PROXY, '0');
  const merged = buildMcpEnv({ TEST_MCP_FOO: 'v', NODE_USE_ENV_PROXY: '1' });
  assert.equal(merged.TEST_MCP_FOO, 'v');
  // entry.env gana si colisiona.
  assert.equal(merged.NODE_USE_ENV_PROXY, '1');
  // Valores no-string se ignoran.
  const mixed = buildMcpEnv({ OK: 'si', NO: 123 });
  assert.equal(mixed.OK, 'si');
  assert.equal(mixed.NO, undefined);
});

test('McpClient directo acepta {env} y lo mergea con strip', async () => {
  process.env.http_proxy = 'http://padre:8080';
  const c = new McpClient({ cmd: NODE, args: [fixture], timeoutMs: 5000, env: { TEST_MCP_FOO: 'directo' } });
  await c.start();
  const res = await c.callTool('echo', { text: 'd' });
  const text = res?.content?.[0]?.text ?? '';
  const seen = parseEnvLine(text);
  assert.equal(seen.TEST_MCP_FOO, 'directo');
  assert.equal(seen.http_proxy, null);
  assert.equal(seen.NODE_USE_ENV_PROXY, '0');
  await c.close();
});

test('entradas inválidas se saltean (vía env)', async () => {
  setServers([
    null,
    'string',
    { name: '', cmd: NODE, args: [fixture] },           // name vacío
    { name: 'noname' },                                  // sin cmd
    { name: 'nocmd', cmd: '   ' },                       // cmd vacío
    { name: 'badargs', cmd: NODE, args: 'no-array' },    // args no array
    { name: 'badargs2', cmd: NODE, args: [123] },        // args no strings
    { name: 'badenv', cmd: NODE, args: [fixture], env: 'no-obj' },       // env no objeto
    { name: 'badenv2', cmd: NODE, args: [fixture], env: { K: 123 } },     // env valor no string
    { name: 'badenv3', cmd: NODE, args: [fixture], env: ['array'] },      // env array
    fakeEntry('buena'),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'buena');
  const tools = await getMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp_buena_echo', 'mcp_buena_sumar']);
});

test('entradas inválidas se saltean (vía archivo)', async () => {
  writeHomeConfig([
    { name: 'rota' }, // sin cmd
    { name: 'mala-env', cmd: NODE, args: [fixture], env: { K: 42 } },
    fakeEntry('buena-file'),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'buena-file');
  const tools = await getMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp_buena-file_echo', 'mcp_buena-file_sumar']);
});
