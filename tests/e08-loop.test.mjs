// E-08: loop de aprendizaje — errores → skill_note accionables + refuerzo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordErrorLearning } from '../server/lib/learning.js';
import { runToolLoop, setManosStore, toolRegistry } from '../server/lib/manos.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Learn' });
  setManosStore(store);
  return { store, project, ctx: { companyId: company.id, slug: project.slug, agentId: 'a1' } };
}

const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;

test('e08: recordErrorLearning crea + refuerza duplicado', () => {
  const { store, project } = seeded();
  const r1 = recordErrorLearning(store, { agentId: 'a1', goalId: project.id, tool: 'run_cmd', error: 'timeout 30s' });
  assert.ok(r1.id && !r1.reinforced);
  const all = store.activeLearnings('a1', project.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].type, 'skill_note');
  assert.ok(all[0].content.includes('[error] run_cmd falló'), all[0].content);
  assert.ok(all[0].content.includes('cambiar de estrategia'), 'accionable');
  const r2 = recordErrorLearning(store, { agentId: 'a1', goalId: project.id, tool: 'run_cmd', error: 'timeout 30s' });
  assert.equal(r2.reinforced, true, 'dup refuerza, no duplica');
  assert.equal(store.activeLearnings('a1', project.id).length, 1);
  assert.equal(recordErrorLearning(store, { tool: null }), null);
  assert.equal(recordErrorLearning(null, { tool: 'x' }), null);
  store.close();
  setManosStore(null);
});

test('e08: loop con fallo deja learning solo (aprobación no)', async () => {
  const { store, project, ctx } = seeded();
  const { __resetPermissions, setMode } = await import('../server/lib/permissions.js');
  const { __resetHooks } = await import('../server/lib/hooks.js');
  __resetHooks();
  setMode('manual');
  try {
    await runToolLoop({
      system: 's',
      messages: [{ role: 'user', content: 'h' }],
      completeChat: (() => {
        let i = 0;
        const scripts = [
          call('read_file', { path: 'no-existe.txt' }),
          call('run_cmd', { cmd: 'ls' }),
          'fin'
        ];
        return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
      })(),
      source: ctx,
      maxTurns: 4
    });
  } finally {
    __resetPermissions();
  }
  const learnings = store.activeLearnings('a1', project.id);
  assert.equal(learnings.length, 1, `solo el fallo real (${learnings.map((l) => l.content).join('|')})`);
  assert.ok(learnings[0].content.includes('read_file'), 'el fallo, no la aprobación');
  store.close();
  setManosStore(null);
  toolRegistry.delete('qw10_fake');
});
