import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { rootDir } from './config.js';
import { completeChat, parseJsonFromModel } from './llm.js';
import { getMinimaxModels } from './settings.js';
import { telemetry } from './telemetry.js';

// Motor de trabajo estilo Paperclip: los empleados NO trabajan en vivo
// durante la reunión — al cerrarse, las tareas de la meta entran a una
// cola y este motor las ejecuta por heartbeats: checkout atómico, pasos
// acotados con herramientas de archivos (sandbox por empresa), log
// durable por corrida y artefactos reales servidos en /workspace.

// TODO lo que la empresa produce vive acá dentro y en ningún otro lado:
// workspace/<empresa>/<proyecto>/… Es el único punto de escritura del
// sistema y está aislado del resto del repo.
export const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(rootDir, 'workspace'));

const TICK_MS = Number(process.env.WORKFORCE_TICK_MS || 5000);
const MAX_CONCURRENT = Number(process.env.WORKFORCE_MAX_CONCURRENT || 2);
const MAX_STEPS_PER_RUN = Number(process.env.WORKFORCE_MAX_STEPS || 10);
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES_PER_RUN = 12;
const STEP_TIMEOUT_MS = Number(process.env.WORKFORCE_STEP_TIMEOUT_MS || 180000);
// Tope de reintentos por tarea: evita el bucle infinito si el modelo no responde.
const MAX_RUNS_PER_TASK = Number(process.env.WORKFORCE_MAX_RUNS_PER_TASK || 3);

// Solo formatos de entregable: nada ejecutable, nada de configuración del host.
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt',
  '.svg', '.csv', '.xml', '.yml', '.yaml', '.ts', '.tsx', '.jsx'
]);

export function projectDir(companyId, projectSlug) {
  return path.join(WORKSPACE_ROOT, String(companyId), String(projectSlug || 'general'));
}

// Guardia del sandbox: la ruta resultante tiene que caer DENTRO de la carpeta
// del proyecto, sin escapes (..), sin ocultos, sin symlinks y con extensión
// permitida.
function safeWorkspacePath(companyId, projectSlug, relative) {
  const base = projectDir(companyId, projectSlug);
  const raw = String(relative || '').trim();
  if (!raw || path.isAbsolute(raw) || raw.includes('\0')) {
    throw new Error(`Ruta inválida: ${relative}`);
  }
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))) {
    throw new Error(`Ruta fuera del proyecto: ${relative}`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Extensión no permitida (${ext || 'sin extensión'}). Usá: ${[...ALLOWED_EXTENSIONS].slice(0, 8).join(', ')}…`);
  }
  return target;
}

// El contenido del archivo puede llegar de varias formas según cómo el modelo
// decida responder: entre los marcadores (lo pedido), dentro del JSON con
// distintos nombres de campo, o simplemente pegado después del JSON. Todas
// valen: rechazarlas quemaba pasos de la corrida sin producir nada.
export function extractFileContent(rawText, action) {
  const heredoc = String(rawText || '').match(/<<<CONTENIDO\n?([\s\S]*?)\n?CONTENIDO>>>/);
  if (heredoc) {
    return heredoc[1];
  }
  for (const key of ['content', 'contents', 'text', 'body', 'data', 'file']) {
    if (typeof action?.[key] === 'string' && action[key].trim()) {
      return action[key];
    }
  }
  // Última chance: lo que venga después del JSON de la acción.
  const text = String(rawText || '');
  const closing = text.indexOf('}');
  if (closing >= 0) {
    const rest = text.slice(closing + 1)
      .replace(/^\s*```[a-z]*\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (rest.length > 40) {
      return rest;
    }
  }
  return '';
}

export class Workforce {
  constructor(store, keyRing, { onEvent } = {}) {
    this.store = store;
    this.keyRing = keyRing;
    this.onEvent = onEvent;
    this.busyAgents = new Set();
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
    this.migrateLegacyLayout();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        telemetry.add({ type: 'workforce_tick_failed', payload: { error: String(error?.message || error).slice(0, 200) } });
      });
    }, TICK_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Antes de los proyectos, todo se escribía suelto en workspace/<empresa>/.
  // Esos archivos se mudan a la carpeta 'general' para que sigan visibles
  // desde la UI (y para que el entorno tenga una sola forma).
  migrateLegacyLayout() {
    let companies = [];
    try {
      companies = readdirSync(WORKSPACE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return;
    }
    for (const company of companies) {
      const companyPath = path.join(WORKSPACE_ROOT, company.name);
      let loose = [];
      try {
        loose = readdirSync(companyPath, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
      } catch {
        continue;
      }
      if (loose.length === 0) {
        continue;
      }
      const target = path.join(companyPath, 'general');
      mkdirSync(target, { recursive: true });
      for (const file of loose) {
        try {
          renameSync(path.join(companyPath, file.name), path.join(target, file.name));
        } catch {
          // Un archivo que no se puede mover no debe frenar el arranque.
        }
      }
      telemetry.add({ type: 'workspace_layout_migrated', payload: { companyId: company.name, files: loose.length } });
    }
  }

  emitEvent(companyId, event) {
    telemetry.add({ type: `work_${event.kind}`, payload: { companyId, ...event } });
    this.onEvent?.(companyId, { type: 'work_event', ...event });
  }

  async tick() {
    if (!this.keyRing.hasKeys() || this.busyAgents.size >= MAX_CONCURRENT) {
      return;
    }
    for (const companyId of this.store.activeWorkCompanies()) {
      for (const task of this.store.workQueue(companyId)) {
        if (this.busyAgents.size >= MAX_CONCURRENT) {
          return;
        }
        const agent = this.store.getAgent(task.agent_id);
        if (!agent || agent.status !== 'active' || this.busyAgents.has(agent.id)) {
          continue;
        }
        if (!this.store.checkoutTask(task.id)) {
          continue;
        }
        this.busyAgents.add(agent.id);
        void this.executeTask(companyId, agent, task)
          .catch((error) => {
            this.store.finishTask(task.id, { status: 'blocked', blockedReason: String(error?.message || error).slice(0, 300) });
          })
          .finally(() => {
            this.busyAgents.delete(agent.id);
            if (task.goal_id && this.store.completeGoalIfDone(task.goal_id)) {
              const goal = this.store.getGoal(task.goal_id);
              this.emitEvent(companyId, { kind: 'goal_done', goalId: task.goal_id, title: goal?.title });
            }
          });
      }
    }
  }

  async executeTask(companyId, agent, task) {
    const runId = this.store.startWorkRun(task.id, agent.id, companyId);
    this.emitEvent(companyId, { kind: 'task_started', taskId: task.id, agentId: agent.id, agentName: agent.name, text: task.text });

    if (task.kind === 'revision') {
      return this.executeReview(companyId, agent, task, runId);
    }
    if (agent.role === 'contratista') {
      return this.executeHiring(companyId, agent, task, runId);
    }
    return this.executeWork(companyId, agent, task, runId);
  }

  // ── Trabajo real con herramientas de archivos ─────────────────────────

  async executeWork(companyId, agent, task, runId) {
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;
    const company = this.store.getCompany(companyId);
    const slug = goal?.slug || 'general';
    const workspaceDir = projectDir(companyId, slug);
    mkdirSync(workspaceDir, { recursive: true });

    const log = [];
    const artifacts = new Set();
    let filesWritten = 0;

    const listFiles = async () => {
      const out = [];
      const walk = async (dir, prefix) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.')) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), rel);
          } else {
            out.push(rel);
          }
        }
      };
      await walk(workspaceDir, '');
      return out.slice(0, 100);
    };

    const teammates = this.store.listAgents({ companyId })
      .filter((a) => a.id !== agent.id)
      .map((a) => `${a.name} (${a.title})`).join(', ');

    const system = [
      `Sos ${agent.name}, ${agent.title} de ${company?.name || 'la empresa'}. AHORA NO estás en una reunión: estás TRABAJANDO, produciendo un entregable real.`,
      agent.knowledge ? `Tu conocimiento: ${agent.knowledge}` : '',
      agent.craft ? `TU OFICIO (cómo hacés bien tu trabajo): ${agent.craft}` : '',
      `Tus skills: ${agent.domains.join(', ')}.`,
      `Compañeros (pueden haber dejado archivos en el workspace): ${teammates || 'ninguno'}.`,
      '',
      'Trabajás editando archivos del workspace compartido. En CADA respuesta ejecutás UNA acción:',
      '- Para escribir un archivo respondé EXACTAMENTE así (el contenido va CRUDO entre los marcadores, sin escapar):',
      '{"action":"write_file","path":"ruta/relativa"}',
      '<<<CONTENIDO',
      '…el archivo COMPLETO acá, tal cual…',
      'CONTENIDO>>>',
      '- Otras acciones (solo el JSON, nada más):',
      '{"action":"read_file","path":"ruta/relativa"}',
      '{"action":"list_files"}',
      '{"action":"finish","summary":"qué hiciste en 1-3 oraciones en español","artifacts":["archivos","principales"]}',
      '{"action":"block","reason":"qué te falta para poder avanzar"}',
      '',
      'Reglas: contenido completo en cada write_file (no parches). NO listes archivos más de una vez. Andá directo a producir: en el paso 1 ya podés escribir. Terminá con finish cuando el entregable esté REALMENTE completo y usable. Máximo ' + MAX_STEPS_PER_RUN + ' pasos.',
      '',
      'ESTÁNDAR DE CALIDAD (te van a revisar, y una revisión negativa te devuelve el trabajo):',
      '- Contenido REAL y específico de esta empresa: nada de "Lorem ipsum", "Texto de ejemplo", "Servicio 1" ni placeholders.',
      '- Nada de TODOs, secciones vacías, enlaces rotos (#) sin destino ni promesas de "completar después".',
      '- Si es una página/app web: HTML5 semántico (header/nav/main/section/footer), CSS embebido con variables de color coherentes,',
      '  tipografía cuidada y jerarquía visual clara, responsive de verdad (media queries, sin scroll horizontal en móvil),',
      '  contraste accesible, foco visible, alt en imágenes y <title>/<meta description> propios. Sin librerías externas ni CDNs.',
      '- Preferí SVG inline o gradientes CSS antes que imágenes remotas (no hay internet en el navegador del usuario).',
      '- Si es un documento: estructura con títulos, datos concretos y conclusiones accionables, no relleno.'
    ].filter(Boolean).join('\n');

    // El contexto de la tarea viaja SIEMPRE; cada paso suma la historia de
    // acciones + la última observación (nunca se pierde el "qué" ni el "porqué").
    const header = [
      goal ? `META DE LA EMPRESA (el porqué): ${goal.title} — ${goal.description}` : '',
      `TU TAREA (el qué): ${task.text}`,
      `Archivos al empezar: ${JSON.stringify(await listFiles())}`
    ].filter(Boolean).join('\n');
    let lastObservation = 'Todavía no hiciste ninguna acción.';

    for (let step = 1; step <= MAX_STEPS_PER_RUN; step += 1) {
      let action = null;
      let rawText = '';
      try {
        const history = log.length
          ? 'Acciones que ya hiciste: ' + log.map((entry) => `${entry.step}:${entry.action}${entry.path ? '(' + entry.path + ')' : ''}${entry.ok === false ? '✗' : ''}`).join(', ')
          : '';
        const { text } = await completeChat(this.keyRing, {
          models: getMinimaxModels(),
          scope: `trabajo ${agent.name}`,
          timeoutMs: STEP_TIMEOUT_MS,
          maxTokens: 16000,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: [header, history, `Última observación: ${lastObservation}`, `Paso ${step}/${MAX_STEPS_PER_RUN}. Tu próxima acción:`].filter(Boolean).join('\n\n') }
          ]
        });
        rawText = text;
        action = parseJsonFromModel(text.split('<<<CONTENIDO')[0]);
      } catch (error) {
        log.push({ step, action: 'error', note: String(error?.message || error).slice(0, 200) });
        this.store.finishWorkRun(runId, { status: 'error', summary: 'Falló la llamada al modelo.', log, artifacts: [...artifacts] });
        if (task.run_count >= MAX_RUNS_PER_TASK) {
          const reason = `Falló ${task.run_count} veces seguidas al llamar al modelo. Revisá la clave o el estado del servicio.`;
          this.store.finishTask(task.id, { status: 'blocked', blockedReason: reason });
          this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason });
          return;
        }
        this.store.finishTask(task.id, { status: 'pending' }); // vuelve a la cola
        this.emitEvent(companyId, { kind: 'task_retry', taskId: task.id, agentId: agent.id, agentName: agent.name, attempt: task.run_count });
        return;
      }

      if (!action?.action) {
        log.push({ step, action: 'invalid', note: 'respuesta sin JSON de acción' });
        lastObservation = 'Tu respuesta anterior no tenía un JSON de acción válido. Respondé con el formato exacto de las acciones.';
        continue;
      }

      if (action.action === 'list_files') {
        const files = await listFiles();
        log.push({ step, action: 'list_files', note: `${files.length} archivos` });
        lastObservation = `Archivos: ${JSON.stringify(files)}. No vuelvas a listar: escribí o terminá.`;
      } else if (action.action === 'read_file') {
        try {
          const content = await fs.readFile(safeWorkspacePath(companyId, slug, action.path), 'utf-8');
          log.push({ step, action: 'read_file', path: action.path, ok: true });
          lastObservation = `Contenido de ${action.path}:\n${content.slice(0, 20000)}`;
        } catch (error) {
          log.push({ step, action: 'read_file', path: action.path, ok: false });
          lastObservation = `No pude leer ${action.path}: ${String(error?.message).slice(0, 120)}`;
        }
      } else if (action.action === 'write_file') {
        try {
          // El contenido viene crudo entre marcadores (robusto para HTML/CSS),
          // o inline en el JSON como fallback.
          const content = extractFileContent(rawText, action);
          if (!content.trim()) {
            throw new Error('write_file sin contenido (usá los marcadores <<<CONTENIDO … CONTENIDO>>>)');
          }
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
            throw new Error('archivo demasiado grande');
          }
          if (filesWritten >= MAX_FILES_PER_RUN) {
            throw new Error('límite de archivos por corrida alcanzado');
          }
          const target = safeWorkspacePath(companyId, slug, action.path);
          mkdirSync(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, 'utf-8');
          filesWritten += 1;
          artifacts.add(String(action.path));
          log.push({ step, action: 'write_file', path: action.path, bytes: Buffer.byteLength(content), ok: true });
          lastObservation = `Escribí ${action.path} (${Buffer.byteLength(content)} bytes). Si el entregable ya está completo y usable, respondé finish.`;
          this.emitEvent(companyId, { kind: 'file_written', taskId: task.id, agentId: agent.id, agentName: agent.name, path: String(action.path) });
        } catch (error) {
          log.push({ step, action: 'write_file', path: action.path, ok: false, note: String(error?.message).slice(0, 120) });
          lastObservation = [
            `No pude escribir ${action.path}: ${String(error?.message).slice(0, 160)}`,
            'Repetí la acción con este formato EXACTO, el contenido crudo entre los marcadores:',
            `{"action":"write_file","path":"${action.path}"}`,
            '<<<CONTENIDO',
            '<!doctype html> … el archivo entero …',
            'CONTENIDO>>>'
          ].join('\n');
        }
      } else if (action.action === 'finish') {
        const summary = String(action.summary || 'Tarea completada.').slice(0, 500);
        const finalArtifacts = [...new Set([...(action.artifacts || []), ...artifacts])].map(String).slice(0, 20);
        this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: finalArtifacts });
        this.store.finishTask(task.id, { status: 'done', summary });
        this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: finalArtifacts });
        this.requestReview(companyId, agent, task, finalArtifacts);
        return;
      } else if (action.action === 'block') {
        const reason = String(action.reason || 'Bloqueado.').slice(0, 300);
        this.store.finishWorkRun(runId, { status: 'blocked', summary: reason, log, artifacts: [...artifacts] });
        this.store.finishTask(task.id, { status: 'blocked', blockedReason: reason });
        this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason });
        return;
      } else {
        log.push({ step, action: 'unknown', note: String(action.action).slice(0, 40) });
        lastObservation = `Acción desconocida "${action.action}". Usá list_files, read_file, write_file, finish o block.`;
      }
    }

    // Se acabaron los pasos. Si alcanzó a producir archivos, el trabajo existe
    // y cuenta como hecho (queda la revisión del compañero para juzgarlo);
    // si no produjo nada, ahí sí la tarea queda bloqueada con contexto.
    const produced = [...artifacts];
    if (produced.length > 0) {
      const summary = `Entregó ${produced.join(', ')} (se quedó sin pasos antes de cerrar el resumen).`;
      this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: produced });
      this.store.finishTask(task.id, { status: 'done', summary });
      this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: produced });
      this.requestReview(companyId, agent, task, produced);
      return;
    }
    this.store.finishWorkRun(runId, { status: 'blocked', summary: 'Se quedó sin pasos sin producir nada.', log, artifacts: [] });
    this.store.finishTask(task.id, { status: 'blocked', blockedReason: 'Agotó los pasos sin producir un entregable; revisar el alcance de la tarea.' });
    this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason: 'sin pasos' });
  }

  // ── Revisión entre compañeros ─────────────────────────────────────────

  // Elige quién revisa: un compañero con skills afines al entregable (no el
  // autor, no el contratista). Si nadie encaja, revisa la CEO.
  pickReviewer(companyId, author, task) {
    const words = new Set(String(task.text || '').toLowerCase().split(/[^\p{L}0-9]+/u).filter((w) => w.length > 3));
    const candidates = this.store.listAgents({ companyId })
      .filter((a) => a.id !== author.id && a.status === 'active' && a.role !== 'contratista');
    if (candidates.length === 0) {
      return null;
    }
    const scored = candidates.map((a) => {
      const overlap = a.domains.filter((d) => words.has(String(d).toLowerCase())).length;
      const qaBoost = /qa|calidad|test/i.test(`${a.title} ${a.domains.join(' ')}`) ? 2 : 0;
      const designBoost = /dise|ux|ui/i.test(`${a.title} ${a.domains.join(' ')}`) && /web|p[áa]gina|landing|sitio|interfaz/i.test(task.text || '') ? 2 : 0;
      return { agent: a, score: overlap * 2 + qaBoost + designBoost + (a.role === 'ceo' ? -1 : 0) };
    }).sort((a, b) => b.score - a.score);
    return scored[0].agent;
  }

  requestReview(companyId, author, task, artifacts) {
    // Solo entregables originales con archivos: las correcciones ya nacen de
    // una revisión y no se vuelven a revisar (evita el ida y vuelta infinito).
    if (task.kind !== 'entregable' || !artifacts.length || task.parent_task_id || task.review_status) {
      return;
    }
    const reviewer = this.pickReviewer(companyId, author, task);
    if (!reviewer) {
      return;
    }
    const reviewTaskId = this.store.insertTask(task.meeting_id, reviewer.id, {
      text: `Revisar el trabajo de ${author.name}: ${task.text}`,
      kind: 'revision',
      parentTaskId: task.id
    });
    this.store.assignTaskToGoal(reviewTaskId, task.goal_id, { kind: 'revision' });
    this.store.setReviewStatus(task.id, 'pendiente', reviewer.id);
    this.emitEvent(companyId, {
      kind: 'review_requested',
      taskId: reviewTaskId,
      targetTaskId: task.id,
      agentId: reviewer.id,
      agentName: reviewer.name,
      authorName: author.name
    });
  }

  async executeReview(companyId, reviewer, task, runId) {
    const parent = task.parent_task_id ? this.store.getTask(task.parent_task_id) : null;
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;
    const slug = goal?.slug || 'general';
    const author = parent ? this.store.getAgent(parent.agent_id) : null;

    if (!parent) {
      this.store.finishWorkRun(runId, { status: 'blocked', summary: 'No encontré el trabajo a revisar.', log: [], artifacts: [] });
      this.store.finishTask(task.id, { status: 'blocked', blockedReason: 'Sin tarea original.' });
      return;
    }

    // Lee de verdad lo que produjo el compañero (hasta 3 archivos).
    const dir = projectDir(companyId, slug);
    const files = [];
    const walk = async (current, prefix) => {
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
        else files.push(rel);
      }
    };
    await walk(dir, '');

    const contents = [];
    for (const rel of files.slice(0, 3)) {
      const text = await fs.readFile(path.join(dir, rel), 'utf-8').catch(() => '');
      if (text) {
        contents.push(`--- ${rel} (${Buffer.byteLength(text)} bytes) ---\n${text.slice(0, 18000)}`);
      }
    }

    const prompt = [
      `Sos ${reviewer.name}, ${reviewer.title}. Revisás el trabajo de ${author?.name || 'un compañero'} con criterio profesional y honesto.`,
      `Tus skills: ${reviewer.domains.join(', ')}.`,
      reviewer.craft ? `Tu oficio: ${reviewer.craft}` : '',
      goal ? `Proyecto: ${goal.title} — ${goal.description}` : '',
      `Tarea que se le encargó: ${parent.text}`,
      `Lo que dijo que hizo: ${parent.result_summary || '—'}`,
      '',
      files.length ? `Archivos del proyecto: ${JSON.stringify(files.slice(0, 30))}` : 'No hay archivos en el proyecto.',
      contents.length ? `\nCONTENIDO REAL:\n${contents.join('\n\n')}` : '',
      '',
      'Revisá contra estos criterios: (1) ¿cumple lo que se pidió?, (2) ¿tiene contenido real o hay placeholders/TODOs/lorem ipsum?,',
      '(3) si es web: ¿HTML semántico, responsive, contraste y foco accesibles, se ve profesional?, (4) ¿algo roto o vacío?',
      'Sé exigente pero justo: aprobá si está bien hecho, pedí cambios SOLO si hay algo concreto que arreglar.',
      '',
      'Respondé SOLO un JSON:',
      '{"verdict":"aprobado|cambios","comment":"2-4 oraciones en español, dirigidas al compañero, concretas","issues":["arreglo puntual 1","arreglo puntual 2"]}'
    ].filter(Boolean).join('\n');

    let verdict = 'aprobado';
    let comment = '';
    let issues = [];
    try {
      const { text } = await completeChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `revisión ${reviewer.name}`,
        timeoutMs: STEP_TIMEOUT_MS,
        maxTokens: 4000,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      });
      const parsed = parseJsonFromModel(text) || {};
      verdict = parsed.verdict === 'cambios' ? 'cambios' : 'aprobado';
      comment = String(parsed.comment || '').slice(0, 1200);
      issues = (Array.isArray(parsed.issues) ? parsed.issues : []).map(String).slice(0, 5);
    } catch (error) {
      this.store.finishWorkRun(runId, { status: 'error', summary: 'Falló la revisión.', log: [{ error: String(error?.message || error).slice(0, 200) }], artifacts: [] });
      this.store.finishTask(task.id, task.run_count >= MAX_RUNS_PER_TASK
        ? { status: 'blocked', blockedReason: 'No se pudo completar la revisión tras varios intentos.' }
        : { status: 'pending' });
      return;
    }

    if (!comment) {
      comment = verdict === 'aprobado' ? 'Revisado: cumple con lo pedido.' : 'Revisado: hay cambios pendientes.';
    }

    this.store.addTaskComment({
      taskId: parent.id,
      companyId,
      authorId: reviewer.id,
      kind: verdict === 'aprobado' ? 'aprobacion' : 'cambios',
      text: issues.length ? `${comment}\n• ${issues.join('\n• ')}` : comment
    });
    this.store.setReviewStatus(parent.id, verdict, reviewer.id);

    const summary = `${verdict === 'aprobado' ? 'Aprobado' : 'Pedí cambios'}: ${comment}`;
    this.store.finishWorkRun(runId, { status: 'ok', summary, log: [{ verdict, issues }], artifacts: [] });
    this.store.finishTask(task.id, { status: 'done', summary });
    this.emitEvent(companyId, {
      kind: 'review_done',
      taskId: task.id,
      targetTaskId: parent.id,
      agentId: reviewer.id,
      agentName: reviewer.name,
      authorName: author?.name || '',
      verdict,
      comment
    });

    // Cambios pedidos: vuelve al autor UNA vez, con la lista concreta.
    if (verdict === 'cambios' && author) {
      const fixText = `Aplicar la revisión de ${reviewer.name} sobre "${parent.text}": ${issues.length ? issues.join('; ') : comment}`;
      const fixId = this.store.insertTask(parent.meeting_id, author.id, {
        text: fixText.slice(0, 900),
        kind: 'entregable',
        parentTaskId: parent.id
      });
      this.store.assignTaskToGoal(fixId, parent.goal_id, { kind: 'entregable' });
      this.emitEvent(companyId, {
        kind: 'changes_requested',
        taskId: fixId,
        agentId: author.id,
        agentName: author.name,
        reviewerName: reviewer.name
      });
    }
  }

  // ── Contratación: el contratista crea al empleado que falta ───────────

  async executeHiring(companyId, contratista, task, runId) {
    const company = this.store.getCompany(companyId);
    const team = this.store.listAgents({ companyId });
    const ceo = team.find((a) => a.role === 'ceo');
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;

    const prompt = [
      `Sos ${contratista.name}, contratista de talento de ${company?.name}. Tenés que CREAR al empleado ideal para esta necesidad.`,
      goal ? `Meta: ${goal.title} — ${goal.description}` : '',
      `Necesidad: ${task.text}`,
      `Equipo actual (NO dupliques roles): ${team.map((a) => `${a.name} — ${a.title} [${a.domains.slice(0, 6).join(', ')}]`).join(' | ')}`,
      '',
      'Respondé SOLO un JSON válido:',
      '{"name":"nombre de pila hispano","title":"puesto","skills":["6-10 skills en minúsculas para el ruteo"],"knowledge":"2-3 oraciones de conocimiento concreto del puesto","craft":"3-4 oraciones de OFICIO: el método concreto y el estándar de calidad con el que produce su trabajo (técnicas, criterios, qué revisa antes de dar algo por terminado)","style":"personalidad y forma de hablar en 1-2 oraciones","voice":"M1|M2|M3|M4|M5|F1|F2|F3|F4|F5","boundaries":["1-2 límites"],"firstTask":"la tarea concreta que debe ejecutar ya (relacionada a la necesidad)"}'
    ].filter(Boolean).join('\n');

    const { text } = await completeChat(this.keyRing, {
      models: getMinimaxModels(),
      scope: 'contratista',
      timeoutMs: STEP_TIMEOUT_MS,
      maxTokens: 4000,
      temperature: 0.5,
      messages: [{ role: 'user', content: prompt }]
    });
    const profile = parseJsonFromModel(text);
    if (!profile?.name || !profile?.title) {
      this.store.finishWorkRun(runId, { status: 'error', summary: 'No pude definir el perfil.', log: [{ raw: text?.slice(0, 300) }], artifacts: [] });
      this.store.finishTask(task.id, { status: 'blocked', blockedReason: 'El contratista no logró definir el perfil.' });
      return;
    }

    const agentId = profile.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '-') + '-' + nanoid(4);
    const hired = this.store.insertAgent({
      id: agentId,
      companyId,
      name: String(profile.name).slice(0, 40),
      title: String(profile.title).slice(0, 80),
      voice: ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].includes(profile.voice) ? profile.voice : 'M2',
      color: company?.color || '#4c6ef5',
      style: String(profile.style || '').slice(0, 500),
      aliases: [profile.name.toLowerCase()],
      domains: (profile.skills || []).map(String).slice(0, 12),
      boundaries: (profile.boundaries || []).map(String).slice(0, 4),
      knowledge: String(profile.knowledge || '').slice(0, 2000),
      craft: String(profile.craft || '').slice(0, 2000),
      role: 'worker',
      managerId: ceo?.id || null
    }, 'custom', 'contratista');

    // Se suma a las reuniones activas de la empresa y hereda la tarea real.
    for (const meeting of this.store.listMeetings(10, companyId).filter((m) => m.status === 'active')) {
      this.store.addAgentToMeeting(meeting.id, hired.id);
    }
    const firstTaskText = String(profile.firstTask || task.text).slice(0, 300);
    const newTaskId = this.store.insertTask(task.meeting_id, hired.id, { text: firstTaskText });
    if (task.goal_id) {
      this.store.assignTaskToGoal(newTaskId, task.goal_id);
    }

    const summary = `Contraté a ${hired.name} (${hired.title}) y le asigné: "${firstTaskText}".`;
    this.store.finishWorkRun(runId, { status: 'ok', summary, log: [{ action: 'hire', agentId: hired.id }], artifacts: [] });
    this.store.finishTask(task.id, { status: 'done', summary });
    this.emitEvent(companyId, { kind: 'agent_hired', taskId: task.id, agentId: hired.id, agentName: hired.name, title: hired.title, by: contratista.name, summary });
  }
}
