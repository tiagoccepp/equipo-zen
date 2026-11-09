// ═══════════════════════════════════════════════════════════════════════
// fx/palette.ts — command palette Ctrl+K. Sin dependencias, estilos en
// motion.css (.fx-palette*). El main pasa las acciones y recibe el id.
//
//   const pal = mountPalette({
//     actions: [
//       { id: 'mute', label: 'Mutear micrófono', hint: 'M' },
//       { id: 'sala', label: 'Cambiar de sala…', hint: 'S' },
//       { id: 'mission', label: 'Abrir mission control', hint: 'C' },
//       { id: 'audio', label: 'Test de audio', hint: 'T' }
//     ],
//     onAction: (id) => { … }
//   });
//   // … pal.dispose()
// ═══════════════════════════════════════════════════════════════════════

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
};

export type PaletteOptions = {
  actions: PaletteAction[];
  onAction: (id: string) => void;
  // Atajo de apertura. Default 'k' → Ctrl+K (⌘+K en mac).
  shortcutKey?: string;
};

export type PaletteHandle = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  dispose: () => void;
};

export function mountPalette(options: PaletteOptions): PaletteHandle {
  const key = (options.shortcutKey ?? 'k').toLowerCase();
  let backdrop: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;
  let list: HTMLUListElement | null = null;
  let selected = 0;
  let filtered: PaletteAction[] = [...options.actions];

  function render() {
    if (!list) return;
    list.innerHTML = '';
    filtered.forEach((action, index) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      li.textContent = action.label;
      if (action.hint) {
        const kbd = document.createElement('span');
        kbd.className = 'fx-kbd';
        kbd.textContent = action.hint;
        li.appendChild(kbd);
      }
      li.addEventListener('click', () => {
        options.onAction(action.id);
        close();
      });
      list!.appendChild(li);
    });
  }

  function applyFilter() {
    const q = (input?.value || '').trim().toLowerCase();
    filtered = q
      ? options.actions.filter((a) => a.label.toLowerCase().includes(q) || a.id.includes(q))
      : [...options.actions];
    selected = 0;
    render();
  }

  function open() {
    if (panel) return;
    selected = 0;
    filtered = [...options.actions];
    backdrop = document.createElement('div');
    backdrop.className = 'fx-palette-backdrop';
    backdrop.addEventListener('click', close);
    panel = document.createElement('div');
    panel.className = 'fx-palette';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Comandos');
    input = document.createElement('input');
    input.placeholder = 'Escribí un comando…';
    input.setAttribute('aria-label', 'Filtrar comandos');
    input.addEventListener('input', applyFilter);
    list = document.createElement('ul');
    panel.appendChild(input);
    panel.appendChild(list);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      backdrop?.classList.add('fx-in');
      panel?.classList.add('fx-in');
    }));
    input.focus();
  }

  function close() {
    backdrop?.remove();
    panel?.remove();
    backdrop = null;
    panel = null;
    input = null;
    list = null;
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
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(filtered.length - 1, selected + 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(0, selected - 1);
      render();
    } else if (event.key === 'Enter' && filtered[selected]) {
      options.onAction(filtered[selected].id);
      close();
    }
  }

  document.addEventListener('keydown', onKeyDown);
  return {
    open,
    close,
    toggle: () => (panel ? close() : open()),
    dispose: () => {
      document.removeEventListener('keydown', onKeyDown);
      close();
    }
  };
}
