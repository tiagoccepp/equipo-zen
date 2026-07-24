import { ThinkingLevel } from '@google/genai';
import { nanoid } from 'nanoid';

import {
  AGENT_BACKEND,
  AUDIO_MIME_TYPE,
  MAX_CONTEXTUAL_FOLLOWUPS,
  MODEL,
  ROUTER_MODELS,
  ROUTER_TIMEOUT_MS,
  TELEMETRY_MAX_EVENTS,
  agentConfig
} from './config.js';
import { AgentLiveBackend } from './agent-live-backend.js';
import { LiveAgentRuntime } from './agent-runtime.js';
import { extractTextFromResponse, generateContentWithRotation, parseJsonFromModel } from './gemini.js';
import { MeetingMemory } from './memory.js';
import { AgentRouter } from './router.js';
import { getErrorText, getShortError } from './text.js';
import { summarizeClientMessage, summarizeServerMessage, telemetry } from './telemetry.js';
import { LiveAudioTranscriberRuntime } from './transcriber.js';
import { CancellableTurnQueue, SpeakerGate } from './turn-pipeline.js';

const MAX_SESSION_AGENTS = 8;

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

export class MeetingSession {
  constructor(socket, keyRingInstance, store) {
    this.id = nanoid(10);
    this.createdAt = new Date().toISOString();
    this.socket = socket;
    this.keyRing = keyRingInstance;
    this.store = store;

    // Se inicializan en initMeeting() cuando llega el hello del cliente.
    this.meeting = null;
    this.memory = null;
    this.sessionAgents = [];
    this.router = null;
    this.agents = new Map();

    this.transcriber = new LiveAudioTranscriberRuntime(this.keyRing, null, {
      emit: (event) => this.send(event),
      onTranscript: (text) => this.enqueueAudioTranscript(text)
    });
    this.gate = new SpeakerGate({ emit: (event) => this.send(event) });
    this.turnQueue = new CancellableTurnQueue({
      timeoutMs: 60000,
      maxPending: 10,
      onCancelled: (turnId, reason) => {
        this.send({ type: 'turn_cancelled', turnId, reason: reason === 'barge_in' ? 'barge_in' : 'superseded' });
        this.logTelemetry('turn_cancelled', { turnId, reason }, turnId);
      }
    });
    this.warmupStarted = false;
  }

  createAgentRuntime(agent) {
    const runtime = new LiveAgentRuntime(agent, this.keyRing, this.memory, this);
    if (AGENT_BACKEND === 'auto' || AGENT_BACKEND === 'live') {
      runtime.liveBackend = new AgentLiveBackend(agent, this.keyRing, this.memory, this);
    }
    return runtime;
  }

  initMeeting(requestedMeetingId = null) {
    let meeting = this.store.findResumableMeeting(requestedMeetingId);
    if (meeting && activeSessionsByMeeting.has(meeting.id)) {
      meeting = null;
    }
    const resumed = Boolean(meeting);
    if (!meeting) {
      meeting = this.store.createMeeting({
        scenarioName: agentConfig.companySimulation?.name || null,
        scenarioText: agentConfig.companySimulation?.scenario || null
      });
    }

    this.meeting = meeting;
    activeSessionsByMeeting.set(meeting.id, this);
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
    setTimeout(() => this.warmupLiveSessions(), 250);

    const mode = !this.keyRing.hasKeys() || AGENT_BACKEND === 'mock'
      ? 'mock'
      : (AGENT_BACKEND === 'auto' || AGENT_BACKEND === 'live') ? 'live' : 'stream';
    this.send({
      type: 'meeting_ready',
      id: this.id,
      meetingId: meeting.id,
      resumed,
      agents: this.publicAgents(),
      scenario: { name: meeting.scenario_name, text: meeting.scenario_text },
      turns: restoredTurns,
      model: MODEL,
      liveMode: this.keyRing.hasKeys(),
      mode,
      agentBackends: Object.fromEntries(this.sessionAgents.map((agent) => [agent.id, mode]))
    });
  }

  closeCurrentMeeting(reason) {
    if (!this.meeting) {
      return;
    }
    this.store.closeMeeting(this.meeting.id);
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

  promptContext() {
    return {
      agents: this.sessionAgents,
      scenario: this.meeting
        ? { name: this.meeting.scenario_name, text: this.meeting.scenario_text }
        : null
    };
  }

  publicAgents() {
    return this.sessionAgents.map(({ id, name, title, color, domains, aliases, boundaries, style, voice, tasks, origin, enabled, learningEnabled }) => ({
      id,
      name,
      title,
      color,
      domains,
      aliases,
      boundaries,
      style,
      voice,
      tasks: tasks || [],
      origin,
      enabled,
      learningEnabled
    }));
  }


  async handleClientMessage(message) {
    this.logClientMessage(message);

    if (message.type === 'hello') {
      if (!this.meeting) {
        this.initMeeting(message.meetingId || null);
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
      this.turnQueue.interrupt(message.reason === 'barge_in' ? 'barge_in' : 'superseded');
      this.gate.flush();
      this.send({ type: 'agent_interrupted', turnId: speakingTurnId || undefined, agentId: speakingAgentId || undefined });
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
      this.closeCurrentMeeting('user_reset');
      this.send({ type: 'meeting_reset' });
      this.initMeeting(null);
      return;
    }

    if (message.type === 'health') {
      this.send({ type: 'health', keys: this.keyRing.snapshot(), memory: this.memory.snapshot() });
      return;
    }

    if (message.type === 'spawn_agent') {
      const { name, title, color, aliases, domains, boundaries, style, voice, initialTasks } = message.agent || {};
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
        name,
        title,
        color: color || '#888888',
        aliases: Array.isArray(aliases) ? aliases : (aliases || '').split(',').map(s => s.trim()).filter(Boolean),
        domains: Array.isArray(domains) ? domains : (domains || '').split(',').map(s => s.trim()).filter(Boolean),
        boundaries: Array.isArray(boundaries) ? boundaries : (boundaries || '').split(',').map(s => s.trim()).filter(Boolean),
        style: style || 'Conversador estándar y profesional.',
        voice: voice || 'Charon'
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

  processAgentTaskCommands(agentId, text) {
    if (!text) return text;

    let cleanText = text;
    let changed = false;

    // 1. Parsear creaciones con agente explícito: [TAREA_CREAR: agenteId: descripción]
    const createRegex = /\[TAREA_CREAR:\s*([a-zA-Z0-9_-]+):\s*([^\]]+)\]/g;
    let createMatch;
    while ((createMatch = createRegex.exec(text)) !== null) {
      const targetAgentId = createMatch[1].trim();
      const taskText = createMatch[2].trim();

      const targetAgent = this.sessionAgents.find(a => a.id === targetAgentId);
      if (targetAgent && taskText) {
        targetAgent.tasks = targetAgent.tasks || [];
        const newTaskId = this.store.insertTask(this.meeting.id, targetAgentId, { text: taskText });
        targetAgent.tasks.push({
          id: newTaskId,
          text: taskText,
          completed: false,
          createdAt: new Date().toISOString()
        });
        this.logTelemetry('task_created_by_agent', { agentId: targetAgentId, createdBy: agentId, taskText, method: 'explicit_target' });
        changed = true;
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
        if (targetAgent) {
          targetAgent.tasks = targetAgent.tasks || [];
          const newTaskId = this.store.insertTask(this.meeting.id, agentId, { text: taskText });
          targetAgent.tasks.push({
            id: newTaskId,
            text: taskText,
            completed: false,
            createdAt: new Date().toISOString()
          });
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


  async warmupLiveSessions() {
    if (this.warmupStarted || !this.keyRing.hasKeys()) {
      return;
    }
    this.warmupStarted = true;
    this.send({ type: 'meeting_warmup_start' });
    this.logTelemetry('meeting_warmup_start', { agentCount: this.agents.size });

    const tasks = [this.transcriber.ensureSession()];

    const results = await Promise.allSettled(tasks);
    const failures = results.filter((result) => result.status === 'rejected');
    this.send({
      type: 'meeting_warmup_complete',
      ok: failures.length === 0,
      failures: failures.length
    });
    this.logTelemetry('meeting_warmup_complete', {
      ok: failures.length === 0,
      failures: failures.length
    });
  }

  enqueueAudioTranscript(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return;
    }
    this.enqueueUserTurn(normalized, 'audio');
  }

  enqueueUserTurn(text, source) {
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
      return;
    }
    this.memory.add('user', 'Tu', text, null, turnId);
    this.send({ type: 'user_turn_received', turnId, text, source });
    this.logTelemetry('user_turn_enqueued', { turnId, source, text }, turnId);
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
    const heuristicTargets = heuristicRoute.targets.map((target) => target.agentId);
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

    const { response } = await generateContentWithRotation(this.keyRing, {
      models: ROUTER_MODELS,
      scope: 'orquestador',
      timeoutMs: ROUTER_TIMEOUT_MS,
      emit: (event) => this.send(event),
      config: {
        maxOutputTokens: 300,
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json'
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const parsed = parseJsonFromModel(response.text || extractTextFromResponse(response));
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

    this.feedContextToIdleLiveSessions(text, route);
  }

  // Mantiene "context-warm" las sesiones Live de los agentes que NO
  // hablaron este turno (sendClientContent con turnComplete:false).
  feedContextToIdleLiveSessions(userText, route) {
    const spoke = new Set((route.responses || []).map((response) => response.agentId));
    const lines = [
      `Usuario: ${userText}`,
      ...(route.responses || []).map((response) => `${response.name}: ${response.text}`)
    ];
    for (const [agentId, runtime] of this.agents) {
      const backend = runtime.liveBackend;
      if (!backend) {
        continue;
      }
      const missing = spoke.has(agentId)
        ? lines.filter((line) => !line.startsWith(`${runtime.name}:`) && !line.startsWith('Usuario:'))
        : lines;
      if (missing.length > 0) {
        backend.feedContext(missing.join('\n'));
      }
    }
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

  send(payload) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      this.logServerMessage(payload);
    }
  }

  close() {
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
