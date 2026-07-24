import { nanoid } from 'nanoid';

import { openDatabase } from './db.js';

function now() {
  return new Date().toISOString();
}

function parseJsonColumn(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToAgent(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    origin: row.origin,
    status: row.status,
    name: row.name,
    title: row.title,
    voice: row.voice,
    color: row.color,
    style: row.style,
    aliases: parseJsonColumn(row.aliases_json, []),
    domains: parseJsonColumn(row.domains_json, []),
    boundaries: parseJsonColumn(row.boundaries_json, []),
    learningEnabled: Boolean(row.learning_enabled),
    version: row.version
  };
}

// Repositorio único sobre node:sqlite. API síncrona: cada operación es un
// INSERT/SELECT chico a ritmo humano bajo WAL, no bloquea el event loop de
// forma apreciable.
export class Store {
  constructor(dbPath) {
    this.db = openDatabase(dbPath);
  }

  close() {
    this.db.close();
  }

  // ── Agentes ────────────────────────────────────────────────────────────

  seedAgentsIfEmpty(agentConfig) {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM agents').get();
    if (count > 0) {
      return false;
    }
    for (const agent of agentConfig.agents) {
      this.insertAgent(
        {
          id: agent.id,
          name: agent.name,
          title: agent.title,
          voice: agent.voice || 'Kore',
          color: agent.color || '#888888',
          style: agent.style || '',
          aliases: agent.aliases || [],
          domains: agent.domains || [],
          boundaries: agent.boundaries || []
        },
        'builtin',
        'seed'
      );
    }
    return true;
  }

  insertAgent(profile, origin, actor) {
    const at = now();
    this.db.prepare(`
      INSERT INTO agents (id, origin, status, name, title, voice, color, style,
        aliases_json, domains_json, boundaries_json, learning_enabled, version, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(
      profile.id,
      origin,
      profile.name,
      profile.title,
      profile.voice,
      profile.color,
      profile.style,
      JSON.stringify(profile.aliases),
      JSON.stringify(profile.domains),
      JSON.stringify(profile.boundaries),
      at,
      at
    );
    this.logChange(actor, 'agent', profile.id, 'create', { name: profile.name, origin });
    return this.getAgent(profile.id);
  }

  getAgent(agentId) {
    return rowToAgent(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId));
  }

  listAgents({ includeArchived = false } = {}) {
    const rows = includeArchived
      ? this.db.prepare('SELECT * FROM agents ORDER BY created_at').all()
      : this.db.prepare("SELECT * FROM agents WHERE status = 'active' ORDER BY created_at").all();
    return rows.map(rowToAgent);
  }

  updateAgent(agentId, patch, actor, note = null) {
    const current = this.getAgent(agentId);
    if (!current) {
      return null;
    }

    this.db.prepare(`
      INSERT INTO agent_profile_versions (agent_id, version, profile_json, changed_by, change_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentId, current.version, JSON.stringify(current), actor, note, now());

    const next = {
      name: patch.name ?? current.name,
      title: patch.title ?? current.title,
      voice: patch.voice ?? current.voice,
      color: patch.color ?? current.color,
      style: patch.style ?? current.style,
      aliases: patch.aliases ?? current.aliases,
      domains: patch.domains ?? current.domains,
      boundaries: patch.boundaries ?? current.boundaries,
      learningEnabled: patch.learningEnabled ?? current.learningEnabled
    };

    this.db.prepare(`
      UPDATE agents SET name = ?, title = ?, voice = ?, color = ?, style = ?,
        aliases_json = ?, domains_json = ?, boundaries_json = ?, learning_enabled = ?,
        version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.title,
      next.voice,
      next.color,
      next.style,
      JSON.stringify(next.aliases),
      JSON.stringify(next.domains),
      JSON.stringify(next.boundaries),
      next.learningEnabled ? 1 : 0,
      now(),
      agentId
    );

    this.logChange(actor, 'agent', agentId, 'update', { patch, note });
    return this.getAgent(agentId);
  }

  archiveAgent(agentId, actor) {
    this.db.prepare("UPDATE agents SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), agentId);
    this.logChange(actor, 'agent', agentId, 'archive', {});
  }

  listAgentVersions(agentId, limit = 20) {
    return this.db.prepare(`
      SELECT id, agent_id, version, profile_json, changed_by, change_note, created_at
      FROM agent_profile_versions WHERE agent_id = ? ORDER BY id DESC LIMIT ?
    `).all(agentId, limit).map((row) => ({ ...row, profile: parseJsonColumn(row.profile_json, null) }));
  }

  // ── Reuniones ──────────────────────────────────────────────────────────

  createMeeting({ scenarioName = null, scenarioText = null } = {}) {
    const id = nanoid(10);
    const at = now();
    this.db.prepare(`
      INSERT INTO meetings (id, scenario_name, scenario_text, status, created_at, last_active_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, scenarioName, scenarioText, at, at);

    for (const agent of this.listAgents()) {
      this.db.prepare('INSERT INTO meeting_agents (meeting_id, agent_id, enabled) VALUES (?, ?, 1)').run(id, agent.id);
    }
    return this.getMeeting(id);
  }

  getMeeting(meetingId) {
    return this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) || null;
  }

  findResumableMeeting(meetingId) {
    if (!meetingId) {
      return null;
    }
    return this.db.prepare("SELECT * FROM meetings WHERE id = ? AND status = 'active'").get(meetingId) || null;
  }

  listMeetings(limit = 30) {
    return this.db.prepare(`
      SELECT id, title, scenario_name, status, created_at, last_active_at, closed_at, turn_count, summary
      FROM meetings ORDER BY last_active_at DESC LIMIT ?
    `).all(limit);
  }

  updateMeeting(meetingId, patch) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) {
      return null;
    }
    this.db.prepare('UPDATE meetings SET title = ?, scenario_name = ?, scenario_text = ?, summary = ? WHERE id = ?').run(
      patch.title ?? meeting.title,
      patch.scenarioName ?? meeting.scenario_name,
      patch.scenarioText ?? meeting.scenario_text,
      patch.summary ?? meeting.summary,
      meetingId
    );
    return this.getMeeting(meetingId);
  }

  closeMeeting(meetingId) {
    this.db.prepare("UPDATE meetings SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), meetingId);
  }

  touchMeeting(meetingId) {
    this.db.prepare('UPDATE meetings SET last_active_at = ? WHERE id = ?').run(now(), meetingId);
  }

  // ── Roster por reunión ─────────────────────────────────────────────────

  rosterForMeeting(meetingId) {
    const rows = this.db.prepare(`
      SELECT a.*, ma.enabled AS meeting_enabled
      FROM meeting_agents ma JOIN agents a ON a.id = ma.agent_id
      WHERE ma.meeting_id = ? AND a.status = 'active'
      ORDER BY a.created_at
    `).all(meetingId);
    return rows.map((row) => ({ ...rowToAgent(row), enabled: Boolean(row.meeting_enabled) }));
  }

  addAgentToMeeting(meetingId, agentId) {
    this.db.prepare('INSERT OR IGNORE INTO meeting_agents (meeting_id, agent_id, enabled) VALUES (?, ?, 1)').run(meetingId, agentId);
  }

  removeAgentFromMeeting(meetingId, agentId) {
    this.db.prepare('DELETE FROM meeting_agents WHERE meeting_id = ? AND agent_id = ?').run(meetingId, agentId);
  }

  setAgentEnabled(meetingId, agentId, enabled) {
    this.db.prepare('UPDATE meeting_agents SET enabled = ? WHERE meeting_id = ? AND agent_id = ?').run(enabled ? 1 : 0, meetingId, agentId);
  }

  // ── Turnos ─────────────────────────────────────────────────────────────

  appendTurn(meetingId, { turnId = null, kind, speaker, agentId = null, text }) {
    const at = now();
    const result = this.db.prepare(`
      INSERT INTO turns (meeting_id, turn_id, at, kind, speaker, agent_id, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(meetingId, turnId, at, kind, speaker, agentId, text);
    this.db.prepare('UPDATE meetings SET turn_count = turn_count + 1, last_active_at = ? WHERE id = ?').run(at, meetingId);
    return result.lastInsertRowid;
  }

  recentTurns(meetingId, limit = 80) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT id, turn_id, at, kind, speaker, agent_id, text
        FROM turns WHERE meeting_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(meetingId, limit);
  }

  // ── Tareas ─────────────────────────────────────────────────────────────

  insertTask(meetingId, agentId, { id = null, text, completed = false, createdAt = null }) {
    const taskId = id || 'task-' + nanoid(6);
    this.db.prepare(`
      INSERT INTO tasks (id, meeting_id, agent_id, text, completed, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, meetingId, agentId, text, completed ? 1 : 0, createdAt || now(), completed ? now() : null);
    return taskId;
  }

  setTaskCompleted(taskId, completed) {
    this.db.prepare('UPDATE tasks SET completed = ?, completed_at = ? WHERE id = ?')
      .run(completed ? 1 : 0, completed ? now() : null, taskId);
  }

  deleteTask(taskId) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  tasksForMeeting(meetingId) {
    return this.db.prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY created_at').all(meetingId)
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        text: row.text,
        completed: Boolean(row.completed),
        createdAt: row.created_at
      }));
  }

  // ── Resúmenes, telemetría y changelog ──────────────────────────────────

  saveSessionSummary(meetingId, sessionId, startedAt, summary) {
    this.db.prepare(`
      INSERT INTO session_summaries (meeting_id, session_id, started_at, ended_at, summary_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(meetingId, sessionId, startedAt, now(), JSON.stringify(summary));
  }

  logTelemetryEvent(meetingId, turnId, type, payload) {
    this.db.prepare(`
      INSERT INTO telemetry_events (meeting_id, turn_id, at, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(meetingId, turnId, now(), type, JSON.stringify(payload ?? {}));
  }

  telemetryEventsForMeeting(meetingId, types = null) {
    const rows = types
      ? this.db.prepare(`
          SELECT * FROM telemetry_events
          WHERE meeting_id = ? AND type IN (${types.map(() => '?').join(',')})
          ORDER BY id ASC
        `).all(meetingId, ...types)
      : this.db.prepare('SELECT * FROM telemetry_events WHERE meeting_id = ? ORDER BY id ASC').all(meetingId);
    return rows.map((row) => ({ ...row, payload: parseJsonColumn(row.payload_json, {}) }));
  }

  logChange(actor, entity, entityId, action, detail) {
    this.db.prepare(`
      INSERT INTO changelog (at, actor, entity, entity_id, action, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(now(), actor, entity, entityId, action, JSON.stringify(detail ?? {}));
  }

  listChangelog({ entity = null, entityId = null, limit = 50 } = {}) {
    let rows;
    if (entity && entityId) {
      rows = this.db.prepare('SELECT * FROM changelog WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?')
        .all(entity, entityId, limit);
    } else if (entity) {
      rows = this.db.prepare('SELECT * FROM changelog WHERE entity = ? ORDER BY id DESC LIMIT ?').all(entity, limit);
    } else {
      rows = this.db.prepare('SELECT * FROM changelog ORDER BY id DESC LIMIT ?').all(limit);
    }
    return rows.map((row) => ({ ...row, detail: parseJsonColumn(row.detail_json, {}) }));
  }

  // ── Aprendizajes (consumido por el workstream de auto-aprendizaje) ─────

  insertLearning({ agentId = null, meetingId = null, type, content, confidence, sourceTurnIds = [] }) {
    const at = now();
    const result = this.db.prepare(`
      INSERT INTO learnings (agent_id, meeting_id, type, content, confidence, source_turn_ids, status, times_reinforced, created_at, last_reinforced_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
    `).run(agentId, meetingId, type, content, confidence, JSON.stringify(sourceTurnIds), at, at);
    return result.lastInsertRowid;
  }

  reinforceLearning(learningId, confidence) {
    this.db.prepare(`
      UPDATE learnings SET times_reinforced = times_reinforced + 1,
        confidence = MAX(confidence, ?), last_reinforced_at = ?
      WHERE id = ?
    `).run(confidence, now(), learningId);
  }

  activeLearnings(agentId = null) {
    if (agentId) {
      return this.db.prepare(`
        SELECT * FROM learnings WHERE status = 'active' AND (agent_id = ? OR agent_id IS NULL)
        ORDER BY last_reinforced_at DESC
      `).all(agentId).map(this.#rowToLearning);
    }
    return this.db.prepare("SELECT * FROM learnings WHERE status = 'active' ORDER BY last_reinforced_at DESC")
      .all().map(this.#rowToLearning);
  }

  learningsForPanel(agentId) {
    return this.db.prepare(`
      SELECT * FROM learnings WHERE (agent_id = ? OR agent_id IS NULL) AND status != 'user_deleted'
      ORDER BY last_reinforced_at DESC
    `).all(agentId).map(this.#rowToLearning);
  }

  updateLearning(learningId, patch, actor) {
    const row = this.db.prepare('SELECT * FROM learnings WHERE id = ?').get(learningId);
    if (!row) {
      return null;
    }
    this.db.prepare('UPDATE learnings SET content = ?, status = ? WHERE id = ?').run(
      patch.content ?? row.content,
      patch.status ?? row.status,
      learningId
    );
    this.logChange(actor, 'learning', String(learningId), 'update', { patch });
    return this.db.prepare('SELECT * FROM learnings WHERE id = ?').get(learningId);
  }

  forgetAllLearnings(agentId, actor) {
    this.db.prepare("UPDATE learnings SET status = 'user_deleted' WHERE agent_id = ? AND status = 'active'").run(agentId);
    this.logChange(actor, 'learning', agentId, 'forget_all', {});
  }

  #rowToLearning = (row) => ({
    id: row.id,
    agentId: row.agent_id,
    meetingId: row.meeting_id,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    sourceTurnIds: parseJsonColumn(row.source_turn_ids, []),
    status: row.status,
    timesReinforced: row.times_reinforced,
    createdAt: row.created_at,
    lastReinforcedAt: row.last_reinforced_at
  });
}
