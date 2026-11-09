// Tests convenciones por agente (agent-conventions.js): AGENTS.md propio por
// agente con seed por rol, y fragmento corto para SU system prompt.
// Disco real pero en tmp (PABLO_MEMORY_DIR), como pablo-memory en dieta.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'conv-'));
process.env.PABLO_MEMORY_DIR = tmp;

const {
  CONVENTIONS_MAX_CHARS,
  CONVENTIONS_MAX_LINES,
  agentDirFor,
  conventionsPathFor,
  ensureAgentConventions,
  renderAgentConventions,
  seedForRole,
  __resetConventionsCache
} = await import('../server/lib/agent-conventions.js');

afterEach(() => {
  __resetConventionsCache();
});

const BRUNO = { id: 'bruno-x', name: 'Bruno', role: 'worker' };

// ── Seeds ─────────────────────────────────────────────────────────────

test('seed por rol menciona el nombre y respeta el techo', () => {
  for (const role of ['ceo', 'worker', 'contratista']) {
    const seed = seedForRole(role, 'Bruno');
    assert.ok(seed.includes('Bruno'), `${role}: lleva el nombre`);
    assert.ok(seed.split('\n').length <= CONVENTIONS_MAX_LINES, `${role}: ≤${CONVENTIONS_MAX_LINES} líneas`);
    assert.ok(seed.length <= CONVENTIONS_MAX_CHARS, `${role}: ${seed.length}ch ≤ ${CONVENTIONS_MAX_CHARS}`);
  }
});

test('rol desconocido cae a worker', () => {
  assert.equal(seedForRole('ninja', 'X'), seedForRole('worker', 'X'));
  assert.equal(seedForRole('', 'X'), seedForRole('worker', 'X'));
});

test('cada rol tiene su oficio', () => {
  assert.match(seedForRole('ceo', 'R'), /coordin/i);
  assert.match(seedForRole('worker', 'B'), /produc/i);
  assert.match(seedForRole('contratista', 'H'), /refin/i);
});

// ── Creación ──────────────────────────────────────────────────────────

test('ensure crea el AGENTS.md si falta, con seed del rol', () => {
  const res = ensureAgentConventions('acme', BRUNO);
  assert.equal(res.created, true);
  assert.equal(res.path, conventionsPathFor('acme', BRUNO.id));
  const raw = readFileSync(res.path, 'utf-8');
  assert.ok(raw.includes('Bruno'), 'seed con nombre');
  assert.ok(raw.includes('Produc'), 'seed de worker');
});

test('ensure no sobrescribe el existente', () => {
  ensureAgentConventions('acme', BRUNO);
  const abs = conventionsPathFor('acme', BRUNO.id);
  writeFileSync(abs, '# Mío\n', 'utf-8');
  const res = ensureAgentConventions('acme', BRUNO);
  assert.equal(res.created, false);
  assert.equal(readFileSync(abs, 'utf-8'), '# Mío\n');
});

test('slugs inválidos no crean nada ni lanzan', () => {
  assert.deepEqual(ensureAgentConventions('../x', BRUNO), { created: false, path: null });
  assert.deepEqual(ensureAgentConventions('acme', { id: '../../etc' }), { created: false, path: null });
  assert.deepEqual(ensureAgentConventions('acme', {}), { created: false, path: null });
  assert.equal(renderAgentConventions('acme', {}), '');
  assert.equal(renderAgentConventions('../x', BRUNO), '');
});

// ── Render ────────────────────────────────────────────────────────────

test('render: sin archivo devuelve vacío (el turno sigue igual)', () => {
  assert.equal(renderAgentConventions('nadie', { id: 'fantasma', name: 'Fan' }), '');
});

test('render: header propio + contenido, dentro de dieta', () => {
  ensureAgentConventions('acme2', BRUNO);
  const out = renderAgentConventions('acme2', BRUNO);
  assert.ok(out.includes('CONVENCIONES DE BRUNO'), 'header con nombre');
  assert.ok(out.includes('solo tuyas'), 'marca de privado');
  assert.ok(out.length <= CONVENTIONS_MAX_CHARS + 80, `${out.length}ch dentro de dieta`);
});

test('render: recorta a 15 líneas y 900ch aunque el archivo sea largo', () => {
  const dir = agentDirFor('acme3', BRUNO.id);
  mkdirSync(dir, { recursive: true });
  const largo = Array.from({ length: 40 }, (_, i) => `línea ${i} con bastante relleno para que quince líneas pasen holgadas el techo`).join('\n');
  writeFileSync(join(dir, 'AGENTS.md'), largo, 'utf-8');
  const out = renderAgentConventions('acme3', BRUNO);
  const body = out.split('\n').slice(1).join('\n');
  assert.ok(body.split('\n').length <= CONVENTIONS_MAX_LINES, '≤15 líneas de cuerpo');
  assert.ok(body.length <= CONVENTIONS_MAX_CHARS, `${body.length}ch ≤ ${CONVENTIONS_MAX_CHARS}`);
  assert.ok(out.endsWith('…'), 'truncado marcado');
});

test('caché 30s: relectura pega caché, reset la invalida', () => {
  ensureAgentConventions('acme4', BRUNO);
  const abs = conventionsPathFor('acme4', BRUNO.id);
  const primero = renderAgentConventions('acme4', BRUNO);
  writeFileSync(abs, '# Nuevo contenido del agente\n', 'utf-8');
  assert.equal(renderAgentConventions('acme4', BRUNO), primero, 'caché vigente');
  __resetConventionsCache();
  assert.ok(renderAgentConventions('acme4', BRUNO).includes('Nuevo contenido'), 'tras reset relee');
});
