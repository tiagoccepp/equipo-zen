// Roundtable UI: polished multi-agent discussion panel.
// Calls POST /api/roundtable (batch request) and renders participants, live session state,
// and final transcript with clear turn identity and status.

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
type Participant = { id: string; name: string; role: string; color?: string; title?: string };

const STOP_LABEL: Record<string, string> = {
  done: 'Completed (consensus reached)',
  max_turns: 'Stopped: turn limit reached',
  max_chars: 'Stopped: character limit reached',
  skipped: 'Stopped: repeated skips',
  errors: 'Stopped: consecutive errors'
};

const LIVE_PHASES = [
  'Preparing discussion',
  'Opening statements',
  'Exchange in progress',
  'Collecting responses',
  'Finalizing transcript'
];

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
  return STOP_LABEL[reason] || `Stopped: ${reason || 'unknown'}`;
}

function initials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function participantMarkup(p: Participant, compact = false): string {
  const color = p.color ? ` style="--rt-agent-color:${esc(p.color)}"` : '';
  const meta = p.title && p.title !== p.role ? `${p.role} · ${p.title}` : p.role;
  return `
    <span class="rt-person${compact ? ' rt-person-compact' : ''}"${color}>
      <span class="rt-avatar" aria-hidden="true">${esc(initials(p.name))}</span>
      <span class="rt-person-copy">
        <span class="rt-person-name">${esc(p.name)}</span>
        <span class="rt-person-meta">${esc(meta || 'Participant')}</span>
      </span>
    </span>`;
}

export function mountRoundtable(container: HTMLElement, opts: { getCompanyId: () => string }): void {
  if (container.dataset.rtMounted === '1') return;
  container.dataset.rtMounted = '1';

  container.innerHTML = `
    <div class="rt-card">
      <div class="rt-head">
        <div>
          <h3 class="rt-title">Roundtable</h3>
          <p class="rt-desc">Run a structured multi-agent discussion, track speaking turns, and review a clear transcript.</p>
        </div>
        <div class="rt-head-status">
          <span class="rt-badge" id="rt-status-badge">Idle</span>
          <span class="rt-head-note" id="rt-head-note">Ready to configure</span>
        </div>
      </div>
      <div class="rt-body">
        <div class="rt-form" id="rt-form">
          <label class="rt-field">
            <span class="rt-label">Topic</span>
            <textarea id="rt-topic" class="rt-input rt-textarea" rows="3" maxlength="400" placeholder="Describe the question, decision, or tradeoff the team should discuss."></textarea>
            <small class="rt-muted">A specific prompt produces clearer turns. Press Ctrl+Enter to start.</small>
          </label>
          <div class="rt-row">
            <div class="rt-field rt-field-grow">
              <div class="rt-label-row">
                <span class="rt-label">Participants <small id="rt-participants-hint" class="rt-muted">(select 2 to 5)</small></span>
                <span id="rt-selected-count" class="rt-muted">0 selected</span>
              </div>
              <div id="rt-agents" class="rt-agents" aria-live="polite"></div>
              <div id="rt-selected-preview" class="rt-selected-preview" aria-live="polite"></div>
            </div>
            <label class="rt-field rt-field-small">
              <span class="rt-label">Max turns</span>
              <input id="rt-max-turns" class="rt-input" type="number" min="2" max="6" value="4" />
              <small class="rt-muted">2–6 turns total</small>
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
  const headNote = container.querySelector('#rt-head-note') as HTMLSpanElement;
  const selectedCountEl = container.querySelector('#rt-selected-count') as HTMLSpanElement;
  const selectedPreviewEl = container.querySelector('#rt-selected-preview') as HTMLDivElement;

  let knownAgents: RtAgent[] = [];
  let loadingAgents = false;
  let running = false;
  let liveTimer: number | null = null;
  let liveStartedAt = 0;

  function stopLiveTimer(): void {
    if (liveTimer !== null) {
      window.clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  function setBadge(state: 'idle' | 'running' | 'done' | 'error', text: string): void {
    badge.textContent = text;
    badge.className = `rt-badge rt-badge-${state}`;
  }

  function setHeadNote(text: string): void {
    headNote.textContent = text;
  }

  function setFormMsg(text: string, kind: 'info' | 'error' | '' = ''): void {
    formMsg.textContent = text;
    formMsg.className = `rt-inline-msg ${kind ? `rt-inline-${kind}` : ''}`.trim();
  }

  function selectedAgents(): Participant[] {
    const rows = Array.from(agentsEl.querySelectorAll<HTMLElement>('[data-agent-row]'));
    const out: Participant[] = [];
    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!cb || !cb.checked) continue;
      const id = row.dataset.agentId || cb.value;
      const name = row.dataset.agentName || id;
      const roleInput = row.querySelector('input[data-role]') as HTMLInputElement | null;
      const role = (roleInput?.value || '').trim() || 'participant';
      out.push({
        id,
        name,
        role,
        color: row.dataset.agentColor || undefined,
        title: row.dataset.agentTitle || undefined
      });
    }
    return out;
  }

  function updateSelectedPreview(): void {
    const selected = selectedAgents();
    selectedCountEl.textContent = `${selected.length} selected`;
    if (selected.length === 0) {
      selectedPreviewEl.innerHTML = '<span class="rt-muted">No participants selected yet.</span>';
      return;
    }
    const chips = selected.map((p) => `<span class="rt-chip rt-chip-person" style="--rt-agent-color:${esc(p.color || 'var(--accent)')}">${esc(p.name)}<span class="rt-chip-role">${esc(p.role)}</span></span>`).join('');
    selectedPreviewEl.innerHTML = `<div class="rt-chip-row">${chips}</div>`;
  }

  function renderAgentPicker(): void {
    if (loadingAgents) {
      agentsEl.innerHTML = `
        <div class="rt-skeleton-list" aria-hidden="true">
          <div class="rt-skeleton-row"></div>
          <div class="rt-skeleton-row"></div>
          <div class="rt-skeleton-row"></div>
        </div>
        <div class="rt-empty">Loading available agents…</div>`;
      return;
    }
    const companyId = opts.getCompanyId();
    if (!companyId) {
      agentsEl.innerHTML = '<div class="rt-empty">Open or connect a company/project to load available agents.</div>';
      updateSelectedPreview();
      return;
    }
    if (knownAgents.length === 0) {
      agentsEl.innerHTML = '<div class="rt-empty">No agents found for this company. Refresh after creating agents.</div>';
      updateSelectedPreview();
      return;
    }
    agentsEl.innerHTML = '';
    knownAgents.forEach((a, i) => {
      const row = el('label', 'rt-agent-row');
      row.dataset.agentRow = '1';
      row.dataset.agentId = a.id;
      row.dataset.agentName = a.name;
      row.dataset.agentColor = a.color || '';
      row.dataset.agentTitle = a.title || '';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = a.id;
      cb.checked = i < Math.min(3, knownAgents.length);
      cb.setAttribute('aria-label', `Include ${a.name}`);
      cb.addEventListener('change', updateSelectedPreview);
      const main = el('span', 'rt-agent-main');
      const dot = el('span', 'rt-agent-dot');
      if (a.color) dot.style.background = a.color;
      const text = el('span', 'rt-agent-copy');
      const name = el('span', 'rt-agent-name', a.name);
      const metaText = [a.title, a.role].filter(Boolean).join(' · ') || a.id;
      const meta = el('span', 'rt-agent-meta', metaText);
      text.append(name, meta);
      main.append(dot, text);
      const role = document.createElement('input');
      role.type = 'text';
      role.className = 'rt-input rt-role-input';
      role.dataset.role = '1';
      role.placeholder = 'Discussion role';
      role.value = (a.role || a.title || 'participant').slice(0, 60);
      role.maxLength = 60;
      role.addEventListener('click', (e) => e.stopPropagation());
      role.addEventListener('input', updateSelectedPreview);
      row.append(cb, main, role);
      agentsEl.appendChild(row);
    });
    updateSelectedPreview();
  }

  async function loadAgents(): Promise<void> {
    const companyId = opts.getCompanyId();
    if (!companyId) {
      knownAgents = [];
      renderAgentPicker();
      setHeadNote('Connect a company to load agents');
      return;
    }
    loadingAgents = true;
    renderAgentPicker();
    try {
      const data = await apiJson<{ agents?: RtAgent[] }>(`/api/agents?companyId=${encodeURIComponent(companyId)}`);
      knownAgents = Array.isArray(data?.agents) ? data.agents : [];
      setHeadNote(knownAgents.length > 0 ? `${knownAgents.length} agents available` : 'No agents available');
      if (!running) setFormMsg('', '');
    } catch {
      knownAgents = [];
      setHeadNote('Unable to load agents');
      setFormMsg('Could not load agents for the current company.', 'error');
    } finally {
      loadingAgents = false;
      renderAgentPicker();
    }
  }

  function liveStateForTurn(turnIndex: number, activeTurn: number): { label: string; cls: string } {
    if (turnIndex < activeTurn) return { label: 'Complete', cls: 'done' };
    if (turnIndex === activeTurn) return { label: 'Speaking', cls: 'speaking' };
    return { label: 'Queued', cls: 'queued' };
  }

  function renderLive(topic: string, participants: Participant[], maxTurns: number): void {
    stopLiveTimer();
    liveStartedAt = Date.now();
    setBadge('running', 'Running');
    setHeadNote('Session in progress');
    resultEl.innerHTML = '';

    const wrap = el('div', 'rt-live rt-live-rich');
    const top = el('div', 'rt-live-top');
    top.innerHTML = `
      <div>
        <div class="rt-live-title">Discussion in progress</div>
        <div class="rt-live-meta">${esc(topic)}</div>
      </div>
      <div class="rt-live-phase" id="rt-live-phase">${LIVE_PHASES[0]}</div>`;

    const progress = el('div', 'rt-progress rt-progress-live');
    progress.innerHTML = `
      <span class="rt-spinner" aria-hidden="true"></span>
      <span id="rt-live-status">Preparing the roundtable and collecting agent responses.</span>`;

    const columns = el('div', 'rt-live-grid');
    const roster = el('section', 'rt-panel');
    roster.innerHTML = `<div class="rt-panel-head"><span>Participants</span><span class="rt-panel-sub">${participants.length} selected</span></div>`;
    const rosterList = el('div', 'rt-roster-list');
    participants.forEach((p, i) => {
      const row = el('div', 'rt-roster-item');
      row.dataset.agentId = p.id;
      row.innerHTML = `${participantMarkup(p, true)}<span class="rt-state-pill rt-state-queued" data-roster-state>${i === 0 ? 'Ready' : 'Queued'}</span>`;
      rosterList.appendChild(row);
    });
    roster.appendChild(rosterList);

    const timeline = el('section', 'rt-panel');
    timeline.innerHTML = `<div class="rt-panel-head"><span>Turn timeline</span><span class="rt-panel-sub">Up to ${maxTurns} turns</span></div>`;
    const turnList = el('ol', 'rt-live-turns');
    for (let i = 1; i <= maxTurns; i += 1) {
      const speaker = participants[(i - 1) % participants.length];
      const item = el('li', 'rt-live-turn rt-state-queued');
      item.dataset.turn = String(i);
      item.innerHTML = `
        <div class="rt-live-turn-head">
          <span class="rt-turn-index">Turn ${i}</span>
          <span class="rt-state-pill rt-state-queued" data-turn-state>Queued</span>
        </div>
        <div class="rt-live-turn-speaker">${participantMarkup({ ...speaker, role: speaker.role || 'participant' }, true)}</div>
        <div class="rt-live-turn-body" data-turn-body>Awaiting response.</div>`;
      turnList.appendChild(item);
    }
    timeline.appendChild(turnList);

    columns.append(roster, timeline);
    wrap.append(top, progress, columns);
    resultEl.appendChild(wrap);

    const phaseEl = wrap.querySelector('#rt-live-phase') as HTMLDivElement;
    const statusEl = wrap.querySelector('#rt-live-status') as HTMLSpanElement;
    const rosterStates = Array.from(wrap.querySelectorAll<HTMLElement>('[data-roster-state]'));
    const turnItems = Array.from(wrap.querySelectorAll<HTMLElement>('.rt-live-turn'));

    const tick = () => {
      const elapsed = Date.now() - liveStartedAt;
      const step = Math.max(1, Math.min(maxTurns, Math.floor(elapsed / 2200) + 1));
      const phase = LIVE_PHASES[Math.min(LIVE_PHASES.length - 1, Math.floor(elapsed / 3500))];
      phaseEl.textContent = phase;
      statusEl.textContent = 'Responses are being generated. The full transcript will appear when the roundtable completes.';

      participants.forEach((p, idx) => {
        const pill = rosterStates[idx];
        if (!pill) return;
        const currentTurnIdx = step - 1;
        const speakingNow = participants[currentTurnIdx % participants.length]?.id === p.id && currentTurnIdx < maxTurns;
        const spokeBefore = Array.from({ length: Math.max(0, currentTurnIdx) }, (_, t) => participants[t % participants.length]?.id === p.id).some(Boolean);
        if (speakingNow) {
          pill.textContent = 'Speaking';
          pill.className = 'rt-state-pill rt-state-speaking';
        } else if (spokeBefore) {
          pill.textContent = 'Responded';
          pill.className = 'rt-state-pill rt-state-done';
        } else {
          pill.textContent = idx === currentTurnIdx ? 'Ready' : 'Queued';
          pill.className = 'rt-state-pill rt-state-queued';
        }
      });

      turnItems.forEach((item, idx) => {
        const turnIndex = idx + 1;
        const state = liveStateForTurn(turnIndex, step);
        item.className = `rt-live-turn rt-state-${state.cls}`;
        const pill = item.querySelector('[data-turn-state]') as HTMLElement | null;
        const body = item.querySelector('[data-turn-body]') as HTMLElement | null;
        if (pill) {
          pill.textContent = state.label;
          pill.className = `rt-state-pill rt-state-${state.cls}`;
        }
        if (body) {
          body.textContent = state.cls === 'done'
            ? 'Response received. Waiting for final transcript.'
            : state.cls === 'speaking'
              ? 'Drafting response for this turn.'
              : 'Awaiting response.';
        }
      });
    };

    tick();
    liveTimer = window.setInterval(tick, 700);
  }

  function transcriptGroups(entries: RtEntry[]): Array<{ agentId: string; name: string; role: string; turns: RtEntry[] }> {
    const groups: Array<{ agentId: string; name: string; role: string; turns: RtEntry[] }> = [];
    for (const entry of entries) {
      const last = groups[groups.length - 1];
      if (last && last.agentId === entry.agentId && last.role === entry.role && last.name === entry.name) {
        last.turns.push(entry);
      } else {
        groups.push({ agentId: entry.agentId, name: entry.name, role: entry.role, turns: [entry] });
      }
    }
    return groups;
  }

  function findAgentColor(result: RtResult, agentId: string): string | undefined {
    const known = knownAgents.find((a) => a.id === agentId);
    return known?.color;
  }

  function renderResult(result: RtResult): void {
    stopLiveTimer();
    resultEl.innerHTML = '';
    const hasTranscript = Array.isArray(result.transcript) && result.transcript.length > 0;
    const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
    const finishedOk = result.stopped?.reason === 'done' || hasTranscript;
    setBadge(finishedOk ? 'done' : 'error', result.stopped?.reason === 'done' ? 'Completed' : 'Finished');
    setHeadNote(hasTranscript ? `${result.transcript.length} turns recorded` : 'No transcript recorded');

    const card = el('div', 'rt-transcript-card');
    const meta = el('div', 'rt-result-meta');
    meta.innerHTML = `
      <div class="rt-result-topic">${esc(result.topic || 'Untitled topic')}</div>
      <div class="rt-result-stats">
        <span class="rt-stat">${esc(reasonLabel(result.stopped?.reason || 'max_turns'))}</span>
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

    const participantsFromTranscript = new Map<string, Participant>();
    for (const entry of result.transcript || []) {
      if (!participantsFromTranscript.has(entry.agentId)) {
        participantsFromTranscript.set(entry.agentId, {
          id: entry.agentId,
          name: entry.name || entry.agentId,
          role: entry.role || 'participant',
          color: findAgentColor(result, entry.agentId)
        });
      }
    }
    if (participantsFromTranscript.size > 0) {
      const pPanel = el('section', 'rt-panel');
      pPanel.innerHTML = `<div class="rt-panel-head"><span>Participants</span><span class="rt-panel-sub">${participantsFromTranscript.size} in transcript</span></div>`;
      const pList = el('div', 'rt-roster-list');
      for (const p of participantsFromTranscript.values()) {
        const count = (result.transcript || []).filter((t) => t.agentId === p.id).length;
        const row = el('div', 'rt-roster-item');
        row.innerHTML = `${participantMarkup(p, true)}<span class="rt-state-pill rt-state-done">${count} turn${count === 1 ? '' : 's'}</span>`;
        pList.appendChild(row);
      }
      pPanel.appendChild(pList);
      card.appendChild(pPanel);
    }

    if (!hasTranscript) {
      const empty = el('div', 'rt-empty rt-empty-result');
      empty.innerHTML = `
        <div class="rt-empty-title">No transcript was produced</div>
        <div>Try a more specific topic, adjust participant roles, or run the roundtable again.</div>`;
      card.appendChild(empty);
    } else {
      const section = el('section', 'rt-panel');
      section.innerHTML = '<div class="rt-panel-head"><span>Transcript</span><span class="rt-panel-sub">Grouped by speaker turns</span></div>';
      const list = el('ol', 'rt-turn-list');
      const groups = transcriptGroups(result.transcript);
      for (const group of groups) {
        const participant: Participant = {
          id: group.agentId,
          name: group.name || group.agentId,
          role: group.role || 'participant',
          color: findAgentColor(result, group.agentId)
        };
        const item = el('li', 'rt-turn-group');
        item.style.setProperty('--rt-agent-color', participant.color || 'var(--accent)');
        const head = el('div', 'rt-turn-group-head');
        head.innerHTML = `${participantMarkup(participant)}<span class="rt-state-pill rt-state-done">Responded</span>`;
        item.appendChild(head);

        const turnsWrap = el('div', 'rt-turn-group-body');
        for (const entry of group.turns) {
          const turn = el('article', 'rt-turn');
          const turnHead = el('div', 'rt-turn-head');
          const idx = el('span', 'rt-turn-index', `Turn ${entry.index}`);
          const role = el('span', 'rt-turn-role', entry.role || 'participant');
          turnHead.append(idx, role);
          const text = el('div', 'rt-turn-text', entry.text || '');
          turn.append(turnHead, text);
          turnsWrap.appendChild(turn);
        }
        item.appendChild(turnsWrap);
        list.appendChild(item);
      }
      section.appendChild(list);
      card.appendChild(section);
    }

    if (hasErrors) {
      const errBox = el('div', 'rt-errors');
      errBox.innerHTML = '<div class="rt-errors-title">Turn issues</div>';
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
    stopLiveTimer();
    setBadge('error', 'Error');
    setHeadNote('Request failed');
    resultEl.innerHTML = '';
    const box = el('div', 'rt-error-box');
    box.innerHTML = `<div class="rt-error-title">Roundtable failed</div><div class="rt-error-body">${esc(message)}</div><div class="rt-error-help">Check the topic, selected participants, and provider availability, then try again.</div>`;
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
    runBtn.textContent = 'Running…';
    setFormMsg('');
    renderLive(topic, participants, maxTurns);

    try {
      const result = await apiJson<RtResult>('/api/roundtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, agents: participants.map(({ id, name, role }) => ({ id, name, role })), maxTurns })
      });
      renderResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      renderError(msg);
      setFormMsg(msg, 'error');
    } finally {
      stopLiveTimer();
      running = false;
      runBtn.disabled = false;
      refreshBtn.disabled = false;
      runBtn.textContent = 'Start roundtable';
    }
  }

  runBtn.addEventListener('click', () => { void run(); });
  refreshBtn.addEventListener('click', () => { void loadAgents(); });
  topicEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
  });
  topicEl.addEventListener('input', () => {
    if (topicEl.value.trim()) setFormMsg('', '');
  });

  setBadge('idle', 'Idle');
  setHeadNote('Ready to configure');
  resultEl.innerHTML = `
    <div class="rt-empty rt-empty-initial">
      <div class="rt-empty-title">Ready for a roundtable</div>
      <div>Choose a topic, select participants, and start a discussion to see turn status and a grouped transcript.</div>
    </div>`;
  void loadAgents();
}
