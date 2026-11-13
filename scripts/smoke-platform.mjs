// E-25: smoke portable por plataforma — corre en CI (linux/win/mac) y local.
// Solo Node puro + asserts: versiones, módulos clave, store :memory:,
// settings, y gates de portabilidad (shell/autostart por OS).
// node scripts/smoke-platform.mjs [--quick]
import assert from 'node:assert/strict';

const failures = [];
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log(`ok - ${name}`)).catch((e) => {
        failures.push(name);
        console.error(`FAIL - ${name}: ${e.message}`);
      });
    }
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${e.message}`);
  }
  return Promise.resolve();
};

const quick = process.argv.includes('--quick');

await ok('node >= 20', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
});

await ok('platform detectada', () => {
  assert.ok(['linux', 'win32', 'darwin'].includes(process.platform), process.platform);
  console.log(`  platform=${process.platform} arch=${process.arch}`);
});

await ok('settings + store :memory:', async () => {
  const { Store } = await import('../server/lib/store.js');
  const store = new Store(':memory:');
  store.recordUsage({ kind: 'smoke', tokens: 1 });
  assert.equal(store.usageSummary({}).calls, 1);
  store.close();
});

await ok('permisos + hooks cargan', async () => {
  const perms = await import('../server/lib/permissions.js');
  assert.equal(perms.tierFor('read_file'), 'allow');
  const hooks = await import('../server/lib/hooks.js');
  assert.ok(hooks.HOOK_EVENTS.includes('preToolUse'));
});

await ok('shell por plataforma', async () => {
  const { shellFor } = await import('../server/lib/herramientas.js');
  const [winBin, winArgs] = shellFor('win32', 'echo hi');
  assert.ok(winBin.toLowerCase().includes('cmd'), winBin);
  assert.ok(winArgs.includes('/c'));
  const [nixBin] = shellFor('linux', 'echo hi');
  assert.equal(nixBin, '/bin/sh');
  const [cur] = shellFor(process.platform, 'x');
  assert.ok(cur, 'shell actual resuelve');
});

await ok('autostart por OS (dry, tmp HOME)', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { applyEnergyMode } = await import('../server/lib/energy.js');
  for (const plat of ['linux', 'win32', 'darwin']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-home-'));
    const r = applyEnergyMode('gate', { home, platform: plat });
    assert.equal(r.autostart, true, plat);
    assert.ok(fs.existsSync(r.file), r.file);
    if (plat === 'win32') assert.ok(r.file.endsWith('.bat'), r.file);
    if (plat === 'darwin') assert.ok(r.file.endsWith('.plist'), r.file);
    if (plat === 'linux') assert.ok(r.file.endsWith('.desktop'), r.file);
  }
});

if (!quick) {
  await ok('manos registry + tool search', async () => {
    const manos = await import('../server/lib/manos.js');
    assert.ok(manos.getTool('read_file'), 'builtin');
    assert.ok(manos.getTool('mcp_search'), 'mcp_search');
    assert.ok(manos.getTool('task_add'), 'checklist');
  });

  await ok('figures + sanitize', async () => {
    const { figure } = await import('../server/lib/figures.js');
    assert.ok(figure({ kind: 'notice', text: 'hola' }).ok);
    const { sanitizeWidgetHtml } = await import('../src/lib/widget-sandbox.ts');
    assert.ok(!sanitizeWidgetHtml('<script>x</script>').includes('script'));
  });
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAIL: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE OK');
