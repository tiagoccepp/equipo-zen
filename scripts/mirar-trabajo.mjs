// Mira cómo avanza un proyecto mientras el equipo trabaja. Sirve para ver de
// verdad qué entregan, en vez de suponerlo.
//
//   node scripts/mirar-trabajo.mjs <titulo-del-proyecto> [minutos]

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const titulo = process.argv[2];
const minutos = Number(process.argv[3] || 6);
const db = new DatabaseSync('server/data/meetings.db');

const g = db.prepare('SELECT * FROM goals WHERE title = ? ORDER BY created_at DESC LIMIT 1').get(titulo);
if (!g) {
  console.error(`No encontré un proyecto llamado "${titulo}"`);
  process.exit(1);
}
const dir = path.join('workspace', g.company_id, g.slug || 'general');
console.log(`proyecto ${g.id} · ${dir} · stack ${g.stack}\n`);

function archivos(base, prefijo = '') {
  const out = [];
  let entradas = [];
  try {
    entradas = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entradas) {
    if (e.name.startsWith('.') || ['node_modules', 'build', '.gradle', 'dist', '.expo'].includes(e.name)) continue;
    const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...archivos(path.join(base, e.name), rel));
    } else {
      let size = 0;
      try { size = statSync(path.join(base, e.name)).size; } catch {}
      out.push({ rel, size });
    }
  }
  return out;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const vueltas = Math.ceil((minutos * 60) / 12);

for (let i = 1; i <= vueltas; i += 1) {
  const estados = db.prepare('SELECT status, COUNT(*) c FROM tasks WHERE goal_id = ? GROUP BY status').all(g.id);
  const resumen = estados.map((x) => `${x.status}:${x.c}`).join(' ') || 'sin tareas';
  const fs = archivos(dir);
  console.log(`  ${String(i * 12).padStart(4)}s · ${resumen.padEnd(40)} · ${fs.length} archivos`);

  if (!estados.some((x) => x.status === 'pending' || x.status === 'in_progress')) {
    console.log('\n  ── el equipo terminó ──');
    break;
  }
  await dormir(12000);
}

console.log('\n=== LO QUE ENTREGARON ===');
for (const f of archivos(dir)) {
  console.log(`  ${String(f.size).padStart(8)} bytes  ${f.rel}`);
}

console.log('\n=== TAREAS ===');
for (const t of db.prepare('SELECT t.*, a.name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.goal_id = ? ORDER BY t.created_at').all(g.id)) {
  console.log(`  ${(t.name || '?').padEnd(10)} ${t.kind.padEnd(12)} ${t.status.padEnd(11)} ${String(t.target_file || '—').padEnd(26)} ${String(t.text).slice(0, 40)}`);
  if (t.blocked_reason) console.log(`      ↳ ${t.blocked_reason}`);
}

console.log('\n=== CORRIDAS ===');
for (const r of db.prepare('SELECT w.*, a.name FROM work_runs w LEFT JOIN agents a ON a.id = w.agent_id WHERE w.company_id = ? ORDER BY w.id').all(g.company_id)) {
  const log = JSON.parse(r.log_json || '[]');
  const cuenta = {};
  for (const s of log) cuenta[s.action] = (cuenta[s.action] || 0) + 1;
  console.log(`  ${r.name} · ${r.status} · ${JSON.stringify(cuenta)}`);
  if (r.summary) console.log(`      ${String(r.summary).slice(0, 140)}`);
  for (const s of log) {
    if (s.action === 'comando') console.log(`      $ ${String(s.path || '').slice(0, 90)} ${s.ok ? '✓' : '✗'}`);
  }
}
db.close();
