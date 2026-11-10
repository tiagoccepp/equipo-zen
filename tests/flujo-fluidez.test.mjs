// TF fluidez voz (09/11): pipeline synth/emit con prefetch + persona de
// llamada realtime + estilo-hablado solo en llamada. Todo con fakes
// temporizados: cero red, cero TTS real, cero LLM.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  LiveAgentRuntime,
  SPEECH_PREFETCH_DEFAULT,
  buildSystemInstruction,
  createSpeechPipeline
} from '../server/lib/agent-runtime.js';
import { initSettings } from '../server/lib/settings.js';

// Store stub mutable (cada archivo de test corre en su propio proceso).
const db = new Map();
initSettings(
  {
    getSetting: (k) => (db.has(k) ? db.get(k) : null),
    setSetting: (k, v) => { db.set(k, v); },
    deleteSetting: (k) => { db.delete(k); },
    logChange: () => {}
  },
  { setKeys: () => {} }
);
afterEach(() => { db.clear(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AGENTE = {
  id: 't', name: 'Pablo', title: 'Personal assistant', role: 'worker',
  domains: ['general'], style: 'Directo y cálido.', tasks: []
};

// ── 1. Referencia legacy: la cadena secuencial mete un bache = synth ─────
// Réplica fiel del audioRunner anterior (N+1 espera synth+emit de N): es el
// "antes" contra el que se mide el pipeline. Fakes: synth 120ms, emit 80ms.
async function runLegacySequential(n, synthMs, emitMs) {
  const starts = [];
  const ends = [];
  let runner = Promise.resolve();
  const t0 = Date.now();
  for (let i = 0; i < n; i += 1) {
    runner = runner.then(async () => {
      await sleep(synthMs);
      starts.push(Date.now() - t0);
      await sleep(emitMs);
      ends.push(Date.now() - t0);
    });
  }
  await runner;
  return { starts, ends, total: Date.now() - t0 };
}

test('fluidez legacy: el bache entre oraciones es la síntesis completa', async () => {
  const { starts, ends, total } = await runLegacySequential(4, 120, 80);
  const gaps = starts.slice(1).map((s, i) => s - ends[i]);
  for (const g of gaps) {
    assert.ok(g >= 105 && g <= 200, `bache legacy ${g}ms ≈ synth 120ms`);
  }
  assert.ok(total >= 780, `total legacy ${total}ms ≈ 4×(120+80)`);
});

// ── 2. Pipeline: N+1 sintetiza mientras N se emite ───────────────────────

test('fluidez pipeline: TTS rápido → gap ≈ 0 y síntesis solapada', async () => {
  const starts = [];
  const ends = [];
  const t0 = Date.now();
  const pipe = createSpeechPipeline({
    synth: async (s) => { await sleep(60); return { s }; },
    emitPrepared: async () => {
      starts.push(Date.now() - t0);
      await sleep(100);
      ends.push(Date.now() - t0);
    },
    prefetch: SPEECH_PREFETCH_DEFAULT
  });
  for (const s of ['una. ', 'dos. ', 'tres. ', 'cuatro. ']) pipe.enqueue(s);
  await pipe.done();
  const gaps = starts.slice(1).map((s, i) => s - ends[i]);
  for (const g of gaps) {
    assert.ok(g < 40, `gap pipeline ${g}ms < 40ms (legacy: 60ms)`);
  }
  const st = pipe.stats();
  assert.equal(st.enqueued, 4);
  assert.equal(st.emitted, 4);
  assert.equal(st.synthPeak, 2, `pico síntesis ${st.synthPeak} = prefetch+1`);
});

test('fluidez pipeline: TTS lento → gap = synth − emit (mejor que legacy)', async () => {
  const starts = [];
  const ends = [];
  const t0 = Date.now();
  const pipe = createSpeechPipeline({
    synth: async (s) => { await sleep(120); return { s }; },
    emitPrepared: async () => {
      starts.push(Date.now() - t0);
      await sleep(80);
      ends.push(Date.now() - t0);
    },
    prefetch: 1
  });
  for (let i = 0; i < 4; i += 1) pipe.enqueue(`oración ${i}. `);
  await pipe.done();
  const gaps = starts.slice(1).map((s, i) => s - ends[i]);
  for (const g of gaps) {
    assert.ok(g < 100, `gap ${g}ms < synth 120ms del legacy`);
  }
  const total = Date.now() - t0;
  assert.ok(total < 700, `total pipeline ${total}ms < legacy 800ms`);
});

test('fluidez pipeline: orden de emisión aunque una síntesis gane', async () => {
  const order = [];
  // La 2ª sintetiza rapidísimo: sin orden estricto saldría primera.
  const delays = [80, 10, 50];
  const pipe = createSpeechPipeline({
    synth: async (s) => { await sleep(delays[Number(s)]); return { s }; },
    emitPrepared: async (p) => { order.push(p.s); }
  });
  pipe.enqueue('0');
  pipe.enqueue('1');
  pipe.enqueue('2');
  await pipe.done();
  assert.deepEqual(order, ['0', '1', '2']);
  assert.equal(pipe.stats().emitted, 3);
});

test('fluidez pipeline: abort cancela prefetch y pendientes, done resuelve', async () => {
  const ctrl = new AbortController();
  const emitted = [];
  const pipe = createSpeechPipeline({
    synth: async (s) => { await sleep(60); return { s }; },
    emitPrepared: async (p) => {
      await sleep(80);
      emitted.push(p.s);
    },
    signal: ctrl.signal,
    prefetch: 1
  });
  for (let i = 0; i < 6; i += 1) pipe.enqueue(`o${i}`);
  await sleep(100); // 1ª emitida, 2ª/3ª sintetizando → cortar (barge-in).
  ctrl.abort();
  await pipe.done();
  assert.ok(emitted.length <= 2, `tras abortar salieron ${emitted.length} (≤2)`);
  const st = pipe.stats();
  assert.ok(st.synthPeak <= 2, `pico ${st.synthPeak} ≤ prefetch+1`);
});

test('fluidez pipeline: synth caído saltea la oración sin romper el turno', async () => {
  const order = [];
  const pipe = createSpeechPipeline({
    synth: async (s) => {
      await sleep(10);
      if (s === '1') throw new Error('tts caído');
      return { s };
    },
    emitPrepared: async (p) => { order.push(p.s); }
  });
  pipe.enqueue('0');
  pipe.enqueue('1');
  pipe.enqueue('2');
  await pipe.done();
  assert.deepEqual(order, ['0', '2']);
});

// ── 3. Persona de llamada (bilingüe, gateada por voice) ──────────────────

test('fluidez persona: en llamada ES manda oído + manejo humano', () => {
  db.set('tts.language', 'es');
  const sys = buildSystemInstruction(AGENTE, { voice: true });
  assert.ok(sys.includes('§VOICE'), 'bloque voz');
  assert.ok(sys.includes('LLAMADA DE VOZ'), 'consciente de la llamada');
  assert.ok(sys.includes('SOLO se escuchan'), 'respuestas solo escuchadas');
  assert.ok(sys.includes('una idea por turno'), 'una idea por turno');
  assert.ok(sys.includes('Cero markdown'), 'cero markdown/listas/código');
  assert.ok(sys.includes('deletrean'), 'siglas deletreadas para oído');
  assert.ok(sys.includes('como modelo de IA'), 'prohíbe presentarse como IA');
  assert.ok(sys.includes('cedé la palabra'), 'manejo humano: ceder la palabra');
  // Protocolo load-bearing sobrevive en llamada.
  for (const keep of ['[PIENSO]', '[AVANCE]', 'SILENCIO', '[TAREA_CREAR']) {
    assert.ok(sys.includes(keep), `protocolo sobrevive: ${keep}`);
  }
});

test('fluidez persona: en llamada EN todo el bloque queda en inglés', () => {
  db.set('tts.language', 'en');
  const sys = buildSystemInstruction(AGENTE, { voice: true });
  assert.ok(sys.includes('LIVE VOICE CALL'), 'llamada en inglés');
  assert.ok(sys.includes('ONLY heard'), 'solo escuchadas');
  assert.ok(sys.includes('spelled out'), 'siglas deletreadas');
  assert.ok(sys.includes('as an AI model'), 'prohíbe presentarse como IA');
  assert.ok(sys.includes('yield the floor'), 'ceder la palabra');
  assert.ok(!sys.includes('LLAMADA DE VOZ'), 'sin español contaminando');
  assert.ok(sys.includes('SILENCIO'), 'protocolo silencio intacto');
});

test('fluidez persona: fuera de llamada el estilo-hablado NO rige', () => {
  db.set('tts.language', 'es');
  const sys = buildSystemInstruction(AGENTE, { voice: false });
  assert.ok(sys.includes('§CHAT'), 'bloque chat');
  assert.ok(!sys.includes('LLAMADA DE VOZ'), 'sin persona de llamada');
  assert.ok(!sys.includes('Texto normal = HABLADO'), 'sin estilo-hablado');
  assert.ok(!sys.includes('Plain text = SPOKEN'), 'sin estilo-hablado EN');
  assert.ok(sys.includes('con formato cuando ayude'), 'chat normal con formato');
  // Protocolo load-bearing sobrevive también en chat.
  for (const keep of ['[PIENSO]', '[AVANCE]', 'SILENCIO', '[TAREA_CREAR']) {
    assert.ok(sys.includes(keep), `protocolo sobrevive: ${keep}`);
  }
});

test('fluidez persona: legacy sin voice queda byte-idéntico', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  assert.ok(sys.includes('§VOICE'), 'bloque voz único');
  assert.ok(!sys.includes('LLAMADA DE VOZ'), 'sin refuerzo de llamada');
  assert.ok(!sys.includes('§CHAT'), 'sin bloque chat');
});

test('fluidez turno: MODO VOZ en llamada aunque entre por texto', () => {
  const memoria = { recentContext: () => '' };
  const keys = { hasKeys: () => true };
  const mkTurn = (source) => ({
    text: 'hola', source, isContextualFollowup: false,
    target: {}, priorResponses: [], route: { reason: 'test', greeting: false }
  });
  const enLlamada = new LiveAgentRuntime(AGENTE, keys, memoria, { voiceEnabled: true });
  assert.ok(enLlamada.buildTurnPrompt(mkTurn('text')).includes('§VOICE'), 'llamada+texto → MODO VOZ');
  assert.ok(enLlamada.buildTurnPrompt(mkTurn('audio')).includes('§VOICE'), 'llamada+audio → MODO VOZ');
  const enChat = new LiveAgentRuntime(AGENTE, keys, memoria, { voiceEnabled: false });
  assert.ok(!enChat.buildTurnPrompt(mkTurn('text')).includes('MODO VOZ'), 'chat+texto → sin MODO VOZ');
  assert.ok(!enChat.buildTurnPrompt(mkTurn('text')).includes('VOICE MODE'), 'chat+texto → sin VOICE MODE');
  const legacy = new LiveAgentRuntime(AGENTE, keys, memoria, null);
  assert.ok(legacy.buildTurnPrompt(mkTurn('audio')).includes('§VOICE'), 'legacy audio → MODO VOZ');
  assert.ok(!legacy.buildTurnPrompt(mkTurn('text')).includes('MODO VOZ'), 'legacy texto → sin MODO VOZ');
});
