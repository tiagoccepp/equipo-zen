// Manos v1 smoke: LIVE against real code (only external network allowed:
// fetch to https://example.com). node scripts/manos-smoke.mjs

// No proxy: the gateway poisons it with 403 and example.com must go direct.
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

import fs from 'node:fs/promises';

const { getTool } = await import('../server/lib/manos.js');
const { projectDir } = await import('../server/lib/workforce.js');

const EMPRESA = 'smoke-manos';
const ctx = { companyId: EMPRESA, slug: 'general' };
const filas = [];
let fallos = 0;

async function paso(nombre, fn) {
  try {
    const detalle = await fn();
    filas.push(['PASS', nombre, detalle || '']);
  } catch (error) {
    fallos += 1;
    filas.push(['FAIL', nombre, String(error?.message || error).slice(0, 120)]);
  }
}

function ok(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

await paso('write_file en workspace', async () => {
  const r = await getTool('write_file').execute({ path: 'smoke.txt', content: 'manos v1 OK' }, ctx);
  ok(r.ok, r.error);
  return r.output;
});

await paso('read_file roundtrip', async () => {
  const r = await getTool('read_file').execute({ path: 'smoke.txt' }, ctx);
  ok(r.ok && r.output === 'manos v1 OK', `inesperado: ${r.output || r.error}`);
  return r.output;
});

await paso('list_files raíz (ve smoke.txt)', async () => {
  const r = await getTool('list_files').execute({}, ctx);
  ok(r.ok && r.output.includes('smoke.txt'), r.error || r.output);
  return r.output.split('\n').length + ' entradas';
});

await paso('run_cmd echo', async () => {
  const r = await getTool('run_cmd').execute({ cmd: 'echo smoke-vivo' }, ctx);
  ok(r.ok && r.output.includes('smoke-vivo'), r.error || r.output);
  return r.output.trim();
});

await paso('fetch_url https://example.com', async () => {
  const r = await getTool('fetch_url').execute({ url: 'https://example.com' }, ctx);
  ok(r.ok && /example/i.test(r.output), r.error || r.output.slice(0, 80));
  return `${r.output.length} chars`;
});

await paso('now', async () => {
  const r = await getTool('now').execute({}, ctx);
  ok(r.ok && /^\d{4}-/.test(r.output), r.error || r.output);
  return r.output;
});

await paso('NEGATIVO: escape ../../../etc denegado', async () => {
  const r = await getTool('write_file').execute({ path: '../../../etc/manos-evil.txt', content: 'x' }, ctx);
  ok(!r.ok, '¡PERMITIÓ EL ESCAPE!');
  return r.error;
});

await paso('NEGATIVO: rm -rf negado en vivo', async () => {
  const r = await getTool('run_cmd').execute({ cmd: 'rm -rf node_modules' }, ctx);
  ok(!r.ok && /negado en vivo/.test(r.error || ''), `inesperado: ${JSON.stringify(r).slice(0, 100)}`);
  return r.error;
});

// Cleanup: the smoke leaves no litter.
await fs.rm(projectDir(EMPRESA, 'general'), { recursive: true, force: true });

const ancho = Math.max(...filas.map((f) => f[1].length));
console.log('\nManos v1 smoke (LIVE)');
for (const [estado, nombre, detalle] of filas) {
  console.log(`${estado}  ${nombre.padEnd(ancho)}  ${detalle}`);
}
console.log(fallos === 0 ? '\nTODO PASS' : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
