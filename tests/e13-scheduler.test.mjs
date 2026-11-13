// E-13: scheduler — cron/interval/once/watcher + acciones + outbox.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  __resetSchedulerState,
  nextCronRun,
  nextRunFor,
  onScheduledNotify,
  parseCron,
  runDueJobs,
  scheduledOutbox,
  watcherFingerprint
} from '../server/lib/scheduler.js';
import { Store } from '../server/lib/store.js';

afterEach(() => { __resetSchedulerState(); });

test('e13: cron parse + next (diaria, cada 5min, semanal)', () => {
  const c = parseCron('*/5 9 * * 1-5');
  assert.ok(c.minute.has(0) && c.minute.has(5) && !c.minute.has(6));
  assert.ok(c.hour.has(9) && c.hour.size === 1);
  assert.throws(() => parseCron('nope'), /5 campos/);
  // Lunes 2026-11-09 08:00 → próxima 9:00 mismo día.
  const monday = new Date(2026, 10, 9, 8, 0, 0).getTime();
  const next = nextCronRun('0 9 * * *', monday);
  const d = new Date(next);
  assert.equal(d.getHours(), 9, 'misma mañana');
  assert.equal(d.getDate(), 9);
  const past = nextCronRun('0 9 * * *', new Date(2026, 10, 9, 10, 0, 0).getTime());
  assert.equal(new Date(past).getDate(), 10, 'ya pasó → mañana');
  const weekly = nextCronRun('30 8 * * 1', new Date(2026, 10, 10, 0, 0, 0).getTime());
  assert.equal(new Date(weekly).getDay(), 1, 'próximo lunes');
});

test('e13: nextRunFor por kind + disabled', () => {
  const now = 1000000;
  // Interval vencido → ya (now+1s); futuro → base+every.
  assert.equal(nextRunFor({ kind: 'interval', spec: { everyMs: 60000 }, lastRun: now - 90000, enabled: true }, now), now + 1000);
  assert.equal(nextRunFor({ kind: 'interval', spec: { everyMs: 60000 }, lastRun: now - 10000, enabled: true }, now), now + 50000);
  assert.equal(nextRunFor({ kind: 'interval', spec: {}, lastRun: 0, enabled: true }, now), null, 'sin everyMs');
  assert.equal(nextRunFor({ kind: 'once', spec: { at: now + 5000 }, enabled: true }, now), now + 5000);
  assert.equal(nextRunFor({ kind: 'once', spec: { at: now - 5 }, enabled: true }, now), null, 'once pasado');
  assert.equal(nextRunFor({ kind: 'interval', spec: { everyMs: 1 }, enabled: false }, now), null, 'disabled');
  assert.equal(nextRunFor({ kind: 'invento', spec: {}, enabled: true }, now), null);
});

test('e13: watcher detecta cambios de archivo', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e13-w-'));
  const f = path.join(dir, 'x.txt');
  writeFileSync(f, 'v1');
  const fp1 = watcherFingerprint(f);
  assert.ok(fp1);
  assert.equal(watcherFingerprint(f), fp1, 'sin cambio: igual');
  writeFileSync(f, 'v1 más largo');
  assert.notEqual(watcherFingerprint(f), fp1, 'cambio detectado');
  assert.equal(watcherFingerprint(path.join(dir, 'nope')), null, 'inexistente');
  assert.ok(watcherFingerprint(dir), 'dir también');
});

test('e13: runDueJobs ejecuta notify+task, respeta next_run y disabled', async () => {
  const store = new Store(':memory:');
  const seen = [];
  onScheduledNotify((e) => seen.push(e));
  const j1 = store.createSchedJob({ name: 'aviso', kind: 'interval', spec: { everyMs: 60000 }, action: { type: 'notify', text: 'hora' } });
  const j2 = store.createSchedJob({ name: 'tarea', kind: 'interval', spec: { everyMs: 60000 }, action: { type: 'task_create', text: 'hacer X' } });
  const j3 = store.createSchedJob({ name: 'off', kind: 'interval', spec: { everyMs: 1 }, action: { type: 'notify' }, enabled: false });
  assert.ok(j1 && j2 && j3, 'CRUD crea');
  assert.equal(store.createSchedJob({ name: '', kind: 'interval' }), null, 'inválido');
  const ran = await runDueJobs({ store });
  assert.equal(ran.length, 2, 'los 2 enabled (off no)');
  assert.equal(scheduledOutbox().length, 1, 'notify al outbox');
  assert.equal(seen.length, 1, 'subscriber avisado');
  assert.ok(store._prepare("SELECT COUNT(*) AS n FROM tasks WHERE text = 'hacer X'").get().n >= 1, 'tarea creada');
  const ran2 = await runDueJobs({ store });
  assert.equal(ran2.length, 0, 'next_run futuro: no repite');
  store.close();
});

test('e13: watcher dispara una vez por cambio', async () => {
  const store = new Store(':memory:');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e13-w2-'));
  const f = path.join(dir, 'y.txt');
  writeFileSync(f, 'a');
  store.createSchedJob({ name: 'w', kind: 'watcher', spec: { path: f }, action: { type: 'notify', text: 'cambió' } });
  assert.equal((await runDueJobs({ store })).length, 1, 'primer fingerprint cuenta como cambio');
  assert.equal((await runDueJobs({ store })).length, 0, 'sin cambio no');
  writeFileSync(f, 'a modificado!!!');
  assert.equal((await runDueJobs({ store })).length, 1, 'cambio sí');
  store.close();
});
