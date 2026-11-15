// T6: HUD/widget de latencia (p50/latest) — "se siente rápido" medible.
// Módulo liviano: fetch read-only a /api/latency/recent y render unobtrusivo.

type StageStats = {
  count?: number;
  latest?: number | null;
  p50?: number | null;
  p95?: number | null;
  avg?: number | null;
};

type LatencySummary = {
  turns?: number;
  totalRecorded?: number;
  latest?: {
    at?: number;
    agentName?: string | null;
    latency?: Record<string, number | null>;
  } | null;
  stages?: Record<string, StageStats>;
};

function fmtMs(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}s`;
  return `${Math.round(n)}ms`;
}

function fmtPair(label: string, latest: unknown, p50: unknown): string {
  return `${label} ${fmtMs(latest)} · p50 ${fmtMs(p50)}`;
}

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('latency-hud-style')) return;
  const style = document.createElement('style');
  style.id = 'latency-hud-style';
  style.textContent = `
    .latency-hud{position:fixed;right:12px;bottom:12px;z-index:60;max-width:320px;
      font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      color:rgba(232,236,241,.92);background:rgba(14,16,19,.78);border:1px solid rgba(255,255,255,.10);
      border-radius:10px;backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.28)}
    .latency-hud[hidden]{display:none}
    .latency-hud-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.08)}
    .latency-hud-title{font-weight:600;letter-spacing:.02em;color:#9fd7c6}
    .latency-hud-meta{color:rgba(232,236,241,.55)}
    .latency-hud-body{padding:7px 9px;display:grid;gap:4px}
    .latency-hud-row{display:flex;justify-content:space-between;gap:10px}
    .latency-hud-k{color:rgba(232,236,241,.62)}
    .latency-hud-v{color:#e8ecf1;text-align:right}
    .latency-hud-foot{padding:0 9px 7px;color:rgba(232,236,241,.45)}
    @media (max-width: 700px){.latency-hud{right:8px;bottom:8px;max-width:260px}}
  `;
  document.head.appendChild(style);
}

function render(root: HTMLElement, payload: any) {
  const summary: LatencySummary = payload?.summary || {};
  const stages = summary.stages || {};
  const latest = summary.latest?.latency || {};
  const turns = Number(summary.turns || 0);
  const total = Number(summary.totalRecorded || 0);
  const rows: Array<[string, string]> = [
    ['TTFS', fmtPair('', latest.ttfsMs, stages.ttfsMs?.p50).replace(/^ /, '')],
    ['TTFR', fmtPair('', latest.ttfrMs, stages.ttfrMs?.p50).replace(/^ /, '')],
    ['E2E', fmtPair('', latest.e2eMs, stages.e2eMs?.p50).replace(/^ /, '')],
    ['LLM', fmtPair('', latest.llmTtfbMs, stages.llmTtfbMs?.p50).replace(/^ /, '')],
    ['TTS', fmtPair('', latest.ttsTtfbMs, stages.ttsTtfbMs?.p50).replace(/^ /, '')],
  ].filter(([, v]) => v && !/^— · p50 —$/.test(v)) as Array<[string, string]>;

  const body = rows.length
    ? rows.map(([k, v]) => `<div class="latency-hud-row"><span class="latency-hud-k">${k}</span><span class="latency-hud-v">${v}</span></div>`).join('')
    : `<div class="latency-hud-row"><span class="latency-hud-k">Estado</span><span class="latency-hud-v">sin turnos medidos</span></div>`;

  const who = summary.latest?.agentName ? ` · ${String(summary.latest.agentName)}` : '';
  root.innerHTML = `
    <div class="latency-hud-head">
      <span class="latency-hud-title">Latency</span>
      <span class="latency-hud-meta">${turns}/${total}${who}</span>
    </div>
    <div class="latency-hud-body">${body}</div>
    <div class="latency-hud-foot">latest · p50 (recientes)</div>
  `;
}

async function fetchLatency(limit = 20): Promise<any | null> {
  try {
    const res = await fetch(`/api/latency/recent?limit=${encodeURIComponent(String(limit))}`, {
      headers: { 'accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function mountLatencyHud(opts: { container?: HTMLElement | null; intervalMs?: number; limit?: number } = {}) {
  if (typeof document === 'undefined') return { unmount() {} };
  ensureStyles();
  const host = opts.container || document.body;
  let root = host.querySelector<HTMLElement>('.latency-hud');
  if (!root) {
    root = document.createElement('aside');
    root.className = 'latency-hud';
    root.setAttribute('aria-label', 'Latency HUD');
    root.setAttribute('data-latency-hud', 'true');
    host.appendChild(root);
  }

  let stopped = false;
  const limit = Number(opts.limit) || 20;
  const refresh = async () => {
    if (stopped) return;
    const data = await fetchLatency(limit);
    if (stopped || !root) return;
    if (data?.ok) render(root, data);
    else render(root, { summary: { turns: 0, totalRecorded: 0, stages: {}, latest: null } });
  };

  void refresh();
  const timer = window.setInterval(() => { void refresh(); }, Math.max(2000, Number(opts.intervalMs) || 5000));

  return {
    unmount() {
      stopped = true;
      window.clearInterval(timer);
      try { root?.remove(); } catch { /* noop */ }
    },
    refresh,
  };
}

// Auto-mount discreto en consola web (sin refactor pesado de app.ts).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const w = window as any;
  if (!w.__JABS_LATENCY_HUD_MOUNTED__) {
    w.__JABS_LATENCY_HUD_MOUNTED__ = true;
    const start = () => {
      try { w.__JABS_LATENCY_HUD__ = mountLatencyHud(); } catch { /* noop */ }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
}
