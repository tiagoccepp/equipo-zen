// Tests T4 (jobs historial + replay): record/list/load roundtrip en workspace
// temporal + replay re-encola con session fake. Cero modelo, cero disco real:
// todo escribe bajo mkdtemp, nunca en workspace/ del repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __resetRegistry,
  appendJobHistory,
  enqueueJob,
  findJobRecord,
  flushJobHistory,
  getJob,
  jobRecordPath,
  listJobHistory,
  loadJobBrief,
  loadJobRecord,
  runJob
} from '../server/lib/driver.js';

function freshBase() {
  return mkdtempSync(join(tmpdir(), 'jobs-t4-'));
}

function briefBase(extra = {}) {
  return {
    objetivo: 'Job T4 de prueba',
    contexto: 'Laboratorio: validar historial + replay',
    restricciones: ['sin deploy real'],
    criteriosExito: ['historial completo', 'replay re-encola'],
    formatoEntrega: 'documento de texto',
    producto: { tipo: 'generico', descripcion: 'entregable de prueba' },
    ...extra
  };
}

const FASES_1 = [
  { titulo: 'Construir entregable', dueño: 'backend', doneCriteria: 'entregable completo', dependeDe: [] }
];

const ROSTER = [
  { id: 'a-be', role: 'backend', name: 'Be' },
  { id: 'a-te', role: 'tester', name: 'Te' }
];

function fakeSession() {
  const calls = { turns: 0 };
  const session = {
    roster: ROSTER.map((m) => ({ ...m })),
    store: { activeLearnings: () => [], insertLearning: () => 1, reinforceLearning: () => {} },
    meeting: { id: 'm-t4' },
    async runAgentJobTurn(_agentId, text) {
      calls.turns += 1;
      if (String(text).includes('Sos el TESTER')) {
        return { text: 'Verificado.\nVEREDICTO: PASS — todo en verde', toolCalls: [], ms: 1, turnId: `t${calls.turns}` };
      }
      return { text: 'Entrega limpia y completa del job T4.', toolCalls: [], ms: 1, turnId: `d${calls.turns}` };
    },
    announceTeamEvent() {
      return { speaker: 'x', texto: 'y' };
    }
  };
  return { session, calls };
}

const fetchUrlFake = async (q) => `hallazgo: ${String(q).slice(0, 40)}`;

// ── 1. Paths sanitizados ───────────────────────────────────────────────
test('jobRecordPath: slug/id con ../ quedan dentro del base', () => {
  const base = freshBase();
  const p = jobRecordPath('../../etc', '../../../x', base);
  assert.ok(p.startsWith(base + '/'), `escapó del base: ${p}`);
  assert.ok(p.endsWith('.json'));
  const normal = jobRecordPath('mi-slug', 'job-abc', base);
  assert.equal(normal, join(base, 'mi-slug', 'jobs', 'job-abc.json'));
});

// ── 2. Roundtrip append/list/load ──────────────────────────────────────
test('append/list/load roundtrip en workspace temporal', async () => {
  const base = freshBase();
  const brief = briefBase();
  await appendJobHistory('proj-a', 'job-1', { tipo: 'brief', texto: brief.objetivo }, { baseDir: base, brief });
  await appendJobHistory('proj-a', 'job-1', { tipo: 'plan_listo', texto: '1 fase' }, {
    baseDir: base,
    patch: { estado: 'aprobado', fases: [{ titulo: 'F1', dueño: 'backend', doneCriteria: 'ok' }], rondas: 1 }
  });

  const rec = await loadJobRecord('proj-a', 'job-1', { baseDir: base });
  assert.equal(rec.id, 'job-1');
  assert.equal(rec.slug, 'proj-a');
  assert.equal(rec.brief.objetivo, brief.objetivo);
  assert.equal(rec.estado, 'aprobado');
  assert.equal(rec.history.length, 2);
  assert.deepEqual(rec.history.map((h) => h.tipo), ['brief', 'plan_listo']);
  assert.ok(rec.createdAt && rec.updatedAt);

  const loaded = await loadJobBrief('proj-a', 'job-1', { baseDir: base });
  assert.equal(loaded.objetivo, brief.objetivo);

  const lista = await listJobHistory({ baseDir: base });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, 'job-1');
  assert.equal(lista[0].source, 'disk');
  assert.equal(lista[0].estado, 'aprobado');

  assert.equal(await loadJobBrief('proj-a', 'nope', { baseDir: base }), null);
  assert.equal(await loadJobRecord('nope', 'job-1', { baseDir: base }), null);
});

// ── 3. Lista: orden, límite y filtro por slug ───────────────────────────
test('listJobHistory: orden desc, limit y filtro slug', async () => {
  const base = freshBase();
  await appendJobHistory('s1', 'job-old', { tipo: 'brief' }, { baseDir: base, brief: briefBase() });
  await new Promise((r) => setTimeout(r, 15));
  await appendJobHistory('s2', 'job-new', { tipo: 'brief' }, { baseDir: base, brief: briefBase() });

  const all = await listJobHistory({ baseDir: base });
  assert.deepEqual(all.map((j) => j.id), ['job-new', 'job-old']);

  const one = await listJobHistory({ baseDir: base, limit: 1 });
  assert.equal(one.length, 1);

  const s1 = await listJobHistory({ baseDir: base, slug: 's1' });
  assert.deepEqual(s1.map((j) => j.id), ['job-old']);

  const found = await findJobRecord('job-new', { baseDir: base });
  assert.equal(found.slug, 's2');
  assert.equal(found.record.id, 'job-new');
  assert.equal(await findJobRecord('job-zzz', { baseDir: base }), null);
});

// ── 4. runJob deja historial completo ──────────────────────────────────
test('runJob con jobsBaseDir: brief+fases+history+estado en disco', async () => {
  __resetRegistry();
  const base = freshBase();
  const { session } = fakeSession();
  const final = await runJob(session, briefBase({ fases: FASES_1 }), {
    fetchUrl: fetchUrlFake,
    jobsBaseDir: base,
    slug: 't4test'
  });
  assert.equal(final.estado, 'aprobado');
  await flushJobHistory();

  const rec = await loadJobRecord('t4test', final.id, { baseDir: base });
  assert.ok(rec, 'el record debe existir en disco');
  assert.equal(rec.brief.objetivo, 'Job T4 de prueba');
  assert.equal(rec.estado, 'aprobado');
  assert.equal(rec.fases.length, 1);
  assert.equal(rec.fases[0].dueño, 'backend');
  const tipos = rec.history.map((h) => h.tipo);
  for (const t of ['brief', 'plan_listo', 'dispatch', 'entrega', 'aprobado']) {
    assert.ok(tipos.includes(t), `falta evento ${t}: ${tipos.join(',')}`);
  }
  // Orden preservado por la cola por-archivo (brief primero, aprobado último).
  assert.equal(tipos[0], 'brief');
  assert.equal(tipos[tipos.length - 1], 'aprobado');

  const lista = await listJobHistory({ baseDir: base });
  assert.ok(lista.some((j) => j.id === final.id && j.estado === 'aprobado'));
});

// ── 5. Replay: brief guardado se re-encola como job nuevo ───────────────
test('replay: loadJobBrief + enqueueJob corre un job nuevo hasta aprobado', async () => {
  __resetRegistry();
  const base = freshBase();
  const { session } = fakeSession();
  const first = await runJob(session, briefBase({ fases: FASES_1 }), {
    fetchUrl: fetchUrlFake,
    jobsBaseDir: base,
    slug: 't4test'
  });
  assert.equal(first.estado, 'aprobado');

  const brief = await loadJobBrief('t4test', first.id, { baseDir: base });
  assert.ok(brief && brief.objetivo === 'Job T4 de prueba');

  const { session: session2 } = fakeSession();
  const { jobId, estado } = enqueueJob(session2, brief, { fetchUrl: fetchUrlFake, jobsBaseDir: base, slug: 't4test' });
  assert.equal(estado, 'encolado');
  assert.notEqual(jobId, first.id);

  const t0 = Date.now();
  let job = getJob(jobId);
  while (!['aprobado', 'fallo', 'escalado'].includes(job.estado) && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 25));
    job = getJob(jobId);
  }
  assert.equal(job.estado, 'aprobado');
  await flushJobHistory();

  const rec2 = await loadJobRecord('t4test', jobId, { baseDir: base });
  assert.ok(rec2 && rec2.estado === 'aprobado');
  assert.ok(rec2.history.some((h) => h.tipo === 'encolado'));
  const lista = await listJobHistory({ baseDir: base });
  assert.equal(lista.length, 2);
});

// ── 6. Sin recording: cero writes fuera del loop ────────────────────────
test('sin recordHistory ni jobsBaseDir: no escribe en el workspace real', async () => {
  __resetRegistry();
  const { session } = fakeSession();
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  await flushJobHistory();
  // Si el driver hubiera grabado por default, este brief existiría en disco.
  assert.equal(await loadJobBrief('general', final.id), null);
  assert.equal(await findJobRecord(final.id), null);
});
