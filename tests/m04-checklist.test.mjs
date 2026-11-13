// M-04: checklist con voz + UI en vivo — store + tools + figura emitida.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { Store } = await import('../server/lib/store.js');
const { companyTemplates } = await import('../server/lib/config.js');
const manos = await import('../server/lib/manos.js');

afterEach(() => { manos.setManosStore(null); });

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Check' });
  manos.setManosStore(store);
  return { store, company, project, ctx: { companyId: company.id, slug: project.slug, agentId: 'a1', turnId: 't1' } };
}

function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}
const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;

test('m04: goalForSlug + add/list/complete', () => {
  const { store, company, project } = seeded();
  const goal = store.goalForSlug(company.id, project.slug);
  assert.equal(goal.id, project.id);
  assert.equal(store.goalForSlug(company.id, 'nope'), null);
  assert.deepEqual(store.checklistForGoal(project.id), []);
  const item = store.addChecklistItem(project.id, '  Armar home  ', 'a1');
  assert.equal(item.text, 'Armar home');
  assert.equal(store.addChecklistItem(project.id, '   '), null, 'vacío no se agrega');
  assert.equal(store.checklistForGoal(project.id).length, 1);
  store.setTaskCompleted(item.id, true);
  assert.equal(store.checklistForGoal(project.id)[0].completed, 1);
  store.close();
});

test('m04: tools por loop — add/list/done con figura en vivo', async () => {
  const { store, project, ctx } = seeded();
  const events = [];
  const outcome = await manos.runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'checklist' }],
    completeChat: fakeChat([
      call('task_add', { text: 'Uno' }),
      call('task_add', { text: 'Dos' }),
      call('task_list', {}),
      call('task_done', { item: '1' }),
      'fin, sin llamadas'
    ]),
    source: ctx,
    emit: (e) => events.push(e),
    maxTurns: 7
  });
  assert.ok(!outcome.toolSummary.includes('falló'), outcome.toolSummary);
  const items = store.checklistForGoal(project.id);
  assert.equal(items.length, 2);
  assert.equal(items[0].completed, 1, 'ítem 1 por número');
  assert.equal(items[1].completed, 0);
  const figs = events.filter((e) => e.type === 'agent_figure');
  assert.ok(figs.length >= 3, `figuras emitidas (${figs.length})`);
  assert.equal(figs[figs.length - 1].figure.kind, 'checklist');
  assert.deepEqual(
    figs[figs.length - 1].figure.items.map((i) => i.done),
    [true, false]
  );
  store.close();
});

test('m04: task_done habla progreso + errores claros', async () => {
  const { store, ctx } = seeded();
  const add = manos.getTool('task_add');
  const done = manos.getTool('task_done');
  await add.execute({ text: 'A' }, ctx);
  await add.execute({ text: 'B' }, ctx);
  const r = await done.execute({ item: '1' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('1 de 2'), r.output);
  assert.ok(r.output.includes('Faltan: B'), r.output);
  const bad = await done.execute({ item: '9' }, ctx);
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('inexistente'));
  // Sin store: error claro, no crash.
  manos.setManosStore(null);
  const nostore = await manos.getTool('task_list').execute({}, ctx);
  assert.equal(nostore.ok, false);
  assert.ok(nostore.error.includes('sin store'));
  store.close();
});

test('m04: undone desmarca', async () => {
  const { store, project, ctx } = seeded();
  await manos.getTool('task_add').execute({ text: 'A' }, ctx);
  const item = store.checklistForGoal(project.id)[0];
  await manos.getTool('task_done').execute({ item: item.id }, ctx);
  assert.equal(store.checklistForGoal(project.id)[0].completed, 1, 'por id también');
  await manos.getTool('task_done').execute({ item: item.id, undone: true }, ctx);
  assert.equal(store.checklistForGoal(project.id)[0].completed, 0);
  store.close();
});
