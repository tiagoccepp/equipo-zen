import { ThinkingLevel } from '@google/genai';
import { nanoid } from 'nanoid';

import {
  AUDIO_MIME_TYPE,
  MAX_CONTEXTUAL_FOLLOWUPS,
  ROUTER_MODELS,
  ROUTER_TIMEOUT_MS,
  TELEMETRY_MAX_EVENTS,
  agentConfig
} from './config.js';
import { LiveAgentRuntime } from './agent-runtime.js';
import { extractTextFromResponse, generateContentWithRotation, parseJsonFromModel } from './gemini.js';
import { MeetingMemory } from './memory.js';
import { AgentRouter } from './router.js';
import { getErrorText, getShortError } from './text.js';
import { summarizeClientMessage, summarizeServerMessage, telemetry } from './telemetry.js';
import { LiveAudioTranscriberRuntime } from './transcriber.js';
import { TurnQueue } from './turn-queue.js';

const MAX_SESSION_AGENTS = 8;

export class MeetingSession {
  constructor(socket, keyRingInstance) {
    this.id = nanoid(10);
    this.createdAt = new Date().toISOString();
    this.socket = socket;
    this.keyRing = keyRingInstance;
    this.memory = new MeetingMemory();

    // Lista dinámica de agentes mutable en memoria por sesión
    this.sessionAgents = JSON.parse(JSON.stringify(agentConfig.agents)).map((agent) => ({
      ...agent,
      tasks: agent.tasks || []
    }));

    this.router = new AgentRouter(this.sessionAgents);
    this.transcriber = new LiveAudioTranscriberRuntime(this.keyRing, this.memory, {
      emit: (event) => this.send(event),
      onTranscript: (text) => this.enqueueAudioTranscript(text)
    });
    this.agents = new Map(
      this.sessionAgents.map((agent) => [
        agent.id,
        new LiveAgentRuntime(agent, this.keyRing, this.memory, this)
      ])
    );
    this.turnQueue = new TurnQueue({ timeoutMs: 60000, maxPending: 10 });
    this.warmupStarted = false;
    telemetry.add({
      type: 'meeting_session_created',
      sessionId: this.id,
      payload: {
        liveMode: this.keyRing.hasKeys(),
        agents: this.sessionAgents.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }))
      }
    });
    setTimeout(() => this.warmupLiveSessions(), 250);
  }

  publicAgents() {
    return this.sessionAgents.map(({ id, name, title, color, domains, aliases, boundaries, style, voice, tasks }) => ({
      id,
      name,
      title,
      color,
      domains,
      aliases,
      boundaries,
      style,
      voice,
      tasks: tasks || []
    }));
  }


  async handleClientMessage(message) {
    this.logClientMessage(message);

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
      this.memory.reset();
      this.transcriber.reset();
      for (const agent of this.agents.values()) {
        agent.reset();
      }
      this.send({ type: 'meeting_reset' });
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

      const tasks = (initialTasks || [])
        .map(t => t.trim())
        .filter(Boolean)
        .map((t) => ({
          id: 'task-' + nanoid(6),
          text: t,
          completed: false,
          createdAt: new Date().toISOString()
        }));

      const newAgent = {
        id,
        name,
        title,
        color: color || '#888888',
        aliases: Array.isArray(aliases) ? aliases : (aliases || '').split(',').map(s => s.trim()).filter(Boolean),
        domains: Array.isArray(domains) ? domains : (domains || '').split(',').map(s => s.trim()).filter(Boolean),
        boundaries: Array.isArray(boundaries) ? boundaries : (boundaries || '').split(',').map(s => s.trim()).filter(Boolean),
        style: style || 'Conversador estándar y profesional.',
        voice: voice || 'Charon',
        tasks
      };

      const lowerName = newAgent.name.toLowerCase();
      if (!newAgent.aliases.some(alias => alias.toLowerCase() === lowerName)) {
        newAgent.aliases.push(lowerName);
      }

      this.sessionAgents.push(newAgent);
      this.agents.set(id, new LiveAgentRuntime(newAgent, this.keyRing, this.memory, this));
      this.logTelemetry('agent_spawned', { agentId: id, name, title, domains, taskCount: tasks.length });

      this.broadcastAgentsUpdated();

      const systemMsgId = nanoid(8);
      this.memory.add('system', 'Orquestador', `Se ha unido ${name} (${title}) a la mesa de trabajo.`);
      this.send({
        type: 'user_turn_received',
        turnId: systemMsgId,
        text: `Se ha unido ${name} (${title}) a la mesa de trabajo.`,
        source: 'system'
      });
      return;
    }

    if (message.type === 'add_task') {
      const { agentId, text } = message;
      const agent = this.sessionAgents.find(a => a.id === agentId);
      if (agent && text?.trim()) {
        agent.tasks = agent.tasks || [];
        agent.tasks.push({
          id: 'task-' + nanoid(6),
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
        targetAgent.tasks.push({
          id: 'task-' + nanoid(6),
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
          targetAgent.tasks.push({
            id: 'task-' + nanoid(6),
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
            this.logTelemetry('task_completed_by_agent', { agentId, taskRef, taskText: currentAgent.tasks[idx].text, method: 'index' });
            changed = true;
          }
        } else {
          const task = currentAgent.tasks.find(t => t.id === taskRef);
          if (task) {
            task.completed = true;
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
      () => this.processUserTurn(turnId, text),
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
    this.memory.add('user', 'Tu', text);
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

  async processUserTurn(turnId, text) {
    const route = await this.routeUserTurn(turnId, text);
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
      this.memory.add('system', 'Orquestador', note);
      this.send({ type: 'no_agent_response', turnId, note });
      this.logTelemetry('no_agent_response', { turnId, note }, turnId);
      return;
    }

    for (const target of route.targets) {
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
      });
      // Las tareas se parsean SIEMPRE desde rawText: un "SILENCIO
      // [TAREA_CREAR: x]" crea la tarea aunque el agente se calle.
      if (response.rawText) {
        const cleanedText = this.processAgentTaskCommands(agent.id, response.rawText);
        response.text = response.text ? cleanedText : '';
      }
      if (response.text) {
        this.memory.add('agent', agent.name, response.text, agent.id);
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
        spoke: Boolean(response.text?.trim())
      }, turnId);
    }

    if (!route.closing) {
      await this.processContextualFollowups(turnId, text, route);
    }
  }

  async processContextualFollowups(turnId, originalText, route) {
    let followups = 0;
    while (followups < MAX_CONTEXTUAL_FOLLOWUPS) {
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
      });

      if (response.rawText) {
        const cleanedText = this.processAgentTaskCommands(agent.id, response.rawText);
        response.text = response.text ? cleanedText : '';
      }
      if (response.text) {
        this.memory.add('agent', agent.name, response.text, agent.id);
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
    this.logTelemetry('meeting_session_summary', summary);
    this.logTelemetry('meeting_session_closed', {});
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
    this.logTelemetry('server_ws_message', summarizeServerMessage(payload), payload.turnId || null);
  }
}
