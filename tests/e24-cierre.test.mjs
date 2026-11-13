// E-24: single-instance + quit limpio — estático Rust + conducta documentada.
// (GUI real no se prueba headless; compila: cargo check 21s OK 10/11.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rs = readFileSync(join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
const cargo = readFileSync(join(ROOT, 'src-tauri/Cargo.toml'), 'utf8');

test('e24: single-instance plugin + foco a ventana existente', () => {
  assert.ok(cargo.includes('tauri-plugin-single-instance'), 'dep en Cargo.toml');
  assert.ok(rs.includes('single_instance_init'), 'plugin registrado');
  assert.ok(rs.includes('show_main_inner(app);'), '2do lanzamiento enfoca main');
});

test('e24: quit limpio — salir mata app + sidecar (RAII)', () => {
  assert.ok(rs.includes('"salir" => app.exit(0)'), 'tray Salir sale');
  assert.ok(rs.includes('let _ = child.kill()'), 'Drop mata sidecar');
  assert.ok(rs.includes('prevent_close'), 'X esconde a orbe (diseño, no bug)');
  assert.ok(rs.includes('place_orb(&handle)'), 'X muestra orbe');
});
