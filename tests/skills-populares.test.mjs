// TS tests (flujo-equipo-v3): 12 adapted popular skills (verbatim excerpts).
// Sources: obra/superpowers (MIT), anthropics/skills (Apache-2.0),
// vercel-labs/agent-skills (MIT). Only own frontmatter + provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listSkillNames,
  loadSkills,
  matchSkills,
  renderSkillsSection,
  skillsForRole,
  __resetSkillsCache
} from '../server/lib/skills.js';

const NUEVAS = {
  'depuracion-sistematica': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:backend', 'role:tester'] },
  tdd: { url: 'obra/superpowers', lic: 'MIT', roles: ['role:backend', 'role:tester'] },
  'verificar-antes-de-terminar': { url: 'obra/superpowers', lic: 'MIT', roles: [] },
  'pedir-revision-codigo': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:backend'] },
  'recibir-revision': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:backend'] },
  'planificar-tareas': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:orquestador'] },
  'agentes-paralelos': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:orquestador'] },
  'brainstorming-ideas': { url: 'obra/superpowers', lic: 'MIT', roles: ['role:diseno', 'role:copy'] },
  pdf: { url: 'anthropics/skills', lic: 'Apache-2.0', roles: ['role:data'] },
  xlsx: { url: 'anthropics/skills', lic: 'Apache-2.0', roles: ['role:data'] },
  docx: { url: 'anthropics/skills', lic: 'Apache-2.0', roles: ['role:copy'] },
  'react-best-practices': { url: 'vercel-labs/agent-skills', lic: 'MIT', roles: ['role:frontend'] }
};

// Roles that already exist in the repo (convention): nothing phantom.
const ROLES_REALES = new Set([
  'role:orquestador', 'role:tester', 'role:marketing', 'role:ventas',
  'role:copy', 'role:diseno', 'role:frontend', 'role:backend',
  'role:data', 'role:devops'
]);

test('the 12 popular ones load: own frontmatter + provenance + 1500 ceiling', () => {
  __resetSkillsCache();
  const names = listSkillNames();
  assert.equal(new Set(names).size, names.length, 'sin nombres duplicados');
  const skills = loadSkills();
  for (const [n, meta] of Object.entries(NUEVAS)) {
    const s = skills.find((k) => k.name === n);
    assert.ok(s, `${n} cargada`);
    assert.ok(s.description.length > 10, `${n}: description propia`);
    assert.ok(s.keywords.length >= 5, `${n}: keywords propios (${s.keywords.length})`);
    assert.ok(s.scopes.includes('chat') || s.scopes.includes('all'), `${n}: funciona hoy (chat/all)`);
    for (const r of meta.roles) {
      assert.ok(s.scopes.includes(r), `${n}: filtro ${r}`);
    }
    for (const sc of s.scopes) {
      assert.ok(sc === 'chat' || sc === 'work' || sc === 'all' || ROLES_REALES.has(sc), `${n}: scope fantasma ${sc}`);
    }
    assert.ok(s.body.length <= 1500, `${n}: cuerpo ${s.body.length}ch ≤ 1500`);
    assert.ok(s.body.includes(meta.url), `${n}: procedencia URL`);
    assert.ok(s.body.includes(`Licencia: ${meta.lic}`), `${n}: procedencia licencia`);
  }
});

test('without agent all 12 match by keywords (chat)', () => {
  __resetSkillsCache();
  const FRASES = {
    'depuracion-sistematica': 'hay un bug en producción, investigá la causa raíz del error',
    tdd: 'escribí primero el test que falla y después el código mínimo',
    'verificar-antes-de-terminar': 'verificá con evidencia antes de afirmar que funciona',
    'pedir-revision-codigo': 'antes de mergear pedí un code review del pull request',
    'recibir-revision': 'cómo respondo este feedback de review recibido',
    'planificar-tareas': 'descomponé la implementación en tareas chicas',
    'agentes-paralelos': 'delegá en paralelo a subagentes los fallos múltiples',
    'brainstorming-ideas': 'tengo una idea nueva, ayudame a aclarar el alcance del requerimiento',
    pdf: 'extraé el texto de este documento pdf con pypdf',
    xlsx: 'armá la planilla excel con fórmulas usando openpyxl',
    docx: 'escribí el informe en un documento word',
    'react-best-practices': 'optimizá el bundle de este componente react con suspense'
  };
  for (const [n, frase] of Object.entries(FRASES)) {
    const m = matchSkills(frase, { scope: 'chat' });
    assert.ok(m.some((s) => s.name === n), `${n} matchea «${frase}» (dio: ${m.map((s) => s.name).join(',')})`);
  }
});

test('skillsForRole brings the new ones by role', () => {
  __resetSkillsCache();
  assert.ok(skillsForRole('orquestador').includes('planificar-tareas'), 'orquestador→planificar');
  assert.ok(skillsForRole('orquestador').includes('agentes-paralelos'), 'orquestador→paralelos');
  assert.ok(skillsForRole('data').includes('xlsx'), 'data→xlsx');
  assert.ok(skillsForRole('data').includes('pdf'), 'data→pdf');
  assert.ok(skillsForRole('frontend').includes('react-best-practices'), 'frontend→react');
  assert.ok(skillsForRole('tester').includes('tdd'), 'tester→tdd');
  assert.ok(skillsForRole('backend').includes('depuracion-sistematica'), 'backend→depuracion');
});

test('diet D6: render with the new ones stays under the ceiling', () => {
  __resetSkillsCache();
  const out = renderSkillsSection(
    'hay un bug, escribí el test que falla, verificá con evidencia antes de afirmar y pedí code review del pull request',
    { scope: 'chat' }
  );
  assert.ok(out.length <= 1700, `skills ${out.length}ch > 1700`);
  assert.ok(out.includes('depuracion-sistematica') || out.includes('tdd') || out.includes('verificar-antes-de-terminar'), 'alguna nueva matcheó');
});
