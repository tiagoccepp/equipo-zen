// M-06/T2: semantic turn-taking + end-of-turn heuristics.
// Decide whether user speech CUTS the agent based on WHAT it says, not just
// energy (backchannel = keep talking; explicit stop/new content = cut), and
// estimate whether a turn is likely complete (silence + punctuation + trailing
// connectors). Pure, lightweight, conservative (avoid cutting user off).

export type InterruptionClass = 'backchannel' | 'barge' | 'content' | 'unclear';

const BACKCHANNEL = new Set([
  // Spanish (Rioplatense) - functional recognition tokens / short acknowledgements
  'si', 'sí', 'aja', 'ajá', 'aha', 'mhm', 'mm', 'mmm', 'mmmm', 'dale', 'ok', 'okay',
  'claro', 'entiendo', 'ya', 'veo', 'bien', 'perfecto', 'exacto', 'bueno',
  'genial', 'joya', 'ta', 'está', 'esta', 'uh', 'uhm', 'aja', 'ajja', 'sipi',
  'listo', 'copiado', 'de una', 'va', 'sep', 'sip',
  // EN
  'yes', 'yeah', 'yep', 'yup', 'right', 'got it', 'i see', 'uh-huh', 'uh huh',
  'mm-hmm', 'mm hmm', 'understood', 'nice', 'great', 'sure', 'alright', 'all right',
  'cool', 'okey', 'k', 'kk', 'roger', 'copy'
]);

// Multi-word backchannel phrases (normalized, space-joined).
const BACKCHANNEL_PHRASES = new Set([
  'ya veo', 'esta bien', 'está bien', 'de acuerdo', 'todo bien', 'ah ok', 'ah bueno',
  'ah si', 'ah sí', 'ya ya', 'si si', 'sí sí', 'ok ok', 'dale dale',
  'i see', 'got it', 'all right', 'sounds good', 'gotcha', 'makes sense'
]);

const BARGE = [
  'pará', 'para', 'basta', 'callate', 'cállate', 'cállese', 'esperá', 'espera',
  'momento', 'alto ahí', 'alto ahi', 'no no', 'cortala', 'cortá', 'corta',
  'escuchame', 'escuchá', 'frená', 'frena', 'dejame hablar', 'deja de hablar',
  'stop', 'wait', 'hold on', 'shut up', 'quiet', 'hang on', 'hold it',
  'stop that', 'cut it', 'one moment', 'listen', 'let me speak', 'never mind',
  'no wait', 'no espera', 'no esperes'
];

// Trailing connectors / incomplete continuations: if a turn ends with these,
// it is likely NOT complete (speaker will continue). Conservative: better to
// wait than cut off mid-thought.
const TRAILING_CONNECTORS = new Set([
  // ES
  'y', 'e', 'o', 'u', 'pero', 'porque', 'que', 'como', 'si', 'cuando', 'aunque',
  'entonces', 'ademas', 'además', 'tambien', 'también', 'despues', 'después',
  'antes', 'para', 'por', 'con', 'sin', 'de', 'del', 'al', 'a', 'en', 'la', 'el',
  'los', 'las', 'un', 'una', 'unos', 'unas', 'mi', 'tu', 'su', 'me', 'te', 'se',
  'lo', 'le', 'nos', 'les', 'este', 'esta', 'ese', 'esa', 'tipo', 'osea', 'o sea',
  // EN
  'and', 'or', 'but', 'because', 'so', 'if', 'when', 'while', 'although', 'then',
  'also', 'after', 'before', 'for', 'with', 'without', 'to', 'of', 'in', 'on', 'at',
  'the', 'a', 'an', 'my', 'your', 'its', 'our', 'their', 'this', 'that', 'like',
  'i', 'we', 'you', 'he', 'she', 'they', 'it'
]);

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:()"'«»\u2014\u2013-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKeepPunct(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?…]+["')\]]*\s*$/.test(String(text || '').trim());
}

/** Classifies the user interruption. Empty/noise → 'unclear'. */
export function classifyInterruption(text: string): InterruptionClass {
  return assessInterruption(text).class;
}

export interface InterruptionAssessment {
  class: InterruptionClass;
  /** True for short acknowledgements/backchannels ("ajá", "dale", "mm", "ok"). */
  isBackchannel: boolean;
  /** True when this should hard-interrupt/cancel ongoing bot speech. */
  shouldInterrupt: boolean;
  /** 0..1 strength: 0 backchannel/unclear, ~0.6 substantive content, 1.0 explicit barge. */
  interruptStrength: number;
  reason: string;
}

export function assessInterruption(
  text: string,
  opts: { agentSpeaking?: boolean } = {}
): InterruptionAssessment {
  const raw = String(text || '').trim();
  const clean = norm(raw);
  if (!clean || clean.length < 2) {
    return { class: 'unclear', isBackchannel: false, shouldInterrupt: false, interruptStrength: 0, reason: 'empty' };
  }

  // Explicit stop/command wins (even when it comes with more words).
  for (const b of BARGE) {
    if (clean === b || clean.startsWith(`${b} `) || clean.endsWith(` ${b}`) || clean.includes(` ${b} `)) {
      return { class: 'barge', isBackchannel: false, shouldInterrupt: true, interruptStrength: 1, reason: 'barge-command' };
    }
  }

  const words = clean.split(' ').filter(Boolean);
  const backchannelPhrase = BACKCHANNEL_PHRASES.has(clean);

  // Backchannel = short acknowledgement/filler, all tokens filler-like.
  if (backchannelPhrase || (words.length <= 4 && words.length > 0 && words.every((w) => BACKCHANNEL.has(w)))) {
    return { class: 'backchannel', isBackchannel: true, shouldInterrupt: false, interruptStrength: 0, reason: 'backchannel' };
  }
  if (BACKCHANNEL.has(clean)) {
    return { class: 'backchannel', isBackchannel: true, shouldInterrupt: false, interruptStrength: 0, reason: 'backchannel' };
  }

  // Very short ambiguous noise: wait for more text, don't cut.
  if (words.length <= 2 && words.every((w) => w.length <= 3 || BACKCHANNEL.has(w))) {
    return { class: 'unclear', isBackchannel: false, shouldInterrupt: false, interruptStrength: 0.1, reason: 'ambiguous-short' };
  }

  // Substantive speech / real content: should interrupt bot speech.
  const strength = Math.min(1, 0.55 + Math.min(words.length, 8) * 0.05);
  return {
    class: 'content',
    isBackchannel: false,
    shouldInterrupt: true,
    interruptStrength: strength,
    reason: opts.agentSpeaking ? 'substantive-during-agent' : 'substantive'
  };
}

/** Does it cut the agent? backchannel/unclear = no (unclear = wait for more text). */
export function shouldCut(cls: InterruptionClass): boolean {
  return cls === 'barge' || cls === 'content';
}

export interface TurnCompletionInput {
  /** Transcript text or current hint/tail (best available). */
  text?: string;
  /** Optional explicit tail (overrides deriving from text). */
  hintEnd?: string;
  /** Silence observed so far (ms), if known. */
  silenceMs?: number;
  /** Silence threshold that would close the turn (ms), if known. */
  endSilenceMs?: number;
  /** Speech duration so far (ms), if known. */
  speechMs?: number;
}

export interface TurnCompletionAssessment {
  /** Conservative estimate: true only when completion looks likely. */
  likelyComplete: boolean;
  /** 0..1 confidence in the estimate. */
  confidence: number;
  /** Human/debug reasons. */
  reasons: string[];
  /** Turn ends with a connector suggesting more speech is coming. */
  trailingConnector: boolean;
  /** Turn ends with terminal punctuation (?, !, ., …). */
  terminalPunctuation: boolean;
}

export function assessTurnCompletion(input: TurnCompletionInput = {}): TurnCompletionAssessment {
  const raw = normKeepPunct(input.hintEnd ?? input.text ?? '');
  const clean = norm(raw);
  const words = clean ? clean.split(' ').filter(Boolean) : [];
  const last = words[words.length - 1] || '';
  const terminalPunctuation = hasTerminalPunctuation(raw);
  const trailingConnector = !!last && TRAILING_CONNECTORS.has(last);
  const reasons: string[] = [];

  if (terminalPunctuation) reasons.push('terminal-punctuation');
  if (trailingConnector) reasons.push('trailing-connector');
  if (words.length === 0) reasons.push('empty');

  const silenceMs = Number(input.silenceMs);
  const endSilenceMs = Number(input.endSilenceMs);
  const silenceSatisfied = Number.isFinite(silenceMs) && Number.isFinite(endSilenceMs) && endSilenceMs > 0
    ? silenceMs >= endSilenceMs
    : Number.isFinite(silenceMs) && silenceMs >= 700; // conservative fallback

  if (silenceSatisfied) reasons.push('silence-satisfied');

  // Conservative: trailing connector strongly suggests incomplete, even with silence.
  if (trailingConnector) {
    return {
      likelyComplete: false,
      confidence: terminalPunctuation ? 0.45 : 0.8,
      reasons,
      trailingConnector,
      terminalPunctuation
    };
  }

  if (terminalPunctuation) {
    const conf = silenceSatisfied ? 0.95 : 0.8;
    return { likelyComplete: true, confidence: conf, reasons, trailingConnector, terminalPunctuation };
  }

  // Short complete-feeling utterances without punctuation (common in STT hints):
  // "gracias", "si", "ok gracias" — likely complete if silence is satisfied.
  if (silenceSatisfied && words.length > 0 && words.length <= 6) {
    reasons.push('short-utterance-silence');
    return { likelyComplete: true, confidence: 0.65, reasons, trailingConnector, terminalPunctuation };
  }

  if (silenceSatisfied && words.length > 6) {
    reasons.push('long-utterance-needs-punctuation');
    return { likelyComplete: false, confidence: 0.55, reasons, trailingConnector, terminalPunctuation };
  }

  reasons.push('insufficient-evidence');
  return { likelyComplete: false, confidence: 0.6, reasons, trailingConnector, terminalPunctuation };
}

