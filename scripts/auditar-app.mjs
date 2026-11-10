// Audits the STRUCTURE of a deliverable: is what's in that folder a well-built app
// or just loose files that look like one?
//
// It doesn't reimplement what already exists. Content verification is done by
// verify.js (balanced HTML, title, description, remote resources, broken
// references, JS that doesn't parse) and the "this is a real app" check is done by
// native-build.js (revisarReactNative, compilarPython, detectarProyecto). Only
// what neither of them looks at goes here: that the files the niche's
// STRUCTURE requires are present and fit together (the module namespace
// against the code package, the entry point against the screens).
//
//   node scripts/auditar-app.mjs <folder> [stack]
//   node scripts/auditar-app.mjs --workspace          # everything in workspace/
//   node scripts/auditar-app.mjs <folder> --json
//
// Without a stack, it infers it with detectarProyecto() and says so. With --workspace
// it takes it from the DB (goals.stack), which is the source of truth.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { verifyProject } from '../server/lib/verify.js';
import { archivosPython, compilarPython, detectarProyecto, revisarReactNative } from '../server/lib/native-build.js';
import { esCarpetaIgnorada } from '../server/lib/workforce.js';
import { normalizeStack } from '../server/lib/playbooks.js';

// ── Folder reading ──────────────────────────────────────────────────────────

// Same filter the engine uses: without this, after a build the listing
// returns thousands of intermediates and the audit measures garbage.
function listar(base, prefijo = '') {
  const out = [];
  let entradas = [];
  try {
    entradas = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entradas) {
    if (e.name.startsWith('.') || esCarpetaIgnorada(e.name)) {
      continue;
    }
    const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...listar(path.join(base, e.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function leer(dir, rel) {
  try {
    return readFileSync(path.join(dir, rel), 'utf-8');
  } catch {
    return '';
  }
}

function json(dir, rel) {
  const texto = leer(dir, rel);
  if (!texto) {
    return { existe: false, valido: false, datos: null };
  }
  try {
    return { existe: true, valido: true, datos: JSON.parse(texto) };
  } catch {
    return { existe: true, valido: false, datos: null };
  }
}

// ── The report ──────────────────────────────────────────────────────────────

// A report with two columns: what is there and what is missing. The verdict comes from
// nothing critical missing, not from a made-up grade.
function nuevaActa() {
  const bien = [];
  const mal = [];
  return {
    bien,
    mal,
    ok(que) {
      bien.push(que);
    },
    falta(que, grave = true) {
      mal.push({ que, grave });
    },
    // Sugar for the most common case: "exists or missing".
    archivo(existe, nombre, detalle = '', grave = true) {
      if (existe) {
        bien.push(`${nombre}${detalle ? ` — ${detalle}` : ''}`);
      } else {
        mal.push({ que: `falta ${nombre}${detalle ? ` (${detalle})` : ''}`, grave });
      }
      return existe;
    }
  };
}

// ── What all niches share ───────────────────────────────────────────────────

// verify.js measures the CONTENT of what can be measured without running. The
// project's full file list is passed separately, because one file may reference
// another and without that list something that exists gets reported as broken.
function verificarContenido(dir, archivos, acta, { soloEstos = null } = {}) {
  const candidatos = (soloEstos || archivos).filter((rel) => /\.(html?|css|js|mjs|md|txt)$/i.test(rel));
  const mapa = new Map();
  for (const rel of candidatos) {
    // A huge file is not verified: verify.js works with regex and reading
    // a bundle adds nothing.
    let tamano = 0;
    try {
      tamano = statSync(path.join(dir, rel)).size;
    } catch {
      continue;
    }
    if (tamano > 400 * 1024) {
      continue;
    }
    mapa.set(rel, leer(dir, rel));
  }
  const hallazgos = verifyProject(mapa, archivos);
  if (hallazgos.length === 0) {
    if (mapa.size) {
      acta.ok(`la verificación de contenido pasa limpia en ${mapa.size} archivo(s)`);
    }
    return;
  }
  for (const h of hallazgos.slice(0, 12)) {
    // JS that doesn't parse and broken references are structural; the rest
    // (placeholders, English, a hand-picked color) is quality and doesn't fail the app.
    const estructural = /no parsea|no existen|balanceado|remoto/i.test(h.que);
    acta.falta(`[${h.archivo}] ${h.que}`, estructural);
  }
  if (hallazgos.length > 12) {
    acta.falta(`y ${hallazgos.length - 12} hallazgo(s) más de la verificación de contenido`, false);
  }
}

// ── web ─────────────────────────────────────────────────────────────────────

async function auditarWeb(dir, archivos, acta) {
  const entrada = archivos.find((rel) => /^index\.html?$/i.test(rel));
  if (!acta.archivo(Boolean(entrada), 'index.html', 'el punto de entrada del sitio')) {
    const otroHtml = archivos.filter((rel) => /\.html?$/i.test(rel));
    if (otroHtml.length) {
      acta.falta(`hay HTML (${otroHtml.slice(0, 3).join(', ')}) pero ninguno se llama index.html: no abre solo`);
    }
    return;
  }

  const html = leer(dir, entrada);
  // Document structure. verify.js already measures title, description and lang, but
  // it takes for granted that this is a document: if there is no <html>/<head>/<body>
  // it doesn't even bother looking at the head, so that is checked here.
  for (const [tag, porque] of [['html', 'el documento'], ['head', 'la cabecera'], ['body', 'el cuerpo']]) {
    acta.archivo(new RegExp(`<${tag}[\\s>]`, 'i').test(html), `<${tag}>`, porque);
  }

  // Tokens: the only coordination artifact the project keeps. Valid either
  // as a separate file or as an embedded :root — both forms are legitimate.
  const tokensAparte = archivos.some((rel) => /tokens\.css$/i.test(rel));
  const rootEmbebido = /:root\s*\{/i.test(html);
  const rootEnCss = archivos
    .filter((rel) => /\.css$/i.test(rel))
    .some((rel) => /:root\s*\{/i.test(leer(dir, rel)));
  if (tokensAparte || rootEmbebido || rootEnCss) {
    acta.ok(`identidad visual declarada (${tokensAparte ? 'tokens.css' : rootEmbebido ? ':root en index.html' : ':root en una hoja aparte'})`);
  } else {
    acta.falta('no hay tokens.css ni un :root con variables: cada bloque inventa su paleta');
  }

  verificarContenido(dir, archivos, acta);
}

// ── movil-rn ────────────────────────────────────────────────────────────────

async function auditarMovilRn(dir, archivos, acta) {
  const pkg = json(dir, 'package.json');
  if (!pkg.existe) {
    acta.falta('falta package.json: sin él no es un proyecto de React Native, son archivos sueltos');
  } else if (!pkg.valido) {
    acta.falta('package.json no es JSON válido: ninguna herramienta puede leerlo');
  } else {
    const deps = { ...(pkg.datos.dependencies || {}), ...(pkg.datos.devDependencies || {}) };
    const rn = deps['react-native'];
    const expo = deps.expo;
    if (rn || expo) {
      acta.ok(`package.json válido con ${rn ? `react-native ${rn}` : ''}${rn && expo ? ' y ' : ''}${expo ? `expo ${expo}` : ''}`);
    } else {
      acta.falta('package.json no declara react-native ni expo: esto no es una app móvil');
    }
  }

  const appJson = json(dir, 'app.json');
  if (appJson.existe && appJson.valido) {
    acta.ok('app.json (nombre, slug, icono y splash de la app)');
  } else if (appJson.existe) {
    acta.falta('app.json no es JSON válido');
  } else {
    acta.falta('falta app.json (nombre, slug, icono y splash de la app)');
  }

  const entrada = ['App.js', 'App.jsx', 'App.tsx', 'index.js', 'index.tsx', 'app/_layout.tsx']
    .find((rel) => archivos.includes(rel));
  acta.archivo(Boolean(entrada), entrada || 'App.jsx', entrada ? 'punto de entrada' : 'el punto de entrada de la app');

  const pantallas = archivos.filter((rel) => /^src\/(screens|pantallas)\/.+\.[jt]sx?$/.test(rel));
  if (pantallas.length) {
    acta.ok(`${pantallas.length} pantalla(s) en src/: ${pantallas.slice(0, 4).join(', ')}`);
  } else {
    const sueltas = archivos.filter((rel) => /\.[jt]sx$/.test(rel) && rel !== entrada);
    acta.falta(
      sueltas.length
        ? `no hay pantallas en src/screens/: el código vive suelto en ${sueltas.slice(0, 3).join(', ')}`
        : 'no hay ninguna pantalla: la app no tiene contenido propio'
    );
  }

  // The entry point with the default Expo template while the work lives in
  // src/screens/ is the bug the niche flow attacks head-on: you open the app
  // and see the Expo banner, not the product.
  if (entrada && pantallas.length) {
    const texto = leer(dir, entrada);
    const montaAlgo = pantallas.some((rel) => {
      const nombre = path.basename(rel).replace(/\.[jt]sx?$/, '');
      return texto.includes(nombre);
    }) || /from ['"]\.\/src\//.test(texto) || /expo-router/.test(texto);
    if (montaAlgo) {
      acta.ok(`${entrada} monta las pantallas del proyecto`);
    } else {
      acta.falta(`${entrada} no monta ninguna pantalla de src/: al abrir la app se ve la plantilla, no el producto`);
    }
  }

  // HTML tags and browser APIs in the JSX: exactly how a web disguised as an
  // app slips in. native-build.js measures it, it is not rewritten here.
  // Only the JSX part of its report is taken: package.json and app.json were
  // already reviewed above in more detail and repeating it fills the report with the same.
  const revision = await revisarReactNative(dir);
  const delJsx = (revision.errores || []).filter((e) => !['package.json', 'app.json'].includes(e.archivo));
  if (revision.ok) {
    acta.ok('cero etiquetas HTML y cero APIs del navegador en el JSX');
  } else if (delJsx.length === 0) {
    acta.ok('el JSX no tiene etiquetas HTML ni APIs del navegador');
  } else {
    for (const e of delJsx) {
      acta.falta(`[${e.archivo}] ${e.que}`);
    }
  }

  // JS/JSX that doesn't parse also breaks the app, and verify.js knows about that.
  verificarContenido(dir, archivos, acta, {
    soloEstos: archivos.filter((rel) => /\.(js|mjs|md|txt)$/i.test(rel))
  });
}

// ── android ─────────────────────────────────────────────────────────────────

async function auditarAndroid(dir, archivos, acta) {
  for (const [rel, porque] of [
    ['settings.gradle.kts', 'declara los módulos del proyecto'],
    ['app/build.gradle.kts', 'el módulo de la app'],
    ['app/src/main/AndroidManifest.xml', 'el manifiesto']
  ]) {
    acta.archivo(archivos.includes(rel), rel, porque);
  }

  const mainActivity = archivos.find((rel) => /(^|\/)MainActivity\.kt$/.test(rel));
  acta.archivo(Boolean(mainActivity), 'MainActivity.kt', mainActivity || 'la actividad que arranca la app');

  const kotlin = archivos.filter((rel) => rel.endsWith('.kt'));
  if (kotlin.length > 1) {
    acta.ok(`${kotlin.length} archivos Kotlin (pantallas y tema aparte de la actividad)`);
  } else if (kotlin.length === 1) {
    acta.falta('todo el código está en un solo .kt: falta separar pantallas y tema', false);
  }

  // The module namespace against the code package: if they don't match, Gradle
  // compiles and the app can't find its own class. It's the failure you don't see
  // reading a single file, which is why it's audited here and not in verify.js.
  const gradle = leer(dir, 'app/build.gradle.kts');
  const namespace = gradle.match(/namespace\s*=\s*["']([\w.]+)["']/)?.[1] || null;
  const paquete = mainActivity ? leer(dir, mainActivity).match(/^\s*package\s+([\w.]+)/m)?.[1] || null : null;
  if (namespace && paquete) {
    if (namespace === paquete) {
      acta.ok(`el namespace del módulo y el paquete del código coinciden (${namespace})`);
    } else {
      acta.falta(`el namespace del módulo (${namespace}) no coincide con el paquete del código (${paquete})`);
    }
  } else {
    acta.falta(
      !namespace
        ? 'app/build.gradle.kts no declara namespace'
        : 'MainActivity.kt no declara su package: no se puede saber si coincide con el namespace'
    );
  }

  // The manifest must point to an activity that really exists.
  const manifiesto = leer(dir, 'app/src/main/AndroidManifest.xml');
  if (manifiesto) {
    const declarada = manifiesto.match(/<activity[^>]*android:name=["']([^"']+)["']/)?.[1] || null;
    if (declarada) {
      const clase = declarada.replace(/^\./, '');
      if (mainActivity && (mainActivity.includes(clase.replace(/\./g, '/')) || clase.endsWith('MainActivity'))) {
        acta.ok(`el manifiesto declara ${declarada}, que existe en el código`);
      } else {
        acta.falta(`el manifiesto declara la actividad ${declarada} y no hay un .kt que la implemente`);
      }
    } else {
      acta.falta('el manifiesto no declara ninguna <activity>: la app no tiene por dónde arrancar');
    }
  }

  verificarContenido(dir, archivos, acta, {
    soloEstos: archivos.filter((rel) => /\.(md|txt)$/i.test(rel))
  });
}

// ── python ──────────────────────────────────────────────────────────────────

async function auditarPython(dir, archivos, acta) {
  const py = archivosPython(dir).map((abs) => path.relative(dir, abs));
  if (py.length === 0) {
    acta.falta('no hay ningún archivo .py: falta el programa');
    return;
  }
  acta.ok(`${py.length} archivo(s) .py`);

  const entrada = ['main.py', 'app.py', '__main__.py', 'src/main.py'].find((rel) => archivos.includes(rel));
  if (entrada) {
    acta.ok(`${entrada} — el punto de entrada`);
    const texto = leer(dir, entrada);
    if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(texto)) {
      acta.ok(`${entrada} tiene guard de __main__: se puede importar sin ejecutar`);
    } else {
      acta.falta(`${entrada} no tiene if __name__ == "__main__": importarlo ejecuta el programa`, false);
    }
    if (/\binput\s*\(/.test(texto)) {
      acta.falta(`${entrada} usa input(): un programa que espera tecla no se puede correr sin una persona`, false);
    }
  } else {
    acta.falta('no hay punto de entrada (main.py o app.py): no se sabe qué correr');
  }

  const declaracion = ['requirements.txt', 'pyproject.toml'].find((rel) => archivos.includes(rel));
  if (declaracion) {
    acta.ok(`${declaracion} — las dependencias están declaradas`);
  } else {
    acta.falta('falta requirements.txt o pyproject.toml: no se sabe qué hace falta para correrlo');
  }

  // The real compilation: py_compile file by file, with the cache outside
  // the deliverable. It's the same one the engine runs before accepting the finish.
  const build = await compilarPython(dir);
  if (build.saltado) {
    acta.falta(`no se pudo compilar: ${build.motivo}`, false);
  } else if (build.ok) {
    acta.ok(`los ${py.length} .py compilan (python3 -m py_compile)`);
  } else {
    for (const e of build.errores.slice(0, 8)) {
      acta.falta(`[${e.archivo}${e.linea ? `:${e.linea}` : ''}] ${e.que}`);
    }
  }

  verificarContenido(dir, archivos, acta, {
    soloEstos: archivos.filter((rel) => /\.(md|txt)$/i.test(rel))
  });
}

// ── automation ──────────────────────────────────────────────────────────────

async function auditarAutomatizacion(dir, archivos, acta) {
  const scripts = archivos.filter((rel) => /\.(js|mjs)$/i.test(rel));
  if (scripts.length) {
    acta.ok(`${scripts.length} script(s): ${scripts.slice(0, 4).join(', ')}`);
  } else {
    acta.falta('no hay ningún .js ni .mjs: falta el script que hace el trabajo');
  }
  acta.archivo(
    archivos.some((rel) => /^README\.md$/i.test(rel)),
    'README.md',
    'cómo se corre',
    false
  );
  verificarContenido(dir, archivos, acta);
}

// ── Orchestration ───────────────────────────────────────────────────────────

const AUDITORES = {
  web: auditarWeb,
  'movil-rn': auditarMovilRn,
  android: auditarAndroid,
  python: auditarPython,
  automatizacion: auditarAutomatizacion
};

// From the type native-build.js detects to the project niche.
const NICHO_DETECTADO = { android: 'android', 'react-native': 'movil-rn', python: 'python' };

export async function auditarApp(dir, stackPedido = null) {
  const absoluto = path.resolve(dir);
  if (!existsSync(absoluto)) {
    return { dir: absoluto, error: `no existe la carpeta ${absoluto}` };
  }

  const archivos = listar(absoluto);
  const detectado = NICHO_DETECTADO[detectarProyecto(absoluto)] || null;
  // If no niche was given, it's inferred; if one was given, what was said wins — a
  // mobile project that delivered a web must fail as mobile, not pass
  // as web.
  const stack = stackPedido ? normalizeStack(stackPedido) : (detectado || 'web');

  const acta = nuevaActa();
  if (archivos.length === 0) {
    acta.falta('la carpeta está vacía: no se entregó nada');
  } else {
    if (stackPedido && detectado && detectado !== stack) {
      acta.falta(`el proyecto es de nicho ${stack} pero lo que hay adentro tiene forma de ${detectado}`);
    }
    await AUDITORES[stack](absoluto, archivos, acta);
  }

  const graves = acta.mal.filter((m) => m.grave);
  return {
    dir: absoluto,
    stack,
    stackDeducido: stackPedido ? null : stack,
    detectado,
    archivos,
    bien: acta.bien,
    mal: acta.mal,
    graves: graves.length,
    // The verdict averages nothing: either it's well-built or something breaking is missing.
    veredicto: archivos.length === 0
      ? 'VACÍA'
      : graves.length === 0
        ? (acta.mal.length === 0 ? 'BIEN ARMADA' : 'BIEN ARMADA CON DETALLES')
        : 'NO ES UNA APP BIEN ARMADA'
  };
}

function imprimir(resultado) {
  if (resultado.error) {
    console.log(`✗ ${resultado.error}`);
    return;
  }
  console.log(`━━ ${resultado.dir}`);
  console.log(`nicho: ${resultado.stack}${resultado.stackDeducido ? ' (deducido de lo que hay adentro)' : ''} · ${resultado.archivos.length} archivo(s)`);
  console.log('');
  for (const b of resultado.bien) {
    console.log(`  OK    ${b}`);
  }
  for (const m of resultado.mal) {
    console.log(`  ${m.grave ? 'FALTA' : 'menor'} ${m.que}`);
  }
  console.log('');
  console.log(`VEREDICTO: ${resultado.veredicto}${resultado.graves ? ` — ${resultado.graves} problema(s) que la rompen` : ''}`);
  console.log('');
}

// Every folder in workspace/, with the niche the DB says. It's the way
// to answer "of what the team already produced, what is well-built?".
function proyectosDelWorkspace() {
  const raiz = path.resolve(process.env.WORKSPACE_ROOT || 'workspace');
  const db = new DatabaseSync(path.resolve('server/data/meetings.db'), { readOnly: true });
  const metas = db.prepare("SELECT company_id, slug, stack, title FROM goals WHERE kind = 'proyecto'").all();
  const porCarpeta = new Map();
  for (const m of metas) {
    porCarpeta.set(`${m.company_id}/${m.slug || 'general'}`, m);
  }

  const out = [];
  for (const empresa of readdirSync(raiz, { withFileTypes: true })) {
    if (!empresa.isDirectory()) {
      continue;
    }
    for (const proyecto of readdirSync(path.join(raiz, empresa.name), { withFileTypes: true })) {
      if (!proyecto.isDirectory()) {
        continue;
      }
      const clave = `${empresa.name}/${proyecto.name}`;
      const meta = porCarpeta.get(clave);
      out.push({
        dir: path.join(raiz, empresa.name, proyecto.name),
        clave,
        stack: meta?.stack || null,
        titulo: meta?.title || null
      });
    }
  }
  return out;
}

// The CLI runs ONLY when the script is invoked; importing
// auditarApp() from a test must not read process.argv nor touch the DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const comoJson = args.includes('--json');
  const libres = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--workspace')) {
    const resultados = [];
    for (const p of proyectosDelWorkspace()) {
      const r = await auditarApp(p.dir, p.stack);
      resultados.push({ ...r, clave: p.clave, titulo: p.titulo, stackDeclarado: p.stack });
    }
    if (comoJson) {
      console.log(JSON.stringify(resultados, null, 2));
    } else {
      for (const r of resultados.filter((x) => x.archivos?.length)) {
        imprimir(r);
      }
      const vacias = resultados.filter((x) => !x.archivos?.length).length;
      console.log(`(${vacias} carpeta(s) de proyecto vacía(s), sin nada entregado)`);
    }
  } else if (libres.length === 0) {
    console.error('Uso: node scripts/auditar-app.mjs <carpeta> [stack]   ·   node scripts/auditar-app.mjs --workspace');
    process.exit(1);
  } else {
    const resultado = await auditarApp(libres[0], libres[1] || null);
    if (comoJson) {
      console.log(JSON.stringify(resultado, null, 2));
    } else {
      imprimir(resultado);
    }
    process.exitCode = resultado.error || resultado.graves ? 1 : 0;
  }
}
