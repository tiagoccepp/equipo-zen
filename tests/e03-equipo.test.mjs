// E-03: equipo por proyecto — templates por stack, match de agentes,
// seed en createProject, reuniones que heredan el roster. Cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchAgentForRole, planProjectRoster, teamTemplateFor } from '../server/lib/team-templates.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];

function seeded() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(template, 'test');
  return { store, company };
}

test('e03: templates por stack + default', () => {
  assert.deepEqual(teamTemplateFor('web'), ['orquestador', 'diseno', 'frontend', 'backend', 'tester', 'copy']);
  assert.ok(teamTemplateFor('python').includes('data'));
  assert.ok(teamTemplateFor('automatizacion').includes('devops'));
  assert.deepEqual(teamTemplateFor('invento'), teamTemplateFor(''));
  assert.ok(teamTemplateFor(null).includes('orquestador'));
});

test('e03: match exacto gana; keywords cubren agentes viejos', () => {
  const agents = [
    { id: 'a1', status: 'active', role: 'worker', title: 'Programador', aliases: [], domains: ['codigo'], knowledge: '' },
    { id: 'a2', status: 'active', role: 'ceo', title: 'CEO', aliases: [], domains: [], knowledge: '' },
    { id: 'a3', status: 'active', role: 'frontend', title: 'Front', aliases: [], domains: [], knowledge: '' }
  ];
  assert.equal(matchAgentForRole(agents, 'ceo').id, 'a2');
  assert.equal(matchAgentForRole(agents, 'frontend').id, 'a3', 'exacto gana');
  assert.equal(matchAgentForRole(agents, 'backend').id, 'a1', 'keywords: programador/código');
  assert.equal(matchAgentForRole(agents, 'data'), null, 'sin match → null (va a missing)');
  const taken = new Set(['a1']);
  assert.equal(matchAgentForRole(agents, 'backend', taken), null, 'ocupado no se repite');
});

test('e03: planProjectRoster asigna sin duplicar + missing', () => {
  const agents = [
    { id: 'a1', status: 'active', role: 'ceo', title: 'CEO', aliases: [], domains: [], knowledge: '' },
    { id: 'a2', status: 'inactive', role: 'backend', title: 'X', aliases: [], domains: [], knowledge: '' }
  ];
  const plan = planProjectRoster(agents, 'web');
  assert.equal(plan.wanted.length, 6);
  assert.equal(plan.assigned.length, 1);
  assert.equal(plan.assigned[0].role, 'orquestador');
  assert.ok(plan.missing.includes('backend'), 'inactivo no cuenta');
  assert.ok(plan.missing.includes('tester'));
});

test('e03: createProject siembra roster; reunion hereda equipo (no empresa)', () => {
  const { store, company } = seeded();
  const all = store.listAgents({ companyId: company.id });
  assert.ok(all.length > 0);
  const project = store.createProject({ companyId: company.id, title: 'Sitio' });
  const roster = store.rosterForProject(project.id);
  assert.ok(roster.length > 0, 'roster sembrado');
  assert.ok(roster.every((r) => r.roleWanted), 'toda fila tiene rol querido');
  const agentIds = roster.filter((r) => r.agent_id).map((r) => r.agent_id);
  assert.equal(new Set(agentIds).size, agentIds.length, 'sin duplicados');
  assert.deepEqual(
    [...store.missingProjectRoles(project.id)].sort(),
    roster.filter((r) => !r.agent_id).map((r) => r.roleWanted).sort()
  );

  const meeting = store.createMeeting({ companyId: company.id, goalId: project.id });
  const enReunion = store.rosterForMeeting(meeting.id).map((a) => a.id).sort();
  assert.deepEqual(enReunion, [...agentIds].sort(), 'reunión = equipo del proyecto');

  // Proyecto 2 aísla su propio roster.
  const p2 = store.createProject({ companyId: company.id, title: 'Otro' });
  assert.ok(store.rosterForProject(p2.id).length > 0);
  store.close();
});

test('e03: seed idempotente + addAgentToProject cubre wanted', () => {
  const { store, company } = seeded();
  const project = store.createProject({ companyId: company.id, title: 'X' });
  const n1 = store.rosterForProject(project.id).length;
  store.seedProjectRoster(project.id);
  assert.equal(store.rosterForProject(project.id).length, n1, 'no duplica');

  const missing = store.missingProjectRoles(project.id);
  if (missing.length > 0) {
    const outsider = store.listAgents({ companyId: company.id })
      .find((a) => !store.rosterForProject(project.id).some((r) => r.agent_id === a.id));
    if (outsider) {
      store.addAgentToProject(project.id, outsider.id, missing[0], 'test');
      assert.ok(!store.missingProjectRoles(project.id).includes(missing[0]), 'wanted cubierto');
    }
  }
  store.close();
});

test('e03: reunion sin proyecto cae a empresa (legacy intacto)', () => {
  const { store, company } = seeded();
  const meeting = store.createMeeting({ companyId: company.id });
  assert.equal(
    store.rosterForMeeting(meeting.id).length,
    store.listAgents({ companyId: company.id }).length
  );
  store.close();
});
