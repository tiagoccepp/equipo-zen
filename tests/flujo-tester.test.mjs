import { test } from 'node:test';
import assert from 'node:assert/strict';

import { revisar, dedup, CHECKLISTS_ROL } from '../server/lib/critic.js';
import {
  planDePrueba, juzgar, resumirParaVoz, PERSONAS_POR_TIPO,
  DIMENSIONES_POR_TIPO, FALLO_SCHEMA, tipoDe
} from '../server/lib/tester.js';
import { registrarLearningsDeLaburo, contextoPrevio } from '../server/lib/learning.js';

// Minimal fake store with the real API the hook uses.
function fakeStore() {
  const learnings = [];
  let seq = 0;
  return {
    learnings,
    insertLearning({ agentId = null, meetingId = null, type, content, confidence }) {
      seq += 1;
      learnings.push({ id: seq, agentId, meetingId, type, content, confidence, timesReinforced: 0 });
      return seq;
    },
    reinforceLearning(id, confidence) {
      const l = learnings.find((x) => x.id === id);
      if (l) l.timesReinforced += 1;
    },
    activeLearnings(agentId) {
      const list = agentId === undefined || agentId === null
        ? learnings
        : learnings.filter((l) => l.agentId === agentId || l.agentId === null);
      return list.map((l) => ({ ...l }));
    }
  };
}

// ---- critic: silence when there is no improvement ----

test('critic: structured silence with a clean delivery', () => {
  const r = revisar(
    { texto: 'Implementé el endpoint con validación zod, tests en verde y docs.' },
    { rol: 'backend' }
  );
  assert.equal(r.silencio, true);
  assert.equal(r.motivo, 'sin_mejora_concreta');
});

test('critic: silence with empty text or role without checklist', () => {
  assert.equal(revisar({ texto: '' }, { rol: 'backend' }).silencio, true);
  assert.equal(revisar({ texto: 'algo' }, { rol: 'rol-inexistente' }).silencio, true);
});

test('critic: concrete improvement with que+porque+como+evidencia', () => {
  const r = revisar(
    { texto: 'Dejé un TODO: refactorizar esto después y un catch(e) {} vacío.' },
    { rol: 'backend' }
  );
  assert.equal(r.silencio, false);
  assert.ok(r.mejoras.length >= 2);
  for (const m of r.mejoras) {
    assert.ok(m.que && m.porque && m.como && m.evidencia, JSON.stringify(m));
    assert.ok(['bug', 'mejora', 'nit'].includes(m.severidad));
  }
  const ids = r.mejoras.map((m) => m.id);
  assert.ok(ids.includes('todo-pendiente'));
  assert.ok(ids.includes('error-silenciado'));
});

test('critic: severidades ordered bug → mejora → nit', () => {
  const r = revisar(
    { texto: 'Lorem ipsum dolor. Fue implementado por el equipo. Es robusto y sin fisuras.' },
    { rol: 'copy' }
  );
  assert.equal(r.silencio, false);
  const orden = { bug: 0, mejora: 1, nit: 2 };
  const sevs = r.mejoras.map((m) => orden[m.severidad]);
  assert.deepEqual([...sevs].sort((a, b) => a - b), sevs);
  assert.equal(r.mejoras[0].severidad, 'bug'); // lorem = placeholder
});

test('critic: anti-duplicates (same signal twice = 1)', () => {
  const dup = dedup([
    { severidad: 'mejora', que: 'Quedó un TODO sin resolver', como: 'Resolverlo ahora mismo' },
    { severidad: 'mejora', que: 'Quedó un TODO sin resolver en el código', como: 'Resolverlo ahora mismo ya' }
  ]);
  assert.equal(dup.length, 1);
});

test('critic: checklists exist for the 8 base roles', () => {
  for (const rol of ['backend', 'frontend', 'diseño', 'copy', 'marketing', 'ventas', 'data', 'devops']) {
    assert.ok(Array.isArray(CHECKLISTS_ROL[rol]) && CHECKLISTS_ROL[rol].length > 0, rol);
  }
});

test('critic: hardcoded secret = bug (devops)', () => {
  const r = revisar({ texto: 'config: api_key = "sk-abc123456789" en el deploy' }, { rol: 'devops' });
  assert.equal(r.silencio, false);
  assert.equal(r.mejoras[0].severidad, 'bug');
});

// ---- tester: persona×dimension matrix ----

test('tester: web matrix = 4 personas × 4 dims', () => {
  const plan = planDePrueba({ tipo: 'web', descripcion: 'landing', url: 'http://x' });
  assert.equal(plan.tipo, 'web');
  assert.deepEqual(plan.personas, ['usuario-nuevo', 'usuario-experto', 'ingeniero-design', 'comprador']);
  assert.deepEqual(plan.dimensiones, ['visual', 'funcional', 'destructivo', 'bordes']);
  assert.equal(plan.celdas.length, 16);
});

test('tester: cv matrix = 2 personas without visual', () => {
  const plan = planDePrueba({ tipo: 'cv', descripcion: 'CV senior' });
  assert.deepEqual(plan.personas, ['ATS', 'recruiter']);
  assert.deepEqual(plan.dimensiones, ['funcional', 'destructivo', 'bordes']);
  assert.equal(plan.celdas.length, 6);
});

test('tester: app matrix = 2 personas × 4 dims', () => {
  const plan = planDePrueba({ tipo: 'app', descripcion: 'app mobile' });
  assert.deepEqual(plan.personas, ['usuario', 'store-reviewer']);
  assert.equal(plan.celdas.length, 8);
});

test('tester: unknown tipo → generico (3 personas)', () => {
  const plan = planDePrueba({ tipo: 'informe', descripcion: 'reporte' });
  assert.equal(plan.tipo, 'generico');
  assert.deepEqual(plan.personas, ['usuario', 'experto', 'escéptico']);
  assert.equal(tipoDe({}), 'generico');
});

test('tester: each check has pasos + mirar + pass', () => {
  const plan = planDePrueba({ tipo: 'web', descripcion: 'x' });
  for (const celda of plan.celdas) {
    assert.ok(celda.checks.length > 0, celda.id);
    for (const c of celda.checks) {
      assert.ok(c.pasos.length > 0 && c.pasos.every((p) => p.trim()), c.id);
      assert.ok(c.mirar.trim(), c.id);
      assert.ok(c.pass.trim(), c.id);
    }
  }
});

test('tester: funcional derives 1 check per brief criterio', () => {
  const plan = planDePrueba({
    tipo: 'web', descripcion: 'x',
    brief: { criteriosExito: ['carga en <2s', 'formulario funciona'] }
  });
  const briefChecks = plan.celdas.flatMap((c) => c.checks).filter((c) => c.id.startsWith('C-brief'));
  assert.equal(briefChecks.length, 2);
  assert.ok(briefChecks[0].mirar.includes('carga en <2s'));
});

// ---- juzgar ----

test('juzgar: fails → severitized devolucion + reproducible + persona', () => {
  const j = juzgar([
    { persona: 'usuario-nuevo', dimension: 'funcional', estado: 'fail', observado: 'el form no envía', pasosRepro: ['abrir', 'enviar'], titulo: 'form roto' },
    { persona: 'ingeniero-design', dimension: 'destructivo', estado: 'fail', observado: 'crash con input largo', pasosRepro: ['pegar 5k chars'], titulo: 'crash input' },
    { persona: 'comprador', dimension: 'visual', estado: 'pass' }
  ], { ronda: 2 });
  assert.equal(j.veredicto, 'devolucion');
  assert.equal(j.ronda, 2);
  assert.equal(j.fallos.length, 2);
  assert.equal(j.fallos[0].severidad, 'bug'); // destructive first
  assert.ok(j.fallos.every((f) => f.reproducible && f.persona && f.pasosRepro.length > 0));
  for (const f of j.fallos) {
    for (const k of FALLO_SCHEMA.filter((x) => !x.endsWith('?'))) {
      assert.ok(k in f, `falta campo ${k}`);
    }
  }
  assert.ok(j.resumenVoz.includes('Ronda 2'));
});

test('juzgar: no pasosRepro → reproducible:false + faltaParaReproducir', () => {
  const j = juzgar([
    { persona: 'ATS', dimension: 'funcional', estado: 'fail', observado: 'algo raro', titulo: 'raro' }
  ]);
  assert.equal(j.fallos[0].reproducible, false);
  assert.ok(j.fallos[0].faltaParaReproducir);
});

test('juzgar: all pass → aprobacion with cobertura + limitaciones', () => {
  const j = juzgar([
    { persona: 'ATS', dimension: 'funcional', estado: 'pass' },
    { persona: 'recruiter', dimension: 'bordes', estado: 'pass' }
  ], { limitaciones: ['sin aviso real para keywords'], arregladoEnRondas: ['typo en título'] });
  assert.equal(j.veredicto, 'aprobado');
  assert.equal(j.cobertura.checksPasados, 2);
  assert.equal(j.cobertura.checksTotales, 2);
  assert.deepEqual(j.limitaciones, ['sin aviso real para keywords']);
  assert.deepEqual(j.arregladoEnRondas, ['typo en título']);
  assert.ok(resumirParaVoz(j).includes('Aprobado'));
});

// ---- learnings ----

test('learnings: records on approval and idempotent on 2nd call', () => {
  const store = fakeStore();
  const juicio = juzgar(
    [{ persona: 'usuario', dimension: 'funcional', estado: 'pass' }],
    { limitaciones: ['solo desktop'] }
  );
  const laburo = {
    meetingId: 1,
    agentePorRol: { tester: 7 },
    juicioFinal: juicio,
    rondas: 2,
    fallosRecurrentes: ['validación de formularios'],
    reusar: ['matriz persona×dimensión'],
    vigilar: ['contraste AA']
  };
  const r1 = registrarLearningsDeLaburo(store, laburo);
  assert.ok(r1.creados > 0, JSON.stringify(r1));
  assert.ok(store.learnings.every((l) => l.type === 'skill_note'));
  const r2 = registrarLearningsDeLaburo(store, laburo);
  assert.equal(r2.creados, 0);
  assert.ok(r2.reforzados > 0);
});

test('contextoPrevio: matches by topic, respects budget, empty without noise', () => {
  const store = fakeStore();
  store.insertLearning({ agentId: null, type: 'skill_note', content: 'Revisar contraste AA en cada entrega visual siempre.', confidence: 0.9 });
  store.insertLearning({ agentId: null, type: 'skill_note', content: 'Los deploy usan healthcheck obligatorio.', confidence: 0.9 });
  const ctx = contextoPrevio(store, 'diseño', 'contraste visual entrega');
  assert.ok(ctx.includes('contraste'));
  assert.ok(!ctx.includes('healthcheck'));
  assert.ok(ctx.length <= 800);
  assert.equal(contextoPrevio(store, 'backend', 'cocina recetas pastas'), '');
  assert.equal(contextoPrevio(store, 'backend', ''), '');
});

test('exported PERSONAS/DIMENSIONES cover the 4 tipos', () => {
  for (const t of ['web', 'cv', 'app', 'generico']) {
    assert.ok(PERSONAS_POR_TIPO[t].length >= 2, t);
    assert.ok(DIMENSIONES_POR_TIPO[t].length >= 3, t);
  }
});
