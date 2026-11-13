// M-09: modo plan por voz — clasificador + ciclo propose→aprueba→ejecuta.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPlanReply, maybeResolvePlan, planStepsText } from '../server/lib/plan-mode.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { getTool, setManosStore } from '../server/lib/manos.js';

afterEach(() => { setManosStore(null); });

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Plan' });
  setManosStore(store);
  return { store, project, ctx: { companyId: company.id, slug: project.slug, agentId: 'a1' } };
}

test('m09: clasificador aprueba/rechaza/amend/unclear', () => {
  for (const t of ['dale', 'Dale!', 'sí', 'si', 'sí, dale', 'hacelo', 'aprobado', 'de una', 'mandale', 'do it', 'go ahead', 'sounds good']) {
    assert.equal(classifyPlanReply(t), 'approve', t);
  }
  assert.equal(classifyPlanReply('si hacés eso avisame'), 'unclear', 'condicional no aprueba');
  for (const t of ['no', 'mejor no', 'pará', 'todavía no', 'rechazo', 'stop']) {
    assert.equal(classifyPlanReply(t), 'reject', t);
  }
  assert.equal(classifyPlanReply('no, dale'), 'approve', 'el último manda');
  assert.equal(classifyPlanReply('dale, pero cambiá el paso 2 por otra cosa más larga y detallada para que supere holgadamente el largo mínimo de amendment textual larguísimo de verdad'), 'amend', 'largo = amend');
  assert.equal(classifyPlanReply('¿qué incluye?'), 'unclear');
  assert.equal(classifyPlanReply(''), 'unclear');
});

test('m09: ciclo completo propose → approve por voz', async () => {
  const { store, project, ctx } = seeded();
  assert.equal(store.planForGoal(project.id), null, 'sin plan');
  const prop = await getTool('plan_propose').execute({ title: 'Home nueva', steps: ['Diseñar', 'Codear', 'Probar'] }, ctx);
  assert.equal(prop.ok, true, prop.error);
  const plan = store.planForGoal(project.id);
  assert.ok(plan, 'plan pendiente');
  assert.ok(planStepsText(plan).includes('2. Codear'));
  const st = await getTool('plan_status').execute({}, ctx);
  assert.ok(st.output.includes('Home nueva'));

  const r = maybeResolvePlan(store, project.id, 'dale, hacelo');
  assert.equal(r.resolved, true);
  assert.equal(r.verdict, 'approve');
  assert.equal(store.planForGoal(project.id), null, 'ya no pendiente');
  assert.equal(store.getTask(plan.id).status, 'approved');
  store.close();
});

test('m09: reject por voz + nuevo plan supera al anterior', async () => {
  const { store, project, ctx } = seeded();
  await getTool('plan_propose').execute({ title: 'A', steps: ['x'] }, ctx);
  const p1 = store.planForGoal(project.id);
  const r = maybeResolvePlan(store, project.id, 'mejor no, pará');
  assert.equal(r.verdict, 'reject');
  assert.equal(store.getTask(p1.id).status, 'rejected');

  await getTool('plan_propose').execute({ title: 'B', steps: ['y'] }, ctx);
  await getTool('plan_propose').execute({ title: 'C', steps: ['z'] }, ctx);
  const pending = store.planForGoal(project.id);
  assert.ok(JSON.parse(pending.text).title === 'C', 'solo el último pendiente');
  store.close();
});

test('m09: sin plan o texto vago no resuelve', () => {
  const { store, project } = seeded();
  assert.equal(maybeResolvePlan(store, project.id, 'dale').resolved, false, 'sin plan: nada');
  assert.equal(maybeResolvePlan(null, null, 'dale').resolved, false, 'sin store: nada');
  store.close();
});
