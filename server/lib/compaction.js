// F-09: compactación estilo OpenCode — resumen rolling en background.
// Cuando la reunión supera el umbral, un agente resume los turnos viejos
// (fuera de la ventana útil) y el resumen entra al prompt: memoria efectiva
// infinita con contexto acotado. Los turnos crudos se conservan (auditoría;
// dreaming los purga cuando hay resumen final).

export const COMPACT_THRESHOLD_TURNS = 120;
export const COMPACT_KEEP_LAST = 40;
export const COMPACT_BATCH = 60;
export const COMPACT_SUMMARY_MAX = 4000;

export function needsCompaction(store, meetingId) {
  try {
    const meeting = store.getMeeting(meetingId);
    if (!meeting) {
      return false;
    }
    const total = Number(meeting.turn_count) || 0;
    const compacted = Number(meeting.compacted_turns) || 0;
    return total - compacted >= COMPACT_THRESHOLD_TURNS;
  } catch {
    return false;
  }
}

function foldSummary(prev, batchText) {
  return `${prev}\n\n${batchText}`.trim().slice(-COMPACT_SUMMARY_MAX * 2);
}

// Compacta UN batch. completeChat: async ({messages}) → {text} (inyectado).
export async function compactOnce({ store, meetingId, completeChat, keepLast = COMPACT_KEEP_LAST } = {}) {
  if (!store || !meetingId) {
    throw new Error('compactOnce necesita {store, meetingId}');
  }
  if (typeof completeChat !== 'function') {
    throw new Error('compactOnce necesita completeChat');
  }
  const meeting = store.getMeeting(meetingId);
  if (!meeting) {
    return { compacted: false, reason: 'sin reunión' };
  }
  const compacted = Number(meeting.compacted_turns) || 0;
  const total = Number(meeting.turn_count) || 0;
  const cutoff = total - keepLast;
  if (cutoff - compacted < 20) {
    return { compacted: false, reason: 'poco para compactar' };
  }
  // Ventana a resumir: [compacted, cutoff) sin invadir keepLast.
  const limit = Math.min(COMPACT_BATCH, cutoff - compacted);
  const rows = store._prepare(`
    SELECT id, speaker, text FROM turns WHERE meeting_id = ?
    ORDER BY id ASC LIMIT ? OFFSET ?
  `).all(meetingId, limit, compacted);
  if (rows.length < 20) {
    return { compacted: false, reason: 'poco para compactar' };
  }
  const batchText = rows.map((r) => `${r.speaker}: ${r.text}`).join('\n').slice(0, 12000);
  const prev = String(meeting.compacted_summary || '');
  const out = await completeChat({
    scope: 'compactacion',
    maxTokens: 1200,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        'Resumí esta parte vieja de una reunión en ≤1500 chars: decisiones, datos, pendientes. Si hay RESUMEN PREVIO, fusionalo (no lo repitas, actualizalo). Solo hechos, sin formato.',
        prev ? `RESUMEN PREVIO:\n${prev.slice(0, 3000)}` : '(sin resumen previo)',
        `TURNOS:\n${batchText}`
      ].join('\n\n')
    }]
  });
  const text = typeof out === 'string' ? out : String(out?.text || '').trim();
  if (!text) {
    return { compacted: false, reason: 'resumen vacío' };
  }
  const merged = foldSummary(prev ? prev : '', text).slice(-COMPACT_SUMMARY_MAX);
  store._prepare('UPDATE meetings SET compacted_summary = ?, compacted_turns = ? WHERE id = ?')
    .run(merged, compacted + rows.length, meetingId);
  // A-04: espejo en disco (re-inyección garantizada si la DB se pierde).
  try {
    const companyId = meeting.company_id || 'local';
    let slug = 'general';
    try {
      const goal = meeting.goal_id ? store.getGoal(meeting.goal_id) : null;
      slug = goal?.slug || 'general';
    } catch {}
    persistCompactToDisk({ companyId, slug, meetingId, summary: merged });
  } catch {}
  return { compacted: true, turns: rows.length, through: compacted + rows.length };
}

export function renderCompactSection(summary, { english = false } = {}) {
  const s = String(summary || '').trim();
  if (!s) {
    return '';
  }
  const head = english
    ? 'ROLLED-UP CONTEXT (older turns, summarized):'
    : 'CONTEXTO COMPACTADO (turnos viejos, resumidos):';
  return `${head}\n${s.slice(0, COMPACT_SUMMARY_MAX)}`;
}

// A-04: compactación DIRIGIDA (rango explícito, no solo rolling) +
// re-inyección garantizada desde disco (workspace/memoria).
import { mkdirSync as mkdirSyncCompact, readFileSync as readFileSyncCompact, writeFileSync as writeFileSyncCompact } from 'node:fs';
import { join as joinCompact } from 'node:path';

export function compactFilePath(companyId, slug, meetingId, wsRoot = null) {
  const root = wsRoot || process.env.WORKSPACE_ROOT || '/tmp/equipo-workspace';
  const safe = (s) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return joinCompact(root, safe(companyId), safe(slug || 'general'), 'memoria', `compact-${safe(meetingId)}.md`);
}

export function persistCompactToDisk({ companyId, slug, meetingId, summary, wsRoot = null }) {
  const file = compactFilePath(companyId, slug, meetingId, wsRoot);
  mkdirSyncCompact(joinCompact(file, '..'), { recursive: true });
  writeFileSyncCompact(file, `# Compact ${meetingId}\n\n${String(summary || '')}\n`, 'utf-8');
  return file;
}

export function loadCompactFromDisk({ companyId, slug, meetingId, wsRoot = null }) {
  try {
    const content = readFileSyncCompact(compactFilePath(companyId, slug, meetingId, wsRoot), 'utf-8');
    return content.replace(/^# Compact .*\n\n/, '').trim() || null;
  } catch {
    return null;
  }
}

// Re-inyección garantizada: si la DB perdió el resumen pero el disco lo
// tiene, se restaura. Devuelve el resumen efectivo (DB > disco > '').
export function effectiveCompactSummary({ store, meetingId, companyId = null, slug = null, wsRoot = null }) {
  try {
    const db = String(store?.getMeeting?.(meetingId)?.compacted_summary || '').trim();
    if (db) {
      return db;
    }
  } catch { /* sigue a disco */ }
  const disk = loadCompactFromDisk({ companyId, slug, meetingId, wsRoot });
  if (disk) {
    try {
      store?._prepare?.('UPDATE meetings SET compacted_summary = ? WHERE id = ?').run(disk, meetingId);
    } catch { /* best-effort */ }
    return disk;
  }
  return '';
}

// Compactación dirigida: resume turnos [fromId, throughId] explícitos.
export async function compactDirected({ store, meetingId, completeChat, throughId = null, maxTurns = 60 } = {}) {
  if (!store || !meetingId) {
    throw new Error('compactDirected necesita {store, meetingId}');
  }
  if (typeof completeChat !== 'function') {
    throw new Error('compactDirected necesita completeChat');
  }
  const meeting = store.getMeeting(meetingId);
  if (!meeting) {
    return { compacted: false, reason: 'sin reunión' };
  }
  const rows = store._prepare(`
    SELECT id, speaker, text FROM turns WHERE meeting_id = ?
    ${throughId ? 'AND id <= ?' : ''} ORDER BY id DESC LIMIT ?
  `).all(...(throughId ? [meetingId, throughId, maxTurns] : [meetingId, maxTurns])).reverse();
  if (rows.length < 5) {
    return { compacted: false, reason: 'poco para compactar' };
  }
  const batchText = rows.map((r) => `${r.speaker}: ${r.text}`).join('\n').slice(0, 12000);
  const out = await completeChat({
    scope: 'compactacion-dirigida',
    maxTokens: 1200,
    temperature: 0,
    messages: [{ role: 'user', content: `Resumí estos turnos en ≤1500 chars (decisiones, datos, pendientes). Solo hechos.\n\n${batchText}` }]
  });
  const text = typeof out === 'string' ? out : String(out?.text || '').trim();
  if (!text) {
    return { compacted: false, reason: 'resumen vacío' };
  }
  const prev = String(meeting.compacted_summary || '');
  const merged = `${prev}\n\n${text}`.trim().slice(-COMPACT_SUMMARY_MAX);
  store._prepare('UPDATE meetings SET compacted_summary = ? WHERE id = ?').run(merged, meetingId);
  return { compacted: true, turns: rows.length, throughId: rows[rows.length - 1].id };
}
