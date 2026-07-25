import { nanoid } from 'nanoid';

import {
  AUDIO_MIME_TYPE,
  MAX_CONTEXTUAL_FOLLOWUPS,
  ROUTER_TIMEOUT_MS,
  TELEMETRY_MAX_EVENTS
} from './config.js';
import { getMinimaxModels } from './settings.js';
import { LiveAgentRuntime } from './agent-runtime.js';
import { completeChat, parseJsonFromModel } from './llm.js';
import { LearningObserver, renderLearningsSection } from './learning.js';
import { MeetingMemory } from './memory.js';
import { ReflectionRunner } from './reflection.js';
import { registerSession, unregisterSession } from './priority.js';
import { logEvent } from './session-log.js';
import { AgentRouter } from './router.js';
import { renderWorkSection } from './workforce.js';
import { getErrorText, getShortError } from './text.js';
import { summarizeClientMessage, summarizeServerMessage, telemetry } from './telemetry.js';
import { CaptureTranscriberRuntime } from './transcriber.js';
import { CancellableTurnQueue, SpeakerGate } from './turn-pipeline.js';

const MAX_SESSION_AGENTS = 8;
// Paciencia: cuánto se espera tras el último fragmento antes de rutear.
const USER_TURN_SETTLE_MS = Number(process.env.USER_TURN_SETTLE_MS || 2600);
const USER_TURN_SETTLE_EXTENDED_MS = Number(process.env.USER_TURN_SETTLE_EXTENDED_MS || 6000);

// Tipos de telemetría que alimentan el auto-ajuste del router: se persisten
// en SQLite además del ring en RAM.
const PERSISTED_TELEMETRY_TYPES = new Set([
  'route_decision',
  'contextual_route_decision',
  'no_agent_response',
  'ai_route_planned',
  'turn_error'
]);

// Una sola sesión WS viva por reunión (single-writer): una segunda pestaña
// que intente retomar la misma reunión recibe una reunión nueva.
const activeSessionsByMeeting = new Map();

// Difusión a todas las sesiones vivas de una empresa (eventos de trabajo).
export function broadcastToCompany(companyId, payload) {
  for (const session of activeSessionsByMeeting.values()) {
    if (session.company?.id === companyId) {
      session.send(payload);
    }
  }
}

// Reflexión post-reunión: singleton por proceso (los timers de debounce
// deben sobrevivir a la sesión WS y cancelarse si la reunión resume).
let reflectionRunner = null;
function getReflectionRunner(store, keyRing) {
  if (!reflectionRunner) {
    reflectionRunner = new ReflectionRunner(store, keyRing);
  }
  return reflectionRunner;
}

export class MeetingSession {
  constructor(socket, keyRingInstance, store) {
    this.id = nanoid(10);
    this.createdAt = new Date().toISOString();
    this.socket = socket;
    this.keyRing = keyRingInstance;
    this.store = store;

    // Se inicializan en initMeeting() cuando llega el hello del cliente.
    this.company = null;
    this.meeting = null;
    this.memory = null;
    this.sessionAgents = [];
    this.router = null;
    this.agents = new Map();

    this.transcriber = new CaptureTranscriberRuntime({
      emit: (event) => this.send(event),
      onTranscript: (text) => this.enqueueAudioTranscript(text)
    });
    this.gate = new SpeakerGate({ emit: (event) => this.send(event) });
    this.turnQueue = new CancellableTurnQueue({
      timeoutMs: Number(process.env.TURN_TIMEOUT_MS || 120000),
      maxPending: 10,
      onCancelled: (turnId, reason) => {
        this.send({ type: 'turn_cancelled', turnId, reason: reason === 'barge_in' ? 'barge_in' : 'superseded' });
        this.logTelemetry('turn_cancelled', { turnId, reason }, turnId);
      }
    });
    this.learningObserver = new LearningObserver(store, keyRingInstance);
    this.reflection = getReflectionRunner(store, keyRingInstance);
    // Paciencia conversacional: los mensajes seguidos del usuario se juntan
    // en UN solo turno antes de rutear (el agente espera a que termines la idea).
    this.pendingUser = null;
    this.pendingClose = null;
    // Con alguien conectado, el trabajo de fondo cede la clave.
    registerSession();
    this.sessionCounted = true;
  }

  createAgentRuntime(agent) {
    return new LiveAgentRuntime(agent, this.keyRing, this.memory, this);
  }

  initMeeting(requestedMeetingId = null, requestedCompanyId = null) {
    // Resolver la empresa: la pedida, o la más activa como fallback.
    this.company = (requestedCompanyId ? this.store.getCompany(requestedCompanyId) : null)
      || this.store.listCompanies()[0]
      || null;
    if (!this.company) {
      this.send({ type: 'error', message: 'No hay empresas creadas todavía.' });
      return;
    }

    let meeting = this.store.findResumableMeeting(requestedMeetingId, this.company.id);
    if (meeting && activeSessionsByMeeting.has(meeting.id)) {
      meeting = null;
    }
    const resumed = Boolean(meeting);
    if (!meeting) {
      meeting = this.store.createMeeting({ companyId: this.company.id });
    }

    this.meeting = meeting;
    activeSessionsByMeeting.set(meeting.id, this);
    this.reflection.cancelForMeeting(meeting.id);
    this.memory = new MeetingMemory({ store: this.store, meetingId: meeting.id });

    let restoredTurns = [];
    if (resumed) {
      const rows = this.store.recentTurns(meeting.id, 80);
      this.memory.hydrate(rows);
      restoredTurns = rows.slice(-40).map((row) => ({
        id: String(row.turn_id || row.id),
        kind: row.kind,
        speaker: row.speaker,
        agentId: row.agent_id,
        text: row.text
      }));
    }

    const tasksByAgent = new Map();
    for (const task of this.store.tasksForMeeting(meeting.id)) {
      if (!tasksByAgent.has(task.agentId)) {
        tasksByAgent.set(task.agentId, []);
      }
      tasksByAgent.get(task.agentId).push({
        id: task.id,
        text: task.text,
        completed: task.completed,
        createdAt: task.createdAt
      });
    }

    this.store.touchCompany(this.company.id);
    this.sessionAgents = this.store.rosterForMeeting(meeting.id).map((agent) => ({
      ...agent,
      tasks: tasksByAgent.get(agent.id) || []
    }));
    this.router = new AgentRouter(this.sessionAgents);
    this.agents = new Map(
      this.sessionAgents.map((agent) => [agent.id, this.createAgentRuntime(agent)])
    );

    telemetry.add({
      type: 'meeting_session_created',
      sessionId: this.id,
      payload: {
        meetingId: meeting.id,
        resumed,
        liveMode: this.keyRing.hasKeys(),
        agents: this.sessionAgents.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }))
      }
    });
    const mode = this.keyRing.hasKeys() ? 'stream' : 'mock';
    this.send({
      type: 'meeting_ready',
      id: this.id,
      meetingId: meeting.id,
      resumed,
      company: this.company,
      agents: this.publicAgents(),
      scenario: { name: this.company.name, text: meeting.scenario_text },
      turns: restoredTurns,
      model: getMinimaxModels()[0],
      liveMode: this.keyRing.hasKeys(),
      mode,
      agentBackends: Object.fromEntries(this.sessionAgents.map((agent) => [agent.id, mode]))
    });
  }

  closeCurrentMeeting(reason) {
    if (!this.meeting) {
      return;
    }
    const closingMeetingId = this.meeting.id;
    this.store.closeMeeting(closingMeetingId);
    this.reflection.runNow(closingMeetingId);
    if (activeSessionsByMeeting.get(this.meeting.id) === this) {
      activeSessionsByMeeting.delete(this.meeting.id);
    }
    this.logTelemetry('meeting_closed', { meetingId: this.meeting.id, reason });
    this.meeting = null;
    this.memory?.reset();
    this.transcriber.reset();
    for (const agent of this.agents.values()) {
      agent.reset();
    }
  }

  promptContext(agentId = null) {
    const scenarioText = this.company
      ? [
          this.company.scenario,
          this.meeting?.scenario_text ? `Objetivo de esta reunión: ${this.meeting.scenario_text}` : ''
        ].filter(Boolean).join('\n')
      : this.meeting?.scenario_text || '';
    return {
      agents: this.sessionAgents,
      scenario: this.company
        ? { name: `${this.company.name} (${this.company.industry})`, text: scenarioText }
        : null,
      workSection: renderWorkSection(this.store, this.company?.id),
      learningsSection: agentId ? renderLearningsSection(this.store, agentId) : ''
    };
  }

  closeCurrentMeeting(reason) {
    if (!this.meeting) {
      return;
    }
    const closingMeetingId = this.meeting.id;
    this.store.closeMeeting(closingMeetingId);
    this.reflection.runNow(closingMeetingId);
    if (activeSessionsByMeeting.get(this.meeting.id) === this) {
      activeSessionsByMeeting.delete(this.meeting.id);
    }
    this.logTelemetry('meeting_closed', { meetingId: this.meeting.id, reason });
    this.meeting = null;
    this.memory?.reset();
    this.transcriber.reset();
    for (const agent of this.agents.values()) {
      agent.reset();
    }
  }

  promptContext(agentId = null) {
    const scenarioText = this.company
      ? [
          this.company.scenario,
          this.meeting?.scenario_text ? `Objetivo de esta reunión: ${this.meeting.scenario_text}` : ''
        ].filter(Boolean).join('\n')
      : this.meeting?.scenario_text || '';
    return {
      agents: this.sessionAgents,
      scenario: this.company
        ? { name: `${this.company.name} (${this.company.industry})`, text: scenarioText }
        : null,
      workSection: renderWorkSection(this.store, this.company?.id),
      learningsSection: agentId ? renderLearningsSection(this.store, agentId) : ''
    };
  }

  // Qué está produciendo el equipo AHORA. Sin esto, preguntarle a la CEO cómo
  // viene un proyecto que su propio equipo está construyendo daba un "no sé".
  renderWorkSection() {
    if (!this.company) {
      return '';
    }
    const goals = this.store.listGoals(this.company.id, 'active').slice(0, 3);
    if (goals.length === 0) {
      return '';
    }
    const nameOf = (agentId) => this.store.getAgent(agentId)?.name || 'alguien del equipo';
    const ESTADOS = {
      pending: 'en cola',
      in_progress: 'trabajando ahora',
      done: 'terminada',
      blocked: 'trabada',
      noted: 'anotada como acuerdo'
    };

    const lines = [];
    for (const goal of goals) {
      const tasks = this.store.tasksForGoal(goal.id);
      lines.push(`Proyecto "${goal.title}":`);
      for (const task of tasks.slice(0, 8)) {
        const estado = ESTADOS[task.status] || task.status;
        const revision = task.review_status === 'cambios'
          ? ' (le pidieron cambios)'
          : task.review_status === 'aprobado' ? ' (revisada y aprobada)' : '';
        lines.push(`- ${nameOf(task.agent_id)}: ${task.text.slice(0, 120)} — ${estado}${revision}`);
      }
    }
    return [
      'TRABAJO EN CURSO DE LA EMPRESA (esto está pasando de verdad ahora mismo;',
      'si te preguntan cómo viene algo, respondé con esto y no digas que no sabés):',
      ...lines
    ].join('\n');
  }

  publicAgents() {
    return this.sessionAgents.map(({ id, name, title, color, domains, aliases, boundaries, knowledge, style, voice, tasks, origin, enabled, learningEnabled, role, managerId }) => ({
      id,
      name,
      title,
      color,
      domains,
      aliases,
      boundaries,
      knowledge,
      style,
      voice,
      tasks: tasks || [],
      origin,
      enabled,
      learningEnabled,
      role,
      managerId
    }));
  }


  async handleClientMessage(message) {
    this.logClientMessage(message);

    if (message.type === 'hello') {
      if (!this.meeting) {
        this.initMeeting(message.meetingId || null, message.companyId || null);
      }
      return;
    }

    if (!this.meeting) {
      this.send({ type: 'error', message: 'La reunión todavía no está inicializada; recargá la página.' });
      return;
    }

    if (message.type === 'interrupt') {
      // Barge-in: abortar el turno en curso, cortar el audio y avisar.
      const speakingAgentId = this.gate.owner?.agentId || message.agentId || null;
      const speakingTurnId = this.gate.owner?.turnId || message.turnId || null;
      if (this.pendingUser) {
        clearTimeout(this.pendingUser.timer);
        this.pendingUser = null;
      }
      this.turnQueue.interrupt(message.reason === 'barge_in' ? 'barge_in' : 'superseded');
      this.gate.flush();
      this.send({ type: 'agent_interrupted', turnId: speakingTurnId || undefined, agentId: speakingAgentId || undefined });
      logEvent('interrupcion', {
        meetingId: this.meeting?.id,
        motivo: message.reason,
        agenteInterrumpido: this.sessionAgents.find((a) => a.id === speakingAgentId)?.name || speakingAgentId,
        msReproducidos: message.playedMs ?? null
      });
      this.logTelemetry('user_interrupt', {
        reason: message.reason,
        agentId: speakingAgentId,
        playedMs: message.playedMs ?? null
      }, speakingTurnId);
      if (speakingAgentId) {
        this.memory.add('system', 'Orquestador', `El usuario interrumpió a ${this.sessionAgents.find(a => a.id === speakingAgentId)?.name || speakingAgentId} antes de que termine.`);
      }
      return;
    }

    if (message.type === 'playback_complete') {
      this.gate.onPlaybackComplete(message.turnId, message.agentId);
      return;
    }

    if (message.type === 'user_turn') {
      const text = String(message.text || '').trim();
      if (!text) {
        return;
      }
      this.enqueueUserTurn(text, 'text');
      return;
    }

    if (message.type === 'audio_prepare') {
      try {
        await this.transcriber.prepareListening();
      } catch (error) {
        this.send({
          type: 'api_rotation_failed',
          scope: 'audio',
          message: getShortError(error)
        });
      }
      return;
    }

    if (message.type === 'audio_start') {
      try {
        await this.transcriber.startListening();
      } catch (error) {
        this.send({
          type: 'api_rotation_failed',
          scope: 'audio',
          message: getShortError(error)
        });
      }
      return;
    }

    if (message.type === 'audio_chunk') {
      try {
        await this.transcriber.sendAudio(message.data, message.mimeType || AUDIO_MIME_TYPE);
      } catch (error) {
        this.send({
          type: 'api_rotation_failed',
          scope: 'audio',
          message: getShortError(error)
        });
      }
      return;
    }

    if (message.type === 'audio_end') {
      this.transcriber.endAudio({ closeStream: true, transcriptHint: message.transcriptHint });
      return;
    }

    if (message.type === 'audio_cancel') {
      this.transcriber.reset();
      this.logTelemetry('audio_turn_cancelled', {
        reason: message.reason || 'client_audio_gate',
        speechMs: message.speechMs || null
      });
      return;
    }

    if (message.type === 'audio_stop') {
      this.transcriber.stopListening();
      return;
    }

    if (message.type === 'reset') {
      // "Reiniciar reunión" = cerrar la reunión actual (queda en el
      // historial, reanudable solo por lista) y abrir una nueva.
      if (this.pendingUser) {
        clearTimeout(this.pendingUser.timer);
        this.pendingUser = null;
      }
      const companyId = this.company?.id || null;
      this.closeCurrentMeeting('user_reset');
      this.send({ type: 'meeting_reset' });
      this.initMeeting(null, companyId);
      return;
    }

    if (message.type === 'health') {
      this.send({ type: 'health', keys: this.keyRing.snapshot(), memory: this.memory.snapshot() });
      return;
    }

    if (message.type === 'spawn_agent') {
      const { name, title, color, aliases, domains, boundaries, style, voice, knowledge, initialTasks } = message.agent || {};
      if (!name || !title) {
        this.send({ type: 'error', message: 'Faltan campos obligatorios para crear el agente.' });
        return;
      }
      if (this.sessionAgents.length >= MAX_SESSION_AGENTS) {
        this.send({ type: 'error', message: `La mesa está completa (máximo ${MAX_SESSION_AGENTS} agentes).` });
        return;
      }
      if (this.sessionAgents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
        this.send({ type: 'error', message: `Ya hay un agente llamado ${name} en la mesa.` });
        return;
      }

      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + nanoid(4);

      const profile = {
        id,
        companyId: this.company.id,
        name,
        title,
        color: color || this.company.color || '#4c6ef5',
        aliases: Array.isArray(aliases) ? aliases : (aliases || '').split(',').map(s => s.trim()).filter(Boolean),
        domains: Array.isArray(domains) ? domains : (domains || '').split(',').map(s => s.trim()).filter(Boolean),
        boundaries: Array.isArray(boundaries) ? boundaries : (boundaries || '').split(',').map(s => s.trim()).filter(Boolean),
        knowledge: knowledge || '',
        style: style || 'Conversador estándar y profesional.',
        voice: voice || 'M1'
      };

      const lowerName = profile.name.toLowerCase();
      if (!profile.aliases.some(alias => alias.toLowerCase() === lowerName)) {
        profile.aliases.push(lowerName);
      }

      const stored = this.store.insertAgent(profile, 'custom', 'user');
      this.store.addAgentToMeeting(this.meeting.id, id);

      const tasks = (initialTasks || [])
        .map(t => t.trim())
        .filter(Boolean)
        .map((t) => {
          const taskId = this.store.insertTask(this.meeting.id, id, { text: t });
          return { id: taskId, text: t, completed: false, createdAt: new Date().toISOString() };
        });

      const newAgent = { ...stored, enabled: true, tasks };

      this.sessionAgents.push(newAgent);
      this.agents.set(id, this.createAgentRuntime(newAgent));
      this.logTelemetry('agent_spawned', { agentId: id, name, title, domains: newAgent.domains, taskCount: tasks.length });

      this.broadcastAgentsUpdated();

      const systemMsgId = nanoid(8);
      this.memory.add('system', 'Orquestador', `Se ha unido ${name} (${title}) a la mesa de trabajo.`, null, systemMsgId);
      this.send({
        type: 'user_turn_received',
        turnId: systemMsgId,
        text: `Se ha unido ${name} (${title}) a la mesa de trabajo.`,
        source: 'system'
      });
      return;
    }

    if (message.type === 'update_agent') {
      const agent = this.sessionAgents.find(a => a.id === message.agentId);
      if (!agent) {
        this.send({ type: 'error', message: 'No encontré ese agente en la mesa.' });
        return;
      }
      if (message.patch.name) {
        const lowerName = message.patch.name.toLowerCase();
        if (this.sessionAgents.some(a => a.id !== agent.id && a.name.toLowerCase() === lowerName)) {
          this.send({ type: 'error', message: `Ya hay un agente llamado ${message.patch.name} en la mesa.` });
          return;
        }
      }
      const updated = this.store.updateAgent(agent.id, message.patch, 'user', 'edición desde la UI');
      if (!updated) {
        this.send({ type: 'error', message: 'No pude guardar los cambios del agente.' });
        return;
      }
      Object.assign(agent, {
        name: updated.name,
        title: updated.title,
        voice: updated.voice,
        color: updated.color,
        style: updated.style,
        aliases: updated.aliases,
        domains: updated.domains,
        boundaries: updated.boundaries,
        knowledge: updated.knowledge,
        learningEnabled: updated.learningEnabled,
        version: updated.version
      });
      const runtime = this.agents.get(agent.id);
      if (runtime) {
        runtime.name = updated.name;
      }
      this.logTelemetry('agent_updated', { agentId: agent.id, fields: Object.keys(message.patch) });
      this.broadcastAgentsUpdated();
      return;
    }

    if (message.type === 'archive_agent') {
      const index = this.sessionAgents.findIndex(a => a.id === message.agentId);
      if (index === -1) {
        this.send({ type: 'error', message: 'No encontré ese agente en la mesa.' });
        return;
      }
      const agent = this.sessionAgents[index];
      if (agent.origin === 'builtin') {
        this.send({ type: 'error', message: `${agent.name} es parte del equipo base y no se puede archivar; podés deshabilitarlo para esta reunión.` });
        return;
      }
      this.store.archiveAgent(agent.id, 'user');
      this.sessionAgents.splice(index, 1);
      this.agents.get(agent.id)?.close();
      this.agents.delete(agent.id);
      this.logTelemetry('agent_archived', { agentId: agent.id, name: agent.name });
      this.broadcastAgentsUpdated();
      return;
    }

    if (message.type === 'set_agent_enabled') {
      const agent = this.sessionAgents.find(a => a.id === message.agentId);
      if (!agent) {
        this.send({ type: 'error', message: 'No encontré ese agente en la mesa.' });
        return;
      }
      agent.enabled = message.enabled;
      this.store.setAgentEnabled(this.meeting.id, agent.id, message.enabled);
      this.logTelemetry('agent_enabled_changed', { agentId: agent.id, enabled: message.enabled });
      this.broadcastAgentsUpdated();
      return;
    }

    if (message.type === 'end_meeting') {
      void this.prepareMeetingClose().catch((error) => {
        this.send({ type: 'error', message: 'No pude preparar el cierre de la reunión.', detail: getShortError(error) });
      });
      return;
    }

    if (message.type === 'confirm_end_meeting') {
      this.confirmMeetingClose();
      return;
    }

    if (message.type === 'set_scenario') {
      const updated = this.store.updateMeeting(this.meeting.id, { scenarioText: message.text || null });
      if (updated) {
        this.meeting = updated;
        this.logTelemetry('scenario_updated', { length: (message.text || '').length });
        this.send({
          type: 'scenario_updated',
          scenario: { name: updated.scenario_name, text: updated.scenario_text }
        });
      }
      return;
    }

    if (message.type === 'add_task') {
      const { agentId, text } = message;
      const agent = this.sessionAgents.find(a => a.id === agentId);
      if (agent && text?.trim()) {
        agent.tasks = agent.tasks || [];
        const taskId = this.store.insertTask(this.meeting.id, agentId, { text: text.trim() });
        agent.tasks.push({
          id: taskId,
          text: text.trim(),
          completed: false,
          createdAt: new Date().toISOString()
        });
        this.logTelemetry('task_added', { agentId, taskText: text.trim() });
        this.broadcastAgentsUpdated();
      }
      return;
    }

    if (message.type === 'toggle_task') {
      const { agentId, taskId, completed } = message;
      const agent = this.sessionAgents.find(a => a.id === agentId);
      if (agent) {
        const task = agent.tasks?.find(t => t.id === taskId);
        if (task) {
          task.completed = !!completed;
          this.store.setTaskCompleted(taskId, !!completed);
          this.logTelemetry('task_toggled', { agentId, taskId, completed: !!completed, taskText: task.text });
          this.broadcastAgentsUpdated();
        }
      }
      return;
    }

    if (message.type === 'delete_task') {
      const { agentId, taskId } = message;
      const agent = this.sessionAgents.find(a => a.id === agentId);
      if (agent) {
        const task = agent.tasks?.find(t => t.id === taskId);
        agent.tasks = (agent.tasks || []).filter(t => t.id !== taskId);
        this.store.deleteTask(taskId);
        this.logTelemetry('task_deleted', { agentId, taskId, taskText: task?.text });
        this.broadcastAgentsUpdated();
      }
      return;
    }
  }

  broadcastAgentsUpdated() {
    this.send({
      type: 'agents_updated',
      agents: this.publicAgents()
    });
  }

  // "Bruno y Hugo" / "Sofía, Damián" → los agentes que existan de verdad.
  static resolveTaskTargets(rawTargets, agents) {
    const partes = String(rawTargets || '')
      .split(/\s*(?:,|;|\/|\by\b|\be\b|&)\s*/iu)
      .map((parte) => parte.trim().toLowerCase())
      .filter(Boolean);
    const encontrados = [];
    for (const parte of partes) {
      const agente = agents.find((a) => a.id === parte || a.name.toLowerCase() === parte);
      if (agente && !encontrados.includes(agente)) {
        encontrados.push(agente);
      }
    }
    return encontrados;
  }

  // Alta con dedupe: el modelo repite la misma etiqueta en turnos seguidos y
  // aparecían tareas idénticas duplicadas en el tablero.
  assignTaskToAgent(agent, taskText) {
    const texto = String(taskText || '').trim();
    if (!texto) {
      return false;
    }
    agent.tasks = agent.tasks || [];
    const yaEsta = agent.tasks.some(
      (task) => !task.completed && task.text.trim().toLowerCase() === texto.toLowerCase()
    );
    if (yaEsta) {
      return false;
    }
    const newTaskId = this.store.insertTask(this.meeting.id, agent.id, { text: texto });
    agent.tasks.push({ id: newTaskId, text: texto, completed: false, createdAt: new Date().toISOString() });
    return true;
  }

  processAgentTaskCommands(agentId, text) {
    if (!text) return text;

    let cleanText = text;
    let changed = false;

    // 1. Parsear creaciones con destinatario explícito (nombre o id):
    // [TAREA_CREAR: Tomasa: descripción]
    const createRegex = /\[TAREA_CREAR:\s*([^:\]]+):\s*([^\]]+)\]/gu;
    let createMatch;
    while ((createMatch = createRegex.exec(text)) !== null) {
      const taskText = createMatch[2].trim();
      // Una etiqueta puede nombrar a más de una persona ("Bruno y Hugo",
      // "Sofía, Damián"): antes se descartaba entera y el trabajo se perdía.
      const targets = MeetingSession.resolveTaskTargets(createMatch[1], this.sessionAgents);
      for (const targetAgent of targets) {
        if (taskText && this.assignTaskToAgent(targetAgent, taskText)) {
          this.logTelemetry('task_created_by_agent', { agentId: targetAgent.id, createdBy: agentId, taskText, method: 'explicit_target' });
          changed = true;
        }
      }
    }

    // 2. Parsear auto-asignación: [TAREA_CREAR: descripción] (sin agenteId explícito)
    // Solo matchea si NO hay dos parámetros separados por ':'
    const selfCreateRegex = /\[TAREA_CREAR:\s*([^:\]]+)\]/g;
    let selfCreateMatch;
    while ((selfCreateMatch = selfCreateRegex.exec(text)) !== null) {
      const taskText = selfCreateMatch[1].trim();
      if (taskText && !taskText.startsWith('TAREA_') && !taskText.includes(':')) {
        const targetAgent = this.sessionAgents.find(a => a.id === agentId);
        if (targetAgent && this.assignTaskToAgent(targetAgent, taskText)) {
          this.logTelemetry('task_created_by_agent', { agentId, taskText, method: 'self_assign' });
          changed = true;
        }
      }
    }

    // 3. Parsear completados: [TAREA_COMPLETAR: #número] o [TAREA_COMPLETAR: id_tarea]
    const completeRegex = /\[TAREA_COMPLETAR:\s*([^\]]+)\]/g;
    let completeMatch;
    const currentAgent = this.sessionAgents.find(a => a.id === agentId);

    while ((completeMatch = completeRegex.exec(text)) !== null) {
      const taskRef = completeMatch[1].trim();
      if (currentAgent && currentAgent.tasks && currentAgent.tasks.length > 0) {
        if (taskRef.startsWith('#')) {
          const idx = parseInt(taskRef.substring(1), 10) - 1;
          if (idx >= 0 && idx < currentAgent.tasks.length) {
            currentAgent.tasks[idx].completed = true;
            this.store.setTaskCompleted(currentAgent.tasks[idx].id, true);
            this.logTelemetry('task_completed_by_agent', { agentId, taskRef, taskText: currentAgent.tasks[idx].text, method: 'index' });
            changed = true;
          }
        } else {
          const task = currentAgent.tasks.find(t => t.id === taskRef);
          if (task) {
            task.completed = true;
            this.store.setTaskCompleted(task.id, true);
            this.logTelemetry('task_completed_by_agent', { agentId, taskRef, taskText: task.text, method: 'id' });
            changed = true;
          }
        }
      }
    }

    // Limpiar etiquetas del texto original
    cleanText = cleanText.replace(/\[TAREA_[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();

    // Solo transmitir si hubo cambios reales
    if (changed) {
      this.broadcastAgentsUpdated();
    }

    return cleanText;
  }



  enqueueAudioTranscript(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return;
    }
    this.enqueueUserTurn(normalized, 'audio');
  }

  // ¿La tarea pide producir algo concreto? Se usa como red de seguridad
  // contra una clasificación demasiado prudente al cerrar la reunión.
  static looksLikeDeliverable(text) {
    const normalized = String(text || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const verb = /\b(crear|cre[aá]|armar|arm[aá]|hacer|hac[eé]|construir|desarrollar|disen(ar|[aá])|escribir|escrib[ií]|redactar|redact[aá]|preparar|prepar[aá]|generar|maquetar|programar|implementar|documentar|montar)\b/;
    const object = /\b(pagina|web|sitio|landing|portada|html|css|app|prototipo|mockup|documento|informe|reporte|plan|propuesta|presupuesto|guion|articulo|texto|manual|instructivo|checklist|planilla|tablero|dashboard|catalogo|presentacion|borrador|resumen escrito)\b/;
    return verb.test(normalized) && object.test(normalized);
  }

  // ¿El mensaje parece a medio terminar? (termina en conector o coma) →
  // se espera más tiempo por el resto de la idea.
  static seemsUnfinished(text) {
    const trimmed = String(text || '').trim();
    if (/[,:;(]$/.test(trimmed)) {
      return true;
    }
    if (/\b(y|e|o|u|pero|ademas|además|tambien|también|aparte|primero|luego|despues|después|entonces|osea|o sea|por ejemplo|es decir|que)$/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  enqueueUserTurn(text, source) {
    const fragmentId = nanoid(8);
    // Cada fragmento se muestra al instante en el chat…
    this.memory.add('user', 'Tu', text, null, fragmentId);
    this.send({ type: 'user_turn_received', turnId: fragmentId, text, source });
    logEvent('mensaje_usuario', {
      meetingId: this.meeting?.id,
      companyId: this.company?.id,
      empresa: this.company?.name,
      turnId: fragmentId,
      via: source,
      texto: text
    });
    this.logTelemetry('user_turn_enqueued', { turnId: fragmentId, source, text }, fragmentId);

    // …pero el ruteo espera: si venís escribiendo/hablando de a partes,
    // se junta todo en un solo turno con el contexto completo.
    if (this.pendingUser) {
      clearTimeout(this.pendingUser.timer);
      this.pendingUser.texts.push(text);
      this.pendingUser.source = source;
    } else {
      this.pendingUser = { texts: [text], source };
    }
    const combined = this.pendingUser.texts.join('\n');
    const settleMs = MeetingSession.seemsUnfinished(combined)
      ? USER_TURN_SETTLE_EXTENDED_MS
      : USER_TURN_SETTLE_MS;
    this.pendingUser.timer = setTimeout(() => this.flushPendingUser(), settleMs);
  }

  flushPendingUser() {
    if (!this.pendingUser) {
      return;
    }
    const { texts, source } = this.pendingUser;
    this.pendingUser = null;
    const text = texts.join('\n');
    if (texts.length > 1) {
      this.logTelemetry('user_turns_aggregated', { fragments: texts.length, chars: text.length });
    }
    this.routeCombinedTurn(text, source);
  }

  routeCombinedTurn(text, source) {
    logEvent('turno_combinado', {
      meetingId: this.meeting?.id,
      companyId: this.company?.id,
      via: source,
      texto: text
    });
    const turnId = nanoid(8);
    const accepted = this.turnQueue.push(
      turnId,
      (signal) => this.processUserTurn(turnId, text, signal),
      (error) => {
        this.send({
          type: 'error',
          turnId,
          message: 'La orquestacion fallo en este turno.',
          detail: getErrorText(error)
        });
        this.logTelemetry('turn_error', {
          turnId,
          message: 'La orquestacion fallo en este turno.',
          detail: getErrorText(error)
        }, turnId);
      }
    );
    if (!accepted) {
      this.send({
        type: 'error',
        turnId,
        message: 'Hay demasiados turnos en cola; esperá a que termine la ronda actual.'
      });
      this.logTelemetry('turn_rejected_queue_full', { turnId, source }, turnId);
    }
  }

  async routeUserTurn(turnId, text) {
    const heuristicRoute = this.router.route(text, this.memory);
    if (!this.shouldUseAiRouter(heuristicRoute)) {
      return heuristicRoute;
    }

    try {
      const plannedRoute = await this.planRouteWithAi(text, heuristicRoute);
      if (plannedRoute) {
        this.logTelemetry('ai_route_planned', {
          turnId,
          targets: plannedRoute.targets,
          reason: plannedRoute.reason
        }, turnId);
        return plannedRoute;
      }
    } catch (error) {
      this.logTelemetry('ai_route_failed', {
        turnId,
        message: getShortError(error)
      }, turnId);
    }

    return heuristicRoute;
  }

  shouldUseAiRouter(route) {
    return Boolean(route.greeting || route.groupAddressed);
  }

  async planRouteWithAi(text, heuristicRoute) {
    if (!this.keyRing.hasKeys() || heuristicRoute.closing) {
      return null;
    }

    const recentContext = this.memory.recentContext(8);
    const agents = this.sessionAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      domains: agent.domains,
      boundaries: agent.boundaries || []
    }));
    const prompt = [
      'You are the routing controller of a virtual meeting system.',
      'Your only job is to decide which agents should respond to the user\'s message.',
      'Do NOT generate any response to the user. Do NOT speak as an agent.',
      '',
      'Return ONLY a strict JSON object. No explanation, no markdown, no extra text.',
      '',
      'OUTPUT FORMAT:',
      '{"targets":[{"agentId":"string","matchedDomains":["string"],"score":0-10,"directMention":true|false}],"reason":"short explanation in Spanish"}',
      '',
      'ROUTING RULES:',
      '',
      '1. DIRECT MENTION — If the user names an agent explicitly (e.g. "Julio, ¿cómo va?"), that agent MUST be in targets with directMention: true. Score ≥ 8.',
      '',
      '2. DOMAIN MATCH — If the message clearly belongs to one agent\'s domain, route only to that agent. Score based on relevance (0–10).',
      '',
      '3. TANGENTIAL RELEVANCE — If a secondary agent can add something meaningful (even indirectly), include them with a lower score (3–5). Do NOT include an agent just to fill space.',
      '',
      '4. GENERAL GREETING — If the user greets the group with no specific topic, include all agents. Score: 5 for everyone.',
      '',
      '5. CROSS-DOMAIN — If the topic genuinely involves two or more domains (e.g. technical implementation + business data), include all relevant agents ordered by relevance.',
      '',
      '6. SILENCE IS VALID — If no agent has anything meaningful to add, return an empty targets array. Do not force participation.',
      '',
      '7. USER OVERRIDE — If the user explicitly asks both/all agents to respond, respect that unless an agent has truly nothing to contribute (score would be < 2).',
      '',
      'SCORING GUIDE:',
      '- 9–10: core domain, direct question',
      '- 6–8: strong domain match',
      '- 3–5: tangential but can contribute',
      '- 1–2: very weak connection, omit unless forced',
      '- 0: no connection, do not include',
      '',
      `AGENTS: ${JSON.stringify(agents)}`,
      `RECENT CONTEXT: ${recentContext || 'empty'}`,
      `USER MESSAGE: "${text}"`
    ].join('\n');

    const { text: routerText } = await completeChat(this.keyRing, {
      models: getMinimaxModels(),
      scope: 'orquestador',
      timeoutMs: ROUTER_TIMEOUT_MS,
      emit: (event) => this.send(event),
      maxTokens: 1200,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });

    const parsed = parseJsonFromModel(routerText);
    if (!parsed || !Array.isArray(parsed.targets)) {
      return null;
    }

    const validAgents = new Map(this.sessionAgents.map((agent) => [agent.id, agent]));
    const heuristicTargetsById = new Map(heuristicRoute.targets.map((target) => [target.agentId, target]));
    const seen = new Set();
    const targets = [];

    for (const item of parsed.targets) {
      const agentId = typeof item === 'string' ? item : item?.agentId;
      const agent = validAgents.get(agentId);
      if (!agent || seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      const heuristicTarget = heuristicTargetsById.get(agentId);
      const matchedDomains = Array.isArray(item?.matchedDomains) && item.matchedDomains.length > 0
        ? item.matchedDomains.map((domain) => String(domain).slice(0, 60))
        : heuristicTarget?.matchedDomains || ['decision IA'];
      targets.push({
        agentId,
        name: agent.name,
        score: Math.max(1, Math.min(10, Number(item?.score) || heuristicTarget?.score || 7)),
        directMention: Boolean(item?.directMention ?? heuristicTarget?.directMention ?? heuristicRoute.groupAddressed),
        mentionIndex: heuristicTarget?.mentionIndex ?? targets.length,
        matchedDomains
      });
    }

    return {
      ...heuristicRoute,
      responses: [],
      targets,
      reason: String(parsed.reason || 'El orquestador IA decidio el turno segun roles y contexto.').slice(0, 220)
    };
  }

  async processUserTurn(turnId, text, signal) {
    const route = await this.routeUserTurn(turnId, text);
    if (signal?.aborted) {
      return;
    }
    this.send({ type: 'route_decision', turnId, route });
    this.logTelemetry('route_decision', {
      turnId,
      targets: route.targets,
      reason: route.reason,
      closing: Boolean(route.closing),
      greeting: Boolean(route.greeting)
    }, turnId);

    if (route.targets.length === 0) {
      const note = route.reason || 'Ningun agente tiene suficiente senal de dominio para responder sin inventar.';
      this.memory.add('system', 'Orquestador', note, null, turnId);
      this.send({ type: 'no_agent_response', turnId, note });
      this.logTelemetry('no_agent_response', { turnId, note }, turnId);
      return;
    }

    for (const target of route.targets) {
      if (signal?.aborted) {
        return;
      }
      const agent = this.agents.get(target.agentId);
      if (!agent) {
        continue;
      }
      this.send({ type: 'agent_turn_start', turnId, agentId: agent.id });
      this.logTelemetry('agent_turn_start', {
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        matchedDomains: target.matchedDomains || [],
        directMention: Boolean(target.directMention)
      }, turnId);
      const response = await agent.respond({
        speaker: 'Usuario',
        text,
        route,
        target,
        priorResponses: route.responses || []
      }, (event) => {
        this.send({ ...event, turnId, agentId: agent.id });
      }, { signal, gate: this.gate, turnId });
      // Las tareas se parsean SIEMPRE desde rawText: un "SILENCIO
      // [TAREA_CREAR: x]" crea la tarea aunque el agente se calle.
      if (response.rawText) {
        const cleanedText = this.processAgentTaskCommands(agent.id, response.rawText);
        response.text = response.text ? cleanedText : '';
      }
      logEvent('respuesta_agente', {
        meetingId: this.meeting?.id,
        turnId,
        agente: agent.name,
        interrumpido: Boolean(response.interrupted),
        texto: response.text || '(silencio)'
      });
      if (response.text) {
        const memoryText = response.interrupted
          ? `${response.text} …(interrumpido por el usuario)`
          : response.text;
        this.memory.add('agent', agent.name, memoryText, agent.id, turnId);
        route.responses = [
          ...(route.responses || []),
          {
            agentId: agent.id,
            name: agent.name,
            text: response.text
          }
        ];
      }
      this.send({
        type: 'agent_turn_complete',
        turnId,
        agentId: agent.id,
        text: response.text,
        usedMock: response.usedMock,
        backend: response.backend,
        interrupted: Boolean(response.interrupted),
        keyStatus: this.keyRing.snapshot()
      });
      this.logTelemetry('agent_turn_complete', {
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        text: response.text,
        usedMock: response.usedMock,
        backend: response.backend,
        spoke: Boolean(response.text?.trim())
      }, turnId);
      if (response.interrupted) {
        return;
      }
    }

    if (!route.closing && !signal?.aborted) {
      await this.processContextualFollowups(turnId, text, route, signal);
    }

    this.learningObserver.observeCycle(this.meeting.id, this.memory, this.sessionAgents, text);
  }

  async processContextualFollowups(turnId, originalText, route, signal) {
    let followups = 0;
    while (followups < MAX_CONTEXTUAL_FOLLOWUPS && !signal?.aborted) {
      const nextTarget = this.router.nextContextualTarget(originalText, route, this.memory);
      if (!nextTarget) {
        break;
      }

      route.targets.push(nextTarget);
      route.reason = 'El orquestador cedio la palabra por contexto entre agentes.';
      this.send({ type: 'route_decision', turnId, route });
      this.logTelemetry('contextual_route_decision', {
        turnId,
        nextTarget,
        reason: route.reason
      }, turnId);

      const agent = this.agents.get(nextTarget.agentId);
      if (!agent) {
        break;
      }

      this.send({ type: 'agent_turn_start', turnId, agentId: agent.id });
      this.logTelemetry('agent_turn_start', {
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        contextual: true,
        matchedDomains: nextTarget.matchedDomains || []
      }, turnId);
      const response = await agent.respond({
        speaker: this.memory.lastAgentTurn()?.speaker || 'Otro agente',
        text: this.memory.lastAgentTurn()?.text || originalText,
        route,
        target: nextTarget,
        priorResponses: route.responses || [],
        isContextualFollowup: true
      }, (event) => {
        this.send({ ...event, turnId, agentId: agent.id });
      }, { signal, gate: this.gate, turnId });

      if (response.rawText) {
        const cleanedText = this.processAgentTaskCommands(agent.id, response.rawText);
        response.text = response.text ? cleanedText : '';
      }
      if (response.text) {
        this.memory.add('agent', agent.name, response.text, agent.id, turnId);
        route.responses = [
          ...(route.responses || []),
          {
            agentId: agent.id,
            name: agent.name,
            text: response.text
          }
        ];
      }
      this.send({
        type: 'agent_turn_complete',
        turnId,
        agentId: agent.id,
        text: response.text,
        usedMock: response.usedMock,
        keyStatus: this.keyRing.snapshot()
      });
      this.logTelemetry('agent_turn_complete', {
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        text: response.text,
        usedMock: response.usedMock,
        spoke: Boolean(response.text?.trim()),
        contextual: true
      }, turnId);

      followups += 1;
    }
  }

  // "Finalizar reunión": la CEO repasa en voz alta quién quedó con qué
  // (validación conversacional) y queda pendiente la confirmación del
  // usuario para arrancar el trabajo.
  async prepareMeetingClose() {
    const ceo = this.sessionAgents.find((agent) => agent.role === 'ceo' && agent.enabled !== false);
    const assignments = this.sessionAgents
      .filter((agent) => (agent.tasks || []).some((task) => !task.completed))
      .map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        tasks: agent.tasks.filter((task) => !task.completed).map((task) => task.text)
      }));

    // Cada tarea se numera para que la CEO pueda clasificarla: no toda
    // reunión termina en un entregable — muchas solo dejan acuerdos.
    const numbered = [];
    for (const assignment of assignments) {
      for (const text of assignment.tasks) {
        numbered.push({ n: numbered.length + 1, agentName: assignment.agentName, text });
      }
    }

    const transcript = this.memory.recentContext(30);
    const prompt = [
      `Sos ${ceo ? ceo.name : 'la CEO'}, CEO de ${this.company.name}. Se está cerrando la reunión y tenés que decidir, con criterio, qué pasa después.`,
      '',
      'TAREAS PENDIENTES POR EMPLEADO:',
      numbered.length
        ? numbered.map((item) => `${item.n}. ${item.agentName}: ${item.text}`).join('\n')
        : '(no se asignaron tareas en esta reunión)',
      '',
      'TRANSCRIPCIÓN RECIENTE:',
      transcript || '(vacía)',
      '',
      'CRITERIO IMPORTANTE — no inventes trabajo:',
      '- "entregable" = hay que PRODUCIR algo concreto y revisable (una página, un documento, un plan escrito, un análisis).',
      '- "decision" = un acuerdo o definición que ya quedó tomada en la reunión; no hay nada que construir.',
      '- "seguimiento" = algo para retomar más adelante o que depende de terceros; tampoco se construye ahora.',
      '- Si la reunión fue de alineación, presentación, dudas o charla, "producesWork" es false y NO se abre ningún proyecto.',
      'Ejemplos: "crear la página web institucional" → entregable. "escribir el plan de lanzamiento" → entregable.',
      '"quedamos en que el foco es retail" → decision. "revisar cómo viene el mercado el mes que viene" → seguimiento.',
      'Si una tarea pide CREAR, ARMAR, ESCRIBIR o DISEÑAR algo concreto, es entregable y "producesWork" es true. No seas tímida:',
      'si el equipo se comprometió a producir algo, hay que producirlo.',
      '',
      'Devolvé SOLO un JSON válido:',
      '{"producesWork":true|false,',
      ' "tasks":[{"n":1,"kind":"entregable|decision|seguimiento"}],',
      ' "goalTitle":"título corto del proyecto (o del acuerdo, si no hay trabajo)",',
      ' "goalDescription":"1-2 oraciones: qué se busca y por qué",',
      ' "spokenSummary":"tu repaso HABLADO en 2-5 oraciones, cálido y claro: qué quedó a cargo de cada uno o, si no hay nada que producir, qué se acordó; terminá preguntando si está bien así",',
      ' "hires":[{"need":"solo si falta una habilidad que NADIE del equipo tiene; lista vacía si no falta nada"}]}'
    ].join('\n');

    let plan = null;
    if (this.keyRing.hasKeys()) {
      try {
        const { text } = await completeChat(this.keyRing, {
          models: getMinimaxModels(),
          scope: 'cierre de reunión',
          timeoutMs: 30000,
          maxTokens: 4000,
          temperature: 0.4,
          messages: [{ role: 'user', content: prompt }]
        });
        plan = parseJsonFromModel(text);
      } catch {
        plan = null;
      }
    }

    // Clasificación por número de tarea → tipo. Sin plan del modelo, se
    // asume entregable (comportamiento anterior) solo si hay tareas.
    const kindByIndex = new Map();
    for (const item of Array.isArray(plan?.tasks) ? plan.tasks : []) {
      const n = Number(item?.n);
      const kind = ['entregable', 'decision', 'seguimiento'].includes(item?.kind) ? item.kind : 'entregable';
      if (Number.isFinite(n)) {
        kindByIndex.set(n, kind);
      }
    }
    let cursor = 0;
    const classified = assignments.map((assignment) => ({
      ...assignment,
      tasks: assignment.tasks.map((text) => {
        cursor += 1;
        const proposed = kindByIndex.get(cursor) || 'entregable';
        // Red de seguridad: si la tarea pide explícitamente CREAR algo, se
        // construye aunque el modelo la haya rotulado como acuerdo. Negarse a
        // hacer lo que se pidió es peor que producir de más.
        const kind = proposed !== 'entregable' && MeetingSession.looksLikeDeliverable(text) ? 'entregable' : proposed;
        return { text, kind };
      })
    }));

    // Si hay aunque sea una tarea para construir, la reunión produce trabajo:
    // un "no" del modelo no puede contradecir su propia clasificación.
    const deliverables = classified.flatMap((a) => a.tasks).filter((t) => t.kind === 'entregable').length;
    const producesWork = deliverables > 0;
    const hires = producesWork && Array.isArray(plan?.hires) ? plan.hires.filter((h) => h?.need).slice(0, 3) : [];

    const fallbackSummary = producesWork
      ? `Repasemos antes de cerrar: ${classified.map((a) => `${a.agentName} queda con ${a.tasks.map((t) => t.text).join(' y ')}`).join('; ')}. Si te parece bien, cerramos y el equipo arranca. ¿Confirmamos?`
      : assignments.length
        ? 'De esta reunión no sale nada para construir todavía: quedan los acuerdos anotados. ¿Cerramos así?'
        : 'No quedaron tareas para producir en esta reunión, solo la conversación. ¿Cerramos igual?';

    this.pendingClose = {
      producesWork,
      goalTitle: String(plan?.goalTitle || (producesWork ? 'Objetivos de la reunión' : 'Acuerdos de la reunión')).slice(0, 120),
      goalDescription: String(plan?.goalDescription || this.meeting.scenario_text || '').slice(0, 500),
      // La clasificación YA corregida: es la que se aplica al confirmar.
      kinds: classified.flatMap((a) => a.tasks).map((task, index) => [index + 1, task.kind]),
      hires
    };

    const spoken = String(plan?.spokenSummary || fallbackSummary).slice(0, 900);
    if (ceo) {
      await this.speakAs(ceo, spoken);
    }
    this.send({
      type: 'meeting_closing_summary',
      producesWork,
      goalTitle: this.pendingClose.goalTitle,
      goalDescription: this.pendingClose.goalDescription,
      assignments: classified,
      hires: this.pendingClose.hires.map((h) => ({ need: String(h.need).slice(0, 200) }))
    });
    logEvent('cierre_preparado', {
      meetingId: this.meeting?.id,
      empresa: this.company?.name,
      produceTrabajo: producesWork,
      proyecto: this.pendingClose.goalTitle,
      asignaciones: classified.map((a) => ({ quien: a.agentName, tareas: a.tasks.map((t) => `[${t.kind}] ${t.text}`) }))
    });
    this.logTelemetry('meeting_close_prepared', { assignments: assignments.length, deliverables, producesWork, hires: this.pendingClose.hires.length });
  }

  confirmMeetingClose() {
    const pending = this.pendingClose;
    this.pendingClose = null;
    if (!pending) {
      this.send({ type: 'error', message: 'No hay un cierre de reunión pendiente.' });
      return;
    }

    // Sin nada que producir, la reunión deja un ACUERDO registrado (queda en
    // el tablero como historia de la empresa) y nadie se pone a "trabajar".
    const goal = this.store.createGoal({
      companyId: this.company.id,
      meetingId: this.meeting.id,
      title: pending.goalTitle,
      description: pending.goalDescription,
      kind: pending.producesWork ? 'proyecto' : 'acuerdo'
    });

    const kindByIndex = new Map(pending.kinds || []);
    let cursor = 0;
    let taskCount = 0;
    for (const agent of this.sessionAgents) {
      for (const task of agent.tasks || []) {
        if (!task.completed) {
          cursor += 1;
          const kind = pending.producesWork ? (kindByIndex.get(cursor) || 'entregable') : 'decision';
          this.store.assignTaskToGoal(task.id, goal.id, { kind });
          if (kind === 'entregable') {
            taskCount += 1;
          }
        }
      }
    }
    // Necesidades sin dueño → tareas del contratista (contrata y delega).
    const contratista = this.sessionAgents.find((agent) => agent.role === 'contratista');
    if (contratista && pending.producesWork) {
      for (const hire of pending.hires) {
        const taskId = this.store.insertTask(this.meeting.id, contratista.id, {
          text: `Contratar a alguien para: ${hire.need}`,
          kind: 'contratacion'
        });
        this.store.assignTaskToGoal(taskId, goal.id, { kind: 'contratacion' });
        taskCount += 1;
      }
    }

    this.logTelemetry('meeting_confirmed_close', { goalId: goal.id, tasks: taskCount });
    const companyId = this.company.id;
    this.closeCurrentMeeting('finished_to_work');
    this.send({ type: 'meeting_reset' });
    this.initMeeting(null, companyId);
  }

  // Habla sintética de un agente fuera del flujo de respuesta (p.ej. el
  // resumen de cierre de la CEO): texto + voz por el gate.
  async speakAs(agent, text) {
    const turnId = nanoid(8);
    this.send({ type: 'agent_turn_start', turnId, agentId: agent.id });
    this.send({ type: 'agent_transcript_delta', turnId, agentId: agent.id, delta: text, seq: 1 });
    this.memory.add('agent', agent.name, text, agent.id, turnId);
    this.send({
      type: 'agent_turn_complete',
      turnId,
      agentId: agent.id,
      text,
      backend: 'stream',
      keyStatus: this.keyRing.snapshot()
    });
    const runtime = this.agents.get(agent.id);
    if (runtime) {
      void (async () => {
        try {
          const parts = await runtime.generateAudioParts(text, (event) => this.send({ ...event, turnId, agentId: agent.id }));
          if (parts.length > 0) {
            const rate = Number(parts[0].mimeType?.match(/rate=(\d+)/)?.[1] || 44100);
            const token = await this.gate.acquire(turnId, agent.id, { sampleRate: rate });
            for (const part of parts) {
              this.gate.sendChunk(token, part.data, part.mimeType);
            }
            this.gate.finish(token, 'complete');
          }
        } catch {
          // La voz del cierre es best-effort.
        }
      })();
    }
  }

  send(payload) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      this.logServerMessage(payload);
    }
  }

  close() {
    if (this.sessionCounted) {
      unregisterSession();
      this.sessionCounted = false;
    }
    const allEvents = telemetry.list(TELEMETRY_MAX_EVENTS).filter(e => e.sessionId === this.id);
    const summary = {
      sessionDurationMs: Date.now() - new Date(this.createdAt).getTime(),
      totalEvents: allEvents.length,
      userTurns: allEvents.filter(e => e.type === 'user_turn_enqueued').length,
      agentTurns: allEvents.filter(e => e.type === 'agent_turn_start').length,
      agentCompletions: allEvents.filter(e => e.type === 'agent_turn_complete').length,
      routeDecisions: allEvents.filter(e => e.type === 'route_decision').length,
      noAgentResponses: allEvents.filter(e => e.type === 'no_agent_response').length,
      taskCreations: allEvents.filter(e => e.type === 'task_created_by_agent').length,
      taskCompletions: allEvents.filter(e => e.type === 'task_completed_by_agent').length,
      apiRotations: allEvents.filter(e => e.type === 'api_rotation_start').length,
      errors: allEvents.filter(e => e.type === 'api_rotation_failed' || e.type === 'turn_error').length,
      agentCount: this.sessionAgents.length
    };
    this.turnQueue.interrupt('superseded');
    this.gate.flush();
    if (this.meeting && summary.userTurns >= 3) {
      this.reflection.scheduleForMeeting(this.meeting.id);
    }
    this.logTelemetry('meeting_session_summary', summary);
    this.logTelemetry('meeting_session_closed', {});
    if (this.meeting) {
      try {
        this.store.saveSessionSummary(this.meeting.id, this.id, this.createdAt, summary);
      } catch {
        // El resumen no debe impedir el cierre.
      }
      if (activeSessionsByMeeting.get(this.meeting.id) === this) {
        activeSessionsByMeeting.delete(this.meeting.id);
      }
    }
    this.transcriber.close();
    for (const agent of this.agents.values()) {
      agent.close();
    }
  }

  logTelemetry(type, payload = {}, turnId = null) {
    telemetry.add({
      type,
      sessionId: this.id,
      turnId,
      payload
    });
    if (this.meeting && PERSISTED_TELEMETRY_TYPES.has(type)) {
      try {
        this.store.logTelemetryEvent(this.meeting.id, turnId, type, payload);
      } catch {
        // La telemetría persistida es best-effort.
      }
    }
  }

  logClientMessage(message) {
    if (message.type === 'audio_chunk') {
      this.audioChunkCount = (this.audioChunkCount || 0) + 1;
      if (this.audioChunkCount % 20 === 0) {
        this.logTelemetry('client_audio_chunk_summary', {
          chunks: this.audioChunkCount,
          mimeType: message.mimeType || AUDIO_MIME_TYPE
        });
      }
      return;
    }

    if (message.type === 'audio_start') {
      this.audioChunkCount = 0;
    }

    this.logTelemetry('client_ws_message', summarizeClientMessage(message), message.turnId || null);
  }

  logServerMessage(payload) {
    const skipped = new Set(['agent_audio_chunk', 'agent_transcript_delta', 'user_audio_transcript_delta']);
    if (skipped.has(payload.type)) {
      return;
    }
    if (this.meeting && payload.type === 'agent_silence') {
      try {
        this.store.logTelemetryEvent(this.meeting.id, payload.turnId || null, 'agent_silence', {
          agentId: payload.agentId || null,
          reason: payload.reason || null
        });
      } catch {
        // Best-effort.
      }
    }
    this.logTelemetry('server_ws_message', summarizeServerMessage(payload), payload.turnId || null);
  }
}
