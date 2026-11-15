import test from 'node:test';
import assert from 'node:assert/strict';

import { createTurnLatency, normalizeTurnLatencyRecord } from '../server/lib/turn-latency.js';
import {
  clearLatencyReport,
  getLatencySummary,
  getRecentLatency,
  recordTurnLatency
} from '../server/lib/latency-report.js';

test('createTurnLatency mantiene M-12 (ttfs/ttfr) y agrega e2e/stages', () => {
  let now = 1000;
  const clock = () => now;
  const t = createTurnLatency(1000, clock);
  assert.deepEqual({ ttfsMs: t.snapshot().ttfsMs, ttfrMs: t.snapshot().ttfrMs }, { ttfsMs: null, ttfrMs: null });

  now = 1120;
  t.markSound();
  now = 1180;
  t.markLlmFirstToken();
  now = 1250;
  t.markUseful();
  now = 1400;
  t.markEnd();
  const s = t.snapshot();
  assert.equal(s.ttfsMs, 120);
  assert.equal(s.ttfrMs, 250);
  assert.equal(s.e2eMs, 400);
  assert.equal(s.llmTtfbMs, 180);
  assert.ok(Number.isFinite(s.ttsTtfbMs));
});

test('normalizeTurnLatencyRecord normaliza campos y timings', () => {
  const rec = normalizeTurnLatencyRecord({
    turnId: 't1',
    agentId: 'a1',
    agentName: 'Pablo',
    source: 'audio',
    backend: 'stream',
    interrupted: 0,
    usedMock: false,
    spoke: 1,
    at: 1234.9,
    latency: { ttfsMs: 10.2, ttfrMs: '30', e2eMs: -5, llmTtfbMs: 15, ttsTtfbMs: null, sttMs: 220 }
  });
  assert.equal(rec.turnId, 't1');
  assert.equal(rec.agentId, 'a1');
  assert.equal(rec.agentName, 'Pablo');
  assert.equal(rec.source, 'audio');
  assert.equal(rec.spoke, true);
  assert.equal(rec.at, 1235);
  assert.deepEqual(rec.latency, {
    ttfsMs: 10,
    ttfrMs: 30,
    e2eMs: null,
    llmTtfbMs: 15,
    ttsTtfbMs: null,
    sttMs: 220
  });
});

test('latency-report registra turnos recientes y resume p50/latest', () => {
  clearLatencyReport();
  recordTurnLatency({ turnId: 't1', agentId: 'a', latency: { ttfsMs: 100, ttfrMs: 300, e2eMs: 900, llmTtfbMs: 120, ttsTtfbMs: 100 } });
  recordTurnLatency({ turnId: 't2', agentId: 'a', latency: { ttfsMs: 200, ttfrMs: 500, e2eMs: 1100, llmTtfbMs: 180, ttsTtfbMs: 200 } });
  recordTurnLatency({ turnId: 't3', agentId: 'b', latency: { ttfsMs: 300, ttfrMs: 700, e2eMs: 1300, llmTtfbMs: 240, ttsTtfbMs: 300 } });

  const recent = getRecentLatency({ limit: 2 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].turnId, 't3'); // más reciente primero
  assert.equal(recent[1].turnId, 't2');

  const summary = getLatencySummary({ limit: 10 });
  assert.equal(summary.turns, 3);
  assert.equal(summary.latest.turnId, 't3');
  assert.equal(summary.stages.ttfsMs.latest, 300);
  assert.equal(summary.stages.ttfsMs.p50, 200);
  assert.equal(summary.stages.ttfrMs.p50, 500);
  assert.equal(summary.stages.e2eMs.latest, 1300);
  assert.equal(summary.stages.llmTtfbMs.p50, 180);
  assert.equal(summary.stages.ttsTtfbMs.p50, 200);
});

test('latency-report ignora registros sin señal de timing', () => {
  clearLatencyReport();
  const out = recordTurnLatency({ turnId: null, latency: {} });
  assert.equal(out, null);
  assert.deepEqual(getRecentLatency(), []);
  const summary = getLatencySummary();
  assert.equal(summary.turns, 0);
  assert.equal(summary.latest, null);
});
