// M-02: figures view — draws validated specs into the stream.
// diagram reuses the mermaid renderer (QW-06); the rest is plain DOM.

import { mountMermaid, type MermaidMountCtx } from './mermaid-inline.ts';
import { renderWidget } from './widget-sandbox.ts';

export interface Figure {
 kind: 'diagram' | 'progress' | 'checklist' | 'notice' | 'glyph' | 'chart' | 'slide' | 'widget';
 code?: string;
 pct?: number;
 label?: string;
 items?: Array<{ text: string; done: boolean }>;
 tone?: string;
 text?: string;
 name?: string;
 chartType?: 'bar' | 'line' | 'pie';
 title?: string;
 labels?: string[];
 series?: Array<{ name: string; values: number[] }>;
 bullets?: string[];
 html?: string;
 height?: number;
 // M-10: stable key (upsert) + ephemeral lane.
 key?: string;
 ephemeral?: boolean;
}

// M-03: SVG computed from the chart spec. Pure (testable without DOM), no eval:
// just arithmetic on numbers + escaped labels.
const CHART_COLORS = ['#4c6ef5', '#0ca678', '#f08c00', '#9c36b5'];

function escXml(s: string): string {
 return String(s ?? '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
}

export function chartSvg(figure: Figure): string {
 const labels = Array.isArray(figure.labels) ? figure.labels : [];
 const series = Array.isArray(figure.series) ? figure.series : [];
 const type = figure.chartType === 'pie' ? 'pie' : figure.chartType === 'line' ? 'line' : 'bar';
 const W = 320;
 const H = 180;
 const pad = 8;
 let body = '';
 if (type === 'pie') {
 const values = series[0]?.values || [];
 const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
 const cx = 90;
 const cy = 90;
 const r = 70;
 let ang = -Math.PI / 2;
 values.forEach((v, i) => {
 const frac = Math.max(0, v) / total;
 const a2 = ang + frac * Math.PI * 2;
 const large = frac > 0.5 ? 1 : 0;
 const x1 = cx + r * Math.cos(ang);
 const y1 = cy + r * Math.sin(ang);
 const x2 = cx + r * Math.cos(a2);
 const y2 = cy + r * Math.sin(a2);
 body += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${CHART_COLORS[i % 4]}"/>`;
 ang = a2;
 });
 labels.forEach((l, i) => {
 body += `<text x="180" y="${40 + i * 20}" fill="${CHART_COLORS[i % 4]}" font-size="12">▪ ${escXml(l)}</text>`;
 });
 } else {
 const max = Math.max(1, ...series.flatMap((s) => s.values));
 const n = labels.length;
 const plotW = W - pad * 2 - 30;
 const plotH = H - pad * 2 - 24;
 const baseY = pad + plotH;
 const slot = plotW / Math.max(1, n);
 if (type === 'bar') {
 const bw = Math.min(28, (slot / Math.max(1, series.length)) * 0.7);
 series.forEach((s, si) => {
 s.values.forEach((v, i) => {
 const h = Math.max(0, (v / max) * plotH);
 const x = pad + 30 + i * slot + si * bw + (slot - series.length * bw) / 2;
 body += `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${CHART_COLORS[si % 4]}"/>`;
 });
 });
 } else {
 series.forEach((s, si) => {
 const pts = s.values.map((v, i) => {
 const x = pad + 30 + i * slot + slot / 2;
 const y = baseY - Math.max(0, (v / max) * plotH);
 return `${x.toFixed(1)},${y.toFixed(1)}`;
 }).join(' ');
 body += `<polyline points="${pts}" fill="none" stroke="${CHART_COLORS[si % 4]}" stroke-width="2"/>`;
 });
 }
 labels.forEach((l, i) => {
 const x = pad + 30 + i * slot + slot / 2;
 body += `<text x="${x.toFixed(1)}" y="${baseY + 14}" fill="#868e96" font-size="10" text-anchor="middle">${escXml(l.slice(0, 10))}</text>`;
 });
 series.forEach((s, si) => {
 if (!s.name) return;
 body += `<text x="${pad + 30 + si * 90}" y="${pad + 4}" fill="${CHART_COLORS[si % 4]}" font-size="10">▪ ${escXml(s.name.slice(0, 12))}</text>`;
 });
 }
 const title = figure.title ? `<text x="${W / 2}" y="14" fill="#e9ecef" font-size="12" text-anchor="middle">${escXml(figure.title)}</text>` : '';
 return `<svg viewBox="0 0 ${W} ${H}" class="fig-chart" role="img" aria-label="${escXml(figure.title || 'Chart')}">${title}${body}</svg>`;
}

export interface FiguresCtx extends MermaidMountCtx {
 setGlyph?: (name: string) => void;
}

export { createFigureQueue, defaultFigureQueue, type IdleSchedule } from './figure-queue.ts';

// M-10: upsert by key — if a figure with the same key already exists in the
// host, its content is replaced (progress bars UPDATE instead of
// spamming). Without a key: classic append (persistent lane).
export function upsertFigure(host: HTMLElement, figure: Figure, ctx: FiguresCtx): boolean {
 if (figure && typeof figure.key === 'string' && figure.key) {
 const kids = Array.from(host.children || []) as HTMLElement[];
 const prev = kids.find((n) => n.getAttribute && n.getAttribute('data-fig-key') === figure.key);
 if (prev) {
 const tmp = document.createElement('div');
 const ok = renderFigure(tmp, { ...figure, key: undefined }, ctx);
 if (!ok || tmp.children.length === 0) return false;
 const fresh = tmp.children[0] as HTMLElement;
 fresh.setAttribute('data-fig-key', figure.key as string);
 prev.replaceWith(fresh);
 return true;
 }
 }
 const before = host.children?.length || 0;
 const ok = renderFigure(host, figure, ctx);
 if (ok && figure && figure.key && host.children && host.children.length > before) {
 (host.children[host.children.length - 1] as HTMLElement).setAttribute?.('data-fig-key', figure.key);
 }
 return ok;
}

/** Draws a figure into `host`. Returns false if the spec can't be drawn. */
export function renderFigure(host: HTMLElement, figure: Figure, ctx: FiguresCtx): boolean {
 if (!figure || typeof figure.kind !== 'string') return false;
 switch (figure.kind) {
 case 'glyph': {
 // Legacy compat: the glyph morphs the orb, it doesn't take a stream slot.
 if (figure.name) ctx.setGlyph?.(figure.name);
 return true;
 }
 case 'diagram': {
 if (!figure.code) return false;
 const box = document.createElement('div');
 box.className = 'msg fig';
 const b = document.createElement('b');
 b.textContent = 'figure';
 box.appendChild(b);
 mountMermaid(box, figure.code, ctx);
 host.appendChild(box);
 return true;
 }
 case 'progress': {
 const pct = Math.max(0, Math.min(100, Math.round(Number(figure.pct) || 0)));
 const box = document.createElement('div');
 box.className = 'msg fig';
 const bar = document.createElement('div');
 bar.className = 'fig-bar';
 bar.setAttribute('role', 'progressbar');
 bar.setAttribute('aria-valuenow', String(pct));
 bar.setAttribute('aria-valuemin', '0');
 bar.setAttribute('aria-valuemax', '100');
 bar.setAttribute('aria-label', figure.label || 'Progress');
 const fill = document.createElement('div');
 fill.className = 'fig-fill';
 fill.style.width = `${pct}%`;
 bar.appendChild(fill);
 box.appendChild(bar);
 if (figure.label) {
 const lab = document.createElement('div');
 lab.className = 'fig-label';
 lab.textContent = `${figure.label} — ${pct}%`;
 box.appendChild(lab);
 }
 host.appendChild(box);
 return true;
 }
 case 'checklist': {
 if (!Array.isArray(figure.items) || figure.items.length === 0) return false;
 const box = document.createElement('div');
 box.className = 'msg fig';
 const ul = document.createElement('ul');
 ul.className = 'fig-check';
 for (const it of figure.items) {
 const li = document.createElement('li');
 li.className = it.done ? 'done' : '';
 li.textContent = `${it.done ? '[x]' : '[ ]'} ${it.text}`;
 ul.appendChild(li);
 }
 box.appendChild(ul);
 host.appendChild(box);
 return true;
 }
 case 'chart': {
 if (!Array.isArray(figure.labels) || !Array.isArray(figure.series)) return false;
 const box = document.createElement('div');
 box.className = 'msg fig';
 const wrap = document.createElement('div');
 wrap.className = 'fig-chart-wrap';
 // Markup generated by chartSvg (numbers + escaped labels): safe.
 wrap.innerHTML = chartSvg(figure);
 box.appendChild(wrap);
 host.appendChild(box);
 return true;
 }
 case 'slide': {
 if (!figure.title || !Array.isArray(figure.bullets) || figure.bullets.length === 0) return false;
 const box = document.createElement('div');
 box.className = 'msg fig fig-slide';
 const h = document.createElement('div');
 h.className = 'fig-slide-title';
 h.textContent = figure.title;
 box.appendChild(h);
 const ul = document.createElement('ul');
 ul.className = 'fig-slide-list';
 for (const b of figure.bullets) {
 const li = document.createElement('li');
 li.textContent = b;
 ul.appendChild(li);
 }
 box.appendChild(ul);
 host.appendChild(box);
 return true;
 }
 case 'widget': {
 return renderWidget(host, { title: figure.title, html: figure.html, height: figure.height });
 }
 case 'notice': {
 if (!figure.text) return false;
 const box = document.createElement('div');
 box.className = `msg sys fig-notice fig-tone-${figure.tone || 'info'}`;
 const b = document.createElement('b');
 b.textContent = 'notice';
 box.appendChild(b);
 box.appendChild(document.createTextNode(figure.text));
 host.appendChild(box);
 return true;
 }
 default:
 return false;
 }
}
