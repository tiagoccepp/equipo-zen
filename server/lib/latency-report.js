import { normalizeTurnLatencyRecord } from './turn-latency.js';

const MAX_RECENT = 200;
const recent = [];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsFor(key, records) {
  const values = records
    .map((r) => r?.latency?.[key])
    .filter((v) => Number.isFinite(v));
  if (!values.length) {
    return { count: 0, latest: null, p50: null, p95: null, min: null, max: null, avg: null };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    latest: values[values.length - 1] ?? null,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round(sum / values.length),
  };
}

export function recordTurnLatency(input = {}) {
  const rec = normalizeTurnLatencyRecord(input);
  // Ignore records with no timing signal at all.
  const hasAny = Object.values(rec.latency || {}).some((v) => Number.isFinite(v));
  if (!hasAny && !rec.turnId) return null;
  recent.push(rec);
  if (recent.length > MAX_RECENT) {
    recent.splice(0, recent.length - MAX_RECENT);
  }
  return rec;
}

export function getRecentLatency({ limit = 20 } = {}) {
  const lim = Math.max(1, Math.min(MAX_RECENT, Number(limit) || 20));
  return recent.slice(-lim).reverse();
}

export function getLatencySummary({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(MAX_RECENT, Number(limit) || 50));
  const sample = recent.slice(-lim);
  const latest = sample.length ? sample[sample.length - 1] : null;
  return {
    turns: sample.length,
    totalRecorded: recent.length,
    latest,
    stages: {
      ttfsMs: statsFor('ttfsMs', sample),
      ttfrMs: statsFor('ttfrMs', sample),
      e2eMs: statsFor('e2eMs', sample),
      llmTtfbMs: statsFor('llmTtfbMs', sample),
      ttsTtfbMs: statsFor('ttsTtfbMs', sample),
      sttMs: statsFor('sttMs', sample),
    },
  };
}

export function clearLatencyReport() {
  recent.length = 0;
}

export function _latencyReportState() {
  return { recent };
}
