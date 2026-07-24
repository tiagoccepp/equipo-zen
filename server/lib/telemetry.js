import { nanoid } from 'nanoid';

import { TELEMETRY_MAX_EVENTS, TELEMETRY_TEXT_LIMIT } from './config.js';

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

export const telemetry = new TelemetryBridge();

export function summarizeClientMessage(message) {
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

export function summarizeServerMessage(payload) {
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

export function analyzeTelemetry(events) {
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

export function sanitizeTelemetryPayload(value, depth = 0) {
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
