// ═══════════════════════════════════════════════════════════════════════
// Gestos: protocolo [[gesto:NOMBRE]] (T2a, Fase 2).
//
// Puro y testeable en node: sin FS, sin imports del frontend. El backend
// parsea el tag del texto del agente, limpia el texto visible y emite el
// evento `gesto {agentId, gesto}` que main cablea al frontend (5 líneas:
// field.setGlyph(agentId, gesto)).
//
// Registro: VALID_GESTOS trae los 100 (50 T2a + 50 T2b) + figuras de
// estado (5 estados + 5 shapes clásicos). El test cruza ambas listas
// contra glyphs-a.ts y glyphs-b.ts.
// ═══════════════════════════════════════════════════════════════════════

// 50 de T2a — DEBE matchear GLYPH_A_NAMES de src/fx/glyphs-a.ts (el test
// lo verifica; si agregás un glifo en A, agregalo acá también).
export const GESTOS_A = [
  // Manos (12)
  'saludar', 'aplaudir', 'pulgar_arriba', 'paz', 'puno', 'mano_abierta',
  'senalar', 'ok_mano', 'abrazo', 'chocar_las_cinco', 'adios', 'contar',
  // Caras (10)
  'sonrisa', 'risa', 'guino', 'sorpresa', 'tristeza', 'enojo', 'calma',
  'enamorado', 'llanto', 'verguenza',
  // Símbolos (12)
  'corazon', 'estrella', 'check', 'cruz', 'pregunta', 'exclamacion',
  'flecha_arriba', 'flecha_abajo', 'flecha_derecha', 'flecha_izquierda',
  'infinito', 'circulo',
  // Objetos (10)
  'taza', 'libro', 'llave', 'candado', 'lampara', 'regalo', 'campana',
  'reloj', 'carta', 'microfono',
  // Letras (6)
  'letra_a', 'letra_e', 'letra_o', 'letra_t', 'letra_v', 'letra_x'
];

// 50 de T2b — DEBE matchear los names de GLYPHS_B en src/fx/glyphs-b.ts
// (el test lo verifica). Main los suma acá para que el backend valide los
// 100 sin importar TS del frontend (el server corre JS puro).
export const GESTOS_B = [
  // Naturaleza (7)
  'arbol', 'pino', 'flor', 'hoja', 'montana', 'ola_mar', 'seta',
  // Comida (6)
  'manzana', 'pizza', 'mate', 'copa', 'helado', 'dona',
  // Herramientas (6)
  'martillo', 'destornillador', 'tuerca', 'clavo', 'pincel', 'engranaje',
  // Transporte (6)
  'auto', 'bicicleta', 'avion', 'barco', 'cohete', 'ancla',
  // Deportes (5)
  'pelota', 'trofeo', 'medalla', 'raqueta', 'pesa',
  // Clima (6)
  'sol', 'luna', 'nube', 'gota', 'rayo', 'copo',
  // Música (4)
  'nota', 'tambor', 'guitarra', 'parlante',
  // Tech (5)
  'chip', 'antena', 'satelite', 'robot', 'bateria',
  // Manos extra (3)
  'dedos_cruzados', 'saludo_vulcano', 'mano_rock',
  // Abstractos (2)
  'mandala', 'espiral'
];

// Figuras de estado: estados visuales + shapes clásicos (un agente puede
// pedir explícitamente la figura de un estado con el mismo tag).
export const STATE_NAMES = ['idle', 'escuchando', 'hablando', 'pensando', 'trabajando'];
export const SHAPE_NAMES = ['sphere', 'ring', 'wave', 'torus', 'cube'];

// Normalización (espejo de foldGlyphName en glyphs-a.ts): minúsculas +
// sin tildes + espacios→_. "GUIÑO", "Pulgar Arriba" y "pulgar_arriba"
// resuelven igual.
export function foldGestoName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function buildValid() {
  const set = new Set();
  for (const n of GESTOS_A) set.add(foldGestoName(n));
  for (const n of GESTOS_B) set.add(foldGestoName(n));
  for (const n of STATE_NAMES) set.add(foldGestoName(n));
  for (const n of SHAPE_NAMES) set.add(foldGestoName(n));
  return set;
}

// Registro vivo: T2b/main suman sus 50 con registerGestos().
export const VALID_GESTOS = buildValid();

// Suma nombres al registro. Devuelve { added, skipped } (skipped = ya
// existían, incluido colisión con A: gana el primero registrado).
export function registerGestos(names) {
  let added = 0;
  const skipped = [];
  for (const raw of names ?? []) {
    const key = foldGestoName(raw);
    if (!key || VALID_GESTOS.has(key)) {
      skipped.push(String(raw));
      continue;
    }
    VALID_GESTOS.add(key);
    added += 1;
  }
  return { added, skipped };
}

export function isValidGesto(name) {
  return VALID_GESTOS.has(foldGestoName(name));
}

export function listGestos() {
  return [...VALID_GESTOS].sort();
}

const TAG_RE = /\[\[\s*gesto\s*:\s*([^\][\]]+?)\s*\]\]/gi;

function freshTagRe() {
  return new RegExp(TAG_RE.source, TAG_RE.flags);
}

// Parsea el primer tag [[gesto:NOMBRE]] válido del texto.
// → { gesto: string|null (nombre fold, ej. 'pulgar_arriba'), cleanText }
// Reglas: case-insensitive; primer tag VÁLIDO gana (si el primero es
// desconocido se sigue buscando); TODOS los tags gesto se quitan del
// texto limpio (válidos o no); espacios colapsados + trim.
export function parseGesto(text) {
  const input = String(text ?? '');
  let gesto = null;
  for (const m of input.matchAll(freshTagRe())) {
    const cand = foldGestoName(m[1]);
    if (cand && VALID_GESTOS.has(cand)) {
      gesto = cand;
      break;
    }
  }
  const cleanText = input
    .replace(freshTagRe(), '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
  return { gesto, cleanText };
}
