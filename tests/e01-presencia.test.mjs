// E-01: contrato de presencia (orbe + voz + estados). Estático cross-file:
// los estados del protocolo y los comandos invoke deben coincidir entre
// Rust, app.ts y orb.ts — si uno deriva, este test lo atrapa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rust = readFileSync(join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
const app = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
const orb = readFileSync(join(ROOT, 'src/orb.ts'), 'utf8');

test('e01: estados del protocolo consistentes Rust↔app↔orb', () => {
  // Rust acepta estos en orb_report (match arms).
  const matchArms = rust.match(/o\.estado = match nuevo\.as_str\(\) \{([^}]+)\}/s)?.[1] || '';
  for (const st of ['escuchando', 'hablando', 'pensando']) {
    assert.ok(matchArms.includes(`"${st}"`), `Rust acepta ${st}`);
  }
  assert.ok(matchArms.includes('"idle"'), 'Rust defaultea a idle');
  // app.ts los reporta (orbState).
  for (const st of ['escuchando', 'hablando', 'pensando', 'idle']) {
    assert.ok(app.includes(`return '${st}'`), `orbState reporta ${st}`);
  }
  // orb.ts los muestra (label + piso de vibración).
  for (const st of ['idle', 'escuchando', 'hablando', 'pensando']) {
    assert.ok(orb.includes(`${st}:`), `orb.ts conoce ${st}`);
  }
});

test('e01: todo invoke del orbe existe en generate_handler', () => {
  const handler = rust.match(/generate_handler!\[(.*?)\]\)/s)?.[1] || '';
  const invokes = new Set([
    ...(app.matchAll(/tinvoke\(\s*'([a-z_]+)'/g) || []),
    // orb.ts usa invoke<Tipo>('cmd'): tolerar type params.
    ...(orb.matchAll(/invoke(?:<.+?>)?\(\s*'([a-z_]+)'/g) || [])
  ].map((m) => m[1]));
  assert.ok(invokes.has('orb_report'), 'app reporta estado');
  assert.ok(invokes.has('orb_poll'), 'orb consulta estado');
  for (const cmd of invokes) {
    // Comandos de ventana de Tauri (no nuestros) se resuelven por plugin.
    if (['backend_url', 'app_platform'].includes(cmd)) continue;
    assert.ok(
      handler.includes(cmd),
      `comando '${cmd}' invocado pero no registrado en generate_handler`
    );
  }
});

test('e01: superficie mínima presente (tray + atajo + close-to-orb)', () => {
  assert.ok(rust.includes('"mostrar"'), 'tray: mostrar');
  assert.ok(rust.includes('"orbe"'), 'tray: orbe');
  assert.ok(rust.includes('"salir"'), 'tray: salir');
  assert.ok(rust.includes('Code::KeyE'), 'atajo global Ctrl+Shift+E');
  assert.ok(rust.includes('prevent_close'), 'cerrar no mata: esconde a orbe');
  assert.ok(rust.includes('place_orb(&handle)'), 'cerrar muestra orbe');
  assert.ok(orb.includes("cmd: 'toggle-mic'"), 'orbe: clic = hablar');
  assert.ok(orb.includes("cmd: 'expand'"), 'orbe: expandir a main');
});
