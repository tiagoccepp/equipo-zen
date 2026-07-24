import 'dotenv/config';

import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';
import agentConfig from './agents.config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-preview';
const TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.0-flash-preview';
const AGENT_TEXT_MODEL = process.env.GEMINI_AGENT_TEXT_MODEL || process.env.GEMINI_FAST_TEXT_MODEL || 'gemini-2.5-flash';
const ROUTER_MODEL = process.env.GEMINI_ROUTER_MODEL || 'gemini-2.5-flash';
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.0-flash-preview-tts';
const AGENT_TEXT_MODELS = uniqueModelList([
  AGENT_TEXT_MODEL,
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash'
]);
const ROUTER_MODELS = uniqueModelList([
  ROUTER_MODEL,
  AGENT_TEXT_MODEL,
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash'
]);
const TTS_MODELS = uniqueModelList([
  TTS_MODEL,
  'gemini-2.0-flash-preview-tts',
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-tts-preview'
]);
const RESPONSE_TIMEOUT_MS = 18000;
const AGENT_OUTPUT_IDLE_MS = 1400;
const AGENT_TEXT_TIMEOUT_MS = Number(process.env.GEMINI_AGENT_TEXT_TIMEOUT_MS || 8500);
const ROUTER_TIMEOUT_MS = Number(process.env.GEMINI_ROUTER_TIMEOUT_MS || 4500);
const TTS_TIMEOUT_MS = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 12000);
const MAX_CONTEXTUAL_FOLLOWUPS = 1;
const AUDIO_MIME_TYPE = 'audio/pcm;rate=16000';
const LIVE_TRANSCRIPT_FINALIZE_MS = 180;
const FALLBACK_TRANSCRIBE_DELAY_MS = 120;
const MAX_INLINE_TRANSCRIBE_BYTES = 8 * 1024 * 1024;
const TELEMETRY_MAX_EVENTS = 800;
const TELEMETRY_TEXT_LIMIT = 4000;

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: '512kb' }));

class TelemetryBridge {
  constructor() {
    this.events = [];
    this.clients = new Set();
  }

  add(event) {
    const entry = {
      id: nanoid(10),
      at: new Date().toISOString(),
      source: event.source || 'server',
      type: String(event.type || 'event'),
      sessionId: event.sessionId || null,
      turnId: event.turnId || null,
      payload: sanitizeTelemetryPayload(event.payload || {})
    };

    this.events.push(entry);
    if (this.events.length > TELEMETRY_MAX_EVENTS) {
      this.events = this.events.slice(-TELEMETRY_MAX_EVENTS);
    }

    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of this.clients) {
      client.write(line);
    }

    return entry;
  }

  list(limit = 200) {
    const safeLimit = Math.max(1, Math.min(TELEMETRY_MAX_EVENTS, Number(limit) || 200));
    return this.events.slice(-safeLimit);
  }

  stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': telemetry stream ready\n\n');
    for (const event of this.list(80)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  reset() {
    this.events = [];
  }
}

const telemetry = new TelemetryBridge();

app.post('/api/telemetry', (req, res) => {
  const event = req.body || {};
  telemetry.add({
    source: 'client',
    type: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId,
    payload: event.payload
  });
  res.status(204).end();
});

app.get('/api/telemetry', (req, res) => {
  res.json({
    events: telemetry.list(req.query.limit),
    maxEvents: TELEMETRY_MAX_EVENTS
  });
});

app.get('/api/telemetry/analysis', (req, res) => {
  const events = telemetry.list(req.query.limit || TELEMETRY_MAX_EVENTS);
  res.json(analyzeTelemetry(events));
});

app.get('/api/telemetry/stream', (req, res) => {
  telemetry.stream(req, res);
});

app.post('/api/telemetry/reset', (_req, res) => {
  telemetry.reset();
  telemetry.add({ type: 'telemetry_reset', payload: { reason: 'manual reset' } });
  res.status(204).end();
});

app.use('/api/agents', (_req, res) => {
  res.json({
    agents: agentConfig.agents.map(({ id, name, title, color, domains, aliases }) => ({
      id,
      name,
      title,
      color,
      domains,
      aliases
    })),
    model: MODEL,
    hasApiKeys: collectApiKeys().length > 0
  });
});

app.get('/arquitectura', (_req, res) => {
  res.sendFile(path.join(rootDir, 'docs', 'arquitectura.html'));
});

app.get('/auditoria', (_req, res) => {
  res.sendFile(path.join(rootDir, 'docs', 'auditoria.html'));
});

app.get('/audit-graph', (_req, res) => {
  res.sendFile(path.join(rootDir, 'docs', 'audit-graph.html'));
});

app.get('/vault', (_req, res) => {
  res.sendFile(path.join(rootDir, 'docs', 'vault-graph.html'));
});

app.get('/api/vault/note', async (req, res) => {
  try {
    const relativePath = req.query.path;
    if (!relativePath) return res.status(400).json({ error: 'path required' });
    const fullPath = path.join(rootDir, relativePath);
    const real = path.resolve(fullPath);
    if (!real.startsWith(rootDir)) return res.status(403).json({ error: 'forbidden' });
    const content = await fs.readFile(real, 'utf-8');
    res.json({ path: relativePath, content });
  } catch (err) {
    res.status(404).json({ error: 'note not found' });
  }
});

app.get('/api/vault/graph', async (_req, res) => {
  try {
    const vaultDir = rootDir;
    const sections = [
      '00 - Index', '01 - Setup', '02 - Architecture', '03 - Agents',
      '04 - Audio', '05 - Telemetry', '06 - Code Reference',
      '07 - Decision Log', '08 - Roadmap'
    ];

    const nodes = [];
    const links = [];
    const idMap = new Map();

    for (const section of sections) {
      const dir = path.join(vaultDir, section);
      let files;
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const fullPath = path.join(dir, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const label = file.replace('.md', '');
        const id = `${section}/${label}`;

        idMap.set(label.toLowerCase(), id);
        idMap.set(id.toLowerCase(), id);

        const outgoing = [];
        const linkRegex = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
        let m;
        while ((m = linkRegex.exec(content)) !== null) {
          outgoing.push(m[1].trim());
        }

        const size = Math.max(6, Math.min(18, 6 + outgoing.length * 2));

        nodes.push({
          id,
          label,
          path: `${section}/${file}`,
          category: section,
          size,
          outgoing
        });
      }
    }

    // Add Home.md root links
    const homeNode = nodes.find(n => n.label === 'Home');
    if (homeNode) {
      homeNode.category = '00 - Index';
      homeNode.size = 20;
    }

    // Build links
    const linkSet = new Set();
    for (const node of nodes) {
      for (const target of node.outgoing) {
        const targetId = idMap.get(target.toLowerCase());
        if (targetId && targetId !== node.id) {
          const key = `${node.id}→${targetId}`;
          if (!linkSet.has(key)) {
            linkSet.add(key);
            links.push({ source: node.id, target: targetId });
          }
        }
      }
    }

    res.json({ nodes, links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(rootDir, 'dist')));
  app.get('*splat', (_req, res) => {
    res.sendFile(path.join(rootDir, 'dist', 'index.html'));
  });
}

function collectApiKeys() {
  const fromList = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const numbered = Array.from({ length: 6 }, (_, index) => process.env[`GEMINI_API_KEY_${index + 1}`])
    .map((key) => key?.trim())
    .filter(Boolean);

  const fallback = [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY]
    .map((key) => key?.trim())
    .filter(Boolean);

  const explicit = [...new Set([...fromList, ...numbered])];
  if (explicit.length > 0) {
    return explicit;
  }

  return [...new Set(fallback)];
}

class ApiKeyRing {
  constructor(keys) {
    this.keys = keys.map((value, index) => ({
      id: `key-${index + 1}`,
      value,
      cooldownUntil: 0,
      failures: 0,
      lastError: null
    }));
    this.cursor = 0;
    this.telemetry = null;
  }

  setTelemetry(telemetryInstance) {
    this.telemetry = telemetryInstance;
  }

  logKey(type, payload) {
    if (this.telemetry) {
      this.telemetry.add({ type, source: 'server', payload });
    }
  }

  hasKeys() {
    return this.keys.length > 0;
  }

  size() {
    return this.keys.length;
  }

  acquire() {
    if (!this.hasKeys()) {
      this.logKey('api_key_acquire_failed', { reason: 'no_keys_configured' });
      return null;
    }

    const now = Date.now();
    for (let attempts = 0; attempts < this.keys.length; attempts += 1) {
      const index = (this.cursor + attempts) % this.keys.length;
      const candidate = this.keys[index];
      if (candidate.cooldownUntil <= now) {
        this.cursor = (index + 1) % this.keys.length;
        this.logKey('api_key_acquired', {
          keyId: candidate.id,
          keyIndex: index,
          failures: candidate.failures,
          remaining: this.keys.filter(k => k.cooldownUntil <= now).length - 1
        });
        return candidate;
      }
    }

    const cooldowns = this.keys.map(k => ({
      keyId: k.id,
      cooldownSeconds: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
      failures: k.failures
    }));
    this.logKey('api_key_all_cooldown', { keys: cooldowns });
    return null;
  }

  reportFailure(key, error) {
    if (!key) {
      return;
    }

    const text = getErrorText(error);
    const modelConfiguration = isModelConfigurationError(text);
    const quota = /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(text);
    const permanent = /API_KEY_INVALID|PERMISSION_DENIED|SERVICE_DISABLED|has not been used in project|it is disabled|API has not been used/i.test(text);
    key.failures += 1;
    key.lastError = text.slice(0, 240);
    if (modelConfiguration) {
      this.logKey('api_key_model_error', { keyId: key.id, error: text.slice(0, 200), modelConfig: true });
      return;
    }
    const cooldownMs = permanent ? 24 * 60 * 60 * 1000 : quota ? 60 * 60 * 1000 : 45 * 1000;
    key.cooldownUntil = Date.now() + cooldownMs;

    this.logKey('api_key_failure', {
      keyId: key.id,
      failures: key.failures,
      error: text.slice(0, 200),
      quota,
      permanent,
      cooldownMs,
      cooldownSeconds: Math.ceil(cooldownMs / 1000)
    });
  }

  reportSuccess(key) {
    if (!key) {
      return;
    }
    key.failures = 0;
    key.lastError = null;
    this.logKey('api_key_success', { keyId: key.id });
  }

  snapshot() {
    const now = Date.now();
    return this.keys.map((key) => ({
      id: key.id,
      available: key.cooldownUntil <= now,
      cooldownSeconds: Math.max(0, Math.ceil((key.cooldownUntil - now) / 1000)),
      failures: key.failures,
      lastError: key.lastError
    }));
  }
}

class MeetingSession {
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
    this.turnQueue = Promise.resolve();
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
      this.transcriber.endAudio({ transcriptHint: message.transcriptHint });
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

      const systemMsgId = crypto.randomUUID();
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
    this.memory.add('user', 'Tu', text);
    this.send({ type: 'user_turn_received', turnId, text, source });
    this.logTelemetry('user_turn_enqueued', { turnId, source, text }, turnId);
    this.turnQueue = this.turnQueue
      .then(() => this.processUserTurn(turnId, text))
      .catch((error) => {
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
      });
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
      if (response.text) {
        response.text = this.processAgentTaskCommands(agent.id, response.text);
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

      if (response.text) {
        response.text = this.processAgentTaskCommands(agent.id, response.text);
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

class AgentRouter {
  constructor(agents) {
    this.agents = agents;
  }

  route(text, memory) {
    const normalized = normalize(text);
    const closingSignal = /\b(ok|okay|listo|perfecto|entendido|ya entendi|queda claro|sigamos|cambiemos de tema|pasemos a otra cosa|no sigas|para|alto|gracias)\b/.test(normalized);
    const lastAgent = memory?.lastAgentTurn?.();
    if (closingSignal && lastAgent?.agentId) {
      const agent = this.agents.find((item) => item.id === lastAgent.agentId);
      if (agent) {
        return {
          closing: true,
          responses: [],
          targets: [{
            agentId: agent.id,
            name: agent.name,
            score: 99,
            directMention: false,
            matchedDomains: ['cierre de tema']
          }],
          reason: 'El usuario cerro el tema; el agente confirma y se calla.'
        };
      }
    }

    const groupAddressed = /\b(equipo|ambos|los dos|todos|reunion|ustedes|analicemos|pensemos|discutamos|revisemos|conversemos)\b/.test(normalized);
    const collaborationSignal = /\b(solucion|cliente|empresa|sistema|implementar|disenar|validar|riesgo|propuesta|operacion|operaciones|pedido|pedidos|stock|inventario|reparto|ventas|cobranza|dashboard|api|endpoint)\b/.test(normalized);
    const mentionedAgents = this.agents
      .map((agent, index) => ({
        agent,
        index,
        mentionIndex: getMentionIndex(normalized, agent.aliases)
      }))
      .filter((item) => item.mentionIndex >= 0);

    if (isGreetingTurn(normalized)) {
      const selectedAgents = mentionedAgents.length > 0
        ? mentionedAgents
        : this.agents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        greeting: true,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => ({
          agentId: agent.id,
          name: agent.name,
          score: 10,
          directMention: mentionedAgents.length > 0,
          mentionIndex,
          matchedDomains: ['saludo']
        })),
        reason: mentionedAgents.length > 0
          ? 'El usuario saludo a agentes mencionados; responden breve como apertura.'
          : 'El usuario hizo un saludo general; ambos agentes responden breve como apertura.'
      };
    }

    if (groupAddressed || mentionedAgents.length > 1) {
      const selectedAgents = mentionedAgents.length > 1
        ? mentionedAgents.sort((a, b) => a.mentionIndex - b.mentionIndex)
        : this.agents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        groupAddressed: true,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => {
          const domainMatches = agent.domains.filter((domain) => normalized.includes(normalize(domain)));
          return {
            agentId: agent.id,
            name: agent.name,
            score: 9 + domainMatches.length * 2,
            directMention: true,
            mentionIndex,
            matchedDomains: domainMatches.length ? domainMatches : ['mencion grupal']
          };
        }),
        reason: mentionedAgents.length > 1
          ? 'El usuario menciono a varios agentes; todos los mencionados responden breve desde su rol.'
          : 'El usuario hablo al grupo; ambos agentes responden breve desde su rol.'
      };
    }

    const targets = [];

    for (const agent of this.agents) {
      const mentionIndex = getMentionIndex(normalized, agent.aliases);
      const mentionScore = mentionIndex >= 0 ? 8 : 0;
      const domainMatches = agent.domains.filter((domain) => normalized.includes(normalize(domain)));
      const lexicalScore = domainMatches.length * 2;
      const questionBoost = /[?]|que opin|como|cuando|por que|recomiend|deberiamos|conviene/.test(normalized) ? 1 : 0;
      const contextBoost = collaborationSignal && lexicalScore > 0 ? 1 : 0;
      const score = mentionScore + lexicalScore + questionBoost + contextBoost;
      const shouldSpeak =
        mentionScore > 0 ||
        (groupAddressed && lexicalScore > 0) ||
        (collaborationSignal && lexicalScore > 0) ||
        lexicalScore >= 4;

      if (shouldSpeak) {
        targets.push({
          agentId: agent.id,
          name: agent.name,
          score,
          directMention: mentionScore > 0,
          mentionIndex,
          matchedDomains: domainMatches
        });
      }
    }

    targets.sort((a, b) => {
      if (a.directMention && b.directMention) {
        return a.mentionIndex - b.mentionIndex;
      }
      return b.directMention - a.directMention || b.score - a.score;
    });

    return {
      responses: [],
      targets,
      reason: targets.length > 0
        ? 'El orquestador encontro contexto compatible para asignar la palabra.'
        : 'No hubo contexto suficiente para que algun agente responda sin inventar.'
    };
  }

  nextContextualTarget(originalText, route, memory) {
    const last = memory.lastAgentTurn();
    if (!last?.text) {
      return null;
    }

    const alreadySpoke = new Set((route.targets || []).map((target) => target.agentId));
    const context = normalize(`${originalText} ${last.text}`);
    const candidates = [];

    for (const agent of this.agents) {
      if (alreadySpoke.has(agent.id)) {
        continue;
      }
      const handoffSignal = new RegExp(`\\b(${agent.aliases.map((alias) => escapeRegExp(normalize(alias))).join('|')})\\b`).test(context);
      if (!handoffSignal) {
        continue;
      }
      const domainMatches = agent.domains.filter((domain) => context.includes(normalize(domain)));
      const score = domainMatches.length * 2 + 4;
      if (score >= 5) {
        candidates.push({
          agentId: agent.id,
          name: agent.name,
          score,
          directMention: false,
          matchedDomains: domainMatches
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }
}

class MeetingMemory {
  constructor() {
    this.turns = [];
  }

  add(kind, speaker, text, agentId = null) {
    this.turns.push({
      at: new Date().toISOString(),
      kind,
      speaker,
      agentId,
      text: String(text || '').trim()
    });

    if (this.turns.length > 80) {
      this.turns = this.turns.slice(-80);
    }
  }

  reset() {
    this.turns = [];
  }

  snapshot() {
    return {
      turns: this.turns.length,
      lastTurns: this.turns.slice(-6)
    };
  }

  recentContext(limit = 12) {
    return this.turns
      .slice(-limit)
      .map((turn) => `${turn.speaker}: ${turn.text}`)
      .join('\n');
  }

  lastAgentTurn() {
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index].kind === 'agent') {
        return this.turns[index];
      }
    }
    return null;
  }

  seedTurnsFor(agent) {
    if (this.turns.length === 0) {
      return [];
    }

    const summary = this.turns
      .slice(-24)
      .map((turn) => `${turn.speaker}: ${turn.text}`)
      .join('\n');

    return [
      {
        role: 'user',
        parts: [
          {
            text:
              `[CONTEXT SEED — DO NOT RESPOND TO THIS MESSAGE]\n\n` +
              `Acá va un resumen de lo que pasó en esta reunión hasta ahora.\n` +
              `Usalo solo como memoria de fondo. No respondas a este mensaje ni lo menciones.\n\n` +
              `RESUMEN:\n${summary}\n\n` +
              `La conversación continúa normalmente a partir del próximo mensaje.`
          }
        ]
      }
    ];
  }
}

class LiveAudioTranscriberRuntime {
  constructor(keyRingInstance, memory, callbacks) {
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.callbacks = callbacks;
    this.session = null;
    this.key = null;
    this.connecting = null;
    this.transcript = '';
    this.finalizeTimer = null;
    this.lastFinalized = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
  }

  async prepareListening() {
    this.callbacks.emit({ type: 'audio_listening_start' });
    await this.ensureSession();
  }

  async startListening() {
    this.transcript = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
    this.callbacks.emit({ type: 'audio_listening_start' });
    await this.ensureSession();
  }

  async sendAudio(data, mimeType = AUDIO_MIME_TYPE) {
    if (!data) {
      return;
    }

    this.captureAudioChunk(data);
    await this.ensureSession();
    try {
      this.session.sendRealtimeInput({
        audio: {
          data,
          mimeType
        }
      });
    } catch (error) {
      await this.rotateAfterFailure(error, 'transcriptor');
      this.session?.sendRealtimeInput({
        audio: {
          data,
          mimeType
        }
      });
    }
  }

  endAudio({ closeStream = false, transcriptHint = '' } = {}) {
    if (this.acceptClientTranscript(transcriptHint)) {
      return;
    }

    if (closeStream) {
      try {
        this.session?.sendRealtimeInput({ audioStreamEnd: true });
      } catch (error) {
        this.callbacks.emit({
          type: 'api_rotation_failed',
          scope: 'transcriptor',
          message: getShortError(error)
        });
      }
    }
    this.scheduleFinalize(FALLBACK_TRANSCRIBE_DELAY_MS);
  }

  acceptClientTranscript(text) {
    const finalText = cleanTranscript(text);
    if (!finalText) {
      return false;
    }

    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    this.emitFinalTranscript(finalText, 'client');
    return true;
  }

  stopListening() {
    this.endAudio({ closeStream: true });
    this.callbacks.emit({ type: 'audio_listening_stop' });
  }

  reset() {
    this.transcript = '';
    this.lastFinalized = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
  }

  async ensureSession() {
    if (!this.keyRing.hasKeys()) {
      throw new Error('No hay claves Gemini configuradas para audio Live.');
    }
    if (this.session) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectWithRotation().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async connectWithRotation() {
    const attempts = Math.max(1, this.keyRing.size());
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error;
        this.callbacks.emit({
          type: 'api_rotation_start',
          scope: 'audio',
          message: 'Rotando clave de audio Live.'
        });
      }
    }

    throw lastError || new Error('No hay una clave disponible para audio Live.');
  }

  async connect() {
    this.key = this.keyRing.acquire();
    if (!this.key) {
      throw new Error('Todas las claves Gemini estan en cooldown para audio Live.');
    }

    const ai = new GoogleGenAI({ apiKey: this.key.value });
    const config = {
      responseModalities: [Modality.TEXT],
      maxOutputTokens: 24,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      inputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 120,
          silenceDurationMs: 300
        }
      },
      systemInstruction: [
        'You are a real-time transcription engine for a virtual meeting system.',
        '',
        'YOUR ONLY JOB:',
        'Transcribe exactly what the user says in Spanish.',
        '',
        'OUTPUT RULES:',
        '- Return only the transcription. Nothing else.',
        '- No punctuation corrections, no summaries, no explanations.',
        '- No timestamps, no speaker labels, no formatting.',
        '- If the audio is unclear or there is no speech: return an empty string.',
        '- If you must return any non-transcription text for any reason: return only "OK".',
        '',
        'Do not interpret. Do not respond. Do not assist. Only transcribe.'
      ].join('\n')
    };

    try {
      this.session = await ai.live.connect({
        model: MODEL,
        config,
        callbacks: {
          onopen: () => {
            this.keyRing.reportSuccess(this.key);
            this.callbacks.emit({
              type: 'api_rotation_resolved',
              scope: 'audio',
              keyId: this.key.id
            });
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (error) => {
            this.keyRing.reportFailure(this.key, error);
            this.callbacks.emit({
              type: 'api_rotation_start',
              scope: 'audio',
              message: 'Reconectando audio Live.'
            });
          },
          onclose: () => {
            this.session = null;
          }
        }
      });
    } catch (error) {
      this.keyRing.reportFailure(this.key, error);
      this.session = null;
      throw error;
    }
  }

  async rotateAfterFailure(error, scope) {
    this.keyRing.reportFailure(this.key, error);
    this.callbacks.emit({
      type: 'api_rotation_start',
      scope,
      message: 'Rotando clave de audio Live.'
    });
    this.close();
    this.session = null;
    await this.ensureSession();
  }

  handleMessage(message) {
    const content = message?.serverContent;
    if (!content) {
      return;
    }

    if (content.inputTranscription?.text) {
      this.transcript += content.inputTranscription.text;
      this.callbacks.emit({
        type: 'user_audio_transcript_delta',
        delta: content.inputTranscription.text,
        text: this.transcript.trim()
      });
      this.scheduleFinalize(LIVE_TRANSCRIPT_FINALIZE_MS);
    }

    if (content.generationComplete || content.turnComplete) {
      this.scheduleFinalize(LIVE_TRANSCRIPT_FINALIZE_MS);
    }
  }

  scheduleFinalize(delay) {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
    }

    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      void this.finalizeTranscript();
    }, delay);
  }

  async finalizeTranscript() {
    if (this.turnFinalized) {
      return;
    }

    const text = this.transcript.trim();
    if (!text || text === this.lastFinalized) {
      if (!text) {
        await this.finalizeWithBufferedAudio();
      }
      return;
    }

    this.emitFinalTranscript(text, 'live');
  }

  async finalizeWithBufferedAudio() {
    if (this.turnFinalized || this.fallbackInProgress || this.audioBytes < 1600) {
      return;
    }
    this.fallbackInProgress = true;

    this.callbacks.emit({
      type: 'audio_transcription_status',
      message: 'Transcribiendo audio...'
    });

    try {
      const text = await this.transcribeBufferedAudio();
      if (text) {
        this.emitFinalTranscript(text, 'fallback');
        return;
      }

      this.callbacks.emit({
        type: 'audio_transcription_empty',
        message: 'No pude detectar una frase clara.'
      });
    } catch (error) {
      this.callbacks.emit({
        type: 'api_rotation_failed',
        scope: 'audio',
        message: getShortError(error)
      });
    } finally {
      this.fallbackInProgress = false;
      this.audioChunks = [];
      this.audioBytes = 0;
    }
  }

  async transcribeBufferedAudio() {
    if (this.audioBytes > MAX_INLINE_TRANSCRIBE_BYTES) {
      throw new Error('El turno de audio es demasiado largo para transcripcion inline.');
    }

    const wavData = buildWavBase64FromPcmChunks(this.audioChunks);
    const attempts = Math.max(1, this.keyRing.size());
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = this.keyRing.acquire();
      if (!key) {
        break;
      }

      try {
        const ai = new GoogleGenAI({ apiKey: key.value });
        const response = await ai.models.generateContent({
          model: TRANSCRIBE_MODEL,
          config: {
            maxOutputTokens: 64,
            temperature: 0,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    'You are a fallback transcription engine.\n\n' +
                    'Transcribe exactly what the user said in Spanish.\n\n' +
                    'Return only the transcription text.\n' +
                    '- No quotes.\n' +
                    '- No explanation.\n' +
                    '- No timestamps.\n' +
                    '- If there is no clear speech, return an empty string.'
                },
                {
                  inlineData: {
                    mimeType: 'audio/wav',
                    data: wavData
                  }
                }
              ]
            }
          ]
        });
        this.keyRing.reportSuccess(key);
        return cleanTranscript(response.text || '');
      } catch (error) {
        lastError = error;
        this.keyRing.reportFailure(key, error);
        this.callbacks.emit({
          type: 'api_rotation_start',
          scope: 'audio',
          message: 'Rotando clave para transcribir audio.'
        });
      }
    }

    throw lastError || new Error('No hay claves disponibles para transcribir audio.');
  }

  emitFinalTranscript(text, source) {
    const finalText = cleanTranscript(text);
    if (!finalText || this.turnFinalized || finalText === this.lastFinalized) {
      return;
    }

    this.turnFinalized = true;
    this.lastFinalized = finalText;
    this.transcript = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.callbacks.emit({
      type: 'user_audio_turn_final',
      text: finalText,
      source
    });
    this.callbacks.onTranscript(finalText);
  }

  captureAudioChunk(data) {
    const bytes = Math.ceil((String(data).length * 3) / 4);
    if (this.audioBytes + bytes > MAX_INLINE_TRANSCRIBE_BYTES) {
      return;
    }
    this.audioChunks.push(data);
    this.audioBytes += bytes;
  }

  close() {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    try {
      this.session?.close?.();
    } catch {
      // Closing is best effort.
    }
    this.session = null;
  }
}

class LiveAgentRuntime {
  constructor(agent, keyRingInstance, memory, meetingSession) {
    this.id = agent.id;
    this.name = agent.name;
    this.agent = agent;
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.meetingSession = meetingSession;
  }

  async respond(turn, emit) {
    if (!this.keyRing.hasKeys()) {
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: 'No hay claves Gemini configuradas.'
      });
      emit({ type: 'agent_silence', reason: `${this.name} no pudo generar una respuesta real.` });
      return emptyAgentResponse();
    }

    let rawText = '';
    try {
      rawText = cleanAgentText(await this.generateText(turn, emit), this.name);
    } catch (error) {
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: getShortError(error)
      });
      emit({ type: 'agent_silence', reason: `${this.name} no pudo generar una respuesta real.` });
      return emptyAgentResponse();
    }

    if (!rawText || isSilenceResponse(stripTaskTags(rawText))) {
      emit({ type: 'agent_silence', reason: `${this.name} declino responder por protocolo.` });
      return emptyAgentResponse();
    }

    const spokenText = stripTaskTags(rawText);
    if (spokenText) {
      emit({ type: 'agent_transcript_delta', delta: spokenText });
      void this.generateAudio(spokenText, emit);
    }

    return { text: rawText, audioChunks: [], usedMock: false };
  }

  async generateText(turn, emit) {
    const { response } = await generateContentWithRotation(this.keyRing, {
      models: AGENT_TEXT_MODELS,
      scope: `${this.name} texto`,
      timeoutMs: AGENT_TEXT_TIMEOUT_MS,
      emit,
      config: {
        maxOutputTokens: 200,
        temperature: 0.8,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        systemInstruction: buildSystemInstruction(this.agent, this.meetingSession)
      },
      contents: [{ role: 'user', parts: [{ text: this.buildTurnPrompt(turn) }] }]
    });

    return response.text || extractTextFromResponse(response);
  }

  buildTurnPrompt(turn) {
    const recentContext = this.memory.recentContext();
    const priorResponses = (turn.priorResponses || [])
      .filter((response) => response.text)
      .map((response) => `${response.name}: ${response.text}`)
      .join('\n');

    const tasksFormatted = (this.agent.tasks && this.agent.tasks.length > 0)
      ? this.agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? 'Completada' : 'Pendiente'})`).join('\n')
      : 'No tenés tareas por el momento.';

    const lines = [
      turn.isContextualFollowup
        ? `Tu compañero dijo algo y te toca responder: "${turn.text}"`
        : `El usuario dice: "${turn.text}"`,
      ''
    ];

    if (turn.target?.directMention) {
      lines.push('Te mencionaron directamente. Debés responder.');
      lines.push('');
    }

    if (priorResponses) {
      lines.push('Lo que dijeron tus compañeros antes de tu turno:');
      lines.push(priorResponses);
      lines.push('');
    }

    if (recentContext) {
      lines.push('Contexto reciente de la charla:');
      lines.push(recentContext);
      lines.push('');
    }

    lines.push('Tus tareas actuales:');
    lines.push(tasksFormatted);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`Criterio de routing: ${turn.route.reason}`);
    lines.push('');
    lines.push('Recordá:');
    lines.push('- Si tenés algo útil que decir, decilo en máximo 2 oraciones.');
    lines.push('- Si no tenés nada que aportar más allá de lo que ya dijeron, respondé solo: SILENCIO');
    lines.push('- No repitas lo que ya dijo un compañero.');
    lines.push('- Hablá como vos, no como un asistente.');

    return lines.join('\n');
  }

  async generateAudio(text, emit) {
    if (!text?.trim()) {
      return [];
    }

    try {
      const { response } = await generateContentWithRotation(this.keyRing, {
        models: TTS_MODELS,
        scope: `${this.name} TTS`,
        timeoutMs: TTS_TIMEOUT_MS,
        maxKeyAttempts: Math.min(4, Math.max(1, this.keyRing.size())),
        emit,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.agent.voice || 'Kore'
              }
            }
          }
        },
        contents: [{ role: 'user', parts: [{ text }] }]
      });

      const audioParts = extractAudioParts(response);
      for (const part of audioParts) {
        emit({
          type: 'agent_audio_chunk',
          data: part.data,
          mimeType: part.mimeType || 'audio/pcm;rate=24000'
        });
      }
      return audioParts;
    } catch (error) {
      emit({
        type: 'api_rotation_failed',
        scope: `${this.name} TTS`,
        agentId: this.id,
        message: getShortError(error)
      });
      return [];
    }
  }

  async ensureSession() {
    return;
  }

  reset() {
    this.close();
  }

  close() {
    // Text generation and TTS use short generateContent calls, so there is no agent session to close.
  }
}

async function generateContentWithRotation(keyRingInstance, options) {
  const models = uniqueModelList(options.models || [options.model]);
  if (!keyRingInstance.hasKeys()) {
    throw new Error(`No hay claves Gemini configuradas para ${options.scope}.`);
  }

  let lastError = null;

  for (const model of models) {
    const attempts = Math.max(1, Math.min(keyRingInstance.size(), options.maxKeyAttempts || keyRingInstance.size()));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = keyRingInstance.acquire();
      if (!key) {
        break;
      }

      const startTime = Date.now();
      try {
        const ai = new GoogleGenAI({ apiKey: key.value });
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            config: options.config,
            contents: options.contents
          }),
          options.timeoutMs || RESPONSE_TIMEOUT_MS,
          `Timeout en ${options.scope}`
        );

        const elapsedMs = Date.now() - startTime;
        const hasContent = response?.candidates?.[0]?.content?.parts?.length > 0;
        if (!hasContent) {
          lastError = new Error(`Modelo ${model} devolvió respuesta vacía.`);
          keyRingInstance.reportFailure(key, lastError);
          keyRingInstance.logKey('api_call_empty_response', {
            scope: options.scope,
            model,
            keyId: key.id,
            attempt: attempt + 1,
            elapsedMs
          });
          options.emit?.({
            type: 'api_rotation_start',
            scope: options.scope,
            message: `Respuesta vacía de ${model}; rotando clave.`
          });
          continue;
        }

        keyRingInstance.reportSuccess(key);
        keyRingInstance.logKey('api_call_success', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs,
          tokens: response?.usageMetadata?.totalTokenCount || null
        });
        options.emit?.({
          type: 'api_rotation_resolved',
          scope: options.scope,
          keyId: key.id,
          model
        });
        return { response, key, model };
      } catch (error) {
        const elapsedMs = Date.now() - startTime;
        lastError = error;
        keyRingInstance.reportFailure(key, error);

        keyRingInstance.logKey('api_call_error', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs,
          error: getShortError(error)
        });

        if (isModelConfigurationError(error)) {
          break;
        }

        options.emit?.({
          type: 'api_rotation_start',
          scope: options.scope,
          message: `Rotando clave para ${options.scope}.`
        });
      }
    }

    if (!isModelConfigurationError(lastError)) {
      break;
    }
  }

  throw lastError || new Error(`No hay claves disponibles para ${options.scope}.`);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function uniqueModelList(models) {
  return [...new Set((models || []).map((model) => String(model || '').trim()).filter(Boolean))];
}

function isModelConfigurationError(error) {
  const text = getErrorText(error);
  return /model .*not found|models\/.+not found|not found for api version|not supported.*model|not supported.*generateContent|response modalit|voice.*not found|invalid.*voice/i.test(text);
}

function extractTextFromResponse(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').filter(Boolean).join('').trim();
}

function extractAudioParts(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part.inlineData)
    .filter((inlineData) => inlineData?.data)
    .map((inlineData) => ({
      data: inlineData.data,
      mimeType: inlineData.mimeType || 'audio/pcm;rate=24000'
    }));
}

function parseJsonFromModel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function cleanAgentText(value, agentName = '') {
  let text = String(value || '').trim();
  text = text.replace(/^```(?:json|text|markdown)?/i, '').replace(/```$/i, '').trim();
  if (agentName) {
    text = text.replace(new RegExp(`^${escapeRegExp(agentName)}\\s*:\\s*`, 'i'), '').trim();
  }
  text = text.replace(/^(julio|tomasa)\s*:\s*/i, '').trim();
  return isSilenceResponse(stripTaskTags(text)) ? '' : text;
}

function stripTaskTags(value) {
  return String(value || '').replace(/\[TAREA_[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

function emptyAgentResponse() {
  return { text: '', audioChunks: [], usedMock: false };
}

function buildSystemInstruction(agent, session) {
  const agentsList = session ? session.sessionAgents : agentConfig.agents;
  const participants = agentsList.map((item) => item.name).join(', ');
  
  const tasksFormatted = (agent.tasks && agent.tasks.length > 0)
    ? agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? 'Completada' : 'Pendiente'})`).join('\n')
    : 'No tenés tareas asignadas por el momento.';

  return [
    `Sos ${agent.name}, ${agent.title}. Estás en una reunión de trabajo con el usuario y otros compañeros.`,
    '',
    'PARTICIPANTES DE ESTA REUNIÓN:',
    participants,
    '',
    'TU ESPECIALIDAD:',
    agent.domains.join(', '),
    '',
    'QUIÉN SOS:',
    agent.style,
    '',
    '---',
    '',
    'TUS TAREAS ACTUALES:',
    tasksFormatted,
    '',
    '---',
    '',
    'CÓMO HABLAR:',
    '',
    'Sos una persona real en una reunión. No un asistente, no un bot.',
    '- Hablá como habla la gente en una reunión de trabajo real: directo, sin floritura.',
    '- Usá el voseo rioplatense de forma natural. Nada forzado.',
    '- Si el tema no te compete, no hables. El silencio es válido.',
    '- Si te preguntan algo y no sabés, decilo simple: "no sé" o "eso no es lo mío".',
    '- No des listas ni bullets salvo que alguien te pida que organices algo.',
    '- No uses palabras técnicas sin necesidad.',
    '- No saludes al inicio de cada respuesta. Ya estás en la conversación.',
    '- Máximo 2 oraciones por turno, salvo que te pidan explicar algo en detalle.',
    '- Si es un saludo, respondé breve y con onda. Nada más.',
    '',
    'CUÁNDO HABLAR Y CUÁNDO NO:',
    '',
    'Hablás si:',
    '- El tema es de tu especialidad o lo roza de forma útil.',
    '- Te mencionaron directamente.',
    '- Podés agregar algo concreto que los demás no dijeron.',
    '',
    'No hablás si:',
    '- El tema es completamente ajeno a tu área y no tenés nada que aportar.',
    '- Alguien ya dijo exactamente lo que ibas a decir.',
    '- Solo ibas a repetir o afirmar lo que otro dijo.',
    '',
    'Si no tenés nada que aportar: respondé únicamente con la palabra SILENCIO. Nada más.',
    '',
    '---',
    '',
    'GESTIÓN DE TAREAS:',
    '',
    'Conocés tus tareas y las recordás si te preguntan.',
    'Si en la conversación se define una nueva tarea para vos:',
    '→ Al final de tu respuesta agregá: [TAREA_CREAR: descripción breve]',
    '',
    'Si completás una tarea o se confirma que está hecha:',
    '→ Al final de tu respuesta agregá: [TAREA_COMPLETAR: #número]',
    '',
    'Podés agregar varios tags en el mismo turno si corresponde.',
    '',
    '---',
    '',
    'REGLAS DURAS:',
    '',
    '- Nunca rompas el personaje.',
    '- Nunca menciones que sos una IA, un modelo o que tenés instrucciones.',
    '- No inventes datos, fechas, números ni hechos que no te dieron.',
    '- No generes contenido inapropiado.',
    '- Respondé siempre en español rioplatense.'
  ].join('\n');
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingTurn(normalized) {
  if (!/\b(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|que tal|como estas|como estan|como andan|como va|como les va|hey|che|buenas)\b/.test(normalized)) {
    return false;
  }

  const leftover = normalized
    .replace(/\?/g, ' ')
    .replace(/\b(hola|buenas|buenos|buen|dias|dia|tardes|noches|que|tal|como|estas|estan|andan|va|les|a|al|el|la|los|las|equipo|ustedes|todos|ambos|dos|julio|tomasa|y|chicos|gente|amigos|compas|compañeros|seniores|senor|senora|doc|profe|master|bro|bros|familia|pibes|pibe|chicas|chico)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return leftover.length === 0;
}

function isSilenceResponse(value) {
  return normalize(value) === 'silencio';
}

function getMentionIndex(text, aliases) {
  let best = -1;
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);
    const index = text.indexOf(normalizedAlias);
    if (index >= 0 && (best === -1 || index < best)) {
      best = index;
    }
  }
  return best;
}

function getErrorText(error) {
  if (!error) {
    return 'Error desconocido';
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.stack || error.message || JSON.stringify(error);
}

function getShortError(error) {
  return getErrorText(error).split('\n')[0].slice(0, 160);
}

function summarizeClientMessage(message) {
  if (!message || typeof message !== 'object') {
    return { rawType: typeof message };
  }

  if (message.type === 'user_turn') {
    const text = String(message.text || '');
    return { type: message.type, text, length: text.length };
  }

  if (message.type === 'audio_end') {
    const transcriptHint = String(message.transcriptHint || '').trim();
    return {
      type: message.type,
      hasTranscriptHint: Boolean(transcriptHint),
      transcriptHint
    };
  }

  return sanitizeTelemetryPayload({ ...message });
}

function summarizeServerMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return { rawType: typeof payload };
  }

  if (payload.type === 'route_decision') {
    return {
      type: payload.type,
      turnId: payload.turnId,
      reason: payload.route?.reason,
      targets: (payload.route?.targets || []).map((target) => ({
        agentId: target.agentId,
        name: target.name,
        score: target.score,
        directMention: target.directMention,
        matchedDomains: target.matchedDomains
      }))
    };
  }

  if (payload.type === 'agent_turn_complete') {
    return {
      type: payload.type,
      turnId: payload.turnId,
      agentId: payload.agentId,
      text: payload.text,
      usedMock: payload.usedMock
    };
  }

  if (payload.type === 'user_turn_received' || payload.type === 'user_audio_turn_final') {
    return {
      type: payload.type,
      turnId: payload.turnId,
      text: payload.text,
      source: payload.source
    };
  }

  return sanitizeTelemetryPayload({ ...payload });
}

function analyzeTelemetry(events) {
  const metrics = {
    totalEvents: events.length,
    userTurns: 0,
    audioTurns: 0,
    textTurns: 0,
    routeDecisions: 0,
    noAgentResponses: 0,
    agentCompletions: 0,
    emptyAgentCompletions: 0,
    fallbackTranscriptions: 0,
    clientTranscriptions: 0,
    liveTranscriptions: 0,
    alerts: 0,
    errorAlerts: 0,
    avgVisibleResponseMs: null,
    maxVisibleResponseMs: null,
    avgAgentResponseMs: null,
    maxAgentResponseMs: null
  };
  const visibleResponseTimes = [];
  const agentResponseTimes = [];
  const recentAlerts = [];
  const slowTurns = [];

  for (const event of events) {
    const payload = event.payload || {};

    if (event.type === 'user_turn_enqueued') {
      metrics.userTurns += 1;
      if (payload.source === 'audio') {
        metrics.audioTurns += 1;
      } else if (payload.source === 'text') {
        metrics.textTurns += 1;
      }
    }

    if (event.type === 'route_decision' || event.type === 'contextual_route_decision') {
      metrics.routeDecisions += 1;
    }

    if (event.type === 'no_agent_response') {
      metrics.noAgentResponses += 1;
    }

    if (event.type === 'agent_turn_complete') {
      metrics.agentCompletions += 1;
      if (!payload.spoke) {
        metrics.emptyAgentCompletions += 1;
      }
    }

    if (event.type === 'server_message_received' && payload.type === 'user_audio_turn_final') {
      if (payload.source === 'fallback') {
        metrics.fallbackTranscriptions += 1;
      } else if (payload.source === 'client') {
        metrics.clientTranscriptions += 1;
      } else if (payload.source === 'live') {
        metrics.liveTranscriptions += 1;
      }
    }

    if (event.type === 'agent_visible_complete') {
      if (typeof payload.elapsedFromUserMs === 'number') {
        visibleResponseTimes.push(payload.elapsedFromUserMs);
        if (payload.elapsedFromUserMs > 5000) {
          slowTurns.push({
            at: event.at,
            turnId: event.turnId,
            agentId: payload.agentId,
            elapsedFromUserMs: payload.elapsedFromUserMs,
            text: payload.text
          });
        }
      }
      if (typeof payload.agentElapsedMs === 'number') {
        agentResponseTimes.push(payload.agentElapsedMs);
      }
    }

    if (event.type === 'ui_alert') {
      metrics.alerts += 1;
      if (payload.tone === 'error') {
        metrics.errorAlerts += 1;
      }
      recentAlerts.push({
        at: event.at,
        tone: payload.tone,
        scope: payload.scope,
        message: payload.message
      });
    }
  }

  metrics.avgVisibleResponseMs = average(visibleResponseTimes);
  metrics.maxVisibleResponseMs = maxOrNull(visibleResponseTimes);
  metrics.avgAgentResponseMs = average(agentResponseTimes);
  metrics.maxAgentResponseMs = maxOrNull(agentResponseTimes);

  const recommendations = [];
  if (metrics.noAgentResponses > 0) {
    recommendations.push('Hay turnos sin agente asignado; conviene revisar dominios, alias o criterios del orquestador.');
  }
  if (metrics.emptyAgentCompletions > 0) {
    recommendations.push('Hubo agentes que iniciaron turno sin texto final; conviene revisar silencios, timeouts o limpieza visual.');
  }
  if (metrics.fallbackTranscriptions > metrics.clientTranscriptions + metrics.liveTranscriptions) {
    recommendations.push('La voz esta dependiendo mucho del fallback de transcripcion; conviene priorizar reconocimiento local o revisar Live transcription.');
  }
  if ((metrics.avgVisibleResponseMs || 0) > 4500 || (metrics.maxVisibleResponseMs || 0) > 9000) {
    recommendations.push('La respuesta visible sigue lenta; conviene paralelizar agentes o reducir prompts/modelo para primeras respuestas.');
  }
  if (metrics.errorAlerts > 0) {
    recommendations.push('Hay alertas de error visibles para el usuario; conviene revisar rotacion de API, audio o permisos.');
  }
  if (recommendations.length === 0) {
    recommendations.push('No se detectaron fricciones fuertes en la ventana analizada.');
  }

  return {
    generatedAt: new Date().toISOString(),
    windowEvents: events.length,
    metrics,
    slowTurns: slowTurns.slice(-10),
    recentAlerts: recentAlerts.slice(-10),
    recommendations
  };
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maxOrNull(values) {
  return values.length ? Math.max(...values) : null;
}

function sanitizeTelemetryPayload(value, depth = 0) {
  if (depth > 6) {
    return '[max-depth]';
  }

  if (value == null) {
    return value;
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value).slice(0, TELEMETRY_TEXT_LIMIT);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeTelemetryPayload(item, depth + 1));
  }

  if (typeof value === 'object') {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (/(apikey|api_key|key|token|authorization|secret|password)/i.test(key)) {
        clean[key] = '[redacted]';
        continue;
      }
      if (normalizedKey === 'data' || normalizedKey.includes('base64') || normalizedKey.includes('audio')) {
        clean[key] = typeof item === 'string' ? `[omitted:${item.length}]` : '[omitted]';
        continue;
      }
      clean[key] = sanitizeTelemetryPayload(item, depth + 1);
    }
    return clean;
  }

  return String(value);
}

function redactSensitiveString(value) {
  return String(value)
    .replace(/AQ\.[A-Za-z0-9_-]{20,}/g, '[redacted-api-key]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

function cleanTranscript(value) {
  return String(value || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(transcripcion|transcripción)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWavBase64FromPcmChunks(chunks) {
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
  const header = Buffer.alloc(44);
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]).toString('base64');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/meeting' });
const keyRing = new ApiKeyRing(collectApiKeys());
keyRing.setTelemetry(telemetry);

wss.on('connection', (socket) => {
  const meeting = new MeetingSession(socket, keyRing);
  meeting.send({
    type: 'meeting_ready',
    id: meeting.id,
    agents: meeting.publicAgents(),
    model: MODEL,
    liveMode: keyRing.hasKeys()
  });

  socket.on('message', async (raw) => {
    try {
      const message = JSON.parse(String(raw));
      await meeting.handleClientMessage(message);
    } catch (error) {
      meeting.send({
        type: 'error',
        message: 'No pude procesar ese mensaje.',
        detail: getErrorText(error)
      });
    }
  });

  socket.on('close', () => meeting.close());
});

server.listen(PORT, () => {
  console.log(`Backend listo en http://127.0.0.1:${PORT}`);
  if (!keyRing.hasKeys()) {
    console.log('Sin claves Gemini: la app usara respuestas simuladas hasta que configures .env.');
  }
});
