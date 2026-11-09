import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { rootDir } from './config.js';
import { renderConciencia } from './conciencia.js';
import { completeChat, parseJsonFromModel, parseJsonObjects } from './llm.js';
import {
  archivoDeTokens,
  normalizeStack,
  renderDesignStandard,
  renderFlujo,
  renderPlaybooks,
  renderRoles
} from './playbooks.js';
import { hasLiveSession, isUserSpeaking } from './priority.js';
import { logEvent } from './session-log.js';
import { clasificarComando, ejecutar, renderHerramientas, renderResultado } from './herramientas.js';
import { renderSkillsSection } from './skills.js';
import { andamiar, renderAndamiaje } from './andamiaje.js';
import { construirApp, renderBuildReport } from './native-build.js';
import {
  abrirDiseno,
  disponible as disenoDisponible,
  esAgenteDeDiseno,
  leerTokensDelDiseno,
  renderDiseno,
  tokensComoCodigo
} from './openpencil.js';
import { renderVerificationReport, verifyProject } from './verify.js';
import { getMinimaxModels, getTtsLanguage } from './settings.js';
import { telemetry } from './telemetry.js';

// Motor de trabajo estilo Paperclip: los empleados NO trabajan en vivo
// durante la reunión — al cerrarse, las tareas de la meta entran a una
// cola y este motor las ejecuta por heartbeats: checkout atómico, pasos
// acotados con herramientas de archivos (sandbox por empresa), log
// durable por corrida y artefactos reales servidos en /workspace.

// TODO lo que la empresa produce vive acá dentro y en ningún otro lado:
// workspace/<empresa>/<proyecto>/… Es el único punto de escritura del
// sistema y está aislado del resto del repo.
export const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(rootDir, 'workspace'));

const TICK_MS = Number(process.env.WORKFORCE_TICK_MS || 5000);
const MAX_CONCURRENT = Number(process.env.WORKFORCE_MAX_CONCURRENT || 4);
// Con alguien en la reunión se baja el paralelismo, no se apaga: antes era 1 y
// el equipo quedaba prácticamente detenido mientras vos hablabas con ellos.
const MAX_CONCURRENT_EN_REUNION = Number(process.env.WORKFORCE_MAX_CONCURRENT_MEETING || 2);
const MAX_STEPS_PER_RUN = Number(process.env.WORKFORCE_MAX_STEPS || 12);
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES_PER_RUN = 12;
const STEP_TIMEOUT_MS = Number(process.env.WORKFORCE_STEP_TIMEOUT_MS || 180000);
// Tope de reintentos por tarea: evita el bucle infinito si el modelo no responde.
const MAX_RUNS_PER_TASK = Number(process.env.WORKFORCE_MAX_RUNS_PER_TASK || 3);
// Consultas a un compañero por corrida. Dos alcanza: más es conversar en vez
// de producir, y cada una cuesta una llamada al modelo.
const MAX_CONSULTAS_POR_CORRIDA = Number(process.env.WORKFORCE_MAX_CONSULTAS || 2);
// Comandos por corrida. Andamiar + instalar + verificar entra cómodo en 6.
const MAX_COMANDOS_POR_CORRIDA = Number(process.env.WORKFORCE_MAX_COMANDOS || 6);

// El formato, repetido al FINAL de cada paso. Es lo último que lee el modelo
// antes de contestar, y eso decide si contesta con una acción o con prosa: con
// el protocolo solo arriba del system y 15.000 caracteres de contexto en el
// medio, se iba a prosa y quemaba la corrida entera. Corto a propósito.
const RECORDATORIO_FORMATO = [
  '━━ RESPONDÉ CON UNA ACCIÓN, NADA MÁS ━━',
  '{"action":"write_file","path":"x.jsx"} + <<<CONTENIDO … CONTENIDO>>>',
  '{"action":"edit_file","path":"x.jsx"} + <<<BUSCAR … BUSCAR>>> <<<REEMPLAZAR … REEMPLAZAR>>>',
  '{"action":"read_file","path":"x.jsx"} · {"action":"comando","cmd":"…","porque":"…"}',
  '{"action":"consultar","a":"Nombre","pregunta":"…"} · {"action":"finish","summary":"…"}',
  'Sin markdown, sin explicaciones, sin saludos. Solo el JSON (y los marcadores si van).'
].join('\n');

// Solo formatos de entregable: nada ejecutable, nada de configuración del host.
// Formatos de entregable, incluidos los de los nichos móviles. Nada
// ejecutable ni de configuración del host: la guardia de rutas de
// safeWorkspacePath() sigue siendo la misma.
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt',
  '.svg', '.csv', '.xml', '.yml', '.yaml', '.ts', '.tsx', '.jsx',
  // Android / React Native: el proyecto nativo ENTERO es el entregable de esos
  // nichos, así que hacen falta también sus archivos de compilación.
  '.kt', '.kts', '.java', '.gradle', '.pro', '.properties',
  // Python: el módulo y su configuración de proyecto (pyproject.toml, setup.cfg,
  // pytest.ini). requirements.txt entra por .txt, que ya estaba.
  '.py', '.toml', '.cfg', '.ini',
  // El archivo de diseño de OpenPencil (JSON versionable) y las capturas que la
  // diseñadora exporta para que el usuario apruebe. Sin .op la diseñadora no
  // podía escribir SU PROPIO entregable y quedaba trabada en cada corrida.
  '.op', '.png', '.jpg', '.jpeg', '.webp'
]);

// Archivos sin extensión que un proyecto nativo necesita sí o sí.
const ALLOWED_EXACT_NAMES = new Set(['gradlew', 'gradlew.bat', '.gitignore']);

// Los nichos que entregan una app: su producto tiene que compilar, no verse.
export function esProyectoMovil(stack) {
  return stack === 'android' || stack === 'movil-rn';
}

// Los nichos cuyo entregable TIENE QUE COMPILAR antes de darse por hecho. Los
// móviles compilan una app; Python compila cada módulo con py_compile. En los
// dos casos el error del compilador vuelve al agente con archivo y línea, que
// es lo que evita que "entregué el programa" sea un texto con forma de
// programa.
export function esProyectoCompilado(stack) {
  return esProyectoMovil(stack) || stack === 'python';
}

// Salida de compilación y dependencias: NO son entregables. Listarlas llenaba
// la barra de archivos de la app con intermedios y, peor, le metía miles de
// rutas de basura al contexto del agente cuando hacía list_files.
// `__pycache__` y `venv` van acá por lo mismo: py_compile deja un .pyc por cada
// módulo y un entorno virtual son miles de archivos. Los que empiezan con punto
// (.venv, .pytest_cache, .ruff_cache) ya los saltea el filtro de ocultos.
export const CARPETAS_IGNORADAS = new Set(['build', '.gradle', 'node_modules', 'dist', '.expo', 'Pods', '__pycache__', 'venv']);

export function esCarpetaIgnorada(nombre) {
  return CARPETAS_IGNORADAS.has(nombre);
}

export function projectDir(companyId, projectSlug) {
  return path.join(WORKSPACE_ROOT, String(companyId), String(projectSlug || 'general'));
}

// Guardia del sandbox: la ruta resultante tiene que caer DENTRO de la carpeta
// del proyecto, sin escapes (..), sin ocultos, sin symlinks y con extensión
// permitida.
export function safeWorkspacePath(companyId, projectSlug, relative) {
  const base = projectDir(companyId, projectSlug);
  const raw = String(relative || '').trim();
  if (!raw || path.isAbsolute(raw) || raw.includes('\0')) {
    throw new Error(`Ruta inválida: ${relative}`);
  }
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))) {
    throw new Error(`Ruta fuera del proyecto: ${relative}`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_EXACT_NAMES.has(path.basename(target))) {
    throw new Error(`Extensión no permitida (${ext || 'sin extensión'}). Usá: ${[...ALLOWED_EXTENSIONS].slice(0, 8).join(', ')}…`);
  }
  return target;
}

// El contenido del archivo puede llegar de varias formas según cómo el modelo
// decida responder: entre los marcadores (lo pedido), dentro del JSON con
// distintos nombres de campo, o simplemente pegado después del JSON. Todas
// valen: rechazarlas quemaba pasos de la corrida sin producir nada.
// Ningún marcador del protocolo puede terminar DENTRO del archivo. Pasó de
// verdad: un theme.js quedó terminado en "\n<<<" porque el modelo truncó el
// marcador de cierre, el import rompía, y el equipo entero se quedó trabado
// intentando arreglar un archivo que nadie entendía por qué fallaba.
function limpiarMarcadores(texto) {
  return String(texto || '')
    // Marcador de apertura suelto al principio.
    .replace(/^\s*<<<[A-ZÁÉÍÓÚ]*\s*\n?/, '')
    // Marcador de cierre —entero o truncado— al final.
    .replace(/\n?\s*(?:[A-ZÁÉÍÓÚ]*>>>|<<<[A-ZÁÉÍÓÚ]*)\s*$/, '')
    .replace(/\n?\s*<+\s*$/, '');
}

export function extractFileContent(rawText, action) {
  const heredoc = String(rawText || '').match(/<<<CONTENIDO\n?([\s\S]*?)\n?CONTENIDO>>>/);
  if (heredoc) {
    return limpiarMarcadores(heredoc[1]);
  }
  // Marcador de apertura sin cierre: el modelo lo truncó. El contenido vale,
  // el marcador no.
  const abierto = String(rawText || '').match(/<<<CONTENIDO\n?([\s\S]*)$/);
  if (abierto && abierto[1].trim().length > 40) {
    return limpiarMarcadores(abierto[1]);
  }
  for (const key of ['content', 'contents', 'text', 'body', 'data', 'file']) {
    if (typeof action?.[key] === 'string' && action[key].trim()) {
      return limpiarMarcadores(action[key]);
    }
  }
  // Última chance: lo que venga después del JSON de la acción.
  const text = String(rawText || '');
  const closing = text.indexOf('}');
  if (closing >= 0) {
    const rest = text.slice(closing + 1)
      .replace(/^\s*```[a-z]*\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (rest.length > 40) {
      return limpiarMarcadores(rest);
    }
  }
  return '';
}

// Cede la clave mientras la persona conversa (con tope, para que un cliente
// colgado no congele el trabajo para siempre).
async function waitWhileUserSpeaks(maxWaitMs = 60000) {
  const until = Date.now() + maxWaitMs;
  while (isUserSpeaking() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Estado real del trabajo de la empresa, para que en la reunión los agentes
// (sobre todo la CEO) sepan qué está pasando y no contesten "no sé".
export function renderWorkSection(store, companyId, goalId = null) {
  if (!companyId) {
    return '';
  }
  // Dentro de un proyecto se habla SOLO de ese proyecto: es lo que hace que el
  // agente entienda "cambiá el header" sin preguntar de cuál de cinco webs.
  const goals = goalId
    ? [store.getGoal(goalId)].filter(Boolean)
    : store.listGoals(companyId, 'active').slice(0, 3);
  if (goals.length === 0) {
    return '';
  }
  const en = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
  const ESTADOS = en ? {
    pending: 'queued',
    in_progress: 'working now',
    done: 'done',
    blocked: 'stuck',
    noted: 'noted as agreement'
  } : {
    pending: 'en cola',
    in_progress: 'trabajando ahora',
    done: 'terminada',
    blocked: 'trabada',
    noted: 'anotada como acuerdo'
  };
  const nameOf = (agentId) => store.getAgent(agentId)?.name || (en ? 'someone on the team' : 'alguien del equipo');

  const lines = [];
  for (const goal of goals) {
    lines.push(en ? `Project "${goal.title}":` : `Proyecto "${goal.title}":`);
    // Los archivos que YA existen: sin esto, pedirles "cambiá el header" en la
    // reunión les llegaba sin ninguna referencia de qué hay construido.
    const archivos = listProjectFilesSync(companyId, goal.slug);
    if (archivos.length) {
      lines.push(en ? `  Shipped files: ${archivos.slice(0, 20).join(', ')}` : `  Archivos entregados: ${archivos.slice(0, 20).join(', ')}`);
    }
    for (const task of store.tasksForGoal(goal.id).slice(0, 8)) {
      const estado = ESTADOS[task.status] || task.status;
      const revision = task.review_status === 'cambios'
        ? (en ? ' (changes requested)' : ' (le pidieron cambios)')
        : task.review_status === 'aprobado' ? (en ? ' (reviewed and approved)' : ' (revisada y aprobada)') : '';
      lines.push(`- ${nameOf(task.agent_id)}: ${String(task.text).slice(0, 120)} — ${estado}${revision}`);
    }
  }
  return [
    goalId
      ? (en
        ? 'THIS PROJECT, RIGHT NOW (this is really happening; if they ask how'
        : 'ESTE PROYECTO, AHORA MISMO (está pasando de verdad; si te preguntan cómo viene')
      : (en
        ? 'COMPANY WORK IN PROGRESS (really happening right now; if they ask how'
        : 'TRABAJO EN CURSO DE LA EMPRESA (está pasando de verdad ahora mismo; si te preguntan cómo viene'),
    en
      ? 'something is going, or ask to change something already shipped, answer with this and never say you don\'t know):'
      : 'algo, o te piden cambiar algo que ya está entregado, respondé con esto y no digas que no sabés):',
    ...lines
  ].join('\n');
}

// Los archivos de un proyecto, planos y relativos. Síncrono a propósito: son
// unas pocas decenas de entradas y se arma dentro del prompt.
export function listProjectFilesFor(companyId, slug) {
  return listProjectFilesSync(companyId, slug);
}

function listProjectFilesSync(companyId, slug) {
  const base = projectDir(companyId, slug);
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name) || out.length >= 40) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(base, '');
  return out;
}

// Lo que ya existe en el proyecto, listo para meter en el prompt: el archivo
// principal completo y las señas de su identidad visual. Sin esto, cada
// empleado regeneraba index.html con su propio estilo y el sitio cambiaba de
// cara en cada vuelta.
// El JSON de la acción vive ANTES del primer marcador (<<<CONTENIDO,
// <<<BUSCAR, <<<REEMPLAZAR). Cortarlo solo en <<<CONTENIDO hacía que el
// contenido —HTML y CSS, llenos de llaves— se mezclara con el JSON y la
// acción se descartara como inválida, quemando el paso.
// Reemplazo exacto y, si no da, tolerante a espacios/indentación: el modelo
// casi nunca reproduce el sangrado tal cual, y rechazarlo por eso quemaba
// pasos sin que el archivo avanzara.
export function applyEdit(contenido, desde, hacia) {
  if (!desde.trim()) {
    throw new Error('el bloque BUSCAR está vacío');
  }
  const exactas = contenido.split(desde).length - 1;
  if (exactas === 1) {
    return contenido.replace(desde, hacia);
  }
  if (exactas > 1) {
    throw new Error(`ese texto aparece ${exactas} veces: incluí más contexto alrededor para que sea único`);
  }

  // Segundo intento: mismo texto salvo cantidad de espacios y saltos.
  const flexible = new RegExp(
    desde
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
    'g'
  );
  const coincidencias = contenido.match(flexible);
  if (!coincidencias) {
    throw new Error('ese texto no está en el archivo. Volvé a leerlo con read_file y copiá un fragmento EXACTO, corto y único');
  }
  if (coincidencias.length > 1) {
    throw new Error(`ese texto aparece ${coincidencias.length} veces: incluí más contexto para que sea único`);
  }
  return contenido.replace(flexible, () => hacia);
}

export function splitBeforeHeredoc(text) {
  const marker = String(text || '').search(/<<<[A-ZÁÉÍÓÚ]/);
  return marker >= 0 ? String(text).slice(0, marker) : String(text || '');
}

// La identidad visual del proyecto vive en tokens.css y en ningún otro lado.
// (Antes había además un PROYECTO.md de varios KB: producir ese documento se
// comía una corrida entera y competía con el producto. El único artefacto de
// coordinación que se gana el lugar es este, porque evita que cada agente
// invente su propia paleta.)
export async function leerTokens(dir) {
  const tokens = await fs.readFile(path.join(dir, 'tokens.css'), 'utf-8').catch(() => '');
  return tokens.trim().slice(0, 4000);
}

// Una línea por corrida: qué hizo, qué dejó pendiente. Es el traspaso entre
// compañeros — sin esto, lo que aprendió el que trabajó antes se pierde.
export async function anotarEnBitacora(dir, { agente, tarea, resumen, pendiente }) {
  const fecha = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const linea = [
    `- **${fecha} · ${agente}** — ${String(tarea).slice(0, 140)}`,
    `  - Did: ${String(resumen || '—').slice(0, 400)}`,
    pendiente ? `  - Still pending: ${String(pendiente).slice(0, 300)}` : ''
  ].filter(Boolean).join('\n');

  const ruta = path.join(dir, 'BITACORA.md');
  const cabecera = '# Project log\n\nWhat each person did and what they left for whoever comes next.\n\n';
  // APPEND, no leer-modificar-escribir: con varios agentes terminando a la vez,
  // el ciclo read→write perdía entradas en silencio — justo el canal por el que
  // se pasan el contexto entre corridas.
  const existe = existsSync(ruta);
  await fs.appendFile(ruta, existe ? `${linea}\n` : `${cabecera}${linea}\n`, 'utf-8').catch(() => {});

  // El recorte va aparte y solo cuando hace falta: dejó de ser transaccional a
  // propósito, es una bitácora y no un libro contable.
  const info = await fs.stat(ruta).catch(() => null);
  if (info && info.size > 20000) {
    const actual = await fs.readFile(ruta, 'utf-8').catch(() => '');
    if (actual) {
      await fs.writeFile(ruta, cabecera + actual.slice(-16000).replace(/^[^\n]*\n/, ''), 'utf-8').catch(() => {});
    }
  }
}

export async function readProjectState(dir, files) {
  if (files.length === 0) {
    return null;
  }
  const principal = files.find((f) => /(^|\/)index\.html?$/i.test(f)) || files[0];
  const contenido = await fs.readFile(path.join(dir, principal), 'utf-8').catch(() => '');
  if (!contenido) {
    return { principal, contenido: '', identidad: [] };
  }

  const identidad = [];
  const root = contenido.match(/:root\s*\{[^}]{0,1200}\}/i);
  if (root) {
    identidad.push(`Variables de diseño ya definidas:\n${root[0]}`);
  }
  const fuentes = [...contenido.matchAll(/font-family\s*:\s*([^;]{3,90});/gi)].map((m) => m[1].trim());
  if (fuentes.length) {
    identidad.push(`Tipografías en uso: ${[...new Set(fuentes)].slice(0, 3).join(' | ')}`);
  }
  const clases = [...contenido.matchAll(/class="([^"]{1,120})"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean);
  const frecuentes = [...new Set(clases)].slice(0, 24);
  if (frecuentes.length) {
    identidad.push(`Clases CSS existentes (reusalas, no inventes otras en paralelo): ${frecuentes.join(', ')}`);
  }
  const secciones = [...contenido.matchAll(/<(?:section|header|footer|main|nav)[^>]*\bid="([^"]+)"/gi)].map((m) => m[1]);
  if (secciones.length) {
    identidad.push(`Secciones ya armadas: ${[...new Set(secciones)].join(', ')}`);
  }
  return { principal, contenido, identidad };
}

export class Workforce {
  constructor(store, keyRing, { onEvent } = {}) {
    this.store = store;
    this.keyRing = keyRing;
    this.onEvent = onEvent;
    this.busyAgents = new Set();
    // Cerrojos de trabajo, a dos niveles:
    //  - busyFiles: goalId → archivos tomados. Dos agentes pueden construir el
    //    MISMO proyecto a la vez mientras cada uno escriba lo suyo.
    //  - busyProjects: proyectos tomados enteros (revisiones y tareas sin
    //    archivo declarado, que pueden tocar cualquier cosa).
    this.busyFiles = new Map();
    this.busyProjects = new Set();
    // Archivos que una corrida reclamó sobre la marcha (no eran su target_file
    // pero los empezó a escribir). Se liberan con ella.
    this.reclamados = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
    this.migrateLegacyLayout();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        telemetry.add({ type: 'workforce_tick_failed', payload: { error: String(error?.message || error).slice(0, 200) } });
      });
    }, TICK_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Antes de los proyectos, todo se escribía suelto en workspace/<empresa>/.
  // Esos archivos se mudan a la carpeta 'general' para que sigan visibles
  // desde la UI (y para que el entorno tenga una sola forma).
  migrateLegacyLayout() {
    let companies = [];
    try {
      companies = readdirSync(WORKSPACE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return;
    }
    for (const company of companies) {
      const companyPath = path.join(WORKSPACE_ROOT, company.name);
      let loose = [];
      try {
        loose = readdirSync(companyPath, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
      } catch {
        continue;
      }
      if (loose.length === 0) {
        continue;
      }
      const target = path.join(companyPath, 'general');
      mkdirSync(target, { recursive: true });
      for (const file of loose) {
        try {
          renameSync(path.join(companyPath, file.name), path.join(target, file.name));
        } catch {
          // Un archivo que no se puede mover no debe frenar el arranque.
        }
      }
      telemetry.add({ type: 'workspace_layout_migrated', payload: { companyId: company.name, files: loose.length } });
    }
  }

  emitEvent(companyId, event) {
    telemetry.add({ type: `work_${event.kind}`, payload: { companyId, ...event } });
    logEvent(`trabajo_${event.kind}`, { companyId, ...event });
    this.onEvent?.(companyId, { type: 'work_event', ...event });
  }

  // ¿Esta tarea puede arrancar sin pisar a nadie?
  //
  // El candado era por PROYECTO: una sola corrida por proyecto, aunque las
  // tareas tocaran archivos distintos. Era lo correcto cuando nadie declaraba
  // qué archivo escribía. Ahora cada entregable trae su target_file con un
  // único dueño, así que el candado baja a nivel ARCHIVO y dos personas pueden
  // construir el mismo proyecto a la vez, cada una en lo suyo.
  //
  // Se mantiene exclusivo el proyecto entero cuando:
  //  - la tarea no declara archivo (no se sabe qué va a tocar),
  //  - es una revisión (lee TODO el proyecto: no puede leerlo a medio escribir),
  //  - es un refinamiento (toca perfiles, no archivos, pero conviene serializar).
  puedeArrancar(task) {
    if (!task.goal_id) {
      return true;
    }
    if (this.busyProjects.has(task.goal_id)) {
      return false;
    }
    // Por OLAS: quien define el contrato del proyecto (la paleta, la
    // estructura) va primero y solo; los que lo consumen entran después. Sin
    // esto, el paralelismo hace que cada uno invente su propio estilo.
    if (task.kind === 'entregable' || task.kind === 'spec') {
      const abierta = this.store.faseAbierta(task.goal_id);
      if (abierta !== null && task.phase > abierta) {
        return false;
      }
    }
    const exclusiva = !task.target_file || task.kind !== 'entregable';
    if (exclusiva) {
      // Necesita el proyecto para ella sola: no puede haber nadie adentro.
      return !this.busyFiles.has(task.goal_id);
    }
    const tomados = this.busyFiles.get(task.goal_id);
    return !tomados || !tomados.has(task.target_file);
  }

  tomarCerrojo(task) {
    if (!task.goal_id) {
      return;
    }
    const exclusiva = !task.target_file || task.kind !== 'entregable';
    if (exclusiva) {
      this.busyProjects.add(task.goal_id);
      return;
    }
    if (!this.busyFiles.has(task.goal_id)) {
      this.busyFiles.set(task.goal_id, new Set());
    }
    this.busyFiles.get(task.goal_id).add(task.target_file);
  }

  soltarCerrojo(task) {
    if (!task.goal_id) {
      return;
    }
    this.busyProjects.delete(task.goal_id);
    const tomados = this.busyFiles.get(task.goal_id);
    if (tomados) {
      if (task.target_file) {
        tomados.delete(task.target_file);
      }
      // También lo que reclamó sobre la marcha: si no, queda tomado para
      // siempre y nadie puede volver a tocar ese archivo.
      for (const archivo of this.reclamados.get(task.id) || []) {
        tomados.delete(archivo);
      }
      if (tomados.size === 0) {
        this.busyFiles.delete(task.goal_id);
      }
    }
    this.reclamados.delete(task.id);
  }

  // ¿Alguien más está escribiendo ESTE archivo ahora mismo? Devuelve su
  // nombre, o null si está libre. El cerrojo protegía solo el archivo
  // declarado: sin esto, un agente podía escribir el de otro.
  duenoDeArchivo(task, archivo) {
    if (!task.goal_id || archivo === task.target_file) {
      return null;
    }
    const tomados = this.busyFiles.get(task.goal_id);
    if (!tomados || !tomados.has(archivo)) {
      return null;
    }
    const otro = this.store.fileOwnersForGoal(task.goal_id)
      .find((d) => d.file === archivo && d.agent_id !== task.agent_id);
    return otro?.name || 'un compañero';
  }

  // Un archivo sin dueño que alguien empieza a escribir pasa a ser suyo
  // mientras dure la corrida.
  reclamarArchivo(task, archivo) {
    if (!task.goal_id || archivo === task.target_file) {
      return;
    }
    if (!this.busyFiles.has(task.goal_id)) {
      this.busyFiles.set(task.goal_id, new Set());
    }
    this.busyFiles.get(task.goal_id).add(archivo);
    if (!this.reclamados.has(task.id)) {
      this.reclamados.set(task.id, new Set());
    }
    this.reclamados.get(task.id).add(archivo);
  }

  async tick() {
    // Con una reunión abierta el equipo trabaja igual, pero más despacio: la
    // clave de API es la misma que usa la conversación.
    const maxConcurrent = hasLiveSession() ? MAX_CONCURRENT_EN_REUNION : MAX_CONCURRENT;
    if (!this.keyRing.hasKeys() || this.busyAgents.size >= maxConcurrent) {
      return;
    }
    // La persona tiene prioridad: mientras HABLA, el equipo no arranca trabajo
    // nuevo (lo que ya está corriendo cede la clave por su cuenta).
    if (isUserSpeaking()) {
      return;
    }
    for (const companyId of this.store.activeWorkCompanies()) {
      for (const task of this.store.workQueue(companyId)) {
        if (this.busyAgents.size >= maxConcurrent) {
          return;
        }
        const agent = this.store.getAgent(task.agent_id);
        if (!agent || agent.status !== 'active' || this.busyAgents.has(agent.id)) {
          continue;
        }
        if (!this.puedeArrancar(task)) {
          continue;
        }
        if (!this.store.checkoutTask(task.id)) {
          continue;
        }
        this.busyAgents.add(agent.id);
        this.tomarCerrojo(task);
        void this.executeTask(companyId, agent, task)
          .catch((error) => {
            this.store.finishTask(task.id, { status: 'blocked', blockedReason: String(error?.message || error).slice(0, 300) });
          })
          .finally(() => {
            this.busyAgents.delete(agent.id);
            this.soltarCerrojo(task);
            if (task.goal_id && this.store.completeGoalIfDone(task.goal_id)) {
              const goal = this.store.getGoal(task.goal_id);
              this.emitEvent(companyId, { kind: 'goal_done', goalId: task.goal_id, title: goal?.title });
            }
          });
      }
    }
  }

  async executeTask(companyId, agent, task) {
    const runId = this.store.startWorkRun(task.id, agent.id, companyId);
    this.emitEvent(companyId, { kind: 'task_started', taskId: task.id, agentId: agent.id, agentName: agent.name, text: task.text });

    if (task.kind === 'revision') {
      return this.executeReview(companyId, agent, task, runId);
    }
    if (task.kind === 'refinamiento' || agent.role === 'contratista') {
      return this.executeRefinement(companyId, agent, task, runId);
    }
    return this.executeWork(companyId, agent, task, runId);
  }

  // ── Trabajo real con herramientas de archivos ─────────────────────────

  async executeWork(companyId, agent, task, runId) {
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;
    const company = this.store.getCompany(companyId);
    const slug = goal?.slug || 'general';
    const workspaceDir = projectDir(companyId, slug);
    mkdirSync(workspaceDir, { recursive: true });

    const log = [];
    const artifacts = new Set();
    let filesWritten = 0;

    // ANDAMIAJE OBLIGATORIO. Un proyecto vacío se andamia con la herramienta
    // oficial ANTES de que el agente entre. Medido: la única app bien armada de
    // 18 fue la única donde el agente lo corrió por su cuenta; pedírselo no
    // alcanza. Si el usuario nombró un comando, manda el suyo.
    let andamiaje = null;
    if (goal && task.kind === 'entregable') {
      andamiaje = await andamiar(workspaceDir, normalizeStack(goal.stack), {
        pedidoDelUsuario: this.store.userRequestForGoal(goal.id).join(' '),
        escribir: async (rel, contenido) => {
          const destino = safeWorkspacePath(companyId, slug, rel);
          mkdirSync(path.dirname(destino), { recursive: true });
          await fs.writeFile(destino, contenido, 'utf-8');
        }
      });
      if (andamiaje.hecho) {
        log.push({ step: 0, action: 'andamiaje', ok: true, note: andamiaje.cmd || andamiaje.como });
        this.emitEvent(companyId, {
          kind: 'andamiaje',
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          que: andamiaje.que
        });
        logEvent('andamiaje', { companyId, proyecto: goal.title, stack: goal.stack, cmd: andamiaje.cmd || andamiaje.como });
      } else if (andamiaje.motivo) {
        log.push({ step: 0, action: 'andamiaje', ok: false, note: andamiaje.motivo.slice(0, 160) });
      }
    }

    // El entorno de diseño tiene que estar ARRIBA antes de que la diseñadora
    // corra su primer comando. Malena quedó bloqueada con "Connection refused
    // en 127.0.0.1:3100" porque este arranque no existía: la función estaba
    // escrita y nadie la llamaba.
    if (goal && esAgenteDeDiseno(agent) && disenoDisponible()) {
      const abierto = await abrirDiseno(workspaceDir, goal.id);
      log.push({ step: 0, action: 'diseno', ok: abierto.ok, note: abierto.ok ? `port ${abierto.puerto}` : abierto.motivo });
    }
    // La verificación determinista corre UNA vez por corrida, al primer finish.
    let verificado = false;
    let ultimaVerificacion = [];
    // Respuestas en prosa seguidas: a la tercera se corta la corrida.
    let invalidasSeguidas = 0;
    // La compilación de la app móvil corre UNA vez por corrida.
    let compilado = false;
    // Consultas a compañeros: acotadas para que no se vuelva una charla.
    let consultas = 0;
    // Comandos ejecutados: hay tope porque cada uno puede tardar minutos.
    let comandos = 0;

    const listFiles = async () => {
      const out = [];
      const walk = async (dir, prefix) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), rel);
          } else {
            out.push(rel);
          }
        }
      };
      await walk(workspaceDir, '');
      return out.slice(0, 100);
    };

    const teammates = this.store.listAgents({ companyId })
      .filter((a) => a.id !== agent.id)
      .map((a) => `${a.name} (${a.title})`).join(', ');
    // El summary del finish lo lee el usuario en el panel: en inglés si la voz es inglesa.
    const enWork = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');

    const system = [
      `Sos ${agent.name}, ${agent.title} de ${company?.name || 'la empresa'}. AHORA NO estás en una reunión: estás TRABAJANDO, produciendo un entregable real.`,
      agent.knowledge ? `Tu conocimiento: ${agent.knowledge}` : '',
      agent.craft ? `TU OFICIO (cómo hacés bien tu trabajo): ${agent.craft}` : '',
      `Tus skills: ${agent.domains.join(', ')}.`,
      `Compañeros (pueden haber dejado archivos en el workspace): ${teammates || 'ninguno'}.`,
      '',
      renderSkillsSection(`${task.text || ''} ${goal?.title || ''}`, { scope: 'work' }),
      'Trabajás editando archivos del workspace compartido. En CADA respuesta ejecutás UNA acción:',
      '- Para escribir un archivo respondé EXACTAMENTE así (el contenido va CRUDO entre los marcadores, sin escapar):',
      '{"action":"write_file","path":"ruta/relativa"}',
      '<<<CONTENIDO',
      '…el archivo COMPLETO acá, tal cual…',
      'CONTENIDO>>>',
      '- Para CAMBIAR una parte de un archivo que ya existe (preferí esto antes que reescribirlo entero):',
      '{"action":"edit_file","path":"ruta/relativa"}',
      '<<<BUSCAR',
      'el texto exacto que hay que reemplazar, tal cual está en el archivo',
      'BUSCAR>>>',
      '<<<REEMPLAZAR',
      'el texto nuevo',
      'REEMPLAZAR>>>',
      '  Para INSERTAR algo nuevo: buscá una línea corta y única (por ejemplo </main> o </body>) y reemplazala por tu bloque seguido de esa misma línea.',
      '- Otras acciones (solo el JSON, nada más):',
      '{"action":"read_file","path":"ruta/relativa"}',
      '{"action":"list_files"}',
      '{"action":"web","url":"https://…"}',
      '  ↑ Leer una página web (docs, precios, referencias). Solo http/https, devuelve texto recortado.',
      renderHerramientas(goal?.stack),
      '{"action":"consultar","a":"nombre de un compañero","pregunta":"lo que necesitás saber"}',
      '  ↑ Consultale a quien sabe en vez de adivinar. Te contesta EN EL ACTO con su criterio.',
      '  Usalo cuando la duda es de otra especialidad: la paleta, un patrón, si algo se entiende.',
      '  Es una ventaja que tenés y una persona no: preguntar no le hace perder tiempo a nadie.',
      enWork
        ? '{"action":"finish","summary":"what you did, in 1-3 sentences in English","artifacts":["main","files"]}'
        : '{"action":"finish","summary":"qué hiciste en 1-3 oraciones en español","artifacts":["archivos","principales"]}',
      '{"action":"block","reason":"qué te falta para poder avanzar"}',
      '',
      'Reglas: en write_file va el archivo COMPLETO (no parches); para tocar una parte usá edit_file. NO listes archivos más de una vez.',
      'Si el proyecto ya tiene archivos, tu trabajo es CONTINUARLOS: editá lo que existe y respetá su estilo. Empezar de cero borra el trabajo de un compañero.',
      // El archivo de tokens NO se llama igual en todos los nichos, y el nombre
      // importa: pedirle tokens.css a un dev de React Native lo manda a romper su
      // propio playbook ("Nada de CSS") en el mismo prompt que se lo prohíbe. Un
      // programa de consola, además, no tiene superficie que mirar: arrancar por
      // los tokens le gasta un paso en un archivo que nadie abre.
      archivoDeTokens(goal?.stack)
        ? `Si el proyecto está vacío sos el primero: escribí ${archivoDeTokens(goal?.stack)} (paleta, escala, espaciado, radios) y ENSEGUIDA el entregable, en esta misma corrida. Los dos archivos, no uno.`
        : 'Si el proyecto está vacío sos el primero: escribí el punto de entrada y ENSEGUIDA lo que falte para que corra, en esta misma corrida. Un archivo de tokens va solo si el entregable tiene una pantalla que se mire.',
      'ANDÁ DIRECTO A PRODUCIR: en el paso 1 ya escribís. Nada de planes, documentos ni resúmenes previos — el entregable es el producto, no un informe sobre el producto.',
      `Terminá con finish cuando esté REALMENTE completo y usable. Máximo ${MAX_STEPS_PER_RUN} pasos.`,
      '',
      // El criterio del oficio (qué tecnología para qué caso) y el piso de
      // diseño viven en server/playbooks/*.md, no acá: son largos, se editan
      // seguido y valen para todos los agentes del nicho.
      renderPlaybooks(goal?.stack),
      '',
      // El criterio dice QUÉ construir; el flujo dice EN QUÉ ORDEN y con qué
      // comando se verifica antes de cerrar. Sin él las corridas escribían
      // archivos sueltos, dejaban el punto de entrada con la plantilla por
      // defecto y se quedaban sin pasos antes del finish.
      renderFlujo(goal?.stack),
      renderRoles(),
      '',
      'Usá el contexto real de la empresa: los nombres y puestos de tus compañeros valen más que personas inventadas.',
      'NUNCA le preguntes al usuario cuestiones técnicas: decidí vos con el criterio de arriba.'
    ].filter(Boolean).join('\n');

    // El contexto de la tarea viaja SIEMPRE; cada paso suma la historia de
    // acciones + la última observación (nunca se pierde el "qué" ni el "porqué").
    const archivosIniciales = await listFiles();
    const estado = await readProjectState(workspaceDir, archivosIniciales);
    const yaExiste = new Set(archivosIniciales);
    const leidos = new Set();

    // El contrato escrito manda sobre cualquier deducción. Antes la identidad
    // visual se reconstruía con regex sobre index.html (buscando :root y
    // font-family); ahora se lee el documento que la declara, que es la razón
    // por la que existe.
    // El entorno de diseño: la diseñadora diseña en OpenPencil, el dev lee ESE
    // diseño. Es el handoff que en FASA no existía — cada uno inventaba.
    const disenaEsta = esAgenteDeDiseno(agent);
    const variablesDiseno = await leerTokensDelDiseno(workspaceDir);
    const tokensDelDiseno = tokensComoCodigo(variablesDiseno, goal?.stack);
    const bloqueDiseno = renderDiseno({
      esDisenador: disenaEsta,
      hayDiseno: Boolean(variablesDiseno) || existsSync(path.join(workspaceDir, 'diseno.op')),
      tokens: tokensDelDiseno,
      stack: goal?.stack
    });

    const tokens = await leerTokens(workspaceDir);
    const bloqueContrato = tokens
      ? `\nPALETA Y MEDIDAS DEL PROYECTO (tokens.css) — usá var(--…), no escribas valores a mano.\nSi falta un tono, agregalo a tokens.css y referencialo.\n${tokens}`
      : '';

    // Lo que dejó quien trabajó antes: sin esto el traspaso se pierde, porque
    // lastObservation solo vive dentro de una corrida.
    const bitacora = await fs.readFile(path.join(workspaceDir, 'BITACORA.md'), 'utf-8').catch(() => '');
    const bloqueBitacora = bitacora.trim()
      // 2000 y no 4000: las entradas reales miden 150-190 caracteres, así que
      // entran las últimas ~11 y esas son el traspaso vivo. Con 4000, un
      // proyecto de varios días metía 4 kB de historia vieja en el prompt y era
      // el único bloque de documentación sin techo efectivo.
      ? `\n━━ BITÁCORA DEL EQUIPO (qué hizo cada uno y qué dejó pendiente) ━━\n${bitacora.trim().slice(-2000)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      : '';

    // Las reglas de continuidad estaban escritas en vocabulario de una sola
    // pantalla web (`:root`, `var(--...)`, `<style>`, "secciones") y viajaban
    // igual a los cuatro nichos que no producen HTML. En React Native eran
    // ~700 caracteres pidiéndole exactamente lo que revisarReactNative() rechaza.
    // Ahora las tres líneas de CSS solo salen donde hay CSS, y el resto nombra el
    // archivo de tokens del nicho.
    const esWeb = normalizeStack(goal?.stack) === 'web';
    const archivoTokens = archivoDeTokens(goal?.stack);
    const bloqueContinuidad = estado
      ? [
          '',
          '━━ ESTO YA EXISTE EN EL PROYECTO. NO EMPIECES DE CERO ━━',
          `El trabajo ya arrancó: alguien del equipo dejó ${archivosIniciales.length === 1 ? 'este archivo' : 'estos archivos'}: ${archivosIniciales.join(', ')}.`,
          'Tu trabajo es CONTINUARLO, no reemplazarlo. Reglas, en serio:',
          `- Si tu tarea toca algo que ya está en ${estado.principal}, EDITÁ ese archivo (usá edit_file). No creés uno nuevo al lado.`,
          '- Respetá la identidad visual que ya tiene: mismos colores, misma tipografía, mismo tono de los textos.',
          archivoTokens
            ? `- NO inventes colores ni medidas: usá los que ya están en ${archivoTokens}. Si de verdad falta un tono, agregalo ahí con el mismo criterio de los que ya están.`
            : '- NO inventes valores nuevos: reusá los que ya están definidos en el proyecto.',
          ...(esWeb
            ? [
                '  Un bloque con fondo claro en una página oscura (o al revés) es un error, no una decisión de diseño.',
                '- Si tu bloque nuevo necesita estilos, escribilos dentro del <style> que ya existe, siguiendo sus convenciones de nombres.'
              ]
            : []),
          '- No rehagas lo que ya está bien solo porque lo harías distinto.',
          '- Si de verdad hay que rehacer el archivo completo, primero leelo y después escribilo MANTENIENDO su estilo.',
          // La identidad deducida solo se usa como respaldo: si hay tokens.css,
          // ese es el contrato y las señas adivinadas sobran.
          ...(!tokens && estado.identidad.length
            ? ['', 'IDENTIDAD DEL PROYECTO (deducida de lo que ya está; respetala):', ...estado.identidad]
            : []),
          '',
          `CONTENIDO ACTUAL DE ${estado.principal}:`,
          estado.contenido.length > 6000
            ? `${estado.contenido.slice(0, 6000)}\n… (recortado a propósito: leelo completo con read_file si lo necesitás)`
            : estado.contenido,
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n')
      : '';

    // El pedido con las palabras del usuario va PRIMERO y siempre. Cuando el
    // prompt arrancaba con el título del proyecto, un proyecto llamado
    // "Trabajo de 27/7/2026" hacía que el equipo inventara una web genérica
    // aunque en la reunión se hubiera pedido un menú de sushi con parallax.
    const pedido = goal ? this.store.userRequestForGoal(goal.id) : [];
    const bloquePedido = pedido.length
      ? [
          '━━ LO QUE PIDIÓ EL USUARIO (sus palabras — esto es lo que hay que construir) ━━',
          ...pedido.map((linea) => `» ${String(linea).slice(0, 600)}`),
          'Construí ESTO. Si el título del proyecto dice otra cosa, mandan estas palabras.',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n')
      : '';

    // El esquema de archivos del proyecto, con dueño. Sin esto cada agente
    // suponía el suyo: uno escribía index.html, otro "maquetaba tres páginas"
    // que no existían y un tercero tenía que "implementar el parallax" dentro
    // de un archivo ajeno que todavía no estaba escrito.
    const duenos = goal ? this.store.fileOwnersForGoal(goal.id) : [];
    const mios = duenos.filter((d) => d.agent_id === agent.id).map((d) => d.file);
    const ajenos = duenos.filter((d) => d.agent_id !== agent.id);
    const bloqueEsquema = duenos.length
      ? [
          '',
          '━━ ESQUEMA DE ARCHIVOS DEL PROYECTO ━━',
          ...(mios.length
            ? [`TU ARCHIVO: ${mios.join(', ')} — es el que tenés que escribir en esta corrida.`]
            : ['Tu tarea no tiene un archivo asignado: escribí el que corresponda sin pisar los de abajo.']),
          ...(ajenos.length
            ? [
                'De otros (NO los toques, ni creés versiones al lado):',
                ...ajenos.map((d) => `  ${d.file} → ${d.name || 'un compañero'}${d.status === 'done' ? ' (ya entregado)' : ' (todavía no)'}`)
              ]
            : []),
          'Si lo que te toca vive DENTRO de un archivo de otro, esperá a que lo entregue y editalo con edit_file. No lo dupliques.',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n')
      : '';

    // El esquema de arriba es el REPARTO; esto es el PRESENTE: quién está
    // escribiendo qué en este momento, qué ya se entregó y qué espera turno.
    // Sin esto el agente no podía distinguir "todavía no" de "lo están
    // haciendo ahora mismo" y arrancaba una segunda versión del mismo archivo.
    //
    // Es una foto del arranque de la corrida, como el resto del encabezado: la
    // duplicación que hay que evitar se decide en el primer paso, cuando el
    // agente elige si crea el archivo o edita el que ya está.
    const bloqueConciencia = goal
      ? renderConciencia(this.store, {
          goalId: goal.id,
          agentId: agent.id,
          taskId: task.id,
          miArchivo: task.target_file
        })
      : '';

    const header = [
      bloquePedido,
      renderAndamiaje(andamiaje),
      bloqueDiseno,
      goal ? `PROYECTO: ${goal.title}${goal.brief ? ` — ${goal.brief}` : ''}` : '',
      `TU TAREA (el qué): ${task.text}`,
      task.target_file ? `EL ARCHIVO QUE TENÉS QUE ESCRIBIR: ${task.target_file}` : '',
      bloqueEsquema,
      bloqueConciencia,
      archivosIniciales.length ? '' : 'El proyecto está vacío: sos el primero.',
      bloqueContrato,
      bloqueBitacora,
      bloqueContinuidad
    ].filter(Boolean).join('\n');
    let lastObservation = estado
      ? `Ya leíste arriba el contenido de ${estado.principal}. Continuá sobre eso.`
      : 'Todavía no hiciste ninguna acción.';

    // A partir del paso 2 el contenido completo ya no viaja: el modelo lo vio
    // en el paso 1 y, si lo necesita otra vez, tiene read_file. Repetirlo
    // costaba ~7.900 tokens de entrada por paso en una web de 32kB.
    const headerLiviano = estado
      ? [
          // El pedido viaja en TODOS los pasos: es lo único que no se puede
          // recuperar con read_file si el modelo lo olvida.
          bloquePedido,
          bloqueDiseno,
          goal ? `PROYECTO: ${goal.title}` : '',
          `TU TAREA (el qué): ${task.text}`,
          task.target_file ? `TU ARCHIVO: ${task.target_file}` : '',
          // También en los pasos livianos: el choque con un compañero no deja
          // de ser posible en el paso 7. Son ≤900 caracteres con tope duro.
          bloqueConciencia,
          `Proyecto en curso — archivos: ${archivosIniciales.join(', ')}. El principal es ${estado.principal}.`,
          'Seguís CONTINUANDO ese trabajo: editá con edit_file y respetá su estilo.',
          tokens ? 'Los valores de diseño salen de tokens.css con var(--…).' : '',
          ...(!tokens && estado.identidad.length ? ['IDENTIDAD DEL PROYECTO (respetala):', ...estado.identidad] : []),
          'Si necesitás ver el archivo de nuevo, usá read_file.'
        ].filter(Boolean).join('\n')
      : header;

    for (let step = 1; step <= MAX_STEPS_PER_RUN; step += 1) {
      let action = null;
      let rawText = '';
      await waitWhileUserSpeaks();
      try {
        const history = log.length
          ? 'Acciones que ya hiciste: ' + log.map((entry) => `${entry.step}:${entry.action}${entry.path ? '(' + entry.path + ')' : ''}${entry.ok === false ? '✗' : ''}`).join(', ')
          : '';
        const encabezado = step === 1 ? header : headerLiviano;
        const { text } = await completeChat(this.keyRing, {
          models: getMinimaxModels(),
          scope: `trabajo ${agent.name}`,
          timeoutMs: STEP_TIMEOUT_MS,
          maxTokens: 16000,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                encabezado,
                history,
                `Última observación: ${lastObservation}`,
                RECORDATORIO_FORMATO,
                `Paso ${step}/${MAX_STEPS_PER_RUN}. Tu próxima acción (SOLO el JSON, nada de explicaciones):`
              ].filter(Boolean).join('\n\n')
            }
          ]
        });
        rawText = text;
        // El modelo suele mandar VARIAS acciones en un mensaje: quiere leer tres
        // archivos de una. Eso no es un error suyo, es una ventaja — leer es
        // barato. Si todas son de lectura, se resuelven en ESTE paso; si hay
        // alguna que modifica, se ejecuta la primera y se le avisa del resto.
        const acciones = parseJsonObjects(splitBeforeHeredoc(text)).filter((a) => a && a.action);
        if (acciones.length > 1 && acciones.every((a) => a.action === 'read_file' || a.action === 'list_files')) {
          const partes = [];
          for (const lectura of acciones.slice(0, 5)) {
            if (lectura.action === 'list_files') {
              const files = await listFiles();
              partes.push(`Archivos: ${JSON.stringify(files)}`);
              log.push({ step, action: 'list_files', note: `${files.length} files (batched)` });
              continue;
            }
            const contenido = await fs.readFile(safeWorkspacePath(companyId, slug, lectura.path), 'utf-8')
              .catch((error) => `[no pude leerlo: ${String(error?.message).slice(0, 100)}]`);
            leidos.add(String(lectura.path));
            log.push({ step, action: 'read_file', path: lectura.path, ok: true, note: 'batched' });
            partes.push(`--- ${lectura.path} ---\n${String(contenido).slice(0, 30000)}`);
          }
          invalidasSeguidas = 0;
          lastObservation = `Leí los ${partes.length} de una vez:\n\n${partes.join('\n\n')}`;
          continue;
        }
        action = acciones[0] || parseJsonFromModel(splitBeforeHeredoc(text));
        if (acciones.length > 1) {
          // Se ejecuta la primera; el resto se le recuerda para que no lo repita.
          const resto = acciones.slice(1).map((a) => a.action).join(', ');
          log.push({ step, action: 'multi', note: `also asked for: ${resto}` });
        }
      } catch (error) {
        log.push({ step, action: 'error', note: String(error?.message || error).slice(0, 200) });
        this.store.finishWorkRun(runId, { status: 'error', summary: 'The model call failed.', log, artifacts: [...artifacts] });
        if (task.run_count >= MAX_RUNS_PER_TASK) {
          const reason = `Failed ${task.run_count} times in a row calling the model. Check the key or the service status.`;
          this.store.finishTask(task.id, { status: 'blocked', blockedReason: reason });
          this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason });
          return;
        }
        this.store.finishTask(task.id, { status: 'pending' }); // vuelve a la cola
        this.emitEvent(companyId, { kind: 'task_retry', taskId: task.id, agentId: agent.id, agentName: agent.name, attempt: task.run_count });
        return;
      }

      if (!action?.action) {
        invalidasSeguidas += 1;
        log.push({ step, action: 'invalid', note: `no action JSON (${rawText.slice(0, 60).replace(/\s+/g, ' ')}…)` });
        // Se corta a la tercera seguida: antes se quemaban los 12 pasos
        // respondiendo en prosa y la tarea terminaba bloqueada sin producir
        // nada. Mejor volver a la cola y reintentar limpio.
        if (invalidasSeguidas >= 3) {
          this.store.finishWorkRun(runId, {
            status: 'error',
            summary: 'The model answered in prose three times in a row instead of an action.',
            log,
            artifacts: [...artifacts]
          });
          this.store.finishTask(task.id, task.run_count >= MAX_RUNS_PER_TASK
            ? { status: 'blocked', blockedReason: 'Could not answer with the action format after several tries.' }
            : { status: 'pending' });
          return;
        }
        // Se le repite el formato EXACTO: decirle "usá el formato correcto"
        // sin mostrarlo no lo saca del modo prosa.
        lastObservation = [
          'ERROR: tu respuesta no tenía una acción. No escribas explicaciones ni markdown.',
          'Respondé EXACTAMENTE con una de estas formas y nada más:',
          '{"action":"write_file","path":"index.html"}',
          '<<<CONTENIDO',
          '…el archivo entero…',
          'CONTENIDO>>>',
          '',
          'o bien: {"action":"read_file","path":"…"} · {"action":"finish","summary":"…"}'
        ].join('\n');
        continue;
      }
      invalidasSeguidas = 0;

      if (action.action === 'comando') {
        if (comandos >= MAX_COMANDOS_POR_CORRIDA) {
          lastObservation = `Ya corriste ${MAX_COMANDOS_POR_CORRIDA} comandos en esta corrida. Terminá con lo que tenés.`;
          log.push({ step, action: 'comando', ok: false, note: 'limit reached' });
          continue;
        }
        const cmd = String(action.cmd || action.comando || '').trim();
        const clasificacion = clasificarComando(cmd);
        if (!clasificacion.permitido) {
          log.push({ step, action: 'comando', ok: false, note: `blocked: ${clasificacion.motivo}` });
          lastObservation = `No corrí "${cmd.slice(0, 80)}": ${clasificacion.motivo}. Probá otra forma.`;
          continue;
        }
        // Riesgoso sin justificar: se le pide el porqué, no se le niega.
        if (clasificacion.riesgoso && !String(action.porque || '').trim()) {
          log.push({ step, action: 'comando', ok: false, note: 'risky without justification' });
          lastObservation = `"${cmd.slice(0, 80)}" puede borrar o mover cosas. Si de verdad hace falta, repetilo agregando "porque":"para qué lo necesitás" y lo corro.`;
          continue;
        }
        comandos += 1;
        this.emitEvent(companyId, {
          kind: 'comando',
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          cmd: cmd.slice(0, 160),
          riesgoso: Boolean(clasificacion.riesgoso)
        });
        const r = await ejecutar(cmd, workspaceDir);
        log.push({ step, action: 'comando', ok: r.ok, path: cmd.slice(0, 90), note: r.ok ? 'ok' : `code ${r.codigo}` });
        logEvent('comando_agente', {
          companyId,
          agente: agent.name,
          cmd: cmd.slice(0, 300),
          ok: r.ok,
          riesgoso: Boolean(clasificacion.riesgoso),
          porque: String(action.porque || '').slice(0, 200)
        });
        lastObservation = renderResultado(cmd, r);
        // Un comando puede haber creado archivos: cuentan como entregados.
        for (const nuevo of await listFiles()) {
          if (!yaExiste.has(nuevo)) {
            artifacts.add(nuevo);
          }
        }
        continue;
      }

      if (action.action === 'consultar') {
        // Colaboración de verdad: el compañero contesta con SU criterio, en el
        // acto. Es la ventaja que un agente tiene sobre una persona —
        // preguntar no le interrumpe el día a nadie— y evita que cada uno
        // resuelva por su cuenta lo que otro ya sabe.
        if (consultas >= MAX_CONSULTAS_POR_CORRIDA) {
          lastObservation = 'Ya consultaste dos veces en esta corrida. Resolvé con lo que tenés y seguí.';
          log.push({ step, action: 'consultar', ok: false, note: 'limit reached' });
          continue;
        }
        consultas += 1;
        const respuesta = await this.consultarCompanero(companyId, {
          quienPregunta: agent,
          aQuien: String(action.a || ''),
          pregunta: String(action.pregunta || ''),
          goal,
          slug,
          task
        });
        log.push({ step, action: 'consultar', ok: respuesta.ok, note: `${action.a}: ${respuesta.nota}` });
        lastObservation = respuesta.observacion;
        continue;
      }

      if (action.action === 'list_files') {
        const files = await listFiles();
        log.push({ step, action: 'list_files', note: `${files.length} files` });
        lastObservation = `Archivos: ${JSON.stringify(files)}. No vuelvas a listar: escribí o terminá.`;
      } else if (action.action === 'read_file') {
        try {
          const content = await fs.readFile(safeWorkspacePath(companyId, slug, action.path), 'utf-8');
          leidos.add(String(action.path));
          log.push({ step, action: 'read_file', path: action.path, ok: true });
          const recortado = content.length > 90000;
          lastObservation = [
            `Contenido de ${action.path}${recortado ? ' (recortado)' : ' (completo)'}:`,
            content.slice(0, 90000)
          ].join('\n');
        } catch (error) {
          log.push({ step, action: 'read_file', path: action.path, ok: false });
          lastObservation = `No pude leer ${action.path}: ${String(error?.message).slice(0, 120)}`;
        }
      } else if (action.action === 'web') {
        try {
          const url = String(action.url || '');
          if (!/^https?:\/\//.test(url)) {
            throw new Error('URL inválida (solo http/https)');
          }
          const res = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'EquipoAgent/1.0', Accept: 'text/html,text/plain' },
            redirect: 'follow'
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const html = (await res.text()).slice(0, 120000);
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60000);
          log.push({ step, action: 'web', path: url.slice(0, 120), ok: true });
          this.emitEvent(companyId, { kind: 'web', taskId: task.id, agentId: agent.id, agentName: agent.name, url: url.slice(0, 200) });
          lastObservation = `Contenido de ${url} (texto, recortado):\n${text || '(vacío)'}`;
        } catch (error) {
          log.push({ step, action: 'web', path: String(action.url || '').slice(0, 120), ok: false });
          lastObservation = `No pude leer ${String(action.url || '')}: ${String(error?.message).slice(0, 120)}`;
        }
      } else if (action.action === 'edit_file') {
        try {
          const target = safeWorkspacePath(companyId, slug, action.path);
          const actual = await fs.readFile(target, 'utf-8');
          const buscar = rawText.match(/<<<BUSCAR\n?([\s\S]*?)\n?BUSCAR>>>/);
          const reemplazar = rawText.match(/<<<REEMPLAZAR\n?([\s\S]*?)\n?REEMPLAZAR>>>/);
          if (!buscar) {
            throw new Error('falta el bloque <<<BUSCAR … BUSCAR>>>');
          }
          const desde = buscar[1];
          const hacia = reemplazar ? reemplazar[1] : '';
          const nuevo = applyEdit(actual, desde, hacia);
          await fs.writeFile(target, nuevo, 'utf-8');
          leidos.add(String(action.path));
          artifacts.add(String(action.path));
          log.push({ step, action: 'edit_file', path: action.path, bytes: Buffer.byteLength(nuevo), ok: true });
          lastObservation = `Edité ${action.path} (ahora tiene ${Buffer.byteLength(nuevo)} bytes). El resto del archivo quedó intacto.`;
          this.emitEvent(companyId, { kind: 'file_written', taskId: task.id, agentId: agent.id, agentName: agent.name, path: String(action.path), edited: true });
        } catch (error) {
          log.push({ step, action: 'edit_file', path: action.path, ok: false, note: String(error?.message).slice(0, 140) });
          const cola = await fs.readFile(safeWorkspacePath(companyId, slug, action.path), 'utf-8')
            .then((texto) => texto.slice(-1200))
            .catch(() => '');
          lastObservation = [
            `No pude editar ${action.path}: ${String(error?.message).slice(0, 200)}`,
            cola ? `Así TERMINA el archivo ahora (copiá de acá un fragmento corto y único para BUSCAR):\n${cola}` : '',
            'Truco: para insertar algo nuevo, buscá una línea corta y única —por ejemplo </main> o </body>— y reemplazala por tu bloque seguido de esa misma línea.'
          ].filter(Boolean).join('\n');
        }
      } else if (action.action === 'write_file') {
        try {
          const destino = safeWorkspacePath(companyId, slug, action.path);
          // Barrera anti-pisada. Se consulta el DISCO, no la foto del arranque:
          // con varios agentes trabajando a la vez, un archivo que un compañero
          // creó DURANTE esta corrida no está en la foto, y sobreescribirlo
          // borraba su trabajo entero sin decir nada.
          const existeAhora = yaExiste.has(String(action.path)) || existsSync(destino);
          if (existeAhora && !leidos.has(String(action.path)) && !artifacts.has(String(action.path))
              && !(estado && estado.principal === String(action.path))) {
            throw new Error('ese archivo ya existe y no lo leíste todavía en esta corrida: leelo con read_file (o usá edit_file para cambiar solo una parte)');
          }
          // Y no se escribe encima de lo que otro está escribiendo AHORA.
          const dueno = this.duenoDeArchivo(task, String(action.path));
          if (dueno) {
            throw new Error(`ese archivo lo está escribiendo ${dueno} en este momento. Trabajá en el tuyo (${task.target_file || 'el que te toca'}); si necesitás algo de ahí, usá consultar.`);
          }
          // El contenido viene crudo entre marcadores (robusto para HTML/CSS),
          // o inline en el JSON como fallback.
          const content = extractFileContent(rawText, action);
          if (!content.trim()) {
            throw new Error('write_file sin contenido (usá los marcadores <<<CONTENIDO … CONTENIDO>>>)');
          }
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
            throw new Error('archivo demasiado grande');
          }
          if (filesWritten >= MAX_FILES_PER_RUN) {
            throw new Error('límite de archivos por corrida alcanzado');
          }
          const target = destino;
          mkdirSync(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, 'utf-8');
          // Se reclama el archivo: de acá en más nadie más lo toca mientras
          // dure esta corrida.
          this.reclamarArchivo(task, String(action.path));
          filesWritten += 1;
          artifacts.add(String(action.path));
          log.push({ step, action: 'write_file', path: action.path, bytes: Buffer.byteLength(content), ok: true });
          lastObservation = `Escribí ${action.path} (${Buffer.byteLength(content)} bytes). Si el entregable ya está completo y usable, respondé finish.`;
          this.emitEvent(companyId, { kind: 'file_written', taskId: task.id, agentId: agent.id, agentName: agent.name, path: String(action.path) });
        } catch (error) {
          log.push({ step, action: 'write_file', path: action.path, ok: false, note: String(error?.message).slice(0, 120) });
          lastObservation = [
            `No pude escribir ${action.path}: ${String(error?.message).slice(0, 160)}`,
            'Repetí la acción con este formato EXACTO, el contenido crudo entre los marcadores:',
            `{"action":"write_file","path":"${action.path}"}`,
            '<<<CONTENIDO',
            '<!doctype html> … el archivo entero …',
            'CONTENIDO>>>'
          ].join('\n');
        }
      } else if (action.action === 'finish') {
        // Antes de dejar cerrar, se MIDE lo que produjo. Los hallazgos vuelven
        // como observación del paso siguiente: el agente los arregla dentro de
        // esta misma corrida, que es cuando todavía tiene el contexto entero.
        // Se hace una sola vez por corrida para no encerrarlo en un bucle.
        // Los nichos móviles entregan una APP que tiene que COMPILAR. Se
        // compila de verdad y los errores del compilador vuelven al agente,
        // igual que los del verificador. Sin esto, "entregué la app" era un
        // texto con forma de app.
        if (!compilado && esProyectoCompilado(goal?.stack) && artifacts.size > 0) {
          compilado = true;
          const build = await construirApp(workspaceDir, goal?.stack);
          if (build && build.ok === false) {
            log.push({ step, action: 'build', ok: false, note: `${build.errores.length} errors` });
            lastObservation = renderBuildReport(build);
            this.emitEvent(companyId, {
              kind: 'build_failed',
              taskId: task.id,
              agentId: agent.id,
              agentName: agent.name,
              count: build.errores.length
            });
            continue;
          }
          if (build?.ok) {
            log.push({ step, action: 'build', ok: true, note: build.apk ? 'APK built and installed' : 'project valid' });
            this.emitEvent(companyId, {
              kind: 'build_ok',
              taskId: task.id,
              agentId: agent.id,
              agentName: agent.name,
              tipo: build.tipo
            });
          } else if (build?.saltado) {
            log.push({ step, action: 'build', note: `not compiled: ${build.motivo}` });
          }
        }

        if (!verificado && artifacts.size > 0) {
          verificado = true;
          const hallazgos = await this.verifyArtifacts(companyId, slug, artifacts);
          if (hallazgos.length > 0) {
            log.push({ step, action: 'verify', note: `${hallazgos.length} findings` });
            ultimaVerificacion = hallazgos;
            lastObservation = renderVerificationReport(hallazgos);
            this.emitEvent(companyId, {
              kind: 'verify_failed',
              taskId: task.id,
              agentId: agent.id,
              agentName: agent.name,
              count: hallazgos.length
            });
            continue;
          }
          log.push({ step, action: 'verify', ok: true, note: 'no findings' });
        }

        const summary = String(action.summary || 'Task done.').slice(0, 500);
        const finalArtifacts = [...new Set([...(action.artifacts || []), ...artifacts])].map(String).slice(0, 20);
        // Si quedaron hallazgos sin resolver, se registran para que el revisor
        // no gaste su atención en lo que la máquina ya detectó.
        const pendientes = verificado ? await this.verifyArtifacts(companyId, slug, artifacts) : [];
        await anotarEnBitacora(workspaceDir, {
          agente: agent.name,
          tarea: task.text,
          resumen: summary,
          pendiente: pendientes.length
            ? pendientes.map((h) => `[${h.archivo}] ${h.que}`).join('; ').slice(0, 300)
            : ''
        });
        this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: finalArtifacts });
        this.store.finishTask(task.id, { status: 'done', summary });
        this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: finalArtifacts });
        this.requestReview(companyId, agent, task, finalArtifacts, pendientes);
        return;
      } else if (action.action === 'block') {
        const reason = String(action.reason || 'Bloqueado.').slice(0, 300);
        this.store.finishWorkRun(runId, { status: 'blocked', summary: reason, log, artifacts: [...artifacts] });
        this.store.finishTask(task.id, { status: 'blocked', blockedReason: reason });
        this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason });
        return;
      } else {
        log.push({ step, action: 'unknown', note: String(action.action).slice(0, 40) });
        lastObservation = `Acción desconocida "${action.action}". Usá list_files, read_file, write_file, finish o block.`;
      }
    }

    // Se acabaron los pasos. Si alcanzó a producir archivos, el trabajo existe
    // y cuenta como hecho (queda la revisión del compañero para juzgarlo);
    // si no produjo nada, ahí sí la tarea queda bloqueada con contexto.
    const produced = [...artifacts];
    if (produced.length > 0) {
      // La validación de la app corría SOLO en el finish, y las corridas
      // terminan casi siempre agotando los pasos: la comprobación se salteaba
      // justo cuando más falta hacía. Un proyecto móvil sin package.json se
      // daba por entregado.
      if (!compilado && esProyectoCompilado(goal?.stack)) {
        const build = await construirApp(workspaceDir, goal?.stack);
        if (build && build.ok === false) {
          const detalle = build.errores.map((e) => `${e.archivo}${e.linea ? `:${e.linea}` : ''}: ${e.que}`).join(' · ').slice(0, 400);
          const queEs = goal?.stack === 'python' ? 'a program that runs' : 'a valid app';
          this.store.finishWorkRun(runId, {
            status: 'blocked',
            summary: `Ran out of steps and what was delivered is not ${queEs}: ${detalle}`,
            log,
            artifacts: produced
          });
          this.store.finishTask(task.id, {
            status: 'blocked',
            blockedReason: goal?.stack === 'python'
              ? `Still needed for the program to compile → ${detalle}`
              : `Still needed for this to be a real app → ${detalle}`
          });
          this.emitEvent(companyId, {
            kind: 'build_failed',
            taskId: task.id,
            agentId: agent.id,
            agentName: agent.name,
            count: build.errores.length
          });
          return;
        }
      }
      const summary = `Delivered ${produced.join(', ')} (ran out of steps before closing the summary).`;
      this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: produced });
      this.store.finishTask(task.id, { status: 'done', summary });
      this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: produced });
      // Se quedó sin pasos: lo que la verificación había encontrado sigue ahí.
      this.requestReview(companyId, agent, task, produced, ultimaVerificacion);
      return;
    }
    // Su archivo YA existe y no lo escribió nadie más en esta corrida: el
    // trabajo estaba hecho antes de empezar (pasó con "definir la paleta"
    // cuando tokens.css ya estaba). Eso no es un bloqueo: es una tarea que
    // llegó tarde, y bloquearla ensuciaba el tablero con fallas que no lo eran.
    if (task.target_file && existsSync(path.join(workspaceDir, task.target_file))) {
      const summary = `${task.target_file} was already written: no need to redo it.`;
      this.store.finishWorkRun(runId, { status: 'ok', summary, log, artifacts: [task.target_file] });
      this.store.finishTask(task.id, { status: 'done', summary });
      this.emitEvent(companyId, { kind: 'task_done', taskId: task.id, agentId: agent.id, agentName: agent.name, summary, artifacts: [task.target_file] });
      return;
    }

    const razon = task.target_file
      ? `Did not manage to write ${task.target_file} in ${MAX_STEPS_PER_RUN} steps.`
      : 'Ran out of steps without producing a file. The task is probably not a deliverable: it may be a decision, a review, or part of someone else\'s file.';
    this.store.finishWorkRun(runId, { status: 'blocked', summary: 'Ran out of steps without producing anything.', log, artifacts: [] });
    this.store.finishTask(task.id, { status: 'blocked', blockedReason: razon });
    this.emitEvent(companyId, { kind: 'task_blocked', taskId: task.id, agentId: agent.id, agentName: agent.name, reason: 'out of steps' });
  }

  // Lee del disco lo que se produjo y lo pasa por el verificador. Se lee del
  // disco y no de memoria a propósito: interesa lo que quedó escrito de verdad,
  // no lo que el agente cree que escribió.
  async verifyArtifacts(companyId, slug, artifacts) {
    const dir = projectDir(companyId, slug);
    const todos = new Map();
    // El proyecto entero, para poder detectar referencias a archivos que no
    // existen; verificar solo lo tocado daría falsos positivos.
    const walk = async (actual, prefijo) => {
      for (const entry of await fs.readdir(actual, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name)) continue;
        const rel = prefijo ? `${prefijo}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(actual, entry.name), rel);
        } else {
          todos.set(rel, null);
        }
      }
    };
    await walk(dir, '');

    // Solo se lee el contenido de lo que esta corrida tocó: el resto ya se
    // verificó cuando lo escribió su autor, y leerlo entero cuesta.
    const aVerificar = new Map();
    for (const rel of todos.keys()) {
      if (artifacts.has(rel)) {
        const texto = await fs.readFile(path.join(dir, rel), 'utf-8').catch(() => null);
        if (texto !== null) {
          aVerificar.set(rel, texto);
        }
      }
    }
    if (aVerificar.size === 0) {
      return [];
    }
    // El listado completo del proyecto viaja aparte para resolver las
    // referencias entre archivos.
    return verifyProject(aVerificar, [...todos.keys()]);
  }

  // ── Consulta entre compañeros ─────────────────────────────────────────
  //
  // Un agente atascado le pregunta a quien sabe y recibe la respuesta con el
  // criterio de esa persona (su oficio, su conocimiento, sus límites). Queda
  // registrada como comentario, así la colaboración es visible y no magia.
  async consultarCompanero(companyId, { quienPregunta, aQuien, pregunta, goal, slug, task }) {
    const texto = String(pregunta || '').trim();
    // La respuesta queda como comentario visible: en inglés si la voz es inglesa.
    const enNote = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
    if (!texto) {
      return { ok: false, nota: 'missing question', observacion: 'Te faltó la pregunta. Usá {"action":"consultar","a":"Nombre","pregunta":"..."}' };
    }

    const equipo = this.store.listAgents({ companyId })
      .filter((a) => a.status === 'active' && a.id !== quienPregunta.id);
    const buscado = String(aQuien || '').toLowerCase().trim();
    // Ojo con el nombre vacío: 'renata'.includes('') es TRUE, así que sin este
    // guard una consulta sin destinatario caía siempre en el primero de la
    // lista en vez de en quien sabe del tema.
    const companero = (buscado && (
      equipo.find((a) => a.name.toLowerCase() === buscado)
      || equipo.find((a) => a.name.toLowerCase().includes(buscado) || buscado.includes(a.name.toLowerCase()))
    ))
      // Sin nombre válido, contesta quien más tenga que ver con la pregunta.
      || this.mejorParaLaPregunta(equipo, texto);

    if (!companero) {
      return {
        ok: false,
        nota: 'person not found',
        observacion: `No hay nadie llamado "${aQuien}" en el equipo. Son: ${equipo.map((a) => a.name).join(', ')}.`
      };
    }

    this.emitEvent(companyId, {
      kind: 'consulta',
      taskId: task.id,
      agentId: companero.id,
      agentName: companero.name,
      dePersona: quienPregunta.name,
      pregunta: texto.slice(0, 200)
    });

    const estado = await leerTokens(projectDir(companyId, slug));
    const prompt = [
      `Sos ${companero.name}, ${companero.title}.`,
      companero.craft ? `Tu oficio: ${companero.craft}` : '',
      companero.knowledge ? `Lo que sabés: ${companero.knowledge}` : '',
      `Tus skills: ${companero.domains.join(', ')}.`,
      '',
      `${quienPregunta.name} (${quienPregunta.title}) está trabajando en "${task.text}" y te consulta:`,
      `"${texto}"`,
      '',
      goal ? `Proyecto: ${goal.title}${goal.brief ? ` — ${goal.brief}` : ''}` : '',
      estado ? `Paleta y medidas acordadas (tokens.css):\n${estado.slice(0, 1500)}` : '',
      '',
      'Contestale como en el pasillo: DIRECTO y accionable, 2 a 4 oraciones.',
      'Si la respuesta es un valor concreto (un color, una medida, un patrón), dalo.',
      'Si no es tu tema, decilo en una línea y sugerí a quién preguntarle.',
      enNote ? 'No greeting, no intro: you already know each other. English.' : 'No saludes, no te presentes: ya se conocen. Español rioplatense.'
    ].filter(Boolean).join('\n');

    let respuesta = '';
    try {
      const { text } = await completeChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `consulta a ${companero.name}`,
        timeoutMs: 60000,
        maxTokens: 700,
        temperature: 0.5,
        messages: [{ role: 'user', content: prompt }]
      });
      respuesta = String(text || '').trim().slice(0, 1200);
    } catch (error) {
      return {
        ok: false,
        nota: 'no answer',
        observacion: `${companero.name} no llegó a contestarte. Resolvelo con tu criterio y seguí.`
      };
    }

    if (!respuesta) {
      return { ok: false, nota: 'empty answer', observacion: `${companero.name} no tenía nada para aportar. Seguí con tu criterio.` };
    }

    // Queda registrado: la colaboración se ve en la Actividad del proyecto.
    this.store.addTaskComment({
      taskId: task.id,
      companyId,
      authorId: companero.id,
      kind: 'consulta',
      text: `${quienPregunta.name} asked: ${texto.slice(0, 300)}\n\n${respuesta}`
    });
    this.emitEvent(companyId, {
      kind: 'consulta_respondida',
      taskId: task.id,
      agentId: companero.id,
      agentName: companero.name,
      dePersona: quienPregunta.name,
      respuesta: respuesta.slice(0, 200)
    });

    return {
      ok: true,
      nota: 'answered',
      observacion: `${companero.name} te contestó:\n${respuesta}\n\nSeguí con tu trabajo teniendo esto en cuenta.`
    };
  }

  // Sin destinatario claro, contesta quien tenga más que ver con la pregunta.
  mejorParaLaPregunta(equipo, pregunta) {
    const palabras = new Set(String(pregunta).toLowerCase().split(/[^\p{L}0-9]+/u).filter((w) => w.length > 3));
    const puntuado = equipo.map((a) => ({
      agente: a,
      puntos: a.domains.filter((d) => palabras.has(String(d).toLowerCase())).length
    })).sort((x, y) => y.puntos - x.puntos);
    return puntuado[0]?.puntos > 0 ? puntuado[0].agente : null;
  }

  // ── Revisión entre compañeros ─────────────────────────────────────────

  // Elige quién revisa: un compañero con skills afines al entregable (no el
  // autor, no el contratista). Si nadie encaja, revisa la CEO.
  pickReviewer(companyId, author, task) {
    const words = new Set(String(task.text || '').toLowerCase().split(/[^\p{L}0-9]+/u).filter((w) => w.length > 3));
    const candidates = this.store.listAgents({ companyId })
      .filter((a) => a.id !== author.id && a.status === 'active' && a.role !== 'contratista');
    if (candidates.length === 0) {
      return null;
    }
    const scored = candidates.map((a) => {
      const overlap = a.domains.filter((d) => words.has(String(d).toLowerCase())).length;
      const qaBoost = /qa|calidad|test/i.test(`${a.title} ${a.domains.join(' ')}`) ? 2 : 0;
      const designBoost = /dise|ux|ui/i.test(`${a.title} ${a.domains.join(' ')}`) && /web|p[áa]gina|landing|sitio|interfaz/i.test(task.text || '') ? 2 : 0;
      return { agent: a, score: overlap * 2 + qaBoost + designBoost + (a.role === 'ceo' ? -1 : 0) };
    }).sort((a, b) => b.score - a.score);
    return scored[0].agent;
  }

  requestReview(companyId, author, task, artifacts, hallazgosPendientes = []) {
    // Solo entregables originales con archivos: las correcciones ya nacen de
    // una revisión y no se vuelven a revisar (evita el ida y vuelta infinito).
    if (task.kind !== 'entregable' || !artifacts.length || task.parent_task_id || task.review_status) {
      return;
    }
    const reviewer = this.pickReviewer(companyId, author, task);
    if (!reviewer) {
      return;
    }
    // Lo que la verificación automática dejó sin resolver se guarda en el
    // comentario del revisor: así el par no vuelve a buscar lo ya medido y se
    // concentra en si CUMPLE lo pedido, que es lo que una máquina no puede ver.
    if (hallazgosPendientes.length) {
      this.store.addTaskComment({
        taskId: task.id,
        companyId,
        authorId: 'verificacion',
        kind: 'nota',
        text: `Automatic verification left ${hallazgosPendientes.length} unresolved point(s):\n• ${
          hallazgosPendientes.map((h) => `[${h.archivo}] ${h.que}`).join('\n• ')}`
      });
    }
    const reviewTaskId = this.store.insertTask(task.meeting_id, reviewer.id, {
      text: `Review ${author.name}'s work: ${task.text}`,
      kind: 'revision',
      parentTaskId: task.id
    });
    this.store.assignTaskToGoal(reviewTaskId, task.goal_id, { kind: 'revision' });
    this.store.setReviewStatus(task.id, 'pendiente', reviewer.id);
    this.emitEvent(companyId, {
      kind: 'review_requested',
      taskId: reviewTaskId,
      targetTaskId: task.id,
      agentId: reviewer.id,
      agentName: reviewer.name,
      authorName: author.name
    });
  }

  async executeReview(companyId, reviewer, task, runId) {
    // El comment queda visible en la tarea: en inglés si la voz es inglesa.
    const enNote = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
    const parent = task.parent_task_id ? this.store.getTask(task.parent_task_id) : null;
    const goal = task.goal_id ? this.store.getGoal(task.goal_id) : null;
    const slug = goal?.slug || 'general';
    const author = parent ? this.store.getAgent(parent.agent_id) : null;

    if (!parent) {
      // Revisión sin trabajo que revisar: no es una falla, es una tarea que
      // llegó antes de tiempo. Se anota y el motor va a crear la revisión real
      // cuando alguien termine su entregable.
      this.store.finishWorkRun(runId, {
        status: 'ok',
        summary: 'Nothing delivered to review yet; noted.',
        log: [],
        artifacts: []
      });
      this.store.finishTask(task.id, { status: 'noted', summary: 'Waiting for something to be delivered.' });
      return;
    }

    // Lee de verdad lo que produjo el compañero (hasta 3 archivos).
    const dir = projectDir(companyId, slug);
    const files = [];
    const walk = async (current, prefix) => {
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
        else files.push(rel);
      }
    };
    await walk(dir, '');

    // Se leen TODOS los archivos hasta agotar un presupuesto, no los 3 primeros
    // que devuelva readdir: revisar solo lo que el sistema de archivos listó
    // primero es azar, no criterio. El principal va primero para que si el
    // presupuesto se acaba, lo que se leyó sea lo que importa.
    const PRESUPUESTO = 60000;
    const orden = [...files].sort((a, b) => {
      const pa = /(^|\/)(index\.html?|PROYECTO\.md|tokens\.css)$/i.test(a) ? 0 : 1;
      const pb = /(^|\/)(index\.html?|PROYECTO\.md|tokens\.css)$/i.test(b) ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
    const contents = [];
    let gastado = 0;
    const omitidos = [];
    for (const rel of orden) {
      if (gastado >= PRESUPUESTO) {
        omitidos.push(rel);
        continue;
      }
      const text = await fs.readFile(path.join(dir, rel), 'utf-8').catch(() => '');
      if (!text) {
        continue;
      }
      const recorte = text.slice(0, PRESUPUESTO - gastado);
      gastado += recorte.length;
      contents.push(`--- ${rel} (${Buffer.byteLength(text)} bytes${recorte.length < text.length ? ', recortado' : ''}) ---\n${recorte}`);
    }
    if (omitidos.length) {
      contents.push(`--- No entraron en el presupuesto de lectura: ${omitidos.join(', ')} ---`);
    }

    // Lo que pidió el usuario, con sus palabras: es contra ESO que se juzga.
    const criterios = goal ? this.store.userRequestForGoal(goal.id).map((t) => `» ${t}`).join('\n') : '';
    // Lo que la máquina ya midió: el revisor no lo vuelve a buscar y usa su
    // atención en lo que una máquina no puede ver (¿cumple lo que se pidió?).
    const yaMedido = this.store.taskComments(parent.id)
      .filter((c) => c.author_id === 'verificacion')
      .map((c) => c.text)
      .join('\n');

    const prompt = [
      `Sos ${reviewer.name}, ${reviewer.title}. Revisás el trabajo de ${author?.name || 'un compañero'} con criterio profesional y honesto.`,
      `Tus skills: ${reviewer.domains.join(', ')}.`,
      reviewer.craft ? `Tu oficio: ${reviewer.craft}` : '',
      goal ? `Proyecto: ${goal.title} — ${goal.brief || goal.description}` : '',
      `Tarea que se le encargó: ${parent.text}`,
      `Lo que dijo que hizo: ${parent.result_summary || '—'}`,
      criterios ? `\nLO QUE PIDIÓ EL USUARIO (juzgá contra esto, no contra tu gusto):\n${criterios}` : '',
      yaMedido
        ? `\nYA LO MIDIÓ LA VERIFICACIÓN AUTOMÁTICA (no lo repitas; dalo por cierto):\n${yaMedido}`
        : '\nLa verificación automática pasó limpia: el HTML cierra, no hay placeholders y los colores salen de los tokens.',
      '',
      files.length ? `Archivos del proyecto: ${JSON.stringify(files.slice(0, 30))}` : 'No hay archivos en el proyecto.',
      contents.length ? `\nCONTENIDO REAL:\n${contents.join('\n\n')}` : '',
      '',
      '',
      'EL PISO DE CALIDAD:',
      // Con el stack: el piso de una app nativa no es el de una página. Sin esto
      // el revisor de un proyecto móvil pedía var(--…) y alt en las imágenes, y
      // marcaba como falla lo que el playbook del nicho manda hacer.
      renderDesignStandard(goal?.stack),
      '',
      'Concentrate en lo que una máquina NO puede ver:',
      '(1) ¿cumple de verdad lo que se pidió, o cumple la letra y no la intención?,',
      '(2) ¿lo interactivo (acordeones, pestañas, formularios) de verdad funciona y no solo lo parece?,',
      '(3) ¿el contenido es específico de esta empresa o es genérico intercambiable?,',
      '(4) ¿algo quedó a medio hacer?',
      'Sé exigente pero justo: aprobá si está bien hecho, pedí cambios SOLO si hay algo concreto que arreglar.',
      '',
      'Respondé SOLO un JSON:',
      enNote
        ? '{"verdict":"aprobado|cambios","comment":"2-4 sentences in English, addressed to the teammate, concrete","issues":["concrete fix 1","concrete fix 2"]}'
        : '{"verdict":"aprobado|cambios","comment":"2-4 oraciones en español, dirigidas al compañero, concretas","issues":["arreglo puntual 1","arreglo puntual 2"]}'
    ].filter(Boolean).join('\n');

    let verdict = 'aprobado';
    let comment = '';
    let issues = [];
    try {
      const { text } = await completeChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `revisión ${reviewer.name}`,
        timeoutMs: STEP_TIMEOUT_MS,
        maxTokens: 4000,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      });
      const parsed = parseJsonFromModel(text) || {};
      verdict = parsed.verdict === 'cambios' ? 'cambios' : 'aprobado';
      comment = String(parsed.comment || '').slice(0, 1200);
      issues = (Array.isArray(parsed.issues) ? parsed.issues : []).map(String).slice(0, 5);
    } catch (error) {
      this.store.finishWorkRun(runId, { status: 'error', summary: 'The review failed.', log: [{ error: String(error?.message || error).slice(0, 200) }], artifacts: [] });
      this.store.finishTask(task.id, task.run_count >= MAX_RUNS_PER_TASK
        ? { status: 'blocked', blockedReason: 'The review could not be completed after several tries.' }
        : { status: 'pending' });
      return;
    }

    if (!comment) {
      comment = verdict === 'aprobado' ? 'Reviewed: meets what was asked.' : 'Reviewed: changes pending.';
    }

    this.store.addTaskComment({
      taskId: parent.id,
      companyId,
      authorId: reviewer.id,
      kind: verdict === 'aprobado' ? 'aprobacion' : 'cambios',
      text: issues.length ? `${comment}\n• ${issues.join('\n• ')}` : comment
    });
    this.store.setReviewStatus(parent.id, verdict, reviewer.id);

    const summary = `${verdict === 'aprobado' ? 'Approved' : 'Requested changes'}: ${comment}`;
    this.store.finishWorkRun(runId, { status: 'ok', summary, log: [{ verdict, issues }], artifacts: [] });
    this.store.finishTask(task.id, { status: 'done', summary });
    this.emitEvent(companyId, {
      kind: 'review_done',
      taskId: task.id,
      targetTaskId: parent.id,
      agentId: reviewer.id,
      agentName: reviewer.name,
      authorName: author?.name || '',
      verdict,
      comment
    });

    // Cambios pedidos: vuelve al autor UNA vez, con la lista concreta.
    if (verdict === 'cambios' && author) {
      const fixText = `Apply ${reviewer.name}'s review on "${parent.text}": ${issues.length ? issues.join('; ') : comment}`;
      const fixId = this.store.insertTask(parent.meeting_id, author.id, {
        text: fixText.slice(0, 900),
        kind: 'entregable',
        parentTaskId: parent.id
      });
      // Hereda el archivo del trabajo original: una corrección toca lo mismo
      // que se corrige. Sin esto quedaba sin archivo, tomaba el proyecto entero
      // y terminaba bloqueada con un mensaje que decía "quizá no sea un
      // entregable" — cuando era exactamente eso.
      this.store.assignTaskToGoal(fixId, parent.goal_id, {
        kind: 'entregable',
        targetFile: parent.target_file || null,
        phase: parent.phase
      });
      this.emitEvent(companyId, {
        kind: 'changes_requested',
        taskId: fixId,
        agentId: author.id,
        agentName: author.name,
        reviewerName: reviewer.name
      });
    }
  }

  // ── Refinamiento: el contratista pule a la gente que ya está ──────────
  //
  // Antes contrataba gente nueva. Ahora su oficio es afinar a los que están:
  // el usuario pide "que Bruno sepa más de accesibilidad" o "quiero a Sofía
  // más directa" y el perfil se ajusta de verdad, con la versión anterior
  // guardada por si hay que volver atrás.

  // A quién refinar: el nombre que aparezca en el pedido y, si no hay
  // ninguno, la persona cuyo oficio esté más cerca de lo pedido.
  pickRefinementTarget(companyId, task) {
    const equipo = this.store.listAgents({ companyId }).filter((a) => a.status === 'active' && a.role !== 'contratista');
    if (equipo.length === 0) {
      return null;
    }
    const texto = String(task.text || '').toLowerCase();
    const nombrado = equipo.find((a) => texto.includes(a.name.toLowerCase()));
    if (nombrado) {
      return nombrado;
    }
    const palabras = new Set(texto.split(/[^\p{L}0-9]+/u).filter((w) => w.length > 3));
    const porAfinidad = equipo
      .map((a) => ({ agente: a, afinidad: a.domains.filter((d) => palabras.has(String(d).toLowerCase())).length }))
      .sort((a, b) => b.afinidad - a.afinidad)[0];
    return porAfinidad && porAfinidad.afinidad > 0 ? porAfinidad.agente : null;
  }

  async executeRefinement(companyId, contratista, task, runId) {
    const company = this.store.getCompany(companyId);
    // El resumen queda visible en la corrida: en inglés si la voz es inglesa.
    const enNote = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
    const objetivo = this.pickRefinementTarget(companyId, task);
    if (!objetivo) {
      const razon = 'Could not tell who to refine: name the person in the request.';
      this.store.finishWorkRun(runId, { status: 'blocked', summary: razon, log: [], artifacts: [] });
      this.store.finishTask(task.id, { status: 'blocked', blockedReason: razon });
      return;
    }

    const prompt = [
      `Sos ${contratista.name}, de talento en ${company ? company.name : 'la empresa'}. No contratás gente nueva: tu trabajo es AFINAR a quien ya está.`,
      '',
      `PEDIDO: ${task.text}`,
      '',
      `PERSONA A REFINAR: ${objetivo.name} — ${objetivo.title}`,
      `Skills actuales: ${objetivo.domains.join(', ')}`,
      `Conocimiento actual: ${objetivo.knowledge || '(vacío)'}`,
      `Oficio actual: ${objetivo.craft || '(vacío)'}`,
      `Estilo actual: ${objetivo.style || '(vacío)'}`,
      `Límites actuales: ${(objetivo.boundaries || []).join(' | ') || '(ninguno)'}`,
      '',
      'Devolvé SOLO los campos que de verdad cambian, en un JSON. Reglas:',
      '- NO cambies el nombre ni el puesto salvo que el pedido lo diga explícitamente.',
      '- "skills" reemplaza la lista entera: incluí las actuales MÁS las nuevas, en minúsculas y sin acentos.',
      '- "knowledge" y "craft": reescribilos completos incorporando lo pedido, sin perder lo que ya sabía.',
      '- Nada de inventar una persona distinta: es la misma, mejor preparada.',
      '',
      enNote
        ? '{"skills":["..."],"knowledge":"...","craft":"...","style":"...","boundaries":["..."],"resumen":"in one sentence, what you changed (English)"}'
        : '{"skills":["..."],"knowledge":"...","craft":"...","style":"...","boundaries":["..."],"resumen":"en una oración, qué le cambiaste"}'
    ].join('\n');

    let patch = null;
    try {
      const { text } = await completeChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `refinamiento ${objetivo.name}`,
        timeoutMs: STEP_TIMEOUT_MS,
        maxTokens: 4000,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }]
      });
      patch = parseJsonFromModel(text);
    } catch {
      this.store.finishWorkRun(runId, { status: 'error', summary: 'The model call failed.', log: [], artifacts: [] });
      this.store.finishTask(task.id, task.run_count >= MAX_RUNS_PER_TASK
        ? { status: 'blocked', blockedReason: 'Could not refine after several tries.' }
        : { status: 'pending' });
      return;
    }

    // Solo se acepta lo que de verdad refina; la identidad no se toca.
    const limpio = {};
    if (Array.isArray(patch && patch.skills) && patch.skills.length) {
      limpio.domains = [...new Set(patch.skills.map((x) => String(x).toLowerCase().trim()).filter(Boolean))].slice(0, 16);
    }
    for (const [campo, tope] of [['knowledge', 2000], ['craft', 2000], ['style', 500]]) {
      if (patch && typeof patch[campo] === 'string' && patch[campo].trim()) {
        limpio[campo] = patch[campo].trim().slice(0, tope);
      }
    }
    if (Array.isArray(patch && patch.boundaries) && patch.boundaries.length) {
      limpio.boundaries = patch.boundaries.map(String).slice(0, 5);
    }

    if (Object.keys(limpio).length === 0) {
      const razon = 'The refinement proposed no concrete change.';
      this.store.finishWorkRun(runId, { status: 'blocked', summary: razon, log: [], artifacts: [] });
      this.store.finishTask(task.id, { status: 'blocked', blockedReason: razon });
      return;
    }

    const skillsAntes = objetivo.domains;
    this.store.updateAgent(objetivo.id, limpio, 'contratista', String(task.text).slice(0, 200));
    const nuevas = (limpio.domains || []).filter((d) => !skillsAntes.includes(d));
    const resumen = String((patch && patch.resumen) || `Tuned ${objetivo.name}'s profile.`).slice(0, 400);

    this.store.finishWorkRun(runId, {
      status: 'ok',
      summary: resumen,
      log: [{ persona: objetivo.name, campos: Object.keys(limpio), skillsNuevas: nuevas }],
      artifacts: []
    });
    this.store.finishTask(task.id, { status: 'done', summary: resumen });
    this.emitEvent(companyId, {
      kind: 'agent_refined',
      taskId: task.id,
      agentId: contratista.id,
      agentName: contratista.name,
      targetId: objetivo.id,
      targetName: objetivo.name,
      skillsNuevas: nuevas,
      summary: resumen
    });
  }
}
