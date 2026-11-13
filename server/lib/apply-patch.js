// QW-11: apply_patch — edición atómica multi-archivo para manos.
// Formato (pensado para que el modelo lo emita sin errores):
//   *** Begin Patch
//   *** Update File: ruta/relativa
//   @@ (opcional, se ignora)
//    línea de contexto (empieza con espacio)
//   -línea a quitar
//   +línea a agregar
//   *** Add File: ruta/nueva
//   +líneas...
//   *** Delete File: ruta/vieja
//   *** End Patch
// Atómico: se verifican TODOS los archivos antes de escribir UNO; si algo
// falla (contexto que no matchea, ambiguo, error de escritura), no se toca
// nada (rollback de lo ya escrito en el mismo patch).

export const APPLY_PATCH_MAX_FILES = 10;
export const APPLY_PATCH_MAX_CHARS = 100 * 1024;
export const APPLY_PATCH_MAX_FILE_BYTES = 1024 * 1024;

export function parseApplyPatch(patchText) {
  const text = String(patchText || '');
  if (text.length > APPLY_PATCH_MAX_CHARS) {
    return { ok: false, error: `patch demasiado largo (máx ${APPLY_PATCH_MAX_CHARS} chars)` };
  }
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  const end = lines.findIndex((l) => l.trim() === '*** End Patch');
  if (begin === -1 || end === -1 || end <= begin) {
    return { ok: false, error: 'formato: falta *** Begin Patch / *** End Patch' };
  }
  const files = [];
  let current = null;
  const push = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };
  for (const raw of lines.slice(begin + 1, end)) {
    const line = raw.replace(/\r$/, '');
    const update = line.match(/^\*\*\* Update File:\s*(.+?)\s*$/);
    const add = line.match(/^\*\*\* Add File:\s*(.+?)\s*$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+?)\s*$/);
    if (update || add || del) {
      push();
      current = {
        op: update ? 'update' : add ? 'add' : 'delete',
        path: (update?.[1] || add?.[1] || del?.[1] || '').trim(),
        hunks: [],
        groups: [[]]
      };
      continue;
    }
    if (!current) {
      if (line.trim() === '' || line.startsWith('@@')) continue;
      return { ok: false, error: `línea fuera de archivo: ${line.slice(0, 80)}` };
    }
    // @@ separa grupos (hunks independientes, se aplican en orden).
    if (line.startsWith('@@')) {
      if (current.groups[current.groups.length - 1].length > 0) {
        current.groups.push([]);
      }
      continue;
    }
    const emit = (entry) => {
      current.hunks.push(entry);
      current.groups[current.groups.length - 1].push(entry);
    };
    if (line === '' && current.op === 'update') {
      // Línea vacía = contexto vacío (el modelo suele emitirla sin el espacio).
      emit({ type: 'context', text: '' });
      continue;
    }
    const marker = line[0];
    if (marker === ' ' || marker === '\t') {
      emit({ type: 'context', text: line.slice(1) });
    } else if (marker === '-') {
      emit({ type: 'remove', text: line.slice(1) });
    } else if (marker === '+') {
      emit({ type: 'add', text: line.slice(1) });
    } else {
      return { ok: false, error: `línea inválida en ${current.path}: debe empezar con espacio/-/+: ${line.slice(0, 80)}` };
    }
  }
  push();
  if (files.length === 0) {
    return { ok: false, error: 'el patch no trae ningún archivo' };
  }
  if (files.length > APPLY_PATCH_MAX_FILES) {
    return { ok: false, error: `demasiados archivos (máx ${APPLY_PATCH_MAX_FILES})` };
  }
  for (const f of files) {
    if (!f.path) {
      return { ok: false, error: 'archivo sin ruta' };
    }
    if (f.op !== 'delete' && f.hunks.length === 0) {
      return { ok: false, error: `${f.path}: sin cambios` };
    }
  }
  return { ok: true, files };
}

// Aplica UN grupo a las líneas del archivo. Busca el bloque
// (contexto+remove) exacto; 0 o 2+ matches = error (seguro, no adivina).
export function applyHunks(fileLines, hunks) {
  // Bloque a buscar: context + remove en orden.
  const needle = [];
  for (const h of hunks) {
    if (h.type === 'context' || h.type === 'remove') {
      needle.push(h.text);
    }
  }
  if (needle.length === 0) {
    return { ok: false, error: 'hunk sin contexto ni líneas a quitar (agregado puro: usar Add File o dar contexto)' };
  }
  const matches = [];
  for (let i = 0; i + needle.length <= fileLines.length; i += 1) {
    let same = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (fileLines[i + j] !== needle[j]) {
        same = false;
        break;
      }
    }
    if (same) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    return { ok: false, error: `contexto no encontrado:\n${needle.slice(0, 6).join('\n')}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `contexto ambiguo (${matches.length} matches): agregá más líneas de contexto` };
  }
  // Reconstrucción: contexto se copia, remove se salta, add se inserta.
  const at = matches[0];
  const before = fileLines.slice(0, at);
  const after = fileLines.slice(at + needle.length);
  const middle = [];
  for (const h of hunks) {
    if (h.type === 'context' || h.type === 'add') {
      middle.push(h.text);
    }
  }
  return { ok: true, lines: [...before, ...middle, ...after] };
}

// Aplica los grupos en orden (cada uno sobre el resultado del anterior).
export function applyGroups(fileLines, groups) {
  let lines = fileLines;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].length === 0) continue;
    const r = applyHunks(lines, groups[i]);
    if (!r.ok) {
      return { ok: false, error: `hunk ${i + 1}: ${r.error}` };
    }
    lines = r.lines;
  }
  return { ok: true, lines };
}
