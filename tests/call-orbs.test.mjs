import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORB_TONE,
  colorHue,
  followEnergy,
  harmonizeOrbColor,
  orbColorFromHue,
  particleCount,
  parseHexColor,
  resolveOrbHues,
  sphereParticles
} from '../src/lib/call-orbs.ts';

// Las esferas del modo llamada tienen que leerse como una FAMILIA: mismo
// brillo, casi sin saturación, y cada empleado con su tono. Lo que se prueba
// acá es justo eso, porque a ojo (sobre todo en modo oscuro) un color de más
// pasa desapercibido hasta que la pantalla parece un semáforo.

const AGENT_COLORS = ['#2f6f73', '#8a5a2b', '#b74e39', '#4a7c59', '#5c5470', '#15618a', '#c2255c', '#f08c00'];

// OKLab del hex final, para poder afirmar cosas sobre brillo y saturación.
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

test('todas las esferas comparten brillo y saturación (una familia, no un semáforo)', () => {
  for (const theme of ['light', 'dark']) {
    const tone = ORB_TONE[theme];
    for (const color of AGENT_COLORS) {
      const { L, chroma } = oklab(harmonizeOrbColor(color, theme));
      // Redondear a #rrggbb mueve L y C un pelo; 0.01 es el margen del redondeo.
      assert.ok(Math.abs(L - tone.l) < 0.01, `${color} en ${theme}: L=${L.toFixed(3)} ≠ ${tone.l}`);
      assert.ok(Math.abs(chroma - tone.c) < 0.01, `${color} en ${theme}: C=${chroma.toFixed(3)} ≠ ${tone.c}`);
    }
  }
});

test('la armonización aplana el equipo entero (los colores fuertes son los que ceden)', () => {
  const antes = AGENT_COLORS.map((color) => oklab(color));
  const despues = AGENT_COLORS.map((color) => oklab(harmonizeOrbColor(color, 'light')));
  const rango = (valores) => Math.max(...valores) - Math.min(...valores);

  // El equipo entra con brillos y saturaciones dispares y sale parejo.
  assert.ok(rango(antes.map((c) => c.L)) > 0.2, 'los colores originales ya eran parejos: revisar el fixture');
  assert.ok(rango(despues.map((c) => c.L)) < 0.02, 'quedaron con brillos distintos');
  assert.ok(rango(despues.map((c) => c.chroma)) < 0.02, 'quedaron con saturaciones distintas');

  // Y los estridentes (el fucsia, el naranja) son los que más bajan.
  for (const [index, color] of AGENT_COLORS.entries()) {
    if (antes[index].chroma > 0.12) {
      assert.ok(despues[index].chroma < antes[index].chroma * 0.5,
        `${color} sigue estridente: ${despues[index].chroma.toFixed(3)}`);
    }
    assert.ok(despues[index].chroma <= ORB_TONE.light.c + 0.01, `${color} se pasó de saturación`);
  }
});

test('el tono del empleado se conserva cuando nadie se lo pisa', () => {
  const hues = resolveOrbHues(['#2f6f73', '#4c6ef5', '#c2255c']);
  hues.forEach((hue, index) => {
    const original = colorHue(['#2f6f73', '#4c6ef5', '#c2255c'][index]);
    assert.ok(Math.abs(hue - original) < 1e-9);
  });
});

test('dos empleados con el MISMO color igual terminan distinguibles', () => {
  // Pasa de verdad: a la CEO y al contratista de las empresas viejas se les
  // asignó el color de la empresa.
  const hues = resolveOrbHues(['#4c6ef5', '#4c6ef5', '#4c6ef5']);
  const colores = hues.map((hue) => orbColorFromHue(hue, 'dark'));
  assert.equal(new Set(colores).size, 3, `se repiten: ${colores.join(' ')}`);
});

test('ninguna pareja de una llamada llena comparte tono', () => {
  const dist = (a, b) => Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  // 8 es el tamaño de equipo con el que se probó la vista; 10 es el caso en que
  // la rueda de tonos ya no da para todos y el reparto pasa a ser "el mejor
  // posible" en vez de "0.55 garantizado".
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

test('un gris o un color roto no dejan la esfera negra ni invisible', () => {
  for (const roto of ['#888888', 'no-es-un-color', '', '#fff']) {
    const claro = oklab(harmonizeOrbColor(roto, 'light'));
    const oscuro = oklab(harmonizeOrbColor(roto, 'dark'));
    assert.ok(Math.abs(claro.L - ORB_TONE.light.l) < 0.01, `${roto} en claro: L=${claro.L}`);
    assert.ok(Math.abs(oscuro.L - ORB_TONE.dark.l) < 0.01, `${roto} en oscuro: L=${oscuro.L}`);
  }
  // Y siguen siendo grises distintos entre sí si son varios en la misma llamada.
  const colores = resolveOrbHues(['#888888', '#777777', '#666666']).map((h) => orbColorFromHue(h, 'light'));
  assert.equal(new Set(colores).size, 3);
});

test('la nube es una esfera: direcciones unitarias y cáscara acotada', () => {
  const particles = sphereParticles(particleCount(76), 2.117);
  assert.ok(particles.length > 300, `pocas partículas: ${particles.length}`);
  let arriba = 0;
  for (const p of particles) {
    assert.ok(Math.abs(Math.hypot(p.ux, p.uy, p.uz) - 1) < 1e-9, 'dirección no unitaria');
    assert.ok(p.rad >= 0.72 && p.rad <= 1, `radio fuera de la cáscara: ${p.rad}`);
    assert.ok(p.phase >= 0 && p.phase < Math.PI * 2, `fase fuera de rango: ${p.phase}`);
    if (p.uy > 0) arriba += 1;
  }
  // Reparto parejo entre hemisferios: si se apelotonan, la silueta deja de ser
  // un círculo lleno.
  const mitad = particles.length / 2;
  assert.ok(Math.abs(arriba - mitad) < mitad * 0.1, `hemisferios desbalanceados: ${arriba}/${particles.length}`);
});

test('la misma esfera se reconstruye idéntica (nada de saltos al re-medir)', () => {
  const a = sphereParticles(200, 1.3);
  const b = sphereParticles(200, 1.3);
  assert.deepEqual(a, b);
  const c = sphereParticles(200, 2.7);
  assert.notDeepEqual(a, c);
});

test('la densidad acompaña al tamaño, con techo y piso', () => {
  assert.ok(particleCount(20) >= 150, 'una esfera chica no puede quedar vacía');
  assert.ok(particleCount(40) < particleCount(80), 'más grande, más puntos');
  assert.ok(particleCount(5000) <= 620, 'el techo protege los FPS');
});

test('la amplitud sube rápido y baja despacio (sin titileo entre sílabas)', () => {
  const frame = 1 / 60;
  // Ataque: en ~100 ms la esfera ya está arriba.
  let up = 0;
  for (let i = 0; i < 6; i += 1) up = followEnergy(up, 1, frame);
  assert.ok(up > 0.7, `ataque lento: ${up.toFixed(2)}`);
  // Caída: después de los mismos 100 ms todavía queda energía (no se apaga de golpe).
  let down = 1;
  for (let i = 0; i < 6; i += 1) down = followEnergy(down, 0, frame);
  assert.ok(down > 0.4, `caída demasiado brusca: ${down.toFixed(2)}`);
  // Y termina llegando a cero.
  for (let i = 0; i < 240; i += 1) down = followEnergy(down, 0, frame);
  assert.ok(down < 0.01, `no vuelve al reposo: ${down}`);
});

test('un dt absurdo (pestaña trabada) no dispara la animación', () => {
  assert.equal(followEnergy(0, 1, 10), 1);
  assert.equal(followEnergy(0.5, 0.5, -1), 0.5);
});
