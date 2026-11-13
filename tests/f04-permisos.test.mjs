// F-04: permisos deny→ask→allow + modos + grants + gate en loop.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetPermissions,
  checkCall,
  getMode,
  grantTool,
  listPending,
  requestApproval,
  resolveApproval,
  setMode,
  setTier,
  tierFor
} from '../server/lib/permissions.js';
import { runToolLoop } from '../server/lib/manos.js';

afterEach(() => { __resetPermissions(); });

const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;
function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}

test('f04: tiers default + fail-closed + overrides', () => {
  assert.equal(getMode(), 'auto', 'default preserva conducta actual');
  assert.equal(tierFor('read_file'), 'allow');
  assert.equal(tierFor('write_file'), 'ask');
  assert.equal(tierFor('run_cmd'), 'ask');
  assert.equal(tierFor('outreach_send'), 'ask');
  assert.equal(tierFor('invento_total'), 'ask', 'desconocida fail-closed');
  assert.equal(setTier('fetch_url', 'deny'), true);
  assert.equal(tierFor('fetch_url'), 'deny');
  assert.equal(setTier('x', 'talvez'), false);
  assert.equal(setMode('manual'), true);
  assert.equal(getMode(), 'manual');
  assert.equal(setMode('turbo'), false);
});

test('f04: checkCall por modo (deny niega siempre; auto pasa; manual pide)', () => {
  assert.equal(checkCall('read_file', {}).verdict, 'allow');
  setTier('run_cmd', 'deny');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }).verdict, 'deny');
  setTier('run_cmd', 'ask');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }).verdict, 'allow', 'auto pasa (auto:true)');
  setMode('manual');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }).verdict, 'ask');
  setMode('plan');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }, {}).verdict, 'ask', 'plan sin plan aprobado pide');
  assert.equal(checkCall('run_cmd', { cmd: 'ls' }, { planApproved: true }).verdict, 'allow', 'plan aprobado ejecuta');
});

test('f04: grants once se consumen; project aísla por goal', () => {
  setMode('manual');
  grantTool('run_cmd', { scope: 'once', uses: 2 });
  assert.equal(checkCall('run_cmd', {}).verdict, 'allow');
  assert.equal(checkCall('run_cmd', {}).verdict, 'allow');
  assert.equal(checkCall('run_cmd', {}).verdict, 'ask', 'consumido');
  grantTool('write_file', { scope: 'project', goalId: 'g1' });
  assert.equal(checkCall('write_file', {}, { goalId: 'g1' }).verdict, 'allow');
  assert.equal(checkCall('write_file', {}, { goalId: 'g2' }).verdict, 'ask', 'otro proyecto no');
  grantTool('write_file', { scope: 'always' });
  assert.equal(checkCall('write_file', {}, { goalId: 'g2' }).verdict, 'allow');
});

test('f04: ciclo pendiente → resolve approve/deny', () => {
  const id = requestApproval({ tool: 'run_cmd', args: { cmd: 'rm -rf /' }, goalId: 'g1', userText: 'borrá todo' });
  assert.ok(id.startsWith('approval-'));
  assert.equal(listPending().length, 1);
  const denied = resolveApproval(id, false);
  assert.equal(denied.approved, false);
  assert.equal(listPending().length, 0);
  const id2 = requestApproval({ tool: 'run_cmd', args: {} });
  const ok = resolveApproval(id2, true, { scope: 'once' });
  assert.equal(ok.approved, true);
  assert.ok(ok.grant.id.startsWith('grant-'));
  assert.equal(resolveApproval('approval-999', true).ok, false, 'inexistente');
});

test('f04: loop en manual frena con APPROVAL_REQUIRED; grant libera', async () => {
  setMode('manual');
  const events = [];
  const outcome = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: fakeChat([call('run_cmd', { cmd: 'ls' }), 'fin']),
    source: { companyId: 'c1', slug: 's' },
    allow: ['run_cmd'],
    blockedUserText: 'listá archivos',
    emit: (e) => events.push(e),
    maxTurns: 3
  });
  assert.ok(outcome.toolSummary.includes('pausado: falta aprobación'), outcome.toolSummary);
  const done = events.find((e) => e.type === 'agent_tool_done');
  assert.ok(done.approvalId, 'evento trae approvalId');
  assert.equal(listPending().length, 1);
  assert.equal(listPending()[0].userText, 'listá archivos');
  // Grant + re-loop: ejecuta (run_cmd real 'echo' inocuo).
  resolveApproval(done.approvalId, true, { scope: 'once' });
  const outcome2 = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: fakeChat([call('run_cmd', { cmd: 'echo ok' }), 'fin']),
    source: { companyId: 'c1', slug: 's' },
    allow: ['run_cmd'],
    maxTurns: 3
  });
  assert.ok(!outcome2.toolSummary.includes('pausado'), outcome2.toolSummary);
});

test('f04: deny frena esa call pero el loop sigue', async () => {
  setMode('manual');
  setTier('run_cmd', 'deny');
  grantTool('now', { scope: 'once' });
  const outcome = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: fakeChat([
      call('run_cmd', { cmd: 'ls' }),
      call('now', {}),
      'fin'
    ]),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 4
  });
  const calls = outcome.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, false);
  assert.ok(calls[0].error.includes('bloqueada por permisos'), calls[0].error);
  assert.equal(calls[1].ok, true, 'el loop sigue con otras tools');
});
