import { nanoid } from 'nanoid';

import { openDatabase } from './db.js';

function now() {
  return new Date().toISOString();
}

// Nombre de carpeta del proyecto: sin acentos, sin espacios, sin sorpresas
// en el sistema de archivos.
function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
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
    knowledge: row.knowledge || '',
    craft: row.craft || '',
    companyId: row.company_id || null,
    role: row.role || 'worker',
    managerId: row.manager_id || null,
    learningEnabled: Boolean(row.learning_enabled),
    version: row.version
  };
}

function rowToCompany(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    emoji: row.emoji,
    color: row.color,
    scenario: row.scenario,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
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

  // Primer arranque: crea la Distribuidora Norte desde la plantilla.
  // Bases anteriores a v2: crea la empresa default y adopta agentes y
  // reuniones huérfanos (además de migrar voces Gemini → Supertonic).
  ensureCompanies(companyTemplates, legacyVoiceMap = {}) {
    for (const [from, to] of Object.entries(legacyVoiceMap)) {
      this.db.prepare('UPDATE agents SET voice = ? WHERE voice = ?').run(to, from);
    }

    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM companies').get();
    if (count === 0) {
      const template = companyTemplates.templates.find((item) => item.id === 'distribuidora') || companyTemplates.templates[0];
      const orphanAgents = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE company_id IS NULL").get().count;
      if (orphanAgents > 0) {
        // DB pre-v2: adoptar lo existente bajo la empresa default.
        const company = this.insertCompany({
          name: template.name,
          industry: template.industry,
          emoji: template.emoji,
          color: template.color,
          scenario: template.scenario
        }, 'migration');
        this.db.prepare('UPDATE agents SET company_id = ? WHERE company_id IS NULL').run(company.id);
        this.db.prepare('UPDATE meetings SET company_id = ? WHERE company_id IS NULL').run(company.id);
        return company;
      }
      return this.createCompanyFromTemplate(template, 'seed');
    }
    return null;
  }

  // ── Empresas ───────────────────────────────────────────────────────────

  insertCompany(data, actor) {
    const id = nanoid(10);
    const at = now();
    this.db.prepare(`
      INSERT INTO companies (id, name, industry, emoji, color, scenario, status, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, data.name, data.industry || '', data.emoji || '🏢', data.color || '#4c6ef5', data.scenario || '', at, at);
    this.logChange(actor, 'company', id, 'create', { name: data.name });
    return this.getCompany(id);
  }

  createCompanyFromTemplate(template, actor = 'user') {
    const company = this.insertCompany(template, actor);
    let ceoId = null;
    for (const employee of template.employees || []) {
      const agentId = employee.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-') + '-' + nanoid(4);
      const role = employee.role || 'worker';
      this.insertAgent({
        id: agentId,
        companyId: company.id,
        name: employee.name,
        title: employee.title,
        voice: employee.voice || 'M1',
        color: employee.color || company.color,
        style: employee.style || '',
        aliases: employee.aliases || [employee.name.toLowerCase()],
        domains: employee.skills || [],
        boundaries: employee.boundaries || [],
        knowledge: employee.knowledge || '',
        craft: employee.craft || '',
        role,
        managerId: role === 'ceo' ? null : ceoId
      }, 'builtin', actor);
      if (role === 'ceo') {
        ceoId = agentId;
      }
    }
    return company;
  }

  // Metas sin carpeta (creadas antes de los proyectos, o por una migración
  // que corrió antes de este relleno): quedan en 'general', que es donde se
  // mudan sus archivos al arrancar. Idempotente.
  slugTaken(companyId, slug) {
    return Boolean(this.db.prepare('SELECT 1 FROM goals WHERE company_id = ? AND slug = ? LIMIT 1').get(companyId, slug));
  }

  ensureGoalSlugs() {
    const result = this.db.prepare(
      "UPDATE goals SET slug = 'general' WHERE slug IS NULL OR slug = ''"
    ).run();
    return result.changes;
  }

  // Toda empresa necesita CEO y contratista para el flujo de trabajo:
  // a las empresas viejas se les suman genéricos y el equipo reporta al CEO.
  ensureLeadership(companyTemplates) {
    for (const company of this.listCompanies()) {
      const team = this.listAgents({ companyId: company.id });
      let ceo = team.find((agent) => agent.role === 'ceo');
      if (!ceo) {
        const ceoId = 'ceo-' + nanoid(6);
        ceo = this.insertAgent({
          id: ceoId,
          companyId: company.id,
          name: 'Delia',
          title: 'CEO',
          voice: 'F5',
          color: company.color,
          style: 'Ejecutiva cercana: clara y al grano. Resume, prioriza y reparte el trabajo, y cierra las reuniones repasando quién quedó con qué.',
          aliases: ['delia', 'ceo', 'jefa', 'directora'],
          domains: ['estrategia', 'prioridades', 'planificacion', 'coordinacion', 'objetivos'],
          boundaries: ['No baja a detalles técnicos finos; delega y coordina.', 'No asigna trabajo sin explicar el porqué.'],
          knowledge: `Dirige ${company.name}: sabe qué está haciendo cada integrante del equipo y es la interlocutora directa del dueño (vos).`,
          craft: 'Traduce un pedido difuso en un objetivo con criterio de éxito y un alcance realista. Reparte según la fortaleza real de cada uno, dice qué NO entra en esta vuelta y explica siempre el porqué antes del qué.',
          role: 'ceo',
          managerId: null
        }, 'builtin', 'migration');
      }
      if (!team.some((agent) => agent.role === 'contratista')) {
        this.insertAgent({
          id: 'contratista-' + nanoid(6),
          companyId: company.id,
          name: 'Franco',
          title: 'Contratista de talento',
          voice: 'M4',
          color: company.color,
          style: 'Observador y resolutivo: cuando falta una habilidad en el equipo lo dice y propone el perfil exacto que hay que sumar.',
          aliases: ['franco', 'contratista', 'talento', 'reclutador'],
          domains: ['contratacion', 'perfiles', 'talento', 'reclutamiento', 'equipo nuevo'],
          boundaries: ['No contrata sin una necesidad concreta.', 'No duplica roles existentes.'],
          knowledge: 'Detecta cuando una tarea necesita habilidades que el equipo no tiene y crea al empleado ideal (nombre, rol, skills, conocimientos y personalidad).',
          craft: 'Identifica la brecha exacta de habilidades: qué tarea no puede hacer nadie y por qué. Diseña perfiles concretos con responsabilidad, skills operativas, oficio y límites, sin superponerse con el equipo, y entrega una primera tarea que ya aporta valor.',
          role: 'contratista',
          managerId: ceo.id
        }, 'builtin', 'migration');
      }
      // Empresas creadas antes del oficio: se completa desde la plantilla
      // por coincidencia de nombre (no pisa lo que ya tenga texto).
      for (const template of companyTemplates?.templates || []) {
        for (const employee of template.employees || []) {
          if (employee.craft) {
            this.db.prepare(
              "UPDATE agents SET craft = ? WHERE company_id = ? AND name = ? AND (craft IS NULL OR craft = '')"
            ).run(employee.craft, company.id, employee.name);
          }
        }
      }

      // El resto del equipo reporta al CEO si no tiene jefe.
      this.db.prepare("UPDATE agents SET manager_id = ? WHERE company_id = ? AND role != 'ceo' AND (manager_id IS NULL OR manager_id = '')")
        .run(ceo.id, company.id);
      // Y sumar a los nuevos a las reuniones activas existentes de la empresa.
      for (const meeting of this.db.prepare("SELECT id FROM meetings WHERE company_id = ? AND status = 'active'").all(company.id)) {
        for (const agent of this.listAgents({ companyId: company.id })) {
          this.addAgentToMeeting(meeting.id, agent.id);
        }
      }
    }
  }

  getCompany(companyId) {
    return rowToCompany(this.db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId));
  }

  listCompanies() {
    return this.db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM agents a WHERE a.company_id = c.id AND a.status = 'active') AS team_size,
             (SELECT COUNT(*) FROM meetings m WHERE m.company_id = c.id) AS meeting_count
      FROM companies c WHERE c.status = 'active' ORDER BY c.last_active_at DESC
    `).all().map((row) => ({ ...rowToCompany(row), teamSize: row.team_size, meetingCount: row.meeting_count }));
  }

  updateCompany(companyId, patch, actor = 'user') {
    const company = this.getCompany(companyId);
    if (!company) {
      return null;
    }
    this.db.prepare('UPDATE companies SET name = ?, industry = ?, emoji = ?, color = ?, scenario = ? WHERE id = ?').run(
      patch.name ?? company.name,
      patch.industry ?? company.industry,
      patch.emoji ?? company.emoji,
      patch.color ?? company.color,
      patch.scenario ?? company.scenario,
      companyId
    );
    this.logChange(actor, 'company', companyId, 'update', { patch });
    return this.getCompany(companyId);
  }

  archiveCompany(companyId, actor = 'user') {
    this.db.prepare("UPDATE companies SET status = 'archived' WHERE id = ?").run(companyId);
    this.logChange(actor, 'company', companyId, 'archive', {});
  }

  touchCompany(companyId) {
    this.db.prepare('UPDATE companies SET last_active_at = ? WHERE id = ?').run(now(), companyId);
  }

  insertAgent(profile, origin, actor) {
    const at = now();
    this.db.prepare(`
      INSERT INTO agents (id, origin, status, name, title, voice, color, style,
        aliases_json, domains_json, boundaries_json, knowledge, craft, company_id, role, manager_id, learning_enabled, version, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
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
      profile.knowledge || '',
      profile.craft || '',
      profile.companyId || null,
      profile.role || 'worker',
      profile.managerId || null,
      at,
      at
    );
    this.logChange(actor, 'agent', profile.id, 'create', { name: profile.name, origin });
    return this.getAgent(profile.id);
  }

  getAgent(agentId) {
    return rowToAgent(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId));
  }

  listAgents({ includeArchived = false, companyId = null } = {}) {
    let query = 'SELECT * FROM agents';
    const conditions = [];
    const params = [];
    if (!includeArchived) {
      conditions.push("status = 'active'");
    }
    if (companyId) {
      conditions.push('company_id = ?');
      params.push(companyId);
    }
    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at';
    return this.db.prepare(query).all(...params).map(rowToAgent);
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
      knowledge: patch.knowledge ?? current.knowledge,
      learningEnabled: patch.learningEnabled ?? current.learningEnabled
    };

    this.db.prepare(`
      UPDATE agents SET name = ?, title = ?, voice = ?, color = ?, style = ?,
        aliases_json = ?, domains_json = ?, boundaries_json = ?, knowledge = ?, learning_enabled = ?,
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
      next.knowledge,
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

  createMeeting({ companyId, scenarioName = null, scenarioText = null } = {}) {
    const id = nanoid(10);
    const at = now();
    this.db.prepare(`
      INSERT INTO meetings (id, company_id, scenario_name, scenario_text, status, created_at, last_active_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, companyId || null, scenarioName, scenarioText, at, at);

    for (const agent of this.listAgents({ companyId })) {
      this.db.prepare('INSERT INTO meeting_agents (meeting_id, agent_id, enabled) VALUES (?, ?, 1)').run(id, agent.id);
    }
    if (companyId) {
      this.touchCompany(companyId);
    }
    return this.getMeeting(id);
  }

  getMeeting(meetingId) {
    return this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) || null;
  }

  findResumableMeeting(meetingId, companyId = null) {
    if (!meetingId) {
      return null;
    }
    const meeting = this.db.prepare("SELECT * FROM meetings WHERE id = ? AND status = 'active'").get(meetingId) || null;
    if (meeting && companyId && meeting.company_id !== companyId) {
      return null;
    }
    return meeting;
  }

  listMeetings(limit = 30, companyId = null) {
    if (companyId) {
      return this.db.prepare(`
        SELECT id, company_id, title, scenario_name, status, created_at, last_active_at, closed_at, turn_count, summary
        FROM meetings WHERE company_id = ? ORDER BY last_active_at DESC LIMIT ?
      `).all(companyId, limit);
    }
    return this.db.prepare(`
      SELECT id, company_id, title, scenario_name, status, created_at, last_active_at, closed_at, turn_count, summary
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

  insertTask(meetingId, agentId, { id = null, text, completed = false, createdAt = null, kind = 'entregable', parentTaskId = null, reviewerId = null }) {
    const taskId = id || 'task-' + nanoid(6);
    this.db.prepare(`
      INSERT INTO tasks (id, meeting_id, agent_id, text, completed, created_at, completed_at, kind, parent_task_id, reviewer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, meetingId, agentId, text, completed ? 1 : 0, createdAt || now(), completed ? now() : null, kind, parentTaskId, reviewerId);
    return taskId;
  }

  setTaskKind(taskId, kind) {
    this.db.prepare('UPDATE tasks SET kind = ? WHERE id = ?').run(kind, taskId);
  }

  getTask(taskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null;
  }

  setReviewStatus(taskId, reviewStatus, reviewerId = null) {
    this.db.prepare('UPDATE tasks SET review_status = ?, reviewer_id = COALESCE(?, reviewer_id) WHERE id = ?')
      .run(reviewStatus, reviewerId, taskId);
  }

  // ── Comentarios entre compañeros (colaboración visible) ────────────────

  addTaskComment({ taskId, companyId, authorId, kind = 'nota', text }) {
    const id = 'cmt-' + nanoid(8);
    this.db.prepare(`
      INSERT INTO task_comments (id, task_id, company_id, author_id, kind, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, companyId, authorId, kind, String(text).slice(0, 4000), now());
    return id;
  }

  taskComments(taskId) {
    return this.db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at').all(taskId);
  }

  recentComments(companyId, limit = 40) {
    return this.db.prepare(
      'SELECT * FROM task_comments WHERE company_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(companyId, limit);
  }

  reassignTask(taskId, agentId) {
    this.db.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run(agentId, taskId);
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

  // ── Metas y trabajo (estilo Paperclip) ─────────────────────────────────

  createGoal({ companyId, meetingId = null, title, description = '', kind = 'proyecto', slug = null }) {
    const id = 'goal-' + nanoid(8);
    // Cada proyecto necesita SU carpeta: dos reuniones con el mismo título no
    // pueden terminar escribiendo sobre los archivos de la otra.
    const base = slug || slugify(title) || id;
    let folder = base;
    for (let suffix = 2; this.slugTaken(companyId, folder); suffix += 1) {
      folder = `${base}-${suffix}`;
    }
    this.db.prepare(`
      INSERT INTO goals (id, company_id, meeting_id, title, description, status, created_at, kind, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, meetingId, title, description, kind === 'acuerdo' ? 'done' : 'active', now(), kind, folder);
    this.logChange('user', 'goal', id, 'create', { title, kind });
    return this.getGoal(id);
  }

  getGoal(goalId) {
    return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) || null;
  }

  listGoals(companyId, status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM goals WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(companyId, status);
    }
    return this.db.prepare('SELECT * FROM goals WHERE company_id = ? ORDER BY created_at DESC').all(companyId);
  }

  completeGoalIfDone(goalId) {
    const remaining = this.db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE goal_id = ? AND status IN ('pending','in_progress')"
    ).get(goalId).count;
    if (remaining === 0) {
      this.db.prepare("UPDATE goals SET status = 'done', completed_at = ? WHERE id = ? AND status = 'active'").run(now(), goalId);
      return this.getGoal(goalId)?.status === 'done';
    }
    return false;
  }

  // Las tareas que NO son entregables (acuerdos, seguimientos) quedan
  // registradas como 'noted': se ven en el tablero pero nadie las "trabaja".
  assignTaskToGoal(taskId, goalId, { kind = 'entregable' } = {}) {
    const status = kind === 'decision' || kind === 'seguimiento' ? 'noted' : 'pending';
    this.db.prepare('UPDATE tasks SET goal_id = ?, status = ?, kind = ? WHERE id = ?').run(goalId, status, kind, taskId);
  }

  // Checkout atómico: un solo worker puede tomar la tarea (semántica issue).
  checkoutTask(taskId) {
    const result = this.db.prepare(
      "UPDATE tasks SET status = 'in_progress', run_count = run_count + 1 WHERE id = ? AND status = 'pending'"
    ).run(taskId);
    return result.changes === 1;
  }

  finishTask(taskId, { status, summary = null, blockedReason = null }) {
    this.db.prepare(`
      UPDATE tasks SET status = ?, result_summary = ?, blocked_reason = ?,
        completed = CASE WHEN ? = 'done' THEN 1 ELSE completed END,
        completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(status, summary, blockedReason, status, status, now(), taskId);
  }

  workQueue(companyId) {
    return this.db.prepare(`
      SELECT t.* FROM tasks t JOIN goals g ON g.id = t.goal_id
      WHERE g.company_id = ? AND g.status = 'active' AND t.status = 'pending'
        AND t.kind IN ('entregable', 'revision', 'contratacion')
      ORDER BY t.created_at
    `).all(companyId);
  }

  tasksForGoal(goalId) {
    return this.db.prepare('SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at').all(goalId);
  }

  activeWorkCompanies() {
    return this.db.prepare(`
      SELECT DISTINCT g.company_id AS id FROM goals g
      JOIN tasks t ON t.goal_id = g.id
      WHERE g.status = 'active' AND t.status IN ('pending','in_progress')
    `).all().map((row) => row.id);
  }

  startWorkRun(taskId, agentId, companyId) {
    const result = this.db.prepare(`
      INSERT INTO work_runs (task_id, agent_id, company_id, started_at, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(taskId, agentId, companyId, now());
    return result.lastInsertRowid;
  }

  finishWorkRun(runId, { status, summary = null, log = [], artifacts = [] }) {
    this.db.prepare(`
      UPDATE work_runs SET ended_at = ?, status = ?, summary = ?, log_json = ?, artifacts_json = ?
      WHERE id = ?
    `).run(now(), status, summary, JSON.stringify(log).slice(0, 200000), JSON.stringify(artifacts), runId);
  }

  recentWorkRuns(companyId, limit = 30) {
    return this.db.prepare(`
      SELECT id, task_id, agent_id, started_at, ended_at, status, summary, artifacts_json
      FROM work_runs WHERE company_id = ? ORDER BY id DESC LIMIT ?
    `).all(companyId, limit).map((row) => ({
      ...row,
      artifacts: parseJsonColumn(row.artifacts_json, [])
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

  // ── Ajustes del usuario ────────────────────────────────────────────────

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now());
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  allSettings() {
    const out = {};
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      out[row.key] = row.value;
    }
    return out;
  }

  // ── Sugerencias del tuner ──────────────────────────────────────────────

  insertSuggestion(agentId, kind, value, evidence = {}) {
    const result = this.db.prepare(`
      INSERT INTO router_suggestions (agent_id, kind, value, evidence_json, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(agentId, kind, value, JSON.stringify(evidence), now());
    return result.lastInsertRowid;
  }

  listSuggestions(status = 'pending') {
    return this.db.prepare('SELECT * FROM router_suggestions WHERE status = ? ORDER BY id DESC LIMIT 50')
      .all(status)
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        kind: row.kind,
        value: row.value,
        evidence: parseJsonColumn(row.evidence_json, {}),
        status: row.status,
        createdAt: row.created_at
      }));
  }

  getSuggestion(id) {
    const row = this.db.prepare('SELECT * FROM router_suggestions WHERE id = ?').get(id);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      agentId: row.agent_id,
      kind: row.kind,
      value: row.value,
      evidence: parseJsonColumn(row.evidence_json, {}),
      status: row.status
    };
  }

  resolveSuggestion(id, status) {
    this.db.prepare('UPDATE router_suggestions SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id);
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
