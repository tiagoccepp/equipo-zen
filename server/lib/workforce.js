import { mkdirSync } from 'node:fs';
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

export const WORKSPACE_ROOT = path.join(rootDir, 'workspace');

const TICK_MS = Number(process.env.WORKFORCE_TICK_MS || 5000);
const MAX_CONCURRENT = Number(process.env.WORKFORCE_MAX_CONCURRENT || 2);
const MAX_STEPS_PER_RUN = 8;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES_PER_RUN = 12;
const STEP_TIMEOUT_MS = Number(process.env.WORKFORCE_STEP_TIMEOUT_MS || 180000);

function safeWorkspacePath(companyId, relative) {
  const base = path.join(WORKSPACE_ROOT, companyId);
  const target = path.resolve(base, String(relative || ''));
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))) {
    throw new Error(`Ruta fuera del workspace: ${relative}`);
  }
  return target;
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

    if (agent.role === 'contratista') {
      return this.executeHiring(companyId, agent, task, runId);
    }
    return this.executeWork(companyId, agent, task, runId);
  }

  // ── Trabajo real con herramientas de archivos ─────────────────────────

  async executeWork(companyId, agent, task, runId) {
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;
    const company = this.store.getCompany(companyId);
    const workspaceDir = path.join(WORKSPACE_ROOT, companyId);
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
      'Reglas: contenido completo en cada write_file (no parches). NO listes archivos más de una vez. Andá directo a producir: en el paso 1 ya podés escribir. Terminá con finish cuando el entregable esté REALMENTE completo y usable. Si la tarea pide una página/app web, el HTML debe verse profesional (CSS embebido, responsive). Máximo ' + MAX_STEPS_PER_RUN + ' pasos.'
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
        this.store.finishTask(task.id, { status: 'pending' }); // vuelve a la cola
        this.emitEvent(companyId, { kind: 'task_retry', taskId: task.id, agentId: agent.id, agentName: agent.name });
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
          const content = await fs.readFile(safeWorkspacePath(companyId, action.path), 'utf-8');
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
          const heredoc = rawText.match(/<<<CONTENIDO\n?([\s\S]*?)\n?CONTENIDO>>>/);
          const content = heredoc ? heredoc[1] : String(action.content ?? '');
          if (!content.trim()) {
            throw new Error('write_file sin contenido (usá los marcadores <<<CONTENIDO … CONTENIDO>>>)');
          }
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
            throw new Error('archivo demasiado grande');
          }
          if (filesWritten >= MAX_FILES_PER_RUN) {
            throw new Error('límite de archivos por corrida alcanzado');
          }
          const target = safeWorkspacePath(companyId, action.path);
          mkdirSync(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, 'utf-8');
          filesWritten += 1;
          artifacts.add(String(action.path));
          log.push({ step, action: 'write_file', path: action.path, bytes: Buffer.byteLength(content), ok: true });
          lastObservation = `Escribí ${action.path} (${Buffer.byteLength(content)} bytes). Si el entregable ya está completo y usable, respondé finish.`;
          this.emitEvent(companyId, { kind: 'file_written', taskId: task.id, agentId: agent.id, agentName: agent.name, path: String(action.path) });
        } catch (error) {
          log.push({ step, action: 'write_file', path: action.path, ok: false, note: String(error?.message).slice(0, 120) });
          lastObservation = `No pude escribir ${action.path}: ${String(error?.message).slice(0, 120)}`;
        }
      } else if (action.action === 'finish') {
        const summary = String(action.summary || 'Tarea completada.').slice(0, 500);
        const finalArtifacts = [...new Set([...(action.artifacts || []), ...artifacts])].map(String).slice(0, 20);
        this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: finalArtifacts });
        this.store.finishTask(task.id, { status: 'done', summary });
        this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: finalArtifacts });
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

    // Sin finish en el presupuesto de pasos: lo hecho queda, la tarea se bloquea con contexto.
    this.store.finishWorkRun(runId, { status: 'blocked', summary: 'Se quedó sin pasos antes del finish.', log, artifacts: [...artifacts] });
    this.store.finishTask(task.id, { status: 'blocked', blockedReason: 'Agotó los pasos de la corrida; revisar el alcance de la tarea.' });
    this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason: 'sin pasos' });
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
      '{"name":"nombre de pila hispano","title":"puesto","skills":["6-10 skills en minúsculas para el ruteo"],"knowledge":"2-3 oraciones de conocimiento concreto del puesto","style":"personalidad y forma de hablar en 1-2 oraciones","voice":"M1|M2|M3|M4|M5|F1|F2|F3|F4|F5","boundaries":["1-2 límites"],"firstTask":"la tarea concreta que debe ejecutar ya (relacionada a la necesidad)"}'
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
