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

// Manos v1: two-phase wiring into the live turn. The loader is injectable;
// the real manos.js may not exist yet: these tests program against the
// contract (shouldUseTools/renderManosPrompt/runToolLoop) with fakes.

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

// Happy-path fake: keyword gate, 2-tool loop returning a summary.
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

test('manos: defaults enabled=true and maxTurns=6', () => {
  freshSettings();
  assert.equal(getManosEnabled(), true);
  assert.equal(getManosMaxTurns(), 6);
  assert.deepEqual(publicSettings().manos, { enabled: true, maxTurns: 6 });
});

// ── settings: apply + validation ─────────────────────────────────────

test('manos: applySettings saves valid enabled and maxTurns', () => {
  freshSettings();
  const applied = applySettings({ 'manos.enabled': 'false', 'manos.maxTurns': '10' });
  assert.deepEqual(applied.sort(), ['manos.enabled', 'manos.maxTurns']);
  assert.equal(getManosEnabled(), false);
  assert.equal(getManosMaxTurns(), 10);
  assert.deepEqual(publicSettings().manos, { enabled: false, maxTurns: 10 });
});

test('manos: maxTurns outside 1..12 or non-numeric is ignored', () => {
  freshSettings();
  applySettings({ 'manos.maxTurns': '7' });
  assert.equal(getManosMaxTurns(), 7);
  for (const bad of ['0', '13', '-1', 'hola', '2.5']) {
    const applied = applySettings({ 'manos.maxTurns': bad });
    assert.deepEqual(applied, [], `debió ignorar maxTurns=${bad}`);
    assert.equal(getManosMaxTurns(), 7);
  }
});

test('manos: enabled with a weird value is ignored, empty returns to default', () => {
  freshSettings();
  applySettings({ 'manos.enabled': 'false' });
  assert.equal(getManosEnabled(), false);
  assert.deepEqual(applySettings({ 'manos.enabled': 'quizás' }), []);
  assert.equal(getManosEnabled(), false);
  applySettings({ 'manos.enabled': '' });
  assert.equal(getManosEnabled(), true);
});

// ── tools phase: happy path ──────────────────────────────────────────

test('manos: gate true runs the loop and injects the summary into user', async () => {
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
    // [AVANCE]-style notice over the existing channel, with identity.
    assert.equal(emitted[0].type, 'agent_progress');
    assert.equal(emitted[0].text, 'Using tools…');
    assert.equal(emitted[0].turnId, 'turn-1');
    assert.equal(emitted[0].agentId, 'ana');
    // The loop emits over the same channel and the wrapper adds identity.
    const call = emitted.find((m) => m.type === 'agent_tool_call');
    assert.equal(call.turnId, 'turn-1');
    assert.equal(call.agentId, 'ana');
  } finally {
    setManosLoader(null);
  }
});

test('manos: the loop receives maxTurns/deadline/source/messages/system', async () => {
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
    // The loop system carries the Manos section; messages use chat format.
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

test('manos: voice deadline is 45s, text is 120s', async () => {
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

// ── tools phase: fallbacks identical to today ─────────────────────────────

test('manos: disabled touches neither loader nor user nor emits', async () => {
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

test('manos: gate false leaves the turn EXACTLY as today', async () => {
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

test('manos: crashed loader (missing manos.js) changes nothing', async () => {
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

test('manos: throwing loop degrades to fallback without breaking the turn', async () => {
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

test('manos: empty summary runs but does not inject marker', async () => {
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

test('manos: aborted turn skips the phase without loading anything', async () => {
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

test('manos: default loader degrades gracefully (holds with or without manos.js)', async () => {
  // Today manos.js does not exist → import fails → fallback. Once the parallel
  // module lands, neutral text will not trigger the gate → same fallback.
  freshSettings();
  setManosLoader(null);
  const { args } = baseArgs({ turn: { text: 'hola, ¿cómo están?' } });
  const phase = await maybeRunToolsPhase(args);
  assert.equal(phase.ran, false);
  assert.equal(phase.userContent, 'USER-TURN');
});
