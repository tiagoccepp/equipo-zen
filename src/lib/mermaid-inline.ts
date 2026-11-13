// QW-06: Mermaid inline en el chat — bloques ```mermaid validados y
// renderizados como diagrama, con error accionable + copiar código.
// Sin fence de mermaid el mensaje se muestra como texto plano (igual que antes).

import { defaultFigureQueue } from './figure-queue.ts';

const defaultDeferHeavy = defaultFigureQueue.deferHeavy;

export type Segment = { t: 'text'; text: string } | { t: 'mmd'; code: string };

const FENCE_RE = /```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;

/** Parte el mensaje en texto / bloques mermaid. Fence sin cerrar → texto. */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const closed = m[0].endsWith('```');
    if (!closed) {
      // Sin cerrar: no es un bloque válido, queda como texto literal.
      break;
    }
    if (m.index > last) {
      out.push({ t: 'text', text: text.slice(last, m.index) });
    }
    out.push({ t: 'mmd', code: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ t: 'text', text: text.slice(last) });
  }
  if (out.length === 0) {
    out.push({ t: 'text', text });
  }
  // Fusiona textos adyacentes (p.ej. fence sin cerrar tras uno válido).
  const merged: Segment[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (s.t === 'text' && prev?.t === 'text') {
      prev.text += s.text;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

export interface MermaidErrorInfo {
  title: string;
  detail: string;
  hint: string;
}

/** Error de mermaid → mensaje accionable (línea + causa probable + arreglo). */
export function mermaidErrorInfo(err: unknown, code: string): MermaidErrorInfo {
  const raw = String((err as { message?: unknown })?.message ?? err ?? '').trim();
  const lineMatch = raw.match(/line\s+(\d+)/i);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  const codeLine = line && line >= 1 ? code.split('\n')[line - 1]?.trim() : '';
  let hint = 'Revisá la sintaxis del diagrama: cada línea suele ser NodoA --> NodoB, con nombres sin espacios ni tildes.';
  if (/parse error|syntax/i.test(raw)) {
    hint = 'Error de sintaxis: fijate en flechas (-->), corchetes sin cerrar o caracteres raros en los nombres. Los textos con espacios van entre comillas: A["Mi texto"].';
  } else if (/unknown|no diagram|diagram type/i.test(raw)) {
    hint = 'Falta o falla la primera línea: tiene que declarar el tipo, p.ej. "graph TD", "sequenceDiagram" o "pie".';
  } else if (/render|svg|dom/i.test(raw)) {
    hint = 'Falló el dibujado (no la sintaxis): probá copiar el código y reenviarlo, o achicar el diagrama.';
  }
  return {
    title: line ? `El diagrama tiene un error en la línea ${line}` : 'No pude dibujar este diagrama',
    detail: [codeLine ? `Línea ${line}: ${codeLine}` : '', raw.slice(0, 220)].filter(Boolean).join('\n'),
    hint
  };
}

/** Clipboard con fallback para webviews sin navigator.clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // cae al fallback
  }
  try {
    const doc = globalThis.document;
    if (!doc) return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ── Montaje DOM (inyectable para tests) ───────────────────────────────

export interface MermaidApi {
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

export interface MermaidMountCtx {
  loadMermaid: () => Promise<MermaidApi>;
  copy?: (text: string) => Promise<boolean>;
  // M-11: cola de renders pesados (diagramas de a uno por idle).
  deferHeavy?: (fn: () => void) => void;
}

let mermaidIdCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function copyButton(code: string, copy: (text: string) => Promise<boolean>): HTMLButtonElement {
  const btn = el('button', 'mmd-copy', '⧉ Copiar código');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const ok = await copy(code);
    btn.textContent = ok ? '✓ Copiado' : '✗ No se pudo copiar';
    setTimeout(() => {
      btn.textContent = '⧉ Copiar código';
    }, 1600);
  });
  return btn;
}

/** Monta un bloque mermaid en `host`: diagrama, o error accionable + copiar. */
export function mountMermaid(host: HTMLElement, code: string, ctx: MermaidMountCtx): void {
  const box = el('div', 'mmd');
  const copy = ctx.copy ?? copyText;
  if (!code.trim()) {
    const info = mermaidErrorInfo(new Error('empty diagram'), code);
    box.classList.add('mmd-error');
    box.appendChild(el('div', 'mmd-title', info.title));
    box.appendChild(el('div', 'mmd-hint', 'El bloque mermaid llegó vacío.'));
    box.appendChild(copyButton(code, copy));
    host.appendChild(box);
    return;
  }
  // M-11: skeleton con shimmer (el texto queda para lectores de pantalla).
  const loading = el('div', 'mmd-loading fig-skeleton', '⋯ dibujando diagrama…');
  loading.setAttribute('aria-busy', 'true');
  box.appendChild(loading);
  box.appendChild(copyButton(code, copy));
  host.appendChild(box);
  const id = `mmd-${Date.now().toString(36)}-${(mermaidIdCounter += 1)}`;
  const run = (): void => {
    void ctx.loadMermaid()
    .then((api) => api.render(id, code))
    .then(({ svg }) => {
      loading.remove();
      const wrap = el('div', 'mmd-svg');
      // SVG generado por la lib (securityLevel strict): único innerHTML del chat.
      wrap.innerHTML = svg;
      box.insertBefore(wrap, box.firstChild);
    })
    .catch((err: unknown) => {
      loading.remove();
      const info = mermaidErrorInfo(err, code);
      box.classList.add('mmd-error');
      box.insertBefore(el('div', 'mmd-title', '⚠ ' + info.title), box.firstChild);
      const detail = el('pre', 'mmd-detail', info.detail);
      box.insertBefore(detail, box.querySelector('.mmd-copy'));
      box.insertBefore(el('div', 'mmd-hint', '→ ' + info.hint), box.querySelector('.mmd-copy'));
    });
  };
  if (ctx.deferHeavy) {
    ctx.deferHeavy(run);
  } else {
    run();
  }
}

let mermaidApiPromise: Promise<MermaidApi> | null = null;

/** Carga diferida: mermaid (~1MB) solo se baja cuando aparece un diagrama. */
export function loadMermaidReal(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import('mermaid').then((mod) => {
      const mermaid = (mod as { default?: MermaidApi & { initialize?: (c: unknown) => void } }).default ?? (mod as unknown as MermaidApi & { initialize?: (c: unknown) => void });
      mermaid.initialize?.({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'var(--mono)'
      });
      return mermaid;
    });
  }
  return mermaidApiPromise;
}

/** Texto → nodos: texto plano + diagramas. Sin mermaid, idéntico a antes. */
export function renderRichMessage(div: HTMLElement, text: string, ctx?: MermaidMountCtx): void {
  if (!/```[ \t]*mermaid/i.test(text)) {
    div.appendChild(document.createTextNode(text));
    return;
  }
  // M-11: por defecto los diagramas del chat también van por la cola idle.
  const mount = ctx ?? { loadMermaid: loadMermaidReal, deferHeavy: defaultDeferHeavy };
  for (const seg of splitSegments(text)) {
    if (seg.t === 'text') {
      if (seg.text) div.appendChild(document.createTextNode(seg.text));
    } else {
      mountMermaid(div, seg.code, mount);
    }
  }
}
