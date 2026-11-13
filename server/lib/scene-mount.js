// Safe, additive helper for mounting scene routes without editing core HTTP files.
// Usage from createApiServer (see integration-patches-2026-11-13.md):
//   import { mountSceneRoutes } from './scene-mount.js';
//   mountSceneRoutes(app, { storeOptions });
// or via dynamic import in CJS contexts.

import { createSceneStore } from './scene-store.js';
import { registerSceneRoutes } from './scene-routes.js';

/**
 * Create a scene store and register /api/projects/:id/scene routes on an Express app.
 * Idempotent-unsafe by design (Express will register routes again); call once per app.
 */
export function mountSceneRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('mountSceneRoutes: expected an Express-like app');
  }
  const store = options.store || createSceneStore(options.storeOptions || {});
  registerSceneRoutes(app, { store });
  return { store };
}

export default mountSceneRoutes;
