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

  -- Las metas anteriores a los proyectos vivían en una carpeta plana:
  -- se les asigna 'general', que es donde se mueven sus archivos al arrancar.
  UPDATE goals SET slug = 'general' WHERE slug IS NULL;

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
  `,

  // v6: el oficio del empleado (cómo hace bien su trabajo). Separado de
  // 'knowledge' porque este texto alimenta el prompt de TRABAJO, no el de
  // la conversación: en la reunión el agente habla como persona, no recita
  // su manual de procedimientos.
  `
  ALTER TABLE agents ADD COLUMN craft TEXT;
  `,

  // v7: una tarea puede quedar sin reunión. Al borrar una reunión pasada, lo
  // que produjo trabajo sobrevive desligado; con meeting_id NOT NULL no había
  // forma de soltarlo y el borrado fallaba contra la clave foránea.
  `
  CREATE TABLE tasks_nuevo (
    id             TEXT PRIMARY KEY,
    meeting_id     TEXT REFERENCES meetings(id),
    agent_id       TEXT NOT NULL,
    text           TEXT NOT NULL,
    completed      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    completed_at   TEXT,
    goal_id        TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    blocked_reason TEXT,
    result_summary TEXT,
    run_count      INTEGER NOT NULL DEFAULT 0,
    kind           TEXT NOT NULL DEFAULT 'entregable',
    reviewer_id    TEXT,
    review_status  TEXT,
    parent_task_id TEXT
  );
  INSERT INTO tasks_nuevo SELECT
    id, meeting_id, agent_id, text, completed, created_at, completed_at,
    goal_id, status, blocked_reason, result_summary, run_count, kind,
    reviewer_id, review_status, parent_task_id
  FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_nuevo RENAME TO tasks;
  CREATE INDEX idx_tasks_meeting ON tasks(meeting_id, agent_id);
  CREATE INDEX idx_tasks_goal ON tasks(goal_id, status);
  `,

  // v8: el PROYECTO pasa a ser el contenedor. Antes las reuniones colgaban de
  // la empresa y el proyecto era un subproducto de cerrarlas; ahora es al
  // revés — se entra a un proyecto y adentro viven sus reuniones, sus tareas y
  // su actividad. Así el agente recibe el contexto de UN proyecto y no el de
  // toda la empresa, que es de donde venía que cada vuelta improvisara.
  //
  // 'phase' ordena la cola: hasta que no está escrita la spec (fase 1) no sale
  // ninguna tarea de construcción (fase 2).
  `
  ALTER TABLE meetings ADD COLUMN goal_id TEXT REFERENCES goals(id);
  ALTER TABLE goals ADD COLUMN stack       TEXT NOT NULL DEFAULT '';
  ALTER TABLE goals ADD COLUMN brief       TEXT NOT NULL DEFAULT '';
  ALTER TABLE goals ADD COLUMN archived_at TEXT;
  ALTER TABLE tasks ADD COLUMN phase       INTEGER NOT NULL DEFAULT 2;
  CREATE INDEX idx_meetings_goal ON meetings(goal_id, last_active_at);

  -- 1) La reunión que YA parió un proyecto se cuelga de ese proyecto.
  UPDATE meetings SET goal_id = (
    SELECT g.id FROM goals g WHERE g.meeting_id = meetings.id ORDER BY g.created_at LIMIT 1
  )
  WHERE EXISTS (SELECT 1 FROM goals g WHERE g.meeting_id = meetings.id);

  -- 2) Para las que quedaron sueltas hace falta un proyecto 'General' por
  --    empresa. 'general' es justo la carpeta donde migrateLegacyLayout()
  --    ya deja los archivos que se escribieron antes de los proyectos.
  INSERT INTO goals (id, company_id, meeting_id, title, description, status, created_at, kind, slug, stack, brief)
  SELECT 'goal-general-' || c.id, c.id, NULL, 'General',
         'Reuniones y trabajo anteriores a la organización por proyecto.',
         'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'proyecto', 'general', '', ''
  FROM companies c
  WHERE EXISTS (SELECT 1 FROM meetings m WHERE m.company_id = c.id AND m.goal_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.company_id = c.id AND g.slug = 'general');

  -- 3) Y ahí van las huérfanas. Ninguna reunión queda sin padre.
  UPDATE meetings SET goal_id = (
    SELECT g.id FROM goals g WHERE g.company_id = meetings.company_id AND g.slug = 'general' LIMIT 1
  )
  WHERE goal_id IS NULL AND company_id IS NOT NULL;
  `,

  // v9: el nicho de la empresa (web, automatizacion, movil-rn, android). Define
  // qué playbook recibe el equipo cuando trabaja y con qué marco de dispositivo
  // se previsualiza. Los proyectos heredan el de su empresa.
  //
  `
  ALTER TABLE companies ADD COLUMN stack TEXT NOT NULL DEFAULT 'web';
  `,

  // v10: el catálogo pasa a ser solo de estudios técnicos, así que las empresas
  // de otros rubros se ARCHIVAN: salen del listado pero su equipo, sus reuniones
  // y su workspace quedan intactos y se restauran desde "Archivadas".
  `
  UPDATE companies SET status = 'archived'
  WHERE status = 'active'
    AND industry NOT IN (
      'Tecnología', 'Desarrollo web', 'Automatizaciones',
      'Apps móviles (React Native)', 'Apps Android nativas'
    );
  `,

  // v11: cada entregable declara QUÉ ARCHIVO produce.
  //
  // Sin esto el equipo repartía por disciplina — "definir la paleta",
  // "implementar el parallax", "revisar prolijidad" — y esas tareas no
  // mapean a ningún archivo propio: el motor exige producir uno para dar la
  // tarea por hecha, así que agotaban los 12 pasos y quedaban bloqueadas.
  // Con el archivo declarado, el reparto queda anclado al esquema real del
  // proyecto y cada quien sabe qué le toca escribir.
  `
  ALTER TABLE tasks ADD COLUMN target_file TEXT;
  `,

  // v12: rename Sofia → Pablo (2026-11-08). La instalación existente creó
  // la compañía y el agente con el nombre viejo desde el template 'sofia'
  // (ahora 'pablo'): se renombran compañía, agente, aliases en DB, voz
  // (F1→M1, como el template) y los textos en femenino. Idempotente: solo
  // toca filas con el nombre exacto 'Sofia' (sin acento) — la 'Sofía'
  // ingeniera del Laboratorio Python es otra persona y no se toca. El
  // historial de turnos no se reescribe: lo dicho queda como se dijo.
  `
  UPDATE companies SET name = 'Pablo',
    scenario = REPLACE(scenario, 'Sofia es el asistente', 'Pablo es el asistente')
  WHERE name = 'Sofia';
  UPDATE agents SET name = 'Pablo',
    voice = CASE WHEN voice = 'F1' THEN 'M1' ELSE voice END,
    aliases_json = REPLACE(aliases_json, '"sofia"', '"pablo"'),
    knowledge = REPLACE(knowledge, 'LA interlocutora', 'EL interlocutor'),
    style = REPLACE(style, 'interlocutora', 'interlocutor')
  WHERE name = 'Sofia';
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
