// E-25: multiplataforma — shell/spawn/autostart por OS + auditoría estática.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellFor } from '../server/lib/herramientas.js';
import { applyEnergyMode } from '../server/lib/energy.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('e25: shellFor por plataforma', () => {
  const [winBin, winArgs] = shellFor('win32', 'echo hi');
  assert.ok(winBin.toLowerCase().includes('cmd'), winBin);
  assert.deepEqual(winArgs.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(winArgs[3], 'echo hi');
  assert.deepEqual(shellFor('linux', 'x'), ['/bin/sh', ['-c', 'x']]);
  assert.deepEqual(shellFor('darwin', 'x'), ['/bin/sh', ['-c', 'x']]);
});

test('e25: autostart por OS (dirs falsos)', () => {
  for (const plat of ['linux', 'win32', 'darwin']) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'e25-home-'));
    const r = applyEnergyMode('always-on', { home, platform: plat });
    assert.equal(r.autostart, true, plat);
    assert.ok(existsSync(r.file), r.file);
    const content = readFileSync(r.file, 'utf8');
    assert.ok(content.includes('always-on'), `${plat} lleva modo`);
    if (plat === 'win32') {
      assert.ok(r.file.endsWith('.bat') && content.includes('EQUIPO_ENERGY_MODE='), 'bat windows');
    }
    if (plat === 'darwin') {
      assert.ok(r.file.endsWith('.plist') && content.includes('RunAtLoad'), 'plist mac');
    }
    applyEnergyMode('manual', { home, platform: plat });
    assert.ok(!existsSync(r.file), `${plat} manual limpia`);
  }
});

test('e25: auditoría estática — sin hardcodes de OS ni shell cruda', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'target', '.git'].includes(e.name)) walk(full);
      } else if (e.name.endsWith('.js') && !full.includes('/tests/') && !full.includes('/scripts/')) {
        files.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const code = line.split('//')[0];
      if (/\/home\/[a-z]/i.test(code) && !/homedir|os\.homedir|process\.env\.HOME/.test(line)) {
        offenders.push(`${path.basename(f)}:${i + 1} /home hardcode`);
      }
      if (code.includes('/bin/sh') && !f.endsWith('herramientas.js')) {
        offenders.push(`${path.basename(f)}:${i + 1} /bin/sh fuera de shellFor`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'cero hardcodes de OS');
});

test('e25: CI + packaging presentes y válidos', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
  for (const need of ['windows-latest', 'macos-latest', 'ubuntu-latest', 'smoke-platform', 'tauri-action']) {
    assert.ok(wf.includes(need), `workflow trae ${need}`);
  }
  assert.ok(existsSync(path.join(ROOT, 'packaging/nfpm.yaml')), 'nfpm rpm');
  assert.ok(existsSync(path.join(ROOT, 'packaging/arch/PKGBUILD')), 'PKGBUILD arch');
  assert.ok(existsSync(path.join(ROOT, 'scripts/smoke-platform.mjs')), 'smoke');
  const conf = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.ok(conf.bundle.targets === 'all' || Array.isArray(conf.bundle.targets), 'targets multi-OS');
});
