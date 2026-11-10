// T5 — MCP/skills manager: pure status, never spawns servers.
// Fake config (env + temp HOME), real skills, injectable snapshot,
// honest gaps, planReconnect documents. Never spawns.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  getMcpStatus,
  setMcpStatusSnapshot,
  getMcpStatusSnapshot,
  planReconnect,
  __resetMcpStatusSnapshot,
} from '../server/lib/mcp-status.js';
import { __resetSkillsCache } from '../server/lib/skills.js';

const ENV_SERVERS = 'PABLO_MCP_SERVERS';

let tmpHome;
let saved = {};

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

before(() => {
  for (const k of [ENV_SERVERS, 'HOME']) saved[k] = process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), 'mcp-status-home-'));
  process.env.HOME = tmpHome;
  __resetSkillsCache();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMcpStatusSnapshot();
  __resetSkillsCache();
});

afterEach(() => {
  delete process.env[ENV_SERVERS];
  process.env.HOME = tmpHome;
  clearHomeConfig();
  __resetMcpStatusSnapshot();
  __resetSkillsCache();
});

test('no config: servers [] + honest gap + real skills', () => {
  const st = getMcpStatus();
  assert.deepEqual(st.servers, []);
  assert.ok(st.gaps.some((g) => g.includes('sin servers')), `gaps: ${JSON.stringify(st.gaps)}`);
  // Real repo skills (not fakes).
  const names = st.skills.map((s) => s.name);
  assert.ok(names.includes('diseno-web'), 'skill real diseno-web');
  assert.ok(names.includes('revision-codigo'), 'skill real revision-codigo');
  for (const s of st.skills) {
    assert.ok(Array.isArray(s.scopes) && s.scopes.length > 0, `${s.name} con scopes`);
  }
});

test('fake config via env: configured true, alive false, tools [] (no snapshot)', () => {
  process.env[ENV_SERVERS] = JSON.stringify([
    { name: 'fake-a', cmd: '/bin/false', args: [] },
    { name: 'fake-b', cmd: '/bin/false', args: [] },
  ]);
  const st = getMcpStatus();
  assert.equal(st.servers.length, 2);
  for (const s of st.servers) {
    assert.equal(s.configured, true);
    assert.equal(s.alive, false);
    assert.deepEqual(s.tools, []);
  }
  assert.ok(st.gaps.some((g) => g.includes('fake-a') && g.includes('no vivo')));
  assert.ok(st.gaps.some((g) => g.includes('fake-b') && g.includes('no vivo')));
});

test('fake config via temp HOME file', () => {
  writeHomeConfig([{ name: 'file-srv', cmd: '/bin/false', args: [] }]);
  const st = getMcpStatus();
  assert.equal(st.servers.length, 1);
  assert.equal(st.servers[0].name, 'file-srv');
  assert.equal(st.servers[0].configured, true);
  assert.equal(st.servers[0].alive, false);
});

test('injected snapshot: alive + tools, gaps shrink', () => {
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'srv', cmd: '/bin/false', args: [] }]);
  setMcpStatusSnapshot({ alive: { srv: true }, tools: { srv: ['echo', 'sumar'] } });
  const st = getMcpStatus();
  assert.equal(st.servers.length, 1);
  assert.equal(st.servers[0].alive, true);
  assert.deepEqual(st.servers[0].tools, ['echo', 'sumar']);
  assert.ok(!st.gaps.some((g) => g.includes('"srv"')), `gaps: ${JSON.stringify(st.gaps)}`);
  // One-off snapshot override does not clobber the global one.
  const st2 = getMcpStatus({ snapshot: { alive: {}, tools: {} } });
  assert.equal(st2.servers[0].alive, false);
  assert.deepEqual(getMcpStatusSnapshot().tools, { srv: ['echo', 'sumar'] });
});

test('alive without tools → honest gap', () => {
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'empty', cmd: '/bin/false', args: [] }]);
  setMcpStatusSnapshot({ alive: { empty: true }, tools: { empty: [] } });
  const st = getMcpStatus();
  assert.equal(st.servers[0].alive, true);
  assert.ok(st.gaps.some((g) => g.includes('"empty"') && g.includes('sin tools')));
});

test('stale: snapshot with no-longer-configured server → configured false + gap', () => {
  setMcpStatusSnapshot({ alive: { viejo: true }, tools: { viejo: ['x'] } });
  const st = getMcpStatus();
  assert.equal(st.servers.length, 1);
  assert.equal(st.servers[0].name, 'viejo');
  assert.equal(st.servers[0].configured, false);
  assert.equal(st.servers[0].alive, true);
  assert.ok(st.gaps.some((g) => g.includes('"viejo"') && g.includes('ya no configurado')));
});

test('planReconnect documents steps for main (pure)', () => {
  const plan = planReconnect();
  assert.equal(plan.method, 'POST');
  assert.equal(plan.path, '/api/mcp/reconnect');
  assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 4);
  const joined = plan.steps.join('\n');
  assert.ok(joined.includes('shutdown'), 'menciona shutdown');
  assert.ok(joined.includes('getMcpTools'), 'menciona getMcpTools');
  assert.ok(joined.includes('setMcpStatusSnapshot'), 'menciona snapshot');
  assert.ok(joined.includes('getMcpStatus'), 'menciona status fresco');
});

test('NO spawn: source does not reference spawn/McpClient/getMcpTools + sync return', () => {
  const src = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '..', 'server', 'lib', 'mcp-status.js'),
    'utf8'
  );
  // Real code: no comments or strings (planReconnect strings
  // DOCUMENT getMcpTools/shutdown on purpose; comments explain).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const banned of ['spawn', 'child_process', 'McpClient', 'getMcpTools', 'callMcpTool', 'withMcpClient']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(code), `mcp-status.js no debe usar ${banned} en código`);
  }
  // Imports allowlist: only readMcpConfig + loadSkills (both pure, no spawn).
  const srcImports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(srcImports.sort(), ['./manos-mcp.js', './skills.js']);
  // Sync: if it spawned/listed it would be async. getMcpStatus returns a direct object.
  process.env[ENV_SERVERS] = JSON.stringify([{ name: 'no-spawn', cmd: '/bin/false', args: [] }]);
  const st = getMcpStatus();
  assert.equal(typeof st.then, 'undefined', 'getMcpStatus es síncrono (no Promise)');
  assert.equal(st.servers[0].name, 'no-spawn');
  assert.equal(st.servers[0].alive, false, 'sin snapshot: no vivo, sin sondear');
});

test('opts.config / opts.skillsList allow pure overrides', () => {
  const st = getMcpStatus({
    config: [{ name: 'inj', cmd: 'x', args: [] }],
    skillsList: [{ name: 'demo', scopes: ['chat'], scope: 'chat' }],
    snapshot: { alive: { inj: true }, tools: { inj: ['a'] } },
  });
  assert.equal(st.servers.length, 1);
  assert.equal(st.servers[0].name, 'inj');
  assert.deepEqual(st.skills, [{ name: 'demo', scopes: ['chat'] }]);
});
