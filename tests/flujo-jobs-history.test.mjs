// T4 tests (jobs history + replay): record/list/load roundtrip in a temp
// workspace + replay re-enqueues with a fake session. Zero model, zero real disk:
// everything writes under mkdtemp, never into the repo workspace/.
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

// ── 1. Sanitized paths ───────────────────────────────────────────────
test('jobRecordPath: slug/id with ../ stay inside the base', () => {
  const base = freshBase();
  const p = jobRecordPath('../../etc', '../../../x', base);
  assert.ok(p.startsWith(base + '/'), `escapó del base: ${p}`);
  assert.ok(p.endsWith('.json'));
  const normal = jobRecordPath('mi-slug', 'job-abc', base);
  assert.equal(normal, join(base, 'mi-slug', 'jobs', 'job-abc.json'));
});

// ── 2. append/list/load roundtrip ──────────────────────────────────────
test('append/list/load roundtrip in temp workspace', async () => {
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

// ── 3. List: order, limit and slug filter ──────────────────────────────
test('listJobHistory: desc order, limit and slug filter', async () => {
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

// ── 4. runJob leaves full history ──────────────────────────────────────
test('runJob with jobsBaseDir: brief+phases+history+status on disk', async () => {
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
  // Order preserved by the per-file queue (brief first, aprobado last).
  assert.equal(tipos[0], 'brief');
  assert.equal(tipos[tipos.length - 1], 'aprobado');

  const lista = await listJobHistory({ baseDir: base });
  assert.ok(lista.some((j) => j.id === final.id && j.estado === 'aprobado'));
});

// ── 5. Replay: saved brief re-enqueues as a new job ───────────────────
test('replay: loadJobBrief + enqueueJob runs a new job until approved', async () => {
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

// ── 6. Without recording: zero writes outside the loop ─────────────────
test('without recordHistory or jobsBaseDir: does not write to the real workspace', async () => {
  __resetRegistry();
  const { session } = fakeSession();
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  await flushJobHistory();
  // If the driver recorded by default, this brief would exist on disk.
  assert.equal(await loadJobBrief('general', final.id), null);
  assert.equal(await findJobRecord(final.id), null);
});
