// E-22: niveles + prohibiciones — matriz, reversibilidad, deny absoluto.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetPermissions,
  checkCall,
  grantTool,
  isReversibleCall,
  matchPattern,
  matchProhibition,
  setMode
} from '../server/lib/permissions.js';
import { runToolLoop } from '../server/lib/manos.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

afterEach(() => { __resetPermissions(); });

function seeded(level = 'auto') {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Nivel' });
  store.setProjectAccess(project.id, level);
  return { store, project };
}

test('e22: matchPattern glob + regex', () => {
  assert.equal(matchPattern('run_cmd', 'run_*'), true);
  assert.equal(matchPattern('read_file', 'run_*'), false);
  assert.equal(matchPattern('rm -rf /tmp/x', '*rm -rf*'), true);
  assert.equal(matchPattern('ls', '*rm -rf*'), false);
  assert.equal(matchPattern('/etc/passwd', '/^\\/etc\\//'), true);
  assert.equal(matchPattern('/home/x', '/^\\/etc\\//'), false);
  assert.equal(matchPattern('x', '/(/'), false, 'regex rota no matchea');
  assert.equal(matchPattern('a', ''), false);
});

test('e22: reversibilidad por tool (delete no)', () => {
  assert.equal(isReversibleCall('read_file', {}), true);
  assert.equal(isReversibleCall('write_file', { path: 'a' }), true);
  assert.equal(isReversibleCall('run_cmd', { cmd: 'ls' }), false);
  assert.equal(isReversibleCall('outreach_send', {}), false);
  assert.equal(isReversibleCall('apply_patch', { patch: '*** Begin Patch\n*** Update File: a\n+x\n*** End Patch' }), true);
  assert.equal(isReversibleCall('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a\n*** End Patch' }), false);
});

test('e22: niveles — auto/reversibles/pedir-todo + modo estricto', () => {
  // auto/auto: ask pasa.
  assert.equal(checkCall('write_file', {}, { level: 'auto' }).verdict, 'allow');
  // reversibles: reversible pasa, irreversible pide.
  assert.equal(checkCall('write_file', {}, { level: 'reversibles' }).verdict, 'allow');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }, { level: 'reversibles' }).verdict, 'ask');
  // pedir-todo: todo pide.
  assert.equal(checkCall('write_file', {}, { level: 'pedir-todo' }).verdict, 'ask');
  assert.equal(checkCall('read_file', {}, { level: 'pedir-todo' }).verdict, 'allow', 'allow-tier intacto');
  // modo manual global gana a nivel auto.
  setMode('manual');
  assert.equal(checkCall('write_file', {}, { level: 'auto' }).verdict, 'ask');
});

test('e22: prohibiciones deny absoluto (ni grants las pisan)', () => {
  const rows = [
    { kind: 'tool', pattern: 'run_cmd', reason: 'sin shell' },
    { kind: 'cmd', pattern: '*rm -rf*', reason: '' },
    { kind: 'path', pattern: '/etc/*', reason: '' }
  ];
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }, { prohibitions: rows }).verdict, 'deny');
  grantTool('run_cmd', { scope: 'always' });
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }, { prohibitions: rows }).verdict, 'deny', 'grant no pisa deny');
  assert.equal(matchProhibition('write_file', { path: '/etc/x' }, rows).kind, 'path');
  assert.equal(matchProhibition('write_file', { path: 'notas/a.md' }, rows), null);
  const r = checkCall('run_cmd', { cmd: 'ls' }, { prohibitions: rows });
  assert.ok(r.prohibition.reason.includes('sin shell'));
});

test('e22: loop respeta nivel del proyecto + prohibiciones de DB', async () => {
  const { setManosStore } = await import('../server/lib/manos.js');
  const { store, project } = seeded('reversibles');
  setManosStore(store);
  store.addProhibition({ scope: 'project', goalId: project.id, kind: 'cmd', pattern: '*danger*', reason: 'test' });
  const ctx = { companyId: project.company_id, slug: project.slug, agentId: 'a1' };
  const call = (n, a) => `\`\`\`tool:${n}\n${JSON.stringify(a)}\n\`\`\``;
  const scripts = [
    call('write_file', { path: 'ok.txt', content: 'hola' }),
    call('run_cmd', { cmd: 'echo danger here' }),
    'fin'
  ];
  let i = 0;
  const out = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] }),
    source: ctx,
    maxTurns: 4
  });
  const calls = out.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, true, 'reversible en reversibles ejecuta');
  assert.equal(calls[1].ok, false);
  assert.ok(calls[1].error.includes('prohibido'), calls[1].error);
  store.close();
  setManosStore(null);
});

test('e22: store access + prohibiciones CRUD', () => {
  const { store, project } = seeded();
  assert.equal(store.setProjectAccess(project.id, 'invento'), null, 'nivel inválido');
  assert.equal(store.setProjectAccess(project.id, 'pedir-todo').access_level, 'pedir-todo');
  const row = store.addProhibition({ scope: 'global', kind: 'tool', pattern: 'x', reason: 'y' });
  assert.ok(row.id);
  assert.equal(store.addProhibition({ kind: 'nope', pattern: 'x' }), null);
  assert.equal(store.prohibitionsFor(project.id).length, 1, 'global aplica');
  assert.equal(store.removeProhibition(row.id), true);
  assert.equal(store.prohibitionsFor(project.id).length, 0);
  store.close();
});
