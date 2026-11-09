// tester.js — tester multi-persona (track C, flujo de equipo).
//
// Dado un producto + brief → matriz persona×dimensión de checklists
// ejecutables. Juzga resultados → devolución severizada o aprobación.
// El tester NO ejecuta rework: expone el contrato de devolución que consume
// el Orquestador (track A). Todo puro y determinista.
//
// Revisar(test): tests/flujo-tester.test.mjs

// Personas por tipo de producto.
export const PERSONAS_POR_TIPO = {
  web: [
    { id: 'usuario-nuevo', desc: 'Primera visita: ¿entiendo qué es y qué hacer en 5 segundos?' },
    { id: 'usuario-experto', desc: 'Uso intensivo: atajos, flujos largos, estados raros acumulados' },
    { id: 'ingeniero-design', desc: 'Ojo de diseño+frontend: layout, responsive, estados, accesibilidad' },
    { id: 'comprador', desc: '¿Me convence? Precio/valor/CTA/confianza para pagar o contactar' }
  ],
  cv: [
    { id: 'ATS', desc: 'Parser automático: texto extraíble, fechas, keywords, sin tablas raras' },
    { id: 'recruiter', desc: 'Humano con 6 segundos: impacto, claridad, números, sin slop' }
  ],
  app: [
    { id: 'usuario', desc: 'Instalación, onboarding, uso diario, permisos, offline' },
    { id: 'store-reviewer', desc: 'Criterio de tienda: políticas, crashes, permisos justificados, metadata' }
  ],
  generico: [
    { id: 'usuario', desc: 'Uso normal del entregable según el brief' },
    { id: 'experto', desc: 'Conocimiento del dominio: corrige fondo, no solo forma' },
    { id: 'escéptico', desc: 'Busca el agujero: supuestos débiles, promesas sin sustento' }
  ]
};

// Dimensiones: todas salvo cv (un CV no tiene UI interactiva → sin visual).
export const DIMENSIONES_POR_TIPO = {
  web: ['visual', 'funcional', 'destructivo', 'bordes'],
  cv: ['funcional', 'destructivo', 'bordes'],
  app: ['visual', 'funcional', 'destructivo', 'bordes'],
  generico: ['visual', 'funcional', 'destructivo', 'bordes']
};

const DESC_DIM = {
  visual: 'qué se ve',
  funcional: 'flujos + criterios del brief',
  destructivo: 'romper a propósito',
  bordes: 'casos límite'
};

// Plantillas de checks por (persona, dimensión). `mirar` = qué observar,
// `pass` = criterio pass/fail explícito. `{brief}` se expande con el resumen.
function plantillas(personaId, dimension, producto) {
  const donde = producto.url ? `en ${producto.url}` : (producto.path ? `en ${producto.path}` : 'en la entrega');
  const P = (pasos, mirar, pass) => ({ pasos, mirar, pass });
  const key = `${personaId}×${dimension}`;
  const T = {
    // ---- WEB ----
    'usuario-nuevo×visual': [P(
      ['Abrir la página sin contexto previo', 'Esperar carga completa y mirar 5 segundos sin scrollear', 'Scrollear hasta el final'],
      'jerarquía: título claro, CTA visible, nada roto/solapado',
      'PASS si en 5s se entiende qué ofrece y hay un CTA visible sin scroll lateral ni solapes')],
    'usuario-nuevo×funcional': [P(
      ['Completar el flujo principal (contacto/compra/registro) sin ayuda', 'Leer los mensajes de éxito/error que aparecen'],
      'fricción: pasos confusos, errores crípticos, callejones sin salida',
      'PASS si el flujo se completa sin ayuda externa y cada error dice qué hacer')],
    'usuario-nuevo×destructivo': [P(
      ['Enviar cada formulario vacío', 'Pegar texto de 5000 caracteres en un campo corto', 'Doble-click en el botón de envío'],
      'validaciones, largos máximos, submits duplicados',
      'PASS si nada rompe: errores claros, sin duplicados, sin crash')],
    'usuario-nuevo×bordes': [P(
      ['Probar en viewport 390px (mobile)', 'Probar con zoom 200%', 'Navegar solo con teclado (Tab/Enter)'],
      'responsive, overflow, foco visible',
      'PASS si a 390px no hay scroll horizontal ni solapes y el flujo es completable con teclado')],
    'usuario-experto×visual': [P(
      ['Recorrer todas las secciones/pantallas', 'Comparar espaciados, tipografías y colores entre secciones'],
      'consistencia visual entre pantallas',
      'PASS si no hay estilos inconsistentes ni pantallas “olvidadas”')],
    'usuario-experto×funcional': [P(
      ['Repetir el flujo principal 3 veces seguidas', 'Probar volver atrás y reanudar a mitad de flujo', 'Recargar a mitad de flujo'],
      'estado persistente, idempotencia, recuperación',
      'PASS si recargar/volver no pierde datos ni duplica acciones')],
    'usuario-experto×destructivo': [P(
      ['Abrir el flujo en 2 tabs y avanzar en ambas', 'Usar botón back del browser mid-flow', 'Pegar HTML/JS en campos de texto'],
      'concurrencia, navegación, inyección',
      'PASS si el HTML se escapa como texto y las 2 tabs no corrompen estado')],
    'usuario-experto×bordes': [P(
      ['Probar con conexión lenta (throttle)', 'Probar con JS parcialmente bloqueado si aplica', 'Dejar la sesión idle 10 minutos y retomar'],
      'timeouts, sesiones expiradas, degradación',
      'PASS si los errores de red/sesión se comunican y se puede reintentar sin perder datos')],
    'ingeniero-design×visual': [P(
      ['Revisar en 390px, 768px y 1440px', 'Inspeccionar hover/focus/disabled/error/empty de cada interactivo', 'Chequear contraste texto/fondo'],
      'breakpoints, estados, contraste WCAG AA',
      'PASS si los 3 viewports están sanos, todos los interactivos tienen estados y el contraste pasa AA')],
    'ingeniero-design×funcional': [P(
      ['Verificar cada link/botón lleva a donde dice', 'Verificar formularios: labels asociados, tipos de input, autocomplete'],
      'links rotos, a11y de formularios',
      'PASS si cero links rotos y cada input tiene label accesible')],
    'ingeniero-design×destructivo': [P(
      ['Forzar error de red y observar la UI', 'Cargar imágenes pesadas/rotas', 'Cambiar tamaño de ventana durante animaciones'],
      'estados de error, layout shifts, contenido roto',
      'PASS si hay UI de error diseñada (no pantalla blanca) y no hay saltos de layout')],
    'ingeniero-design×bordes': [P(
      ['Pasar lector de pantalla o audit de a11y', 'Probar con fuentes del sistema / sin webfonts', 'Textos largos: títulos de 200 chars, nombres con acentos/ñ'],
      'a11y, fuentes, overflow de texto',
      'PASS si el audit no reporta errores críticos y los textos largos no rompen layout')],
    'comprador×visual': [P(
      ['Mirar hero + pricing/oferta como si fueras a pagar', 'Buscar prueba social, garantías, contacto real'],
      'confianza: señales que justifican pagar',
      'PASS si hay propuesta de valor + prueba/confianza + contacto visible')],
    'comprador×funcional': [P(
      ['Intentar pagar/contactar de verdad hasta el último paso previo al compromiso', 'Leer letra chica: precios, plazos, condiciones'],
      'fricción de compra, sorpresas de precio',
      'PASS si el camino a pagar/contactar es obvio y no hay costos sorpresivos')],
    'comprador×destructivo': [P(
      ['Buscar promesas exageradas o contradictorias en el copy', 'Verificar que lo prometido en el copy existe en el producto'],
      'copy vs realidad',
      'PASS si cada promesa del copy se verifica en el producto (cero humo)')],
    'comprador×bordes': [P(
      ['Leer todo en mobile como compra impulsiva', 'Buscar política de devolución/errores/qué pasa si algo sale mal'],
      'compra mobile, manejo de objeciones',
      'PASS si en mobile se puede comprar/contactar y hay respuesta visible a “¿y si sale mal?”')],
    // ---- CV ----
    'ATS×funcional': [P(
      ['Extraer texto plano del PDF (pdftotext o similar)', 'Verificar que fechas, títulos y empresas salen en orden legible'],
      'parseabilidad: orden, tablas, columnas, gráficos que rompen el parseo',
      'PASS si el texto extraído lee el CV completo en orden sin basura')],
    'ATS×destructivo': [P(
      ['Buscar keywords del aviso en el texto extraído', 'Verificar fechas con formato consistente y sin huecos raros'],
      'keywords, fechas parseables',
      'PASS si las keywords del aviso aparecen y las fechas tienen formato consistente')],
    'ATS×bordes': [P(
      ['Revisar caracteres especiales (acentos, ñ, bullets)', 'Verificar largo: 1-2 páginas'],
      'encoding, largo',
      'PASS si no hay mojibake y el largo es 1-2 páginas')],
    'recruiter×funcional': [P(
      ['Leer 6 segundos: ¿qué nivel y qué rol encaja?', 'Leer completo buscando números concretos con contexto'],
      'impacto en 6s, números creíbles',
      'PASS si en 6s se ubica nivel+rol y hay ≥2 números concretos no-portables')],
    'recruiter×destructivo': [P(
      ['Buscar muletillas IA (robusto, sin fisuras, de vanguardia, leverage)', 'Buscar ritmo robótico: misma forma de frase en todos los bullets'],
      'slop: muletillas, ritmo repetido, agregados portables',
      'PASS si cero muletillas baneadas y ritmo/vocabulario variado entre entradas')],
    'recruiter×bordes': [P(
      ['Verificar consistencia: fechas vs experiencia declarada, títulos vs seniority', 'Leer en mobile: ¿se entiende igual?'],
      'consistencia interna, legibilidad mobile',
      'PASS si no hay contradicciones y se lee bien en pantalla chica')],
    // ---- APP ----
    'usuario×visual': [P(
      ['Instalar/onboarding: capturas de cada pantalla', 'Revisar dark mode si existe, y pantallas de error/vacío'],
      'onboarding claro, estados diseñados',
      'PASS si el onboarding se entiende sin tutorial y hay pantallas de error/vacío diseñadas')],
    'usuario×funcional': [P(
      ['Completar el flujo core 2 veces', 'Probar deep links / notificaciones si existen'],
      'flujo core estable',
      'PASS si el flujo core funciona 2/2 sin workaround')],
    'usuario×destructivo': [P(
      ['Matar la app mid-flow y reabrir', 'Revocar permisos y seguir usando', 'Activar modo avión mid-flow'],
      'recuperación, permisos, offline',
      'PASS si nada pierde datos y cada permiso revocado degrada con mensaje claro')],
    'usuario×bordes': [P(
      ['Probar con texto enorme (accesibilidad OS)', 'Probar en el device más chico soportado', 'Rotar pantalla mid-flow'],
      'a11y OS, pantallas chicas, rotación',
      'PASS si no hay cortes/solapes con texto grande ni en pantalla chica')],
    'store-reviewer×visual': [P(
      ['Revisar screenshots/icono/descripción de la ficha', 'Verificar que la ficha matchea la app real'],
      'ficha vs realidad',
      'PASS si la ficha describe la app real sin screenshots engañosos')],
    'store-reviewer×funcional': [P(
      ['Ejecutar 15 min de monkey test (taps aleatorios)', 'Verificar login/signup/logout + borrado de cuenta si aplica'],
      'crashes, cuenta y privacidad',
      'PASS si cero crashes en 15 min y existe borrado de cuenta/datos')],
    'store-reviewer×destructivo': [P(
      ['Revisar cada permiso pedido: ¿se justifica en contexto?', 'Buscar tracking/SDKs no declarados en la ficha'],
      'permisos, privacidad declarada',
      'PASS si cada permiso se pide con justificación visible y la privacidad declarada matchea')],
    'store-reviewer×bordes': [P(
      ['Verificar edad/contenido: ¿matchea el rating?', 'Verificar que funciona en OS mínimo soportado'],
      'rating, compatibilidad mínima',
      'PASS si el contenido matchea el rating y corre en el OS mínimo')],
    // ---- GENÉRICO ----
    'usuario×visual': [P(
      ['Revisar la presentación de la entrega ' + donde, 'Buscar errores visuales obvios (alineación, typos, formato)'],
      'presentación profesional',
      'PASS si no hay typos ni errores de formato visibles')],
    'usuario×funcional': [P(
      ['Ejecutar el caso de uso principal del brief paso a paso', 'Verificar cada criterio de éxito del brief uno por uno'],
      'brief: cada criterio se cumple',
      'PASS si todos los criterios de éxito del brief se verifican')],
    'usuario×destructivo': [P(
      ['Probar el input más raro razonable: vacío, enorme, con caracteres especiales', 'Repetir la operación 2 veces: ¿se duplica o falla?'],
      'inputs hostiles, idempotencia',
      'PASS si los inputs raros se manejan con error claro y no hay duplicados')],
    'usuario×bordes': [P(
      ['Probar el caso mínimo (1 item / vacío) y un caso grande', 'Revisar textos con acentos, ñ, mayúsculas extremas'],
      'escala mínima y grande, i18n base',
      'PASS si vacío/1/N funcionan y los acentos no rompen nada')],
    'experto×visual': [P(
      ['Revisar con ojo de dominio: terminología, convenciones, formato esperado'],
      'convenciones del dominio',
      'PASS si la terminología y formato matchean lo que un profesional esperaría')],
    'experto×funcional': [P(
      ['Verificar fondo, no solo forma: ¿los resultados son correctos?', 'Contrastar contra una fuente independiente si existe'],
      'corrección de fondo',
      'PASS si los resultados se verifican contra fuente independiente')],
    'experto×destructivo': [P(
      ['Buscar el caso que el autor no consideró (el “¿y si…?” incómodo)', 'Forzar supuestos: ¿qué pasa si el supuesto base es falso?'],
      'supuestos no declarados',
      'PASS si los supuestos están declarados y el “¿y si…?” tiene respuesta')],
    'experto×bordes': [P(
      ['Revisar límites del dominio: valores extremos válidos', 'Revisar versionado/compatibilidad si aplica'],
      'límites del dominio',
      'PASS si los extremos válidos están contemplados')],
    'escéptico×visual': [P(
      ['Leer como si fuera mentira: ¿qué intenta impresionar sin sustento?', 'Buscar gráficos/números decorativos'],
      'humo visual',
      'PASS si cada número/gráfico tiene fuente o método visible')],
    'escéptico×funcional': [P(
      ['Pedir evidencia de cada afirmación fuerte', 'Verificar la afirmación más importante de forma independiente'],
      'afirmaciones vs evidencia',
      'PASS si la afirmación principal se verifica de forma independiente')],
    'escéptico×destructivo': [P(
      ['Intentar refutar la conclusión: buscar contraejemplos', 'Preguntar “¿qué haría fallar esto?” y probar la respuesta'],
      'refutabilidad',
      'PASS si se intentó refutar de buena fe y sobrevivió, o se achicó la afirmación')],
    'escéptico×bordes': [P(
      ['Buscar lo que NO dice: omisiones convenientes', 'Comparar contra la alternativa obvia (“¿y por qué no X?”)'],
      'omisiones, alternativas',
      'PASS si las omisiones obvias y la alternativa principal están addressed')]
  };
  const fallback = [P(
    [`Ejecutar revisión ${dimension} (${DESC_DIM[dimension]}) como ${personaId} ${donde}`, 'Registrar observado + pasos para reproducir'],
    `calidad ${dimension} desde el ojo de ${personaId}`,
    `PASS si no se encuentra ningún fallo ${dimension} reproducible`)];
  return T[key] || fallback;
}

export function tipoDe(producto) {
  const t = String(producto?.tipo || '').toLowerCase();
  if (t === 'web' || t === 'sitio' || t === 'landing' || t === 'page') return 'web';
  if (t === 'cv' || t === 'curriculum' || t === 'resume') return 'cv';
  if (t === 'app' || t === 'movil' || t === 'mobile') return 'app';
  return 'generico';
}

// producto: { tipo, descripcion, brief?: { criteriosExito: string[] }, url?, path? }
// -> { tipo, personas, dimensiones, celdas: [{ id, persona, dimension, checks: [{ id, pasos, mirar, pass }] }] }
export function planDePrueba(producto = {}) {
  const tipo = tipoDe(producto);
  const personas = PERSONAS_POR_TIPO[tipo];
  const dimensiones = DIMENSIONES_POR_TIPO[tipo];
  const criterios = Array.isArray(producto?.brief?.criteriosExito)
    ? producto.brief.criteriosExito.filter((c) => String(c || '').trim())
    : [];
  const celdas = [];
  let n = 0;
  for (const persona of personas) {
    for (const dimension of dimensiones) {
      n += 1;
      const checks = plantillas(persona.id, dimension, producto).map((c, i) => ({
        id: `C${n}.${i + 1}`,
        pasos: [...c.pasos],
        mirar: c.mirar,
        pass: c.pass
      }));
      celdas.push({ id: `celda-${n}`, persona: persona.id, dimension, checks });
    }
  }
  // 1 check funcional por criterio del brief, en la primera persona funcional disponible.
  criterios.forEach((criterio, i) => {
    const celda = celdas.find((c) => c.dimension === 'funcional');
    if (!celda) return;
    celda.checks.push({
      id: `C-brief.${i + 1}`,
      pasos: [`Verificar criterio del brief: “${criterio}”`, 'Registrar evidencia (screenshot/cita/medición)'],
      mirar: `criterio: ${criterio}`,
      pass: `PASS si “${criterio}” se verifica con evidencia`
    });
  });
  return {
    tipo,
    personas: personas.map((p) => p.id),
    dimensiones: [...dimensiones],
    celdas
  };
}

// Contrato de devolución (lo consume el Orquestador / track A).
// Fallo = { severidad: 'bug'|'mejora'|'nit', titulo, persona, dimension,
//   observado, pasosRepro: [], reproducible: bool, faltaParaReproducir?,
//   criterioFallado? }
export const FALLO_SCHEMA = [
  'severidad', 'titulo', 'persona', 'dimension', 'observado',
  'pasosRepro', 'reproducible', 'faltaParaReproducir?', 'criterioFallado?'
];

const ORDEN_SEV = { bug: 0, mejora: 1, nit: 2 };

function severizarResultado(r) {
  if (r.severidad && ORDEN_SEV[r.severidad] !== undefined) return r.severidad;
  // Heurística: destructivo que falla = bug; funcional = mejora; resto nit.
  if (r.dimension === 'destructivo') return 'bug';
  if (r.dimension === 'funcional') return 'mejora';
  return 'nit';
}

// resultados: [{ celdaId?, persona, dimension, estado: 'pass'|'fail',
//   observado?, pasosRepro?: [], criterioFallado?, titulo? }]
// opts: { ronda?, limitaciones?: [], arregladoEnRondas?: [] }
// -> { veredicto: 'devolucion', ronda, fallos, resumenVoz }
//  | { veredicto: 'aprobado', cobertura, arregladoEnRondas, limitaciones, resumenVoz }
export function juzgar(resultados = [], opts = {}) {
  const ronda = Number.isFinite(opts.ronda) ? opts.ronda : 1;
  const fallos = [];
  let pasados = 0;
  for (const r of resultados) {
    if (r.estado !== 'fail') {
      pasados += 1;
      continue;
    }
    const pasosRepro = Array.isArray(r.pasosRepro) ? r.pasosRepro.filter((p) => String(p || '').trim()) : [];
    const reproducible = pasosRepro.length > 0;
    const fallo = {
      severidad: severizarResultado(r),
      titulo: String(r.titulo || r.observado || 'fallo sin título').slice(0, 160),
      persona: String(r.persona || 'desconocida'),
      dimension: String(r.dimension || 'funcional'),
      observado: String(r.observado || ''),
      pasosRepro,
      reproducible
    };
    if (!reproducible) {
      fallo.faltaParaReproducir = 'Faltan pasos para reproducir: indicar acciones exactas + entorno + datos usados.';
    }
    if (r.criterioFallado) fallo.criterioFallado = String(r.criterioFallado);
    fallos.push(fallo);
  }
  fallos.sort((a, b) => ORDEN_SEV[a.severidad] - ORDEN_SEV[b.severidad]);

  if (fallos.length > 0) {
    const bugs = fallos.filter((f) => f.severidad === 'bug').length;
    return {
      veredicto: 'devolucion',
      ronda,
      fallos,
      resumenVoz: bugs > 0
        ? `Ronda ${ronda}: encontré ${fallos.length} ${fallos.length === 1 ? 'tema' : 'temas'}, ${bugs} ${bugs === 1 ? 'bug' : 'bugs'}. Devuelvo con pasos para reproducir.`
        : `Ronda ${ronda}: encontré ${fallos.length} ${fallos.length === 1 ? 'mejora' : 'mejoras'}. Devuelvo detallado.`
    };
  }

  const personas = [...new Set(resultados.map((r) => r.persona).filter(Boolean))];
  const dimensiones = [...new Set(resultados.map((r) => r.dimension).filter(Boolean))];
  return {
    veredicto: 'aprobado',
    cobertura: {
      personas,
      dimensiones,
      checksPasados: pasados,
      checksTotales: resultados.length
    },
    arregladoEnRondas: Array.isArray(opts.arregladoEnRondas) ? opts.arregladoEnRondas : [],
    limitaciones: Array.isArray(opts.limitaciones) ? opts.limitaciones : [],
    resumenVoz: `Aprobado: ${pasados} checks en verde (${personas.length} personas × ${dimensiones.length} dimensiones).`
  };
}

export function resumirParaVoz(juicio) {
  return String(juicio?.resumenVoz || 'Sin veredicto.');
}
