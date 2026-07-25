import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Migraciones ordenadas: cada entrada sube user_version en 1.
// Nunca editar una migración ya aplicada; agregar una nueva al final.
const MIGRATIONS = [
  `
  CREATE TABLE meetings (
    id             TEXT PRIMARY KEY,
    title          TEXT,
    scenario_name  TEXT,
    scenario_text  TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    closed_at      TEXT,
    summary        TEXT,
    turn_count     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    turn_id    TEXT,
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('user','agent','system')),
    speaker    TEXT NOT NULL,
    agent_id   TEXT,
    text       TEXT NOT NULL
  );
  CREATE INDEX idx_turns_meeting ON turns(meeting_id, id);

  CREATE TABLE agents (
    id               TEXT PRIMARY KEY,
    origin           TEXT NOT NULL DEFAULT 'custom',
    status           TEXT NOT NULL DEFAULT 'active',
    name             TEXT NOT NULL,
    title            TEXT NOT NULL,
    voice            TEXT NOT NULL,
    color            TEXT NOT NULL,
    style            TEXT NOT NULL DEFAULT '',
    aliases_json     TEXT NOT NULL DEFAULT '[]',
    domains_json     TEXT NOT NULL DEFAULT '[]',
    boundaries_json  TEXT NOT NULL DEFAULT '[]',
    learning_enabled INTEGER NOT NULL DEFAULT 1,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE agent_profile_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL REFERENCES agents(id),
    version      INTEGER NOT NULL,
    profile_json TEXT NOT NULL,
    changed_by   TEXT NOT NULL,
    change_note  TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE meeting_agents (
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    agent_id   TEXT NOT NULL REFERENCES agents(id),
    enabled    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (meeting_id, agent_id)
  );

  CREATE TABLE tasks (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id),
    agent_id     TEXT NOT NULL,
    text         TEXT NOT NULL,
    completed    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_tasks_meeting ON tasks(meeting_id, agent_id);

  CREATE TABLE learnings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id           TEXT,
    meeting_id         TEXT,
    type               TEXT NOT NULL CHECK (type IN ('user_preference','correction','fact','skill_note')),
    content            TEXT NOT NULL,
    confidence         REAL NOT NULL DEFAULT 0.7,
    source_turn_ids    TEXT NOT NULL DEFAULT '[]',
    status             TEXT NOT NULL DEFAULT 'active',
    times_reinforced   INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    last_reinforced_at TEXT NOT NULL
  );
  CREATE INDEX idx_learnings_agent ON learnings(agent_id, status);

  CREATE TABLE changelog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );

  CREATE TABLE session_summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id   TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    summary_json TEXT NOT NULL
  );

  CREATE TABLE telemetry_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id   TEXT,
    turn_id      TEXT,
    at           TEXT NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX idx_telemetry_meeting ON telemetry_events(meeting_id, id);

  CREATE TABLE router_suggestions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT NOT NULL,
    kind          TEXT NOT NULL,
    value         TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL,
    resolved_at   TEXT
  );
  `,
  // v2: simulaciones de empresas — cada empresa tiene su equipo de
  // empleados (agents) y sus reuniones. knowledge = conocimiento propio
  // del empleado que se inyecta en su prompt.
  `
  CREATE TABLE companies (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    industry       TEXT NOT NULL DEFAULT '',
    emoji          TEXT NOT NULL DEFAULT '🏢',
    color          TEXT NOT NULL DEFAULT '#4c6ef5',
    scenario       TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );

  ALTER TABLE agents ADD COLUMN company_id TEXT;
  ALTER TABLE agents ADD COLUMN knowledge TEXT NOT NULL DEFAULT '';
  ALTER TABLE meetings ADD COLUMN company_id TEXT;
  CREATE INDEX idx_agents_company ON agents(company_id, status);
  CREATE INDEX idx_meetings_company ON meetings(company_id, last_active_at);
  `,
  // v3: ajustes del usuario (claves de API y elección de modelos) —
  // sobreescriben a las variables de entorno.
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v4: empresa digital estilo Paperclip — jerarquía (rol + jefe), metas
  // que bajan en cascada desde las reuniones, tareas con checkout atómico
  // y corridas de trabajo (heartbeats) con log y artefactos.
  `
  ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  ALTER TABLE agents ADD COLUMN manager_id TEXT;

  CREATE TABLE goals (
    id           TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL,
    meeting_id   TEXT,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_goals_company ON goals(company_id, status);

  ALTER TABLE tasks ADD COLUMN goal_id TEXT;
  ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
  ALTER TABLE tasks ADD COLUMN result_summary TEXT;
  ALTER TABLE tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET status = 'done' WHERE completed = 1;

  CREATE TABLE work_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    company_id    TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    summary       TEXT,
    log_json      TEXT NOT NULL DEFAULT '[]',
    artifacts_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_work_runs_task ON work_runs(task_id, id);
  CREATE INDEX idx_work_runs_company ON work_runs(company_id, id);
  `,

  // v5: proyectos con carpeta propia, tareas tipadas (no todo es entregable)
  // y revisión entre compañeros.
  `
  ALTER TABLE goals ADD COLUMN slug TEXT;
  ALTER TABLE goals ADD COLUMN kind TEXT NOT NULL DEFAULT 'proyecto';

  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'entregable';
  ALTER TABLE tasks ADD COLUMN reviewer_id TEXT;
  ALTER TABLE tasks ADD COLUMN review_status TEXT;
  ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;

  CREATE TABLE task_comments (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    company_id  TEXT,
    author_id   TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'nota',
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);
  CREATE INDEX idx_task_comments_company ON task_comments(company_id, created_at);
  `
];

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return db;
}
