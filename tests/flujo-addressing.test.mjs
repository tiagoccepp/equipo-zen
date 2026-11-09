// Tests track T1 (addressing contextual): Jev primario + Groq fallback + shadow.
// TODO fake: fetch stub, key temporal, groq stub. Cero red, cero keys reales.
// Correr con HOME aislado: HOME=/tmp/fakehome-t1 node --test tests/flujo-addressing.test.mjs
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

// fetch stub programable: handlers por URL-substring.
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

// ── Jev primario ─────────────────────────────────────────────────────────

test('jev primario: decide desde TypeSafe y reporta source jev', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ answers: { addressing: { type: 'choice', choice: 'habla_con_otro', confidence: 0.9 } } })
  });
  const res = await callJev({ text: 'María, ¿viste el informe?', context: {}, key: FAKE_ZEN, fetchFn });
  assert.equal(res.decision, 'habla_con_otro');
  assert.equal(res.source, 'jev');
  assert.equal(res.confidence, 0.9);
  assert.ok(res.ms >= 0);
  // Body TypeSafe real: model + state + questions.addressing (choice).
  const sent = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sent.model, 'jev-1.13-free');
  assert.ok(JSON.parse(sent.state).transcript.includes('María'));
  assert.equal(sent.questions.addressing.type, 'choice');
  assert.equal(Object.keys(sent.questions.addressing.criteria).length, 4);
});

test('jev: sin key lanza (el fallback lo atrapa)', async () => {
  await assert.rejects(
    callJev({ text: 'hola', keyPath: '/no/existe/zen.key', fetchFn: fakeFetch({}) }),
    /Missing Zen key/
  );
});

test('jev: 429 propaga status para que classify caiga a groq', async () => {
  const fetchFn = fakeFetch({
    systemone: async () => jsonResponse({ error: 'rate limited' }, { ok: false, status: 429 })
  });
  const err = await callJev({ text: 'hola', key: FAKE_ZEN, fetchFn }).catch((e) => e);
  assert.equal(err.status, 429);
});

// ── Groq fallback ────────────────────────────────────────────────────────

test('groq: parsea JSON del chat y reporta source groq', async () => {
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

test('classify live: 429 de Jev → cae a groq', async () => {
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

test('classify live: jev OK no llama a groq', async () => {
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

test('classify live: todo falla → heurística fail-open (responder)', async () => {
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

test('shadow: loguea JSONL y devuelve legacy aunque clasifique otra cosa', async () => {
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
  assert.ok(!JSON.stringify(entry).includes(FAKE_ZEN)); // nunca keys en el log
});

test('off: bypass total, no toca red ni loguea', async () => {
  const fetchFn = fakeFetch({});
  const res = await classifyAddressing({ text: 'hola' }, { mode: 'off', fetchFn });
  assert.equal(res.source, 'bypass');
  assert.equal(res.decision, 'me_habla');
  assert.equal(fetchFn.calls.length, 0);
});

test('appendShadowLog crea dirs y agrega líneas', () => {
  const p = tmpShadow();
  appendShadowLog({ text: 'a', context: {}, classification: { decision: 'ruido' }, legacy: { decision: 'me_habla' } }, p);
  appendShadowLog({ text: 'b', context: {}, classification: { decision: 'ruido' }, legacy: { decision: 'me_habla' } }, p);
  assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 2);
});

// ── Heurística: TO-vs-ABOUT-Pablo ────────────────────────────────────────

test('heurística: TO Pablo (2da persona) → me_habla', () => {
  const r = heuristicAddressing({ text: 'Pablo, ¿podés ayudarme con esto?', context: {} });
  assert.equal(r.decision, 'me_habla');
  assert.equal(r.source, 'heuristica');
});

test('heurística: ABOUT Pablo (3ra persona) → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'Pablo dijo que lo revisaba mañana', context: {} });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heurística: ABOUT Pablo narrado → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'le dije a Pablo que era para hoy', context: {} });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heurística: Pablo solo + chat activo → me_habla (contexto manda)', () => {
  const r = heuristicAddressing({ text: 'Pablo…', context: { chatActive: true } });
  assert.equal(r.decision, 'me_habla');
});

test('heurística: Pablo solo sin contexto → habla_con_otro', () => {
  const r = heuristicAddressing({ text: 'Pablo…', context: { chatActive: false } });
  assert.equal(r.decision, 'habla_con_otro');
});

test('heurística: piensa en voz alta', () => {
  const r = heuristicAddressing({ text: 'a ver, capaz que si muevo esto…', context: {} });
  assert.equal(r.decision, 'piensa_en_voz_alta');
  assert.equal(ADDRESSING_ACTION[r.decision], 'solo-contexto');
});

test('heurística: ruido corto', () => {
  const r = heuristicAddressing({ text: 'eh', context: {} });
  assert.equal(r.decision, 'ruido');
  assert.equal(ADDRESSING_ACTION[r.decision], 'ignorar');
});

test('heurística: texto vacío → ruido, pero nunca lanza', () => {
  const r = heuristicAddressing({ text: '', context: {} });
  assert.equal(r.decision, 'ruido');
});

// ── Hook turn-pipeline ───────────────────────────────────────────────────

test('hook: live mapea decision → action', async () => {
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

test('hook: off devuelve null (sigue legacy)', async () => {
  const res = await maybeClassifyAddressing({ text: 'hola', deps: { mode: 'off' } });
  assert.equal(res, null);
});

test('hook: sombra devuelve responder (no afecta turnos)', async () => {
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

test('shadow: no espera a la red (fire-and-forget)', async () => {
  // Jev lento (500ms): shadow igual resuelve legacy al instante.
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

test('hook: nunca lanza aunque explote todo', async () => {
  const res = await maybeClassifyAddressing({
    text: 'hola', context: {},
    deps: { mode: 'live', fetchFn: async () => { throw new Error('red muerta'); }, groqFn: async () => { throw new Error('x'); }, keyPath: tmpKey() }
  });
  // heurística rescata: responde algo válido, no null, no throw
  assert.ok(res && res.action);
});
