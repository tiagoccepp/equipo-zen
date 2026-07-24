import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

import {
  ALLOWED_ORIGINS,
  MODEL,
  TELEMETRY_MAX_EVENTS,
  collectApiKeys,
  rootDir
} from './config.js';
import { buildSystemInstruction } from './agent-runtime.js';
import { renderLearningsSection } from './learning.js';
import { applySuggestion } from './reflection.js';
import { analyzeTelemetry, telemetry } from './telemetry.js';

export function createApp({ store }) {
  const app = express();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    }
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '512kb' }));

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

  app.get('/api/agents', (_req, res) => {
    res.json({
      agents: store.listAgents(),
      model: MODEL,
      hasApiKeys: collectApiKeys().length > 0
    });
  });

  // Devuelve el system prompt ensamblado tal como lo vería el modelo:
  // herramienta clave para verificar escenario, límites y (luego) memoria.
  app.get('/api/agents/:id/prompt-preview', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent || agent.status !== 'active') {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    const meetingId = typeof req.query.meetingId === 'string' ? req.query.meetingId : null;
    const latest = meetingId ? { id: meetingId } : store.listMeetings(1)[0] || null;
    const meeting = latest ? store.getMeeting(latest.id) : null;
    const scenario = meeting
      ? { name: meeting.scenario_name, text: meeting.scenario_text }
      : null;
    const instruction = buildSystemInstruction(agent, {
      agents: store.listAgents(),
      scenario,
      learningsSection: renderLearningsSection(store, agent.id)
    });
    res.json({ agentId: agent.id, meetingId: meeting?.id || null, systemInstruction: instruction });
  });

  // ── Aprendizajes: transparencia y control total del usuario ──────────

  app.get('/api/agents/:id/learnings', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    res.json({
      agentId: agent.id,
      learningEnabled: agent.learningEnabled,
      learnings: store.learningsForPanel(agent.id)
    });
  });

  app.patch('/api/learnings/:id', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.content === 'string' && body.content.trim()) {
      patch.content = body.content.trim().slice(0, 300);
    }
    if (body.status === 'active' || body.status === 'archived' || body.status === 'user_deleted') {
      patch.status = body.status;
    }
    const updated = store.updateLearning(Number(req.params.id), patch, 'user');
    if (!updated) {
      return res.status(404).json({ error: 'aprendizaje no encontrado' });
    }
    res.json({ ok: true });
  });

  app.post('/api/agents/:id/forget', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    store.forgetAllLearnings(agent.id, 'user');
    res.json({ ok: true });
  });

  app.post('/api/agents/:id/learning-enabled', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    store.updateAgent(agent.id, { learningEnabled: Boolean(req.body?.enabled) }, 'user', 'toggle de aprendizaje');
    res.json({ ok: true });
  });

  app.get('/api/suggestions', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    res.json({ suggestions: store.listSuggestions(status) });
  });

  app.post('/api/suggestions/:id/apply', (req, res) => {
    const suggestion = store.getSuggestion(Number(req.params.id));
    if (!suggestion || suggestion.status !== 'pending') {
      return res.status(404).json({ error: 'sugerencia no encontrada o ya resuelta' });
    }
    const ok = applySuggestion(store, suggestion);
    store.resolveSuggestion(suggestion.id, ok ? 'applied' : 'rejected');
    res.json({ ok });
  });

  app.post('/api/suggestions/:id/reject', (req, res) => {
    const suggestion = store.getSuggestion(Number(req.params.id));
    if (!suggestion || suggestion.status !== 'pending') {
      return res.status(404).json({ error: 'sugerencia no encontrada o ya resuelta' });
    }
    store.resolveSuggestion(suggestion.id, 'rejected');
    res.json({ ok: true });
  });

  app.post('/api/agents/:id/rollback', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    const versions = store.listAgentVersions(agent.id, 50);
    const target = versions.find((version) => version.version === Number(req.body?.toVersion));
    if (!target?.profile) {
      return res.status(404).json({ error: 'versión no encontrada' });
    }
    const profile = target.profile;
    store.updateAgent(agent.id, {
      name: profile.name,
      title: profile.title,
      voice: profile.voice,
      color: profile.color,
      style: profile.style,
      aliases: profile.aliases,
      domains: profile.domains,
      boundaries: profile.boundaries
    }, 'user', `rollback a v${profile.version}`);
    res.json({ ok: true, restoredVersion: profile.version });
  });

  app.get('/api/agents/:id/versions', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agente no encontrado' });
    }
    res.json({ versions: store.listAgentVersions(agent.id) });
  });

  app.get('/api/meetings', (_req, res) => {
    res.json({ meetings: store.listMeetings(50) });
  });

  app.get('/api/meetings/:id', (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'reunión no encontrada' });
    }
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    res.json({ meeting, turns: store.recentTurns(meeting.id, limit), tasks: store.tasksForMeeting(meeting.id) });
  });

  app.patch('/api/meetings/:id', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.title === 'string') {
      patch.title = body.title.slice(0, 120);
    }
    if (typeof body.scenarioText === 'string') {
      patch.scenarioText = body.scenarioText.slice(0, 2000);
    }
    const meeting = store.updateMeeting(req.params.id, patch);
    if (!meeting) {
      return res.status(404).json({ error: 'reunión no encontrada' });
    }
    res.json({ meeting });
  });

  app.get('/api/changelog', (req, res) => {
    res.json({
      entries: store.listChangelog({
        entity: typeof req.query.entity === 'string' ? req.query.entity : null,
        entityId: typeof req.query.entityId === 'string' ? req.query.entityId : null,
        limit: Math.max(1, Math.min(200, Number(req.query.limit) || 50))
      })
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
      if (!relativePath || typeof relativePath !== 'string') {
        return res.status(400).json({ error: 'path required' });
      }
      const real = path.resolve(rootDir, relativePath);
      const relative = path.relative(rootDir, real);
      const escapesRoot = !relative || relative.startsWith('..') || path.isAbsolute(relative);
      const hasHiddenSegment = relative.split(path.sep).some((segment) => segment.startsWith('.'));
      if (escapesRoot || hasHiddenSegment || !real.endsWith('.md')) {
        return res.status(403).json({ error: 'forbidden' });
      }
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

  return app;
}
