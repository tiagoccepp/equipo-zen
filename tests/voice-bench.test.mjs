import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  percentile,
  roundMs,
  summarizeSamples,
  formatMarkdownReport,
  mockRunTurn,
  runVoiceBench,
  runVoiceBenchReport,
  defaultScenario,
  defaultVariants,
} from '../server/lib/voice-bench.js';

function approxEqual(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~ ${b}`);
}

test('voice-bench percentile: basic interpolation and edges', () => {
  assert.equal(percentile([10], 0), 10);
  assert.equal(percentile([10], 50), 10);
  assert.equal(percentile([10], 100), 10);
  approxEqual(percentile([10, 20, 30, 40], 50), 25);
  approxEqual(percentile([10, 20, 30, 40], 95), 38.5);
  assert.throws(() => percentile([1, 2], 101), /0,100/);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('voice-bench mockRunTurn is deterministic by scenario/variant/run', () => {
  const turn = { text: 'Hola, probando benchmark de voz.' };
  const vEdge = { name: 'edge', flags: { ttsEngine: 'edge', sentenceStream: false } };
  const vEdgeStream = { name: 'edge-stream', flags: { ttsEngine: 'edge', sentenceStream: true } };
  const vPiper = { name: 'piper', flags: { ttsEngine: 'piper', sentenceStream: false } };
  const a1 = mockRunTurn({ turn, turnIndex: 0, run: 1, variant: vEdge });
  const a2 = mockRunTurn({ turn, turnIndex: 0, run: 1, variant: vEdge });
  assert.deepEqual(a1, a2);
  const stream = mockRunTurn({ turn, turnIndex: 0, run: 1, variant: vEdgeStream });
  const piper = mockRunTurn({ turn, turnIndex: 0, run: 1, variant: vPiper });
  assert.ok(stream.ttfbMs < a1.ttfbMs, 'sentence-stream should reduce TTFB in mock model');
  assert.ok(piper.ttfbMs < a1.ttfbMs, 'piper should have lower TTFB than edge in mock model');
  assert.ok(a1.e2eMs >= a1.ttfbMs);
});

test('voice-bench runVoiceBench collects timings across scripted conversation and variants', async () => {
  const scenario = {
    name: 'mini-script',
    turns: [
      { text: 'Hola' },
      { text: 'Necesito ayuda con mi pedido' },
      { text: 'Gracias' },
    ],
  };
  const variants = [
    { name: 'edge/off', flags: { ttsEngine: 'edge', sentenceStream: false } },
    { name: 'piper/on', flags: { ttsEngine: 'piper', sentenceStream: true } },
  ];
  const result = await runVoiceBench({ scenario, variants, runs: 2 });
  assert.equal(result.samples.length, 3 * 2 * 2); // turns * variants * runs
  assert.ok(result.summaries['edge/off']);
  assert.ok(result.summaries['piper/on']);
  assert.equal(result.summaries['edge/off'].samples, 6);
  assert.equal(result.summaries['edge/off'].errors, 0);
  assert.ok(Number.isFinite(result.summaries['edge/off'].ttfb.p50));
  assert.ok(Number.isFinite(result.summaries['edge/off'].ttfb.p95));
  assert.ok(Number.isFinite(result.summaries['edge/off'].e2e.p50));
  assert.ok(Number.isFinite(result.summaries['edge/off'].e2e.p95));
  // Known deterministic ordering from mock model.
  assert.ok(result.summaries['piper/on'].ttfb.p50 < result.summaries['edge/off'].ttfb.p50);
});

test('voice-bench supports injected per-variant runners and runScenario', async () => {
  const scenario = { name: 's', turns: [{ text: 'a' }, { text: 'b' }] };
  const fixed = {
    name: 'fixed',
    flags: { ttsEngine: 'mock', sentenceStream: false },
    runTurn: ({ turnIndex }) => ({ ttfbMs: 100 + turnIndex, e2eMs: 400 + turnIndex * 10 }),
  };
  const whole = {
    name: 'whole-scenario',
    runScenario: ({ run }) => [
      { turn: 1, ttfbMs: 50 + run, e2eMs: 200 + run },
      { turn: 2, ttfbMs: 60 + run, e2eMs: 210 + run },
    ],
  };
  const result = await runVoiceBench({ scenario, variants: [fixed, whole], runs: 2 });
  assert.equal(result.summaries.fixed.samples, 4);
  assert.equal(result.summaries['whole-scenario'].samples, 4);
  approxEqual(result.summaries.fixed.ttfb.p50, 100.5);
  approxEqual(result.summaries.fixed.e2e.p95, 410);
  approxEqual(result.summaries['whole-scenario'].ttfb.min, 51);
  approxEqual(result.summaries['whole-scenario'].e2e.max, 212);
});

test('voice-bench markdown report contains p50/p95 and variant flags', async () => {
  const { report, summaries } = await runVoiceBenchReport({
    scenario: { name: 'report-scenario', turns: [{ text: 'hola' }, { text: 'chau' }] },
    variants: [
      { name: 'edge', flags: { ttsEngine: 'edge', sentenceStream: false } },
      { name: 'piper-stream', flags: { ttsEngine: 'piper', sentenceStream: true } },
    ],
    runs: 1,
    includeSamples: true,
    meta: { generatedAt: '2026-11-14T00:00:00.000Z', notes: 'test' },
    title: 'Test Voice Bench',
  });
  assert.ok(report.includes('# Test Voice Bench'));
  assert.ok(report.includes('Scenario: report-scenario (2 turns)'));
  assert.ok(report.includes('Generated: 2026-11-14T00:00:00.000Z'));
  assert.ok(report.includes('## Summary (ms)'));
  assert.ok(report.includes('| Variant | Samples | Errors | TTFB p50 | TTFB p95 | E2E p50 | E2E p95 |'));
  assert.ok(report.includes('| edge |'));
  assert.ok(report.includes('| piper-stream |'));
  assert.ok(report.includes('"ttsEngine":"edge"'));
  assert.ok(report.includes('## Samples'));
  assert.ok(summaries.edge.ttfb.p50 > 0);
});

test('voice-bench captures runner errors as sample errors', async () => {
  const scenario = { name: 'err', turns: [{ text: 'x' }] };
  const variants = [{
    name: 'boom',
    runTurn: () => { throw new Error('synthetic failure'); },
  }];
  const result = await runVoiceBench({ scenario, variants, runs: 1 });
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].error, 'synthetic failure');
  assert.equal(result.summaries.boom.errors, 1);
  assert.equal(result.summaries.boom.ttfb.count, 0);
});

test('voice-bench defaults are usable and deterministic', async () => {
  const result = await runVoiceBench({ scenario: defaultScenario, variants: defaultVariants, runs: 1 });
  assert.equal(result.samples.length, defaultScenario.turns.length * defaultVariants.length);
  for (const v of defaultVariants) {
    assert.ok(result.summaries[v.name], `missing summary for ${v.name}`);
    assert.equal(result.summaries[v.name].errors, 0);
  }
  const report = formatMarkdownReport({
    scenario: result.scenario,
    variants: result.variants,
    summaries: result.summaries,
  });
  assert.ok(report.includes('short-greeting'));
  assert.equal(roundMs(1.23456, 2), 1.23);
});
