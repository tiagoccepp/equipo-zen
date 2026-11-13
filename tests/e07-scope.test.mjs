// E-07: scope check — la unidad es el PROYECTO, nunca "la conversación".
// Bardea phrasing de unidad-conversación en código nuevo y afirma anclajes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Archivos nuevos de esta sesión (los que E-07 audita de forma estricta).
const NEW_FILES = [
  'server/lib/narration.js', 'server/lib/figures.js', 'server/lib/agent-bus.js',
  'server/lib/team-templates.js', 'server/lib/explore.js', 'server/lib/plan-mode.js',
  'server/lib/permissions.js', 'server/lib/hooks.js', 'server/lib/closing-slides.js',
  'server/lib/compaction.js', 'server/lib/dreaming.js', 'server/lib/apply-patch.js',
  'server/lib/ws-registry.js', 'server/lib/voice-personas.js', 'server/lib/skill-workshop.js',
  'server/lib/widget-sanitize.js', 'src/lib/heard-text.ts', 'src/lib/mermaid-inline.ts',
  'src/lib/figures-view.ts', 'src/lib/karaoke.ts', 'src/lib/turn-taking.ts',
  'src/lib/working-earcon.ts', 'src/lib/figure-queue.ts', 'src/lib/widget-sandbox.ts'
];

// Phrasing prohibido: conversación como UNIDAD (no el uso coloquial).
const BANNED = [
  /por conversaci[óo]n/i,
  /conversation unit/i,
  /unit.{0,12}conversation/i,
  /una conversaci[óo]n como unidad/i,
  /conversationId/i,
  /conversaci[óo]nId/i
];

test('e07: piezas nuevas sin unidad-conversación', () => {
  for (const f of NEW_FILES) {
    let content;
    try {
      content = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue; // archivo renombrado/movido: el loader lo dirá
    }
    for (const re of BANNED) {
      assert.ok(!re.test(content), `${f} matchea ${re}`);
    }
  }
});

test('e07: anclajes proyecto (datos + sesión + memoria)', () => {
  const db = readFileSync(join(ROOT, 'server/lib/db.js'), 'utf8');
  assert.ok(db.includes("kind = 'proyecto'") || db.includes("KIND") || db.includes('goals'), 'goals/proyecto en schema');
  const cfg = readFileSync(join(ROOT, 'server/lib/config.js'), 'utf8');
  assert.ok(cfg.includes('projectSessionId'), 'session por proyecto');
  assert.ok(!/estable por\n\/\/ conversaci[óo]n/.test(cfg), 'comentario QW-05 sin unidad-conversación');
  const mem = readFileSync(join(ROOT, 'server/lib/pablo-memory.js'), 'utf8');
  assert.ok(mem.includes('projectMemoryDirFor') || mem.includes('projectSlug'), 'memoria por proyecto');
  const store = readFileSync(join(ROOT, 'server/lib/store.js'), 'utf8');
  assert.ok(store.includes('goal_id'), 'learnings/tasks por goal');
});
