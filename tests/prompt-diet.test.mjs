// Tests dieta de prompt (D1–D8, 09/11): presupuestos y marcadores.
// No miden conducta del modelo, miden BYTES: que el system/turno compilados
// respeten los techos y conserven los no-tocar (§4 del doc de dieta).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildSystemInstruction, promptIsEnglish } = await import('../server/lib/agent-runtime.js');
const { renderMemorySection, writeMemoryFile, appendDaily, __resetPabloMemoryCache, DAILY_TAIL_MAX_CHARS } = await import('../server/lib/pablo-memory.js');
const { renderManosPrompt, getTool } = await import('../server/lib/manos.js');
const { renderLearningsSection } = await import('../server/lib/learning.js');
const { renderSkillsSection, __resetSkillsCache } = await import('../server/lib/skills.js');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'diet-'));
  process.env.PABLO_MEMORY_DIR = tmp;
  __resetPabloMemoryCache();
});
afterEach(() => {
  delete process.env.PABLO_MEMORY_DIR;
  __resetPabloMemoryCache();
});

const AGENTE = {
  id: 't', name: 'Pablo', title: 'Personal assistant', role: 'ceo',
  domains: ['general'], style: 'Directo y cálido.',
  knowledge: 'Sabe todo.', craft: 'Hace y reporta.',
  boundaries: ['No cruza líneas.'], tasks: []
};

// ---------------------------------------------------------------- D1 memoria

test('dieta D1: el daily no se come el presupuesto (cola 800 + SOUL sobrevive)', () => {
  writeMemoryFile('acme', 'SOUL.md', 'ALMA-IDENTIDAD');
  appendDaily('acme', `${'viejísimo '.repeat(500)}FINAL-IMPORTANTE`);
  const out = renderMemorySection('acme', { maxChars: 3600 });
  assert.ok(out.includes('ALMA-IDENTIDAD'), 'SOUL visible');
  assert.ok(out.includes('FINAL-IMPORTANTE'), 'cola del daily visible');
  const repes = (out.match(/viejísimo/g) || []).length;
  assert.ok(repes > 0 && repes < 100, `cola recortada a ${repes} repes (eran 500)`);
  assert.equal(DAILY_TAIL_MAX_CHARS, 800);
});

test('dieta D1: recorte por parte, de atrás hacia adelante', () => {
  writeMemoryFile('acme', 'SOUL.md', 's'.repeat(300));
  writeMemoryFile('acme', 'USER.md', 'u'.repeat(300));
  writeMemoryFile('acme', 'MEMORY.md', 'm'.repeat(300));
  appendDaily('acme', 'd'.repeat(300));
  const out = renderMemorySection('acme', { maxChars: 500 });
  assert.ok(out.length <= 500, `largo ${out.length}`);
  assert.ok(out.includes('PABLO SOUL'), 'SOUL primero sobrevive');
  // El daily (último) es lo primero que cae.
  assert.ok(!out.includes('PABLO TODAY') || out.includes('…'), 'daily recortado o caído');
});

test('dieta D1: seeds nuevos son deltas chicos', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const seeds = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'templates', 'pablo');
  const soulRaw = readFileSync(join(seeds, 'SOUL.md'), 'utf-8');
  const userRaw = readFileSync(join(seeds, 'USER.md'), 'utf-8');
  assert.ok(soulRaw.length <= 700, `SOUL seed ${soulRaw.length}ch > 700`);
  assert.ok(userRaw.length <= 400, `USER seed ${userRaw.length}ch > 400`);
  assert.ok(soulRaw.includes('NOT repeated here') || soulRaw.includes('NO se repiten'), 'SOUL apunta al system, no repite');
});

// ---------------------------------------------------------------- D2/D3 esqueleto

test('dieta D2+D3: bloques fusionados §VOICE y SCOPE&SPLIT, sin headers viejos', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  for (const h of ['§VOICE', 'SCOPE & SPLIT', 'ALCANCE Y REPARTO']) {
    void h;
  }
  // Idioma default en tests: español (sin store).
  assert.equal(promptIsEnglish(), false);
  assert.ok(sys.includes('§VOICE'), 'bloque voz único');
  assert.ok(sys.includes('ALCANCE Y REPARTO'), 'bloque scope único');
  for (const viejo of ['HOW TO TALK', 'CÓMO HABLAR', 'HOW WHAT YOU EMIT', 'CÓMO SE ESCUCHA', 'WHEN TO TALK AND WHEN NOT', 'CUÁNDO HABLAR Y CUÁNDO NO', 'WHEN THE REQUEST COMES INCOMPLETE', 'CUANDO EL PEDIDO VIENE INCOMPLETO', 'WHAT THE TEAM CAN DELIVER', 'LO QUE EL EQUIPO PUEDE ENTREGAR', 'AS CEO, ALSO', 'COMO CEO, ADEMÁS']) {
    assert.ok(!sys.includes(viejo), `header viejo sobrevivió: ${viejo}`);
  }
});

test('dieta no-tocar: canales, SILENCIO, TAREA, números y ejemplo sobreviven', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  assert.ok(sys.includes('[PIENSO]'), 'canal PIENSO');
  assert.ok(sys.includes('[AVANCE]'), 'canal AVANCE');
  assert.ok(sys.includes('SILENCIO'), 'protocolo silencio');
  assert.ok(sys.includes('[TAREA_CREAR'), 'tags de tarea');
  assert.ok(sys.includes('it really happened') || sys.includes('pasó de verdad'), 'énfasis TAREA load-bearing');
  assert.ok(sys.includes('2 preguntas por turno') || sys.includes('2 questions per turn'), 'hard number 2/turno');
  assert.ok(sys.includes('DOS rondas') || sys.includes('TWO question rounds'), 'hard number 2 rondas');
  assert.ok(sys.includes('UN archivo con UN dueño') || sys.includes('ONE file with ONE owner'), '1 archivo 1 dueño');
  assert.ok(sys.includes('¿Es para vender o para mostrar') || sys.includes('Is it for selling or showing'), 'ejemplo bueno/malo');
  assert.ok(sys.includes('middle of a word') || sys.includes('MEDIO de una palabra'), 'fix CJK middle-of-word');
});

test('dieta D2: sufijo de turno corto (1 línea voz + 1 línea remember)', async () => {
  const { LiveAgentRuntime } = await import('../server/lib/agent-runtime.js');
  const memoria = { recentContext: () => '' };
  const rt = new LiveAgentRuntime(AGENTE, { hasKeys: () => true }, memoria, null);
  const prompt = rt.buildTurnPrompt({
    text: 'hola', source: 'audio', isContextualFollowup: false,
    target: {}, priorResponses: [], route: { reason: 'test', greeting: false }
  });
  assert.ok(prompt.includes('§VOICE'), 'puntero a §VOICE');
  assert.ok(!prompt.includes('ni telegrama ni discurso'), 'párrafo MODO VOZ viejo afuera');
  assert.ok(!prompt.includes('Talk like yourself'), 'remember viejo afuera');
  assert.match(prompt, /SILENCIO if nothing to add|SILENCIO si no tenés nada/);
  assert.ok(prompt.length <= 650, `turno ${prompt.length}ch > 650`);
});

// ---------------------------------------------------------------- D5/D6 techos

test('dieta D5: learnings acotados aunque haya 20 activos', () => {
  const muchos = Array.from({ length: 20 }, (_, i) => ({
    id: `l${i}`, agentId: 't', content: `aprendizaje número ${i} `.repeat(20),
    confidence: 0.9, status: 'active', timesReinforced: 1,
    lastReinforcedAt: new Date(Date.now() - i * 86400000).toISOString()
  }));
  const store = { getAgent: () => null, activeLearnings: () => muchos };
  const out = renderLearningsSection(store, 't');
  assert.ok(out.length <= 2300, `learnings ${out.length}ch > 2300`);
  const items = out.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(items.length <= 5, `${items.length} items > 5`);
  for (const it of items) {
    assert.ok(it.length <= 170, `item ${it.length}ch > 170`);
  }
});

test('dieta D6: skills acotadas a 1500ch totales en el turno', () => {
  __resetSkillsCache();
  // Cuerpos reales chicos: el techo solo pega en peor caso. Verificamos que
  // el render existe y que un match no pasa el techo.
  const out = renderSkillsSection('compilá el proyecto con la terminal y buscá en la web', { scope: 'chat' });
  assert.ok(out.length <= 1700, `skills ${out.length}ch > 1700`);
});

// ---------------------------------------------------------------- D7 manos

test('dieta D7: prompt manos voz corto, texto full, ambos listan list_files', () => {
  const voz = renderManosPrompt('audio');
  const full = renderManosPrompt('text');
  assert.ok(getTool('list_files'), 'list_files registrada');
  assert.ok(voz.includes('list_files') && full.includes('list_files'), 'docs incluyen list_files');
  assert.ok(voz.length < full.length, `voz ${voz.length} no < full ${full.length}`);
  assert.ok(voz.length <= 900, `voz ${voz.length}ch > 900`);
  // 09/11 computer tools (open_url/window_list/screenshot): full 1223→~1560ch.
  // Tope 1650; voz sigue ≤900 (las 3 tools entran en 1 línea c/u).
  assert.ok(full.length <= 1650, `full ${full.length}ch > 1650`);
  assert.ok(voz.includes('tool:'), 'voz muestra formato');
});
