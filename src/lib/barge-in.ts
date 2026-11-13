// ═══════════════════════════════════════════════════════════════════════
// Barge-in: the "shut the agent up, the person is talking" decision.
//
// It lives here outside the mic pipeline so it can be tested without a
// browser: a pure function taking the accumulated state plus one audio
// frame, returning what to do with the agent's audio.
//
// The reasoning, in plain words:
//
//  1. As soon as something comes in CLEARLY above threshold (1.1×) we duck
//     the agent's volume. It's instant and reversible: if it was a throat
//     clear, nothing happened; if it was the person starting to speak, we
//     already hear them over the agent. The margin exists because noise
//     sitting right at the threshold made the volume flicker (it sounded
//     like the agent moving away and closer). Once ducked, a minimum 400 ms
//     hold before restoring, for the same reason.
//  2. We only cut the agent when the voice SUSTAINS above 1.5× threshold
//     for `confirmMs` (300 ms). The factor exists because of echo: the
//     speaker feeds the agent's own voice back into the mic at a moderate,
//     sustained RMS, just above the start threshold. That echo ducks
//     (harmless, and it even lowers the echo) but never confirms, so the
//     agent never interrupts itself.
//  3. A sharp thump (slamming door, mouse on the desk) is one very loud
//     frame and nothing else: it never reaches `confirmMs` and gets dropped.
//  4. Pauses between syllables don't erase the accumulation: we only release
//     the duck and clear the counter after `releaseMs` of silence. Without
//     that hysteresis the agent's volume would pump on every breath.
// ═══════════════════════════════════════════════════════════════════════

export type BargeInState = {
  // ms of "loud" voice (≥ confirmRatio × threshold) accumulated in the current burst.
  loudMs: number;
  // consecutive ms below threshold since the last frame with voice.
  quietMs: number;
  // Whether the agent's audio is ducked and owed a restore.
  ducked: boolean;
  // Ms since ducking started (for the anti-flicker minimum hold).
  duckMs: number;
};

export type BargeInInput = {
  // Frame RMS (0..1), as computed by the capture AudioWorklet.
  rms: number;
  // Frame duration in ms (60 ms with the current capture).
  durationMs: number;
  // VAD voice-start threshold (depends on the chosen sensitivity).
  startThreshold: number;
  // Is an agent sounding or with audio in flight? If not, nobody to cut.
  agentSpeaking: boolean;
  // Is the person already on their turn? Then barge-in already did its job.
  userSpeaking?: boolean;
};

export type BargeInDecision = {
  // Duck the agent's audio now (zero latency, without telling the server).
  duck: boolean;
  // Confirmed: send `interrupt` to the server, cut the audio, restore volume.
  interrupt: boolean;
  // False positive or the agent already finished: restore volume and clear.
  reset: boolean;
  // State to keep for the next frame (the function mutates nothing).
  state: BargeInState;
};

// Barge-in thresholds in one place (tests import these values
// instead of repeating loose numbers).
export const BARGE_IN = {
  // How much louder than the voice threshold a frame must be to
  // count as "the person is talking" rather than agent echo.
  // 1.5× (was 1.4×): with the sensitive mic any noise would cut.
  confirmRatio: 1.5,
  // Sustained loud voice needed to cut the agent. 300 ms (5 frames
  // of 60 ms): a transient (door slam <100 ms, short cough) never makes it,
  // and real voice still cuts in ~360 ms after the person opens their mouth.
  confirmMs: 300,
  // Margin to START ducking: keeps noise sitting right at the threshold
  // from flickering the agent's volume (it sounded like the agent moving
  // away and closer to the mic).
  duckMargin: 1.1,
  // Minimum duck hold: once ducked, no restore before this elapses even
  // in silence (anti-flicker; restore still waits for releaseMs of silence,
  // whichever comes last wins).
  minDuckHoldMs: 400,
  // Silence needed to release the duck (inter-syllable hysteresis).
  releaseMs: 160,
  // How much prior audio we keep so the phrase triggering the
  // barge-in reaches the server whole: the confirmation window plus
  // margin for the first word's attack.
  preBufferMs: 640
} as const;

export function idleBargeInState(): BargeInState {
  return { loudMs: 0, quietMs: 0, ducked: false, duckMs: 0 };
}

const IDLE: BargeInDecision['state'] = { loudMs: 0, quietMs: 0, ducked: false, duckMs: 0 };

export function evaluateBargeIn(state: BargeInState, input: BargeInInput): BargeInDecision {
  const rms = Number.isFinite(input.rms) ? Math.max(0, input.rms) : 0;
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
  const startThreshold = Number.isFinite(input.startThreshold)
    ? Math.max(0.0001, input.startThreshold)
    : 0.0001;

  // Without an agent speaking (or with the person already on turn) there's no barge-in:
  // state returns to zero and only volume restore remains if we ducked.
  // Without this, a half-filled counter survives the turn and the next
  // door slam interrupts the next agent right away.
  if (!input.agentSpeaking || input.userSpeaking) {
    return { duck: false, interrupt: false, reset: state.ducked, state: { ...IDLE } };
  }

  // Duck entry with margin: noise sitting right at the threshold doesn't
  // duck (flicker), only 1.1× and up.
  if (rms >= startThreshold * BARGE_IN.duckMargin) {
    const loudMs = rms >= startThreshold * BARGE_IN.confirmRatio
      ? state.loudMs + durationMs
      : state.loudMs;

    if (loudMs >= BARGE_IN.confirmMs) {
      // Confirmed: the caller cuts the audio, tells the server and
      // restores the volume, so state starts clean.
      return { duck: false, interrupt: true, reset: false, state: { ...IDLE } };
    }

    return {
      duck: true,
      interrupt: false,
      reset: false,
      state: { loudMs, quietMs: 0, ducked: true, duckMs: state.duckMs + durationMs }
    };
  }

  // Silence with nothing pending: state is already clean, we don't dirty it
  // counting calm ms nobody cares about.
  if (!state.ducked && state.loudMs === 0) {
    return { duck: false, interrupt: false, reset: false, state: { ...IDLE } };
  }

  const quietMs = state.quietMs + durationMs;
  const duckMs = state.duckMs + durationMs;
  // Restore only with enough silence AND hold fulfilled (last one wins).
  if (quietMs >= BARGE_IN.releaseMs && duckMs >= BARGE_IN.minDuckHoldMs) {
    return {
      duck: false,
      interrupt: false,
      reset: state.ducked,
      state: { ...IDLE }
    };
  }

  // Short pause (or unfulfilled hold): stay ducked, keep the accumulation.
  return {
    duck: false,
    interrupt: false,
    reset: false,
    state: { loudMs: state.loudMs, quietMs, ducked: state.ducked, duckMs }
  };
}

// Capture pre-buffer: the frames before speech onset that get
// sent to the server when VAD confirms voice. It must cover the whole
// barge-in confirmation window; otherwise the interrupting phrase arrives
// cut off ("…ry, stop" instead of "sorry, stop").
export function trimPreBuffer<T extends { durationMs: number }>(
  chunks: T[],
  budgetMs: number = BARGE_IN.preBufferMs
): T[] {
  let total = 0;
  const kept: T[] = [];
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    kept.push(chunk);
    total += Math.max(0, chunk.durationMs);
    if (total >= budgetMs) {
      break;
    }
  }
  return kept.reverse();
}
