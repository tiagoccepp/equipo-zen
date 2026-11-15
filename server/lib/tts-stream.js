// Sentence chunking + cancellable progressive queue helpers for TTS.
// Pure/testable primitives: no network, no audio playback, no DOM.

/**
 * Split text into speakable chunks/sentences for progressive TTS.
 * Conservative: prefers sentence boundaries, falls back to clause/length splits.
 */
export function splitSentences(text, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(24, Math.floor(options.maxChars)) : 220;
  const minChars = Number.isFinite(options.minChars) ? Math.max(1, Math.floor(options.minChars)) : 2;
  const keepWhitespace = options.keepWhitespace === true;

  const input = String(text || '');
  const normalized = input.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [];

  // Primary split: sentence-ending punctuation followed by space/newline/end.
  // Keep punctuation attached to the sentence.
  const rough = [];
  let buf = '';
  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    buf += ch;
    const isEndPunct = ch === '.' || ch === '!' || ch === '?' || ch === '…' || ch === '\n';
    if (!isEndPunct) continue;

    // Avoid splitting obvious abbreviations/initials/decimals.
    if (ch === '.' && !shouldSplitAtDot(buf, chars, i)) continue;

    const next = chars[i + 1];
    if (next && !/\s|\n/.test(next)) continue;
    rough.push(buf);
    buf = '';
  }
  if (buf) rough.push(buf);

  const cleaned = rough
    .map((s) => (keepWhitespace ? s : s.trim()))
    .filter((s) => String(s).trim().length > 0);

  // Merge tiny/orphan fragments and split oversized chunks.
  const merged = mergeSmall(cleaned, minChars, maxChars);
  const out = [];
  for (const chunk of merged) {
    if (chunk.length <= maxChars) {
      out.push(chunk.trim());
    } else {
      out.push(...splitLongChunk(chunk, maxChars).map((s) => s.trim()).filter(Boolean));
    }
  }
  return out.filter(Boolean);
}

function shouldSplitAtDot(buf, chars, index) {
  // buf ends with '.' at index
  const before = buf.slice(0, -1);
  const tokenMatch = before.match(/([^\s]+)$/);
  const token = tokenMatch ? tokenMatch[1] : '';
  if (!token) return true;

  // Decimal number: 3.14
  if (/^\d+$/.test(token)) {
    const next = chars[index + 1];
    if (next && /\d/.test(next)) return false;
  }

  // Initials / acronyms: J. R. R., U.S.A.
  if (/^(?:[A-Za-z]\.)*[A-Za-z]$/.test(token + '.')) {
    // If token is a single letter (initial), don't split unless followed by newline/end+capital sentence start heuristic weak; safer keep together.
    if (/^[A-Za-z]$/.test(token)) return false;
  }

  // Common abbreviations (ES/EN, conservative list)
  const abbr = token.toLowerCase().replace(/\.$/, '');
  const ABBRS = new Set([
    'sr', 'sra', 'srta', 'dr', 'dra', 'lic', 'ing', 'arq', 'prof', 'etc', 'p', 'pp', 'ej', 'vs', 'ud', 'uds',
    'mr', 'mrs', 'ms', 'jr', 'st', 'dept', 'inc', 'ltd', 'no', 'fig', 'approx'
  ]);
  if (ABBRS.has(abbr)) return false;

  // Ellipsis handled as single char sometimes; "..." already mostly fine.
  if (token.endsWith('.')) return false;
  return true;
}

function mergeSmall(chunks, minChars, maxChars) {
  if (chunks.length <= 1) return chunks.slice();
  const mergeFloor = Math.max(2, Number(minChars) || 2);
  const out = [];
  let cur = '';
  for (const raw of chunks) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (!cur) {
      cur = s;
      continue;
    }
    const curTiny = cur.length < mergeFloor;
    const sTiny = s.length < mergeFloor;
    const canMerge = (curTiny || sTiny) && (cur.length + 1 + s.length <= maxChars);
    if (canMerge) {
      cur = `${cur} ${s}`.trim();
    } else {
      out.push(cur);
      cur = s;
    }
  }
  if (cur) {
    // Avoid leaving a tiny orphan tail when possible.
    if (out.length > 0 && cur.length < mergeFloor && (out[out.length - 1].length + 1 + cur.length <= maxChars)) {
      out[out.length - 1] = `${out[out.length - 1]} ${cur}`.trim();
    } else {
      out.push(cur);
    }
  }
  return out;
}

function splitLongChunk(text, maxChars) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= maxChars) return [s];

  // Prefer clause boundaries, then spaces.
  const boundaries = [', ', '; ', ': ', ' — ', ' – ', ' - '];
  const out = [];
  let rest = s;
  while (rest.length > maxChars) {
    let cut = -1;
    for (const b of boundaries) {
      const idx = rest.lastIndexOf(b, maxChars);
      if (idx > Math.floor(maxChars * 0.45)) {
        cut = Math.max(cut, idx + b.length - 1); // include punctuation char
      }
    }
    if (cut < 0) {
      const space = rest.lastIndexOf(' ', maxChars);
      cut = space > Math.floor(maxChars * 0.45) ? space : maxChars;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
    if (!rest) break;
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Cancellation/generation tracker for turn-scoped async work.
 */
export function createTurnCancellation() {
  // turnId -> generation number (monotonic). A job is valid only if its generation
  // matches the current generation at execution points.
  const generations = new Map();
  const cancelled = new Set();

  return {
    /** Start/advance a turn generation. Returns the active generation. */
    start(turnId) {
      if (!turnId) return 0;
      const next = (generations.get(turnId) || 0) + 1;
      generations.set(turnId, next);
      cancelled.delete(turnId);
      return next;
    },
    /** Current generation for turnId (0 if unknown). */
    generation(turnId) {
      if (!turnId) return 0;
      return generations.get(turnId) || 0;
    },
    /** Mark a turn/generation as cancelled. If generation omitted, cancels current. */
    cancel(turnId, generation = null) {
      if (!turnId) return;
      cancelled.add(cancelKey(turnId, generation));
      // Also mark current-turn key for convenience when generation omitted.
      if (generation == null) cancelled.add(cancelKey(turnId, null));
    },
    /** True if this specific turn+generation is cancelled or superseded. */
    isCancelled(turnId, generation = null) {
      if (!turnId) return false;
      if (cancelled.has(cancelKey(turnId, null))) return true;
      if (generation != null && cancelled.has(cancelKey(turnId, generation))) return true;
      // Superseded by newer generation.
      if (generation != null) {
        const cur = generations.get(turnId) || 0;
        if (cur > generation) return true;
      }
      return false;
    },
    /** Forget tracking for a turn (optional cleanup). */
    clear(turnId) {
      if (!turnId) return;
      generations.delete(turnId);
      for (const k of Array.from(cancelled)) {
        if (k === `${turnId}` || String(k).startsWith(`${turnId}::`)) cancelled.delete(k);
      }
    },
    /** Snapshot for debugging/tests. */
    _debug() {
      return { generations: new Map(generations), cancelled: new Set(cancelled) };
    }
  };
}

function cancelKey(turnId, generation) {
  return generation == null ? String(turnId) : `${String(turnId)}::${Number(generation)}`;
}

/**
 * Progressive cancellable queue: processes items in order with optional
 * concurrency 1 (default), supports abort/cancel checks between steps.
 *
 * Each item: { id?, text/chunk, turnId?, generation?, data? }
 */
export function createProgressiveQueue({
  concurrency = 1,
  worker,
  isCancelled,
  onStart,
  onItem,
  onError,
  onDrain
} = {}) {
  if (typeof worker !== 'function') throw new Error('createProgressiveQueue: worker required');
  const max = Math.max(1, Math.floor(Number(concurrency) || 1));
  const q = [];
  let active = 0;
  let closed = false;
  let drainRequested = false;
  let drainResolve = null;

  const maybeDrain = () => {
    if (active === 0 && q.length === 0) {
      onDrain?.();
      if (drainRequested && drainResolve) {
        const r = drainResolve;
        drainResolve = null;
        drainRequested = false;
        r();
      }
    }
  };

  const pump = () => {
    while (active < max && q.length > 0) {
      if (closed) {
        q.length = 0;
        break;
      }
      const item = q.shift();
      if (item == null) continue;
      if (isCancelled?.(item)) {
        continue;
      }
      active += 1;
      onStart?.(item);
      Promise.resolve()
        .then(() => worker(item))
        .then(
          (result) => {
            if (!isCancelled?.(item)) onItem?.(item, result);
          },
          (err) => {
            if (!isCancelled?.(item)) onError?.(item, err);
          }
        )
        .finally(() => {
          active -= 1;
          pump();
          maybeDrain();
        });
    }
    maybeDrain();
  };

  return {
    push(item) {
      if (closed) return false;
      q.push(item);
      pump();
      return true;
    },
    /** Drop pending items (optionally matching predicate). Active work keeps running. */
    clearPending(predicate = null) {
      if (!predicate) {
        q.length = 0;
      } else {
        for (let i = q.length - 1; i >= 0; i -= 1) {
          if (predicate(q[i])) q.splice(i, 1);
        }
      }
      maybeDrain();
    },
    /** Stop accepting new work and drop pending. */
    close() {
      closed = true;
      q.length = 0;
      maybeDrain();
    },
    stats() {
      return { queued: q.length, active, closed };
    },
    drain() {
      if (active === 0 && q.length === 0) return Promise.resolve();
      drainRequested = true;
      return new Promise((resolve) => { drainResolve = resolve; });
    }
  };
}

/**
 * Helper: plan progressive synthesis for text split into sentence chunks.
 * Returns ordered chunk descriptors; caller controls actual synthesis/playback.
 */
export function planSentenceChunks(text, options = {}) {
  const chunks = splitSentences(text, options);
  return chunks.map((chunk, index) => ({
    index,
    text: chunk,
    first: index === 0,
    last: index === chunks.length - 1,
    total: chunks.length
  }));
}
