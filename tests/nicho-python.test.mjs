import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { companyTemplates } from '../server/lib/config.js';
import { Store } from '../server/lib/store.js';
import { STACKS, normalizeStack, renderPlaybooks } from '../server/lib/playbooks.js';
import { inferirArchivo } from '../server/lib/inferir-archivo.js';
import { renderHerramientas } from '../server/lib/herramientas.js';
import {
  archivosPython,
  compilarPython,
  construirApp,
  detectarProyecto,
  parsearErroresPython,
  renderBuildReport
} from '../server/lib/native-build.js';
import {
  WORKSPACE_ROOT,
  esProyectoCompilado,
  esProyectoMovil,
  projectDir,
  safeWorkspacePath
} from '../server/lib/workforce.js';

// El quinto estudio: desarrollo en Python. Lo que se prueba acá es la promesa
// del nicho — que el estudio exista con su equipo, que el proyecto reciba el
// criterio de Python y no el de web, que cuatro personas puedan escribir cuatro
// archivos .py distintos a la vez, y que un programa que no compila no pase por
// entregado.
//
// Nada de esto se apoya en los nombres de la plantilla: se filtra por stack y
// por role, porque las plantillas cambian y los tests no.

const PLANTILLA = () => {
  const template = companyTemplates.templates.find((t) => t.stack === 'python');
  assert.ok(template, 'hay una plantilla de nicho python');
  return template;
};

function carpetaTemporal(t, nombre = 'proyecto') {
  const dir = path.join(
    process.env.TMPDIR || '/tmp',
    `equipo-py-${nombre}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function escribir(dir, relativo, contenido) {
  const destino = path.join(dir, relativo);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, contenido, 'utf-8');
  return destino;
}

// ── El estudio ──────────────────────────────────────────────────────────────

test('el estudio de Python existe con seis personas: quien coordina, quien afina perfiles y cuatro que producen', () => {
  const template = PLANTILLA();

  assert.equal(template.employees.length, 6);
  assert.equal(template.employees.filter((e) => e.role === 'ceo').length, 1);
  assert.equal(template.employees.filter((e) => e.role === 'contratista').length, 1);
  assert.equal(template.employees.filter((e) => e.role === 'worker').length, 4);

  // La forma tiene que ser la misma que la de los otros cuatro estudios: el
  // cliente y el store leen estos campos sin preguntar de qué nicho vienen.
  const campos = ['name', 'title', 'role', 'voice', 'color', 'aliases', 'skills', 'knowledge', 'boundaries', 'style', 'craft'];
  for (const empleado of template.employees) {
    for (const campo of campos) {
      assert.ok(empleado[campo] !== undefined && empleado[campo] !== '', `${empleado.name} tiene ${campo}`);
    }
    assert.match(empleado.voice, /^[MF][1-5]$/, `${empleado.name} tiene una voz del catálogo`);
    assert.match(empleado.color, /^#[0-9a-f]{6}$/i);
    assert.ok(Array.isArray(empleado.aliases) && empleado.aliases.length >= 2);
    assert.ok(Array.isArray(empleado.skills) && empleado.skills.length >= 4);
    assert.ok(Array.isArray(empleado.boundaries) && empleado.boundaries.length >= 2);
  }

  // Los craft son criterio de oficio, no adjetivos: hablan de decisiones
  // concretas de Python. Si esto vuelve a ser "prolijo y detallista", el agente
  // no gana nada al leerlo.
  const craft = template.employees.filter((e) => e.role === 'worker').map((e) => e.craft).join(' ').toLowerCase();
  assert.match(craft, /biblioteca est[aá]ndar|requirements\.txt|entorno virtual/);
  assert.match(craft, /excepci[oó]n|tests\/test_|tmp_path|c[oó]digo de salida/);
});

test('una empresa creada con la plantilla de Python hereda el nicho en sus proyectos', (t) => {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(PLANTILLA(), 'test');
  const project = store.createProject({ companyId: company.id, title: 'Ordenar los CSV del club' });

  assert.equal(company.stack, 'python');
  assert.equal(project.stack, 'python', 'el proyecto hereda el nicho de su empresa');

  // El equipo llegó completo y por oficio, no por nombre.
  const equipo = store.listAgents(company.id);
  assert.equal(equipo.filter((a) => a.role === 'worker').length, 4);
  assert.ok(equipo.some((a) => /\bqa\b|calidad|prueba/i.test(a.title)), 'hay alguien que prueba');
  assert.ok(equipo.some((a) => /python|software|dev/i.test(a.title)), 'hay alguien que programa');

  t.after(() => store.close?.());
});

// ── El stack y su criterio ──────────────────────────────────────────────────

test('el stack python se normaliza y trae SU criterio, no el de web', () => {
  assert.ok(STACKS.includes('python'));
  assert.equal(normalizeStack('python'), 'python');
  // Un valor inventado sigue cayendo a web: nadie queda sin playbook.
  assert.equal(normalizeStack('phyton'), 'web');
  assert.equal(normalizeStack(undefined), 'web');

  const criterio = renderPlaybooks('python');
  assert.ok(criterio.length > 0, 'el playbook de python llega al prompt de trabajo');
  assert.match(criterio, /main\.py/);
  assert.match(criterio, /venv/);
  assert.match(criterio, /pytest/);
  assert.match(criterio, /SIN RED/);
  // El criterio de web (un index.html con el CSS embebido) no tiene que estar:
  // si se filtra, el equipo entrega una página en vez de un programa.
  assert.ok(!/index\.html con el CSS embebido/.test(criterio), 'no se cuela el criterio de web');

  // Presupuesto del prompt: el criterio técnico de python no puede pesar más
  // que el del nicho más caro que ya existe.
  const tecnico = criterio.split('━━━')[0];
  assert.ok(tecnico.length < 2000, `el criterio de python pesa ${tecnico.length} caracteres`);
});

test('la terminal del nicho ofrece los comandos de Python y el proyecto entra en los que tienen que compilar', () => {
  const bloque = renderHerramientas('python');
  assert.match(bloque, /python3 main\.py/);
  assert.match(bloque, /python3 -m pytest/);
  assert.match(bloque, /python3 -m venv/);
  assert.match(bloque, /pip install -r requirements\.txt/);
  assert.match(bloque, /python3 -m ruff check/);

  // Python compila, pero NO es un proyecto móvil: no se le pide un emulador.
  assert.equal(esProyectoCompilado('python'), true);
  assert.equal(esProyectoMovil('python'), false);
  assert.equal(esProyectoCompilado('web'), false);
});

// ── El reparto de archivos ──────────────────────────────────────────────────

test('cuatro tareas de un proyecto Python reciben cuatro archivos distintos', () => {
  const tareas = [
    'Escribir la lógica que procesa las inscripciones',
    'Leer y validar los datos del CSV de socios',
    'Armar las pruebas con pytest de los casos borde',
    'Documentar en el README cómo se corre'
  ];

  const tomados = new Set();
  const asignados = tareas.map((texto) => {
    const archivo = inferirArchivo(texto, 'python', [], tomados);
    assert.ok(archivo, `la tarea "${texto}" recibió archivo`);
    tomados.add(archivo);
    return archivo;
  });

  // El cerrojo es por ARCHIVO: si dos caen en el mismo, el paralelismo se apaga.
  assert.equal(new Set(asignados).size, 4, `se repitió un archivo: ${asignados.join(', ')}`);
  assert.ok(asignados.filter((a) => a.endsWith('.py')).length >= 3, 'la mayoría son módulos de Python');
  assert.ok(asignados.includes('README.md'));
  assert.ok(asignados.some((a) => /^tests\/test_.+\.py$/.test(a)), 'las pruebas van a tests/test_*.py');
  assert.ok(asignados.some((a) => a.startsWith('src/') && a.endsWith('.py')), 'lo que crece va a src/<modulo>.py');
});

test('las pistas de Python mandan cada cosa a su archivo', () => {
  assert.equal(inferirArchivo('Escribir el punto de entrada con argparse', 'python'), 'main.py');
  assert.equal(inferirArchivo('Fijar las dependencias en requirements', 'python'), 'requirements.txt');
  assert.equal(inferirArchivo('Instructivo de uso', 'python'), 'README.md');
  assert.match(inferirArchivo('Pruebas del cálculo de cuotas', 'python'), /^tests\/test_/);
  assert.equal(inferirArchivo('Validación de los datos de entrada', 'python'), 'src/datos.py');
  assert.equal(inferirArchivo('El algoritmo que calcula el total', 'python'), 'src/nucleo.py');
  // Sin ninguna pista igual sale un archivo: una tarea sin archivo toma el
  // proyecto entero en exclusiva y apaga el trabajo en paralelo.
  assert.equal(inferirArchivo('Che, avanzá con lo tuyo', 'python'), 'main.py');
  // Y si el proyecto ya tiene ese módulo, se continúa en vez de crear al lado.
  assert.equal(inferirArchivo('Ajustar el cobrador', 'python', ['src/cobrador.py']), 'src/cobrador.py');
});

// ── El sandbox ──────────────────────────────────────────────────────────────

test('el sandbox deja escribir los archivos de un proyecto Python y sigue rechazando lo peligroso', (t) => {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(PLANTILLA(), 'test');
  const project = store.createProject({ companyId: company.id, title: 'Conciliador de pagos' });
  t.after(() => {
    rmSync(path.join(WORKSPACE_ROOT, String(company.id)), { recursive: true, force: true });
    store.close?.();
  });

  for (const relativo of ['main.py', 'src/nucleo.py', 'tests/test_nucleo.py', 'requirements.txt', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'README.md']) {
    const destino = safeWorkspacePath(company.id, project.slug, relativo);
    assert.ok(destino.startsWith(projectDir(company.id, project.slug)), `${relativo} cae dentro del proyecto`);
  }

  // La guardia no se relaja por sumar un nicho: sigue rechazando lo mismo.
  const prohibidos = [
    '../fuera.py',
    '../../otro/proyecto/main.py',
    '/etc/passwd',
    '/tmp/main.py',
    '.ssh/id_rsa',
    '.venv/bin/activate',
    'src/../../escape.py',
    'instalar.sh',
    'binario.so',
    'programa.pyc',
    ''
  ];
  for (const relativo of prohibidos) {
    assert.throws(
      () => safeWorkspacePath(company.id, project.slug, relativo),
      `debería rechazar ${relativo || '(vacío)'}`
    );
  }
});

// ── Que compile de verdad ───────────────────────────────────────────────────

test('un .py con error de sintaxis se detecta con su archivo y su línea', async (t) => {
  const dir = carpetaTemporal(t, 'roto');
  escribir(dir, 'main.py', [
    'import sys',
    '',
    'def sumar(a, b)',
    '    return a + b',
    '',
    'print(sumar(1, 2))',
    ''
  ].join('\n'));

  assert.equal(detectarProyecto(dir), 'python');

  const build = await compilarPython(dir);
  if (build.saltado) {
    t.skip(`sin Python en esta máquina: ${build.motivo}`);
    return;
  }

  assert.equal(build.ok, false);
  const error = build.errores.find((e) => e.archivo.endsWith('main.py'));
  assert.ok(error, `ningún error apunta a main.py: ${JSON.stringify(build.errores)}`);
  assert.equal(error.linea, 3, 'la línea es la del def sin los dos puntos');
  assert.match(error.que, /SyntaxError/);

  // El .pyc no se deja adentro del entregable del usuario.
  assert.ok(!existsSync(path.join(dir, '__pycache__')), 'no queda __pycache__ en el proyecto');
});

test('la falla más común de un modelo —la indentación— también sale con archivo y línea', () => {
  // Python emite este caso en un formato distinto del de SyntaxError: viene
  // todo en un renglón que empieza con "Sorry:". Parsear solo el otro dejaba la
  // falla más frecuente sin ubicación.
  const errores = parsearErroresPython(
    "Sorry: IndentationError: expected an indented block after 'if' statement on line 2 (main.py, line 3)"
  );
  assert.equal(errores.length, 1);
  assert.equal(errores[0].archivo, 'main.py');
  assert.equal(errores[0].linea, 3);
  assert.match(errores[0].que, /IndentationError/);

  const tabs = parsearErroresPython(
    'Sorry: TabError: inconsistent use of tabs and spaces in indentation (src/nucleo.py, line 7)'
  );
  assert.equal(tabs[0].archivo, 'src/nucleo.py');
  assert.equal(tabs[0].linea, 7);

  // Y el formato clásico, con el mensaje unos renglones más abajo.
  const clasico = parsearErroresPython([
    '  File "src/datos.py", line 12',
    '    with open(ruta) as f',
    '                       ^',
    "SyntaxError: expected ':'"
  ].join('\n'));
  assert.equal(clasico[0].archivo, 'src/datos.py');
  assert.equal(clasico[0].linea, 12);
  assert.match(clasico[0].que, /SyntaxError: expected/);

  // Sin nada reconocible se devuelve algo útil igual, nunca una lista vacía.
  const raro = parsearErroresPython('todo explotó de una manera nueva', 'main.py');
  assert.equal(raro.length, 1);
  assert.equal(raro[0].archivo, 'main.py');
});

test('un proyecto Python que compila pasa, y el informe solo aparece cuando no', async (t) => {
  const dir = carpetaTemporal(t, 'sano');
  escribir(dir, 'main.py', [
    'import argparse',
    '',
    'from src.nucleo import total',
    '',
    '',
    'def main() -> int:',
    '    parser = argparse.ArgumentParser(description="Suma las cuotas del mes")',
    '    parser.add_argument("--archivo", default="datos/ejemplo.csv")',
    '    args = parser.parse_args()',
    '    print(total([1, 2, 3]), args.archivo)',
    '    return 0',
    '',
    '',
    'if __name__ == "__main__":',
    '    raise SystemExit(main())',
    ''
  ].join('\n'));
  escribir(dir, 'src/nucleo.py', [
    'def total(valores: list[int]) -> int:',
    '    return sum(valores)',
    ''
  ].join('\n'));
  escribir(dir, 'tests/test_nucleo.py', [
    'from src.nucleo import total',
    '',
    '',
    'def test_total_de_una_lista_vacia_es_cero():',
    '    assert total([]) == 0',
    ''
  ].join('\n'));

  const build = await construirApp(dir, 'python');
  if (build.saltado) {
    t.skip(`sin Python en esta máquina: ${build.motivo}`);
    return;
  }

  assert.equal(build.tipo, 'python');
  assert.equal(build.ok, true, `no compiló: ${JSON.stringify(build.errores)}`);
  assert.equal(renderBuildReport(build), '', 'si compiló no hay informe que leer');

  // El informe de una falla le dice qué archivo, qué línea y que arregle antes
  // de cerrar, igual que el de Kotlin.
  const informe = renderBuildReport({
    tipo: 'python',
    ok: false,
    errores: [{ archivo: 'src/nucleo.py', linea: 12, que: "SyntaxError: expected ':'" }]
  });
  assert.match(informe, /EL PROGRAMA NO COMPILA/);
  assert.match(informe, /src\/nucleo\.py:12/);
  assert.match(informe, /finish/);
});

test('en un proyecto Python, entregar una web o no entregar nada no cuenta como entregado', async (t) => {
  const vacio = carpetaTemporal(t, 'vacio');
  escribir(vacio, 'README.md', '# Conciliador\n');

  const sinPrograma = await construirApp(vacio, 'python');
  assert.equal(sinPrograma.ok, false);
  assert.match(sinPrograma.errores.map((e) => e.que).join(' '), /ning[uú]n archivo \.py/);
  assert.match(renderBuildReport(sinPrograma), /NO ES UN PROGRAMA PYTHON/);

  const web = carpetaTemporal(t, 'web');
  escribir(web, 'index.html', '<!doctype html><html lang="es"><body><h1>Hola</h1></body></html>');

  const disfrazada = await construirApp(web, 'python');
  assert.equal(disfrazada.ok, false);
  assert.match(disfrazada.errores.map((e) => e.que).join(' '), /p[aá]gina web/);
});

test('detectar el nicho no confunde un .py suelto con un proyecto móvil ni al revés', async (t) => {
  // Un proyecto Android con un script .py adentro sigue siendo Android.
  const android = carpetaTemporal(t, 'android');
  escribir(android, 'settings.gradle.kts', 'rootProject.name = "app"');
  escribir(android, 'tools/generar.py', 'print("hola")\n');
  assert.equal(detectarProyecto(android), 'android');

  // Y un proyecto de nicho móvil que entregó solo un .py no pasa por app.
  const soloPy = carpetaTemporal(t, 'solo-py');
  escribir(soloPy, 'main.py', 'print("hola")\n');
  assert.equal(detectarProyecto(soloPy), 'python');

  const comoApp = await construirApp(soloPy, 'android');
  assert.equal(comoApp.ok, false);
  assert.match(comoApp.errores.map((e) => e.que).join(' '), /no es una app Android/);

  // Una carpeta sin nada tampoco es un proyecto Python.
  const nada = carpetaTemporal(t, 'nada');
  escribir(nada, 'notas.md', 'nada todavía');
  assert.equal(detectarProyecto(nada), null);
});

test('los intermedios y el entorno virtual no se compilan ni se listan', (t) => {
  const dir = carpetaTemporal(t, 'intermedios');
  escribir(dir, 'main.py', 'print(1)\n');
  escribir(dir, 'src/datos.py', 'DATOS = []\n');
  escribir(dir, '__pycache__/main.cpython-314.py', 'basura\n');
  escribir(dir, '.venv/lib/python3.14/site-packages/requests/api.py', 'def get(): ...\n');
  escribir(dir, 'venv/lib/otro.py', 'x = 1\n');

  const encontrados = archivosPython(dir);
  assert.deepEqual(encontrados, ['main.py', 'src/datos.py']);
  // Y la carpeta existe: no se filtró porque no estuviera.
  assert.ok(readdirSync(dir).includes('__pycache__'));
});
