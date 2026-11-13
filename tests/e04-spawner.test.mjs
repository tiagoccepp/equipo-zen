// E-04: spawner crítico — TODOS los roles sin un fallo, smoke real,
// anti-duplicados, rollback. DB :memory: + tmpdir. Cero red.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}
const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'e04-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;
process.env.PABLO_MEMORY_DIR = mkdtempSync(path.join(os.tmpdir(), 'e04-mem-'));

const { Store } = await import('../server/lib/store.js');
const { companyTemplates } = await import('../server/lib/config.js');
const spawner = await import('../server/lib/spawner.js');
const { knownRoles } = await import('../server/lib/capabilities.js');

afterEach(() => { spawner.__resetSpawnLog(); });

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Spawn' });
  return { store, company, project };
}

test('e04: spawnRequest trae capabilities+skills+tools+needs+mcp', () => {
  const r = spawner.spawnRequest(
    { rol: 'tester', porque: 'hacen falta pruebas' },
    { equipo: [] }
  );
  assert.equal(r.created, true, r.motivo);
  assert.ok(r.capabilities.length > 0);
  assert.ok(r.skills.length > 0, 'skills asignadas');
  assert.ok(r.tools.includes('screenshot') || r.tools.length > 0, 'tools asignadas');
  assert.ok(Array.isArray(r.needs), 'needs reportados');
  assert.ok(Array.isArray(r.mcp), 'mcp listados');
});

test('e04: anti-duplicados — equipo que cubre, pedido que deriva', () => {
  const dup = spawner.spawnRequest(
    { rol: 'backend', porque: 'más código' },
    { equipo: [{ id: 'b1', role: 'backend' }] }
  );
  assert.equal(dup.created, false);
  assert.ok(dup.existing, 'deriva al existente');
  const empty = spawner.spawnRequest({ rol: 'backend' }, { equipo: [] });
  assert.equal(empty.rejected, true, 'sin porqué: rechazo');
});

test('e04: smoke pasa en todos los roles con tools reales', async () => {
  for (const role of knownRoles()) {
    const s = await spawner.smokeSpawnedAgent({ role });
    assert.equal(s.ok, true, `${role}: ${JSON.stringify(s.checks)}`);
    assert.equal(s.checks.registry, 'ok', `${role} registry`);
    assert.ok(s.checks.boundary.startsWith('ok'), `${role} boundary`);
    assert.equal(s.checks.responded, 'ok', `${role} responde`);
  }
}, { timeout: 120000 });

test('e04: spawnAgent persiste + roster + rollback ante smoke roto', async () => {
  const { store, project } = seeded();
  const r = await spawner.spawnAgent({
    store,
    goalId: project.id,
    pedido: { rol: 'data', porque: 'el proyecto necesita análisis de datos' },
    ctx: {}
  });
  assert.equal(r.created, true, r.motivo);
  assert.ok(store.getAgent(r.agent.id), 'agente en DB');
  assert.ok(
    store.rosterForProject(project.id).some((x) => x.agent_id === r.agent.id),
    'agente en roster del proyecto'
  );
  assert.ok(r.smoke, 'smoke registrado');
  const log = store.listChangelog({ entity: 'roster', entityId: project.id });
  assert.ok(log.length > 0, 'matriz viva persistida en changelog');

  // Duplicado intra-proyecto: no crea otro.
  const dup = await spawner.spawnAgent({
    store,
    goalId: project.id,
    pedido: { rol: 'data', porque: 'otro analista' },
    ctx: {}
  });
  assert.equal(dup.created, false, 'cero duplicados en el proyecto');
  store.close();
});

test('e04: rollback borra todo si la persistencia falla', async () => {
  const { store, project } = seeded();
  // Store sabotado: insertAgent lanza.
  const broken = Object.create(store);
  broken.insertAgent = () => { throw new Error('db caída'); };
  broken.getGoal = store.getGoal.bind(store);
  const r = await spawner.spawnAgent({
    store: broken,
    goalId: project.id,
    pedido: { rol: 'devops', porque: 'hace falta deploy' },
    ctx: {}
  });
  assert.equal(r.created, false);
  assert.equal(r.rolledBack, true);
  assert.ok(r.motivo.includes('persistir'));
  store.close();
});
