// Additive integration helper for the Stage (3D scene) module.
// Intended to be lazy-loaded from app.ts to avoid pulling Three.js into the initial bundle.

import type { SceneSpec } from '../stage/spec.ts';

export interface SceneMountHandle {
  root: HTMLElement;
  destroy: () => void;
  refresh: () => Promise<void>;
}

export interface SceneMountOptions {
  container: HTMLElement;
  spec?: SceneSpec;
  projectId?: string;
}

/**
 * Lazily mount the stage view into an existing container.
 * Uses the real stage API (mountStage/fetchLatestScene).
 */
export async function mountProjectScene(options: SceneMountOptions): Promise<SceneMountHandle> {
  // @ts-expect-error - Vite CSS side-effect import
  await import('../stage/stage.css');
  const stage = await import('../stage/stage.ts');

  options.container.replaceChildren();
  const root = document.createElement('div');
  root.className = 'scene-integration-root';
  root.style.width = '100%';
  root.style.height = '100%';
  options.container.appendChild(root);

  let spec = options.spec;
  if (!spec && options.projectId) {
    const env = await stage.fetchLatestScene(options.projectId);
    spec = env?.spec;
  }

  const handle = stage.mountStage({ container: root, spec, projectId: options.projectId });
  return {
    root,
    destroy: () => {
      handle.dispose();
      if (root.parentElement === options.container) options.container.replaceChildren();
    },
    refresh: async () => {
      if (!options.projectId) return;
      const env = await stage.fetchLatestScene(options.projectId);
      if (env?.spec) handle.setSpec(env.spec);
    }
  };
}

/** Prefetch stage chunk after idle so first open is faster. */
export function prefetchSceneModule(): void {
  const run = () => { void import('../stage/stage.ts'); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}
