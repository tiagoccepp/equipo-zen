// M-08: subagente Explore read-only — investiga el workspace/proyecto SIN
// escribir nada. Enforcement a nivel harness (allow-list): aunque el modelo
// pida escribir, el loop lo rechaza. Cero riesgo, ideal para delegar
// reconocimiento antes de actuar.

import { runToolLoop } from './manos.js';

// Solo lectura + clock. run_cmd NO (el shell escribe), fetch_url SÍ (GET).
export const EXPLORE_ALLOW = ['read_file', 'list_files', 'fetch_url', 'now'];

const EXPLORE_SYSTEM = `Sos Explore, un investigador read-only. Respondés preguntas sobre el proyecto LEYENDO archivos (read_file, list_files), consultando la web si hace falta (fetch_url) y reportando hallazgos.

REGLAS DURAS:
- NUNCA escribís, modificás, borrás ni ejecutás nada. Tus tools de escritura están bloqueadas a nivel sistema: si las pedís, se rechazan.
- Sé exhaustivo pero eficiente: empezá por lo general (listar) y bajá a lo específico (leer).
- Tu respuesta final es un REPORTE: hallazgos + rutas exactas + qué falta averiguar. Sin rodeos.`;

export function exploreSystem(extra = '') {
  return extra ? `${EXPLORE_SYSTEM}\n\n${extra}` : EXPLORE_SYSTEM;
}

// Corre una exploración. Devuelve { summary, calls, files } — files son las
// rutas tocadas (para auditoría). Nunca lanza por contenido (solo sin completeChat).
export async function explore({
  question,
  completeChat,
  companyId = null,
  slug = 'general',
  turnId = null,
  agentId = null,
  signal = null,
  maxTurns = 6,
  deadlineMs = 90000,
  extraSystem = ''
} = {}) {
  if (typeof completeChat !== 'function') {
    throw new Error('explore necesita completeChat(messages)');
  }
  const q = String(question || '').trim();
  if (!q) {
    throw new Error('explore necesita una pregunta');
  }
  const outcome = await runToolLoop({
    system: exploreSystem(extraSystem),
    messages: [{ role: 'user', content: q }],
    completeChat,
    source: { companyId, slug, turnId, agentId, aprobadoOutreach: false },
    allow: EXPLORE_ALLOW,
    maxTurns,
    deadlineMs,
    companyId,
    slug,
    turnId,
    agentId,
    signal
  });
  const calls = (outcome.toolTurns || []).flatMap((t) => t?.calls || []);
  const files = [];
  for (const c of calls) {
    const m = String(c.summary || '').match(/[\w./-]+\.[a-z0-9]+/i);
    if (m && !files.includes(m[0])) {
      files.push(m[0]);
    }
  }
  return {
    summary: outcome.toolSummary,
    calls: calls.map((c) => ({ tool: c.tool, ok: c.ok })),
    files,
    readOnly: true
  };
}
