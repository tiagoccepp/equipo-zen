import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../server/lib/store.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import {
  applySettings,
  getManosEnabled,
  getManosMaxTurns,
  initSettings,
  publicSettings
} from '../server/lib/settings.js';
import {
  MANOS_TEXT_DEADLINE_MS,
  MANOS_TOOLS_MARKER,
  MANOS_VOICE_DEADLINE_MS,
  maybeRunToolsPhase,
  setManosLoader
} from '../server/lib/agent-runtime.js';

// Manos v1: cableado two-phase al turno en vivo. El loader es inyectable;
// manos.js real puede no existir todavía: estos tests programan contra el
// contrato (shouldUseTools/renderManosPrompt/runToolLoop) con fakes.

function freshSettings() {
  const store = new Store(':memory:');
  initSettings(store, new ApiKeyRing([]));
  return store;
}

function baseArgs(overrides = {}) {
  const emitted = [];
  return {
    args: {
      turn: { text: 'leé el archivo package.json' },
      system: 'SYSTEM-BASE',
      userContent: 'USER-TURN',
      keyRing: {},
      emit: (message) => emitted.push(message),
      source: 'text',
      turnId: 'turn-1',
      agentId: 'ana',
      signal: undefined,
      ...overrides
    },
    emitted
  };
}

// Fake ok: gate por palabra clave, loop de 2 tools que devuelve resumen.
function fakeManosOk(captured) {
  return {
    shouldUseTools: (text) => /leé|lee|corré|corre|buscá|busca/i.test(String(text || '')),
    renderManosPrompt: () => '## MANOS-FORMATO',
    runToolLoop: async (params) => {
      captured.params = params;
      params.emit({ type: 'agent_tool_call', tool: 'read_file', summary: 'read_file package.json' });
      params.emit({ type: 'agent_tool_done', tool: 'read_file', ok: true, summary: 'ok' });
      return { toolSummary: 'package.json: nombre equipo, 3 deps', toolTurns: 2 };
    }
  };
}

// ── settings: defaults ───────────────────────────────────────────────

test('manos: defaults enabled=true y maxTurns=6', () => {
  freshSettings();
  assert.equal(getManosEnabled(), true);
  assert.equal(getManosMaxTurns(), 6);
  assert.deepEqual(publicSettings().manos, { enabled: true, maxTurns: 6 });
});

// ── settings: apply + validación ─────────────────────────────────────

test('manos: applySettings guarda enabled y maxTurns válidos', () => {
  freshSettings();
  const applied = applySettings({ 'manos.enabled': 'false', 'manos.maxTurns': '10' });
  assert.deepEqual(applied.sort(), ['manos.enabled', 'manos.maxTurns']);
  assert.equal(getManosEnabled(), false);
  assert.equal(getManosMaxTurns(), 10);
  assert.deepEqual(publicSettings().manos, { enabled: false, maxTurns: 10 });
});

test('manos: maxTurns fuera de 1..12 o no numérico se ignora', () => {
  freshSettings();
  applySettings({ 'manos.maxTurns': '7' });
  assert.equal(getManosMaxTurns(), 7);
  for (const bad of ['0', '13', '-1', 'hola', '2.5']) {
    const applied = applySettings({ 'manos.maxTurns': bad });
    assert.deepEqual(applied, [], `debió ignorar maxTurns=${bad}`);
    assert.equal(getManosMaxTurns(), 7);
  }
});

test('manos: enabled con valor raro se ignora, vacío vuelve al default', () => {
  freshSettings();
  applySettings({ 'manos.enabled': 'false' });
  assert.equal(getManosEnabled(), false);
  assert.deepEqual(applySettings({ 'manos.enabled': 'quizás' }), []);
  assert.equal(getManosEnabled(), false);
  applySettings({ 'manos.enabled': '' });
  assert.equal(getManosEnabled(), true);
});

// ── fase tools: camino feliz ──────────────────────────────────────────

test('manos: gate true corre el loop e inyecta el resumen al user', async () => {
  freshSettings();
  const captured = {};
  setManosLoader(async () => fakeManosOk(captured));
  try {
    const { args, emitted } = baseArgs();
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, true);
    assert.equal(phase.toolSummary, 'package.json: nombre equipo, 3 deps');
    assert.equal(phase.toolTurns, 2);
    assert.equal(phase.userContent, `USER-TURN\n\n${MANOS_TOOLS_MARKER}\npackage.json: nombre equipo, 3 deps`);
    // Aviso [AVANCE]-style por el canal existente, con identidad.
    assert.equal(emitted[0].type, 'agent_progress');
    assert.equal(emitted[0].text, 'Using tools…');
    assert.equal(emitted[0].turnId, 'turn-1');
    assert.equal(emitted[0].agentId, 'ana');
    // El loop emite por el mismo canal y el wrapper le pone identidad.
    const call = emitted.find((m) => m.type === 'agent_tool_call');
    assert.equal(call.turnId, 'turn-1');
    assert.equal(call.agentId, 'ana');
  } finally {
    setManosLoader(null);
  }
});

test('manos: el loop recibe maxTurns/deadline/source/messages/system', async () => {
  freshSettings();
  applySettings({ 'manos.maxTurns': '3' });
  const captured = {};
  setManosLoader(async () => fakeManosOk(captured));
  try {
    const { args } = baseArgs({ source: 'text' });
    await maybeRunToolsPhase(args);
    assert.equal(captured.params.maxTurns, 3);
    assert.equal(captured.params.deadlineMs, MANOS_TEXT_DEADLINE_MS);
    assert.equal(captured.params.source, 'text');
    assert.equal(typeof captured.params.completeChat, 'function');
    assert.equal(typeof captured.params.emit, 'function');
    // El system del loop trae la sección Manos; los messages son formato chat.
    assert.match(captured.params.system, /SYSTEM-BASE/);
    assert.match(captured.params.system, /MANOS-FORMATO/);
    assert.equal(captured.params.messages.length, 2);
    assert.equal(captured.params.messages[0].role, 'system');
    assert.equal(captured.params.messages[1].role, 'user');
    assert.equal(captured.params.messages[1].content, 'USER-TURN');
  } finally {
    setManosLoader(null);
  }
});

test('manos: en voz la deadline es 45s, en texto 120s', async () => {
  freshSettings();
  assert.equal(MANOS_VOICE_DEADLINE_MS, 45000);
  assert.equal(MANOS_TEXT_DEADLINE_MS, 120000);
  const capturedVoice = {};
  setManosLoader(async () => fakeManosOk(capturedVoice));
  try {
    await maybeRunToolsPhase(baseArgs({ source: 'audio' }).args);
    assert.equal(capturedVoice.params.deadlineMs, 45000);
  } finally {
    setManosLoader(null);
  }
  const capturedText = {};
  setManosLoader(async () => fakeManosOk(capturedText));
  try {
    await maybeRunToolsPhase(baseArgs({ source: 'text' }).args);
    assert.equal(capturedText.params.deadlineMs, 120000);
  } finally {
    setManosLoader(null);
  }
});

// ── fase tools: fallbacks idénticos a hoy ─────────────────────────────

test('manos: deshabilitado no toca el loader ni el user ni emite', async () => {
  freshSettings();
  applySettings({ 'manos.enabled': 'false' });
  let loaderCalls = 0;
  setManosLoader(async () => {
    loaderCalls += 1;
    throw new Error('no debió cargarse');
  });
  try {
    const { args, emitted } = baseArgs();
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, false);
    assert.equal(phase.userContent, 'USER-TURN');
    assert.equal(phase.toolSummary, '');
    assert.equal(loaderCalls, 0);
    assert.deepEqual(emitted, []);
  } finally {
    setManosLoader(null);
  }
});

test('manos: gate false deja el turno EXACTO como hoy', async () => {
  freshSettings();
  let loopCalls = 0;
  setManosLoader(async () => ({
    shouldUseTools: () => false,
    renderManosPrompt: () => '## MANOS-FORMATO',
    runToolLoop: async () => {
      loopCalls += 1;
      return { toolSummary: 'no debió correr', toolTurns: 9 };
    }
  }));
  try {
    const { args, emitted } = baseArgs({ turn: { text: 'hola, ¿cómo están?' } });
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, false);
    assert.equal(phase.userContent, 'USER-TURN');
    assert.equal(loopCalls, 0);
    assert.deepEqual(emitted, []);
  } finally {
    setManosLoader(null);
  }
});

test('manos: loader caído (manos.js ausente) no cambia nada', async () => {
  freshSettings();
  setManosLoader(async () => {
    throw new Error('Cannot find module ./manos.js');
  });
  try {
    const { args, emitted } = baseArgs();
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, false);
    assert.equal(phase.userContent, 'USER-TURN');
    assert.deepEqual(emitted, []);
  } finally {
    setManosLoader(null);
  }
});

test('manos: loop que lanza degrada a fallback sin romper el turno', async () => {
  freshSettings();
  setManosLoader(async () => ({
    shouldUseTools: () => true,
    renderManosPrompt: () => '## MANOS-FORMATO',
    runToolLoop: async () => {
      throw new Error('boom en el loop');
    }
  }));
  try {
    const { args } = baseArgs();
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, false);
    assert.equal(phase.userContent, 'USER-TURN');
  } finally {
    setManosLoader(null);
  }
});

test('manos: resumen vacío corre pero no inyecta marker', async () => {
  freshSettings();
  setManosLoader(async () => ({
    shouldUseTools: () => true,
    renderManosPrompt: () => '## MANOS-FORMATO',
    runToolLoop: async () => ({ toolSummary: '', toolTurns: 1 })
  }));
  try {
    const { args } = baseArgs();
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, true);
    assert.equal(phase.toolTurns, 1);
    assert.equal(phase.userContent, 'USER-TURN');
  } finally {
    setManosLoader(null);
  }
});

test('manos: turno abortado salta la fase sin cargar nada', async () => {
  freshSettings();
  let loaderCalls = 0;
  setManosLoader(async () => {
    loaderCalls += 1;
    return fakeManosOk({});
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const { args } = baseArgs({ signal: controller.signal });
    const phase = await maybeRunToolsPhase(args);
    assert.equal(phase.ran, false);
    assert.equal(phase.userContent, 'USER-TURN');
    assert.equal(loaderCalls, 0);
  } finally {
    setManosLoader(null);
  }
});

test('manos: loader default degrada elegante (vale con o sin manos.js)', async () => {
  // Hoy manos.js no existe → import falla → fallback. Cuando el módulo
  // paralelo aterrice, un texto neutro no dispara el gate → mismo fallback.
  freshSettings();
  setManosLoader(null);
  const { args } = baseArgs({ turn: { text: 'hola, ¿cómo están?' } });
  const phase = await maybeRunToolsPhase(args);
  assert.equal(phase.ran, false);
  assert.equal(phase.userContent, 'USER-TURN');
});
