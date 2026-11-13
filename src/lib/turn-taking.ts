// M-06: turn-taking semántico — decidir si el habla del usuario CORTA al
// agente según QUÉ dice, no solo que hay energía. backchannel (mm, sí, dale)
// = seguir hablando; stop explícito o contenido nuevo = cortar.

export type InterruptionClass = 'backchannel' | 'barge' | 'content' | 'unclear';

const BACKCHANNEL = new Set([
  // ES rioplatense
  'si', 'sí', 'aja', 'ajá', 'aha', 'mhm', 'mm', 'mmm', 'dale', 'ok', 'okay',
  'claro', 'entiendo', 'ya', 'veo', 'bien', 'perfecto', 'exacto', 'bueno',
  'genial', 'joya', 'ta', 'está', 'esta', 'uh', 'ajja',
  // EN
  'yes', 'yeah', 'yep', 'right', 'got it', 'i see', 'uh-huh', 'uh huh',
  'mm-hmm', 'mm hmm', 'understood', 'nice', 'great', 'sure', 'alright'
]);

const BARGE = [
  'pará', 'para', 'basta', 'callate', 'cállate', 'cállese', 'esperá', 'espera',
  'momento', 'alto ahí', 'no no', 'no, no', 'cortala', 'cortá',
  'stop', 'wait', 'hold on', 'shut up', 'quiet', 'hang on', 'hold it',
  'stop that', 'cut it'
];

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:()"'«»-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clasifica la interrupción del usuario. Vacío/ruido → 'unclear'. */
export function classifyInterruption(text: string): InterruptionClass {
  const clean = norm(text);
  if (!clean || clean.length < 2) {
    return 'unclear';
  }
  // Stop explícito gana (aunque venga con más palabras).
  for (const b of BARGE) {
    if (clean === b || clean.startsWith(`${b} `) || clean.endsWith(` ${b}`) || clean.includes(` ${b} `)) {
      return 'barge';
    }
  }
  const words = clean.split(' ');
  // Backchannel = CORTO y todo-filler. Largo con fillers adentro = contenido.
  if (words.length <= 4 && words.every((w) => BACKCHANNEL.has(w))) {
    return 'backchannel';
  }
  // Frases filler multi-palabra exactas ("got it", "i see", "no no" ya es barge).
  if (BACKCHANNEL.has(clean)) {
    return 'backchannel';
  }
  if (words.length <= 2 && words.every((w) => w.length <= 3 || BACKCHANNEL.has(w))) {
    return 'unclear'; // "eh", "ah si": ruido, esperar más.
  }
  return 'content';
}

/** ¿Corta al agente? backchannel/unclear = no (unclear = esperar más texto). */
export function shouldCut(cls: InterruptionClass): boolean {
  return cls === 'barge' || cls === 'content';
}
