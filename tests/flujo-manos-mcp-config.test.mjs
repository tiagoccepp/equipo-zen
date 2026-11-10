// Track B: MCP config from file + env merge + proxy strip.
// Follows the fake-server pattern from tests/mcp.test.mjs (JSON-RPC stdio, temp fixture).

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

// Fake server: initialize + list (echo, sumar) + call echoing args AND env.
// The call returns two lines: "eco:{args}" and "ENV:{json with selected vars}".
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

test('file fallback: temp HOME with valid config -> readMcpConfig + getMcpTools', async () => {
  // No env, with valid file.
  writeHomeConfig([fakeEntry('file')]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'file');
  const tools = await getMcpTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp_file_echo', 'mcp_file_sumar']);
});

test('env takes priority over file', async () => {
  writeHomeConfig([fakeEntry('file')]);
  setServers([fakeEntry('env')]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'env');
  const tools = await getMcpTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp_env_echo', 'mcp_env_sumar']);
});

test('missing or invalid file -> [] without throwing', async () => {
  // Missing.
  assert.deepEqual(readMcpConfig(), []);
  assert.deepEqual(await getMcpTools(), []);
  // Invalid JSON.
  writeHomeConfig('esto no es json {{{');
  assert.deepEqual(readMcpConfig(), []);
  // Not an array.
  writeHomeConfig({ no: 'array' });
  assert.deepEqual(readMcpConfig(), []);
});

test('env merge: entry.env reaches the child (via env)', async () => {
  setServers([fakeEntry('wenv', { env: { TEST_MCP_FOO: 'hola-env' } })]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0].env, { TEST_MCP_FOO: 'hola-env' });
  const res = await callMcpTool('mcp_wenv_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.TEST_MCP_FOO, 'hola-env');
});

test('env merge: entry.env reaches the child (via file)', async () => {
  writeHomeConfig([fakeEntry('fenv', { env: { TEST_MCP_FOO: 'desde-archivo' } })]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0].env, { TEST_MCP_FOO: 'desde-archivo' });
  const res = await callMcpTool('mcp_fenv_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.TEST_MCP_FOO, 'desde-archivo');
});

test('proxy strip: child does not see parent proxies + NODE_USE_ENV_PROXY=0', async () => {
  process.env.http_proxy = 'http://padre:8080';
  process.env.https_proxy = 'http://padre:8080';
  process.env.HTTP_PROXY = 'http://padre:8080';
  process.env.HTTPS_PROXY = 'http://padre:8080';
  // Parent does NOT define NODE_USE_ENV_PROXY; the child must see '0'.
  setServers([fakeEntry('px', { env: { TEST_MCP_FOO: 'con-proxy-padre' } })]);
  const res = await callMcpTool('mcp_px_echo', { text: 'x' });
  assert.equal(res.ok, true);
  const seen = parseEnvLine(res.output);
  assert.equal(seen.http_proxy, null);
  assert.equal(seen.https_proxy, null);
  assert.equal(seen.HTTP_PROXY, null);
  assert.equal(seen.HTTPS_PROXY, null);
  assert.equal(seen.NODE_USE_ENV_PROXY, '0');
  // And entry.env merge still works with strip active.
  assert.equal(seen.TEST_MCP_FOO, 'con-proxy-padre');
});

test('buildMcpEnv unit: strip + merge + entry wins', async () => {
  process.env.http_proxy = 'http://padre:8080';
  process.env.HTTP_PROXY = 'http://padre:8080';
  const base = buildMcpEnv(undefined);
  assert.equal(base.http_proxy, undefined);
  assert.equal(base.HTTP_PROXY, undefined);
  assert.equal(base.NODE_USE_ENV_PROXY, '0');
  const merged = buildMcpEnv({ TEST_MCP_FOO: 'v', NODE_USE_ENV_PROXY: '1' });
  assert.equal(merged.TEST_MCP_FOO, 'v');
  // entry.env wins on collision.
  assert.equal(merged.NODE_USE_ENV_PROXY, '1');
  // Non-string values are ignored.
  const mixed = buildMcpEnv({ OK: 'si', NO: 123 });
  assert.equal(mixed.OK, 'si');
  assert.equal(mixed.NO, undefined);
});

test('direct McpClient accepts {env} and merges it with strip', async () => {
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

test('invalid entries are skipped (via env)', async () => {
  setServers([
    null,
    'string',
    { name: '', cmd: NODE, args: [fixture] },           // empty name
    { name: 'noname' },                                  // no cmd
    { name: 'nocmd', cmd: '   ' },                       // empty cmd
    { name: 'badargs', cmd: NODE, args: 'no-array' },    // args not array
    { name: 'badargs2', cmd: NODE, args: [123] },        // args not strings
    { name: 'badenv', cmd: NODE, args: [fixture], env: 'no-obj' },       // env not object
    { name: 'badenv2', cmd: NODE, args: [fixture], env: { K: 123 } },     // env value not string
    { name: 'badenv3', cmd: NODE, args: [fixture], env: ['array'] },      // env array
    fakeEntry('buena'),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'buena');
  const tools = await getMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp_buena_echo', 'mcp_buena_sumar']);
});

test('invalid entries are skipped (via file)', async () => {
  writeHomeConfig([
    { name: 'rota' }, // no cmd
    { name: 'mala-env', cmd: NODE, args: [fixture], env: { K: 42 } },
    fakeEntry('buena-file'),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].name, 'buena-file');
  const tools = await getMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp_buena-file_echo', 'mcp_buena-file_sumar']);
});

// ---- TM2 (09/11): MCP repertoire. Additive, lightweight fakes, no real spawns. ----

test('TM2 repertoire: N servers add tools with mcp_<server>_<tool> prefix', async () => {
  // Mimics the repertoire shape (real names, fake cmd): 5 keyless.
  writeHomeConfig(['fs', 'fetch', 'git', 'hora', 'sqlite'].map((n) => fakeEntry(n)));
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 5);
  assert.deepEqual(cfg.map((e) => e.name).sort(), ['fetch', 'fs', 'git', 'hora', 'sqlite']);
  const tools = await getMcpTools();
  assert.equal(tools.length, 10); // 2 per fake server
  const names = tools.map((t) => t.name).sort();
  for (const n of ['fs', 'fetch', 'git', 'hora', 'sqlite']) {
    assert.ok(names.includes(`mcp_${n}_echo`), `falta mcp_${n}_echo`);
    assert.ok(names.includes(`mcp_${n}_sumar`), `falta mcp_${n}_sumar`);
  }
});

test('TM2 with-key: PENDIENTE placeholder in env reaches the child intact', async () => {
  // The 6 with-key ones are configured with an obvious placeholder (main decision).
  writeHomeConfig([
    fakeEntry('brave', { env: { BRAVE_API_KEY: 'PENDIENTE' } }),
    fakeEntry('github', { env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'PENDIENTE' } }),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 2);
  assert.deepEqual(cfg[0].env, { BRAVE_API_KEY: 'PENDIENTE' });
  assert.deepEqual(cfg[1].env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'PENDIENTE' });
  // And the placeholder flows to the child process unredacted (fake value, not a secret).
  const c = new McpClient({ cmd: NODE, args: [fixture], timeoutMs: 5000, env: { TEST_MCP_FOO: 'PENDIENTE' } });
  await c.start();
  try {
    const res = await c.callTool('echo', { text: 'k' });
    const text = res?.content?.[0]?.text ?? '';
    assert.equal(parseEnvLine(text).TEST_MCP_FOO, 'PENDIENTE');
  } finally {
    await c.close();
  }
});

test('TM2 gap: fallen server is skipped without breaking the rest', async () => {
  // 'false' exists on PATH and exits with code=1 immediately (no handshake).
  writeHomeConfig([
    { name: 'caido', cmd: 'false', args: [] },
    fakeEntry('vivo'),
  ]);
  const cfg = readMcpConfig();
  assert.equal(cfg.length, 2); // configured the same (gap visible via manager)
  const tools = await getMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp_vivo_echo', 'mcp_vivo_sumar']);
  const res = await callMcpTool('mcp_vivo_echo', { text: 'ok' });
  assert.equal(res.ok, true);
});
