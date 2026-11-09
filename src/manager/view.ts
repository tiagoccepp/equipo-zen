// T5 — Manager MCP/skills: vista pura. Main la monta en #view-manager.
// Uso: import { mountManager } from './manager/view.ts'; import './manager/manager.css';
//   mountManager(el, { fetchJson: async (path, init) => (await fetch(path, init)).json() })
// Endpoints (los cablea main en http.js): GET /api/mcp/status + POST /api/mcp/reconnect.

export interface McpServerStatus {
  name: string;
  configured: boolean;
  alive: boolean;
  tools: string[];
}

export interface McpSkillStatus {
  name: string;
  scopes: string[];
}

export interface McpStatus {
  servers: McpServerStatus[];
  skills: McpSkillStatus[];
  gaps: string[];
}

export type FetchJson = (path: string, init?: RequestInit) => Promise<unknown>;

export interface ManagerOptions {
  fetchJson?: FetchJson;
}

export interface ManagerHandle {
  destroy: () => void;
  refresh: () => Promise<void>;
}

const STATUS_PATH = '/api/mcp/status';
const RECONNECT_PATH = '/api/mcp/reconnect';

function defaultFetchJson(path: string, init?: RequestInit): Promise<unknown> {
  return fetch(path, { headers: { Accept: 'application/json' }, ...init }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  });
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isStatus(v: unknown): v is McpStatus {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.servers) && Array.isArray(o.skills) && Array.isArray(o.gaps);
}

function pillFor(s: McpServerStatus): { cls: string; label: string } {
  if (!s.configured) return { cls: 'mgr-stale', label: 'stale' };
  if (s.alive) return { cls: 'mgr-ok', label: 'vivo' };
  return { cls: 'mgr-bad', label: 'caído' };
}

function render(status: McpStatus | null, error: string): string {
  const servers = status?.servers ?? [];
  const skills = status?.skills ?? [];
  const gaps = status?.gaps ?? [];

  const serverRows = servers.length === 0
    ? `<tr><td colspan="4" class="mgr-dim">Sin servers — configurá PABLO_MCP_SERVERS o ~/.config/equipo-mcp.json</td></tr>`
    : servers.map((s) => {
        const pill = pillFor(s);
        const tools = s.tools.length === 0
          ? '<span class="mgr-dim">—</span>'
          : s.tools.map((t) => `<code class="mgr-code">${esc(t)}</code>`).join(' ');
        return `<tr>
          <td><strong>${esc(s.name)}</strong>${s.configured ? '' : ' <span class="mgr-dim">(no configurado)</span>'}</td>
          <td><span class="mgr-pill ${pill.cls}">${pill.label}</span></td>
          <td class="mgr-tools">${tools}</td>
          <td class="mgr-num">${s.tools.length}</td>
        </tr>`;
      }).join('');

  const skillItems = skills.length === 0
    ? `<li class="mgr-dim">Sin skills cargadas.</li>`
    : skills.map((k) => {
        const scopes = k.scopes.map((sc) => `<span class="mgr-scope">${esc(sc)}</span>`).join(' ');
        return `<li><strong>${esc(k.name)}</strong> ${scopes}</li>`;
      }).join('');

  const gapItems = gaps.length === 0
    ? `<li class="mgr-ok-text">Sin gaps — todo vivo. 🎉</li>`
    : gaps.map((g) => `<li>${esc(g)}</li>`).join('');

  return `
    <div class="mgr-head">
      <div>
        <h2 class="mgr-title">Manager MCP/skills</h2>
        <p class="mgr-sub">${servers.length} server(s) · ${skills.length} skill(s) · ${gaps.length} gap(s)</p>
      </div>
      <div class="mgr-actions">
        <button type="button" class="mgr-btn" data-act="refresh">↻ Actualizar</button>
        <button type="button" class="mgr-btn mgr-primary" data-act="reconnect">⟳ Re-conectar MCP</button>
      </div>
    </div>
    ${error ? `<p class="mgr-error" role="alert">${esc(error)}</p>` : ''}
    <section class="mgr-card" aria-label="Servers MCP">
      <h3>Servers</h3>
      <div class="mgr-table-wrap">
        <table class="mgr-table">
          <thead><tr><th>Nombre</th><th>Estado</th><th>Tools</th><th>#</th></tr></thead>
          <tbody>${serverRows}</tbody>
        </table>
      </div>
    </section>
    <div class="mgr-cols">
      <section class="mgr-card" aria-label="Skills">
        <h3>Skills</h3>
        <ul class="mgr-list">${skillItems}</ul>
      </section>
      <section class="mgr-card" aria-label="Gaps">
        <h3>Gaps honestos</h3>
        <ul class="mgr-list mgr-gaps">${gapItems}</ul>
      </section>
    </div>
  `;
}

export function mountManager(container: HTMLElement, opts: ManagerOptions = {}): ManagerHandle {
  const fetchJson: FetchJson = opts.fetchJson ?? defaultFetchJson;
  container.classList.add('mgr');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Manager MCP y skills');

  let alive = true;
  let busy = false;
  let status: McpStatus | null = null;
  let error = '';

  function paint(): void {
    if (!alive) return;
    container.innerHTML = render(status, error);
  }

  async function refresh(): Promise<void> {
    if (!alive || busy) return;
    busy = true;
    try {
      const data = await fetchJson(STATUS_PATH);
      if (!alive) return;
      if (isStatus(data)) {
        status = data;
        error = '';
      } else if (data && typeof data === 'object' && isStatus((data as Record<string, unknown>).status)) {
        status = (data as Record<string, unknown>).status as McpStatus;
        error = '';
      } else {
        error = 'Respuesta inesperada de /api/mcp/status.';
      }
    } catch (err) {
      if (!alive) return;
      error = err instanceof Error ? `No se pudo cargar: ${err.message}` : 'No se pudo cargar el estado.';
    } finally {
      busy = false;
      paint();
    }
  }

  async function reconnect(): Promise<void> {
    if (!alive || busy) return;
    busy = true;
    error = '';
    paint();
    try {
      await fetchJson(RECONNECT_PATH, { method: 'POST' });
      if (!alive) return;
      // Tras reconectar, el status fresco manda.
      busy = false;
      await refresh();
      return;
    } catch (err) {
      if (!alive) return;
      error = err instanceof Error ? `Re-conexión falló: ${err.message}` : 'Re-conexión falló.';
    } finally {
      busy = false;
      paint();
    }
  }

  container.addEventListener('click', onClick);

  function onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest?.('[data-act]') as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset.act === 'refresh') void refresh();
    else if (btn.dataset.act === 'reconnect') void reconnect();
  }

  paint();
  void refresh();

  return {
    refresh,
    destroy: () => {
      alive = false;
      container.removeEventListener('click', onClick);
      container.innerHTML = '';
      container.classList.remove('mgr');
    }
  };
}
