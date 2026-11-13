import { existsSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

import {
  ALLOWED_ORIGINS,
  TELEMETRY_MAX_EVENTS,
  companyTemplates,
  rootDir
} from './config.js';
import { buildSystemInstruction } from './agent-runtime.js';
import { applyAudioSettings, listDevices, playTestTone, setNodeMute, setNodeVolume } from './audio.js';
import { CONNECTIVITY_INTERVAL_MS, ensureConnectivityLoop, getConnectivitySnapshot, isConnectivityTestEnv, refreshConnectivitySnapshot } from './connectivity.js';
import { androidStatus, iosStatus, openInAndroid, openInIos, screenSize, screenshot, sendInput, startAndroid, wakeAndroid } from './emulator.js';
import { enqueueJob, findJobRecord, getDefaultSession, getJob, listJobHistory, listJobs, listJobCheckpoints, loadJobBrief, loadJobRecord, loadLatestJobCheckpoint } from './driver.js';
import { renderLearningsSection } from './learning.js';
import { getMcpStatus, setMcpStatusSnapshot } from './mcp-status.js';
import { isMeetingLive } from './meeting-session.js';
import { buildLiveSnapshot } from './mission.js';
import { renderMemorySection } from './pablo-memory.js';
import { applySuggestion } from './reflection.js';
import { deleteLogEntries, listLogDays, logDirectory, readLog } from './session-log.js';
import { applySettings, getEnergyMode, getLlmKeys, getLlmModels, getLlmProvider, getLlmProviderConfig, publicSettings } from './settings.js';
import { getSidecarStatus } from './sidecars.js';
import { whisperHealthy } from './stt.js';
import { isAvailable as ttsAvailable } from './supertonic.js';
import { analyzeTelemetry, telemetry } from './telemetry.js';
import { esCarpetaIgnorada, projectDir, renderWorkSection, WORKSPACE_ROOT } from './workforce.js';
import { mountSceneRoutes } from './scene-mount.js';

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
      if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name) || out.length >= 60) continue;
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

  // Salud para el healthcheck del deploy (Render): GET plano, sin auth.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, servicio: 'equipo', proveedor: getLlmProvider(), modelo: getLlmModels()[0] || null, claves: getLlmKeys().length > 0 });
  });

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

  // TTS directo (Edge, sin turno LLM): botón "probar voz" y avisos.
  app.get('/api/decir', async (req, res) => {
    const texto = String(req.query.texto || '').slice(0, 280);
    if (!texto.trim()) {
      res.status(400).json({ error: 'missing text' });
      return;
    }
    try {
      const { synthesizeEdgeMp3 } = await import('./edge-tts.js');
      const mp3 = await synthesizeEdgeMp3(texto, { voice: 'F1' });
      res.json({ audio: mp3.data, mimeType: mp3.mimeType });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'tts' });
    }
  });

  app.put('/api/settings', async (req, res) => {
    const applied = applySettings(req.body?.settings || req.body || {});
    // Cambio de routing: mover streams vivos + set-default. Nunca rompe el
    // guardado: el error de audio se informa, el setting ya quedó.
    let audio = null;
    if (applied.some((key) => key.startsWith('audio.'))) {
      const current = publicSettings().audio;
      audio = await applyAudioSettings(current);
    }
    res.json({ applied, settings: publicSettings(), audio });
  });

  // ── Audio: routing PipeWire (Ajustes → grupo Audio) ─────────────────
  // Solo lectura + routing/volumen: no expone nada sensible.
  app.get('/api/audio/devices', async (_req, res) => {
    try {
      res.json({ devices: await listDevices() });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'audio unavailable' });
    }
  });

  app.put('/api/audio/volume', async (req, res) => {
    const { id, volume } = req.body || {};
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof volume !== 'number') {
      return res.status(400).json({ error: 'id + numeric volume (0..1) required' });
    }
    try {
      const node = await setNodeVolume(id, volume);
      res.json({ ok: true, id: node.id, name: node.name });
    } catch (err) {
      res.status(err?.code === 'AUDIO_NO_DEVICE' ? 404 : 502).json({
        error: err instanceof Error ? err.message : 'volume failed'
      });
    }
  });

  app.put('/api/audio/mute', async (req, res) => {
    const { id, muted } = req.body || {};
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof muted !== 'boolean') {
      return res.status(400).json({ error: 'id + boolean muted required' });
    }
    try {
      const node = await setNodeMute(id, muted);
      res.json({ ok: true, id: node.id, name: node.name });
    } catch (err) {
      res.status(err?.code === 'AUDIO_NO_DEVICE' ? 404 : 502).json({
        error: err instanceof Error ? err.message : 'mute failed'
      });
    }
  });

  // Tono de prueba (beep 880Hz/0.4s) al sink indicado o al default.
  app.post('/api/audio/test', async (req, res) => {
    try {
      await playTestTone(typeof req.body?.sink === 'string' ? req.body.sink : '');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'test tone failed' });
    }
  });

  // Estado del watchdog de sidecars STT/TTS (§3b): lo sirve el registro
  // en memoria del watcher activo, o 'unknown' si aún no tickeó.
  app.get('/api/sidecars', (_req, res) => {
    res.json({ sidecars: getSidecarStatus() });
  });

  app.get('/api/settings/status', async (_req, res) => {
    const [tts, whisper] = await Promise.all([ttsAvailable(), whisperHealthy()]);
    const current = publicSettings();
    res.json({
      llm: { configured: getLlmKeys().length > 0, provider: getLlmProvider(), model: current.llm.model },
      tts: { engine: current.tts.engine, healthy: tts, deepgramConfigured: current.stt.deepgramKeySet },
      stt: {
        provider: current.stt.provider,
        localHealthy: whisper,
        groqConfigured: current.stt.groqKeySet,
        deepgramConfigured: current.stt.deepgramKeySet
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
      return res.status(404).json({ error: 'company not found' });
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
        return res.status(404).json({ error: 'template not found' });
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
      return res.status(400).json({ error: 'the company needs a name' });
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
      return res.status(404).json({ error: 'company not found' });
    }
    res.json({ company });
  });

  app.post('/api/companies/:id/archive', (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'company not found' });
    }
    store.archiveCompany(company.id, 'user');
    res.json({ ok: true });
  });

  app.get('/api/agents', (req, res) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : null;
    res.json({
      agents: store.listAgents({ companyId }),
      model: getLlmModels()[0],
      hasApiKeys: getLlmKeys().length > 0
    });
  });

  // Devuelve el system prompt ensamblado tal como lo vería el modelo:
  // herramienta clave para verificar escenario, límites y (luego) memoria.
  app.get('/api/agents/:id/prompt-preview', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent || agent.status !== 'active') {
      return res.status(404).json({ error: 'agent not found' });
    }
    const company = agent.companyId ? store.getCompany(agent.companyId) : null;
    const scenario = company
      ? { name: `${company.name} (${company.industry})`, text: company.scenario }
      : null;
    const instruction = buildSystemInstruction(agent, {
      agents: store.listAgents({ companyId: agent.companyId }),
      scenario,
      workSection: renderWorkSection(store, agent.companyId),
      // 3600 chars: cubre los seeds (~3.2k) + daily (ship 09/11: con 1200 ni el SOUL entraba).
      memorySection: renderMemorySection(agent.companyId || 'pablo', { maxChars: 3600 }),
      learningsSection: renderLearningsSection(store, agent.id)
    });
    res.json({ agentId: agent.id, companyId: agent.companyId, systemInstruction: instruction });
  });

  // ── Aprendizajes: transparencia y control total del usuario ──────────

  app.get('/api/agents/:id/learnings', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
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
      return res.status(404).json({ error: 'learning not found' });
    }
    res.json({ ok: true });
  });

  // F-03: dreaming manual (determinístico: purga+decaimiento; la
  // consolidación LLM la corre el scheduler con keyRing).
  app.post('/api/dreaming/run', async (req, res) => {
    try {
      const { dreamCycle } = await import('./dreaming.js');
      const report = await dreamCycle({ store, dryRun: req.body?.dryRun === true });
      res.json({ ok: true, report });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // E-12: auto-aplicaciones + veto de Tito.
  app.get('/api/claims', (req, res) => {
    res.json({ claims: store.selfAssignedTasks(req.query.goalId || null, 24 * 60).map((t) => ({
      id: t.id, text: t.text, agentId: t.agent_id, status: t.status, goalId: t.goal_id
    })) });
  });

  app.post('/api/claims/:id/veto', (req, res) => {
    const r = store.vetoTask(req.params.id, 'tito-ui');
    if (!r.ok) {
      return res.status(400).json({ error: r.error });
    }
    res.json({ ok: true });
  });

  // E-10: propuestas de auto-mejora (aprobar/rechazar).
  app.get('/api/proposals', (req, res) => {
    res.json({ proposals: store.pendingProposals(req.query.goalId || null).map((r) => {
      let d = {};
      try { d = JSON.parse(r.text); } catch { /* legado */ }
      return { id: r.id, goalId: r.goal_id, agentId: r.agent_id, createdAt: r.created_at, ...d };
    }) });
  });

  app.post('/api/proposals/:id/resolve', async (req, res) => {
    const row = store.getTask(req.params.id);
    if (!row || row.kind !== 'proposal' || row.status !== 'pending') {
      return res.status(404).json({ error: 'proposal inexistente o resuelta' });
    }
    if (req.body?.approve === false) {
      store.finishTask(row.id, { status: 'rejected', summary: 'Rechazada por Tito.' });
      return res.json({ ok: true, approved: false });
    }
    try {
      const si = await import('./self-improve.js');
      const d = JSON.parse(row.text);
      const risk = si.classifyRisk(d);
      if (risk === 'high') {
        // High necesita confirmación explícita doble (irreversible/sensible).
        if (req.body?.confirm !== 'sí-aplico') {
          return res.status(409).json({ error: 'alto riesgo: reenviar con confirm="sí-aplico"', risk });
        }
      }
      const r = await si.applyLowRisk({ store, goalId: row.goal_id, proposal: d });
      // applyLowRisk cubre skill-create/taste/prompt-note; tier-ask va directo:
      let detail = r.detail;
      let applied = r.applied;
      if (!applied && d.kind === 'tier' && d.action === 'ask') {
        const { setTier } = await import('./permissions.js');
        applied = setTier(d.payload?.tool, 'ask');
        detail = applied ? `tier ${d.payload?.tool} → ask` : 'tier falló';
      }
      store.finishTask(row.id, { status: applied ? 'approved' : 'rejected', summary: detail });
      store.logChange('tito', 'proposal', row.id, applied ? 'approved' : 'approve-failed', { detail });
      res.json({ ok: true, approved: applied, detail });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // E-15: channels (inbox inbound + envío manual + webhook WhatsApp).
  app.get('/api/channels/inbox', (_req, res) => {
    import('./channel-runtime.js').then(({ channelInbox }) => res.json({ inbox: channelInbox() }))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/channels/send', async (req, res) => {
    try {
      const rt = await import('./channel-runtime.js');
      const kind = req.body?.channel || 'telegram';
      const fn = kind === 'whatsapp' ? rt.sendWhatsapp : rt.sendTelegram;
      const result = await fn({ to: req.body?.to, text: req.body?.text });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // Webhook WhatsApp: verificación GET + inbound POST (esqueleto funcional).
  app.get('/api/channels/whatsapp/webhook', (req, res) => {
    const verify = process.env.WHATSAPP_VERIFY || 'pablo-hook';
    if (req.query['hub.verify_token'] === verify) {
      return res.send(req.query['hub.challenge'] || '');
    }
    res.sendStatus(403);
  });

  app.post('/api/channels/whatsapp/webhook', async (req, res) => {
    try {
      const { waParseWebhook } = await import('./channels.js');
      const parsed = waParseWebhook(req.body);
      if (!parsed) {
        return res.json({ ok: true, allowed: false });
      }
      const { channelConfigs, handleChannelInbound } = await import('./channel-runtime.js');
      const ch = channelConfigs().find((c) => c.kind === 'whatsapp-meta') || {
        id: 'whatsapp',
        kind: 'whatsapp-meta',
        enabled: true,
        mode: 'tito-only',
        allow: [],
        titoId: process.env.WHATSAPP_TITO_ID || ''
      };
      const entry = await handleChannelInbound(ch, parsed, { respond: true, config: ch });
      return res.json({ ok: true, allowed: Boolean(entry?.allowed), duplicate: Boolean(entry?.duplicate) });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 200) });
    }
  });

  // E-17: energía (modo + autostart).
  app.get('/api/energy', (_req, res) => {
    import('./energy.js').then(({ readAutostartMode }) => {
      res.json({ mode: getEnergyMode(), autostart: readAutostartMode() });
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/energy/mode', (req, res) => {
    const mode = String(req.body?.mode || '').toLowerCase();
    if (!['always-on', 'gate', 'manual'].includes(mode)) {
      return res.status(400).json({ error: 'modo inválido (always-on|gate|manual)' });
    }
    store.setSetting('energy.mode', mode);
    import('./energy.js').then(({ applyEnergyMode }) => {
      res.json({ ok: true, ...applyEnergyMode(mode) });
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  // E-18: notificaciones (log + detalle + disparo manual).
  app.get('/api/notifications', (_req, res) => {
    import('./notifications.js').then(({ notificationLog }) => res.json({ notifications: notificationLog({}) }))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.get('/api/notifications/:id', (req, res) => {
    import('./notifications.js').then(({ notificationGet }) => {
      const n = notificationGet(req.params.id);
      if (!n) {
        return res.status(404).json({ error: 'notificación inexistente' });
      }
      res.json({ notification: n });
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/notifications/send', async (req, res) => {
    try {
      const { dispatchNotification, settingsAnnounce } = await import('./notifications.js');
      const n = await dispatchNotification({
        title: req.body?.title,
        detail: req.body?.detail || '',
        goalId: req.body?.goalId || null,
        short: req.body?.short || null,
        announce: settingsAnnounce
      });
      if (!n) {
        return res.status(400).json({ error: 'título requerido' });
      }
      res.json({ ok: true, notification: n });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // E-13: scheduler (CRUD + correr ya + outbox).
  app.get('/api/scheduler/jobs', (req, res) => {
    res.json({ jobs: store.listSchedJobs(req.query.goalId || null) });
  });

  app.post('/api/scheduler/jobs', (req, res) => {
    const job = store.createSchedJob({
      name: req.body?.name,
      kind: req.body?.kind,
      spec: req.body?.spec || {},
      action: req.body?.action || {},
      goalId: req.body?.goalId || null,
      enabled: req.body?.enabled !== false
    });
    if (!job) {
      return res.status(400).json({ error: 'job inválido (name + kind cron|interval|once|watcher)' });
    }
    res.status(201).json({ job });
  });

  app.post('/api/scheduler/jobs/:id/run', async (req, res) => {
    try {
      const { runDueJobs } = await import('./scheduler.js');
      store._prepare('UPDATE sched_jobs SET next_run = 0 WHERE id = ?').run(req.params.id);
      const ran = await runDueJobs({ store });
      res.json({ ok: true, ran: ran.filter((r) => r.id === req.params.id) });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  app.post('/api/scheduler/jobs/:id/toggle', (req, res) => {
    const ok = store.setSchedJobEnabled(req.params.id, req.body?.enabled !== false);
    if (!ok) {
      return res.status(404).json({ error: 'job inexistente' });
    }
    res.json({ ok: true });
  });

  app.delete('/api/scheduler/jobs/:id', (req, res) => {
    if (!store.deleteSchedJob(req.params.id)) {
      return res.status(404).json({ error: 'job inexistente' });
    }
    res.json({ ok: true });
  });

  app.get('/api/scheduler/outbox', (_req, res) => {
    import('./scheduler.js').then(({ scheduledOutbox }) => res.json({ outbox: scheduledOutbox() }))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  // E-22: prohibiciones (global + por proyecto).
  app.get('/api/prohibitions', (req, res) => {
    res.json({ prohibitions: store.prohibitionsFor(req.query.goalId || null) });
  });

  app.post('/api/prohibitions', (req, res) => {
    const row = store.addProhibition({
      scope: req.body?.scope || 'global',
      goalId: req.body?.goalId || null,
      kind: req.body?.kind,
      pattern: req.body?.pattern,
      reason: req.body?.reason || ''
    });
    if (!row) {
      return res.status(400).json({ error: 'prohibición inválida (kind tool|cmd|path|url + pattern)' });
    }
    res.status(201).json({ prohibition: row });
  });

  app.delete('/api/prohibitions/:id', (req, res) => {
    if (!store.removeProhibition(req.params.id)) {
      return res.status(404).json({ error: 'prohibición inexistente' });
    }
    res.json({ ok: true });
  });

  // A-06: grants guardados + policies hard-deny.
  app.get('/api/approvals/grants', (_req, res) => {
    import('./permissions.js').then(({ listGrants, listPolicies }) => res.json({ grants: listGrants(), policies: listPolicies() }))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.delete('/api/approvals/grants/:id', (req, res) => {
    import('./permissions.js').then(({ revokeGrant }) => {
      if (!revokeGrant(req.params.id)) {
        return res.status(404).json({ error: 'grant inexistente' });
      }
      res.json({ ok: true });
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/policies/apply', (req, res) => {
    import('./permissions.js').then(({ applyPolicy }) => {
      const r = applyPolicy(req.body?.policy);
      if (!r.ok) {
        return res.status(400).json({ error: r.error });
      }
      res.json(r);
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/policies/clear', (_req, res) => {
    import('./permissions.js').then(({ clearPolicies }) => {
      clearPolicies();
      res.json({ ok: true });
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  // F-10: introspección del gateway WS único.
  app.get('/api/ws/stats', (_req, res) => {
    import('./ws-registry.js').then(({ wsStats }) => res.json(wsStats()))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  // F-04: aprobaciones pendientes (UI) + grants.
  app.get('/api/approvals/pending', (_req, res) => {
    import('./permissions.js').then(({ listPending }) => res.json({ pending: listPending() }))
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/approvals/:id/resolve', (req, res) => {
    import('./permissions.js').then(({ resolveApproval }) => {
      const r = resolveApproval(req.params.id, req.body?.approve !== false, {
        scope: req.body?.scope || 'once',
        uses: req.body?.uses
      });
      if (!r.ok) {
        return res.status(404).json({ error: r.error });
      }
      res.json(r);
    }).catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  });

  app.post('/api/agents/:id/forget', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }
    store.forgetAllLearnings(agent.id, 'user');
    res.json({ ok: true });
  });

  app.post('/api/agents/:id/learning-enabled', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
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
      return res.status(404).json({ error: 'suggestion not found or already resolved' });
    }
    const ok = applySuggestion(store, suggestion);
    store.resolveSuggestion(suggestion.id, ok ? 'applied' : 'rejected');
    res.json({ ok });
  });

  app.post('/api/suggestions/:id/reject', (req, res) => {
    const suggestion = store.getSuggestion(Number(req.params.id));
    if (!suggestion || suggestion.status !== 'pending') {
      return res.status(404).json({ error: 'suggestion not found or already resolved' });
    }
    store.resolveSuggestion(suggestion.id, 'rejected');
    res.json({ ok: true });
  });

  app.post('/api/agents/:id/rollback', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }
    const versions = store.listAgentVersions(agent.id, 50);
    const target = versions.find((version) => version.version === Number(req.body?.toVersion));
    if (!target?.profile) {
      return res.status(404).json({ error: 'version not found' });
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
      return res.status(404).json({ error: 'agent not found' });
    }
    res.json({ versions: store.listAgentVersions(agent.id) });
  });

  // ── Proyectos ───────────────────────────────────────────────────────────
  //
  // El proyecto es el contenedor: adentro viven sus reuniones, sus tareas y
  // su actividad. La vista de empresa solo lista proyectos.

  app.get('/api/companies/:id/projects', (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'company not found' });
    }
    const projects = store.listProjects(company.id).map((project) => ({
      ...project,
      files: listProjectFiles(company.id, project.slug),
      url: `/workspace/${company.id}/${project.slug || 'general'}/`
    }));
    res.json({ company: { id: company.id, name: company.name }, projects });
  });

  app.post('/api/companies/:id/projects', (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'company not found' });
    }
    const title = String(req.body?.title || '').trim().slice(0, 120);
    if (!title) {
      return res.status(400).json({ error: 'the project needs a name' });
    }
    const project = store.createProject({
      companyId: company.id,
      title,
      brief: String(req.body?.brief || '').slice(0, 4000),
      stack: String(req.body?.stack || '').slice(0, 40)
    });
    res.status(201).json({ project });
  });

  app.get('/api/projects/:goalId', (req, res) => {
    const project = store.getGoal(req.params.goalId);
    if (!project) {
      return res.status(404).json({ error: 'project not found' });
    }
    const company = store.getCompany(project.company_id);
    const comments = store.commentsForProject(project.id);
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
    res.json({
      project: {
        ...project,
        files: listProjectFiles(project.company_id, project.slug),
        url: `/workspace/${project.company_id}/${project.slug || 'general'}/`
      },
      company: company ? { id: company.id, name: company.name, emoji: company.emoji, color: company.color } : null,
      team: store.listAgents({ companyId: project.company_id })
        .map(({ id, name, title, color, role, managerId, domains }) => ({ id, name, title, color, role, managerId, domains })),
      // E-03: equipo DEL PROYECTO (roles asignados + faltantes para spawner).
      projectTeam: store.rosterForProject(project.id),
      missingRoles: store.missingProjectRoles(project.id),
      meetings: store.meetingsForProject(project.id),
      tasks: store.tasksForGoal(project.id).map((task) => ({
        id: task.id,
        text: task.text,
        status: task.status,
        kind: task.kind || 'entregable',
        phase: task.phase,
        targetFile: task.target_file || null,
        agentId: task.agent_id,
        reviewerId: task.reviewer_id,
        reviewStatus: task.review_status,
        parentTaskId: task.parent_task_id,
        resultSummary: task.result_summary,
        blockedReason: task.blocked_reason,
        runCount: task.run_count,
        comments: commentsByTask.get(task.id) || []
      })),
      runs: store.runsForProject(project.id),
      comments: comments.map((comment) => ({
        id: comment.id,
        taskId: comment.task_id,
        authorId: comment.author_id,
        kind: comment.kind,
        text: comment.text,
        createdAt: comment.created_at
      }))
    });
  });

  app.patch('/api/projects/:goalId', (req, res) => {
    const patch = {};
    if (typeof req.body?.title === 'string') {
      patch.title = req.body.title.trim().slice(0, 120);
    }
    if (typeof req.body?.brief === 'string') {
      patch.brief = req.body.brief.slice(0, 4000);
    }
    if (typeof req.body?.stack === 'string') {
      patch.stack = req.body.stack.slice(0, 40);
    }
    if (typeof req.body?.access_level === 'string') {
      patch.access_level = req.body.access_level;
    }
    if (req.body?.caps && typeof req.body.caps === 'object') {
      store.setProjectCaps(req.params.goalId, {
        tokens: req.body.caps.tokens ?? null,
        ramMb: req.body.caps.ramMb ?? null,
        timeMin: req.body.caps.timeMin ?? null
      });
    }
    const project = store.updateProject(req.params.goalId, patch);
    if (!project) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ project });
  });

  // Borrar un proyecto se lleva TODO lo suyo: reuniones, turnos, tareas,
  // comentarios, corridas y la carpeta del entorno aislado. Es lo contrario
  // de borrar una reunión (que preserva el trabajo) — acá el pedido es limpiar.
  app.delete('/api/projects/:goalId', async (req, res) => {
    const project = store.getGoal(req.params.goalId);
    if (!project) {
      return res.status(404).json({ error: 'project not found' });
    }
    // Se leen ANTES de borrar: después ya no hay de dónde sacar los ids para
    // limpiar el registro en disco.
    const meetingIds = store.meetingsForProject(project.id).map((meeting) => meeting.id);
    if (meetingIds.some((id) => isMeetingLive(id))) {
      return res.status(409).json({ error: 'there is an open meeting in this project: close it before deleting' });
    }

    const resultado = store.deleteProject(project.id);
    let carpeta = false;
    // La carpeta solo se borra si es de este proyecto y nada más: las metas
    // anteriores a los proyectos comparten el slug 'general'.
    if (!resultado.carpetaCompartida) {
      carpeta = await fs.rm(projectDir(project.company_id, project.slug), { recursive: true, force: true })
        .then(() => true)
        .catch(() => false);
    }
    let registros = 0;
    for (const meetingId of meetingIds) {
      registros += await deleteLogEntries({ meetingId }).catch(() => 0);
    }
    res.json({ ...resultado, carpetaBorrada: carpeta, registros });
  });

  // ── Emulador y simulador ────────────────────────────────────────────────
  //
  // Ver el entregable móvil corriendo en un dispositivo de verdad. Si las
  // herramientas no están, se responde con el motivo — nunca un error crudo.

  app.get('/api/emulator/status', async (_req, res) => {
    const [android, ios] = await Promise.all([androidStatus(), iosStatus()]);
    res.json({ android, ios });
  });

  app.post('/api/emulator/start', async (req, res) => {
    const resultado = await startAndroid(typeof req.body?.avd === 'string' ? req.body.avd : null);
    res.status(resultado.ok ? 200 : 409).json(resultado);
  });

  // La pantalla del dispositivo, servida como PNG para verla DENTRO de la app.
  app.get('/api/emulator/screen', async (req, res) => {
    const plataforma = req.query.platform === 'ios' ? 'ios' : 'android';
    const png = await screenshot(plataforma);
    if (!png || png.length === 0) {
      return res.status(409).json({ error: 'no device with a screen' });
    }
    res.setHeader('Content-Type', 'image/png');
    // Sin caché: cada pedido es un cuadro nuevo.
    res.setHeader('Cache-Control', 'no-store');
    res.end(png);
  });

  // Despertar el dispositivo: dormido devuelve capturas negras.
  app.post('/api/emulator/wake', async (_req, res) => {
    res.json(await wakeAndroid());
  });

  app.get('/api/emulator/size', async (_req, res) => {
    const size = await screenSize();
    res.json(size || { width: 0, height: 0 });
  });

  // Los clics del usuario sobre esa imagen vuelven como toques reales.
  app.post('/api/emulator/input', async (req, res) => {
    const resultado = await sendInput(req.body || {});
    res.status(resultado.ok ? 200 : 409).json(resultado);
  });

  app.post('/api/projects/:goalId/open-in-device', async (req, res) => {
    const project = store.getGoal(req.params.goalId);
    if (!project) {
      return res.status(404).json({ error: 'project not found' });
    }
    const plataforma = req.body?.platform === 'ios' ? 'ios' : 'android';
    const resultado = plataforma === 'ios'
      ? await openInIos(project.company_id, project.slug)
      : await openInAndroid(project.company_id, project.slug);
    res.status(resultado.ok ? 200 : 409).json({ ...resultado, plataforma });
  });

  app.get('/api/meetings', (req, res) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : null;
    const goalId = typeof req.query.goalId === 'string' ? req.query.goalId : null;
    if (goalId) {
      return res.json({ meetings: store.meetingsForProject(goalId) });
    }
    res.json({ meetings: store.listMeetings(50, companyId) });
  });

  // Mission Control: reuniones con alguien sentado ahora mismo + su equipo.
  // Ruta nueva (09/11): no toca ningún endpoint existente.
  app.get('/api/mission/live', (_req, res) => {
    res.json(buildLiveSnapshot({
      meetings: store.listMeetings(200),
      isLive: isMeetingLive,
      getCompany: (id) => store.getCompany(id),
      teamFor: (companyId) => store.listAgents({ companyId }),
      goalFor: (meetingId) => {
        const meeting = store.getMeeting(meetingId);
        const goalId = meeting && (meeting.goal_id || meeting.goalId);
        if (!goalId) {
          return null;
        }
        const goal = store.getGoal(goalId);
        return goal ? goal.title : null;
      }
    }));
  });

  app.get('/api/meetings/:id', (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'meeting not found' });
    }
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    res.json({ meeting, turns: store.recentTurns(meeting.id, limit), tasks: store.tasksForMeeting(meeting.id) });
  });

  // Borrar una reunión pasada: se va la conversación y su registro. Lo que
  // produjo trabajo (proyectos y sus tareas) sobrevive, desligado.
  app.delete('/api/meetings/:id', async (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'meeting not found' });
    }
    if (isMeetingLive(meeting.id)) {
      return res.status(409).json({ error: 'you are sitting in that meeting: open another one before deleting it' });
    }
    const resultado = store.deleteMeeting(meeting.id);
    const registros = await deleteLogEntries({ meetingId: meeting.id }).catch(() => 0);
    res.json({ ...resultado, registros });
  });

  // Borrado en bloque de lo que ya pasó en una empresa.
  app.delete('/api/companies/:id/meetings', async (req, res) => {
    const company = store.getCompany(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'company not found' });
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
      return res.status(404).json({ error: 'meeting not found' });
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

  // Driver autónomo del equipo (track driver, 09/11): SOLO rutas nuevas.
  // POST crea el job (intake síncrono → jobId real) y corre async; GET
  // devuelve la vista pública resumida. La sesión viva la cablea main con
  // setDefaultSession() (meeting-session.js es no-tocar para el track).
  app.post('/api/team/jobs', (req, res) => {
    const session = getDefaultSession();
    if (!session || typeof session.runAgentJobTurn !== 'function') {
      return res.status(503).json({ error: 'sin sesión viva: el driver necesita una reunión con agentes' });
    }
    const brief = req.body?.brief;
    if (!brief || typeof brief !== 'object') {
      return res.status(400).json({ error: 'brief requerido (objeto con objetivo, criteriosExito, ...)' });
    }
    try {
      // T4: el job creado por HTTP siempre deja historial en disco (replay).
      const slug = typeof req.body?.slug === 'string' ? req.body.slug : undefined;
      const { jobId, estado } = enqueueJob(session, brief, { recordHistory: true, ...(slug ? { slug } : {}) });
      res.json({ jobId, estado });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // T4: lista recientes (vivos del registry + historial en disco).
  app.get('/api/team/jobs', async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    let disk = [];
    try {
      disk = await listJobHistory({ slug, limit });
    } catch {
      disk = [];
    }
    const merged = new Map(disk.map((j) => [j.id, j]));
    for (const j of listJobs()) {
      if (!merged.has(j.id)) merged.set(j.id, { ...j, slug: slug || 'general', source: 'live' });
    }
    const jobs = [...merged.values()]
      .sort((a, b) => (b.actualizadoEn || 0) - (a.actualizadoEn || 0))
      .slice(0, limit);
    res.json({ jobs });
  });

  app.get('/api/team/jobs/:id', async (req, res) => {
    const job = getJob(req.params.id);
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    let record = null;
    try {
      record = slug
        ? await loadJobRecord(slug, req.params.id)
        : (await findJobRecord(req.params.id))?.record || null;
    } catch {
      record = null;
    }
    if (!job && !record) {
      return res.status(404).json({ error: 'job not found' });
    }
    // Si el job ya no vive en memoria, se sintetiza una vista honesta desde
    // el record (fromDisk) para que el detalle siga funcionando.
    const fases = Array.isArray(record?.fases) ? record.fases : [];
    const view = job || {
      id: record.id,
      estado: record.estado || 'desconocido',
      motivo: record.motivo || null,
      fromDisk: true,
      progreso: {
        estado: record.estado || 'desconocido',
        fase: 'done',
        fasesTotal: fases.length,
        fasesCompletadas: fases.length,
        ronda: record.rondas ?? 0,
        maxRondas: 0,
        dispatches: { total: fases.length, entregados: fases.length },
        tests: record.tests || { celdas: 0, pasadas: 0, fallidas: 0, mecanicas: 0, turnos: 0 },
        actualizadoEn: record.updatedAt ? Date.parse(record.updatedAt) || 0 : 0,
        anuncios: (record.history || []).slice(-20).map((h) => ({ at: h.at, texto: h.texto || h.tipo || '' }))
      },
      resumen: {
        objetivo: record.objetivo || record.brief?.objetivo || '',
        fases: fases.length,
        entregas: [],
        tests: record.tests || {},
        rondas: record.rondas ?? 0,
        preguntas: null,
        escalado: null
      }
    };
    res.json({ job: view, history: record?.history || [], brief: record?.brief || null, fases });
  });

  app.get('/api/jobs/:id/checkpoints', async (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : (slug || getDefaultSession()?.company?.id || null);
    let checkpoints = listJobCheckpoints({ jobId: req.params.id, slug, companyId, session: getDefaultSession() });
    if (checkpoints.length === 0 && !slug) {
      try {
        const found = await findJobRecord(req.params.id);
        const foundSlug = found?.slug || null;
        if (foundSlug) {
          checkpoints = listJobCheckpoints({ jobId: req.params.id, slug: foundSlug, companyId: foundSlug, session: getDefaultSession() });
        }
      } catch {
        checkpoints = [];
      }
    }
    res.json({ jobId: req.params.id, checkpoints });
  });

  app.get('/api/team/jobs/:id/checkpoints', async (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : (slug || getDefaultSession()?.company?.id || null);
    let checkpoints = listJobCheckpoints({ jobId: req.params.id, slug, companyId, session: getDefaultSession() });
    if (checkpoints.length === 0 && !slug) {
      try {
        const found = await findJobRecord(req.params.id);
        const foundSlug = found?.slug || null;
        if (foundSlug) {
          checkpoints = listJobCheckpoints({ jobId: req.params.id, slug: foundSlug, companyId: foundSlug, session: getDefaultSession() });
        }
      } catch {
        checkpoints = [];
      }
    }
    res.json({ jobId: req.params.id, checkpoints });
  });

  // T4: replay — re-encola el brief guardado como un job nuevo.
  app.post('/api/team/jobs/:id/replay', async (req, res) => {
    const session = getDefaultSession();
    if (!session || typeof session.runAgentJobTurn !== 'function') {
      return res.status(503).json({ error: 'sin sesión viva: el driver necesita una reunión con agentes' });
    }
    const slug = typeof req.body?.slug === 'string' ? req.body.slug : (typeof req.query.slug === 'string' ? req.query.slug : null);
    const resume = req.body?.resume === true || req.body?.resumeFromCheckpoint === true || req.query.resume === '1';
    let brief = null;
    let foundSlug = slug;
    let record = null;
    try {
      if (slug) {
        brief = await loadJobBrief(slug, req.params.id);
        record = await loadJobRecord(slug, req.params.id);
      } else {
        const found = await findJobRecord(req.params.id);
        brief = found?.record?.brief || null;
        record = found?.record || null;
        foundSlug = found?.slug || null;
      }
    } catch {
      brief = null;
      record = null;
    }
    if (!brief) {
      return res.status(404).json({ error: 'job sin brief guardado: no se puede re-ejecutar' });
    }
    try {
      let opts = { recordHistory: true, slug: foundSlug || 'general' };
      if (resume) {
        const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId : (foundSlug || session?.company?.id || 'general');
        const checkpoint = req.body?.checkpoint || loadLatestJobCheckpoint({ jobId: req.params.id, slug: foundSlug || 'general', companyId, session });
        if (checkpoint) {
          opts = { ...opts, resumeCheckpoint: checkpoint, resumeJobId: req.params.id };
        }
      }
      const { jobId, estado } = enqueueJob(session, brief, opts);
      res.json({ jobId, estado, replayOf: req.params.id, resumed: Boolean(opts.resumeCheckpoint) });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // ── Manager MCP/skills v2 (T5, integración main) ──────────────────────
  // GET expone el status puro (config + snapshot vivo + gaps honestos);
  // POST ejecuta el planReconnect (releer config → shutdown → recargar
  // tools → refrescar snapshot) y devuelve el status fresco.
  app.get('/api/mcp/status', (req, res) => {
    try {
      res.json({ status: getMcpStatus() });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // Monitor de conectividad (TC 09/11, aditivo): sirve el snapshot en
  // memoria del sondeo periódico (30s, arranca lazy). Primer hit sin
  // snapshot sondea en el momento; snapshot viejo se sirve y se refresca
  // en fondo. En tests no hay loop ni refresh (snapshot inyectado).
  app.get('/api/connectivity', async (_req, res) => {
    try {
      ensureConnectivityLoop();
      let snap = getConnectivitySnapshot();
      if (!snap) {
        snap = await refreshConnectivitySnapshot();
      } else if (Date.now() - snap.ts > CONNECTIVITY_INTERVAL_MS && !isConnectivityTestEnv()) {
        void refreshConnectivitySnapshot().catch(() => {});
      }
      res.json(snap);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  app.post('/api/mcp/reconnect', async (req, res) => {
    try {
      const mcp = await import('./manos-mcp.js');
      mcp.readMcpConfig();
      await mcp.shutdown();
      const tools = await mcp.getMcpTools();
      const names = (tools || []).map((t) => String(t?.name || t));
      setMcpStatusSnapshot({ alive: true, tools: names });
      // El runtime también cachea tools MCP: Invalidar para que el próximo
      // turno relea. Best-effort: si manos no expone reload, el turno igual
      // funciona (loadMcpTools es idempotente por diseño).
      res.json({ status: getMcpStatus(), reconnected: names.length });
    } catch (error) {
      try {
        setMcpStatusSnapshot({ alive: false, tools: [] });
      } catch {
        // Snapshot caído: el status igual se intenta devolver.
      }
      res.status(500).json({ error: String(error?.message || error).slice(0, 300) });
    }
  });

  // Generative 3D scene API (additive, in-memory store)
  try {
    mountSceneRoutes(app);
  } catch (err) {
    console.error('[scene] mount failed:', err?.message || err);
  }

  const distDir = path.join(rootDir, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  if (existsSync(distIndex)) {
    app.use(express.static(distDir));
    // SPA fallback: let /api, /workspace and other existing routes win first.
    app.get('*splat', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/workspace') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(distIndex);
    });
  }

  return app;
}
