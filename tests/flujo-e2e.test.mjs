// E2E del flujo de equipo (tracks A→B→C) con adaptadores del main.
// Recorre: brief → plan (+spawn FALTA:*) → dispatch → entrega →
// peer review → tester falla → devolución → rework → tester aprueba.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Orchestrator } from '../server/lib/orchestrator.js';
import { spawnRequest } from '../server/lib/spawner.js';
import { revisar } from '../server/lib/critic.js';
import { juzgar, planDePrueba } from '../server/lib/tester.js';
import {
  adaptarSpawnResponse,
  aprobacionDesdeTester,
  devolucionDesdeTester,
  isAprobacion,
  isDevolucion,
  isSpawnResponse,
  spawnRequestPara
} from '../server/lib/team-protocol.js';

const EQUIPO = [{ id: 'be-1', role: 'backend', name: 'Bruno' }];

function briefWeb() {
  return {
    objetivo: 'landing para cafetería con menú y reservas',
    contexto: 'negocio real, una página',
    restricciones: ['una sola página', 'sin backend'],
    criteriosExito: ['muestra el menú', 'formulario de reserva anda'],
    formatoEntrega: 'url',
    de: 'Pablo'
  };
}

function fasesDemo() {
  return [
    { n: 1, titulo: 'Estructura y copy', dueño: 'backend', doneCriteria: 'html con menú visible', dependeDe: [] },
    { n: 2, titulo: 'Pruebas de receptor', dueño: 'FALTA:tester', doneCriteria: 'matriz persona×dimensión ejecutada', dependeDe: [1] }
  ];
}

function orquestadorE2E(anuncios) {
  return new Orchestrator({
    // Cableado A→B por adaptadores (el único lugar que traduce).
    requestSpawn: (req) => adaptarSpawnResponse(
      spawnRequest(spawnRequestPara(req), { equipo: EQUIPO }),
      EQUIPO
    ),
    announce: (evento) => anuncios.push(evento),
    maxRondas: 3
  });
}

test('flujo E2E: brief → plan con spawn → dispatch → entrega', async () => {
  const anuncios = [];
  const orq = orquestadorE2E(anuncios);
  const { job } = orq.intake(briefWeb());
  assert.equal(job.estado, 'brief_ok');

  await orq.planificar(job.id, fasesDemo(), { research: false });
  assert.equal(job.estado, 'planificado');
  // FALTA:tester se resolvió por protocolo a un nombre (no SIN_DUEÑO).
  const fase2 = job.plan.fases.find((f) => f.n === 2);
  assert.ok(!/^SIN_DUEÑO:/.test(fase2.dueño), `dueño sin resolver: ${fase2.dueño}`);
  assert.ok(anuncios.some((a) => /fase/.test(a.texto || '')), 'anuncia plan_listo');

  const dispatch = orq.dispatchFase(job.id, 1);
  assert.equal(dispatch.estado, 'en_curso');
  const entrega = orq.entregar(job.id, dispatch.taskId, 'html + css listos');
  assert.equal(entrega.estado, 'entregado');
});

test('flujo E2E: rol existente no se duplica (vía adaptador)', async () => {
  const anuncios = [];
  const orq = orquestadorE2E(anuncios);
  const { job } = orq.intake(briefWeb());
  // backend ya está en el equipo → existente, ok:true, con id+nombre.
  const res = await orq.pedirRol(job, 'backend');
  assert.equal(res.ok, true);
  assert.ok(res.existente?.id === 'be-1');
  assert.ok(res.existente?.nombre === 'Bruno');
  assert.equal(isSpawnResponse(res).ok, true);
});

test('flujo E2E: peer review calla sin mejora, habla con mejora', () => {
  const silencio = revisar({ texto: 'código limpio, testeado, documentado' }, { rol: 'backend' });
  assert.equal(silencio.silencio, true);
  const habla = revisar({ texto: 'TODO: arreglar esto después, contraseña admin123 hardcodeada' }, { rol: 'backend' });
  assert.equal(habla.silencio, false);
  assert.ok(habla.mejoras.length > 0);
});

test('flujo E2E: tester falla → devolución → rework → aprueba', async () => {
  const anuncios = [];
  const orq = orquestadorE2E(anuncios);
  const { job } = orq.intake(briefWeb());
  await orq.planificar(job.id, fasesDemo(), { research: false });
  const dispatch = orq.dispatchFase(job.id, 1);
  orq.entregar(job.id, dispatch.taskId, 'v1 lista');

  const plan = planDePrueba({ tipo: 'web', brief: briefWeb() });
  assert.ok(plan.celdas.length > 0);

  // Ronda 1: un bug real → devolución canonical → rework.
  const juicio1 = juzgar([
    { estado: 'pass', persona: 'usuario-nuevo', dimension: 'visual' },
    {
      estado: 'fail', persona: 'comprador', dimension: 'funcional',
      titulo: 'reserva no confirma', observado: 'el botón no responde',
      pasosRepro: ['abrir landing', 'llenar fecha', 'clic reservar'],
      criterioFallado: 'formulario de reserva anda'
    }
  ], { ronda: 1 });
  assert.equal(juicio1.veredicto, 'devolucion');
  const dev = devolucionDesdeTester(juicio1, { jobId: job.id, taskId: dispatch.taskId });
  assert.equal(isDevolucion(dev).ok, true);
  const rw = orq.devolver(job.id, dev);
  assert.equal(rw.estado, 'rework');
  assert.ok(rw.redispatches.length > 0);

  // Ronda 2: todo verde → aprobación canonical → aprobado.
  const juicio2 = juzgar([
    { estado: 'pass', persona: 'usuario-nuevo', dimension: 'visual' },
    { estado: 'pass', persona: 'comprador', dimension: 'funcional' }
  ], { ronda: 2, arregladoEnRondas: ['reserva no confirma'], limitaciones: [] });
  assert.equal(juicio2.veredicto, 'aprobado');
  const ap = aprobacionDesdeTester(juicio2, { jobId: job.id });
  assert.equal(isAprobacion(ap).ok, true);
  const final = orq.aprobar(job.id, ap);
  assert.equal(final.estado, 'aprobado');
  assert.ok(anuncios.some((a) => /aprob/i.test(a.texto || '')));
});
