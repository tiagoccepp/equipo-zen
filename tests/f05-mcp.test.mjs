// F-05: MCP diferido — catálogo estático, ensure on-demand, wildcard allow.
// Fake stdio server para ensure; catálogo puro sin procesos.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_SERVERS = 'PABLO_MCP_SERVERS';
const NODE = process.execPath;
const savedServers = process.env[ENV_SERVERS];

const FAKE = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Repite el texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
    ]}});
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'eco:' + JSON.stringify(params.arguments) }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } });
  }
});
`;
const fixture = join(mkdtempSync(join(tmpdir(), 'f05-fake-')), 'fake.mjs');
writeFileSync(fixture, FAKE);

const mcp = await import('../server/lib/manos-mcp.js');
const manos = await import('../server/lib/manos.js');
const caps = await import('../server/lib/capabilities.js');

afterEach(async () => {
  if (savedServers === undefined) delete process.env[ENV_SERVERS];
  else process.env[ENV_SERVERS] = savedServers;
  await mcp.shutdown();
});

test('f05: catálogo estático cubre servers + search puro', () => {
  const servers = mcp.MCP_STATIC_CATALOG.map((e) => e.server);
  for (const s of ['fs', 'fetch', 'git', 'hora', 'sqlite', 'memoria', 'pensar']) {
    assert.ok(servers.includes(s), `catálogo trae ${s}`);
  }
  const hits = mcp.searchMcpCatalog('zona horaria actual', { configured: ['hora', 'fs'] });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].server, 'hora');
  assert.ok(hits[0].name.startsWith('mcp_hora_'));
  assert.deepEqual(mcp.searchMcpCatalog('hora', { configured: ['fs'] }), [], 'no configurado: no se menciona');
  assert.deepEqual(mcp.searchMcpCatalog('zz'), []);
  assert.deepEqual(mcp.searchMcpCatalog(''), []);
});

test('f05: ensure prende SOLO el server pedido y registra', async () => {
  process.env[ENV_SERVERS] = JSON.stringify([
    { name: 'uno', cmd: NODE, args: [fixture] },
    { name: 'dos', cmd: NODE, args: [fixture] }
  ]);
  const reg = await mcp.ensureMcpTools(['mcp_uno_echo']);
  assert.deepEqual(reg, ['mcp_uno_echo']);
  assert.ok(manos.getTool('mcp_uno_echo'), 'registrada');
  assert.equal(manos.getTool('mcp_dos_echo'), null, 'el otro server ni se tocó');
  const r = await manos.getTool('mcp_uno_echo').execute({ text: 'hola' }, {});
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('eco:'), r.output);
  manos.toolRegistry.delete('mcp_uno_echo');
});

test('f05: mcp_search tool + wildcard mcp_* en allow', async () => {
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'uno', cmd: NODE, args: [fixture] }]);
  // Static catalog no conoce 'uno': search vacío pero sin spawns ni crash.
  const search = manos.getTool('mcp_search');
  assert.ok(search, 'mcp_search registrada');
  const empty = await search.execute({ query: 'zzzzzz' }, {});
  assert.equal(empty.ok, true);
  // Wildcard: rol con mcp_* puede usar mcp_ registrada on-demand.
  await mcp.ensureMcpTools(['mcp_uno_echo']);
  const out = await manos.runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: (() => {
      let i = 0;
      const scripts = ['```tool:mcp_uno_echo\n{"text":"x"}\n```', 'fin'];
      return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
    })(),
    source: { companyId: 'c1', slug: 's' },
    allow: ['mcp_search', 'mcp_*'],
    maxTurns: 3
  });
  assert.ok(!out.toolSummary.includes('no permitida'), out.toolSummary);
  const calls = out.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, true, 'mcp_* cubre la diferida');
  manos.toolRegistry.delete('mcp_uno_echo');
});

test('f05: loadMcpTools diferido (cero spawns) + toolsForRole da search', async () => {
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'uno', cmd: NODE, args: [fixture] }]);
  manos._resetMcpCache();
  const names = await manos.loadMcpTools();
  assert.ok(names.includes('mcp_search'));
  assert.equal(manos.getTool('mcp_uno_echo'), null, 'nada registrado (cero spawns)');
  const allow = caps.toolsForRole('orquestador', { mcpTools: manos.listTools() });
  assert.ok(allow.includes('mcp_search'), 'rol con mcp needs busca');
  assert.ok(allow.includes('mcp_*'), 'wildcard para diferidas');
});
