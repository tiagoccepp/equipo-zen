// Minimal DOM helpers to avoid unnecessary full-surface rewrites.

export interface ReplaceIfChangedResult {
  changed: boolean;
}

/**
 * Replace container HTML only when the content string differs.
 * Returns whether DOM was updated.
 */
export function replaceInnerHtmlIfChanged(
  container: Element,
  html: string,
  lastHtml?: string | null
): ReplaceIfChangedResult {
  if (lastHtml === html) return { changed: false };
  container.innerHTML = html;
  return { changed: true };
}

/** Cheap hash-like key for list rendering decisions (not cryptographic). */
export function listRenderKey(items: readonly unknown[]): string {
  try {
    return JSON.stringify(items);
  } catch {
    return String(items.length);
  }
}
