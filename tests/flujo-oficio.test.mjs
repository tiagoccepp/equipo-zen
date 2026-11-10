import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clasificarComando } from '../server/lib/herramientas.js';
import {
  archivoDeTokens,
  DEFAULT_STACK,
  renderDesignStandard,
  renderFlujo,
  renderPlaybooks,
  renderRoles,
  STACKS
} from '../server/lib/playbooks.js';

// The craft flow: what comes first, which command verifies it, and what must
// not be touched again. This was missing in real runs — five files were written
// with no plan, the entry point kept the default template, and steps ran out
// before finish.
//
// Everything here is measured against files and templates: no employee names,
// which change with each template.

const TOPE_FLUJO = 900;
const TOPE_ROLES = 700;

const companyTemplates = JSON.parse(
  readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8')
);

function leerPlaybook(nombre) {
  return readFileSync(new URL(`../server/playbooks/${nombre}.md`, import.meta.url), 'utf-8').trim();
}

// No accents, all lowercase: the playbook is written to be read, not for
// the test to guess how each word was accented.
function normalizar(texto) {
  return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// The command used to verify in each niche before taking anything for granted.
// It is the same one offered by the team terminal (herramientas.js) and the one
// the engine runs to accept finish.
const VERIFICACION = {
  web: 'node --check',
  automatizacion: 'node flujo.js',
  'movil-rn': 'npx tsc --noEmit',
  android: 'gradle assembleDebug',
  python: 'python3 main.py'
};

test('each declared niche has its flow, and the engine delivers it', () => {
  for (const stack of STACKS) {
    const archivo = leerPlaybook(`flujo-${stack}`);
    assert.ok(archivo.length > 200, `flujo-${stack}.md tiene que existir y decir algo`);
    const render = renderFlujo(stack);
    assert.ok(render.includes(archivo), `renderFlujo('${stack}') tiene que traer flujo-${stack}.md entero`);
    assert.ok(/orden/i.test(render), `el flujo de ${stack} tiene que anunciar que el orden importa`);
  }
});

test('no flow exceeds the prompt budget', () => {
  for (const stack of STACKS) {
    const largo = leerPlaybook(`flujo-${stack}`).length;
    assert.ok(
      largo <= TOPE_FLUJO,
      `flujo-${stack}.md mide ${largo} caracteres y el tope es ${TOPE_FLUJO}: el protocolo de acciones compite con esto`
    );
  }
  const roles = leerPlaybook('roles').length;
  assert.ok(roles <= TOPE_ROLES, `roles.md mide ${roles} caracteres y el tope es ${TOPE_ROLES}`);
});

test('each flow states what to verify and with which exact command, before finish', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    assert.ok(VERIFICACION[stack], `apareció el nicho ${stack}: decí acá con qué comando se verifica`);
    assert.ok(
      flujo.includes(VERIFICACION[stack]),
      `el flujo de ${stack} tiene que nombrar el comando exacto que verifica (${VERIFICACION[stack]})`
    );
    assert.ok(/antes de finish/i.test(flujo), `el flujo de ${stack} tiene que decir qué se verifica ANTES del finish`);
    assert.ok(/\bfinish\b/.test(flujo), `el flujo de ${stack} termina en finish, y tiene que decirlo`);
  }
});

test('the commands the flow sends are commands the terminal allows', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    const comandos = [...flujo.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    assert.ok(comandos.length >= 1, `el flujo de ${stack} tiene que traer al menos un comando entre comillas`);
    for (const cmd of comandos) {
      const r = clasificarComando(cmd);
      assert.equal(r.permitido, true, `"${cmd}" del flujo de ${stack} tiene que poder ejecutarse`);
      assert.ok(!r.riesgoso, `"${cmd}" del flujo de ${stack} no debería pedir explicación: es trabajo normal`);
    }
  }
});

test('each flow is a numbered list with no gaps: the order is the content', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    const pasos = [...flujo.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(pasos.length >= 4, `el flujo de ${stack} necesita al menos 4 pasos, tiene ${pasos.length}`);
    assert.deepEqual(pasos, pasos.map((_, i) => i + 1), `los pasos de ${stack} tienen que ir 1, 2, 3… sin saltos`);
  }
});

test('each flow names the niche\'s usual errors and when not to iterate', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    const errores = flujo.split(/ERRORES DE SIEMPRE:/)[1] || '';
    const listados = [...errores.matchAll(/^- /gm)];
    assert.ok(listados.length >= 2, `el flujo de ${stack} tiene que nombrar 2 o 3 errores típicos`);
    assert.ok(/NO ITERAR/.test(flujo), `el flujo de ${stack} tiene que decir qué dar por bueno y dejar quieto`);
  }
});

test('each niche\'s errors belong to THAT niche, not generic warnings', () => {
  // What always breaks in each place. If this goes generic, the flow stops
  // being useful: the agent already has the technical judgment for the general.
  const propios = {
    web: ['tokens.css', 'href="#"'],
    automatizacion: ['datos de ejemplo', 'credenciales'],
    'movil-rn': ['App.js', 'Expo'],
    android: ['kotlin.android', 'imports'],
    python: ['input()', 'requirements.txt']
  };
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    assert.ok(propios[stack], `apareció el nicho ${stack}: sumale acá sus errores propios`);
    for (const marca of propios[stack]) {
      assert.ok(flujo.includes(marca), `el flujo de ${stack} tiene que advertir sobre "${marca}"`);
    }
  }
});

test('roles.md mentions the crafts that really exist in the templates', () => {
  // Crafts derive from templates by role and title, never by proper name:
  // Renata may be called something else tomorrow.
  const clases = [
    { oficio: 'quien coordina', esta: (e) => e.role === 'ceo', menciones: ['ceo', 'coordina'] },
    { oficio: 'quien afina perfiles', esta: (e) => e.role === 'contratista', menciones: ['contratista', 'afina perfiles'] },
    { oficio: 'quien diseña', esta: (e) => /disen|arte/.test(normalizar(e.title)), menciones: ['disena'] },
    {
      oficio: 'quien construye',
      esta: (e) => /desarrollad|arquitect|plataforma/.test(normalizar(e.title)),
      menciones: ['construye', 'dev']
    },
    { oficio: 'quien prueba', esta: (e) => /\bqa\b|calidad/.test(normalizar(e.title)), menciones: ['qa', 'prueba'] }
  ];
  const empleados = companyTemplates.templates.flatMap((t) => t.employees);
  const roles = normalizar(renderRoles());
  assert.ok(roles.length > 100, 'renderRoles() tiene que traer algo');

  for (const clase of clases) {
    assert.ok(empleados.some(clase.esta), `las plantillas tienen que traer ${clase.oficio}`);
    assert.ok(
      clase.menciones.some((m) => roles.includes(normalizar(m))),
      `roles.md no menciona ${clase.oficio} (buscado: ${clase.menciones.join(' / ')})`
    );
  }
});

test('roles.md states what each craft does NOT do and when it steps in', () => {
  const roles = leerPlaybook('roles');
  const negaciones = [...roles.matchAll(/\bNO\b/g)];
  assert.ok(negaciones.length >= 5, `cada oficio necesita su límite: hay ${negaciones.length} "NO" y son 5 oficios`);
  assert.ok(/entra/i.test(roles), 'roles.md tiene que decir cuándo entra cada uno');
  assert.ok(/consultar|consultale/i.test(roles), 'si algo es de otro oficio, se consulta en vez de invadirlo');
});

test('an unknown stack falls back to the web flow, like the rest of the playbooks', () => {
  const web = renderFlujo(DEFAULT_STACK);
  for (const raro of [undefined, null, '', 'cobol', 'movil']) {
    assert.equal(renderFlujo(raro), web, `renderFlujo(${JSON.stringify(raro)}) tiene que caer a ${DEFAULT_STACK}`);
  }
});

test('the work prompt wires the flow and the roles', () => {
  const motor = readFileSync(new URL('../server/lib/workforce.js', import.meta.url), 'utf-8');
  assert.ok(/renderFlujo\(goal\?\.stack\)/.test(motor), 'executeWork tiene que inyectar renderFlujo(goal?.stack)');
  assert.ok(/renderRoles\(\)/.test(motor), 'executeWork tiene que inyectar renderRoles()');
});

test('the flow and roles fit the work prompt budget', () => {
  // The project's measured rule: when documentation drowns the protocol, the
  // model stops emitting actions. The aggregate is measured whole, not per file.
  let peor = 0;
  for (const stack of STACKS) {
    const agregado = `${renderFlujo(stack)}\n${renderRoles()}`.length;
    peor = Math.max(peor, agregado);
  }
  assert.ok(peor <= 1800, `el agregado al prompt de trabajo llegó a ${peor} caracteres y el techo acordado es 1800`);
});

test('the work prompt craft docs have a measured ceiling', () => {
  // This used to be measured by comparing two doc blocks against each other (flow
  // + roles vs criteria + design), and that guard rewarded what must be avoided:
  // fattening the criteria to justify fattening the flow. What matters is the
  // total vs the protocol, which is what was measured when the model stopped
  // emitting actions. Measured on a real movil-rn project: the system protocol
  // weighs ~3,200 chars, so 4,200 of docs keeps the ratio at 1.3:1 — far from
  // the 7:1 that broke the runs.
  for (const stack of STACKS) {
    const doc = `${renderPlaybooks(stack)}\n${renderFlujo(stack)}\n${renderRoles()}`.length;
    assert.ok(
      doc <= 4200,
      `la documentación de oficio de ${stack} mide ${doc} caracteres y el techo medido es 4200: el protocolo de acciones compite con esto`
    );
  }
});

test('the design floor does not ask CSS from a niche that does no CSS', () => {
  // This was a real bug: diseno.md was written in web vocabulary and shipped
  // unchanged to all five niches. In movil-rn the prompt said "Colors and sizes
  // ALWAYS from tokens.css with var(--…)" three lines below "Styles with
  // StyleSheet.create. No CSS." — and a web page disguised as an app is exactly
  // what revisarReactNative() rejects later.
  const soloWeb = ['tokens.css', 'var(--', '<style', 'href="#"', 'prefers-reduced-motion', 'alt en'];
  for (const stack of STACKS) {
    const piso = renderDesignStandard(stack);
    assert.ok(piso.length > 200, `el piso de diseño de ${stack} tiene que decir algo`);
    if (stack === 'web') {
      continue;
    }
    for (const marca of soloWeb) {
      assert.ok(
        !piso.includes(marca),
        `el piso de diseño de ${stack} no puede nombrar "${marca}": ese nicho no entrega una pantalla web`
      );
    }
  }
  assert.ok(renderDesignStandard('web').includes('var(--'), 'en web el piso SÍ tiene que exigir var(--…)');
});

test('each niche names its own tokens file, not the web one', () => {
  // The engine says "if the project is empty write <tokens file>". If that
  // name is tokens.css in a React Native project, the run's first action
  // contradicts the niche playbook.
  assert.equal(archivoDeTokens('web'), 'tokens.css');
  assert.match(String(archivoDeTokens('movil-rn')), /theme\.js$/);
  assert.match(String(archivoDeTokens('android')), /Tokens\.kt$/);
  assert.equal(archivoDeTokens('python'), null, 'un programa de consola no tiene archivo de tokens');
  assert.equal(archivoDeTokens('cobol'), 'tokens.css', 'un stack desconocido cae a web como el resto');

  const motor = readFileSync(new URL('../server/lib/workforce.js', import.meta.url), 'utf-8');
  assert.ok(
    /archivoDeTokens\(goal\?\.stack\)/.test(motor),
    'executeWork tiene que nombrar el archivo de tokens del nicho, no uno fijo'
  );
  assert.ok(
    /renderDesignStandard\(goal\?\.stack\)/.test(motor),
    'la revisión tiene que juzgar contra el piso de diseño del nicho'
  );
});
