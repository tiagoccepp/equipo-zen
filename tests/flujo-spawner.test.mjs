// Track B: spawner + matriz de capabilities. Hermético: workspace en tmpdir
// vía PABLO_MEMORY_DIR; sin red, sin DISPLAY, sin MCP.
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

describe('matriz íntegra: toda capability resuelve a real', () => {
  it('integrity vacío contra el repo real', () => {
    const fantasmas = caps.integrityCheck();
    assert.deepEqual(fantasmas, [], `capabilities fantasma: ${JSON.stringify(fantasmas)}`);
  });

  it('cada capability desconocida no resuelve', () => {
    const r = caps.resolveCapability('teletransportacion');
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /desconocida/);
  });

  it('detecta tool fantasma si el inventario no la trae', () => {
    const r = caps.resolveCapability('exec', { tools: [], skills: ['terminal'] });
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.includes('run_cmd')));
  });

  it('todos los roles tienen base + propias', () => {
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

describe('no-duplicados: equipo actual manda', () => {
  it('miembro que cubre → responde existente', () => {
    const r = spawner.spawnRequest(
      { rol: 'backend', porque: 'falta API', capabilities: ['exec'] },
      { equipo: [{ id: 'be-1', role: 'backend' }] }
    );
    assert.equal(r.created, false);
    assert.equal(r.existing, 'backend');
    assert.equal(r.agentId, 'be-1');
    assert.match(r.motivo, /cero duplicados/);
  });

  it('rol conocido sin miembro → crea', () => {
    const r = spawner.spawnRequest(
      { rol: 'backend', porque: 'falta API' },
      { equipo: [{ id: 'fe-1', role: 'frontend' }] }
    );
    assert.equal(r.created, true);
    assert.equal(r.agent.role, 'backend');
  });

  it('rol desconocido cubierto por existente → deriva', () => {
    const r = spawner.spawnRequest(
      { rol: 'ninja', porque: 'algo', capabilities: ['exec'] },
      { equipo: [{ id: 'be-1', role: 'backend' }] }
    );
    assert.equal(r.created, false);
    assert.equal(r.existing, 'backend');
  });

  it('rolQueCubre: subconjunto de matriz', () => {
    assert.equal(caps.rolQueCubre(['exec', 'tests']), 'backend');
    assert.equal(caps.rolQueCubre(['no-existe']), null);
    assert.equal(caps.rolQueCubre([]), null);
  });
});

describe('spawn crea ficha + skills + tools', () => {
  it('ficha en workspace + skills/tools concretas', () => {
    const r = spawner.spawnRequest(
      { rol: 'marketing', porque: 'lanzamiento del producto' },
      { companySlug: 'acme', equipo: [] }
    );
    assert.equal(r.created, true);
    assert.ok(r.ficha && r.ficha.includes('acme'), `sin ficha: ${r.ficha}`);
    assert.ok(r.capabilities.includes('outreach-lectura'));
    assert.ok(r.skills.includes('marketing'), `skills: ${r.skills.join(',')}`);
    assert.ok(r.tools.includes('fetch_url'), `tools: ${r.tools.join(',')}`);
    // La ficha existe y es seed de marketing.
    const frag = conv.renderAgentConventions('acme', r.agent);
    assert.match(frag, /MARKETING/);
    // Log registra.
    assert.equal(spawner.spawnLog().length, 1);
  });

  it('skillsForRole trae las nuevas por scope', () => {
    assert.ok(skills.skillsForRole('marketing').includes('marketing'));
    assert.ok(skills.skillsForRole('ventas').includes('ventas'));
    assert.ok(skills.skillsForRole('tester').includes('pruebas'));
    assert.ok(skills.skillsForRole('orquestador').includes('plan-dispatch'));
  });
});

describe('rechazo con motivo', () => {
  it('sin porqué → rechazo', () => {
    const r = spawner.spawnRequest({ rol: 'backend' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    assert.match(r.motivo, /porqu/);
  });

  it('pedido vacío → rechazo', () => {
    const r = spawner.spawnRequest({ porque: 'x' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    const v = spawner.spawnRequest({}, {});
    assert.equal(v.rejected, true);
  });

  it('rol desconocido sin capabilities → rechazo con roles válidos', () => {
    const r = spawner.spawnRequest({ rol: 'astronauta', porque: 'sueño' }, {});
    assert.equal(r.created, false);
    assert.equal(r.rejected, true);
    assert.match(r.motivo, /backend/);
  });
});

describe('revisaMonetizacion (pura, sin IO)', () => {
  it('detecta potencial beneficio', () => {
    assert.equal(caps.revisaMonetizacion({ nombre: 'Tienda de mates', tipo: 'e-commerce' }), true);
    assert.equal(caps.revisaMonetizacion({ descripcion: 'landing con pricing y checkout' }), true);
    assert.equal(caps.revisaMonetizacion({ vende: true }), true);
    assert.equal(caps.revisaMonetizacion({ features: ['carrito', 'pago'] }), true);
  });

  it('no marca lo interno', () => {
    assert.equal(caps.revisaMonetizacion({ nombre: 'Script interno de backup' }), false);
    assert.equal(caps.revisaMonetizacion({}), false);
    assert.equal(caps.revisaMonetizacion(null), false);
    assert.equal(caps.revisaMonetizacion('tienda'), false);
  });
});
