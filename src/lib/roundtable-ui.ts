// Roundtable UI (T4): contained panel to start and display a multi-agent roundtable.
// Calls POST /api/roundtable (server/lib/roundtable-runner.js) and renders transcript.

import { apiJson } from '../client.ts';

type RtAgent = { id: string; name: string; title?: string; role?: string; color?: string };
type RtEntry = { index: number; agentId: string; name: string; role: string; text: string };
type RtResult = {
  topic: string;
  transcript: RtEntry[];
  stopped: { reason: string; turn: number };
  errors: Array<{ turn: number; agentId: string; message: string }>;
  chars: number;
  summary?: string;
};

const STOP_LABEL: Record<string, string> = {
  done: 'Completed (consensus reached)',
  max_turns: 'Stopped: turn limit reached',
  max_chars: 'Stopped: character limit reached',
  skipped: 'Stopped: repeated skips',
  errors: 'Stopped: consecutive errors'
};

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function reasonLabel(reason: string): string {
  return STOP_LABEL[reason] || `Stopped: ${reason}`;
}

export function mountRoundtable(container: HTMLElement, opts: { getCompanyId: () => string }): void {
  if (container.dataset.rtMounted === '1') return;
  container.dataset.rtMounted = '1';

  container.innerHTML = `
    <div class="rt-card">
      <div class="rt-head">
        <div>
          <h3 class="rt-title">Roundtable</h3>
          <p class="rt-desc">Run a focused multi-agent discussion on a topic and review each turn in order.</p>
        </div>
        <span class="rt-badge" id="rt-status-badge">Idle</span>
      </div>
      <div class="rt-body">
        <div class="rt-form" id="rt-form">
          <label class="rt-field">
            <span class="rt-label">Topic</span>
            <textarea id="rt-topic" class="rt-input rt-textarea" rows="2" maxlength="400" placeholder="What should the team discuss?"></textarea>
          </label>
          <div class="rt-row">
            <label class="rt-field rt-field-grow">
              <span class="rt-label">Participants <small id="rt-participants-hint" class="rt-muted">(select 2 to 5)</small></span>
              <div id="rt-agents" class="rt-agents" aria-live="polite"></div>
            </label>
            <label class="rt-field rt-field-small">
              <span class="rt-label">Max turns</span>
              <input id="rt-max-turns" class="rt-input" type="number" min="2" max="6" value="4" />
              <small class="rt-muted">2–6 turns</small>
            </label>
          </div>
          <div class="rt-actions">
            <button type="button" id="rt-run" class="rt-btn rt-btn-primary">Start roundtable</button>
            <button type="button" id="rt-refresh-agents" class="rt-btn">Refresh agents</button>
          </div>
          <div id="rt-form-msg" class="rt-inline-msg" aria-live="polite"></div>
        </div>
        <div class="rt-result" id="rt-result" aria-live="polite"></div>
      </div>
    </div>`;

  const topicEl = container.querySelector('#rt-topic') as HTMLTextAreaElement;
  const agentsEl = container.querySelector('#rt-agents') as HTMLDivElement;
  const maxTurnsEl = container.querySelector('#rt-max-turns') as HTMLInputElement;
  const runBtn = container.querySelector('#rt-run') as HTMLButtonElement;
  const refreshBtn = container.querySelector('#rt-refresh-agents') as HTMLButtonElement;
  const formMsg = container.querySelector('#rt-form-msg') as HTMLDivElement;
  const resultEl = container.querySelector('#rt-result') as HTMLDivElement;
  const badge = container.querySelector('#rt-status-badge') as HTMLSpanElement;

  let knownAgents: RtAgent[] = [];
  let loadingAgents = false;
  let running = false;

  function setBadge(state: 'idle' | 'running' | 'done' | 'error', text: string): void {
    badge.textContent = text;
    badge.className = `rt-badge rt-badge-${state}`;
  }

  function setFormMsg(text: string, kind: 'info' | 'error' | '' = ''): void {
    formMsg.textContent = text;
    formMsg.className = `rt-inline-msg ${kind ? `rt-inline-${kind}` : ''}`.trim();
  }

  function selectedAgents(): Array<{ id: string; name: string; role: string }> {
    const rows = Array.from(agentsEl.querySelectorAll<HTMLElement>('[data-agent-row]'));
    const out: Array<{ id: string; name: string; role: string }> = [];
    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!cb || !cb.checked) continue;
      const id = row.dataset.agentId || cb.value;
      const name = row.dataset.agentName || id;
      const roleInput = row.querySelector('input[data-role]') as HTMLInputElement | null;
      const role = (roleInput?.value || '').trim() || 'participant';
      out.push({ id, name, role });
    }
    return out;
  }

  function renderAgentPicker(): void {
    if (loadingAgents) {
      agentsEl.innerHTML = '<div class="rt-empty">Loading agents…</div>';
      return;
    }
    const companyId = opts.getCompanyId();
    if (!companyId) {
      agentsEl.innerHTML = '<div class="rt-empty">Open or connect a company/project to load available agents. You can still define participants below once agents are available.</div>';
      return;
    }
    if (knownAgents.length === 0) {
      agentsEl.innerHTML = '<div class="rt-empty">No agents found for this company. Refresh after creating agents.</div>';
      return;
    }
    agentsEl.innerHTML = '';
    knownAgents.forEach((a, i) => {
      const row = el('label', 'rt-agent-row');
      row.dataset.agentRow = '1';
      row.dataset.agentId = a.id;
      row.dataset.agentName = a.name;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = a.id;
      cb.checked = i < Math.min(3, knownAgents.length); // sensible default
      cb.setAttribute('aria-label', `Include ${a.name}`);
      const main = el('span', 'rt-agent-main');
      const dot = el('span', 'rt-agent-dot');
      if (a.color) dot.style.background = a.color;
      const name = el('span', 'rt-agent-name', a.name);
      const meta = el('span', 'rt-agent-meta', a.title ? `${a.title}` : a.id);
      main.append(dot, name, meta);
      const role = document.createElement('input');
      role.type = 'text';
      role.className = 'rt-input rt-role-input';
      role.dataset.role = '1';
      role.placeholder = 'Role';
      role.value = (a.role || a.title || '').slice(0, 60);
      role.maxLength = 60;
      role.addEventListener('click', (e) => e.stopPropagation());
      row.append(cb, main, role);
      agentsEl.appendChild(row);
    });
  }

  async function loadAgents(): Promise<void> {
    const companyId = opts.getCompanyId();
    if (!companyId) {
      knownAgents = [];
      renderAgentPicker();
      return;
    }
    loadingAgents = true;
    renderAgentPicker();
    try {
      const data = await apiJson<{ agents?: RtAgent[] }>(`/api/agents?companyId=${encodeURIComponent(companyId)}`);
      knownAgents = Array.isArray(data?.agents) ? data.agents : [];
    } catch {
      knownAgents = [];
      setFormMsg('Could not load agents for the current company.', 'error');
    } finally {
      loadingAgents = false;
      renderAgentPicker();
    }
  }

  function renderLoading(topic: string, participants: Array<{ name: string; role: string }>, maxTurns: number): void {
    setBadge('running', 'Running');
    resultEl.innerHTML = '';
    const wrap = el('div', 'rt-live');
    const head = el('div', 'rt-live-head');
    head.innerHTML = `<div class="rt-live-title">Discussion in progress</div><div class="rt-live-meta">${esc(topic)}</div>`;
    const chips = el('div', 'rt-live-chips');
    for (const p of participants) {
      const chip = el('span', 'rt-chip', `${p.name} — ${p.role}`);
      chips.appendChild(chip);
    }
    const progress = el('div', 'rt-progress');
    progress.innerHTML = `<span class="rt-spinner" aria-hidden="true"></span><span>Running up to ${maxTurns} turns. This may take a little while; results appear when the roundtable completes.</span>`;
    wrap.append(head, chips, progress);
    resultEl.appendChild(wrap);
  }

  function renderResult(result: RtResult): void {
    resultEl.innerHTML = '';
    const hasTranscript = Array.isArray(result.transcript) && result.transcript.length > 0;
    const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
    const statusKind = result.stopped?.reason === 'done' || (hasTranscript && result.stopped?.reason !== 'errors') ? 'done' : (hasTranscript ? 'done' : 'error');
    setBadge(statusKind, result.stopped?.reason === 'done' ? 'Completed' : 'Finished');

    const card = el('div', 'rt-transcript-card');
    const meta = el('div', 'rt-result-meta');
    meta.innerHTML = `
      <div class="rt-result-topic">${esc(result.topic || 'Untitled topic')}</div>
      <div class="rt-result-stats">
        <span class="rt-stat">${reasonLabel(result.stopped?.reason || 'max_turns')}</span>
        <span class="rt-stat">Turns recorded: ${hasTranscript ? result.transcript.length : 0}</span>
        <span class="rt-stat">Last turn: ${result.stopped?.turn ?? 0}</span>
        <span class="rt-stat">Characters: ${result.chars ?? 0}</span>
      </div>`;
    card.appendChild(meta);

    if (result.summary) {
      const sum = el('div', 'rt-summary');
      sum.innerHTML = `<div class="rt-summary-label">Summary</div><pre class="rt-summary-text">${esc(result.summary)}</pre>`;
      card.appendChild(sum);
    }

    if (!hasTranscript) {
      const empty = el('div', 'rt-empty rt-empty-result', 'No transcript was produced. Try a more specific topic, different participants, or run again.');
      card.appendChild(empty);
    } else {
      const list = el('ol', 'rt-turn-list');
      for (const entry of result.transcript) {
        const item = el('li', 'rt-turn');
        const who = el('div', 'rt-turn-head');
        const idx = el('span', 'rt-turn-index', `#${entry.index}`);
        const name = el('span', 'rt-turn-name', entry.name || entry.agentId);
        const role = el('span', 'rt-turn-role', entry.role || 'participant');
        who.append(idx, name, role);
        const text = el('div', 'rt-turn-text', entry.text || '');
        item.append(who, text);
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    if (hasErrors) {
      const errBox = el('div', 'rt-errors');
      const title = el('div', 'rt-errors-title', 'Turn issues');
      errBox.appendChild(title);
      const ul = el('ul', 'rt-error-list');
      for (const e of result.errors) {
        const li = el('li', '', `Turn ${e.turn} (${e.agentId}): ${e.message}`);
        ul.appendChild(li);
      }
      errBox.appendChild(ul);
      card.appendChild(errBox);
    }

    resultEl.appendChild(card);
  }

  function renderError(message: string): void {
    setBadge('error', 'Error');
    resultEl.innerHTML = '';
    const box = el('div', 'rt-error-box');
    box.innerHTML = `<div class="rt-error-title">Roundtable failed</div><div class="rt-error-body">${esc(message)}</div>`;
    resultEl.appendChild(box);
  }

  async function run(): Promise<void> {
    if (running) return;
    const topic = topicEl.value.trim();
    const maxTurns = Math.min(6, Math.max(2, Number(maxTurnsEl.value) || 4));
    maxTurnsEl.value = String(maxTurns);
    const participants = selectedAgents();

    if (!topic) { setFormMsg('Enter a topic to discuss.', 'error'); topicEl.focus(); return; }
    if (participants.length < 2) { setFormMsg('Select at least 2 participants.', 'error'); return; }
    if (participants.length > 5) { setFormMsg('Select at most 5 participants.', 'error'); return; }

    running = true;
    runBtn.disabled = true;
    refreshBtn.disabled = true;
    setFormMsg('');
    renderLoading(topic, participants, maxTurns);

    try {
      const result = await apiJson<RtResult>('/api/roundtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, agents: participants, maxTurns })
      });
      renderResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      renderError(msg);
      setFormMsg(msg, 'error');
    } finally {
      running = false;
      runBtn.disabled = false;
      refreshBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', () => { void run(); });
  refreshBtn.addEventListener('click', () => { void loadAgents(); });
  topicEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
  });

  // Initial load
  setBadge('idle', 'Idle');
  resultEl.innerHTML = '<div class="rt-empty">Start a roundtable to see agent turns, status, and summary here.</div>';
  void loadAgents();
}
