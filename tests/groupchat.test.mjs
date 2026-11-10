// Group-call tests (groupchat.js): PURE R2-reply + CEO-close logic.
// No LLM, no I/O: decide who replies after round 1.
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

// ── Mentions ─────────────────────────────────────────────────────────

test('mention by name finds the agent', () => {
  const found = findMentionedAgents('Camila, el CMS nos retrasa', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['camila']);
});

test('mention by alias finds the agent', () => {
  const found = findMentionedAgents('que lo mire front antes de publicar', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['bruno']);
});

test('ordered by first mention', () => {
  const found = findMentionedAgents('Nahuel lo despliega, pero Camila lo prueba antes', ROSTER);
  assert.deepEqual(found.map((f) => f.agent.id), ['nahuel', 'camila']);
});

test('those who already spoke do not reply', () => {
  const found = findMentionedAgents('Bruno y Camila, ¿qué dicen?', ROSTER, { excludeIds: new Set(['bruno']) });
  assert.deepEqual(found.map((f) => f.agent.id), ['camila']);
});

test('no mention, no reply', () => {
  assert.deepEqual(findMentionedAgents('salgo con estática y listo', ROSTER), []);
  assert.deepEqual(findMentionedAgents('', ROSTER), []);
});

// ── Summoned group / voice cap ───────────────────────────────────

test('summoned group: groupAddressed, greeting or groupGreeting', () => {
  assert.equal(groupRequested({ groupAddressed: true }), true);
  assert.equal(groupRequested({ greeting: true }), true);
  assert.equal(groupRequested({ groupGreeting: true }), true);
  assert.equal(groupRequested({}), false);
  assert.equal(groupRequested(null), false);
});

test('capTargets: up to 3 untouched', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }];
  const { targets: out, capped } = capTargets(targets, {});
  assert.equal(capped, 0);
  assert.deepEqual(out, targets);
});

test('capTargets: more than 3 without group is trimmed to 3 without mutating', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }, { agentId: 'd' }, { agentId: 'e' }];
  const { targets: out, capped } = capTargets(targets, {});
  assert.equal(capped, 2);
  assert.deepEqual(out.map((t) => t.agentId), ['a', 'b', 'c']);
  assert.equal(targets.length, 5, 'no muta el array original');
});

test('capTargets: summoned group is not trimmed', () => {
  const targets = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }, { agentId: 'd' }];
  const { targets: out, capped } = capTargets(targets, { groupAddressed: true });
  assert.equal(capped, 0);
  assert.equal(out.length, 4);
});

// ── R2 selection ──────────────────────────────────────────────────────

function r1(agentId, name, text) {
  return { agentId, name, text };
}

test('R2: mentioned ones who have not spoken yet, with citer', () => {
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

test('R2: one who spoke does not reply to themselves', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Bruno cree que sale hoy')],
    agents: ROSTER,
    spokenIds: ['bruno'],
    totalSpoken: 1,
    route: {}
  });
  assert.deepEqual(out, []);
});

test('R2: respects the 3-voice cap', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila y Nahuel, ¿lo ven?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata'],
    totalSpoken: 2,
    route: {}
  });
  // Only 1 slot left (3 - 2): the first mention gets in.
  assert.deepEqual(out.map((t) => t.agentId), ['camila']);
});

test('R2: no slots, no replies', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila, ¿lo ves?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata', 'nahuel'],
    totalSpoken: 3,
    route: {}
  });
  assert.deepEqual(out, []);
});

test('R2: summoned group has no cap', () => {
  const out = selectReplicaTargets({
    responsesR1: [r1('bruno', 'Bruno', 'Camila y Nahuel, ¿lo ven?')],
    agents: ROSTER,
    spokenIds: ['bruno', 'renata', 'delfina'],
    totalSpoken: 3,
    route: { groupAddressed: true }
  });
  assert.deepEqual(out.map((t) => t.agentId), ['camila', 'nahuel']);
});

test('R2: disabled agents do not reply', () => {
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

// ── CEO close ────────────────────────────────────────────────────────

test('CEO close: only if R2 had a voice and the CEO did not speak', () => {
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

// ── Dissent and texts ──────────────────────────────────────────────────

test('explicit dissent is classified, agreement is not', () => {
  assert.equal(looksLikeDisenso('No estoy de acuerdo, eso retrasa'), true);
  assert.equal(looksLikeDisenso('Discrepo: el CMS complica'), true);
  assert.equal(looksLikeDisenso('Ojo con el plazo, me preocupa'), true);
  assert.equal(looksLikeDisenso('Dale, lo veo bien, avancemos'), false);
  assert.equal(looksLikeDisenso(''), false);
});

test('reply text: talks TO the peer, SILENCIO valid', () => {
  const out = replicaTurnText({ citedBy: 'Bruno', citedText: 'el CMS retrasa', originalText: '¿estática o CMS?' });
  assert.ok(out.includes('Bruno te habló'), 'nombra al citante');
  assert.ok(out.includes('el CMS retrasa'), 'lleva la cita');
  assert.ok(out.includes('¿estática o CMS?'), 'lleva el pedido de Tito');
  assert.ok(out.includes('SILENCIO'), 'silencio válido');
});

test('CEO close text: one line, no reopening', () => {
  const out = ceoCloseTurnText({ originalText: '¿estática o CMS?' });
  assert.ok(out.includes('¿estática o CMS?'), 'lleva el pedido');
  assert.ok(out.includes('UNA línea'), 'pide una línea');
  assert.ok(out.includes('No reabras'), 'no reabre');
});

test('constants: 2 rounds, 3 voices', () => {
  assert.equal(MAX_ROUNDS, 2);
  assert.equal(MAX_VOICES, 3);
});
