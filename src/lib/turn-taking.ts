// M-06: semantic turn-taking — decide whether user speech CUTS the
// agent based on WHAT it says, not just that there is energy. Backchannel (e.g. "mm", "yes", "ok")
// = keep talking; explicit stop or new content = cut.

export type InterruptionClass = 'backchannel' | 'barge' | 'content' | 'unclear';

const BACKCHANNEL = new Set([
  // Spanish (Rioplatense) - functional recognition tokens
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

/** Classifies the user interruption. Empty/noise → 'unclear'. */
export function classifyInterruption(text: string): InterruptionClass {
  const clean = norm(text);
  if (!clean || clean.length < 2) {
    return 'unclear';
  }
  // Explicit stop wins (even when it comes with more words).
  for (const b of BARGE) {
    if (clean === b || clean.startsWith(`${b} `) || clean.endsWith(` ${b}`) || clean.includes(` ${b} `)) {
      return 'barge';
    }
  }
  const words = clean.split(' ');
  // Backchannel = SHORT and all filler. Long with fillers inside = content.
  if (words.length <= 4 && words.every((w) => BACKCHANNEL.has(w))) {
    return 'backchannel';
  }
  // Frases filler multi-palabra exactas ("got it", "i see", "no no" ya es barge).
  if (BACKCHANNEL.has(clean)) {
    return 'backchannel';
  }
  if (words.length <= 2 && words.every((w) => w.length <= 3 || BACKCHANNEL.has(w))) {
    return 'unclear'; // "eh", "ah si": noise, wait for more.
  }
  return 'content';
}

/** Does it cut the agent? backchannel/unclear = no (unclear = wait for more text). */
export function shouldCut(cls: InterruptionClass): boolean {
  return cls === 'barge' || cls === 'content';
}
