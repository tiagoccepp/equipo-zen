// Tests llamada grupal (groupchat.js): lógica PURA de réplicas R2 + cierre CEO.
// Sin LLM, sin I/O: decidir quién replica tras la ronda 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ROUNDS,
  MAX_VOICES,
  capTargets,
  ceoCloseTurnText,
  findMentionedAgents,
  groupRequested,
  looksLikeDisenso,
  replicaTurnText,
  selectReplicaTargets,
  shouldCeoClose
} from '../server/lib/groupchat.js';

const ROSTER = [
  { id: 'renata', name: 'Renata', role: 'ceo', aliases: ['renata', 'jefa'] },
  { id: 'bruno', name: 'Bruno', role: 'worker', aliases: ['bruno', 'front'] },
  { id: 'camila', name: 'Camila', role: 'worker', aliases: ['camila', 'qa'] },
  { id: 'nahuel', name: 'Nahuel', role: 'worker', aliases: ['nahuel'] }
];

// ── Menciones ─────────────────────────────────────────────────────────

test('mención por nombre encuentra al agente', () => {
  const found = findMentionedAgents('Camila, el CMS nos retrasa', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['camila']);
});

test('mención por alias encuentra al agente', () => {
  const found = findMentionedAgents('que lo mire front antes de publicar', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['bruno']);
});

test('orden por primera mención', () => {
  const found = findMentionedAgents('Nahuel lo despliega, pero Camila lo prueba antes', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['nahuel', 'camila']);
});

test('los que ya hablaron no se replican', () => {
  const found = findMentionedAgents('Bruno y Camila, ¿qué dicen?', ROSTER, { excludeIds: new Set(['bruno']) });
  assert.deepEqual(found.map((f) => f.agent.id), ['camila']);
});

test('sin mención no hay réplica', () => {
  assert.deepEqual(findMentionedAgents('salgo con estática y listo', ROSTER), []);
  assert.deepEqual(findMentionedAgents('', ROSTER), []);
});

// ── Grupo convocado / tope de voces ───────────────────────────────────

test('grupo convocado: groupAddressed, greeting o groupGreeting', () => {
  assert.equal(groupRequested({ groupAddressed: true }), true);
  assert.equal(groupRequested({ greeting: true }), true);
  assert.equal(groupRequested({ groupGreeting: true }), true);
  assert.equal(groupRequested({}), false);
  assert.equal(groupRequested(null), false);
});

test('capTargets: hasta 3 intacto', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }];
  const { targets: out, capped } = capTargets(targets, {});
  assert.equal(capped, 0);
  assert.deepEqual(out, targets);
});

test('capTargets: más de 3 sin grupo se recorta a 3 sin mutar', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }, { agentId: 'd' }, { agentId: 'e' }];
  const { targets: out, capped } = capTargets(targets, {});
  assert.equal(capped, 2);
  assert.deepEqual(out.map((t) => t.agentId), ['a', 'b', 'c']);
  assert.equal(targets.length, 5, 'no muta el array original');
});

test('capTargets: grupo convocado no se recorta', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }, { agentId: 'd' }];
  const { targets: out, capped } = capTargets(targets, { groupAddressed: true });
  assert.equal(capped, 0);
  assert.equal(out.length, 4);
});

// ── Selección R2 ──────────────────────────────────────────────────────

function r1(agentId, name, text) {
  return { agentId, name, text };
}

test('R2: aludidos que aún no hablaron, con citante', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila, el CMS nos retrasa una semana')],
    agents: ROSTER,
    spokenIds: ['bruno'],
    totalSpoken: 1,
    route: {}
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, 'camila');
  assert.equal(out[0].citedBy, 'Bruno');
  assert.equal(out[0].directMention, true);
});

test('R2: el que habló no se replica a sí mismo', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Bruno cree que sale hoy')],
    agents: ROSTER,
    spokenIds: ['bruno'],
    totalSpoken: 1,
    route: {}
  });
  assert.deepEqual(out, []);
});

test('R2: respeta el tope de 3 voces', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila y Nahuel, ¿lo ven?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata'],
    totalSpoken: 2,
    route: {}
  });
  // Solo queda 1 lugar (3 - 2): entra la primera mención.
  assert.deepEqual(out.map((t) => t.agentId), ['camila']);
});

test('R2: sin cupo no hay réplicas', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila, ¿lo ves?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata', 'nahuel'],
    totalSpoken: 3,
    route: {}
  });
  assert.deepEqual(out, []);
});

test('R2: grupo convocado no tiene tope', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila y Nahuel, ¿lo ven?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata', 'delfina'],
    totalSpoken: 3,
    route: { groupAddressed: true }
  });
  assert.deepEqual(out.map((t) => t.agentId), ['camila', 'nahuel']);
});

test('R2: agentes deshabilitados no replican', () => {
  const roster = ROSTER.map((a) => (a.id === 'camila' ? { ...a, enabled: false } : a));
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila, ¿lo ves?')],
    agents: roster,
    spokenIds: ['bruno'],
    totalSpoken: 1,
    route: {}
  });
  assert.deepEqual(out, []);
});

// ── Cierre CEO ────────────────────────────────────────────────────────

test('cierre CEO: solo si R2 tuvo voz y la CEO no habló', () => {
  const ceo = shouldCeoClose({ replicaSpoke: true, agents: ROSTER, spokenIds: ['bruno', 'camila'] });
  assert.equal(ceo?.id, 'renata');
  assert.equal(shouldCeoClose({ replicaSpoke: false, agents: ROSTER, spokenIds: [] }), null);
  assert.equal(
    shouldCeoClose({ replicaSpoke: true, agents: ROSTER, spokenIds: ['renata', 'bruno'] }),
    null,
    'CEO ya habló: no cierra'
  );
  assert.equal(
    shouldCeoClose({ replicaSpoke: true, agents: ROSTER.filter((a) => a.role !== 'ceo'), spokenIds: [] }),
    null,
    'sin CEO no hay cierre'
  );
});

// ── Disenso y textos ──────────────────────────────────────────────────

test('disenso explícito se clasifica, acuerdo no', () => {
  assert.equal(looksLikeDisenso('No estoy de acuerdo, eso retrasa'), true);
  assert.equal(looksLikeDisenso('Discrepo: el CMS complica'), true);
  assert.equal(looksLikeDisenso('Ojo con el plazo, me preocupa'), true);
  assert.equal(looksLikeDisenso('Dale, lo veo bien, avancemos'), false);
  assert.equal(looksLikeDisenso(''), false);
});

test('texto de réplica: le habla AL compañero, SILENCIO válido', () => {
  const out = replicaTurnText({ citedBy: 'Bruno', citedText: 'el CMS retrasa', originalText: '¿estática o CMS?' });
  assert.ok(out.includes('Bruno te habló'), 'nombra al citante');
  assert.ok(out.includes('el CMS retrasa'), 'lleva la cita');
  assert.ok(out.includes('¿estática o CMS?'), 'lleva el pedido de Tito');
  assert.ok(out.includes('SILENCIO'), 'silencio válido');
});

test('texto de cierre CEO: una línea, sin reabrir', () => {
  const out = ceoCloseTurnText({ originalText: '¿estática o CMS?' });
  assert.ok(out.includes('¿estática o CMS?'), 'lleva el pedido');
  assert.ok(out.includes('UNA línea'), 'pide una línea');
  assert.ok(out.includes('No reabras'), 'no reabre');
});

test('constantes: 2 rondas, 3 voces', () => {
  assert.equal(MAX_ROUNDS, 2);
  assert.equal(MAX_VOICES, 3);
});
