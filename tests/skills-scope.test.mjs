// Tests skills por agente: scope extendido (role:<rol> | agent:<id>) y las
// 3 skills ejemplo (diseno-web, copy-ventas, revision-codigo).
// Sin agent: conducta histórica intacta (default-off por omisión).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listSkillNames,
  loadSkills,
  matchSkills,
  renderSkillsSection,
  skillAppliesTo,
  __resetSkillsCache
} from '../server/lib/skills.js';

const BRUNO = { id: 'bruno-x', name: 'Bruno', role: 'worker' };
const RENATA = { id: 'renata-y', name: 'Renata', role: 'ceo' };

// ── skillAppliesTo (puro, sintético) ──────────────────────────────────

test('sin agent: all/chat/work como siempre; rol/agente NO matchean', () => {
  assert.equal(skillAppliesTo({ scope: 'all', scopes: ['all'] }, 'chat'), true);
  assert.equal(skillAppliesTo({ scope: 'chat', scopes: ['chat'] }, 'chat'), true);
  assert.equal(skillAppliesTo({ scope: 'work', scopes: ['work'] }, 'chat'), false);
  assert.equal(skillAppliesTo({ scope: 'chat, role:worker', scopes: ['chat', 'role:worker'] }, 'chat'), true);
  assert.equal(skillAppliesTo({ scope: 'role:worker', scopes: ['role:worker'] }, 'chat'), false);
  assert.equal(skillAppliesTo({ scope: 'agent:bruno-x', scopes: ['agent:bruno-x'] }, 'chat'), false);
});

test('con agent: matchea role:<rol> y agent:<id>', () => {
  assert.equal(skillAppliesTo({ scope: 'role:worker', scopes: ['role:worker'] }, 'chat', BRUNO), true);
  assert.equal(skillAppliesTo({ scope: 'role:worker', scopes: ['role:worker'] }, 'chat', RENATA), false);
  assert.equal(skillAppliesTo({ scope: 'agent:bruno-x', scopes: ['agent:bruno-x'] }, 'chat', BRUNO), true);
  assert.equal(skillAppliesTo({ scope: 'agent:bruno-x', scopes: ['agent:bruno-x'] }, 'chat', RENATA), false);
  // El scope del turno sigue valiendo con agent.
  assert.equal(skillAppliesTo({ scope: 'chat', scopes: ['chat'] }, 'chat', BRUNO), true);
  assert.equal(skillAppliesTo({ scope: 'work', scopes: ['work'] }, 'chat', BRUNO), false);
});

test('case-insensitive y listas con comas', () => {
  const skill = { scope: 'chat, role:Worker', scopes: ['chat', 'role:worker'] };
  assert.equal(skillAppliesTo(skill, 'chat', { id: 'X', role: 'WORKER' }), true);
  assert.equal(skillAppliesTo(
    { scope: 'agent:Bruno-X', scopes: ['agent:bruno-x'] }, 'chat', { id: 'BRUNO-x', role: 'worker' }
  ), true);
});

test('entradas desconocidas se ignoran; legacy sin scopes usa scope', () => {
  assert.equal(skillAppliesTo({ scope: 'nada', scopes: ['nada'] }, 'chat', BRUNO), false);
  assert.equal(skillAppliesTo({ scope: 'chat' }, 'chat'), true, 'fallback a scope plano');
  assert.equal(skillAppliesTo({ scope: 'chat', scopes: [] }, 'chat'), true, 'scopes vacío usa scope');
});

// ── Directorio real ───────────────────────────────────────────────────

test('las 3 skills ejemplo cargan con scope chat+roles reales', () => {
  __resetSkillsCache();
  const ESPERADOS = {
    'diseno-web': ['role:diseno', 'role:frontend'],
    'copy-ventas': ['role:copy', 'role:marketing', 'role:ventas'],
    'revision-codigo': ['role:backend', 'role:frontend', 'role:tester', 'role:data', 'role:devops']
  };
  const names = listSkillNames();
  for (const n of Object.keys(ESPERADOS)) {
    assert.ok(names.includes(n), `${n} cargada`);
  }
  const skills = loadSkills();
  for (const [n, roles] of Object.entries(ESPERADOS)) {
    const s = skills.find((k) => k.name === n);
    assert.ok(s.scopes.includes('chat'), `${n}: funciona hoy (chat)`);
    for (const r of roles) {
      assert.ok(s.scopes.includes(r), `${n}: filtro ${r}`);
    }
    assert.ok(!s.scopes.includes('role:worker'), `${n}: sin rol fantasma worker`);
    assert.ok(s.body.length <= 1500, `${n}: cuerpo ${s.body.length}ch ≤ 1500`);
  }
});

test('sin agent las nuevas matchean por keywords (caller actual intacto)', () => {
  __resetSkillsCache();
  const d = matchSkills('hay que definir el layout, la paleta y el responsive', { scope: 'chat' });
  assert.ok(d.some((s) => s.name === 'diseno-web'), 'diseno-web por keywords');
  const c = matchSkills('escribí el titular con un llamado a la acción persuasivo', { scope: 'chat' });
  assert.ok(c.some((s) => s.name === 'copy-ventas'), 'copy-ventas por keywords');
  const r = matchSkills('revisá este código que tiene un bug y hay que refactorizar', { scope: 'chat' });
  assert.ok(r.some((s) => s.name === 'revision-codigo'), 'revision-codigo por keywords');
});

// ── Fixture aislado: skill solo-rol ───────────────────────────────────

test('skill solo-rol: invisible sin agent, visible con su rol', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  writeFileSync(join(dir, 'solo-jefes.md'), [
    '---',
    'name: solo-jefes',
    'description: Coordinar prioridades del equipo.',
    'keywords: coordinar, prioridades, repartir tareas jefatura',
    'scope: role:ceo',
    '---',
    '',
    'Coordiná diciendo quién hace qué.',
    ''
  ].join('\n'));
  __resetSkillsCache();
  loadSkills(dir); // precarga el caché con el fixture
  try {
    const sinAgent = matchSkills('hay que coordinar prioridades y repartir tareas', { scope: 'chat' });
    assert.ok(!sinAgent.some((s) => s.name === 'solo-jefes'), 'sin agent no matchea');
    const ceo = matchSkills('hay que coordinar prioridades y repartir tareas', { scope: 'chat', agent: RENATA });
    assert.ok(ceo.some((s) => s.name === 'solo-jefes'), 'con CEO matchea');
    const worker = matchSkills('hay que coordinar prioridades y repartir tareas', { scope: 'chat', agent: BRUNO });
    assert.ok(!worker.some((s) => s.name === 'solo-jefes'), 'con worker no matchea');
  } finally {
    __resetSkillsCache(); // el siguiente loadSkills relee el dir real
  }
});

// ── Dieta ─────────────────────────────────────────────────────────────

test('dieta D6: render con agent no pasa el techo', () => {
  __resetSkillsCache();
  const out = renderSkillsSection(
    'definí el layout y la paleta responsive y escribí el titular persuasivo con llamada a la acción',
    { scope: 'chat', agent: BRUNO }
  );
  assert.ok(out.length <= 1700, `skills ${out.length}ch > 1700`);
  assert.ok(out.includes('diseno-web') || out.includes('copy-ventas'), 'alguna ejemplo matcheó');
});
