import { readdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

import {
  ALLOWED_ORIGINS,
  MINIMAX_MODEL,
  TELEMETRY_MAX_EVENTS,
  collectApiKeys,
  companyTemplates,
  rootDir
} from './config.js';
import { buildSystemInstruction } from './agent-runtime.js';
import { renderLearningsSection } from './learning.js';
import { isMeetingLive } from './meeting-session.js';
import { applySuggestion } from './reflection.js';
import { deleteLogEntries, listLogDays, logDirectory, readLog } from './session-log.js';
import { applySettings, publicSettings } from './settings.js';
import { whisperHealthy } from './stt.js';
import { isAvailable as ttsAvailable } from './supertonic.js';
import { analyzeTelemetry, telemetry } from './telemetry.js';
import { projectDir, renderWorkSection, WORKSPACE_ROOT } from './workforce.js';

// Índice de archivos de un proyecto para el navegador integrado del cliente.
// Síncrono a propósito: son unas pocas decenas de entradas por proyecto.
function listProjectFiles(companyId, slug) {
  const base = projectDir(companyId, slug);
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || out.length >= 60) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        let size = 0;
        try {
          size = statSync(path.join(dir, entry.name)).size;
        } catch {
          size = 0;
        }
        out.push({ path: rel, size, url: `/workspace/${companyId}/${slug || 'general'}/${rel}` });
      }
    }
  };
  walk(base, '');
  return out.sort((a, b) => {
    // index.html primero: es lo que abre el navegador integrado.
    const aIndex = /(^|\/)index\.html?$/i.test(a.path) ? 0 : 1;
    const bIndex = /(^|\/)index\.html?$/i.test(b.path) ? 0 : 1;
    return aIndex - bIndex || a.path.localeCompare(b.path);
  });
}

export function createApp({ store }) {
  const app = express();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
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

  app.get('/api/settings', (_req, res) => {
    res.json({ settings: publicSettings() });
  });

  app.put('/api/settings', (req, res) => {
    const applied = applySettings(req.body?.settings || req.body || {});
    res.json({ applied, settings: publicSettings() });
  });

  app.get('/api/settings/status', async (_req, res) => {
    const [tts, whisper] = await Promise.all([ttsAvailable(), whisperHealthy()]);
    const current = publicSettings();
    res.json({
      llm: { configured: current.llm.apiKeySet, model: current.llm.model },
      tts: { engine: 'supertonic', healthy: tts },
      stt: {
        provider: current.stt.provider,
        localHealthy: whisper,
        groqConfigured: current.stt.groqKeySet
      }
    });
  });

  // Diario durable de la empresa: sirve para reconstruir qué pasó después
  // de que algo falle (los archivos están en server/data/logs/*.jsonl).
  app.get('/api/logs', async (req, res) => {
    const entries = await readLog({
      day: req.query.day,
      limit: req.query.limit,
      kind: req.query.kind,
      search: req.query.search
    });
    res.json({ directory: logDirectory(), days: await listLogDays(), entries });
  });

  app.get('/api/companies', (req, res) => {
    // Por defecto solo las activas; ?status=archived|all para ver el resto.
    const status = req.query.status;
    if (status === 'archived' || status === 'all') {
      return res.json({ companies: store.listCompaniesByStatus(status) });
    }
    res.json({ companies: store.listCompanies() });
  });

  // Entregables reales de los empleados (páginas, docs...) navegables.
  app.use('/workspace', express.static(WORKSPACE_ROOT, { fallthrough: true, index: ['index.html'] }));

  // Panel de trabajo de la empresa: metas con sus tareas, corridas
  // recientes y organigrama (rol + jefe) para el árbol.
  app.get('/api/companies/:id/work', (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'empresa no encontrada' });
    }
    const comments = store.recentComments(company.id, 60);
    const commentsByTask = new Map();
    for (const comment of comments) {
      if (!commentsByTask.has(comment.task_id)) {
        commentsByTask.set(comment.task_id, []);
      }
      commentsByTask.get(comment.task_id).push({
        id: comment.id,
        authorId: comment.author_id,
        kind: comment.kind,
        text: comment.text,
        createdAt: comment.created_at
      });
    }

    const goals = store.listGoals(company.id).slice(0, 12).map((goal) => ({
      ...goal,
      // Cada proyecto vive en su propia carpeta del entorno aislado.
      files: goal.kind === 'acuerdo' ? [] : listProjectFiles(company.id, goal.slug),
      url: goal.kind === 'acuerdo' ? null : `/workspace/${company.id}/${goal.slug || 'general'}/`,
      tasks: store.tasksForGoal(goal.id).map((task) => ({
        id: task.id,
        text: task.text,
        status: task.status,
        kind: task.kind || 'entregable',
        agentId: task.agent_id,
        reviewerId: task.reviewer_id,
        reviewStatus: task.review_status,
        parentTaskId: task.parent_task_id,
        resultSummary: task.result_summary,
        blockedReason: task.blocked_reason,
        runCount: task.run_count,
        comments: commentsByTask.get(task.id) || []
      }))
    }));
    res.json({
      company: { id: company.id, name: company.name },
      team: store.listAgents({ companyId: company.id }).map(({ id, name, title, color, role, managerId }) => ({ id, name, title, color, role, managerId })),
      goals,
      runs: store.recentWorkRuns(company.id, 30),
      comments: comments.map((comment) => ({
        id: comment.id,
        taskId: comment.task_id,
        authorId: comment.author_id,
        kind: comment.kind,
        text: comment.text,
        createdAt: comment.created_at
      })),
      workspaceUrl: `/workspace/${company.id}/`
    });
  });

  app.get('/api/company-templates', (_req, res) => {
    res.json({
      templates: companyTemplates.templates.map(({ id, name, industry, emoji, color, scenario, employees }) => ({
        id,
        name,
        industry,
        emoji,
        color,
        scenario,
        teamSize: (employees || []).length,
        team: (employees || []).map((employee) => ({ name: employee.name, title: employee.title }))
      }))
    });
  });

  app.post('/api/companies', (req, res) => {
    const body = req.body || {};
    if (body.templateId) {
      const template = companyTemplates.templates.find((item) => item.id === body.templateId);
      if (!template) {
        return res.status(404).json({ error: 'plantilla no encontrada' });
      }
      const overrides = {
        ...template,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : template.name
      };
      const company = store.createCompanyFromTemplate(overrides, 'user');
      return res.status(201).json({ company });
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) {
      return res.status(400).json({ error: 'la empresa necesita un nombre' });
    }
    const company = store.insertCompany({
      name,
      industry: typeof body.industry === 'string' ? body.industry.slice(0, 80) : '',
      emoji: typeof body.emoji === 'string' ? body.emoji.slice(0, 8) : '🏢',
      color: typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color) ? body.color : '#4c6ef5',
      scenario: typeof body.scenario === 'string' ? body.scenario.slice(0, 2000) : ''
    }, 'user');
    res.status(201).json({ company });
  });

  app.patch('/api/companies/:id', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
    if (typeof body.industry === 'string') patch.industry = body.industry.slice(0, 80);
    if (typeof body.emoji === 'string' && body.emoji.trim()) patch.emoji = body.emoji.slice(0, 8);
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color)) patch.color = body.color;
    if (typeof body.scenario === 'string') patch.scenario = body.scenario.slice(0, 2000);
    // Restaurar una empresa archivada (y volver a archivarla) es un cambio de
    // estado más: sin esto, archivar era un viaje de ida sin vuelta.
    if (body.status === 'active' || body.status === 'archived') patch.status = body.status;
    const company = store.updateCompany(req.params.id, patch);
    if (!company) {
      return res.status(404).json({ error: 'empresa no encontrada' });
    }
    res.json({ company });
  });

  app.post('/api/companies/:id/archive', (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'empresa no encontrada' });
    }
    store.archiveCompany(company.id, 'user');
    res.json({ ok: true });
  });

  app.get('/api/agents', (req, res) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : null;
    res.json({
      agents: store.listAgents({ companyId }),
      model: MINIMAX_MODEL,
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
    const company = agent.companyId ? store.getCompany(agent.companyId) : null;
    const scenario = company
      ? { name: `${company.name} (${company.industry})`, text: company.scenario }
      : null;
    const instruction = buildSystemInstruction(agent, {
      agents: store.listAgents({ companyId: agent.companyId }),
      scenario,
      workSection: renderWorkSection(store, agent.companyId),
      learningsSection: renderLearningsSection(store, agent.id)
    });
    res.json({ agentId: agent.id, companyId: agent.companyId, systemInstruction: instruction });
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

  app.get('/api/meetings', (req, res) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : null;
    res.json({ meetings: store.listMeetings(50, companyId) });
  });

  app.get('/api/meetings/:id', (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'reunión no encontrada' });
    }
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    res.json({ meeting, turns: store.recentTurns(meeting.id, limit), tasks: store.tasksForMeeting(meeting.id) });
  });

  // Borrar una reunión pasada: se va la conversación y su registro. Lo que
  // produjo trabajo (proyectos y sus tareas) sobrevive, desligado.
  app.delete('/api/meetings/:id', async (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'reunión no encontrada' });
    }
    if (isMeetingLive(meeting.id)) {
      return res.status(409).json({ error: 'estás sentado en esa reunión: abrí otra antes de borrarla' });
    }
    const resultado = store.deleteMeeting(meeting.id);
    const registros = await deleteLogEntries({ meetingId: meeting.id }).catch(() => 0);
    res.json({ ...resultado, registros });
  });

  // Borrado en bloque de lo que ya pasó en una empresa.
  app.delete('/api/companies/:id/meetings', async (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'empresa no encontrada' });
    }
    // Todas las de la empresa menos en la que hay alguien ahora mismo.
    const ids = store.listMeetings(200, company.id)
      .map((m) => m.id)
      .filter((id) => !isMeetingLive(id));
    let turnos = 0;
    let registros = 0;
    for (const id of ids) {
      const r = store.deleteMeeting(id);
      turnos += r?.turnos || 0;
      registros += await deleteLogEntries({ meetingId: id }).catch(() => 0);
    }
    res.json({ reuniones: ids.length, turnos, registros });
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
