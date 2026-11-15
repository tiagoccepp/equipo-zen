/**
 * T5: Preemptive/quick generation path helpers (feature-flagged, default off).
 *
 * Pure heuristics/state helpers used by meeting-session turn handling.
 * "Speculative" means a turn started early because end-of-turn looked likely;
 * if more user input arrives before commit, the speculative result must be
 * discarded without leaking to the user (no sends, no finals).
 */

export const QUICK_PATH_FLAG_ENV = 'QUICK_PATH';

function normText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lastToken(text) {
  const words = normText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return words[words.length - 1] || '';
}

const TRAILING_CONNECTORS = new Set([
  'y', 'e', 'o', 'u', 'pero', 'porque', 'que', 'como', 'si', 'cuando', 'aunque',
  'entonces', 'ademas', 'tambien', 'despues', 'antes', 'para', 'por', 'con', 'sin',
  'de', 'del', 'al', 'a', 'en', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'mi', 'tu', 'su', 'me', 'te', 'se', 'lo', 'le', 'nos', 'les', 'este', 'esta',
  'ese', 'esa', 'tipo', 'osea',
  'and', 'or', 'but', 'because', 'so', 'if', 'when', 'while', 'although', 'then',
  'also', 'after', 'before', 'for', 'with', 'without', 'to', 'of', 'in', 'on', 'at',
  'the', 'a', 'an', 'my', 'your', 'its', 'our', 'their', 'this', 'that', 'like',
  'i', 'we', 'you', 'he', 'she', 'they', 'it'
]);

export function isQuickPathEnabled(env = process.env, settings = null) {
  if (settings && typeof settings.getQuickPathEnabled === 'function') {
    try {
      return settings.getQuickPathEnabled() === true;
    } catch {
      // fall through to env
    }
  }
  const raw = env?.[QUICK_PATH_FLAG_ENV];
  if (raw == null || raw === '') return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function hasTerminalPunctuation(text) {
  return /[.!?…]+["')\]]*\s*$/.test(normText(text));
}

export function endsWithTrailingConnector(text) {
  const token = lastToken(text);
  return token ? TRAILING_CONNECTORS.has(token) : false;
}

/**
 * Conservative heuristic: should we start a speculative early turn?
 * Only true when the text looks like a completed thought (terminal punctuation
 * or clear short complete utterance) and does not trail off with a connector.
 */
export function shouldPreempt(text, { minChars = 2 } = {}) {
  const clean = normText(text);
  if (clean.length < minChars) return false;
  if (endsWithTrailingConnector(clean)) return false;
  if (hasTerminalPunctuation(clean)) return true;
  // Short acknowledgements/complete-feeling utterances without punctuation.
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount > 0 && wordCount <= 5) return true;
  return false;
}

/**
 * Speculative turn controller: buffers outbound events keyed by turnId until
 * committed, and discards them if cancelled before commit. Safe by default:
 * when not speculative, passThrough is true.
 */
export class SpeculativeTurnController {
  constructor() {
    this.active = null; // { turnId, committed, discarded, buffer, createdAt }
  }

  start(turnId) {
    const state = {
      turnId: String(turnId),
      committed: false,
      discarded: false,
      buffer: [],
      createdAt: Date.now()
    };
    this.active = state;
    return state;
  }

  get(turnId) {
    const a = this.active;
    if (!a) return null;
    return String(turnId) === a.turnId ? a : null;
  }

  isSpeculative(turnId) {
    const s = this.get(turnId);
    return !!(s && !s.committed && !s.discarded);
  }

  /** Returns true if payload should be buffered (hidden) instead of sent now. */
  shouldBuffer(turnId) {
    return this.isSpeculative(turnId);
  }

  buffer(turnId, payload) {
    const s = this.get(turnId);
    if (!s || s.committed || s.discarded) return false;
    s.buffer.push(payload);
    return true;
  }

  commit(turnId) {
    const s = this.get(turnId);
    if (!s || s.discarded || s.committed) return [];
    s.committed = true;
    const out = s.buffer.slice();
    s.buffer.length = 0;
    this.active = null;
    return out;
  }

  discard(turnId, reason = 'discarded') {
    const s = this.get(turnId);
    if (!s || s.committed) return { ok: false, reason: s?.committed ? 'already_committed' : 'not_found' };
    s.discarded = true;
    s.discardReason = reason;
    s.buffer.length = 0;
    this.active = null;
    return { ok: true };
  }

  cancelActive(reason = 'discarded') {
    const a = this.active;
    if (!a) return { ok: false, reason: 'none' };
    return this.discard(a.turnId, reason);
  }
}

export function createQuickPathState() {
  return {
    enabled: false,
    speculative: new SpeculativeTurnController(),
    pendingSpeculative: null, // { turnId, text, source, timer }
    discardedTurnId: null
  };
}
