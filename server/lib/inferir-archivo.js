import { normalizeStack } from './playbooks.js';

// A qué archivo apunta una tarea repartida en vivo.
//
// Existe por una razón concreta: el cerrojo de trabajo es por ARCHIVO, y una
// tarea sin archivo declarado toma el proyecto ENTERO en exclusiva. Como las
// tareas que se reparten durante la reunión no pasan por el plan de cierre
// (que sí asigna archivos), sin esto el equipo vuelve a trabajar de a uno
// justo cuando más se nota.
//
// Es deterministic a propósito: adivinar acá con el modelo costaría una
// llamada por tarea y la clave de API es el recurso escaso del sistema.

// Pistas de la tarea → archivo, por nicho. El orden importa: gana la primera.
const PISTAS = {
  web: [
    [/\b(estilo|css|paleta|tipograf|color|dise[ñn]o visual|tema)\b/i, 'estilos.css'],
    [/\b(script|javascript|\bjs\b|interacci[oó]n|animaci[oó]n|parallax|scroll|filtro|acorde[oó]n|pesta[ñn]a|formulario din)\b/i, 'app.js'],
    [/\b(dato|datos|json|cat[aá]logo|men[uú] de datos|contenido estructurado)\b/i, 'datos.json'],
    [/\b(texto|copy|redacci[oó]n|contenido|documenta)\b/i, 'index.html'],
    [/.*/, 'index.html']
  ],
  automatizacion: [
    [/\b(readme|documenta|instructivo|manual)\b/i, 'README.md'],
    [/\b(dato|datos|ejemplo|muestra|csv)\b/i, 'datos-ejemplo.csv'],
    [/\b(informe|reporte|tablero|salida|resultado)\b/i, 'informe.html'],
    [/.*/, 'flujo.js']
  ],
  'movil-rn': [
    [/\b(tema|estilo|paleta|tipograf|color|token)\b/i, 'src/theme.js'],
    [/\b(pantalla|screen|vista|navegaci[oó]n)\b/i, 'src/screens/Principal.jsx'],
    [/\b(componente|tarjeta|lista|bot[oó]n)\b/i, 'src/components/Lista.jsx'],
    [/\b(configuraci[oó]n|app\.json|[ií]cono|splash)\b/i, 'app.json'],
    [/.*/, 'App.jsx']
  ],
  android: [
    [/\b(tema|estilo|paleta|tipograf|color|material|modo oscuro)\b/i, 'app/src/main/java/com/equipo/app/ui/Theme.kt'],
    [/\b(pantalla|screen|vista|composable)\b/i, 'app/src/main/java/com/equipo/app/ui/Pantalla.kt'],
    [/\b(gradle|dependencia|compilaci[oó]n|build|permiso|manifiesto)\b/i, 'app/build.gradle.kts'],
    [/.*/, 'app/src/main/java/com/equipo/app/MainActivity.kt']
  ],
  // Python: el orden va de lo más específico a lo más general, y cada regla
  // apunta a un archivo DISTINTO. Que cuatro personas trabajen a la vez depende
  // de eso: si dos caen en main.py, el cerrojo por archivo las serializa.
  python: [
    [/\b(readme|documenta|instructivo|manual|c[oó]mo se usa)\b/i, 'README.md'],
    [/\b(prueba|pruebas|test|tests|pytest|caso borde|cobertura)\b/i, 'tests/test_principal.py'],
    [/\b(dependencia|dependencias|requirements|venv|entorno virtual|instalaci[oó]n)\b/i, 'requirements.txt'],
    [/\b(dato|datos|csv|json|archivo de entrada|validaci[oó]n|carga|lectura|parse[oa])\b/i, 'src/datos.py'],
    [/\b(l[oó]gica|n[uú]cleo|procesar|procesamiento|transformar|c[aá]lculo|calcular|algoritmo|regla)\b/i, 'src/nucleo.py'],
    [/\b(cli|comando|argumento|argparse|script|punto de entrada|salida)\b/i, 'main.py'],
    [/.*/, 'main.py']
  ]
};

// Si el proyecto YA tiene un archivo que encaja con lo que pide la tarea, se
// usa ese: continuar lo que existe siempre gana sobre crear al lado.
function archivoExistenteQueEncaja(texto, archivos) {
  const bajo = String(texto).toLowerCase();
  for (const archivo of archivos) {
    const base = archivo.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    if (base.length > 3 && bajo.includes(base)) {
      return archivo;
    }
  }
  // Una mención literal a la ruta ("tocá src/theme.js") manda.
  return archivos.find((a) => bajo.includes(a.toLowerCase())) || null;
}

export function inferirArchivo(texto, stack, archivosExistentes = [], tomados = new Set()) {
  const limpio = String(texto || '').trim();
  if (!limpio) {
    return null;
  }

  const existente = archivoExistenteQueEncaja(limpio, archivosExistentes);
  if (existente && !tomados.has(existente)) {
    return existente;
  }

  const reglas = PISTAS[normalizeStack(stack)] || PISTAS.web;
  for (const [patron, archivo] of reglas) {
    if (patron.test(limpio) && !tomados.has(archivo)) {
      return archivo;
    }
  }

  // Todos los candidatos naturales están tomados: en vez de devolver null
  // —que haría que la tarea bloquee el proyecto entero— se elige el primero
  // libre de la lista. Que dos toquen el mismo archivo se resuelve
  // serializándolos, no parando a todo el equipo.
  const reglasStack = PISTAS[normalizeStack(stack)] || PISTAS.web;
  for (const [, archivo] of reglasStack) {
    if (!tomados.has(archivo)) {
      return archivo;
    }
  }
  return reglasStack[reglasStack.length - 1][1];
}
