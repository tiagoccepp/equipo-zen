// Mesa redonda: núcleo puro (política de turnos, cortes, resumen, prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RT_DEFAULTS,
  RT_LIMITS,
  validateRoundtableConfig,
  createRoundtable,
  turnOrder,
  runRoundtable,
  summarizeRoundtable,
  buildAgentPrompt,
} from '../server/lib/roundtable.js';

const AGENTS = [
  { id: 'ana', name: 'Ana', role: 'producto' },
  { id: 'beto', name: 'Beto', role: 'ingeniería' },
  { id: 'carla', name: 'Carla', role: 'diseño' },
];

function makeRt(overrides = {}) {
  return createRoundtable({ agents: AGENTS, topic: '¿Qué priorizamos?', ...overrides });
}

function relleno(seed, length = 120) {
  const base = `${seed} `;
  return (base.repeat(Math.ceil(length / base.length))).slice(0, length);
}

// ── Validación ──────────────────────────────────────────────────────────────

test('validación: sin agentes falla', () => {
  const { ok, errors } = validateRoundtableConfig({ topic: 't' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('2 agentes')), errors.join('|'));
});

test('validación: un solo agente falla', () => {
  const { ok, errors } = validateRoundtableConfig({ agents: [AGENTS[0]], topic: 't' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('2 agentes')), errors.join('|'));
});

test('validación: topic vacío falla', () => {
  const { ok, errors } = validateRoundtableConfig({ agents: AGENTS, topic: '   ' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('topic')), errors.join('|'));
});

test('validación: agentes sin id/name o duplicados fallan', () => {
  const sinId = validateRoundtableConfig({ agents: [{ name: 'A' }, { id: 'b', name: 'B' }], topic: 't' });
  assert.equal(sinId.ok, false);
  assert.ok(sinId.errors.some((e) => e.includes('falta id')), sinId.errors.join('|'));

  const dupId = validateRoundtableConfig({
    agents: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { id: 'c', name: 'C' }],
    topic: 't',
  });
  assert.equal(dupId.ok, false);
  assert.ok(dupId.errors.some((e) => e.includes('id duplicado')), dupId.errors.join('|'));

  const dupName = validateRoundtableConfig({
    agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'a' }],
    topic: 't',
  });
  assert.equal(dupName.ok, false);
  assert.ok(dupName.errors.some((e) => e.includes('name duplicado')), dupName.errors.join('|'));
});

test('validación: maxTurns fuera de 2..20 falla', () => {
  for (const maxTurns of [1, 21, 2.5, '6']) {
    const { ok, errors } = validateRoundtableConfig({ agents: AGENTS, topic: 't', maxTurns });
    assert.equal(ok, false, `maxTurns=${maxTurns} debería fallar`);
    assert.ok(errors.some((e) => e.includes('maxTurns')), errors.join('|'));
  }
});

test('validación: maxCharsPerTurn fuera de 80..2000 falla', () => {
  for (const maxCharsPerTurn of [79, 2001, 0]) {
    const { ok, errors } = validateRoundtableConfig({ agents: AGENTS, topic: 't', maxCharsPerTurn });
    assert.equal(ok, false, `maxCharsPerTurn=${maxCharsPerTurn} debería fallar`);
    assert.ok(errors.some((e) => e.includes('maxCharsPerTurn')), errors.join('|'));
  }
});

test('validación: config válida con defaults implícitos pasa', () => {
  const { ok, errors } = validateRoundtableConfig({ agents: AGENTS, topic: '¿Qué priorizamos?' });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

// ── createRoundtable ────────────────────────────────────────────────────────

test('createRoundtable aplica defaults y normaliza roles', () => {
  const rt = createRoundtable({
    agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    topic: '  Tema   con espacios  ',
  });
  assert.equal(rt.config.topic, 'Tema con espacios');
  assert.equal(rt.config.maxTurns, RT_DEFAULTS.maxTurns);
  assert.equal(rt.config.maxCharsPerTurn, RT_DEFAULTS.maxCharsPerTurn);
  assert.equal(rt.config.maxTotalChars, RT_DEFAULTS.maxTotalChars);
  assert.deepEqual(rt.config.speakerWeights, {});
  assert.equal(rt.config.agents[0].role, 'generalista');
});

test('createRoundtable tira error con config inválida', () => {
  assert.throws(
    () => createRoundtable({ agents: [AGENTS[0]], topic: 't' }),
    (error) => error.code === 'ROUNDTABLE_CONFIG' && Array.isArray(error.errors),
  );
});

// ── Política de turnos ─────────────────────────────────────────────────────

test('3 agentes × 3 turnos en orden round-robin', async () => {
  const seen = [];
  const result = await runRoundtable(makeRt({ maxTurns: 3 }), {
    callAgent: async ({ agent, turn }) => {
      seen.push(`${turn}:${agent.id}`);
      return { text: `${agent.name} aporta en ${turn}` };
    },
  });
  assert.deepEqual(seen, ['1:ana', '2:beto', '3:carla']);
  assert.deepEqual(result.transcript.map((t) => t.agentId), ['ana', 'beto', 'carla']);
  assert.deepEqual(result.transcript.map((t) => t.index), [1, 2, 3]);
  assert.equal(result.stopped.reason, 'max_turns');
  assert.equal(result.stopped.turn, 3);
  assert.equal(result.chars, result.transcript.reduce((sum, t) => sum + t.text.length, 0));
  assert.deepEqual(result.errors, []);
});

test('speakerWeights ordena la ronda por peso (sin dar turnos extra)', () => {
  const rt = makeRt({ speakerWeights: { carla: 10, ana: 2 } });
  assert.deepEqual(turnOrder(rt.config).map((a) => a.id), ['carla', 'ana', 'beto']);
});

test('speakerWeights cambia el orden visible de las intervenciones', async () => {
  const rt = makeRt({ maxTurns: 3, speakerWeights: { carla: 10, ana: 2 } });
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => ({ text: `${agent.name} ${turn}` }),
  });
  assert.deepEqual(result.transcript.map((t) => t.name), ['Carla', 'Ana', 'Beto']);
});

test('maxTurns se respeta con 2 agentes', async () => {
  const rt = makeRt({
    agents: [AGENTS[0], AGENTS[1]],
    maxTurns: 4,
  });
  let calls = 0;
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => {
      calls += 1;
      return { text: `${agent.name} ${turn}` };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.transcript.length, 4);
  assert.equal(result.stopped.reason, 'max_turns');
  assert.equal(result.stopped.turn, 4);
});

test('done:true corta antes de maxTurns y deja la conclusión en el último turno', async () => {
  const rt = makeRt({ maxTurns: 10 });
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => ({
      text: turn === 2 ? 'Conclusión: priorizamos el onboarding.' : `${agent.name} ${turn}`,
      done: turn === 2,
    }),
  });
  assert.equal(result.transcript.length, 2);
  assert.equal(result.stopped.reason, 'done');
  assert.equal(result.stopped.turn, 2);
  assert.equal(result.transcript.at(-1).text, 'Conclusión: priorizamos el onboarding.');
});

test('3 skips consecutivos cortan con reason skipped', async () => {
  const rt = makeRt({ agents: [AGENTS[0], AGENTS[1]], maxTurns: 8 });
  const result = await runRoundtable(rt, {
    callAgent: async () => ({ skip: true }),
  });
  assert.equal(result.stopped.reason, 'skipped');
  assert.equal(result.stopped.turn, RT_LIMITS.maxConsecutiveSkips);
  assert.equal(result.transcript.length, 0);
});

test('texto vacío / idéntico del mismo agente saltea el turno', async () => {
  const rt = makeRt({ agents: [AGENTS[0], AGENTS[1]], maxTurns: 4 });
  const guion = { 1: 'Ana uno', 2: 'Beto uno', 3: 'Ana uno', 4: 'Beto dos' };
  const result = await runRoundtable(rt, {
    callAgent: async ({ turn }) => ({ text: guion[turn] }),
  });
  assert.deepEqual(result.transcript.map((t) => `${t.name}:${t.text}`), [
    'Ana:Ana uno',
    'Beto:Beto uno',
    'Beto:Beto dos',
  ]);
  assert.equal(result.stopped.reason, 'max_turns');
  assert.equal(result.stopped.turn, 4);
});

test('cap de maxCharsPerTurn con elipsis y normalización de espacios', async () => {
  const rt = makeRt({
    agents: [AGENTS[0], AGENTS[1]],
    maxTurns: 2,
    maxCharsPerTurn: 80,
  });
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => ({
      text: `  ${agent.name}\n\n${relleno(`turno ${turn}`, 300)}   `,
    }),
  });
  assert.equal(result.transcript.length, 2);
  for (const entry of result.transcript) {
    assert.equal(entry.text.length, 80);
    assert.ok(entry.text.endsWith('…'), entry.text);
    assert.ok(!entry.text.includes('\n'), 'sin saltos de línea');
  }
});

// ── Errores ────────────────────────────────────────────────────────────────

test('un error de callAgent no rompe: se registra y sigue con el próximo', async () => {
  const rt = makeRt({ maxTurns: 5 });
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => {
      if (agent.id === 'beto' && turn === 2) {
        throw new Error('proveedor caído');
      }
      return { text: `${agent.name} ${turn}` };
    },
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].agentId, 'beto');
  assert.equal(result.errors[0].turn, 2);
  assert.match(result.errors[0].message, /proveedor caído/);
  assert.deepEqual(result.transcript.map((t) => t.agentId), ['ana', 'carla', 'ana', 'beto']);
  assert.equal(result.stopped.reason, 'max_turns');
});

test('2 errores seguidos cortan con reason errors', async () => {
  const rt = makeRt({ agents: [AGENTS[0], AGENTS[1]], maxTurns: 6 });
  const result = await runRoundtable(rt, {
    callAgent: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(result.stopped.reason, 'errors');
  assert.equal(result.stopped.turn, RT_LIMITS.maxConsecutiveErrors);
  assert.equal(result.errors.length, RT_LIMITS.maxConsecutiveErrors);
  assert.equal(result.transcript.length, 0);
});

test('un éxito entre errores resetea la racha', async () => {
  const rt = makeRt({ agents: [AGENTS[0], AGENTS[1]], maxTurns: 5 });
  const result = await runRoundtable(rt, {
    callAgent: async ({ turn }) => {
      if (turn !== 2) {
        throw new Error('boom');
      }
      return { text: 'ok' };
    },
  });
  assert.equal(result.stopped.reason, 'errors');
  assert.equal(result.errors.length, 3);
  assert.equal(result.transcript.length, 1);
});

// ── Presupuesto total ──────────────────────────────────────────────────────

test('nunca excede maxTotalChars y corta con reason max_chars', async () => {
  const rt = makeRt({
    agents: [AGENTS[0], AGENTS[1]],
    maxTurns: 10,
    maxCharsPerTurn: 80,
    maxTotalChars: 200,
  });
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => ({ text: relleno(`${agent.id}-${turn}`, 300) }),
  });
  assert.equal(result.stopped.reason, 'max_chars');
  assert.ok(result.chars <= 200, `chars=${result.chars}`);
  assert.equal(result.chars, 200);
  assert.equal(result.transcript.reduce((sum, t) => sum + t.text.length, 0), 200);
  assert.ok(result.transcript.at(-1).text.endsWith('…'));
});

// ── summarizeRoundtable ────────────────────────────────────────────────────

function sampleResult() {
  return {
    topic: '¿Qué priorizamos?',
    transcript: [
      { index: 1, agentId: 'ana', name: 'Ana', role: 'producto', text: 'Primero el onboarding. Después medimos.' },
      { index: 2, agentId: 'beto', name: 'Beto', role: 'ingeniería', text: 'El onboarding toca tres servicios. Necesitamos una semana.' },
      { index: 3, agentId: 'ana', name: 'Ana', role: 'producto', text: 'El onboarding es la prioridad y además desbloquea la demo.' },
    ],
    stopped: { reason: 'done', turn: 3 },
    errors: [],
    chars: 200,
  };
}

test('summarizeRoundtable arma Markdown con una línea por agente y conclusión', () => {
  const out = summarizeRoundtable(sampleResult());
  assert.ok(out.startsWith('### Mesa redonda: ¿Qué priorizamos?'), out);
  assert.ok(out.includes('**Ana** (producto): Primero el onboarding.'), out);
  assert.ok(out.includes('**Beto** (ingeniería): El onboarding toca tres servicios.'), out);
  assert.ok(out.includes('Conclusión: El onboarding es la prioridad'), out);
});

test('summarizeRoundtable respeta maxChars con elipsis', () => {
  const out = summarizeRoundtable(sampleResult(), { maxChars: 120 });
  assert.equal(out.length, 120);
  assert.ok(out.endsWith('…'), out);
});

test('summarizeRoundtable sin done no agrega Conclusión', () => {
  const result = sampleResult();
  result.stopped = { reason: 'max_turns', turn: 3 };
  assert.ok(!summarizeRoundtable(result).includes('Conclusión:'));
});

// ── buildAgentPrompt ───────────────────────────────────────────────────────

test('buildAgentPrompt incluye rol, tema y transcript resumido', () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    role: 'producto',
    topic: '¿Qué priorizamos?',
    transcript: [
      { index: 1, agentId: 'beto', name: 'Beto', role: 'ingeniería', text: 'Necesitamos una semana para el onboarding.' },
    ],
  });
  assert.ok(prompt.includes('Ana'), prompt);
  assert.ok(prompt.includes('producto'), prompt);
  assert.ok(prompt.includes('¿Qué priorizamos?'), prompt);
  assert.ok(prompt.includes('Beto'), prompt);
  assert.ok(prompt.includes('Necesitamos una semana'), prompt);
  assert.ok(prompt.includes('1 a 3 oraciones'), prompt);
  assert.ok(prompt.includes('done:true'), prompt);
});

test('buildAgentPrompt sin transcript invita a abrir la discusión', () => {
  const prompt = buildAgentPrompt({ agent: AGENTS[1], role: 'ingeniería', topic: 't', transcript: [] });
  assert.ok(prompt.includes('Todavía no habló nadie'), prompt);
});

// ── Adversarial ────────────────────────────────────────────────────────────

test('adversarial: 50 turnos pedidos son inválidos; el tope real es 20', async () => {
  assert.throws(
    () => createRoundtable({ agents: AGENTS, topic: 't', maxTurns: 50 }),
    /maxTurns/,
  );

  const rt = makeRt({ maxTurns: 20 });
  let calls = 0;
  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, turn }) => {
      calls += 1;
      assert.ok(calls <= 20, 'no debe llamar más de 20 veces');
      return { text: `${agent.name} ${turn}` }; // nunca done
    },
  });
  assert.equal(calls, 20);
  assert.equal(result.stopped.reason, 'max_turns');
  assert.equal(result.stopped.turn, 20);
  assert.equal(result.transcript.length, 20);
});
