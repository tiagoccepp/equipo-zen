// T1 track tests (contextual addressing): primary Jev + Groq fallback + shadow.
// TODO fake: fetch stub, temp key, groq stub. Zero network, zero real keys.
// Run with isolated HOME: HOME=/tmp/fakehome-t1 node --test tests/flujo-addressing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADDRESSING_ACTION,
  appendShadowLog,
  callGroqAddressing,
  callJev,
  classifyAddressing,
  heuristicAddressing
} from '../server/lib/addressing.js';
import { maybeClassifyAddressing } from '../server/lib/turn-pipeline.js';

const FAKE_ZEN = 'fake-zen-key-para-tests';
const FAKE_GROQ = 'fake-groq-key-para-tests';

function tmpKey(content = FAKE_ZEN) {
  const dir = mkdtempSync(join(tmpdir(), 't1-key-'));
  const p = join(dir, 'equipo-zen.key');
  writeFileSync(p, `${content}\n`, 'utf8');
  return p;
}

function tmpShadow() {
  const dir = mkdtempSync(join(tmpdir(), 't1-shadow-'));
  return join(dir, 'shadow', 'addressing.jsonl');
}

// Programmable fetch stub: handlers by URL-substring.
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of Object.entries(routes)) {
      if (String(url).includes(match)) {
        return handler({ url: String(url), init });
      }
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  };
}

// ── Primary Jev ─────────────────────────────────────────────────────────

test('primary jev: decides from TypeSafe and reports jev source', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'habla_con_otro', confidence: 0.9 } } })
  });
  const res = await callJev({ text: 'María, ¿viste el informe?', context: {}, key: FAKE_ZEN, fetchFn });
  assert.equal(res.decision, 'habla_con_otro');
  assert.equal(res.source, 'jev');
  assert.equal(res.confidence, 0.9);
  assert.ok(res.ms >= 0);
  // Real TypeSafe body: model + state + questions.addressing (choice).
  const sent = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sent.model, 'jev-1.13-free');
  assert.ok(JSON.parse(sent.state).transcript.includes('María'));
  assert.equal(sent.questions.addressing.type, 'choice');
  assert.equal(Object.keys(sent.questions.addressing.criteria).length, 4);
});

test('jev: throws without key (fallback catches it)', async () => {
  await assert.rejects(
    callJev({ text: 'hola', keyPath: '/no/existe/zen.key', fetchFn: fakeFetch({}) }),
    /Missing Zen key/
  );
});

test('jev: 429 propagates status so classify falls back to groq', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ error: 'rate limited' }, { ok: false, status: 429 })
  });
  const err = await callJev({ text: 'hola', key: FAKE_ZEN, fetchFn }).catch((e) => e);
  assert.equal(err.status, 429);
});

// ── Groq fallback ────────────────────────────────────────────────────────

test('groq: parses chat JSON and reports groq source', async () => {
  const fetchFn = fakeFetch({
    'api.groq.com': async ({ init }) => {
      const sent = JSON.parse(init.body);
      assert.equal(sent.stream, false);
      assert.equal(sent.messages[0].role, 'system');
      return jsonResponse({ choices: [{ message: { content: '{"decision": "piensa_en_voz_alta", "confidence": 0.62}' } }] });
    }
  });
  const res = await callGroqAddressing({ text: 'a ver, a ver…', context: {}, groqKey: FAKE_GROQ, fetchFn });
  assert.equal(res.decision, 'piensa_en_voz_alta');
  assert.equal(res.source, 'groq');
  assert.equal(res.confidence, 0.62);
});

test('classify live: Jev 429 → falls back to groq', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ error: 'x' }, { ok: false, status: 429 })
  });
  const groqFn = async () => ({ decision: 'me_habla', confidence: 0.8, source: 'groq', ms: 1 });
  const res = await classifyAddressing(
    { text: 'Pablo, ¿me ayudás?', context: { chatActive: true } },
    { mode: 'live', key: FAKE_ZEN, fetchFn, groqFn, keyPath: tmpKey() }
  );
  assert.equal(res.decision, 'me_habla');
  assert.equal(res.source, 'groq');
});

test('classify live: jev OK does not call groq', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'ruido', confidence: 0.88 } } })
  });
  let groqCalls = 0;
  const groqFn = async () => { groqCalls += 1; return { decision: 'me_habla', confidence: 1, source: 'groq', ms: 0 }; };
  const res = await classifyAddressing(
    { text: 'mmm', context: {} },
    { mode: 'live', fetchFn, groqFn, keyPath: tmpKey() }
  );
  assert.equal(res.source, 'jev');
  assert.equal(res.decision, 'ruido');
  assert.equal(groqCalls, 0);
});

// ── Fail-open ────────────────────────────────────────────────────────────

test('classify live: everything fails → fail-open heuristic (responder)', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => { throw new Error('boom'); }
  });
  const groqFn = async () => { throw new Error('boom2'); };
  const res = await classifyAddressing(
    { text: '¿qué hora es?', context: {} },
    { mode: 'live', fetchFn, groqFn, keyPath: tmpKey() }
  );
  assert.equal(res.source, 'heuristica');
  assert.equal(res.decision, 'me_habla'); // legacy = responder
  assert.equal(ADDRESSING_ACTION[res.decision], 'responder');
});

// ── Shadow / off ─────────────────────────────────────────────────────────

test('shadow: logs JSONL and returns legacy even when classifying otherwise', async () => {
  const shadowPath = tmpShadow();
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'habla_con_otro', confidence: 0.9 } } })
  });
  const res = await classifyAddressing(
    { text: 'María, contame', context: { chatActive: false } },
    { mode: 'shadow', fetchFn, keyPath: tmpKey(), shadowPath, awaitShadow: true }
  );
  assert.equal(res.decision, 'me_habla');
  assert.equal(res.source, 'legacy');
  assert.equal(res.shadowed.decision, 'habla_con_otro');
  assert.equal(res.shadowed.source, 'jev');
  const lines = readFileSync(shadowPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.classification.decision, 'habla_con_otro');
  assert.equal(entry.legacy.decision, 'me_habla');
  assert.ok(!JSON.stringify(entry).includes(FAKE_ZEN)); // never keys in the log
});

test('off: total bypass, touches no network and logs nothing', async () => {
  const fetchFn = fakeFetch({});
  const res = await classifyAddressing({ text: 'hola' }, { mode: 'off', fetchFn });
  assert.equal(res.source, 'bypass');
  assert.equal(res.decision, 'me_habla');
  assert.equal(fetchFn.calls.length, 0);
});

test('appendShadowLog creates dirs and appends lines', () => {
  const p = tmpShadow();
  appendShadowLog({ text: 'a', context: {}, classification: { decision: 'ruido' }, legacy: { decision: 'me_habla' } }, p);
  appendShadowLog({ text: 'b', context: {}, classification: { decision: 'ruido' }, legacy: { decision: 'me_habla' } }, p);
  assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 2);
});

// ── Heuristic: TO-vs-ABOUT-Pablo ────────────────────────────────────────

test('heuristic: TO Pablo (2nd person) → me_habla', () => {
  const r = heuristicAddressing({ text: 'Pablo, ¿podés ayudarme con esto?', context: {} });
  assert.equal(r.decision, 'me_habla');
  assert.equal(r.source, 'heuristica');
});

test('heuristic: ABOUT Pablo (3rd person) → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'Pablo dijo que lo revisaba mañana', context: {} });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heuristic: narrated ABOUT Pablo → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'le dije a Pablo que era para hoy', context: {} });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heuristic: lone Pablo + active chat → me_habla (context wins)', () => {
  const r = heuristicAddressing({ text: 'Pablo…', context: { chatActive: true } });
  assert.equal(r.decision, 'me_habla');
});

test('heuristic: lone Pablo without context → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'Pablo…', context: { chatActive: false } });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heuristic: thinking out loud', () => {
  const r = heuristicAddressing({ text: 'a ver, capaz que si muevo esto…', context: {} });
  assert.equal(r.decision, 'piensa_en_voz_alta');
  assert.equal(ADDRESSING_ACTION[r.decision], 'solo-contexto');
});

test('heuristic: short noise', () => {
  const r = heuristicAddressing({ text: 'eh', context: {} });
  assert.equal(r.decision, 'ruido');
  assert.equal(ADDRESSING_ACTION[r.decision], 'ignorar');
});

test('heuristic: empty text → ruido, but never throws', () => {
  const r = heuristicAddressing({ text: '', context: {} });
  assert.equal(r.decision, 'ruido');
});

// ── turn-pipeline hook ───────────────────────────────────────────────────

test('hook: live maps decision → action', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'ruido', confidence: 0.9 } } })
  });
  const res = await maybeClassifyAddressing({
    text: 'eh', context: {},
    deps: { mode: 'live', fetchFn, keyPath: tmpKey() }
  });
  assert.equal(res.decision, 'ruido');
  assert.equal(res.action, 'ignorar');
  assert.equal(res.source, 'jev');
});

test('hook: off returns null (legacy continues)', async () => {
  const res = await maybeClassifyAddressing({ text: 'hola', deps: { mode: 'off' } });
  assert.equal(res, null);
});

test('hook: shadow returns responder (does not affect turns)', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'habla_con_otro', confidence: 0.9 } } })
  });
  const res = await maybeClassifyAddressing({
    text: 'María, vení', context: {},
    deps: { mode: 'shadow', fetchFn, keyPath: tmpKey(), shadowPath: tmpShadow() }
  });
  assert.equal(res.decision, 'me_habla');
  assert.equal(res.action, 'responder');
  assert.equal(res.source, 'legacy');
});

test('shadow: does not wait for the network (fire-and-forget)', async () => {
  // Slow Jev (500ms): shadow still resolves legacy instantly.
  const fetchFn = fakeFetch({
    systemone: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return jsonResponse({ answers: { addressing: { type: 'choice', choice: 'ruido', confidence: 0.5 } } });
    }
  });
  const t0 = Date.now();
  const res = await classifyAddressing(
    { text: 'eh', context: {} },
    { mode: 'shadow', fetchFn, keyPath: tmpKey(), shadowPath: tmpShadow() }
  );
  assert.ok(Date.now() - t0 < 200, 'shadow esperó a la red');
  assert.equal(res.decision, 'me_habla');
  assert.equal(res.shadowed, null);
});

test('hook: never throws even if everything explodes', async () => {
  const res = await maybeClassifyAddressing({
    text: 'hola', context: {},
    deps: { mode: 'live', fetchFn: async () => { throw new Error('red muerta'); }, groqFn: async () => { throw new Error('x'); }, keyPath: tmpKey() }
  });
  // heuristic rescues: returns something valid, not null, no throw
  assert.ok(res && res.action);
});
