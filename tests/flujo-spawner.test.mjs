// Track B: spawner + capabilities matrix. Hermetic: workspace in tmpdir
// via PABLO_MEMORY_DIR; no network, no DISPLAY, no MCP.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach } from 'node:test';

process.env.PABLO_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'spawner-test-'));

const caps = await import('../server/lib/capabilities.js');
const spawner = await import('../server/lib/spawner.js');
const skills = await import('../server/lib/skills.js');
const conv = await import('../server/lib/agent-conventions.js');

beforeEach(() => {
  spawner.__resetSpawnLog();
  skills.__resetSkillsCache();
  conv.__resetConventionsCache();
});

describe('matrix intact: every capability resolves to real', () => {
  it('empty integrity against the real repo', () => {
    const fantasmas = caps.integrityCheck();
    assert.deepEqual(fantasmas, [], `capabilities fantasma: ${JSON.stringify(fantasmas)}`);
  });

  it('each unknown capability does not resolve', () => {
    const r = caps.resolveCapability('teletransportacion');
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /desconocida/);
  });

  it('detects a ghost tool when the inventory lacks it', () => {
    const r = caps.resolveCapability('exec', { tools: [], skills: ['terminal'] });
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.includes('run_cmd')));
  });

  it('all roles have base + own capabilities', () => {
    for (const rol of caps.knownRoles()) {
      const c = caps.capabilitiesForRole(rol);
      for (const b of caps.BASE_CAPABILITIES) {
        assert.ok(c.includes(b), `${rol} sin base ${b}`);
      }
    }
    assert.deepEqual(caps.capabilitiesForRole('pablo'), [...caps.BASE_CAPABILITIES]);
    assert.ok(caps.capabilitiesForRole('backend').includes('exec'));
    assert.ok(caps.capabilitiesForRole('tester').includes('screenshots'));
    assert.ok(caps.capabilitiesForRole('marketing').includes('outreach-lectura'));
  });
});

describe('no-duplicates: current team wins', () => {
  it('covering member → answers existente', () => {
    const r = spawner.spawnRequest(
      { rol: 'backend', porque: 'falta API', capabilities: ['exec'] },
      { equipo: [{ id: 'be-1', role: 'backend' }] }
    );
    assert.equal(r.created, false);
    assert.equal(r.existing, 'backend');
    assert.equal(r.agentId, 'be-1');
    assert.match(r.motivo, /cero duplicados/);
  });

  it('known role without a member → creates', () => {
    const r = spawner.spawnRequest(
      { rol: 'backend', porque: 'falta API' },
      { equipo: [{ id: 'fe-1', role: 'frontend' }] }
    );
    assert.equal(r.created, true);
    assert.equal(r.agent.role, 'backend');
  });

  it('unknown role covered by an existing one → derives', () => {
    const r = spawner.spawnRequest(
      { rol: 'ninja', porque: 'algo', capabilities: ['exec'] },
      { equipo: [{ id: 'be-1', role: 'backend' }] }
    );
    assert.equal(r.created, false);
    assert.equal(r.existing, 'backend');
  });

  it('rolQueCubre: matrix subset', () => {
    assert.equal(caps.rolQueCubre(['exec', 'tests']), 'backend');
    assert.equal(caps.rolQueCubre(['no-existe']), null);
    assert.equal(caps.rolQueCubre([]), null);
  });
});

describe('spawn creates ficha + skills + tools', () => {
  it('ficha in workspace + concrete skills/tools', () => {
    const r = spawner.spawnRequest(
      { rol: 'marketing', porque: 'lanzamiento del producto' },
      { companySlug: 'acme', equipo: [] }
    );
    assert.equal(r.created, true);
    assert.ok(r.ficha && r.ficha.includes('acme'), `sin ficha: ${r.ficha}`);
    assert.ok(r.capabilities.includes('outreach-lectura'));
    assert.ok(r.skills.includes('marketing'), `skills: ${r.skills.join(',')}`);
    assert.ok(r.tools.includes('fetch_url'), `tools: ${r.tools.join(',')}`);
    // The ficha exists and is a marketing seed.
    const frag = conv.renderAgentConventions('acme', r.agent);
    assert.match(frag, /MARKETING/);
    // Log records it.
    assert.equal(spawner.spawnLog().length, 1);
  });

  it('skillsForRole brings the new ones by scope', () => {
    assert.ok(skills.skillsForRole('marketing').includes('marketing'));
    assert.ok(skills.skillsForRole('ventas').includes('ventas'));
    assert.ok(skills.skillsForRole('tester').includes('pruebas'));
    assert.ok(skills.skillsForRole('orquestador').includes('plan-dispatch'));
  });
});

describe('rejection with motivo', () => {
  it('no reason given → rejection', () => {
    const r = spawner.spawnRequest({ rol: 'backend' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    assert.match(r.motivo, /porqu/);
  });

  it('empty request → rejection', () => {
    const r = spawner.spawnRequest({ porque: 'x' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    const v = spawner.spawnRequest({}, {});
    assert.equal(v.rejected, true);
  });

  it('unknown role without capabilities → rejection with valid roles', () => {
    const r = spawner.spawnRequest({ rol: 'astronauta', porque: 'sueño' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    assert.match(r.motivo, /backend/);
  });
});

describe('revisaMonetizacion (pure, no IO)', () => {
  it('detects potential profit', () => {
    assert.equal(caps.revisaMonetizacion({ nombre: 'Tienda de mates', tipo: 'e-commerce' }), true);
    assert.equal(caps.revisaMonetizacion({ descripcion: 'landing con pricing y checkout' }), true);
    assert.equal(caps.revisaMonetizacion({ vende: true }), true);
    assert.equal(caps.revisaMonetizacion({ features: ['carrito', 'pago'] }), true);
  });

  it('does not flag internal stuff', () => {
    assert.equal(caps.revisaMonetizacion({ nombre: 'Script interno de backup' }), false);
    assert.equal(caps.revisaMonetizacion({}), false);
    assert.equal(caps.revisaMonetizacion(null), false);
    assert.equal(caps.revisaMonetizacion('tienda'), false);
  });
});
