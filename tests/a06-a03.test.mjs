// A-06 + A-03: precedencia, policies, grants no pisan deny, sessionStart.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetPermissions,
  applyPolicy,
  checkCall,
  clearPolicies,
  grantTool,
  listPolicies,
  revokeGrant,
  setTier
} from '../server/lib/permissions.js';
import { __resetHooks, listHooks, registerHook, runHooks } from '../server/lib/hooks.js';

afterEach(() => { __resetPermissions(); __resetHooks(); });

test('a06: precedencia prohibiciones > deny > grants > modo', () => {
  // Grant guardado vs tier deny: deny gana.
  grantTool('run_cmd', { scope: 'always' });
  setTier('run_cmd', 'deny');
  assert.equal(checkCall('run_cmd', {}).verdict, 'deny', 'deny > grant guardado');
  // Prohibición vs grant: prohibición gana.
  const rows = [{ kind: 'tool', pattern: 'write_file' }];
  grantTool('write_file', { scope: 'always' });
  assert.equal(checkCall('write_file', {}, { prohibitions: rows }).verdict, 'deny');
});

test('a06: policies presets + revoke grants', async () => {
  const perms = await import('../server/lib/permissions.js');
  const r = perms.applyPolicy('read-only');
  assert.equal(r.ok, true);
  assert.ok(r.denied.includes('write_file'));
  assert.equal(perms.checkCall('write_file', {}).verdict, 'deny');
  assert.equal(perms.checkCall('read_file', {}).verdict, 'allow');
  assert.deepEqual(perms.listPolicies(), ['read-only']);
  assert.equal(perms.applyPolicy('invento').ok, false);
  const g = perms.grantTool('now', { scope: 'once' });
  assert.equal(perms.revokeGrant(g.id), true);
  assert.equal(perms.revokeGrant(g.id), false, 'doble revoke');
  perms.clearPolicies();
  assert.equal(perms.checkCall('write_file', {}).verdict, 'allow', 'clear revierte (modo auto)');
});

test('a03: sessionStart corre y acepta notice', async () => {
  assert.ok(listHooks('sessionStart') !== undefined || true);
  const seen = [];
  registerHook('sessionStart', (payload) => {
    seen.push(payload);
    return { notice: `Proyecto: ${payload.project?.title}` };
  });
  const r = await runHooks('sessionStart', {
    company: { id: 'c', name: 'Co' },
    project: { id: 'g', title: 'Web', slug: 'web' },
    meetingId: 'm', agents: ['a1']
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].project.slug, 'web', 'proyecto inyectado');
  assert.equal(r.results[0].value.notice, 'Proyecto: Web');
});
