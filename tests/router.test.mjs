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

test('isClosingSignal: frases explícitas cierran a cualquier longitud', () => {
  assert.equal(isClosingSignal(normalize('bueno, con esto queda claro el plan')), true);
  assert.equal(isClosingSignal(normalize('cambiemos de tema por favor')), true);
});

test('isClosingSignal: palabras sueltas solo en enunciados cortos', () => {
  assert.equal(isClosingSignal(normalize('para')), true);
  assert.equal(isClosingSignal(normalize('listo, gracias')), true);
  assert.equal(isClosingSignal(normalize('el sistema para pedidos no anda')), false);
  assert.equal(isClosingSignal(normalize('necesito parar el proceso de alto consumo')), false);
});

test('isClosingSignal: nunca cierra si hay pregunta', () => {
  assert.equal(isClosingSignal(normalize('¿qué API usamos para el dashboard?')), false);
  assert.equal(isClosingSignal(normalize('¿listo?')), false);
});

test('route: pregunta con "para" no cierra y rutea por dominio', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('¿Qué API usamos para el dashboard?', memoryWithLastAgent('operaciones'));
  assert.ok(!route.closing);
  assert.ok(route.targets.some((t) => t.agentId === 'programacion'));
});

test('route: cierre real va solo al último agente con score 99', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('listo, queda claro', memoryWithLastAgent('programacion'));
  assert.equal(route.closing, true);
  assert.equal(route.targets.length, 1);
  assert.equal(route.targets[0].agentId, 'programacion');
  assert.equal(route.targets[0].score, 99);
});

test('route: saludo puro marca greeting con todos los agentes', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('hola equipo', memoryWithLastAgent(null));
  assert.equal(route.greeting, true);
  assert.equal(route.targets.length, 2);
});

test('route: mención con límite de palabra ("sistemática" no menciona a Julio)', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('la sistemática de ventas necesita revisión del inventario', memoryWithLastAgent(null));
  assert.ok(!route.targets.some((t) => t.agentId === 'programacion' && t.directMention));
  assert.ok(route.targets.some((t) => t.agentId === 'operaciones'));
});

test('route: dominio multi-palabra matchea completo', () => {
  const router = new AgentRouter(AGENTS);
  const route = router.route('la base de datos y el backend andan lentos', memoryWithLastAgent(null));
  const julio = route.targets.find((t) => t.agentId === 'programacion');
  assert.ok(julio);
  assert.deepEqual(julio.matchedDomains.sort(), ['backend', 'base de datos']);
});

test('nextContextualTarget exige mención explícita del otro agente', () => {
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

test('un "hola" pelado lo contesta solo la CEO, no los ocho a coro', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true },
    { id: 's', name: 'Sofía', role: 'worker', aliases: ['sofia'], domains: ['diseno'], enabled: true }
  ]);

  for (const saludo of ['hola', 'buenas', 'buen día', 'qué tal']) {
    const ruta = router.route(saludo, { lastAgentTurn: () => null });
    assert.equal(ruta.targets.length, 1, `"${saludo}" no puede hacer hablar a todos`);
    assert.equal(ruta.targets[0].name, 'Renata');
  }
});

test('un saludo al grupo sí lo contesta el equipo', () => {
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

test('saludar a alguien por su nombre no arrastra al resto', () => {
  const router = new AgentRouter([
    { id: 'ceo', name: 'Renata', role: 'ceo', aliases: ['renata'], domains: ['estrategia'], enabled: true },
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true }
  ]);
  const ruta = router.route('hola Bruno', { lastAgentTurn: () => null });
  assert.equal(ruta.targets.length, 1);
  assert.equal(ruta.targets[0].name, 'Bruno');
});

test('sin CEO en la mesa, el saludo simple lo toma alguien igual', () => {
  const router = new AgentRouter([
    { id: 'b', name: 'Bruno', role: 'worker', aliases: ['bruno'], domains: ['frontend'], enabled: true },
    { id: 's', name: 'Sofía', role: 'worker', aliases: ['sofia'], domains: ['diseno'], enabled: true }
  ]);
  const ruta = router.route('hola', { lastAgentTurn: () => null });
  assert.equal(ruta.targets.length, 1, 'uno solo, no los dos');
});
