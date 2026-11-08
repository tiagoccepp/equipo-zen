/**
 * Parsing of the Claude-emitted mood tag.
 *
 * Convention: the assistant prefixes a spoken reply with a tiny machine-readable
 * marker `<<mood:NAME>>` (for example `<<mood:happy>>`). The avatar reads the
 * mood and ALWAYS strips every marker from the text, so a stray or mid-sentence
 * tag is silently removed rather than spoken aloud or shown in the transcript.
 *
 * The matcher is tolerant (case-insensitive, whitespace-flexible, keyword length
 * capped to avoid ReDoS) and never throws. An unknown keyword is stripped but
 * yields no mood (the avatar keeps its current mood).
 */

import { isMood, type Mood } from './moods';

export interface ParsedMood {
  /** The first valid mood found, or null if none. */
  mood: Mood | null;
  /** The input with every mood marker removed (leading whitespace trimmed). */
  stripped: string;
}

// Strip ANY mood-marker-shaped token (even malformed ones, e.g. `<<mood:>>` or an
// overlong/space-containing name) so a stray marker is never spoken or shown. The
// body is a bounded negated class `[^>]{0,64}` (linear, no catastrophic
// backtracking). The captured body is then validated separately to pick the mood.
const MARKER = /<<\s*mood\s*:([^>]{0,64})>>/gi;
// A valid mood keyword: the body trimmed to 1..24 of [a-z0-9_-].
const KEYWORD = /^\s*([a-z0-9_-]{1,24})\s*$/i;

export function parseMoodMarker(text: string): ParsedMood {
  if (!text?.includes('<<')) {
    return { mood: null, stripped: text };
  }
  let mood: Mood | null = null;
  MARKER.lastIndex = 0;
  const stripped = text
    .replace(MARKER, (_match: string, body: string): string => {
      if (mood === null) {
        const keyword = KEYWORD.exec(body);
        if (keyword) {
          const lower = keyword[1].toLowerCase();
          if (isMood(lower)) {
            mood = lower;
          }
        }
      }
      return ''; // always strip, valid keyword or not
    })
    .replace(/^\s+/, '');
  return { mood, stripped };
}
