// QW-09: sonido "trabajando" no verbal. Si el agente arranca a trabajar
// (turno/tools) y en ~1s no hubo audio, suena un earcon suave para que se
// note que algo pasa. Se cancela al sonar la voz; cooldown entre earcons.

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

  /** Arma el earcon para el agente (si no hay uno pendiente). */
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
        // El earcon jamás rompe el turno.
      }
    }, delayMs);
    this.pending.set(agentId, handle);
  }

  /** Cancela el pendiente (llegó audio / terminó / se interrumpió). */
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
