/**
 * Barge-resume helpers for voice turns (T3).
 *
 * Tracks spoken vs pending output segments for a turn so a false barge-in can
 * resume playback from the next pending segment without regenerating audio.
 *
 * Integration model (designed for wiring into VoiceOut by T1/T-integration):
 * - Register every segment in order as it is queued/synthesised for a turn.
 * - Mark a segment started when VoiceOut schedules it (e.g. onChunkStart/tag).
 * - On interruption: call interrupt() AFTER flushing VoiceOut. Pending segments
 *   are retained; started/current segment is considered cut and not replayed.
 * - If the interruption is classified as false (backchannel/noise), call
 *   resume() and re-enqueue the returned segments into VoiceOut in order.
 * - If the interruption is real or a new turn begins, call cancel()/resetTurn()
 *   to drop retained segments.
 *
 * Pure data/state transitions; no browser/audio dependencies.
 */

export type BargeSegmentStatus = 'pending' | 'started';

export interface BargeSegment<T = unknown> {
  /** Stable id within the turn (caller-provided). */
  id: string;
  /** Opaque payload needed to replay this segment (e.g. pcm/mp3 descriptor). */
  payload: T;
  /** Optional opaque tag (e.g. VoiceOut chunk tag) for markStarted lookups. */
  tag?: unknown;
  status: BargeSegmentStatus;
}

export type BargeResumePhase = 'idle' | 'playing' | 'interrupted' | 'cancelled';

export interface BargeResumeSnapshot<T = unknown> {
  turnId: string | null;
  phase: BargeResumePhase;
  segments: ReadonlyArray<BargeSegment<T>>;
}

export interface InterruptResult<T = unknown> {
  /** True when there is retained work that can be resumed. */
  canResume: boolean;
  /** Segments still pending after the interruption point. */
  pending: BargeSegment<T>[];
  /** Segment that was started/current at interruption time, if any. */
  interruptedSegment: BargeSegment<T> | null;
  phase: BargeResumePhase;
}

export interface ResumeResult<T = unknown> {
  /** True when playback should continue with returned segments. */
  resumed: boolean;
  /** Pending segments to re-enqueue, in original order, from next pending. */
  segments: BargeSegment<T>[];
  phase: BargeResumePhase;
}

export interface BargeResumeBuffer<T = unknown> {
  /** Current turn id (null when idle). */
  readonly turnId: string | null;
  readonly phase: BargeResumePhase;
  /** Snapshot of tracked segments (copy). */
  getSegments(): BargeSegment<T>[];
  /** Pending segments that have not started yet. */
  getPendingSegments(): BargeSegment<T>[];
  /** True if there is at least one pending segment to resume. */
  hasPending(): boolean;
  /** True if all tracked segments have started (nothing left to resume). */
  isFullySpoken(): boolean;
  /**
   * Start/reset tracking for a turn. Drops any previous turn state.
   * Call when a new agent speech turn begins.
   */
  beginTurn(turnId: string): void;
  /**
   * Append a segment to the current turn as pending.
   * No-op if there is no active turn or buffer is cancelled for a mismatched flow;
   * callers should beginTurn first.
   */
  enqueue(segment: { id: string; payload: T; tag?: unknown }): BargeSegment<T> | null;
  /**
   * Mark a segment as started/scheduled. Accepts segment id or tag (matched by
   * strict equality against id, then tag). Idempotent; returns matched segment.
   */
  markStarted(idOrTag: unknown): BargeSegment<T> | null;
  /**
   * Pause due to interruption. Retains pending remainder. A started segment at
   * interruption time is treated as cut and is not returned for resume.
   * Safe to call when idle or with nothing pending.
   */
  interrupt(): InterruptResult<T>;
  /**
   * Resume after a false barge-in. Returns pending segments from next pending
   * position, moves phase to playing, and keeps them tracked as pending until
   * markStarted is called again by the re-enqueue path.
   * Returns empty/not resumed when not interrupted or nothing pending.
   */
  resume(): ResumeResult<T>;
  /**
   * Cancel/drop retained playback (real interruption/new turn). Clears segments.
   */
  cancel(): void;
  /** Full reset to idle with no turn/segments. */
  reset(): void;
  /** Immutable snapshot for diagnostics/tests. */
  snapshot(): BargeResumeSnapshot<T>;
}

function cloneSegment<T>(seg: BargeSegment<T>): BargeSegment<T> {
  return { id: seg.id, payload: seg.payload, tag: seg.tag, status: seg.status };
}

function tagsEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

export function createBargeResumeBuffer<T = unknown>(): BargeResumeBuffer<T> {
  let turnId: string | null = null;
  let phase: BargeResumePhase = 'idle';
  let segments: BargeSegment<T>[] = [];

  function findIndex(idOrTag: unknown): number {
    if (idOrTag === undefined || idOrTag === null) return -1;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (tagsEqual(seg.id, idOrTag)) return i;
      if (seg.tag !== undefined && tagsEqual(seg.tag, idOrTag)) return i;
    }
    return -1;
  }

  function pendingFromNext(): BargeSegment<T>[] {
    // Resume means continue from next pending segment. Started segments are cut.
    const out: BargeSegment<T>[] = [];
    for (const seg of segments) {
      if (seg.status === 'pending') out.push(cloneSegment(seg));
    }
    return out;
  }

  function hasPendingInternal(): boolean {
    return segments.some((s) => s.status === 'pending');
  }

  function lastStarted(): BargeSegment<T> | null {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].status === 'started') return cloneSegment(segments[i]);
    }
    return null;
  }

  return {
    get turnId() {
      return turnId;
    },
    get phase() {
      return phase;
    },
    getSegments() {
      return segments.map(cloneSegment);
    },
    getPendingSegments() {
      return segments.filter((s) => s.status === 'pending').map(cloneSegment);
    },
    hasPending() {
      return hasPendingInternal();
    },
    isFullySpoken() {
      return segments.length > 0 && segments.every((s) => s.status === 'started');
    },
    beginTurn(nextTurnId: string) {
      turnId = nextTurnId;
      phase = 'playing';
      segments = [];
    },
    enqueue(segment) {
      if (!turnId) return null;
      if (phase === 'cancelled') {
        // Turn was explicitly cancelled; require beginTurn for a fresh turn.
        // Allow enqueue only when a caller intentionally moved to playing/interrupted? no.
        // Defensive: ignore stale enqueues after cancel until new turn.
        return null;
      }
      const rec: BargeSegment<T> = {
        id: segment.id,
        payload: segment.payload,
        tag: segment.tag,
        status: 'pending'
      };
      segments.push(rec);
      // If we were interrupted but more segments arrive for same turn (unlikely),
      // keep interrupted state; otherwise ensure playing.
      if (phase === 'idle') phase = 'playing';
      return cloneSegment(rec);
    },
    markStarted(idOrTag) {
      const idx = findIndex(idOrTag);
      if (idx < 0) return null;
      const seg = segments[idx];
      seg.status = 'started';
      if (phase === 'idle' && turnId) phase = 'playing';
      return cloneSegment(seg);
    },
    interrupt() {
      if (phase === 'cancelled' || turnId === null) {
        return {
          canResume: false,
          pending: [],
          interruptedSegment: null,
          phase
        };
      }
      if (phase !== 'idle') {
        phase = 'interrupted';
      } else if (hasPendingInternal()) {
        phase = 'interrupted';
      }
      const pending = pendingFromNext();
      return {
        canResume: pending.length > 0,
        pending,
        interruptedSegment: lastStarted(),
        phase
      };
    },
    resume() {
      if (phase !== 'interrupted') {
        return { resumed: false, segments: [], phase };
      }
      const pending = pendingFromNext();
      if (pending.length === 0) {
        // Nothing left to resume (fully spoken/cut last segment).
        return { resumed: false, segments: [], phase };
      }
      phase = 'playing';
      // Keep segment records as-is (pending remain pending). Callers re-enqueue
      // returned payloads and should markStarted on new onChunkStart events.
      return { resumed: true, segments: pending, phase };
    },
    cancel() {
      if (turnId === null && segments.length === 0 && phase === 'idle') return;
      segments = [];
      // Mark cancelled to reject stale enqueues for this turn object lifetime
      // until beginTurn/reset. If never began, stay idle.
      phase = turnId ? 'cancelled' : 'idle';
    },
    reset() {
      turnId = null;
      phase = 'idle';
      segments = [];
    },
    snapshot() {
      return {
        turnId,
        phase,
        segments: segments.map(cloneSegment)
      };
    }
  };
}

/**
 * Decide whether an interrupted turn should resume or be dropped.
 * `isFalseBargeIn` should come from turn-taking/barge classification (T2/integration).
 */
export function decideResumeAction(
  isFalseBargeIn: boolean,
  hasPending: boolean
): 'resume' | 'drop' {
  return isFalseBargeIn && hasPending ? 'resume' : 'drop';
}

/**
 * Utility: collect replay payloads in order from resume result.
 */
export function replayPayloads<T>(segments: ReadonlyArray<BargeSegment<T>>): T[] {
  return segments.map((s) => s.payload);
}
