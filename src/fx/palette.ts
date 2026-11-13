// ═══════════════════════════════════════════════════════════════════════
// fx/palette.ts — Ctrl+K command bar. No dependencies; base styles in
// motion.css (.fx-palette*), console aesthetics in app.css (overrides).
// Actions with group + visible shortcut, honest empty state, help footer,
// setActions() for dynamic lists (recent jobs, etc).
//
//   const pal = mountPalette({
//     actions: [
//       { id: 'go-console', label: 'Go to Console', group: 'Views', kbd: '1' },
//       { id: 'mic', label: 'Mic on/off', group: 'Voice', hint: 'voice session' },
//     ],
//     onAction: (id) => { … }
//   });
//   pal.setActions([...]); // refreshes the list (e.g. recent jobs)
//   // … pal.dispose()
// ═══════════════════════════════════════════════════════════════════════

export type PaletteAction = {
  id: string;
  label: string;
  /** Header group (Views, Voice, Jobs…). No group = no header. */
  group?: string;
  /** Secondary text on the right (short description). */
  hint?: string;
  /** Visible kbd-style shortcut (e.g. '1', '⌘K'). */
  kbd?: string;
  /** Destructive/caution action: warm accent tint. */
  danger?: boolean;
};

export type PaletteOptions = {
  actions: PaletteAction[];
  onAction: (id: string) => void;
  // Open shortcut. Default 'k' → Ctrl+K (⌘+K on mac).
  shortcutKey?: string;
  // Input placeholder. Default 'Type a command…'.
  placeholder?: string;
  // Empty-state text. Default 'No matching commands'.
  emptyText?: string;
};

export type PaletteHandle = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Replaces the list (open or closed). */
  setActions: (actions: PaletteAction[]) => void;
  dispose: () => void;
};

export function mountPalette(options: PaletteOptions): PaletteHandle {
  const key = (options.shortcutKey ?? 'k').toLowerCase();
  const placeholder = options.placeholder ?? 'Type a command…';
  const emptyText = options.emptyText ?? 'No matching commands';
  let actions: PaletteAction[] = [...options.actions];
  let backdrop: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;
  let list: HTMLUListElement | null = null;
  let selected = 0;
  let filtered: PaletteAction[] = [...actions];
  let lastFocus: HTMLElement | null = null;

  function render() {
    if (!list || !input) return;
    list.innerHTML = '';
    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fx-empty';
      empty.setAttribute('aria-disabled', 'true');
      empty.textContent = emptyText;
      list.appendChild(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = '';
    filtered.forEach((action, index) => {
      const group = action.group || '';
      if (group && group !== lastGroup) {
        lastGroup = group;
        const head = document.createElement('li');
        head.className = 'fx-group';
        head.setAttribute('aria-hidden', 'true');
        head.textContent = group;
        list!.appendChild(head);
      }
      const li = document.createElement('li');
      li.id = `fx-pal-${index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      if (action.danger) li.classList.add('fx-danger');
      const label = document.createElement('span');
      label.className = 'fx-label';
      label.textContent = action.label;
      li.appendChild(label);
      if (action.hint) {
        const hint = document.createElement('span');
        hint.className = 'fx-hint';
        hint.textContent = action.hint;
        li.appendChild(hint);
      }
      if (action.kbd) {
        const kbd = document.createElement('kbd');
        kbd.className = 'fx-kbd';
        kbd.textContent = action.kbd;
        li.appendChild(kbd);
      } else if (action.hint) {
        // Compat: legacy hint with kbd class stays right-aligned.
        (li.lastChild as HTMLElement).classList.add('fx-kbd');
      }
      li.addEventListener('click', () => {
        options.onAction(action.id);
        close();
      });
      li.addEventListener('mousemove', () => {
        if (selected !== index) {
          selected = index;
          syncSelected();
        }
      });
      list!.appendChild(li);
    });
    syncSelected();
  }

  function syncSelected() {
    if (!list || !input) return;
    const items = list.querySelectorAll('[role="option"]');
    items.forEach((el, i) => {
      el.setAttribute('aria-selected', i === selected ? 'true' : 'false');
    });
    const active = items[selected] as HTMLElement | undefined;
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function applyFilter() {
    const q = (input?.value || '').trim().toLowerCase();
    filtered = q
      ? actions.filter(
          (a) =>
            a.label.toLowerCase().includes(q) ||
            a.id.includes(q) ||
            (a.group || '').toLowerCase().includes(q) ||
            (a.hint || '').toLowerCase().includes(q)
        )
      : [...actions];
    selected = 0;
    render();
  }

  function open() {
    if (panel) return;
    lastFocus = document.activeElement as HTMLElement | null;
    selected = 0;
    filtered = [...actions];
    backdrop = document.createElement('div');
    backdrop.className = 'fx-palette-backdrop';
    backdrop.addEventListener('click', close);
    panel = document.createElement('div');
    panel.className = 'fx-palette';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Command bar');
    input = document.createElement('input');
    input.placeholder = placeholder;
    input.setAttribute('aria-label', 'Filter commands');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'fx-pal-list');
    input.setAttribute('role', 'combobox');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.addEventListener('input', applyFilter);
    list = document.createElement('ul');
    list.id = 'fx-pal-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Commands');
    const foot = document.createElement('div');
    foot.className = 'fx-foot';
    foot.setAttribute('aria-hidden', 'true');
    foot.textContent = '↑↓ navigate · Enter open · Esc close';
    panel.appendChild(input);
    panel.appendChild(list);
    panel.appendChild(foot);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    render();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        backdrop?.classList.add('fx-in');
        panel?.classList.add('fx-in');
      })
    );
    input.focus();
  }

  function close() {
    backdrop?.remove();
    panel?.remove();
    backdrop = null;
    panel = null;
    input = null;
    list = null;
    // Returns focus to where it was (full keyboard, no traps).
    if (lastFocus && document.contains(lastFocus)) {
      lastFocus.focus({ preventScroll: true });
      lastFocus = null;
    }
  }

  function move(delta: number) {
    if (filtered.length === 0) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    syncSelected();
  }

  function onKeyDown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === key) {
      event.preventDefault();
      if (panel) close();
      else open();
      return;
    }
    if (!panel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Tab') {
      // Tab cycles the selection instead of leaking focus out of the dialog.
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' && filtered[selected]) {
      event.preventDefault();
      options.onAction(filtered[selected].id);
      close();
    }
  }

  document.addEventListener('keydown', onKeyDown);
  return {
    open,
    close,
    toggle: () => (panel ? close() : open()),
    setActions: (next: PaletteAction[]) => {
      actions = [...next];
      if (panel) applyFilter();
    },
    dispose: () => {
      document.removeEventListener('keydown', onKeyDown);
      close();
    }
  };
}
