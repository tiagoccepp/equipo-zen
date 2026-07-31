// Conciencia de equipo: qué está haciendo cada uno EN ESTE MOMENTO.
//
// El esquema de archivos (fileOwnersForGoal) ya dice quién es dueño de qué,
// pero es la foto del reparto, no del presente: el agente que trabaja no sabía
// si el archivo que necesita lo está escribiendo un compañero AHORA, si ya
// quedó entregado o si no lo tomó nadie. Sin eso duplicaba trabajo — pasó de
// verdad: dos pantallas de juego distintas y ninguna montada en la app.
//
// Lo que este bloque agrega sobre el esquema son las TRES respuestas que el
// esquema no puede dar: entro, espero, o edito lo que ya está.
//
// TOPE DURO de caracteres, y no es cosmético: es la regla medida del proyecto.
// Con 15.000 caracteres de contexto contra 2.000 de protocolo el modelo deja de
// emitir acciones y contesta en prosa. Esta conciencia se gana el lugar solo si
// es corta, así que primero se recorta lo menos urgente (la cola) y último lo
// que evita el choque (quién escribe ahora).

export const TOPE_CONCIENCIA = 900;

// Entradas por lista. Cuatro alcanza para saber si hay que esperar; la quinta
// ya es ruido que le come lugar al protocolo. Lo que se cae se cuenta con "+N",
// que informa la escala en 3 caracteres.
const MAX_ENTRADAS = 4;
const LARGO_LINEA = 150;
const LARGO_ETIQUETA = 44;

// Solo el trabajo real. Las 'decision' y los 'seguimiento' quedan en estado
// 'noted': nadie los trabaja, así que en el presente del equipo no existen.
const KINDS_DE_TRABAJO = new Set(['entregable', 'revision', 'refinamiento']);

function recortar(texto, largo) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  return limpio.length > largo ? `${limpio.slice(0, largo - 1)}…` : limpio;
}

// Una ruta larga se corta por la IZQUIERDA, no por la derecha. Cortada al final
// queda "app/src/main/java/com/equipo/app/ui/Pantall…", que son 44 caracteres
// que no distinguen una pantalla de otra — justo lo que este bloque existe para
// evitar. El nombre del archivo es lo único irremplazable; la carpeta se deduce.
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
  // Un solo nombre de archivo más largo que el tope: ahí sí se corta a lo bruto,
  // pero conservando el final (la extensión dice de qué se trata).
  return `…/${cola}`.length <= largo ? `…/${cola}` : `…${cola.slice(-(largo - 1))}`;
}

// Con qué se nombra una tarea. El ARCHIVO primero siempre: es la unidad del
// cerrojo y lo único que le sirve al que lee para saber si choca con él. Una
// tarea sin archivo (una revisión, por ejemplo) cae a su texto, bien corto.
function etiquetaDe(tarea) {
  if (tarea.target_file) {
    return recortarRuta(tarea.target_file, LARGO_ETIQUETA);
  }
  if (tarea.kind === 'revision') {
    return 'revisión';
  }
  return recortar(tarea.text, 28);
}

// El estado vivo del proyecto, ya visto desde los ojos de quien va a leerlo:
// sus propias cosas dicen "vos" y lo que toca SU archivo va primero.
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

  // La ola viva: la fase más baja con trabajo sin cerrar. Una tarea de una ola
  // posterior no está esperando a nadie en particular, está esperando el turno.
  const faseViva = tareas
    .filter((t) => (t.status === 'pending' || t.status === 'in_progress') && Number.isFinite(t.phase))
    .reduce((min, t) => (min === null || t.phase < min ? t.phase : min), null);

  const enCurso = tareas.filter((t) => t.status === 'in_progress' && t.id !== taskId);
  // Quién tiene tomado cada archivo AHORA: es lo que convierte "está en la cola"
  // en "está esperando a Renata".
  const duenoAhora = new Map();
  for (const t of enCurso) {
    if (t.target_file && !duenoAhora.has(t.target_file)) {
      duenoAhora.set(t.target_file, nombreDe(t.agent_id));
    }
  }

  const tocaMiArchivo = (t) => Boolean(miArchivo && t.target_file === miArchivo);
  // Lo que pisa MI archivo va primero: es la única entrada que puede cambiar lo
  // que hago en este paso.
  const ordenar = (lista) => [...lista].sort((a, b) => Number(tocaMiArchivo(b.tarea)) - Number(tocaMiArchivo(a.tarea)));

  const ahora = ordenar(
    enCurso
      // Uno mismo no es "el equipo": verse en la lista de quién trabaja ahora
      // es ruido, y peor, se lee como que otro le está tocando el archivo.
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
        // De quién depende, en orden de qué le sirve más al que lee: el autor
        // del entregable que su revisión espera, quien tiene el archivo tomado
        // ahora, o la ola que todavía no abrió.
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

// El bloque para el prompt de trabajo. Devuelve '' cuando no hay nada que
// contar: un agente solo en su proyecto no tiene que leer un cartel vacío que
// le saque lugar al protocolo.
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

  // Se cae la entrada ENTERA, nunca media: una línea cortada al medio deja un
  // nombre de archivo mentiroso ("src/pantallas/Pantalla…") que el agente puede
  // intentar abrir. Y lo que no entró se cuenta con "+N", que en 3 caracteres
  // dice que hay más equipo del que se ve.
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

  // Las reglas son el motivo del bloque: sin ellas el agente sabe el estado y
  // sigue sin saber qué hacer con él. Cada una entra solo si hay algo a lo que
  // aplicarle; la última va siempre, porque es la que lo desbloquea.
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
  // Red de seguridad: el tope es DURO. Con las listas ya vacías el bloque son
  // las reglas, que miden menos de 300 caracteres.
  return bloque.length > tope ? `${bloque.slice(0, tope - 1)}…` : bloque;
}
