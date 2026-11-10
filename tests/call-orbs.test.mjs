import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORB_TONE,
  OrbField,
  colorHue,
  followEnergy,
  harmonizeOrbColor,
  orbColorFromHue,
  particleCount,
  parseHexColor,
  resolveOrbHues,
  sphereParticles
} from '../src/lib/call-orbs.ts';

// The call-mode orbs must read as a FAMILY: same brightness, almost no
// saturation, and each employee with their own hue. That is exactly what is
// tested here, because by eye (especially in dark mode) one extra color
// goes unnoticed until the screen looks like a traffic light.

const AGENT_COLORS = ['#2f6f73', '#8a5a2b', '#b74e39', '#4a7c59', '#5c5470', '#15618a', '#c2255c', '#f08c00'];

// OKLab of the final hex, so we can assert things about lightness and saturation.
function oklab(hex) {
  const rgb = parseHexColor(hex);
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    chroma: Math.sqrt(A * A + B * B)
  };
}

test('all orbs share lightness and saturation (one family, not a traffic light)', () => {
  for (const theme of ['light', 'dark']) {
    const tone = ORB_TONE[theme];
    for (const color of AGENT_COLORS) {
      const { L, chroma } = oklab(harmonizeOrbColor(color, theme));
      // Rounding to #rrggbb shifts L and C slightly; 0.01 is the rounding margin.
      assert.ok(Math.abs(L - tone.l) < 0.01, `${color} en ${theme}: L=${L.toFixed(3)} ≠ ${tone.l}`);
      assert.ok(Math.abs(chroma - tone.c) < 0.01, `${color} en ${theme}: C=${chroma.toFixed(3)} ≠ ${tone.c}`);
    }
  }
});

test('harmonization flattens the whole team (the loud colors are the ones that yield)', () => {
  const antes = AGENT_COLORS.map((color) => oklab(color));
  const despues = AGENT_COLORS.map((color) => oklab(harmonizeOrbColor(color, 'light')));
  const rango = (valores) => Math.max(...valores) - Math.min(...valores);

  // The team enters with uneven lightness and saturation and comes out even.
  assert.ok(rango(antes.map((c) => c.L)) > 0.2, 'los colores originales ya eran parejos: revisar el fixture');
  assert.ok(rango(despues.map((c) => c.L)) < 0.02, 'quedaron con brillos distintos');
  assert.ok(rango(despues.map((c) => c.chroma)) < 0.02, 'quedaron con saturaciones distintas');

  // And the loud ones (the fuchsia, the orange) are the ones that drop most.
  for (const [index, color] of AGENT_COLORS.entries()) {
    if (antes[index].chroma > 0.12) {
      assert.ok(despues[index].chroma < antes[index].chroma * 0.5,
        `${color} sigue estridente: ${despues[index].chroma.toFixed(3)}`);
    }
    assert.ok(despues[index].chroma <= ORB_TONE.light.c + 0.01, `${color} se pasó de saturación`);
  }
});

test('the employee hue is preserved when nobody steps on it', () => {
  const hues = resolveOrbHues(['#2f6f73', '#4c6ef5', '#c2255c']);
  hues.forEach((hue, index) => {
    const original = colorHue(['#2f6f73', '#4c6ef5', '#c2255c'][index]);
    assert.ok(Math.abs(hue - original) < 1e-9);
  });
});

test('two employees with the SAME color still end up distinguishable', () => {
  // This really happens: the CEO and the legacy-company contractor were
  // assigned the company color.
  const hues = resolveOrbHues(['#4c6ef5', '#4c6ef5', '#4c6ef5']);
  const colores = hues.map((hue) => orbColorFromHue(hue, 'dark'));
  assert.equal(new Set(colores).size, 3, `se repiten: ${colores.join(' ')}`);
});

test('no pair in a full call shares a hue', () => {
  const dist = (a, b) => Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  // 8 is the team size the view was tested with; 10 is the case where
  // the hue wheel no longer fits everyone and the spread becomes "best
  // effort" instead of "guaranteed 0.55".
  for (const equipo of [AGENT_COLORS, [...AGENT_COLORS, '#4c6ef5', '#0ca678']]) {
    const hues = resolveOrbHues(equipo);
    const minimo = equipo.length > 8 ? 0.4 : 0.55;
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        assert.ok(dist(hues[i], hues[j]) >= minimo,
          `con ${equipo.length} esferas, ${i} y ${j} quedaron a ${dist(hues[i], hues[j]).toFixed(3)}`);
      }
    }
  }
});

test('a gray or a broken color never leaves the orb black or invisible', () => {
  for (const roto of ['#888888', 'no-es-un-color', '', '#fff']) {
    const claro = oklab(harmonizeOrbColor(roto, 'light'));
    const oscuro = oklab(harmonizeOrbColor(roto, 'dark'));
    assert.ok(Math.abs(claro.L - ORB_TONE.light.l) < 0.01, `${roto} en claro: L=${claro.L}`);
    assert.ok(Math.abs(oscuro.L - ORB_TONE.dark.l) < 0.01, `${roto} en oscuro: L=${oscuro.L}`);
  }
  // And they are still distinct grays from each other when several share a call.
  const colores = resolveOrbHues(['#888888', '#777777', '#666666']).map((h) => orbColorFromHue(h, 'light'));
  assert.equal(new Set(colores).size, 3);
});

test('the cloud is a sphere: unit directions and a bounded shell', () => {
  const particles = sphereParticles(particleCount(76), 2.117);
  assert.ok(particles.length > 300, `pocas partículas: ${particles.length}`);
  let arriba = 0;
  for (const p of particles) {
    assert.ok(Math.abs(Math.hypot(p.ux, p.uy, p.uz) - 1) < 1e-9, 'dirección no unitaria');
    assert.ok(p.rad >= 0.72 && p.rad <= 1, `radio fuera de la cáscara: ${p.rad}`);
    assert.ok(p.phase >= 0 && p.phase < Math.PI * 2, `fase fuera de rango: ${p.phase}`);
    if (p.uy > 0) arriba += 1;
  }
  // Even split between hemispheres: if they bunch up, the silhouette stops
  // being a filled circle.
  const mitad = particles.length / 2;
  assert.ok(Math.abs(arriba - mitad) < mitad * 0.1, `hemisferios desbalanceados: ${arriba}/${particles.length}`);
});

test('the same orb rebuilds identically (no jumps on re-measure)', () => {
  const a = sphereParticles(200, 1.3);
  const b = sphereParticles(200, 1.3);
  assert.deepEqual(a, b);
  const c = sphereParticles(200, 2.7);
  assert.notDeepEqual(a, c);
});

test('density follows size, with ceiling and floor', () => {
  assert.ok(particleCount(20) >= 150, 'una esfera chica no puede quedar vacía');
  assert.ok(particleCount(40) < particleCount(80), 'más grande, más puntos');
  // The ceiling was raised for large orbs (measured: stable 60 fps with 8
  // 133px orbs; the loop draws in passes, not per particle).
  assert.ok(particleCount(5000) <= 720, 'el techo protege los FPS');
  assert.ok(particleCount(130) > 620, 'una esfera grande no puede verse rala');
});

test('amplitude rises fast and falls slowly (no flicker between syllables)', () => {
  const frame = 1 / 60;
  // Attack: at ~100 ms the orb is already up.
  let up = 0;
  for (let i = 0; i < 6; i += 1) up = followEnergy(up, 1, frame);
  assert.ok(up > 0.7, `ataque lento: ${up.toFixed(2)}`);
  // Release: after the same 100 ms there is still energy left (no abrupt shutoff).
  let down = 1;
  for (let i = 0; i < 6; i += 1) down = followEnergy(down, 0, frame);
  assert.ok(down > 0.4, `caída demasiado brusca: ${down.toFixed(2)}`);
  // And it does reach zero eventually.
  for (let i = 0; i < 240; i += 1) down = followEnergy(down, 0, frame);
  assert.ok(down < 0.01, `no vuelve al reposo: ${down}`);
});

test('an absurd dt (frozen tab) does not blow up the animation', () => {
  assert.equal(followEnergy(0, 1, 10), 1);
  assert.equal(followEnergy(0.5, 0.5, -1), 0.5);
});

// ── The "is working" ring ────────────────────────────────────────────────
// What makes it visible that the team keeps producing even when nobody talks.

test('the orbs know who is working and who is not', () => {
  const campo = Object.create(OrbField.prototype);
  campo.workingIds = new Set();
  campo.kick = () => {};

  campo.setWorking(['a', 'b']);
  assert.equal(campo.isWorking('a'), true);
  assert.equal(campo.isWorking('c'), false);

  campo.setWorking(['b']);
  assert.equal(campo.isWorking('a'), false, 'el que terminó deja de tener el anillo');
  assert.equal(campo.isWorking('b'), true);
});

test('repeating the same set does not wake the draw loop pointlessly', () => {
  const campo = Object.create(OrbField.prototype);
  campo.workingIds = new Set();
  let despertadas = 0;
  campo.kick = () => { despertadas += 1; };

  campo.setWorking(['a']);
  assert.equal(despertadas, 1);
  campo.setWorking(['a']);
  assert.equal(despertadas, 1, 'sin cambios, no se repinta');
  campo.setWorking(['a', 'b']);
  assert.equal(despertadas, 2);
});

test('nobody working is a valid state, not an error', () => {
  const campo = Object.create(OrbField.prototype);
  campo.workingIds = new Set(['a']);
  campo.kick = () => {};
  campo.setWorking([]);
  assert.equal(campo.isWorking('a'), false);
});
