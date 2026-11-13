// E-18: notificaciones — dispatch, voz, log, tools + regresión imports E-17.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetNotifications,
  dispatchNotification,
  notificationGet,
  notificationLog,
  registerVoiceAnnouncer
} from '../server/lib/notifications.js';
import { getTool } from '../server/lib/manos.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
afterEach(() => { __resetNotifications(); });

test('e18: dispatch va a channel + log + voz', async () => {
  const announced = [];
  const voiced = [];
  registerVoiceAnnouncer(async ({ short }) => { voiced.push(short); return true; });
  const n = await dispatchNotification({
    title: 'Build listo',
    detail: 'Todo verde en 3m.',
    goalId: 'g1',
    short: 'El build terminó bien.',
    announce: async ({ title }) => { announced.push(title); return { channel: 'test' }; }
  });
  assert.equal(n.channel, 'test');
  assert.equal(n.voiced, true);
  assert.deepEqual(voiced, ['El build terminó bien.']);
  assert.equal(notificationLog().length, 1);
  assert.equal(notificationGet(n.id).detail, 'Todo verde en 3m.');
  assert.equal(notificationGet('nt-999'), null);
  assert.equal(await dispatchNotification({ title: '  ' }), null, 'sin título no');
});

test('e18: sin anunciadores ni channel igual loguea; errores aislados', async () => {
  registerVoiceAnnouncer(async () => { throw new Error('voz caída'); });
  const n = await dispatchNotification({
    title: 'Aviso',
    announce: async () => { throw new Error('channel caído'); }
  });
  assert.ok(n.channelError.includes('channel'), 'error registrado');
  assert.equal(n.voiced, false);
  assert.equal(notificationLog().length, 1);
});

test('e18: tools notify_list/read', async () => {
  await dispatchNotification({ title: 'Uno', detail: 'detalle uno' });
  await dispatchNotification({ title: 'Dos' });
  const list = await getTool('notify_list').execute({}, {});
  assert.equal(list.ok, true);
  assert.ok(list.output.includes('Uno') && list.output.includes('Dos'));
  const id = notificationLog().find((n) => n.title === 'Uno').id;
  const read = await getTool('notify_read').execute({ id }, {});
  assert.ok(read.output.includes('detalle uno'));
  const bad = await getTool('notify_read').execute({ id: 'nt-999' }, {});
  assert.equal(bad.ok, false);
});

test('e18: regresión — meeting-session importa jev + announcer (E-17)', () => {
  const ms = readFileSync(join(ROOT, 'server/lib/meeting-session.js'), 'utf8');
  assert.ok(ms.includes("from './jev.js'"), 'jev importado (no fail-open silencioso)');
  assert.ok(ms.includes("from './notifications.js'"), 'announcer importado');
  assert.ok(ms.includes('getEnergyMode'), 'modo energía resuelto');
  assert.ok(ms.includes('getNotifyVoice'), 'voz notificaciones resuelve');
});
