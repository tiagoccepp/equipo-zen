// E-06: llamada grupal — flag audio_prepare + convocatoria a todo el roster.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyTemplates } from '../server/lib/config.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { Store } from '../server/lib/store.js';

function live() {
  const sent = [];
  const socket = { readyState: 1, OPEN: 1, send: (p) => sent.push(JSON.parse(p)) };
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Call' });
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null, company.id, project.id);
  return { session, sent };
}

test('e06: audio_prepare con group prende/apaga la llamada', async () => {
  const { session } = live();
  assert.equal(session.groupCall, false, 'default off');
  await session.handleClientMessage({ type: 'audio_prepare', group: true });
  assert.equal(session.groupCall, true);
  await session.handleClientMessage({ type: 'audio_stop' });
  assert.equal(session.groupCall, false);
  await session.handleClientMessage({ type: 'audio_prepare' });
  assert.equal(session.groupCall, false, 'sin group: llamada simple');
});

test('e06: en llamada grupal, el route convoca a TODO el roster', async () => {
  const { session } = live();
  const roster = session.sessionAgents.filter((a) => a.enabled !== false);
  assert.ok(roster.length >= 2, `roster con gente (${roster.length})`);
  session.groupCall = true;
  const route = session.applyGroupCallRoute({ targets: [{ agentId: 'uno' }] }, 't1');
  assert.equal(route.groupAddressed, true);
  assert.deepEqual(
    route.targets.map((t) => t.agentId).sort(),
    roster.map((a) => a.id).sort(),
    'todos convocados'
  );
  assert.ok(route.targets.every((t) => t.groupCall === true));
  session.groupCall = false;
  const untouched = { targets: [{ agentId: 'uno' }] };
  session.applyGroupCallRoute(untouched, 't2');
  assert.deepEqual(untouched.targets, [{ agentId: 'uno' }], 'sin llamada: intacto');
});

test('e06: voces distintas por agente (multivoces real)', async () => {
  const { session } = live();
  const voices = session.sessionAgents.map((a) => a.voice).filter(Boolean);
  assert.ok(voices.length >= 2);
  assert.equal(new Set(voices).size, voices.length, `voces únicas: ${voices.join(',')}`);
});
