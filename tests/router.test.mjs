import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRouter, isClosingSignal } from '../server/lib/router.js';
import { normalize } from '../server/lib/text.js';

const AGENTS = [
  {
    id: 'programacion',
    name: 'Julio',
    aliases: ['julio', 'programador', 'sistema'],
    domains: ['api', 'backend', 'base de datos', 'dashboard']
  },
  {
    id: 'operaciones',
    name: 'Tomasa',
    aliases: ['tomasa', 'operaciones'],
    domains: ['stock', 'inventario', 'cobranza', 'reparto']
  }
];

function memoryWithLastAgent(agentId) {
  return {
    lastAgentTurn: () => (agentId ? { agentId, speaker: 'X', text: 'algo' } : null)
  };
}

test('isClosingSignal: explicit phrases close at any length', () => {
  assert.equal(isClosingSignal(normalize('bueno, con esto queda claro el plan')), true);
  assert.equal(isClosingSignal(normalize('cambiemos de tema por favor')), true);
});

test('isClosingSignal: loose words only in short utterances', () => {
  assert.equal(isClosingSignal(normalize('para')), true);
  assert.equal(isClosingSignal(normalize('listo, gracias')), true);
  assert.equal(isClosingSignal(normalize('el sistema para pedidos no anda')), false);
  assert.equal(isClosingSignal(normalize('necesito parar el proceso de alto consumo')), false);
});

test('isClosingSignal: never closes if there is a question', () => {
  assert.equal(isClosingSignal(normalize('¿qué API usamos para el dashboard?')), false);
  assert.equal(isClosingSignal(normalize('¿listo?')), false);
});

test('route: question with "para" does not close and routes by domain', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('¿Qué API usamos para el dashboard?', memoryWithLastAgent('operaciones'));
  assert.ok(!route.closing);
  assert.ok(route.targets.some((t) => t.agentId === 'programacion'));
});

test('route: real close goes only to the last agent with score 99', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('listo, queda claro', memoryWithLastAgent('programacion'));
  assert.equal(route.closing, true);
  assert.equal(route.targets.length, 1);
  assert.equal(route.targets[0].agentId, 'programacion');
  assert.equal(route.targets[0].score, 99);
});

test('route: pure greeting marks greeting with all agents', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('hola equipo', memoryWithLastAgent(null));
  assert.equal(route.greeting, true);
  assert.equal(route.targets.length, 2);
});

test('route: mention with word boundary ("sistemática" does not mention Julio)', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('la sistemática de ventas necesita revisión del inventario', memoryWithLastAgent(null));
  assert.ok(!route.targets.some((t) => t.agentId === 'programacion' && t.directMention));
  assert.ok(route.targets.some((t) => t.agentId === 'operaciones'));
});

test('route: multi-word domain matches whole', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('la base de datos y el backend andan lentos', memoryWithLastAgent(null));
  const julio = route.targets.find((t) => t.agentId === 'programacion');
  assert.ok(julio);
  assert.deepEqual(julio.matchedDomains.sort(), ['backend', 'base de datos']);
});

test('nextContextualTarget requires explicit mention of the other agent', () => {
  const router = new AgentRouter(AGENTS);
  const route = { targets: [{ agentId: 'programacion' }] };
  const memory = {
    lastAgentTurn: () => ({ agentId: 'programacion', speaker: 'Julio', text: 'esto lo tiene que validar tomasa con el stock' })
  };
  const next = router.nextContextualTarget('revisemos', route, memory);
  assert.ok(next);
  assert.equal(next.agentId, 'operaciones');

  const memorySinMencion = {
    lastAgentTurn: () => ({ agentId: 'programacion', speaker: 'Julio', text: 'ya está resuelto el endpoint' })
  };
  assert.equal(router.nextContextualTarget('revisemos', route, memorySinMencion), null);
});

test('a bare "hola" is answered only by the CEO, not all eight in chorus', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true },
    { id: 'p', name: 'Pablo', role: 'worker', aliases: ['pablo'], domains: ['diseno'], enabled: true }
  ]);

  for (const saludo of ['hola', 'buenas', 'buen día', 'qué tal']) {
    const ruta = router.route(saludo, { lastAgentTurn: () => null });
    assert.equal(ruta.targets.length, 1, `"${saludo}" no puede hacer hablar a todos`);
    assert.equal(ruta.targets[0].name, 'Renata');
  }
});

test('a greeting to the group is answered by the team', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true }
  ]);

  for (const saludo of ['hola chicos', 'buenas equipo', 'hola a todos', 'buenas gente']) {
    const ruta = router.route(saludo, { lastAgentTurn: () => null });
    assert.equal(ruta.targets.length, 2, `"${saludo}" es para todos`);
    assert.equal(ruta.groupGreeting, true);
  }
});

test('greeting someone by name does not drag the rest', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true }
  ]);
  const ruta = router.route('hola Bruno', { lastAgentTurn: () => null });
  assert.equal(ruta.targets.length, 1);
  assert.equal(ruta.targets[0].name, 'Bruno');
});

test('without a CEO at the table, someone still takes the simple greeting', () => {
  const router = new AgentRouter([
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true },
    { id: 'p', name: 'Pablo', role: 'worker', aliases: ['pablo'], domains: ['diseno'], enabled: true }
  ]);
  const ruta = router.route('hola', { lastAgentTurn: () => null });
  assert.equal(ruta.targets.length, 1, 'uno solo, no los dos');
});

test('preséntense / each one summons the whole team', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true }
  ]);

  for (const texto of ['Preséntense en una frase cada uno', 'quiero escucharlos a todos', 'todos respondan', 'a ver, cada una diga lo suyo']) {
    const ruta = router.route(texto, { lastAgentTurn: () => null });
    assert.equal(ruta.targets.length, 2, `"${texto}" es ronda completa`);
  }
});
