// Team v2 tests: ordered rounds + synthesis + SOP + flag.
// 100% fake model: no test touches network or real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SOP,
  TEAM_NOTE_PREFIX,
  V2_MAX_ROUNDS_HARD,
  consult,
  hasDisagreement,
  orderSpeakers,
  parseSop,
  runSalaV2
} from '../server/lib/sala.js';
import { maybeConsultSala } from '../server/lib/turn-pipeline.js';
import {
  getSalaAgentTimeoutMs,
  getSalaSop,
  getSalaV2
} from '../server/lib/settings.js';

const PREGUNTA = 'compará hosting A vs B, ¿qué conviene?';

function nombreDeSystem(sys) {
  const m = String(sys).match(/Sos ([^\s,]+)/);
  return (m ? m[1] : '?').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Fake completeChat(keyRing, { scope, messages }): records voice order,
// answers per speaker, distinguishes synthesis by scope.
function fakeSala({ synth = 'DECISIÓN: vamos con A. Dueños: bruno. Riesgo: ninguno.', bySpeaker = {}, order = [], calls = [] } = {}) {
  return async (_keyRing, { scope, messages }) => {
    calls.push(scope);
    if (scope === 'sala_v2_sintesis') {
      return { text: synth, model: 'fake' };
    }
    const name = nombreDeSystem(messages[0].content);
    order.push(name);
    const cfg = bySpeaker[name] || {};
    if (cfg.slow) {
      await new Promise((r) => setTimeout(r, cfg.slow));
    }
    if (cfg.throw) {
      throw new Error('boom');
    }
    if (typeof cfg.onCall === 'function') {
      cfg.onCall();
    }
    return {
      text: cfg.text ?? `APORTE [${name}]: propongo X. EVIDENCIA: medí Y. CONFIANZA: alta. IMPLICA: hacerlo.`,
      model: 'fake'
    };
  };
}

const ROUTE_3 = {
  targets: [
    { agentId: 'camila', score: 9, matchedDomains: ['riesgo'] },
    { agentId: 'ivan', score: 4, matchedDomains: ['web'] },
    { agentId: 'bruno', score: 6, matchedDomains: ['codigo'] }
  ]
};

// ── parseSop ────────────────────────────────────────────────────────────

test('parseSop: sensible defaults with empty text', () => {
  assert.deepEqual(parseSop(''), {
    order: 'score-desc',
    maxRounds: 2,
    agentTimeoutMs: 20000,
    r2: 'on-disagreement'
  });
  assert.deepEqual(parseSop(null), parseSop(''));
});

test('parseSop: reads knobs from the SOP', () => {
  const sop = parseSop('order: score-asc\nmax_rounds: 1\nagent_timeout_ms: 5000\nr2: never');
  assert.deepEqual(sop, { order: 'score-asc', maxRounds: 1, agentTimeoutMs: 5000, r2: 'never' });
});

test('parseSop: max_rounds clamps to the hard cap 1..2', () => {
  assert.equal(V2_MAX_ROUNDS_HARD, 2);
  assert.equal(parseSop('max_rounds: 9').maxRounds, 2);
  assert.equal(parseSop('max_rounds: 0').maxRounds, 1);
  assert.equal(parseSop('max_rounds: -3').maxRounds, 1);
});

test('parseSop: unknown values → defaults', () => {
  const sop = parseSop('order: gritar\nr2: siempre\nagent_timeout_ms: poco');
  assert.equal(sop.order, 'score-desc');
  assert.equal(sop.r2, 'on-disagreement');
  assert.equal(sop.agentTimeoutMs, 20000);
});

test('parseSop: DEFAULT_SOP parses to defaults', () => {
  assert.deepEqual(parseSop(DEFAULT_SOP), parseSop(''));
});

// ── orderSpeakers ───────────────────────────────────────────────────────

test('orderSpeakers: sorts by score desc', () => {
  const ids = orderSpeakers(ROUTE_3, {}).map((s) => s.agentId);
  assert.deepEqual(ids, ['camila', 'bruno', 'ivan']);
});

test('orderSpeakers: score-asc reverses', () => {
  const ids = orderSpeakers(ROUTE_3, { order: 'score-asc' }).map((s) => s.agentId);
  assert.deepEqual(ids, ['ivan', 'bruno', 'camila']);
});

test('orderSpeakers: filters CEO/greeting/closing, cap 4', () => {
  const route = {
    targets: [
      { agentId: 'pablo', score: 99, matchedDomains: ['general coordination'] },
      { agentId: 'a', score: 8, matchedDomains: ['codigo'] },
      { agentId: 'b', score: 7, matchedDomains: ['web'] },
      { agentId: 'c', score: 6, matchedDomains: ['riesgo'] },
      { agentId: 'd', score: 5, matchedDomains: ['stock'] },
      { agentId: 'e', score: 4, matchedDomains: ['codigo'] }
    ]
  };
  const ids = orderSpeakers(route, {}).map((s) => s.agentId);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('orderSpeakers: no route → default roster ivan/bruno/camila', () => {
  assert.deepEqual(orderSpeakers(null, {}).map((s) => s.agentId), ['ivan', 'bruno', 'camila']);
  assert.deepEqual(orderSpeakers({ targets: [] }, {}).map((s) => s.agentId), ['ivan', 'bruno', 'camila']);
});

// ── hasDisagreement ─────────────────────────────────────────────────────

test('hasDisagreement: ≥2 alive → true; 1 or silences → false', () => {
  assert.equal(hasDisagreement([
    { kind: 'aporte' }, { kind: 'aporte' }
  ]), true);
  assert.equal(hasDisagreement([{ kind: 'aporte' }]), false);
  assert.equal(hasDisagreement([
    { kind: 'aporte' }, { kind: 'silencio' }, { kind: 'ausente' }
  ]), false);
  assert.equal(hasDisagreement([]), false);
});

// ── runSalaV2 ───────────────────────────────────────────────────────────

test('runSalaV2: flag off → null without calling the model', async () => {
  let llamadas = 0;
  const telemetria = [];
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: false,
      completeChat: async () => { llamadas += 1; return { text: 'x' }; },
      onTelemetry: (ev, data) => telemetria.push([ev, data])
    }
  });
  assert.equal(out, null);
  assert.equal(llamadas, 0);
  assert.equal(telemetria[0][0], 'sala_skip');
  assert.equal(telemetria[0][1].reason, 'flag_off');
});

test('runSalaV2: R1 in score order + reversed R2 + synthesis', async () => {
  const order = [];
  const telemetria = [];
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({ order }),
      onTelemetry: (ev, data) => telemetria.push([ev, data])
    }
  });
  assert.ok(out);
  assert.equal(out.roundsRun, 2);
  // R1: camila, bruno, ivan (score desc). R2: reversed.
  assert.deepEqual(order, ['camila', 'bruno', 'ivan', 'ivan', 'bruno', 'camila']);
  assert.ok(out.note.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.note.includes('DECISIÓN: vamos con A'));
  assert.deepEqual(out.speakers, ['camila', 'bruno', 'ivan']);
  assert.deepEqual(out.ausentes, []);
  const eventos = telemetria.map(([ev]) => ev);
  assert.ok(eventos.includes('sala_open'));
  assert.ok(eventos.includes('sala_close'));
});

test('runSalaV2: hard cap — max_rounds: 9 never exceeds 2 rounds', async () => {
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      sopText: 'max_rounds: 9',
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({})
    }
  });
  assert.ok(out);
  assert.ok(out.roundsRun <= 2);
});

test('runSalaV2: single contribution → no R2 (1 round)', async () => {
  const order = [];
  const out = await runSalaV2({
    text: PREGUNTA,
    route: { targets: [{ agentId: 'ivan', score: 5, matchedDomains: ['web'] }] },
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({ order })
    }
  });
  assert.ok(out);
  assert.equal(out.roundsRun, 1);
  assert.deepEqual(order, ['ivan']);
});

test('runSalaV2: r2: never → 1 round even with disagreement', async () => {
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      sopText: 'r2: never',
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({})
    }
  });
  assert.ok(out);
  assert.equal(out.roundsRun, 1);
});

test('runSalaV2: all SILENCIO → null (no synthesis)', async () => {
  const telemetria = [];
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({
        bySpeaker: {
          ivan: { text: 'SILENCIO' },
          bruno: { text: 'SILENCIO' },
          camila: { text: 'SILENCIO' }
        }
      }),
      onTelemetry: (ev, data) => telemetria.push([ev, data])
    }
  });
  assert.equal(out, null);
  const last = telemetria[telemetria.length - 1];
  assert.equal(last[0], 'sala_skip');
  assert.equal(last[1].reason, 'all_silence');
});

test('runSalaV2: per-agent timeout → absent, the room goes on and synthesizes', async () => {
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 40,
      timeoutMs: 2000,
      completeChat: fakeSala({
        bySpeaker: { bruno: { slow: 400 } }
      })
    }
  });
  assert.ok(out);
  assert.ok(out.ausentes.includes('bruno'));
  assert.ok(out.note.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.note.includes('DECISIÓN'));
});

test('runSalaV2: one voice fails → absent, does not bring the room down', async () => {
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({
        bySpeaker: { ivan: { throw: true } }
      })
    }
  });
  assert.ok(out);
  assert.ok(out.ausentes.includes('ivan'));
  assert.ok(out.note.includes('DECISIÓN'));
});

test('runSalaV2: prior barge-in → null without calling the model', async () => {
  let llamadas = 0;
  const controller = new AbortController();
  controller.abort();
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      signal: controller.signal,
      completeChat: async () => { llamadas += 1; return { text: 'x' }; }
    }
  });
  assert.equal(out, null);
  assert.equal(llamadas, 0);
});

test('runSalaV2: mid-way barge-in → cuts rounds, partial synthesis', async () => {
  const controller = new AbortController();
  const order = [];
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      signal: controller.signal,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({
        order,
        bySpeaker: { camila: { onCall: () => controller.abort() } }
      })
    }
  });
  assert.ok(out);
  // Only camila spoke (R1 cut short), still a partial synthesis.
  assert.deepEqual(order, ['camila']);
  assert.equal(out.roundsRun, 1);
  assert.ok(out.note.startsWith(TEAM_NOTE_PREFIX));
});

test('runSalaV2: empty/failed synthesis → fallback NOTE with contributions', async () => {
  const out = await runSalaV2({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      sopText: 'r2: never',
      completeChat: fakeSala({ synth: '' })
    }
  });
  assert.ok(out);
  assert.ok(out.note.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.note.includes('fallback'));
  assert.ok(out.note.includes('camila'));
});

test('runSalaV2: negative gate → null without calling the model', async () => {
  let llamadas = 0;
  const out = await runSalaV2({
    text: 'abrí el archivo readme',
    deps: {
      flagV2: true,
      completeChat: async () => { llamadas += 1; return { text: 'x' }; }
    }
  });
  assert.equal(out, null);
  assert.equal(llamadas, 0);
});

// ── maybeConsultSala: v1/v2 branching ────────────────────────────────

test('maybeConsultSala: v2 on → rounds NOTE + synthesis', async () => {
  const out = await maybeConsultSala({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      sopText: 'r2: never',
      completeChat: fakeSala({})
    }
  });
  assert.ok(out.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.includes('DECISIÓN'));
});

test('maybeConsultSala: v2 off + v1 on → v1 behavior intact', async () => {
  const out = await maybeConsultSala({
    text: PREGUNTA,
    deps: {
      flagV2: false,
      flagOn: true,
      timeoutMs: 2000,
      completeChat: async () => ({ text: 'nota v1 clásica', model: 'fake' })
    }
  });
  assert.ok(out.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.includes('nota v1 clásica'));
});

test('maybeConsultSala: v2 on but empty room → null (does not fall back to v1)', async () => {
  const out = await maybeConsultSala({
    text: PREGUNTA,
    route: ROUTE_3,
    deps: {
      flagV2: true,
      flagOn: true,
      agentTimeoutMs: 2000,
      timeoutMs: 2000,
      completeChat: fakeSala({
        bySpeaker: {
          ivan: { text: 'SILENCIO' },
          bruno: { text: 'SILENCIO' },
          camila: { text: 'SILENCIO' }
        }
      })
    }
  });
  assert.equal(out, null);
});

// ── v1 intact ──────────────────────────────────────────────────────────

test('consult v1: unchanged (NOTE + skip flag off)', async () => {
  const ok = await consult({
    text: PREGUNTA,
    deps: {
      flagOn: true,
      timeoutMs: 2000,
      completeChat: async () => ({ text: 'dato iván', model: 'fake' })
    }
  });
  assert.ok(ok.startsWith(TEAM_NOTE_PREFIX));
  const off = await consult({
    text: PREGUNTA,
    deps: { flagOn: false, completeChat: async () => ({ text: 'x' }) }
  });
  assert.equal(off, null);
});

// ── settings sala.v2 ────────────────────────────────────────────────────

test('settings: defaults sala.v2=false, agentTimeoutMs=20000, sop=DEFAULT_SOP', () => {
  assert.equal(getSalaV2(), false);
  assert.equal(getSalaAgentTimeoutMs(), 20000);
  assert.equal(getSalaSop(), DEFAULT_SOP);
});
