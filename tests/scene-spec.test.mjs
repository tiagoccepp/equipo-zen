import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createSceneStore } from '../server/lib/scene-store.js';
import { registerSceneRoutes } from '../server/lib/scene-routes.js';
import { sceneDemo, validateSceneSpec } from '../server/lib/scene-spec.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test('validateSceneSpec accepts a complete V6 demo scene', () => {
  const spec = sceneDemo();
  const r = validateSceneSpec(spec);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.ok(Array.isArray(r.spec.parts) && r.spec.parts.length >= 40);
  assert.ok(Array.isArray(r.spec.steps) && r.spec.steps.length === 4);
});

test('validateSceneSpec clamps/repairs safe cases and reports warnings', () => {
  const r = validateSceneSpec({
    version: 1,
    title: 'Clamped',
    units: 'm',
    camera: { position: [1, 1, 1], target: [0, 0, 0], fov: 200 },
    parts: [
      { id: 'a', kind: 'box', size: [1000, 0.2, 0.2], position: [0, 0, 0], color: '#abc', metalness: 2 },
      { id: 'b', kind: 'sphere', radius: '0.1', position: ['1', 0, 0], color: '#00ff00' }
    ]
  });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.spec.camera.fov, 100);
  assert.equal(r.spec.parts[0].size[0], 50);
  assert.equal(r.spec.parts[0].metalness, 1);
  assert.equal(r.spec.parts[0].color, '#aabbcc');
  assert.ok(r.warnings.length >= 1);
});

test('validateSceneSpec fails unknown shapes, duplicates and dangling refs', () => {
  const badKind = validateSceneSpec({
    version: 1, title: 'Bad', units: 'm', camera: { position: [1, 1, 1], target: [0, 0, 0] },
    parts: [{ id: 'x', kind: 'pyramid', position: [0, 0, 0], color: '#fff' }]
  });
  assert.equal(badKind.ok, false);
  assert.ok(badKind.errors.some((e) => e.includes('unknown kind')));

  const dup = validateSceneSpec({
    version: 1, title: 'Dup', units: 'm', camera: { position: [1, 1, 1], target: [0, 0, 0] },
    parts: [
      { id: 'a', kind: 'box', size: [1, 1, 1], position: [0, 0, 0], color: '#fff' },
      { id: 'a', kind: 'box', size: [1, 1, 1], position: [1, 0, 0], color: '#fff' }
    ]
  });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes('duplicate id')));

  const ref = validateSceneSpec({
    version: 1, title: 'Ref', units: 'm', camera: { position: [1, 1, 1], target: [0, 0, 0] },
    parts: [
      { id: 'a', kind: 'box', size: [1, 1, 1], position: [0, 0, 0], color: '#fff', parent: 'missing' }
    ],
    steps: [{ title: 's', body: 'b', highlight: ['ghost'] }]
  });
  assert.equal(ref.ok, false);
  assert.ok(ref.errors.some((e) => e.includes('unknown part')));
});

test('scene store publishes, versions per project and keeps last 20', async () => {
  const store = createSceneStore({ limit: 20 });
  const spec = sceneDemo();
  const a1 = store.publish('p1', spec);
  const a2 = store.publish('p1', spec);
  const b1 = store.publish('p2', spec);
  assert.equal(a1.version, 1);
  assert.equal(a2.version, 2);
  assert.equal(b1.version, 1);
  assert.equal(store.getLatest('p1').version, 2);
  assert.equal(store.getLatest('p2').version, 1);
  assert.equal(store.list('p1').length, 2);
  for (let i = 0; i < 25; i += 1) store.publish('p3', spec);
  const list = store.list('p3');
  assert.equal(list.length, 20);
  assert.equal(list[0].version, 25);
  assert.equal(list[19].version, 6);
  assert.equal(store.getLatest('missing'), null);
});

test('scene routes post/get latest/list with validation', async () => {
  const app = express();
  app.use(express.json());
  const store = createSceneStore();
  registerSceneRoutes(app, { store });
  const { server, base } = await listen(app);
  try {
    const spec = sceneDemo();

    const bad = await fetch(`${base}/api/scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', spec: { version: 1, title: 'x', parts: [] } })
    });
    assert.equal(bad.status, 422);

    const ok = await fetch(`${base}/api/scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', spec })
    });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.equal(created.ok, true);
    assert.equal(created.scene.version, 1);

    const latest = await fetch(`${base}/api/scene/latest?projectId=p`);
    assert.equal(latest.status, 200);
    const lj = await latest.json();
    assert.equal(lj.scene.spec.title, spec.title);

    await fetch(`${base}/api/scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', spec: { ...spec, title: 'v2' } })
    });
    const listRes = await fetch(`${base}/api/scene/list?projectId=p&n=1`);
    const listJson = await listRes.json();
    assert.equal(listJson.scenes.length, 1);
    assert.equal(listJson.scenes[0].version, 2);

    const miss = await fetch(`${base}/api/scene/latest?projectId=none`);
    assert.equal(miss.status, 404);
  } finally {
    await close(server);
  }
});
