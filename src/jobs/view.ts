// Jobs view: team history + replay (track T4).
// Mounted into #view-jobs from app.ts (main). No imports from app.ts:
// it only receives { fetchJson } and the container element.

import './jobs.css';
import { listRenderKey } from '../lib/dom-batch.ts';
import { canPollElement } from '../lib/polling.ts';

export type JobsFetch = (path: string, init?: RequestInit) => Promise<unknown>;

export interface MountJobsDeps {
 fetchJson: JobsFetch;
}

interface JobSummary {
 id: string;
 slug?: string;
 objetivo?: string;
 estado: string;
 actualizadoEn?: number;
 rondas?: number | null;
 tests?: {
 celdas?: number;
 pasadas?: number;
 fallidas?: number;
 mecanicas?: number;
 turnos?: number;
 } | null;
 source?: string;
}

interface JobDetailPayload {
 job?: {
 id?: string;
 estado?: string;
 motivo?: string | null;
 fromDisk?: boolean;
 progreso?: {
 fase?: string;
 fasesTotal?: number;
 fasesCompletadas?: number;
 ronda?: number;
 tests?: JobSummary['tests'];
 actualizadoEn?: number;
 anuncios?: Array<{ at?: string; texto?: string }>;
 };
 resumen?: {
 objetivo?: string;
 fases?: number;
 entregas?: Array<{ fase?: number; para?: string; resumen?: string; rework?: boolean }>;
 tests?: JobSummary['tests'];
 rondas?: number;
 preguntas?: string[] | null;
 escalado?: { motivo?: string } | null;
 };
 };
 history?: Array<{ at?: string; tipo?: string; texto?: string }>;
 brief?: Record<string, unknown> | null;
 fases?: Array<{ titulo?: string; title?: string; dueño?: string; dueno?: string; owner?: string; doneCriteria?: string }>;
}

function esc(s: unknown): string {
 return String(s ?? '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
}

function relTime(ts: unknown): string {
 const t = Number(ts);
 if (!t) return '—';
 const d = Date.now() - t;
 if (d < 0) return 'now';
 const m = Math.floor(d / 60000);
 if (m < 1) return 'just now';
 if (m < 60) return `${m} min ago`;
 const h = Math.floor(m / 60);
 if (h < 24) return `${h} h ago`;
 return `${Math.floor(h / 24)} d ago`;
}

const ESTADO_ICON: Record<string, string> = {
 aprobado: 'OK',
 escalado: 'Warning:',
 fallo: 'Failed',
 encolado: '…',
 preguntas: '?',
 brief_ok: '●'
};

function estadoIcon(estado: string): string {
 return ESTADO_ICON[estado] || '·';
}

function testsLine(tests: JobSummary['tests']): string {
 if (!tests || typeof tests.celdas !== 'number') return '';
 const fallidas = Number(tests.fallidas || 0);
 const cls = fallidas > 0 ? 'jobs-tests-bad' : 'jobs-tests-ok';
 return `<span class="${cls}">${Number(tests.pasadas || 0)}/${Number(tests.celdas || 0)} checks</span>`;
}

export function mountJobs(el: HTMLElement, deps: MountJobsDeps): () => void {
 let dead = false;
 let jobs: JobSummary[] = [];
 let selectedId: string | null = null;
 let busy = false;
 let lastListKey = '';

 el.classList.add('jobs');
 el.innerHTML = `
 <div class="jobs-head">
 <div>
 <h2>Jobs</h2>
 <p class="jobs-sub">Team history · step by step · replay</p>
 </div>
 <button class="jobs-refresh" type="button" title="Refresh list">↻ Refresh</button>
 </div>
 <p class="jobs-error" hidden></p>
 <div class="jobs-body">
 <ul class="jobs-list" aria-label="Job history"></ul>
 <div class="jobs-detail" aria-live="polite">
 <p class="jobs-empty">Pick a job to see the step-by-step view.</p>
 </div>
 </div>`;

 const listEl = el.querySelector('.jobs-list') as HTMLUListElement;
 const detailEl = el.querySelector('.jobs-detail') as HTMLElement;
 const errorEl = el.querySelector('.jobs-error') as HTMLElement;
 const refreshBtn = el.querySelector('.jobs-refresh') as HTMLButtonElement;

 function showError(msg: string): void {
 if (dead) return;
 errorEl.textContent = msg;
 errorEl.hidden = false;
 }

 function clearError(): void {
 errorEl.textContent = '';
 errorEl.hidden = true;
 }

 function renderList(force = false): void {
 if (dead) return;
 const key = listRenderKey(jobs.map((j) => [j.id, j.slug, j.estado, j.actualizadoEn, j.rondas, j.tests, j.objetivo, selectedId]));
 if (!force && key === lastListKey) return;
 lastListKey = key;
 if (jobs.length === 0) {
 listEl.innerHTML = '<li class="jobs-none">No jobs yet. When the team gets to work, they show up here.</li>';
 return;
 }
 listEl.innerHTML = jobs.map((j) => `
 <li>
 <button type="button" class="jobs-item${j.id === selectedId ? ' jobs-item-active' : ''}" data-id="${esc(j.id)}" data-slug="${esc(j.slug || '')}">
 <span class="jobs-dot jobs-estado-${esc(j.estado)}" aria-hidden="true">${esc(estadoIcon(j.estado))}</span>
 <span class="jobs-item-main">
 <span class="jobs-item-title">${esc(j.objetivo || j.id)}</span>
 <span class="jobs-item-meta">${esc(j.estado)} · ${esc(relTime(j.actualizadoEn))}${j.tests ? ` · ${testsLine(j.tests)}` : ''}</span>
 </span>
 </button>
 </li>`).join('');
 }

 function renderDetail(payload: JobDetailPayload, summary: JobSummary): void {
 if (dead) return;
 const job = payload.job || {};
 const resumen = job.resumen || {};
 const progreso = job.progreso || {};
 const fases = Array.isArray(payload.fases) ? payload.fases : [];
 const history = Array.isArray(payload.history) && payload.history.length > 0
 ? payload.history
 : (progreso.anuncios || []).map((a) => ({ at: a.at, tipo: 'anuncio', texto: a.texto }));
 const entregas = Array.isArray(resumen.entregas) ? resumen.entregas : [];
 const tests = resumen.tests || progreso.tests || summary.tests || null;
 const objetivo = resumen.objetivo || summary.objetivo || summary.id;
 const estado = job.estado || summary.estado;

 const fasesHtml = fases.length === 0
 ? '<p class="jobs-muted">No phase snapshot.</p>'
 : `<ol class="jobs-fases">${fases.map((f, i) => {
 const title = f.title || f.titulo || 'phase';
 const owner = f.owner || f.dueño || f.dueno || '?';
 return `
 <li>
 <strong>${i + 1}. ${esc(title)}</strong>
 <span class="jobs-muted">→ ${esc(owner)} · done: ${esc(f.doneCriteria || '—')}</span>
 </li>`;
 }).join('')}</ol>`;

 const entregasHtml = entregas.length === 0
 ? '<p class="jobs-muted">No deliveries recorded.</p>'
 : `<ul class="jobs-entregas">${entregas.map((e) => `
 <li>
 <span class="jobs-tag">phase ${esc(String(e.fase ?? '?'))} · ${esc(e.para || '?')}${e.rework ? ' · rework' : ''}</span>
 <p>${esc(e.resumen || '')}</p>
 </li>`).join('')}</ul>`;

 const historyHtml = history.length === 0
 ? '<p class="jobs-muted">No events.</p>'
 : `<ol class="jobs-history">${history.map((h) => `
 <li>
 <span class="jobs-tag">${esc(h.tipo || 'event')}</span>
 <span>${esc(h.texto || '')}</span>
 </li>`).join('')}</ol>`;

 detailEl.innerHTML = `
 <div class="jobs-detail-head">
 <div>
 <h3>${esc(objetivo)}</h3>
 <p class="jobs-muted jobs-idline"><code>${esc(summary.id)}</code> · ${esc(estado)}${job.fromDisk ? ' · on disk' : ''}${job.motivo ? ` · ${esc(job.motivo)}` : ''}</p>
 </div>
 <button class="jobs-replay" type="button" ${busy ? 'disabled' : ''}>↻ Replay</button>
 </div>
 ${resumen.escalado?.motivo ? `<p class="jobs-escalado">Warning: Escalated: ${esc(resumen.escalado.motivo)}</p>` : ''}
 <div class="jobs-stats">
 <span>Phases: <strong>${esc(String(progreso.fasesTotal ?? fases.length ?? 0))}</strong></span>
 <span>Round: <strong>${esc(String(progreso.ronda ?? resumen.rondas ?? 0))}</strong></span>
 <span>Tests: <strong>${tests && typeof tests.celdas === 'number' ? `${Number(tests.pasadas || 0)}/${Number(tests.celdas || 0)}` : '—'}</strong></span>
 </div>
 <h4>Phases</h4>
 ${fasesHtml}
 <h4>Deliveries</h4>
 ${entregasHtml}
 <h4>Step by step</h4>
 ${historyHtml}`;

 const replayBtn = detailEl.querySelector('.jobs-replay') as HTMLButtonElement | null;
 replayBtn?.addEventListener('click', () => void onReplay(summary));
 }

 async function loadList(): Promise<void> {
 if (dead || busy) return;
 // If the view is temporarily detached/hidden, avoid useless fetch churn.
 if (!canPollElement(el) && jobs.length > 0) return;
 busy = true;
 clearError();
 refreshBtn.disabled = true;
 try {
 const data = (await deps.fetchJson('/api/team/jobs?limit=30')) as { jobs?: JobSummary[] };
 if (dead) return;
 jobs = Array.isArray(data?.jobs) ? data.jobs : [];
 if (selectedId && !jobs.some((j) => j.id === selectedId)) selectedId = null;
 renderList();
 } catch (err) {
 showError(`Could not load history: ${err instanceof Error ? err.message : String(err)}`);
 } finally {
 busy = false;
 refreshBtn.disabled = false;
 }
 }

 async function select(id: string, slug: string): Promise<void> {
 if (dead) return;
 selectedId = id;
 renderList(true);
 detailEl.innerHTML = '<p class="jobs-muted">Loading detail…</p>';
 clearError();
 try {
 const q = slug ? `?slug=${encodeURIComponent(slug)}` : '';
 const payload = (await deps.fetchJson(`/api/team/jobs/${encodeURIComponent(id)}${q}`)) as JobDetailPayload;
 if (dead || selectedId !== id) return;
 const summary = jobs.find((j) => j.id === id) || { id, slug, estado: payload.job?.estado || 'unknown' };
 renderDetail(payload, summary);
 } catch (err) {
 if (dead || selectedId !== id) return;
 detailEl.innerHTML = `<p class="jobs-error-inline">Could not load detail: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
 }
 }

 async function onReplay(summary: JobSummary): Promise<void> {
 if (dead || busy) return;
 busy = true;
 clearError();
 const btn = detailEl.querySelector('.jobs-replay') as HTMLButtonElement | null;
 if (btn) {
 btn.disabled = true;
 btn.textContent = 'Re-queueing…';
 }
 try {
 const data = (await deps.fetchJson(`/api/team/jobs/${encodeURIComponent(summary.id)}/replay`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(summary.slug ? { slug: summary.slug } : {})
 })) as { jobId?: string; estado?: string };
 if (dead) return;
 detailEl.insertAdjacentHTML('afterbegin',
 `<p class="jobs-replay-ok">↻ Re-queued as <code>${esc(data?.jobId || '?')}</code> (${esc(data?.estado || '?')}).</p>`);
 busy = false;
 await loadList();
 if (data?.jobId && !dead) await select(data.jobId, summary.slug || '');
 } catch (err) {
 busy = false;
 showError(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
 if (btn) {
 btn.disabled = false;
 btn.textContent = '↻ Replay';
 }
 }
 }

 listEl.addEventListener('click', (ev) => {
 const btn = (ev.target as HTMLElement).closest('.jobs-item') as HTMLButtonElement | null;
 if (!btn) return;
 void select(btn.dataset.id || '', btn.dataset.slug || '');
 });
 refreshBtn.addEventListener('click', () => void loadList());
 void loadList();

 return () => {
 dead = true;
 el.classList.remove('jobs');
 el.innerHTML = '';
 };
}
