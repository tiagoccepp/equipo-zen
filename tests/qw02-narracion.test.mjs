// QW-02: protocolo de narración en 3 momentos (CC #2).
// Momento 1 (preámbulo con ACCIÓN) vive en emitLine; acá se verifica que los
// momentos 2 (updates al hallar/trabarse/cambiar rumbo) y 3 (cierre qué
// cambió + qué sigue) estén presentes en llamada/chat/legacy, ES y EN.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemInstruction } from '../server/lib/agent-runtime.js';
import { initSettings } from '../server/lib/settings.js';

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

const AGENTE = {
  id: 't', name: 'Pablo', title: 'Personal assistant', role: 'worker',
  domains: ['general'], style: 'Directo y cálido.', tasks: []
};

test('qw02: momentos 2+3 presentes en llamada ES', () => {
  db.set('tts.language', 'es');
  const sys = buildSystemInstruction(AGENTE, { voice: true });
  assert.ok(sys.includes('cambiás de rumbo o te trabás'), 'momento 2: updates');
  assert.ok(sys.includes('El silencio largo es un bug'), 'momento 2: silencio = bug');
  assert.ok(sys.includes('qué cambió y qué sigue'), 'momento 3: cierre');
  assert.ok(sys.includes('decilo en voz alta y ofrecé reintentar'), 'momento 3: fallo hablado');
});

test('qw02: momentos 2+3 presentes en chat ES', () => {
  db.set('tts.language', 'es');
  const sys = buildSystemInstruction(AGENTE, { voice: false });
  assert.ok(sys.includes('El silencio largo es un bug'), 'momento 2 en chat');
  assert.ok(sys.includes('qué cambió y qué sigue'), 'momento 3 en chat');
});

test('qw02: momentos 2+3 presentes en legacy sin voice', () => {
  db.set('tts.language', 'es');
  const sys = buildSystemInstruction(AGENTE, {});
  assert.ok(sys.includes('El silencio largo es un bug'), 'momento 2 en legacy');
  assert.ok(sys.includes('qué cambió y qué sigue'), 'momento 3 en legacy');
});

test('qw02: momentos 2+3 en inglés sin español contaminando', () => {
  db.set('tts.language', 'en');
  const sys = buildSystemInstruction(AGENTE, { voice: true });
  assert.ok(sys.includes('Long silence is a bug'), 'momento 2 EN');
  assert.ok(sys.includes('what changed and what comes next'), 'momento 3 EN');
  assert.ok(!sys.includes('El silencio largo es un bug'), 'sin español');
  assert.ok(!sys.includes('qué cambió y qué sigue'), 'sin español');
});
