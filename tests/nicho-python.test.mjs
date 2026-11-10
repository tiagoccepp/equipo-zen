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

// The fifth studio: Python development. What is tested here is the niche's
// promise — that the studio exists with its team, that the project receives the
// Python criteria and not web's, that four people can write four different
// .py files at once, and that a program that does not compile never passes as
// delivered.
//
// None of this relies on template names: it filters by stack and by role,
// because templates change and tests do not.

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

// ── The studio ──────────────────────────────────────────────────────────────

test('the Python studio exists with six people: one coordinating, one tuning profiles, and four producing', () => {
  const template = PLANTILLA();

  assert.equal(template.employees.length, 6);
  assert.equal(template.employees.filter((e) => e.role === 'ceo').length, 1);
  assert.equal(template.employees.filter((e) => e.role === 'contratista').length, 1);
  assert.equal(template.employees.filter((e) => e.role === 'worker').length, 4);

  // The shape must match the other four studios: the client and the store
  // read these fields without asking which niche they come from.
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

  // Craft fields are trade judgment, not adjectives: they talk about concrete
  // Python decisions. If this ever goes back to "prolijo y detallista", the agent
  // gains nothing from reading it.
  const craft = template.employees.filter((e) => e.role === 'worker').map((e) => e.craft).join(' ').toLowerCase();
  assert.match(craft, /biblioteca est[aá]ndar|requirements\.txt|entorno virtual/);
  assert.match(craft, /excepci[oó]n|tests\/test_|tmp_path|c[oó]digo de salida/);
});

test('a company created from the Python template inherits the niche in its projects', (t) => {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(PLANTILLA(), 'test');
  const project = store.createProject({ companyId: company.id, title: 'Ordenar los CSV del club' });

  assert.equal(company.stack, 'python');
  assert.equal(project.stack, 'python', 'el proyecto hereda el nicho de su empresa');

  // The team arrived complete and by trade, not by name.
  const equipo = store.listAgents(company.id);
  assert.equal(equipo.filter((a) => a.role === 'worker').length, 4);
  assert.ok(equipo.some((a) => /\bqa\b|calidad|prueba/i.test(a.title)), 'hay alguien que prueba');
  assert.ok(equipo.some((a) => /python|software|dev/i.test(a.title)), 'hay alguien que programa');

  t.after(() => store.close?.());
});

// ── The stack and its criteria ──────────────────────────────────────────────────

test("the python stack normalizes and brings ITS criteria, not web's", () => {
  assert.ok(STACKS.includes('python'));
  assert.equal(normalizeStack('python'), 'python');
  // A made-up value still falls back to web: nobody is left without a playbook.
  assert.equal(normalizeStack('phyton'), 'web');
  assert.equal(normalizeStack(undefined), 'web');

  const criterio = renderPlaybooks('python');
  assert.ok(criterio.length > 0, 'el playbook de python llega al prompt de trabajo');
  assert.match(criterio, /main\.py/);
  assert.match(criterio, /venv/);
  assert.match(criterio, /pytest/);
  assert.match(criterio, /SIN RED/);
  // The web criteria (an index.html with embedded CSS) must not be there:
  // if it leaks, the team ships a page instead of a program.
  assert.ok(!/index\.html con el CSS embebido/.test(criterio), 'no se cuela el criterio de web');

  // Prompt budget: the python technical criteria cannot weigh more than the
  // most expensive existing niche.
  const tecnico = criterio.split('━━━')[0];
  assert.ok(tecnico.length < 2000, `el criterio de python pesa ${tecnico.length} caracteres`);
});

test('the niche terminal offers the Python commands and the project counts as one that must compile', () => {
  const bloque = renderHerramientas('python');
  assert.match(bloque, /python3 main\.py/);
  assert.match(bloque, /python3 -m pytest/);
  assert.match(bloque, /python3 -m venv/);
  assert.match(bloque, /pip install -r requirements\.txt/);
  assert.match(bloque, /python3 -m ruff check/);

  // Python compiles, but it is NOT a mobile project: no emulator is asked of it.
  assert.equal(esProyectoCompilado('python'), true);
  assert.equal(esProyectoMovil('python'), false);
  assert.equal(esProyectoCompilado('web'), false);
});

// ── File assignment ──────────────────────────────────────────────────

test('four tasks in a Python project receive four different files', () => {
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

  // The lock is per FILE: if two land on the same one, parallelism switches off.
  assert.equal(new Set(asignados).size, 4, `se repitió un archivo: ${asignados.join(', ')}`);
  assert.ok(asignados.filter((a) => a.endsWith('.py')).length >= 3, 'la mayoría son módulos de Python');
  assert.ok(asignados.includes('README.md'));
  assert.ok(asignados.some((a) => /^tests\/test_.+\.py$/.test(a)), 'las pruebas van a tests/test_*.py');
  assert.ok(asignados.some((a) => a.startsWith('src/') && a.endsWith('.py')), 'lo que crece va a src/<modulo>.py');
});

test('Python hints send each thing to its file', () => {
  assert.equal(inferirArchivo('Escribir el punto de entrada con argparse', 'python'), 'main.py');
  assert.equal(inferirArchivo('Fijar las dependencias en requirements', 'python'), 'requirements.txt');
  assert.equal(inferirArchivo('Instructivo de uso', 'python'), 'README.md');
  assert.match(inferirArchivo('Pruebas del cálculo de cuotas', 'python'), /^tests\/test_/);
  assert.equal(inferirArchivo('Validación de los datos de entrada', 'python'), 'src/datos.py');
  assert.equal(inferirArchivo('El algoritmo que calcula el total', 'python'), 'src/nucleo.py');
  // With no hints at all a file still comes out: a task without a file takes
  // the whole project exclusively and switches off parallel work.
  assert.equal(inferirArchivo('Che, avanzá con lo tuyo', 'python'), 'main.py');
  // And if the project already has that module, it continues there instead of creating alongside.
  assert.equal(inferirArchivo('Ajustar el cobrador', 'python', ['src/cobrador.py']), 'src/cobrador.py');
});

// ── The sandbox ──────────────────────────────────────────────────────────────

test('the sandbox lets Python project files be written and still rejects dangerous paths', (t) => {
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

  // The guard does not relax for adding a niche: it keeps rejecting the same paths.
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

// ── That it really compiles ───────────────────────────────────────────────────

test('a .py with a syntax error is detected with its file and line', async (t) => {
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

  // The .pyc is not left inside the user's deliverable.
  assert.ok(!existsSync(path.join(dir, '__pycache__')), 'no queda __pycache__ en el proyecto');
});

test('the most common model failure —indentation— also comes out with file and line', () => {
  // Python emits this case in a different format than SyntaxError: it all
  // comes on one line starting with "Sorry:". Parsing only the other one left the
  // most frequent failure without a location.
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

  // And the classic format, with the message a few lines below.
  const clasico = parsearErroresPython([
    '  File "src/datos.py", line 12',
    '    with open(ruta) as f',
    '                       ^',
    "SyntaxError: expected ':'"
  ].join('\n'));
  assert.equal(clasico[0].archivo, 'src/datos.py');
  assert.equal(clasico[0].linea, 12);
  assert.match(clasico[0].que, /SyntaxError: expected/);

  // With nothing recognizable something useful is still returned, never an empty list.
  const raro = parsearErroresPython('todo explotó de una manera nueva', 'main.py');
  assert.equal(raro.length, 1);
  assert.equal(raro[0].archivo, 'main.py');
});

test('a Python project that compiles passes, and the report only appears when it does not', async (t) => {
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

  // A failure report tells which file, which line, and to fix before closing,
  // just like the Kotlin one.
  const informe = renderBuildReport({
    tipo: 'python',
    ok: false,
    errores: [{ archivo: 'src/nucleo.py', linea: 12, que: "SyntaxError: expected ':'" }]
  });
  assert.match(informe, /EL PROGRAMA NO COMPILA/);
  assert.match(informe, /src\/nucleo\.py:12/);
  assert.match(informe, /finish/);
});

test('in a Python project, shipping a web page or shipping nothing does not count as delivered', async (t) => {
  const vacio = carpetaTemporal(t, 'vacio');
  escribir(vacio, 'README.md', '# Conciliador\n');

  const sinPrograma = await construirApp(vacio, 'python');
  assert.equal(sinPrograma.ok, false);
  assert.match(sinPrograma.errores.map((e) => e.que).join(' '), /no \.py files/);
  assert.match(renderBuildReport(sinPrograma), /NO ES UN PROGRAMA PYTHON/);

  const web = carpetaTemporal(t, 'web');
  escribir(web, 'index.html', '<!doctype html><html lang="es"><body><h1>Hola</h1></body></html>');

  const disfrazada = await construirApp(web, 'python');
  assert.equal(disfrazada.ok, false);
  assert.match(disfrazada.errores.map((e) => e.que).join(' '), /web page/);
});

test('niche detection does not confuse a stray .py with a mobile project nor vice versa', async (t) => {
  // An Android project with a .py script inside is still Android.
  const android = carpetaTemporal(t, 'android');
  escribir(android, 'settings.gradle.kts', 'rootProject.name = "app"');
  escribir(android, 'tools/generar.py', 'print("hola")\n');
  assert.equal(detectarProyecto(android), 'android');

  // And a mobile-niche project that shipped only a .py does not pass as an app.
  const soloPy = carpetaTemporal(t, 'solo-py');
  escribir(soloPy, 'main.py', 'print("hola")\n');
  assert.equal(detectarProyecto(soloPy), 'python');

  const comoApp = await construirApp(soloPy, 'android');
  assert.equal(comoApp.ok, false);
  assert.match(comoApp.errores.map((e) => e.que).join(' '), /not an Android app/);

  // A folder with nothing is not a Python project either.
  const nada = carpetaTemporal(t, 'nada');
  escribir(nada, 'notas.md', 'nada todavía');
  assert.equal(detectarProyecto(nada), null);
});

test('intermediates and the virtualenv are neither compiled nor listed', (t) => {
  const dir = carpetaTemporal(t, 'intermedios');
  escribir(dir, 'main.py', 'print(1)\n');
  escribir(dir, 'src/datos.py', 'DATOS = []\n');
  escribir(dir, '__pycache__/main.cpython-314.py', 'basura\n');
  escribir(dir, '.venv/lib/python3.14/site-packages/requests/api.py', 'def get(): ...\n');
  escribir(dir, 'venv/lib/otro.py', 'x = 1\n');

  const encontrados = archivosPython(dir);
  assert.deepEqual(encontrados, ['main.py', 'src/datos.py']);
  // And the folder exists: it was not filtered out for being missing.
  assert.ok(readdirSync(dir).includes('__pycache__'));
});
