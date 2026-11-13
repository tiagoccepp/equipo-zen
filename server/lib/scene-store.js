/**
 * In-memory SceneSpec store. Scenes are project-scoped artifacts: the last
 * valid publish wins as "latest", and we keep a bounded history so the UI can
 * step back. No persistence — the scene is a live, disposable view of a spec.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function createSceneStore({ limit = DEFAULT_LIMIT } = {}) {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))) : DEFAULT_LIMIT;
  // projectId -> { version: number, items: Array<entry> } (items[0] = newest)
  const byProject = new Map();

  function bucket(projectId) {
    const key = String(projectId || '').trim() || 'default';
    let b = byProject.get(key);
    if (!b) {
      b = { version: 0, items: [] };
      byProject.set(key, b);
    }
    return { key, b };
  }

  function publish(projectId, spec, meta = {}) {
    const { key, b } = bucket(projectId);
    b.version += 1;
    const entry = {
      projectId: key,
      version: b.version,
      publishedAt: Date.now(),
      spec
    };
    if (meta.source) entry.source = String(meta.source);
    b.items.unshift(entry);
    if (b.items.length > cap) {
      b.items.length = cap;
    }
    return entry;
  }

  function getLatest(projectId) {
    const { b } = bucket(projectId);
    return b.items[0] || null;
  }

  function list(projectId, opts = {}) {
    const { b } = bucket(projectId);
    const n = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : b.items.length;
    return b.items.slice(0, Math.min(n, b.items.length));
  }

  function clear(projectId) {
    const key = String(projectId || '').trim() || 'default';
    byProject.delete(key);
  }

  function stats() {
    let projects = 0;
    let scenes = 0;
    for (const b of byProject.values()) {
      projects += 1;
      scenes += b.items.length;
    }
    return { projects, scenes };
  }

  return { publish, getLatest, list, clear, stats, _cap: cap };
}
