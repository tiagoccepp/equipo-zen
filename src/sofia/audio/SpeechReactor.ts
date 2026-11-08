/**
 * Speech-output reactivity for the Speaking state.
 *
 * The browser does NOT expose `speechSynthesis` audio to an AnalyserNode, so we
 * cannot read TTS amplitude directly (this is why AVATAR_SPEC's "capture the TTS
 * output stream" is infeasible). Instead we drive the mesh from word-boundary
 * events, with a synthetic time-based envelope as a fallback for voices that do
 * not emit `boundary` events.
 *
 * `attach()` wraps `speechSynthesis.speak` non-destructively: it binds listeners
 * with `addEventListener` (never clobbering host handlers) and always calls the
 * original speak, even if our binding throws, so it can never block speech.
 */

export interface SpeechReactorOptions {
  synthesis?: SpeechSynthesis;
  onSpeakingStart?: () => void;
  onSpeakingEnd?: () => void;
  onBoundary?: () => void;
  /** Synthetic impulse interval (ms) used when no native boundaries arrive. */
  syntheticIntervalMs?: number;
  /**
   * Rewrite each utterance's text before it is spoken. Used to strip the
   * `<<mood:NAME>>` marker so it is never read aloud. Must be pure and fast; any
   * throw is swallowed so it can never block speech.
   */
  transformText?: (text: string) => string;
  /**
   * Optional server-audio TTS path. When provided, each utterance's (already
   * mood-stripped) text is routed here first. If it resolves `true` the native
   * `speechSynthesis` call is skipped entirely (the media player drives the
   * speaking state through its own callbacks). If it resolves `false` or
   * rejects, we fall back to the native engine, so hosts where the browser voice
   * works are unaffected. Used on Windows, where `speechSynthesis` is silent.
   */
  mediaSpeak?: (text: string) => Promise<boolean>;
}

type SpeakFn = (utterance: SpeechSynthesisUtterance) => void;

export class SpeechReactor {
  private readonly synthesis: SpeechSynthesis | undefined;
  private readonly onSpeakingStart?: () => void;
  private readonly onSpeakingEnd?: () => void;
  private readonly onBoundary?: () => void;
  private readonly syntheticIntervalMs: number;
  private readonly transformText?: (text: string) => string;
  private readonly mediaSpeak?: (text: string) => Promise<boolean>;

  private originalSpeak: SpeakFn | null = null;
  private patchedSpeak: SpeakFn | null = null;
  private speaking = false;
  private nativeBoundarySeen = false;
  private syntheticTimer: ReturnType<typeof setInterval> | null = null;
  // Strong references to in-flight utterances. Chrome garbage-collects an
  // utterance with no live reference mid-speak, silently dropping the audio, so
  // we retain each one until it ends. (The host's app.js keeps no reference,
  // which is the common cause of "speech runs but nothing is heard".)
  private readonly alive = new Set<SpeechSynthesisUtterance>();

  constructor(options: SpeechReactorOptions = {}) {
    this.synthesis = options.synthesis ?? globalThis.speechSynthesis;
    this.onSpeakingStart = options.onSpeakingStart;
    this.onSpeakingEnd = options.onSpeakingEnd;
    this.onBoundary = options.onBoundary;
    this.syntheticIntervalMs = options.syntheticIntervalMs ?? 180;
    this.transformText = options.transformText;
    this.mediaSpeak = options.mediaSpeak;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Number of utterances currently held alive (test seam for the anti-GC guard). */
  get aliveCount(): number {
    return this.alive.size;
  }

  attach(): void {
    const synthesis = this.synthesis;
    if (this.originalSpeak || !synthesis) {
      return;
    }
    const original: SpeakFn = synthesis.speak.bind(synthesis);
    this.originalSpeak = original;
    const patched: SpeakFn = (utterance: SpeechSynthesisUtterance): void => {
      try {
        if (this.transformText) {
          const next = this.transformText(utterance.text);
          if (typeof next === 'string' && next !== utterance.text) {
            utterance.text = next;
          }
        }
      } catch {
        // Text rewriting must never block speech.
      }
      // Prefer the server-audio path where available (Windows, where the native
      // engine is silent). If it declines or fails, fall back to the native
      // engine so other hosts are unaffected. mediaSpeak never rejects, but we
      // guard anyway so a bug there can never block speech.
      if (this.mediaSpeak) {
        const text = utterance.text;
        Promise.resolve()
          .then(() => this.mediaSpeak?.(text))
          .then((handled) => {
            if (!handled) {
              this.fallbackSpeak(utterance);
            }
          })
          .catch(() => this.fallbackSpeak(utterance));
        return;
      }
      this.fallbackSpeak(utterance);
    };
    this.patchedSpeak = patched;
    synthesis.speak = patched;
  }

  /**
   * Speak through the native engine: bind reactivity, hold an anti-GC reference,
   * nudge a paused engine, then call the original speak. Never blocks speech.
   */
  private fallbackSpeak(utterance: SpeechSynthesisUtterance): void {
    const original = this.originalSpeak;
    if (!original) {
      return;
    }
    try {
      this.bindUtterance(utterance);
      // Retain a strong reference until the utterance ends so Chrome cannot GC
      // it mid-speak (a silent-failure bug the host code does not guard).
      this.keepAlive(utterance);
    } catch {
      // Binding / keep-alive must never block speech.
    }
    // Nudge a paused or stuck engine before speaking (another Chrome cause of
    // silent speech). Best-effort: never blocks the original speak.
    this.resumeIfPaused();
    original(utterance);
  }

  detach(): void {
    this.stopSynthetic();
    this.alive.clear();
    if (this.speaking) {
      // Emit a clean terminal transition so consumers do not latch on "speaking".
      this.speaking = false;
      this.onSpeakingEnd?.();
    }
    // Only restore if we still own the slot, to avoid clobbering a later patcher.
    if (this.synthesis && this.patchedSpeak && this.originalSpeak && this.synthesis.speak === this.patchedSpeak) {
      this.synthesis.speak = this.originalSpeak;
    }
    this.originalSpeak = null;
    this.patchedSpeak = null;
  }

  private bindUtterance(utterance: SpeechSynthesisUtterance): void {
    utterance.addEventListener('start', () => this.handleStart());
    utterance.addEventListener('boundary', (event) => {
      if (event.name === 'word') {
        this.handleBoundary();
      }
    });
    utterance.addEventListener('end', () => this.handleEnd());
    utterance.addEventListener('error', () => this.handleEnd());
  }

  /** Hold a reference until the utterance terminates, then release it. */
  private keepAlive(utterance: SpeechSynthesisUtterance): void {
    this.alive.add(utterance);
    const release = (): void => {
      this.alive.delete(utterance);
    };
    utterance.addEventListener('end', release);
    utterance.addEventListener('error', release);
  }

  /** Resume a paused engine so a queued utterance can actually start. */
  private resumeIfPaused(): void {
    const synthesis = this.synthesis;
    try {
      if (synthesis && synthesis.paused && typeof synthesis.resume === 'function') {
        synthesis.resume();
      }
    } catch {
      // resume is best-effort and must never block speech.
    }
  }

  private handleStart(): void {
    this.speaking = true;
    this.nativeBoundarySeen = false;
    this.onSpeakingStart?.();
    this.startSynthetic();
  }

  private handleBoundary(): void {
    this.nativeBoundarySeen = true;
    this.onBoundary?.();
  }

  private handleEnd(): void {
    if (!this.speaking) {
      return;
    }
    this.speaking = false;
    this.stopSynthetic();
    this.onSpeakingEnd?.();
  }

  private startSynthetic(): void {
    this.stopSynthetic();
    this.syntheticTimer = setInterval(() => {
      if (this.speaking && !this.nativeBoundarySeen) {
        this.onBoundary?.();
      }
    }, this.syntheticIntervalMs);
  }

  private stopSynthetic(): void {
    if (this.syntheticTimer !== null) {
      clearInterval(this.syntheticTimer);
      this.syntheticTimer = null;
    }
  }
}
