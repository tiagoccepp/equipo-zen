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

// El flujo del oficio: qué se hace primero, con qué comando se verifica y qué no
// hay que volver a tocar. Es lo que faltaba en las corridas reales — se escribían
// cinco archivos sin plan, el punto de entrada quedaba con la plantilla por
// defecto y los pasos se agotaban antes del finish.
//
// Todo lo de acá se mide contra los archivos y contra las plantillas: nada de
// nombres de empleados, que cambian con cada plantilla.

const TOPE_FLUJO = 900;
const TOPE_ROLES = 700;

const companyTemplates = JSON.parse(
  readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8')
);

function leerPlaybook(nombre) {
  return readFileSync(new URL(`../server/playbooks/${nombre}.md`, import.meta.url), 'utf-8').trim();
}

// Sin tildes y en minúsculas: el playbook está escrito para leerse, no para que
// el test adivine cómo se acentuó cada palabra.
function normalizar(texto) {
  return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// El comando con el que se verifica en cada nicho antes de dar algo por hecho.
// Es el mismo que ofrece la terminal del equipo (herramientas.js) y el que corre
// el motor para aceptar el finish.
const VERIFICACION = {
  web: 'node --check',
  automatizacion: 'node flujo.js',
  'movil-rn': 'npx tsc --noEmit',
  android: 'gradle assembleDebug',
  python: 'python3 main.py'
};

test('cada nicho declarado tiene su flujo, y el motor lo entrega', () => {
  for (const stack of STACKS) {
    const archivo = leerPlaybook(`flujo-${stack}`);
    assert.ok(archivo.length > 200, `flujo-${stack}.md tiene que existir y decir algo`);
    const render = renderFlujo(stack);
    assert.ok(render.includes(archivo), `renderFlujo('${stack}') tiene que traer flujo-${stack}.md entero`);
    assert.ok(/orden/i.test(render), `el flujo de ${stack} tiene que anunciar que el orden importa`);
  }
});

test('ningún flujo se pasa del presupuesto del prompt', () => {
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

test('cada flujo dice qué verificar y con qué comando exacto, antes del finish', () => {
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

test('los comandos que manda el flujo son comandos que la terminal permite', () => {
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

test('cada flujo es una lista numerada y sin saltos: el orden es el contenido', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    const pasos = [...flujo.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(pasos.length >= 4, `el flujo de ${stack} necesita al menos 4 pasos, tiene ${pasos.length}`);
    assert.deepEqual(pasos, pasos.map((_, i) => i + 1), `los pasos de ${stack} tienen que ir 1, 2, 3… sin saltos`);
  }
});

test('cada flujo nombra los errores de siempre del nicho y cuándo no iterar', () => {
  for (const stack of STACKS) {
    const flujo = leerPlaybook(`flujo-${stack}`);
    const errores = flujo.split(/ERRORES DE SIEMPRE:/)[1] || '';
    const listados = [...errores.matchAll(/^- /gm)];
    assert.ok(listados.length >= 2, `el flujo de ${stack} tiene que nombrar 2 o 3 errores típicos`);
    assert.ok(/NO ITERAR/.test(flujo), `el flujo de ${stack} tiene que decir qué dar por bueno y dejar quieto`);
  }
});

test('los errores de cada nicho son de ESE nicho, no advertencias genéricas', () => {
  // Lo que se rompe siempre en cada lugar. Si esto se vuelve genérico, el flujo
  // dejó de servir: el agente ya tiene el criterio técnico para lo general.
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

test('roles.md menciona los oficios que de verdad existen en las plantillas', () => {
  // Los oficios se derivan de las plantillas por role y por título, nunca por
  // nombre propio: Renata puede llamarse de otra forma mañana.
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

test('roles.md dice qué NO hace cada oficio y cuándo entra', () => {
  const roles = leerPlaybook('roles');
  const negaciones = [...roles.matchAll(/\bNO\b/g)];
  assert.ok(negaciones.length >= 5, `cada oficio necesita su límite: hay ${negaciones.length} "NO" y son 5 oficios`);
  assert.ok(/entra/i.test(roles), 'roles.md tiene que decir cuándo entra cada uno');
  assert.ok(/consultar|consultale/i.test(roles), 'si algo es de otro oficio, se consulta en vez de invadirlo');
});

test('un stack desconocido cae al flujo de web, como el resto de los playbooks', () => {
  const web = renderFlujo(DEFAULT_STACK);
  for (const raro of [undefined, null, '', 'cobol', 'movil']) {
    assert.equal(renderFlujo(raro), web, `renderFlujo(${JSON.stringify(raro)}) tiene que caer a ${DEFAULT_STACK}`);
  }
});

test('el prompt de trabajo enchufa el flujo y los roles', () => {
  const motor = readFileSync(new URL('../server/lib/workforce.js', import.meta.url), 'utf-8');
  assert.ok(/renderFlujo\(goal\?\.stack\)/.test(motor), 'executeWork tiene que inyectar renderFlujo(goal?.stack)');
  assert.ok(/renderRoles\(\)/.test(motor), 'executeWork tiene que inyectar renderRoles()');
});

test('el flujo y los roles caben en el presupuesto del prompt de trabajo', () => {
  // La regla medida del proyecto: cuando la documentación tapa al protocolo, el
  // modelo deja de emitir acciones. El agregado se mide entero, no por archivo.
  let peor = 0;
  for (const stack of STACKS) {
    const agregado = `${renderFlujo(stack)}\n${renderRoles()}`.length;
    peor = Math.max(peor, agregado);
  }
  assert.ok(peor <= 1800, `el agregado al prompt de trabajo llegó a ${peor} caracteres y el techo acordado es 1800`);
});

test('la documentación de oficio del prompt de trabajo tiene techo medido', () => {
  // Antes esto se medía comparando dos bloques de documentación entre sí (flujo
  // + roles contra criterio + diseño), y ese guard premiaba lo que hay que
  // evitar: engordar el criterio para poder engordar el flujo. Lo que importa es
  // el total contra el protocolo, que es lo que se midió cuando el modelo dejó
  // de emitir acciones. Medido en un proyecto movil-rn real: el protocolo del
  // system pesa ~3.200 caracteres, así que 4.200 de documentación deja la
  // relación en 1,3:1 — lejos del 7:1 que rompió las corridas.
  for (const stack of STACKS) {
    const doc = `${renderPlaybooks(stack)}\n${renderFlujo(stack)}\n${renderRoles()}`.length;
    assert.ok(
      doc <= 4200,
      `la documentación de oficio de ${stack} mide ${doc} caracteres y el techo medido es 4200: el protocolo de acciones compite con esto`
    );
  }
});

test('el piso de diseño no le pide CSS a un nicho que no hace CSS', () => {
  // Esto era un bug real: diseno.md estaba escrito en vocabulario web y viajaba
  // igual a los cinco nichos. En movil-rn el prompt decía "Colores y medidas
  // SIEMPRE desde tokens.css con var(--…)" tres líneas debajo de "Estilos con
  // StyleSheet.create. Nada de CSS." — y una web disfrazada de app es exactamente
  // lo que revisarReactNative() rechaza después.
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

test('cada nicho nombra su propio archivo de tokens, no el de web', () => {
  // El motor le dice "si el proyecto está vacío escribí <archivo de tokens>". Si
  // ese nombre es tokens.css en un proyecto React Native, la primera acción de la
  // corrida contradice el playbook del nicho.
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
