// TV — Visual modelo-manda v3 (09/11): orbe siempre orbe + §GESTOS en system.
// - §GESTOS presente, lista los 100 (cruce A+B), sin tags de ejemplo válidos.
// - STATE_SHAPE todo 'sphere' (2D y 3D); STATE_VIBRATION hablando>pensando>resto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemInstruction } from '../server/lib/agent-runtime.js';
import {
  GESTOS_A,
  GESTOS_B,
  VALID_GESTOS,
  parseGesto
} from '../server/lib/gestos.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (p) => readFileSync(join(ROOT, p), 'utf-8');

const AGENTE = {
  id: 't', name: 'Tito', title: 'Tester', role: 'dev',
  domains: ['general'], style: 'Directo.', tasks: []
};

test('v3: §GESTOS presente en system', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  assert.ok(sys.includes('§GESTOS'), 'falta marcador §GESTOS');
  assert.ok(
    sys.includes('GESTOS VISUALES') || sys.includes('VISUAL GESTURES'),
    'falta header de gestos'
  );
});

test('v3: system lista los 100 (cruce GESTOS_A + GESTOS_B)', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  assert.equal(GESTOS_A.length, 50, 'GESTOS_A debe tener 50');
  assert.equal(GESTOS_B.length, 50, 'GESTOS_B debe tener 50');
  const todos = [...GESTOS_A, ...GESTOS_B];
  assert.equal(new Set(todos).size, 100, 'A+B deben ser 100 únicos');
  const faltan = todos.filter((n) => !sys.includes(n));
  assert.deepEqual(faltan, [], `faltan ${faltan.length} en system: ${faltan.slice(0, 8).join(', ')}`);
});

test('v3: sin tags de ejemplo válidos (no confunden al modelo)', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  // El prompt entero no debe parsear a ningún gesto válido.
  const { gesto } = parseGesto(sys);
  assert.equal(gesto, null, `system contiene tag válido: ${gesto}`);
  // Cada [[gesto:X]] literal del system debe ser placeholder (no válido).
  const tags = [...sys.matchAll(/\[\[\s*gesto\s*:\s*([^\][\]]+?)\s*\]\]/gi)]
    .map((m) => String(m[1]).trim().toLowerCase().replace(/\s+/g, '_'));
  assert.ok(tags.length >= 1, 'el protocolo debe mostrar el formato [[gesto:…]]');
  for (const t of tags) {
    assert.ok(!VALID_GESTOS.has(t), `tag de ejemplo válido confunde: [[gesto:${t}]]`);
  }
});

test('v3: regla solo-si-aporta / nunca-forzado presente', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  assert.ok(
    sys.includes('Solo si aporta') || sys.includes('Only if it adds'),
    'falta regla solo-si-aporta'
  );
  assert.ok(
    sys.includes('nunca forzado') || sys.includes('never forced'),
    'falta regla nunca-forzado'
  );
});

test('v3: STATE_SHAPE todo sphere (2D y 3D), orbe siempre orbe', () => {
  // Nota: se lee como texto — orb-morph/orb3d usan value-imports de tipos
  // que vite acepta pero el type-stripping de node no (preexistente).
  const morph = readSrc('src/fx/orb-morph.ts');
  const block = morph.match(/STATE_SHAPE[^=]*=\s*\{([^}]+)\}/s);
  assert.ok(block, 'STATE_SHAPE no encontrado en orb-morph.ts');
  for (const e of ['idle', 'escuchando', 'hablando', 'pensando', 'trabajando']) {
    assert.match(block[1], new RegExp(`${e}:\\s*'sphere'`), `2D ${e} debe mapear a sphere`);
  }
  // 3D importa STATE_SHAPE de orb-morph (fuente única): verificar import.
  const orb3d = readSrc('src/fx/orb3d.ts');
  assert.ok(orb3d.includes('STATE_SHAPE') && orb3d.includes("from './orb-morph"), '3D debe reutilizar STATE_SHAPE de orb-morph');
  // Ningún setAgentState puede forzar figura vía setShape(STATE_SHAPE…).
  assert.ok(!morph.includes('setShape(STATE_SHAPE'), '2D setAgentState no debe llamar setShape');
  assert.ok(!orb3d.includes('setShape(STATE_SHAPE'), '3D setAgentState no debe llamar setShape');
});

test('v3: STATE_VIBRATION hablando>pensando>resto, idle=0', () => {
  const morph = readSrc('src/fx/orb-morph.ts');
  const block = morph.match(/STATE_VIBRATION[^=]*=\s*\{([^}]+)\}/s);
  assert.ok(block, 'STATE_VIBRATION no encontrado en orb-morph.ts');
  const num = (k) => Number(block[1].match(new RegExp(`${k}:\\s*([0-9.]+)`))?.[1]);
  assert.equal(num('idle'), 0, 'idle=0 libera al upstream');
  assert.ok(num('hablando') > num('pensando'), 'hablando vibra más que pensando');
  assert.ok(num('pensando') > 0, 'pensando tiene pulso leve');
  assert.ok(num('escuchando') > 0, 'escuchando respira sutil');
});

test('v3/TG: gestos cool-only, sin cap duro max-1 (bilingüe)', () => {
  const sys = buildSystemInstruction(AGENTE, {});
  // El cap duro murió: ni ES ni EN pueden mencionarlo.
  assert.ok(!sys.includes('máximo 1 por turno'), 'quedó cap duro ES');
  assert.ok(!sys.includes('at most 1 per turn'), 'quedó cap duro EN');
  assert.ok(!sys.includes('max-1') && !sys.includes('max 1'), 'quedó cap duro');
  // La regla cool-only existe en los dos idiomas.
  assert.ok(sys.includes('cool'), 'falta regla cool-only');
  assert.ok(
    sys.includes('Sin exagerar') || sys.includes('overdo'),
    'falta regla sin-exagerar (ES/EN)'
  );
  assert.ok(
    sys.includes('SOLO si queda cool') || sys.includes('ONLY if it looks cool'),
    'falta condición solo-si-cool (ES/EN)'
  );
  // El protocolo [[gesto:…]] sigue enseñándose (placeholder no válido).
  assert.ok(sys.includes('[[gesto:nombre]]') || sys.includes('[[gesto:name]]'), 'falta formato [[gesto:…]]');
});

test('TG: minimizar main ⇒ orbe (comandos Rust + handler + frontend)', () => {
  // Nota: sin harness Rust; se verifica el cableado como texto, igual
  // que los tests STATE_SHAPE/VIBRATION de arriba.
  const main = readSrc('src-tauri/src/main.rs');
  const app = readSrc('src/app.ts');
  // Comandos nuevos existen y están registrados en el handler.
  assert.ok(main.includes('fn main_minimized'), 'falta comando main_minimized');
  assert.ok(main.includes('fn main_restored'), 'falta comando main_restored');
  const handler = main.match(/generate_handler!\[([\s\S]+?)\]\)/);
  assert.ok(handler, 'invoke_handler no encontrado');
  assert.ok(handler[1].includes('main_minimized'), 'main_minimized no registrado');
  assert.ok(handler[1].includes('main_restored'), 'main_restored no registrado');
  // Restaurar des-minimiza (show y expand traen la ventana de vuelta).
  const showFn = main.match(/fn show_main_inner[\s\S]*?\n\}/);
  assert.ok(showFn && showFn[0].includes('unminimize'), 'show_main_inner debe des-minimizar');
  assert.ok(main.includes('orb_por_minimizar'), 'falta flag orb_por_minimizar');
  // Frontend detecta transiciones con isMinimized() y avisa al núcleo.
  assert.ok(app.includes('isMinimized'), 'app.ts debe leer isMinimized()');
  assert.ok(app.includes("'main_minimized'"), 'app.ts debe invocar main_minimized');
  assert.ok(app.includes("'main_restored'"), 'app.ts debe invocar main_restored');
});

test('TG: hotkey Ctrl+Shift+E intacto (solo alterna orbe)', () => {
  const main = readSrc('src-tauri/src/main.rs');
  assert.ok(main.includes('Code::KeyE'), 'falta hotkey KeyE');
  assert.ok(main.includes('Modifiers::CONTROL | Modifiers::SHIFT'), 'falta modificadores Ctrl+Shift');
  const hotkey = main.match(/with_handler\(\|[\s\S]*?\.build\(\)/);
  assert.ok(hotkey && hotkey[0].includes('toggle_orb_inner'), 'hotkey debe seguir alternando solo el orbe');
});

test('TG: orbe-mini sin figuras forzadas (vibra, no muta)', () => {
  const orb = readSrc('src/orb.ts');
  assert.ok(!orb.includes('setGlyph'), 'orb.ts no debe forzar figuras');
  assert.ok(!orb.includes('setShape'), 'orb.ts no debe forzar shapes');
  assert.ok(orb.includes('orb_poll'), 'orb.ts debe leer estado vía orb_poll');
  assert.ok(orb.includes('expand'), 'orb.ts debe poder expandir a main');
});

test('v3: setGlyph intacto en 2D y 3D (única vía de figuras)', () => {
  for (const p of ['src/fx/orb-morph.ts', 'src/fx/orb3d.ts']) {
    const src = readSrc(p);
    assert.ok(src.includes('setGlyph(agentId: string, glyphName: string | null)'), `${p}: firma setGlyph intacta`);
    assert.ok(src.includes('lookupGlyph(glyphName)'), `${p}: setGlyph usa lookupGlyph`);
  }
});
