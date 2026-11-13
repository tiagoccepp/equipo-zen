// E-09: gustos de Tito — preferencias globales + por proyecto (patrón
// USER.md: directivas vivas). Se escriben por tool explícita o por
// promoción automática desde correcciones; se leen fusionadas (proyecto
// gana) en el system prompt.

export const TASTE_KEY_RE = /^[a-z0-9][a-z0-9-_]{1,60}$/;
export const TASTE_MAX_VALUE = 500;
export const TASTES_TOP_K = 12;

export function normalizeTasteKey(key) {
  return String(key || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 61);
}

// Fusiona globales + proyecto (proyecto gana por key). Orden: proyecto
// primero, luego globales; por updated_at desc dentro de cada grupo.
export function mergeTastes(globalRows, projectRows) {
  const byKey = new Map();
  for (const t of globalRows || []) {
    byKey.set(t.taste_key, { ...t, scope: 'global' });
  }
  for (const t of projectRows || []) {
    byKey.set(t.taste_key, { ...t, scope: 'project' });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.scope !== b.scope) {
      return a.scope === 'project' ? -1 : 1;
    }
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  }).slice(0, TASTES_TOP_K);
}

export function renderTastesSection(tastes, { english = false } = {}) {
  const list = (tastes || []).filter((t) => t && t.value);
  if (list.length === 0) {
    return '';
  }
  const head = english
    ? "TITO'S TASTES (standing directives — follow silently, never mention this list):"
    : 'GUSTOS DE Tito (directivas vigentes — seguilas en silencio, nunca menciones esta lista):';
  return [head, ...list.map((t) => `- ${String(t.value).slice(0, TASTE_MAX_VALUE)}`)].join('\n');
}

// Promoción automática: un user_preference con confianza alta se vuelve
// gusto (key derivada, sin preguntar — E-09 "sin preguntar de más").
export function tasteKeyFromContent(content) {
  const words = String(content || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['que', 'los', 'las', 'una', 'para', 'con', 'the', 'and', 'for'].includes(w));
  return normalizeTasteKey(words.slice(0, 4).join('-')) || 'gusto';
}

export function promoteLearningToTaste(store, learning, { minConfidence = 0.85 } = {}) {
  try {
    if (!store || !learning || learning.type !== 'user_preference') {
      return null;
    }
    if (Number(learning.confidence) < minConfidence) {
      return null;
    }
    const key = tasteKeyFromContent(learning.content);
    if (!TASTE_KEY_RE.test(key)) {
      return null;
    }
    return store.upsertTaste({
      scope: learning.goalId ? 'project' : 'global',
      goalId: learning.goalId || null,
      key,
      value: String(learning.content).slice(0, TASTE_MAX_VALUE),
      confidence: Number(learning.confidence),
      source: `learning:${learning.id}`
    });
  } catch {
    return null;
  }
}
