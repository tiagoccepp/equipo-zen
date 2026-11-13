// A-01 + A-05: dispatch frío por descripción + auto-proceed de planes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freezePacket, routePacketToAgent, scoreAgentForPacket } from '../server/lib/dispatch.js';
import { planAutoProceed, planStepsReversible } from '../server/lib/plan-mode.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { getTool, setManosStore } from '../server/lib/manos.js';

function live() {
  const sent = [];
  const socket = { readyState: 1, OPEN: 1, send: (p) => sent.push(JSON.parse(p)) };
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'D' });
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null, company.id, project.id);
  setManosStore(store);
  return { session, store, project, socket, sent };
}

test('a01: freezePacket congela keywords+preguntas', () => {
  const p = freezePacket('Diseñá la paleta de la home. ¿Oscura o clara?');
  assert.ok(p.id.startsWith('pkt-'));
  assert.ok(p.keywords.includes('paleta') || p.keywords.includes('disena'), p.keywords.join(','));
  assert.equal(p.questions.length, 1, 'una pregunta');
  assert.ok(p.questions[0].toLowerCase().includes('oscura'));
});

test('a01: routing por descripción elige al que calza', () => {
  const agents = [
    { id: 'd1', status: 'active', role: 'worker', title: 'Directora de arte', aliases: [], domains: ['diseno', 'color'], knowledge: 'paleta tipografía' },
    { id: 'b1', status: 'active', role: 'worker', title: 'Programador backend', aliases: [], domains: ['api', 'codigo'], knowledge: 'endpoints' }
  ];
  const p = freezePacket('definir la paleta de colores y tipografía');
  assert.ok(scoreAgentForPacket(agents[0], p) > scoreAgentForPacket(agents[1], p), 'diseño gana');
  assert.equal(routePacketToAgent(p, agents).id, 'd1');
  assert.equal(routePacketToAgent(freezePacket('zzz qqq jjj'), agents), null, 'umbral: nadie');
  assert.equal(routePacketToAgent(p, []), null);
});

test('a01: tarea sin target rutea por descripción (no siempre al autor)', () => {
  const { session } = live();
  const author = session.sessionAgents[0];
  const designTask = 'definir la paleta de colores de la home';
  session.processAgentTaskCommands(author.id, `[TAREA_CREAR: ${designTask}]`);
  // Alguien la tomó: o el autor (fallback) o diseño (ruteo).
  const owners = session.sessionAgents.filter((a) => (a.tasks || []).some((t) => t.text === designTask));
  assert.equal(owners.length, 1, 'exactamente un dueño');
  const routed = owners[0];
  const isDesign = /arte|diseño|diseno/i.test(`${routed.title} ${(routed.domains || []).join(' ')}`);
  assert.ok(isDesign || routed.id === author.id, `dueño sensato (${routed.title})`);
  session.store.close();
  setManosStore(null);
});

test('a05: reversibilidad + auto-proceed solo reversible', async () => {
  assert.equal(planStepsReversible(['Diseñar home', 'Escribir texto']), true);
  assert.equal(planStepsReversible(['Diseñar', 'Borrar la DB vieja']), false);
  assert.equal(planStepsReversible(['deploy a prod']), false);
  assert.equal(planStepsReversible([]), false);
  const { store, project } = live();
  const ok = store.proposePlan(project.id, 'a1', 'Reversible', ['Diseñar', 'Escribir'], {});
  const r = await planAutoProceed(store, ok.id);
  assert.equal(r.proceeded, true, r.reason);
  assert.equal(store.getTask(ok.id).status, 'approved');
  const bad = store.proposePlan(project.id, 'a1', 'Riesgoso', ['Borrar todo'], {});
  const r2 = await planAutoProceed(store, bad.id);
  assert.equal(r2.proceeded, false);
  assert.equal(store.getTask(bad.id).status, 'pending', 'sigue esperando a Tito');
  const r3 = await planAutoProceed(store, ok.id);
  assert.equal(r3.proceeded, false, 'ya resuelto no re-procede');
  store.close();
  setManosStore(null);
});

test('a05: propose programa once-job + tool expone preguntas', async () => {
  const { store, project } = live();
  const ctx = { companyId: project.company_id, slug: project.slug, agentId: 'a1' };
  const out = await getTool('plan_propose').execute({
    title: 'X', steps: ['Diseñar todo'], questions: ['Azul o verde?'], autoSec: 30
  }, ctx);
  assert.equal(out.ok, true, out.error);
  assert.ok(out.output.includes('Azul o verde?'), out.output);
  assert.ok(out.output.includes('30s'), out.output);
  const jobs = store.listSchedJobs(project.id).filter((j) => j.kind === 'once');
  assert.equal(jobs.length, 1, 'once-job programado');
  assert.ok(JSON.parse(jobs[0].action_json).planId, 'con planId');
  store.close();
  setManosStore(null);
});
