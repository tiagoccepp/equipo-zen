// QW-09: non-verbal "working" sound. If the agent starts working
// (turn/tools) and there is no audio for ~1s, a soft earcon plays so it's
// noticeable that something is happening. It cancels when voice plays; cooldown between earcons.

export const WORKING_EARCON_DELAY_MS = 1000;
export const WORKING_EARCON_COOLDOWN_MS = 8000;

export type TimerSchedule = (fn: () => void, ms: number) => unknown;
export type TimerCancel = (handle: unknown) => void;

export class WorkingEarcon {
  private pending = new Map<string, unknown>();
  private lastPlayedAt = new Map<string, number>();
  private schedule: TimerSchedule;
  private cancelTimer: TimerCancel;
  private play: (agentId: string) => void;
  private now: () => number;

  constructor(
    schedule: TimerSchedule,
    cancelTimer: TimerCancel,
    play: (agentId: string) => void,
    now: () => number = () => Date.now()
  ) {
    this.schedule = schedule;
    this.cancelTimer = cancelTimer;
    this.play = play;
    this.now = now;
  }

  /** Arms the earcon for the agent (if there isn't one pending). */
  arm(agentId: string, delayMs = WORKING_EARCON_DELAY_MS): void {
    if (!agentId || this.pending.has(agentId)) {
      return;
    }
    const handle = this.schedule(() => {
      this.pending.delete(agentId);
      const last = this.lastPlayedAt.get(agentId) || 0;
      if (this.now() - last < WORKING_EARCON_COOLDOWN_MS) {
        return;
      }
      this.lastPlayedAt.set(agentId, this.now());
      try {
        this.play(agentId);
      } catch {
        // The earcon must never break the turn.
      }
    }, delayMs);
    this.pending.set(agentId, handle);
  }

  /** Cancels the pending earcon (audio arrived / finished / interrupted). */
  cancel(agentId?: string): void {
    if (agentId) {
      const handle = this.pending.get(agentId);
      if (handle !== undefined) {
        this.cancelTimer(handle);
        this.pending.delete(agentId);
      }
      return;
    }
    for (const handle of this.pending.values()) {
      this.cancelTimer(handle);
    }
    this.pending.clear();
  }

  get armedCount(): number {
    return this.pending.size;
  }
}
