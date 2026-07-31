// Audita la ESTRUCTURA de un entregable: ¿lo que hay en esa carpeta es una app
// bien armada, o son archivos sueltos que parecen una?
//
// No reimplementa lo que ya existe. La verificación de contenido la hace
// verify.js (HTML balanceado, título, descripción, recursos remotos, referencias
// rotas, JS que no parsea) y la de "esto es una app de verdad" la hace
// native-build.js (revisarReactNative, compilarPython, detectarProyecto). Acá
// solo va lo que ninguna de las dos mira: que estén los archivos que la
// ESTRUCTURA del nicho exige y que encajen entre ellos (el namespace del módulo
// contra el paquete del código, el punto de entrada contra las pantallas).
//
//   node scripts/auditar-app.mjs <carpeta> [stack]
//   node scripts/auditar-app.mjs --workspace          # todo lo que hay en workspace/
//   node scripts/auditar-app.mjs <carpeta> --json
//
// Sin stack, lo deduce con detectarProyecto() y lo dice. Con --workspace lo saca
// de la base (goals.stack), que es la fuente de verdad.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { verifyProject } from '../server/lib/verify.js';
import { archivosPython, compilarPython, detectarProyecto, revisarReactNative } from '../server/lib/native-build.js';
import { esCarpetaIgnorada } from '../server/lib/workforce.js';
import { normalizeStack } from '../server/lib/playbooks.js';

// ── Lectura de la carpeta ───────────────────────────────────────────────────

// Mismo filtro que usa el motor: sin esto, después de una compilación el listado
// devuelve miles de intermedios y la auditoría mide basura.
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

// ── El acta ─────────────────────────────────────────────────────────────────

// Un acta con dos columnas: lo que está y lo que falta. El veredicto sale de que
// no falte nada grave, no de una nota inventada.
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
    // Azúcar para el caso más común: "existe o falta".
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

// ── Lo que comparten todos los nichos ───────────────────────────────────────

// verify.js mide el CONTENIDO de lo que se puede medir sin ejecutar. Se le pasa
// el listado completo del proyecto aparte, porque un archivo puede referenciar a
// otro y sin esa lista se reporta como roto algo que existe.
function verificarContenido(dir, archivos, acta, { soloEstos = null } = {}) {
  const candidatos = (soloEstos || archivos).filter((rel) => /\.(html?|css|js|mjs|md|txt)$/i.test(rel));
  const mapa = new Map();
  for (const rel of candidatos) {
    // Un archivo enorme no se verifica: verify.js trabaja con regex y no aporta
    // nada leer un bundle.
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
    // El JS que no parsea y las referencias rotas son estructurales; el resto
    // (placeholders, inglés, un color a mano) es calidad y no tumba la app.
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
  // Estructura del documento. verify.js ya mide título, descripción y lang, pero
  // da por sentado que es un documento: si no hay <html>/<head>/<body> ni se
  // molesta en mirar la cabecera, así que eso se chequea acá.
  for (const [tag, porque] of [['html', 'el documento'], ['head', 'la cabecera'], ['body', 'el cuerpo']]) {
    acta.archivo(new RegExp(`<${tag}[\\s>]`, 'i').test(html), `<${tag}>`, porque);
  }

  // Tokens: el único artefacto de coordinación que el proyecto conserva. Vale
  // como archivo aparte o como :root embebido — las dos formas son legítimas.
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

  // El punto de entrada con la plantilla por defecto de Expo mientras el trabajo
  // vive en src/screens/ es el error que el flujo del nicho ataca de frente: se
  // abre la app y se ve el cartel de Expo, no el producto.
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

  // Etiquetas HTML y APIs del navegador en el JSX: es exactamente cómo se cuela
  // una web disfrazada de app. Lo mide native-build.js, no se reescribe acá.
  // De su informe se toma SOLO la parte del JSX: package.json y app.json ya se
  // revisaron arriba con más detalle y repetirlo llena el acta de lo mismo.
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

  // El JS/JSX que no parsea también rompe la app, y de eso sabe verify.js.
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

  // El namespace del módulo contra el paquete del código: si no coinciden, Gradle
  // compila y la app no encuentra su propia clase. Es la falla que no se ve
  // leyendo un archivo solo, y por eso se audita acá y no en verify.js.
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

  // El manifiesto tiene que apuntar a una actividad que exista de verdad.
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

  // La compilación de verdad: py_compile archivo por archivo, con la caché fuera
  // del entregable. Es la misma que corre el motor antes de aceptar el finish.
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

// ── automatizacion ──────────────────────────────────────────────────────────

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

// ── Orquestación ────────────────────────────────────────────────────────────

const AUDITORES = {
  web: auditarWeb,
  'movil-rn': auditarMovilRn,
  android: auditarAndroid,
  python: auditarPython,
  automatizacion: auditarAutomatizacion
};

// Del tipo que detecta native-build.js al nicho del proyecto.
const NICHO_DETECTADO = { android: 'android', 'react-native': 'movil-rn', python: 'python' };

export async function auditarApp(dir, stackPedido = null) {
  const absoluto = path.resolve(dir);
  if (!existsSync(absoluto)) {
    return { dir: absoluto, error: `no existe la carpeta ${absoluto}` };
  }

  const archivos = listar(absoluto);
  const detectado = NICHO_DETECTADO[detectarProyecto(absoluto)] || null;
  // Si no dijeron el nicho, se deduce; si lo dijeron, manda lo que dijeron — un
  // proyecto móvil que entregó una web tiene que fallar como móvil, no pasar
  // como web.
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
    // El veredicto no promedia nada: o está armada o le falta algo que la rompe.
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

// Todas las carpetas de workspace/, con el nicho que dice la base. Es la forma
// de responder "¿de lo que ya produjo el equipo, qué está bien armado?".
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

// La línea de comandos corre SOLO cuando se invoca el script; importar
// auditarApp() desde un test no tiene que leer process.argv ni tocar la base.
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
