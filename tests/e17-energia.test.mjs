// E-17: energía + Jev — wake word, modos, autostart (HOME falso).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jevGate, stripWakeWord } from '../server/lib/jev.js';
import { applyEnergyMode, autostartFile, energyModeFromEnv, readAutostartMode } from '../server/lib/energy.js';

const FAKEHOME = mkdtempSync(path.join(os.tmpdir(), 'e17-home-'));

test('e17: Jev despierta con Pablo (prefijos y mención corta)', () => {
  assert.deepEqual(jevGate('Pablo, hacé la home'), { wake: true, command: 'hace la home' });
  assert.deepEqual(jevGate('che pablo qué hora es'), { wake: true, command: 'che que hora es' });
  assert.deepEqual(jevGate('ok pablo'), { wake: true, command: 'ok' });
  assert.deepEqual(jevGate('Pablo'), { wake: true, command: '' });
  assert.equal(stripWakeWord('Pablo contame'), 'contame');
});

test('e17: Jev ignora sin wake y menciones tardías', () => {
  assert.deepEqual(jevGate('hacé la home'), { wake: false, command: '' });
  assert.deepEqual(jevGate(''), { wake: false, command: '' });
  assert.deepEqual(
    jevGate('ayer hablé con juan sobre el diseño que le mostré a pablo en la reunión larga'),
    { wake: false, command: '' },
    'hablando DE Pablo ≠ CON Pablo'
  );
  assert.deepEqual(jevGate('decile a pablo que venga'), { wake: true, command: 'decile a que venga' }, 'corta sí');
});

test('e17: env gana; autostart se instala/saca por modo', () => {
  process.env.EQUIPO_ENERGY_MODE = 'gate';
  assert.equal(energyModeFromEnv(), 'gate');
  process.env.EQUIPO_ENERGY_MODE = 'invento';
  assert.equal(energyModeFromEnv(), null);
  delete process.env.EQUIPO_ENERGY_MODE;

  const r1 = applyEnergyMode('always-on', { home: FAKEHOME });
  assert.equal(r1.autostart, true);
  assert.ok(existsSync(autostartFile(FAKEHOME)));
  assert.ok(readFileSync(autostartFile(FAKEHOME), 'utf8').includes('EQUIPO_ENERGY_MODE=always-on'));
  assert.deepEqual(readAutostartMode({ home: FAKEHOME }), { installed: true, mode: 'always-on' });

  applyEnergyMode('gate', { home: FAKEHOME });
  assert.ok(readFileSync(autostartFile(FAKEHOME), 'utf8').includes('EQUIPO_ENERGY_MODE=gate'));

  const r2 = applyEnergyMode('manual', { home: FAKEHOME });
  assert.equal(r2.autostart, false);
  assert.ok(!existsSync(autostartFile(FAKEHOME)), 'manual saca autostart');
  assert.deepEqual(readAutostartMode({ home: FAKEHOME }).installed, false);
});
