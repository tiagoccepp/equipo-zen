// Tests del cliente MCP (mcp.js) y el adaptador a Manos (manos-mcp.js).
// Usan un server MCP fake (fixture temporal) que habla JSON-RPC por stdio.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpClient } from '../server/lib/mcp.js';
import { getMcpTools, callMcpTool, shutdown } from '../server/lib/manos-mcp.js';

const ENV_SERVERS = 'PABLO_MCP_SERVERS';
const ENV_TIMEOUT = 'PABLO_MCP_TIMEOUT_MS';
const NODE = process.execPath;

// Server MCP fake. Modos por argv[2]:
//   normal: initialize + list (2 tools) + call con eco
//   noisy:  igual pero escupe una línea no-JSON por stdout al arrancar
//   slow:   tools/call nunca responde (para probar timeout)
//   crash:  sale con código 1 al arrancar
const FAKE_SERVER = `
import { createInterface } from 'node:readline';
const mode = process.argv[2] || 'normal';
if (mode === 'crash') process.exit(1);
const rl = createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
if (mode === 'noisy') process.stdout.write('ESTO NO ES JSON, soy un log ruidoso\\n');
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notificación: sin respuesta
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05', capabilities: {},
      serverInfo: { name: 'fake', version: '1.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Repite el texto',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'sumar', description: 'Suma dos números',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    ]}});
  } else if (method === 'tools/call') {
    if (mode === 'slow') return; // nunca responde -> timeout del cliente
    send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: 'eco:' + JSON.stringify(params.arguments) }],
    }});
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'método desconocido' } });
  }
});
`;

let fixture;
let savedServers;
let savedTimeout;
let savedHome;

function setServers(entries) {
  process.env[ENV_SERVERS] = JSON.stringify(entries);
}

function fakeEntry(serverName, mode) {
  return { name: serverName, cmd: NODE, args: [fixture, mode] };
}

before(() => {
  savedServers = process.env[ENV_SERVERS];
  savedTimeout = process.env[ENV_TIMEOUT];
  // Integración manos 09/11: readMcpConfig tiene fallback a
  // ~/.config/equipo-mcp.json; HOME aislado para que 'ausente' sea ausente.
  savedHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'mcp-sin-config-'));
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  fixture = join(dir, 'fake-mcp-server.mjs');
  writeFileSync(fixture, FAKE_SERVER);
});

after(async () => {
  if (savedServers === undefined) delete process.env[ENV_SERVERS];
  else process.env[ENV_SERVERS] = savedServers;
  if (savedTimeout === undefined) delete process.env[ENV_TIMEOUT];
  else process.env[ENV_TIMEOUT] = savedTimeout;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await shutdown();
});

afterEach(async () => {
  delete process.env[ENV_SERVERS];
  delete process.env[ENV_TIMEOUT];
  await shutdown();
});

test('config ausente -> [] sin throw', async () => {
  assert.deepEqual(await getMcpTools(), []);
});

test('config inválida -> [] sin throw', async () => {
  process.env[ENV_SERVERS] = 'esto no es json';
  assert.deepEqual(await getMcpTools(), []);
  process.env[ENV_SERVERS] = JSON.stringify({ no: 'es un array' });
  assert.deepEqual(await getMcpTools(), []);
  // Entradas inválidas se saltean (falta cmd).
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'roto' }]);
  assert.deepEqual(await getMcpTools(), []);
});

test('list mapea nombres mcp_<server>_<tool> y parameters (server ruidoso)', async () => {
  setServers([fakeEntry('fs', 'noisy')]);
  const tools = await getMcpTools();
  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp_fs_echo', 'mcp_fs_sumar']);
  const echo = tools.find((t) => t.name === 'mcp_fs_echo');
  assert.equal(echo.description, 'Repite el texto');
  assert.deepEqual(echo.parameters, {
    type: 'object',
    properties: { text: { type: 'string' } },
  });
});

test('call devuelve {ok:true, output} con el eco', async () => {
  setServers([fakeEntry('fs', 'normal')]);
  const res = await callMcpTool('mcp_fs_echo', { text: 'hola' });
  assert.equal(res.ok, true);
  assert.equal(typeof res.output, 'string');
  assert.ok(res.output.includes('hola'), `output inesperado: ${res.output}`);
  assert.ok(res.output.length <= 2000);
});

test('server que duerme -> {ok:false} por timeout', async () => {
  setServers([fakeEntry('lento', 'slow')]);
  process.env[ENV_TIMEOUT] = '300'; // override corto solo para este test
  const res = await callMcpTool('mcp_lento_echo', { text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.output, '');
  assert.ok(res.error.includes('timeout'), `error inesperado: ${res.error}`);
});

test('server que crashea -> [] y {ok:false} sin colgar', async () => {
  setServers([fakeEntry('muerto', 'crash')]);
  assert.deepEqual(await getMcpTools(), []);
  const res = await callMcpTool('mcp_muerto_echo', { text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.output, '');
  assert.ok(res.error.length > 0);
});

test('tool con prefijo desconocido -> {ok:false}', async () => {
  setServers([fakeEntry('fs', 'normal')]);
  const res = await callMcpTool('mcp_otro_echo', {});
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('desconocida'));
});

test('McpClient directo: start/list/call/close y error tras close', async () => {
  const c = new McpClient({ cmd: NODE, args: [fixture, 'normal'], timeoutMs: 5000 });
  await c.start();
  assert.equal(c.isAlive(), true);
  const tools = await c.listTools();
  assert.equal(tools.length, 2);
  const res = await c.callTool('echo', { text: 'directo' });
  assert.ok(JSON.stringify(res).includes('directo'));
  await c.close();
  assert.equal(c.closed, true);
  await assert.rejects(() => c.listTools(), /cerrado/);
});

test('McpClient con comando inexistente rechaza al arrancar', async () => {
  const c = new McpClient({ cmd: 'comando-que-no-existe-xyz-123', timeoutMs: 2000 });
  await assert.rejects(() => c.start(), /no se pudo iniciar/);
});
