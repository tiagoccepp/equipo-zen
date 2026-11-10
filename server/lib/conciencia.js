// Team awareness: what everyone is doing RIGHT NOW.
//
// The file map (fileOwnersForGoal) already says who owns what,
// but it's the snapshot of the split, not of the present: the working agent didn't know
// whether the file it needs is being written by a teammate RIGHT NOW, whether it
// was already delivered or whether nobody picked it up. Without that it duplicated
// work — it really happened: two different game screens and neither mounted in the app.
//
// What this block adds on top of the map are the THREE answers the
// map can't give: go in, wait, or edit what's already there.
//
// HARD character cap, and it's not cosmetic: it's the project's measured rule.
// With 15,000 chars of context against 2,000 of protocol the model stops
// emitting actions and answers in prose. This awareness earns its place only if
// it's short, so the least urgent (the queue) is trimmed first and last what
// avoids collisions (who is writing now).

export const TOPE_CONCIENCIA = 900;

// Entries per list. Four is enough to know whether to wait; the fifth
// is already noise eating the protocol's space. What falls off is counted with "+N",
// which reports the scale in 3 characters.
const MAX_ENTRADAS = 4;
const LARGO_LINEA = 150;
const LARGO_ETIQUETA = 44;

// Real work only. 'decision' and 'seguimiento' kinds stay in 'noted'
// state: nobody works them, so in the team's present they don't exist.
const KINDS_DE_TRABAJO = new Set(['entregable', 'revision', 'refinamiento']);

function recortar(texto, largo) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  return limpio.length > largo ? `${limpio.slice(0, largo - 1)}…` : limpio;
}

// A long path is cut on the LEFT, not on the right. Cut at the end it
// becomes "app/src/main/java/com/equipo/app/ui/Pantall…", 44 characters
// that don't tell one screen from another — exactly what this block exists to
// avoid. The file name is the only irreplaceable part; the folder is inferred.
function recortarRuta(ruta, largo) {
  const limpio = String(ruta || '').trim();
  if (limpio.length <= largo) {
    return limpio;
  }
  const partes = limpio.split('/');
  let cola = partes.pop();
  while (partes.length > 0 && `…/${partes[partes.length - 1]}/${cola}`.length <= largo) {
    cola = `${partes.pop()}/${cola}`;
  }
  // A single file name longer than the cap: then it is cut brutally,
  // but keeping the end (the extension says what it's about).
  return `…/${cola}`.length <= largo ? `…/${cola}` : `…${cola.slice(-(largo - 1))}`;
}

// What a task is named with. The FILE first always: it's the lock unit
// and the only thing the reader needs to know whether it collides. A
// task without a file (a review, e.g.) falls back to its text, very short.
function etiquetaDe(tarea) {
  if (tarea.target_file) {
    return recortarRuta(tarea.target_file, LARGO_ETIQUETA);
  }
  if (tarea.kind === 'revision') {
    return 'revisión';
  }
  return recortar(tarea.text, 28);
}

// The project's live state, already seen through the reader's eyes:
// their own stuff says "vos" and what touches THEIR file goes first.
export function estadoVivo(store, goalId, { agentId = null, taskId = null, miArchivo = null } = {}) {
  const vacio = { ahora: [], listos: [], cola: [] };
  if (!store || !goalId) {
    return vacio;
  }
  const tareas = (store.tasksForGoal(goalId) || []).filter((t) => KINDS_DE_TRABAJO.has(t.kind));
  if (tareas.length === 0) {
    return vacio;
  }

  const nombreDe = (id) => {
    if (id && agentId && id === agentId) {
      return 'vos';
    }
    return store.getAgent?.(id)?.name || 'un compañero';
  };

  // The live wave: the lowest phase with unclosed work. A task from a later wave
  // isn't waiting on anyone in particular, it's waiting its turn.
  const faseViva = tareas
    .filter((t) => (t.status === 'pending' || t.status === 'in_progress') && Number.isFinite(t.phase))
    .reduce((min, t) => (min === null || t.phase < min ? t.phase : min), null);

  const enCurso = tareas.filter((t) => t.status === 'in_progress' && t.id !== taskId);
  // Who holds each file RIGHT NOW: it's what turns "it's in the queue"
  // into "it's waiting on Renata".
  const duenoAhora = new Map();
  for (const t of enCurso) {
    if (t.target_file && !duenoAhora.has(t.target_file)) {
      duenoAhora.set(t.target_file, nombreDe(t.agent_id));
    }
  }

  const tocaMiArchivo = (t) => Boolean(miArchivo && t.target_file === miArchivo);
  // What steps on MY file goes first: it's the only entry that can change what
  // I do in this step.
  const ordenar = (lista) => [...lista].sort((a, b) => Number(tocaMiArchivo(b.tarea)) - Number(tocaMiArchivo(a.tarea)));

  const ahora = ordenar(
    enCurso
      // Oneself is not "the team": seeing yourself in the who's-working-now list
      // is noise, and worse, it reads as if someone else is touching your file.
      .filter((t) => !(agentId && t.agent_id === agentId))
      .map((t) => ({ tarea: t, texto: `${nombreDe(t.agent_id)}→${etiquetaDe(t)}` }))
  );

  const listos = ordenar(
    tareas
      .filter((t) => t.status === 'done' && t.id !== taskId)
      .map((t) => ({ tarea: t, texto: `${etiquetaDe(t)} (${nombreDe(t.agent_id)})` }))
  );

  const cola = ordenar(
    tareas
      .filter((t) => t.status === 'pending' && t.id !== taskId)
      .map((t) => {
        // What it depends on, ordered by usefulness to the reader: the author
        // of the deliverable its review waits on, whoever holds the file
        // now, or the wave that hasn't opened yet.
        const padre = t.parent_task_id && store.getTask ? store.getTask(t.parent_task_id) : null;
        const espera = padre
          ? `tras ${nombreDe(padre.agent_id)}`
          : duenoAhora.get(t.target_file)
            || (faseViva !== null && t.phase > faseViva ? `ola ${t.phase}` : '');
        const quien = nombreDe(t.agent_id);
        return { tarea: t, texto: `${etiquetaDe(t)} (${espera ? `${quien}, ${espera}` : quien})` };
      })
  );

  return { ahora, listos, cola };
}

// The block for the work prompt. Returns '' when there's nothing to
// tell: a lone agent on its project shouldn't read an empty sign that
// steals the protocol's space.
export function renderConciencia(store, {
  goalId = null,
  agentId = null,
  taskId = null,
  miArchivo = null,
  tope = TOPE_CONCIENCIA
} = {}) {
  const { ahora, listos, cola } = estadoVivo(store, goalId, { agentId, taskId, miArchivo });
  if (ahora.length === 0 && listos.length === 0 && cola.length === 0) {
    return '';
  }

  // The WHOLE entry falls off, never half: a line cut in the middle leaves a
  // lying file name ("src/pantallas/Pantalla…") that the agent might
  // try to open. And what didn't fit is counted with "+N", which in 3 characters
  // says there's more team than meets the eye.
  const linea = (rotulo, lista, cuantas) => {
    if (cuantas <= 0 || lista.length === 0) {
      return '';
    }
    const armarLinea = (entradas) => {
      const sobran = lista.length - entradas.length;
      return `${rotulo}: ${entradas.join(' · ')}${sobran > 0 ? ` · +${sobran}` : ''}`;
    };
    const usadas = [];
    for (const entrada of lista.slice(0, cuantas)) {
      const texto = recortar(entrada.texto, LARGO_ETIQUETA + 24);
      if (usadas.length > 0 && armarLinea([...usadas, texto]).length > LARGO_LINEA) {
        break;
      }
      usadas.push(texto);
    }
    return armarLinea(usadas);
  };

  let nAhora = Math.min(ahora.length, MAX_ENTRADAS);
  let nListos = Math.min(listos.length, MAX_ENTRADAS);
  let nCola = Math.min(cola.length, MAX_ENTRADAS);

  // The rules are the point of the block: without them the agent knows the state
  // and still doesn't know what to do with it. Each one goes in only if there's
  // something to apply it to; the last one always goes, because it unblocks.
  const armar = () => [
    '━━ TU EQUIPO, AHORA MISMO ━━',
    linea('AHORA', ahora, nAhora),
    linea('LISTO', listos, nListos),
    linea('EN COLA', cola, nCola),
    nAhora > 0 && ahora.length
      ? 'Un archivo que otro está escribiendo AHORA no se toca: preguntale con consultar y seguí con lo tuyo.'
      : '',
    nListos > 0 && listos.length
      ? 'Lo que ya está LISTO se edita con edit_file: no lo rehagas ni hagas tu versión al lado.'
      : '',
    'Lo que no figura acá arriba no lo tiene nadie: es tuyo, hacelo.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].filter(Boolean).join('\n');

  let bloque = armar();
  while (bloque.length > tope) {
    if (nCola > 0) {
      nCola -= 1;
    } else if (nListos > 0) {
      nListos -= 1;
    } else if (nAhora > 1) {
      nAhora -= 1;
    } else {
      break;
    }
    bloque = armar();
  }
  // Safety net: the cap is HARD. With the lists already empty the block is
  // the rules, which measure under 300 characters.
  return bloque.length > tope ? `${bloque.slice(0, tope - 1)}…` : bloque;
}
