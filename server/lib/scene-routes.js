import { validateSceneSpec } from './scene-spec.js';

/**
 * HTTP surface for generative 3D scenes.
 *
 *   POST /api/scene                       body: { projectId?, spec } or { projectId?, scene }
 *   GET  /api/scene/latest?projectId=     -> { scene } | 404
 *   GET  /api/scene/list?projectId=&n=    -> { scenes: [...] }
 *
 * A "scene" envelope is the stored record: { projectId, version, publishedAt, spec }.
 */
export function registerSceneRoutes(app, { store } = {}) {
  if (!app || !store) {
    throw new Error('registerSceneRoutes requires an express app and a scene store');
  }

  app.post('/api/scene', (req, res) => {
    const body = req.body || {};
    const rawSpec = body.spec ?? body.scene;
    if (!rawSpec || typeof rawSpec !== 'object') {
      return res.status(400).json({ error: 'spec (or scene) object required' });
    }
    const result = validateSceneSpec(rawSpec);
    if (!result.ok || !result.spec) {
      return res.status(422).json({ error: 'invalid scene spec', errors: result.errors, warnings: result.warnings });
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
    const entry = store.publish(projectId, result.spec, { source: body.source });
    return res.status(201).json({ ok: true, scene: entry, warnings: result.warnings });
  });

  app.get('/api/scene/latest', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const scene = store.getLatest(projectId);
    if (!scene) {
      return res.status(404).json({ error: 'no scene' });
    }
    return res.json({ scene });
  });

  app.get('/api/scene/list', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const n = Number(req.query.n ?? req.query.limit);
    const scenes = store.list(projectId, Number.isFinite(n) ? { limit: n } : {});
    return res.json({ scenes });
  });
}
