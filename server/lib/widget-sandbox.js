// Widget HTML sanitizer for server-side figure handling.
// Keep in sync with src/lib/widget-sandbox.ts (client).
export const WIDGET_MAX_HTML = 8 * 1024;

export function sanitizeWidgetHtml(html) {
  let s = String(html || '');
  if (s.length > WIDGET_MAX_HTML) {
    s = s.slice(0, WIDGET_MAX_HTML);
  }
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|action|xlink:href)\s*=\s*("|')?\s*javascript:[^"'\s>]*/gi, ' $1=$2#');
  s = s.replace(/\s(href|src)\s*=\s*("|')\s*data:text\/html[^"']*/gi, ' $1=$2#');
  return s.trim();
}
