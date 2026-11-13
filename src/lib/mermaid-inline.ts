// QW-06: Mermaid inline in chat — validated ```mermaid blocks rendered
// as diagrams, with actionable errors + copy code.
// Without a mermaid fence the message renders as plain text (same as before).

import { defaultFigureQueue } from './figure-queue.ts';

const defaultDeferHeavy = defaultFigureQueue.deferHeavy;

export type Segment = { t: 'text'; text: string } | { t: 'mmd'; code: string };

const FENCE_RE = /```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;

/** Splits the message into text / mermaid blocks. Unclosed fence → text. */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const closed = m[0].endsWith('```');
    if (!closed) {
      // Unclosed: not a valid block, stays as literal text.
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
  // Merges adjacent text (e.g. an unclosed fence after a valid one).
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

/** Mermaid error → actionable message (line + likely cause + fix). */
export function mermaidErrorInfo(err: unknown, code: string): MermaidErrorInfo {
  const raw = String((err as { message?: unknown })?.message ?? err ?? '').trim();
  const lineMatch = raw.match(/line\s+(\d+)/i);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  const codeLine = line && line >= 1 ? code.split('\n')[line - 1]?.trim() : '';
  let hint = 'Check the diagram syntax: each line is usually NodeA --> NodeB, with names without spaces or accents.';
  if (/parse error|syntax/i.test(raw)) {
    hint = 'Syntax error: check the arrows (-->), unclosed brackets or odd characters in names. Text with spaces goes in quotes: A["My text"].';
  } else if (/unknown|no diagram|diagram type/i.test(raw)) {
    hint = 'The first line is missing or broken: it must declare the type, e.g. "graph TD", "sequenceDiagram" or "pie".';
  } else if (/render|svg|dom/i.test(raw)) {
    hint = 'Rendering failed (not the syntax): try copying the code and sending it again, or make the diagram smaller.';
  }
  return {
    title: line ? `The diagram has an error on line ${line}` : 'Could not draw this diagram',
    detail: [codeLine ? `Line ${line}: ${codeLine}` : '', raw.slice(0, 220)].filter(Boolean).join('\n'),
    hint
  };
}

/** Clipboard with fallback for webviews without navigator.clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback
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

// ── DOM mount (injectable for tests) ──────────────────────────────────

export interface MermaidApi {
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

export interface MermaidMountCtx {
  loadMermaid: () => Promise<MermaidApi>;
  copy?: (text: string) => Promise<boolean>;
  // M-11: heavy render queue (diagrams one at a time while idle).
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
  const btn = el('button', 'mmd-copy', '⧉ Copy code');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const ok = await copy(code);
    btn.textContent = ok ? '✓ Copied' : '✗ Could not copy';
    setTimeout(() => {
      btn.textContent = '⧉ Copy code';
    }, 1600);
  });
  return btn;
}

/** Mounts a mermaid block in `host`: diagram, or actionable error + copy. */
export function mountMermaid(host: HTMLElement, code: string, ctx: MermaidMountCtx): void {
  const box = el('div', 'mmd');
  const copy = ctx.copy ?? copyText;
  if (!code.trim()) {
    const info = mermaidErrorInfo(new Error('empty diagram'), code);
    box.classList.add('mmd-error');
    box.appendChild(el('div', 'mmd-title', info.title));
    box.appendChild(el('div', 'mmd-hint', 'The mermaid block was empty.'));
    box.appendChild(copyButton(code, copy));
    host.appendChild(box);
    return;
  }
  // M-11: skeleton with shimmer (the text stays for screen readers).
  const loading = el('div', 'mmd-loading fig-skeleton', '⋯ drawing diagram…');
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
      // SVG generated by the lib (securityLevel strict): the only innerHTML in chat.
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

/** Lazy load: mermaid (~1MB) is only fetched when a diagram appears. */
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

/** Text → nodes: plain text + diagrams. Without mermaid, identical to before. */
export function renderRichMessage(div: HTMLElement, text: string, ctx?: MermaidMountCtx): void {
  if (!/```[ \t]*mermaid/i.test(text)) {
    div.appendChild(document.createTextNode(text));
    return;
  }
  // M-11: by default chat diagrams also go through the idle queue.
  const mount = ctx ?? { loadMermaid: loadMermaidReal, deferHeavy: defaultDeferHeavy };
  for (const seg of splitSegments(text)) {
    if (seg.t === 'text') {
      if (seg.text) div.appendChild(document.createTextNode(seg.text));
    } else {
      mountMermaid(div, seg.code, mount);
    }
  }
}
