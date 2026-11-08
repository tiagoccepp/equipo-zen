/**
 * A floating panel that shows ONE Claude session as a terminal: the live stream
 * (assistant narration, the tools it runs, and command output) scrolling by, plus
 * a text input so the session can be driven by keyboard as a co-equal to voice.
 *
 * Modeled on DiffPanel (single body + titlebar + drag/resize). All rendered text
 * uses `textContent`, never innerHTML, so streamed model/tool text cannot inject
 * markup. The panel is dumb: it renders what it is handed and reports input via
 * callbacks; the adapter owns the session and the submit path.
 */
import { attachDragResize } from '../terminal/dragResize';

export interface SessionPanelOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  title?: string;
  /** Typed/pasted input submitted (Enter; Shift+Enter inserts a newline). */
  onSubmit: (text: string) => void;
  /** Optional attach action (file picker); the button is hidden when absent. */
  onAttach?: () => void;
  onFocus: () => void;
  onClose: () => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
/** Cap retained stream lines so a long session cannot grow the DOM unbounded. */
const MAX_LINES = 500;

export class SessionPanel {
  readonly el: HTMLElement;
  private readonly streamBody: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly cleanup: (() => void) | null = null;

  constructor(opts: SessionPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'session-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 560}px`;
    this.el.style.height = `${opts.height ?? 420}px`;

    this.el.innerHTML = `
      <div class="session-titlebar">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <span class="session-title"></span>
        <button class="session-close" aria-label="Close session view">×</button>
      </div>
      <div class="session-stream"></div>
      <form class="session-inputbar">
        <button type="button" class="session-attach" title="Attach a file by path" aria-label="Attach a file">+</button>
        <textarea class="session-input" rows="1" autocomplete="off" spellcheck="false"
                  placeholder="Escribile a Sofia  (Enter envía, Shift+Enter salta línea)"
                  aria-label="Mensaje para Sofia"></textarea>
      </form>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    this.streamBody = this.el.querySelector('.session-stream')!;
    this.input = this.el.querySelector('.session-input')!;
    this.el.querySelector('.session-title')!.textContent = opts.title ?? 'Session';

    this.el.addEventListener('pointerdown', () => opts.onFocus());
    this.el.querySelector('.session-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose();
    });

    const submit = (): void => {
      const text = this.input.value.trim();
      if (!text) return;
      opts.onSubmit(text);
      this.input.value = '';
      this.input.style.height = 'auto'; // collapse the grown textarea back to one row
    };
    const form = this.el.querySelector<HTMLFormElement>('.session-inputbar')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    // Enter sends; Shift+Enter inserts a newline so long, multi-line prompts can be composed.
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    // Auto-grow the textarea (up to a cap) as the prompt gets longer.
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
    });
    const attachBtn = this.el.querySelector<HTMLButtonElement>('.session-attach')!;
    if (opts.onAttach) {
      attachBtn.addEventListener('click', (e) => {
        e.preventDefault();
        opts.onAttach?.();
      });
    } else {
      attachBtn.style.display = 'none';
    }

    const titlebar = this.el.querySelector<HTMLElement>('.session-titlebar')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: titlebar,
      onMoveStart: () => opts.onFocus(),
    });
  }

  /** Append a stream line. `kind` is narration | action | output | user (styled in CSS). */
  addLine(kind: string, text: string): void {
    const body = this.streamBody;
    // Keep following the tail only if the user was already near the bottom, so
    // scrolling up to read does not get yanked back down by new output.
    const nearBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const line = document.createElement('div');
    line.className = `s-line s-${kind}`;
    line.textContent = text;
    body.appendChild(line);
    while (body.childElementCount > MAX_LINES && body.firstElementChild) {
      body.firstElementChild.remove();
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  /** Append text to the compose box (used by attach to insert a file reference). */
  appendToInput(text: string): void {
    this.input.value = this.input.value ? `${this.input.value} ${text}` : text;
    this.input.dispatchEvent(new Event('input')); // re-grow to fit
    this.input.focus();
  }

  destroy(): void {
    this.cleanup?.();
    this.el.remove();
  }
}
