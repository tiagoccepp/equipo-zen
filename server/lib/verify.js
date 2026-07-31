// Verificación determinista de lo que produce el equipo. SIN LLM.
//
// El motor la corre antes de aceptar un `finish` y le devuelve los hallazgos al
// agente como observación del paso siguiente: arregla y recién ahí cierra. Es la
// diferencia entre "otro modelo opina que está bien" y "una máquina midió que
// el HTML cierra, que no hay placeholders y que los colores salen de los tokens".
//
// Reglas de oro de este archivo:
// - Cero falsos positivos tolerables: un hallazgo inventado hace que el agente
//   rompa algo que estaba bien. Ante la duda, no se reporta.
// - Todo hallazgo dice QUÉ, DÓNDE y CÓMO se arregla.

const PLACEHOLDERS = [
  /\blorem ipsum\b/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /texto de ejemplo/i,
  /contenido de ejemplo/i,
  /tu contenido (acá|aqui|aquí)/i,
  /\bplaceholder\b/i,
  /\b(servicio|producto|item|elemento|secci[óo]n|caracter[íi]stica)\s+[123]\b/i,
  /pr[óo]ximamente/i,
  /completar (despu[ée]s|luego|m[áa]s tarde)/i
];

// Palabras inglesas que aparecen de verdad en interfaces mal traducidas. Lista
// corta y específica a propósito: "chat", "web", "email", "software" o "test"
// son de uso normal en español rioplatense y NO se reportan.
const INGLES_EN_UI = [
  'home', 'about us', 'about', 'contact us', 'read more', 'learn more',
  'get started', 'sign up', 'sign in', 'log in', 'submit', 'send message',
  'our services', 'our team', 'our work', 'features', 'pricing',
  'testimonials', 'coming soon', 'view all', 'see more', 'buy now',
  'subscribe', 'newsletter', 'follow us', 'privacy policy', 'terms of service'
];

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

function hallazgo(archivo, que, comoSeArregla) {
  return { archivo, que, comoSeArregla };
}

// Saca el contenido de <script>, <style>, comentarios y atributos, para que el
// análisis de TEXTO no se coma código (donde el inglés es normal y esperable).
function textoVisible(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

// ── HTML ────────────────────────────────────────────────────────────────

export function verifyHtml(ruta, contenido, { archivosDelProyecto = [] } = {}) {
  const out = [];
  const html = String(contenido);

  // Etiquetas sin cerrar / mal anidadas. Se ignora todo lo que esté dentro de
  // script y style, donde un "<" puede ser un operador y no una etiqueta.
  const limpio = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const pila = [];
  const sinCerrar = [];
  for (const m of limpio.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
    const cierre = m[1] === '/';
    const tag = m[2].toLowerCase();
    const autoCerrada = /\/\s*$/.test(m[3]);
    if (VOID_TAGS.has(tag) || autoCerrada || tag === '!doctype') {
      continue;
    }
    if (!cierre) {
      pila.push(tag);
    } else {
      const idx = pila.lastIndexOf(tag);
      if (idx === -1) {
        sinCerrar.push(`</${tag}> sin apertura`);
      } else {
        // Todo lo que quedó abierto por encima nunca se cerró.
        for (const huerfana of pila.splice(idx + 1)) {
          sinCerrar.push(`<${huerfana}> sin cerrar`);
        }
        pila.pop();
      }
    }
  }
  for (const huerfana of pila) {
    sinCerrar.push(`<${huerfana}> sin cerrar`);
  }
  if (sinCerrar.length) {
    out.push(hallazgo(ruta, `HTML mal balanceado: ${[...new Set(sinCerrar)].slice(0, 6).join(', ')}`,
      'Cerrá esas etiquetas; el navegador va a renderizar cualquier cosa.'));
  }

  // Cabecera del documento. Solo si es un documento completo.
  const esDocumento = /<html[\s>]/i.test(html) || /<!doctype/i.test(html);
  if (esDocumento) {
    if (!/<title>\s*\S[\s\S]*?<\/title>/i.test(html)) {
      out.push(hallazgo(ruta, 'falta <title> con contenido',
        'Agregá un <title> propio de esta página dentro del <head>.'));
    }
    if (!/<meta\s+name=["']description["']\s+content=["']\s*\S/i.test(html)) {
      out.push(hallazgo(ruta, 'falta <meta name="description">',
        'Agregá una descripción de una o dos oraciones en el <head>.'));
    }
    if (!/<html[^>]*\blang=/i.test(html)) {
      out.push(hallazgo(ruta, 'falta el atributo lang en <html>',
        'Poné <html lang="es">: sin eso el lector de pantalla lee en el idioma equivocado.'));
    }
  }

  const h1 = html.match(/<h1\b/gi)?.length || 0;
  if (esDocumento && h1 === 0) {
    out.push(hallazgo(ruta, 'no hay ningún <h1>',
      'Toda página necesita un encabezado principal.'));
  }
  if (h1 > 1) {
    out.push(hallazgo(ruta, `hay ${h1} <h1> en la misma página`,
      'Dejá uno solo y bajá el resto a <h2>.'));
  }

  // Imágenes sin alt.
  const sinAlt = [...html.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/gi)];
  if (sinAlt.length) {
    out.push(hallazgo(ruta, `${sinAlt.length} <img> sin atributo alt`,
      'Poné alt describiendo la imagen, o alt="" si es puramente decorativa.'));
  }

  // Enlaces muertos: href="#" o vacío, que prometen algo y no llevan a ningún
  // lado. Se excluye lo que es claramente un disparador de JS.
  const muertos = [...html.matchAll(/<a\b[^>]*href=["'](#|)["'][^>]*>/gi)]
    .filter((m) => !/\b(onclick|data-|role=["']button)/i.test(m[0]));
  if (muertos.length) {
    out.push(hallazgo(ruta, `${muertos.length} enlace(s) con href="#" que no llevan a ningún lado`,
      'Apuntalos a una sección real (#seccion) o convertilos en <button> si son acciones.'));
  }

  // id repetidos.
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  const repetidos = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repetidos.length) {
    out.push(hallazgo(ruta, `id repetidos: ${repetidos.slice(0, 5).join(', ')}`,
      'Los id son únicos; renombrá los duplicados o usá clases.'));
  }

  // Referencias a archivos locales que no existen en el proyecto.
  if (archivosDelProyecto.length) {
    const existentes = new Set(archivosDelProyecto);
    const rotas = [];
    for (const m of html.matchAll(/(?:href|src)=["']([^"'#?]+)["']/gi)) {
      const destino = m[1].trim();
      if (!destino || /^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(destino)) {
        continue;
      }
      const normal = destino.replace(/^\.\//, '');
      if (!existentes.has(normal)) {
        rotas.push(normal);
      }
    }
    if (rotas.length) {
      out.push(hallazgo(ruta, `apunta a archivos que no existen: ${[...new Set(rotas)].slice(0, 5).join(', ')}`,
        'Creá esos archivos o corregí la ruta. Tal como está, no cargan.'));
    }
  }

  // Recursos remotos: en este entorno el navegador del usuario no tiene internet.
  const remotos = [...html.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  if (remotos.length) {
    out.push(hallazgo(ruta, `${remotos.length} recurso(s) remoto(s): ${remotos.slice(0, 3).join(', ')}`,
      'No hay internet donde esto se abre. Usá SVG en línea, degradados CSS y la tipografía del sistema.'));
  }

  out.push(...verifyTexto(ruta, textoVisible(html)));
  return out;
}

// ── Texto: placeholders e idioma ────────────────────────────────────────

export function verifyTexto(ruta, texto) {
  const out = [];
  const encontrados = PLACEHOLDERS
    .map((re) => texto.match(re)?.[0])
    .filter(Boolean);
  if (encontrados.length) {
    out.push(hallazgo(ruta, `contenido de relleno: ${[...new Set(encontrados)].slice(0, 5).join(', ')}`,
      'Reemplazalo por contenido real y específico de esta empresa.'));
  }

  const bajo = texto.toLowerCase();
  const ingles = INGLES_EN_UI.filter((frase) => new RegExp(`\\b${frase}\\b`, 'i').test(bajo));
  if (ingles.length) {
    out.push(hallazgo(ruta, `texto en inglés: ${ingles.slice(0, 5).join(', ')}`,
      'Todo va en español. Traducilo.'));
  }

  return out;
}

// ── CSS: los colores salen de los tokens ────────────────────────────────

// `archivoDeTokens` es el único lugar donde pueden vivir valores literales.
export function verifyCss(ruta, contenido, { esArchivoDeTokens = false } = {}) {
  const out = [];
  if (esArchivoDeTokens) {
    return out;
  }
  const css = String(contenido);

  // Se ignora lo que está DENTRO de un bloque :root o [data-theme]: ahí es
  // donde se declaran los tokens, aunque el archivo no sea el de tokens.
  const fuera = css.replace(/(?::root|\[data-theme[^\]]*\])\s*\{[^}]*\}/gi, '');

  // Solo se miran VALORES de declaración (después de los dos puntos y hasta el
  // ; o el }). Sin esto, un selector de id como `#cafe { … }` se leía como un
  // color escrito a mano: un falso positivo que manda al agente a "arreglar"
  // algo que está bien.
  const valores = [...fuera.matchAll(/:\s*([^;{}]+)/g)].map((m) => m[1]);
  const literales = valores
    .flatMap((valor) => [...valor.matchAll(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi)].map((m) => m[1]))
    .map((valor) => valor.trim())
    // Transparente y blanco/negro puros se usan legítimamente para sombras y
    // superposiciones; marcarlos sería ruido.
    .filter((valor) => !/^(#fff|#ffffff|#000|#000000|rgba?\(0,\s*0,\s*0|rgba?\(255,\s*255,\s*255|transparent)/i.test(valor));

  if (literales.length) {
    out.push(hallazgo(ruta, `${literales.length} color(es) escritos a mano fuera de los tokens: ${[...new Set(literales)].slice(0, 5).join(', ')}`,
      'Usá var(--…) de tokens.css. Si falta un tono, agregalo AHÍ y referencialo acá; si no, el proyecto termina con cinco paletas distintas.'));
  }

  // 'inherit', 'initial', 'unset' y 'revert' son palabras clave de CSS, no
  // tipografías: marcarlas era mandar a cambiar algo que no es una decisión
  // de diseño.
  const PALABRAS_CLAVE_CSS = /^(inherit|initial|unset|revert|revert-layer)$/i;
  const fuentes = [...fuera.matchAll(/font-family\s*:\s*([^;}]+)/gi)]
    .map((m) => m[1].trim())
    .filter((valor) => !/var\(--/.test(valor) && !PALABRAS_CLAVE_CSS.test(valor));
  if (fuentes.length) {
    out.push(hallazgo(ruta, `font-family declarada fuera de los tokens: ${[...new Set(fuentes)].slice(0, 3).join(' | ')}`,
      'La tipografía se define una vez en tokens.css y se usa con var(--…).'));
  }

  return out;
}

// ── JS: que al menos parsee ─────────────────────────────────────────────

// `new Function` compila un SCRIPT clásico, y hay código perfectamente válido que
// ahí es SyntaxError igual: un módulo ES (import/export, await arriba de todo) y
// el JSX. Así se marcaba como roto un theme.js con `export const`, cualquier
// <script type="module"> y todo el JSX de un proyecto React Native — y un
// hallazgo inventado hace que el agente rompa algo que estaba bien, que es
// justamente lo que este archivo no puede hacer. Lo que no se puede juzgar en
// modo script no se reporta.
function noJuzgableComoScript(codigo, mensaje) {
  // Módulo ES: import/export como sentencia, o import.meta.
  if (/^[ \t]*(?:import|export)\b/m.test(codigo) || /\bimport\s*\.\s*meta\b/.test(codigo)) {
    return true;
  }
  // await en el tope del módulo: legal en un módulo, ilegal en un script.
  if (/await is only valid/i.test(mensaje)) {
    return true;
  }
  // JSX: una etiqueta de cierre con nombre es inconfundible, y ningún operador
  // de comparación la produce.
  if (/<\/[A-Za-z][\w.]*>/.test(codigo) || /<[A-Za-z][\w.]*\s+[^>]*\/>/.test(codigo)) {
    return true;
  }
  return false;
}

export function verifyJs(ruta, contenido) {
  const out = [];
  const codigo = String(contenido);
  if (!codigo.trim()) {
    return out;
  }
  try {
    // Solo se comprueba que PARSEE; nunca se ejecuta. new Function compila el
    // cuerpo y tira SyntaxError sin correr una sola línea.
    // eslint-disable-next-line no-new-func
    new Function(codigo);
  } catch (error) {
    if (error instanceof SyntaxError && !noJuzgableComoScript(codigo, String(error.message))) {
      out.push(hallazgo(ruta, `error de sintaxis en el JavaScript: ${String(error.message).slice(0, 160)}`,
        'Arreglalo: tal como está, el script no corre y todo lo interactivo queda muerto.'));
    }
    // Cualquier otro error acá es del verificador, no del entregable: se ignora.
  }
  return out;
}

// ── Entrada única ───────────────────────────────────────────────────────

// `archivos` es un Map ruta → contenido con lo que hay que verificar.
// `rutasDelProyecto` es el listado COMPLETO del proyecto: hace falta aparte
// porque un archivo puede referenciar a otro que esta corrida no tocó, y sin
// esa lista se reportaría como roto algo que existe. Devuelve hallazgos planos.
export function verifyProject(archivos, rutasDelProyecto = null) {
  const rutas = rutasDelProyecto || [...archivos.keys()];
  const hallazgos = [];

  for (const [ruta, contenido] of archivos) {
    const ext = ruta.toLowerCase().slice(ruta.lastIndexOf('.'));
    if (ext === '.html' || ext === '.htm') {
      hallazgos.push(...verifyHtml(ruta, contenido, { archivosDelProyecto: rutas }));
      // El CSS y el JS embebidos también se revisan.
      for (const bloque of String(contenido).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        hallazgos.push(...verifyCss(ruta, bloque[1]));
      }
      for (const bloque of String(contenido).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        hallazgos.push(...verifyJs(ruta, bloque[1]));
      }
    } else if (ext === '.css') {
      hallazgos.push(...verifyCss(ruta, contenido, { esArchivoDeTokens: /tokens\.css$/i.test(ruta) }));
    } else if (ext === '.js' || ext === '.mjs') {
      hallazgos.push(...verifyJs(ruta, contenido));
    } else if (ext === '.md' || ext === '.txt') {
      hallazgos.push(...verifyTexto(ruta, contenido));
    }
  }

  // Un mismo problema reportado dos veces (por ejemplo el CSS embebido y el
  // archivo aparte) confunde más de lo que ayuda.
  const vistos = new Set();
  return hallazgos.filter((item) => {
    const clave = `${item.archivo}|${item.que}`;
    if (vistos.has(clave)) {
      return false;
    }
    vistos.add(clave);
    return true;
  });
}

// El informe tal como lo lee el agente en su próximo paso.
export function renderVerificationReport(hallazgos) {
  if (hallazgos.length === 0) {
    return '';
  }
  return [
    `━━ LA VERIFICACIÓN AUTOMÁTICA ENCONTRÓ ${hallazgos.length} ${hallazgos.length === 1 ? 'PROBLEMA' : 'PROBLEMAS'} ━━`,
    'Esto NO es una opinión: se midió sobre los archivos que escribiste.',
    'Arreglalos con edit_file y recién después respondé finish.',
    '',
    ...hallazgos.map((item, i) => `${i + 1}. [${item.archivo}] ${item.que}\n   → ${item.comoSeArregla}`),
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}
