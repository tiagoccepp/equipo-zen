// Mission Control — per-card render. Each function takes data or null
// and returns HTML; null → degraded "—" state, never throws.

import type {
  AudioDevices,
  AudioSettings,
  CompanyWork,
  ConnectivityStatus,
  MissionLive,
  MissionLiveHooks,
  SalaSettings,
  SidecarState,
  TelemetryAnalysis
} from './types.ts';
import type { LocalDevices } from './api.ts';
import {
  defaultNode,
  esc,
  fmtMs,
  fmtVol,
  parseSopSummary,
  pillClass,
  summarizeTasks,
  timeAgo,
  uptimeSince
} from './format.ts';

function pill(label: string, status: string | boolean | null): string {
  const key = typeof status === 'boolean' ? (status ? 'on' : 'off') : status;
  return `<span class="mc-pill mc-${pillClass(key)}">${esc(label)}</span>`;
}

function cardShell(title: string, emoji: string, body: string): string {
  return `<article class="mc-card"><header class="mc-card-head"><span class="mc-emoji" aria-hidden="true">${emoji}</span><h3>${esc(title)}</h3></header><div class="mc-card-body">${body}</div></article>`;
}

export function renderEquipo(live: MissionLive | null, work: CompanyWork | null, hooks: MissionLiveHooks): string {
  if (!live && !work) {
    return cardShell('Team', '🧑‍🚀', '<p class="mc-empty">— no data —</p>');
  }
  const speakers = new Set<string>();
  try {
    for (const id of hooks.getLiveSpeakers?.() || []) {
      speakers.add(id);
    }
  } catch {
    /* broken hook = no voice data, the rest lives */
  }
  const voiceOn = (() => {
    try {
      return hooks.getVoiceActive?.() ?? null;
    } catch {
      return null;
    }
  })();

  let body = '';
  if (live && live.live.length > 0) {
    for (const m of live.live) {
      const names = m.team
        .map((a) => {
          const speaking = speakers.has(a.id);
          const dot = speaking ? '<span class="mc-dot mc-speaking" aria-hidden="true"></span>' : '';
          return `<li>${dot}<span class="mc-agent" style="--agent:${esc(a.color || '#7491ff')}">${esc(a.name)}</span> <span class="mc-dim">${esc(a.title || a.role || '')}</span>${speaking ? ' ' + pill('speaking', 'speaking') : ''}</li>`;
        })
        .join('');
      body += `<div class="mc-meet">${pill('IN MEETING', 'live')} <strong>${esc(m.companyName)}</strong> <span class="mc-dim">${esc(m.goalTitle || '')} · ${m.turnCount} turns · ${esc(timeAgo(m.lastActiveAt))}</span><ul class="mc-roster">${names || '<li class="mc-dim">—</li>'}</ul></div>`;
    }
  } else if (work) {
    const names = work.team
      .map(
        (a) =>
          `<li><span class="mc-agent" style="--agent:${esc(a.color || '#7491ff')}">${esc(a.name)}</span> <span class="mc-dim">${esc(a.title || a.role || '')}</span></li>`
      )
      .join('');
    body += `${pill('IDLE', 'idle')} <strong>${esc(work.company.name)}</strong> <span class="mc-dim">no live meeting</span><ul class="mc-roster">${names || '<li class="mc-dim">—</li>'}</ul>`;
  } else {
    body += '<p class="mc-empty">— no live meeting —</p>';
  }
  if (voiceOn !== null) {
    body += `<p class="mc-foot">voice ${voiceOn ? pill('ON', true) : pill('OFF', false)}</p>`;
  }
  return cardShell('Team', '🧑‍🚀', body);
}

export function renderTareas(work: CompanyWork | null): string {
  if (!work) {
    return cardShell('Tasks', '✅', '<p class="mc-empty">— no data —</p>');
  }
  const all = work.goals.flatMap((g) => g.tasks.map((t) => ({ ...t, goal: g.title })));
  const sum = summarizeTasks(all);
  const head = `<p class="mc-counts">${pill(`${sum.active} active`, sum.active ? 'warn' : 'idle')} ${pill(`${sum.pending} pending`, 'idle')} ${pill(`${sum.blocked} blocked`, sum.blocked ? 'blocked' : 'idle')} ${pill(`${sum.done}/${sum.total} done`, sum.total && sum.done === sum.total ? 'done' : 'idle')}</p>`;
  const interesting = all
    .filter((t) => !['done', 'done_ok', 'completed'].includes(String(t.status).toLowerCase()))
    .slice(0, 8);
  if (!interesting.length) {
    return cardShell('Tasks', '✅', head + '<p class="mc-dim">all done 🎉</p>');
  }
  const rows = interesting
    .map(
      (t) =>
        `<li>${pill(t.status, t.status)} <span>${esc(t.text)}</span> <span class="mc-dim">· ${esc(t.goal)}${t.blockedReason ? ` · ⚠ ${esc(t.blockedReason)}` : ''}</span></li>`
    )
    .join('');
  return cardShell('Tasks', '✅', head + `<ul class="mc-list">${rows}</ul>`);
}

export function renderSidecars(states: SidecarState[] | null): string {
  if (!states) {
    return cardShell('Sidecars', '🔌', '<p class="mc-empty">— no data —</p>');
  }
  const rows = states
    .map((s) => {
      const st = String(s.status || 'unknown');
      return `<li>${pill(st.toUpperCase(), st)} <strong>${esc(s.name)}</strong> <span class="mc-dim">${esc(uptimeSince(s.lastSpawnAt))} · ↻${s.restartsLastHour}/h${s.autostart ? '' : ' · manual'}</span></li>`;
    })
    .join('');
  return cardShell('Sidecars', '🔌', `<ul class="mc-list">${rows || '<li class="mc-dim">—</li>'}</ul>`);
}

export function renderLatencia(a: TelemetryAnalysis | null): string {
  if (!a) {
    return cardShell('Latency', '⏱️', '<p class="mc-empty">— no data —</p>');
  }
  const row = (label: string, avg: number | null, max: number | null): string =>
    `<li><span class="mc-dim">${esc(label)}</span> <strong>${esc(fmtMs(avg))}</strong> <span class="mc-dim">avg · max ${esc(fmtMs(max))}</span></li>`;
  return cardShell(
    'Latency',
    '⏱️',
    `<ul class="mc-list">${row('visible response', a.avgVisibleResponseMs, a.maxVisibleResponseMs)}${row('agent turn', a.avgAgentResponseMs, a.maxAgentResponseMs)}</ul>` +
      `<p class="mc-foot">${a.userTurns} turns (${a.audioTurns} voice / ${a.textTurns} text) · ${a.routeDecisions} routes · ${a.noAgentResponses} no response</p>`
  );
}

export function renderAudio(audio: AudioSettings | null, devices: LocalDevices | null, server: AudioDevices | null = null): string {
  if (!audio && !devices && !server) {
    return cardShell('Audio', '🎧', '<p class="mc-empty">— no data —</p>');
  }
  const eng = audio
    ? `<li><span class="mc-dim">TTS</span> <strong>${esc(audio.ttsEngine)}</strong> ${audio.ttsHealthy === null ? '' : pill(audio.ttsHealthy ? 'OK' : 'DOWN', audio.ttsHealthy)} </li>` +
      `<li><span class="mc-dim">STT</span> <strong>${esc(audio.sttProvider)}</strong> ${audio.sttHealthy === null ? '' : pill(audio.sttHealthy ? 'OK' : 'DOWN', audio.sttHealthy)}</li>`
    : '<li class="mc-dim">engines —</li>';
  let route = '';
  if (server) {
    const sink = defaultNode(server.sinks);
    const source = defaultNode(server.sources);
    const nodeLine = (label: string, n: { description: string; volume: number | null; muted: boolean | null } | null): string =>
      n
        ? `<li><span class="mc-dim">${label}</span> <strong>${esc(n.description)}</strong> <span class="mc-dim">${esc(fmtVol(n.volume))}${n.muted ? ' · mute' : ''}</span></li>`
        : `<li class="mc-dim">${label} —</li>`;
    route = nodeLine('out →', sink) + nodeLine('in ←', source);
  } else if (devices) {
    route = `<li><span class="mc-dim">devices</span> <strong>${devices.inputs} in / ${devices.outputs} out</strong> <span class="mc-dim">(local, no PipeWire route)</span></li>`;
  } else {
    route = '<li class="mc-dim">route —</li>';
  }
  return cardShell('Audio', '🎧', `<ul class="mc-list">${eng}${route}</ul>`);
}

export function renderSala(sala: SalaSettings | null): string {
  if (!sala) {
    return cardShell('Room', '🏛️', '<p class="mc-empty">— no data —</p>');
  }
  const sop = parseSopSummary(sala.sop);
  const flags = `${pill('v1 ' + (sala.v1 ? 'ON' : 'OFF'), sala.v1)} ${pill('v2 ' + (sala.v2 ? 'ON' : 'OFF'), sala.v2)} ${pill('groupchat ' + (sala.groupchat ? 'ON' : 'OFF'), sala.groupchat)}`;
  const knobs = [
    sop.maxRounds !== null ? `max ${sop.maxRounds} rounds` : null,
    sop.order ? `order ${sop.order}` : null,
    sop.r2 ? `R2 ${sop.r2}` : null,
    sala.agentTimeoutMs ? `timeout ${fmtMs(sala.agentTimeoutMs)}` : null
  ]
    .filter(Boolean)
    .join(' · ');
  const rules = sop.firstRules.map((r) => `<li class="mc-dim">${esc(r)}</li>`).join('');
  return cardShell(
    'Room',
    '🏛️',
    `<p>${flags}</p><p class="mc-dim">SOP: ${sop.rules} rules${knobs ? ` · ${esc(knobs)}` : ''}</p>` +
      (rules ? `<ul class="mc-list">${rules}</ul>` : '')
  );
}

/** Connectivity badge (TC 09/11): pill + tooltip with the checks. */
export function renderConnectivityBadge(conn: ConnectivityStatus | null): string {
  if (!conn) {
    return `<div class="mc-conn">${pill('CONN —', 'unknown')}</div>`;
  }
  const known = ['online', 'degraded', 'offline'].includes(conn.status) ? conn.status : 'degraded';
  const label = known === 'online' ? 'CONN ONLINE' : known === 'degraded' ? 'CONN DEGRADED' : 'CONN OFFLINE';
  const cls = known === 'online' ? 'on' : known === 'degraded' ? 'warn' : 'off';
  const downs = conn.checks.filter((c) => !c.ok).length;
  const summary = `${conn.checks.length} checks${downs ? `, ${downs} down` : ''}`;
  const lines = conn.checks
    .map((c) => `${c.ok ? '✓' : '✗'} ${c.name} ${fmtMs(c.ms)}${c.detail ? ` — ${c.detail}` : ''}`)
    .join('\n');
  return `<div class="mc-conn" title="${esc(lines || 'no checks')}">${pill(label, cls)} <span class="mc-dim">${esc(summary)}</span></div>`;
}
