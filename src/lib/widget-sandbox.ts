// F-10b: widgets sandbox (cliente) — iframe aislado para HTML de agentes.
// sandbox="" (sin scripts/same-origin/forms) + sanitize en ambos lados.

// F-10b (shared core): widget sanitizer for server and client.

export const WIDGET_MAX_HTML = 8 * 1024;

// subset seguro: quita scripts, handlers on*, javascript:, forms, iframes.
export function sanitizeWidgetHtml(html: string): string {
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

export function widgetDoc(opts: { title?: string; html?: string } = {}): string {
  const { title = '', html = '' } = opts;
  const esc = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = sanitizeWidgetHtml(html);
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>body{margin:0;padding:10px 12px;background:#1a1c21;color:#e9ecef;font:13px/1.5 system-ui,sans-serif}h1,h2,h3{margin:.2em 0;font-size:14px}table{border-collapse:collapse}td,th{border:1px solid #444;padding:2px 8px;font-size:12px}a{color:#4d91ff}</style>',
    `</head><body>${title ? `<h3>${esc(title)}</h3>` : ''}${body}</body></html>`
  ].join('');
}


export interface WidgetSpec {
  title?: string;
  html?: string;
  height?: number;
}

/** Monta un widget aislado en `host`. Altura fija (sin scripts, no auto-fit). */
export function renderWidget(host: HTMLElement, spec: WidgetSpec): boolean {
  const html = sanitizeWidgetHtml(spec.html || '');
  if (!html) return false;
  const box = document.createElement('div');
  box.className = 'msg fig fig-widget';
  const frame = document.createElement('iframe');
  frame.className = 'fig-widget-frame';
  frame.setAttribute('sandbox', '');
  frame.setAttribute('title', spec.title || 'Widget');
  frame.setAttribute('height', String(Math.min(600, Math.max(80, Math.round(spec.height || 220)))));
  frame.srcdoc = widgetDoc({ title: spec.title, html });
  box.appendChild(frame);
  host.appendChild(box);
  return true;
}
