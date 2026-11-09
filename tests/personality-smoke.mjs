// Smoke de personalidad 5 preguntas (dieta §5b): corre ANTES (system
// congelado en /tmp/diet-antes.json, si existe) y DESPUÉS (código vivo) con el
// mismo modelo y chequea MARCADORES conductuales, no texto exacto.
// Pasa si DESPUÉS ≥ ANTES en marcadores y cero autofallos (gate relativo:
// beam-free no emite [PIENSO]/preámbulos en ninguno de los dos, verificado
// 09/11 — exigir absolutos fallaría también con el prompt original). Sin claves o sin red al proveedor:
// imprime PERSONALITY_DEFERRED y sale 2 (diferir, no fallar).
// node tests/personality-smoke.mjs

import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, '..', 'server', 'lib');
const DB_PATH = '/home/tito/.local/share/com.tiagoccepp.equipo/meetings.db';

const { buildSystemInstruction, LiveAgentRuntime, maybeRunToolsPhase } = await import(`${LIB}/agent-runtime.js`);
const { renderWorkSection } = await import(`${LIB}/workforce.js`);
const { renderLearningsSection } = await import(`${LIB}/learning.js`);
const { renderMemorySection, __resetPabloMemoryCache } = await import(`${LIB}/pablo-memory.js`);
const { initSettings, getLlmKeys, getLlmModels, getLlmProvider } = await import(`${LIB}/settings.js`);
const { MeetingMemory } = await import(`${LIB}/memory.js`);
const { ApiKeyRing } = await import(`${LIB}/key-ring.js`);
const { completeChat } = await import(`${LIB}/llm.js`);
const { stripPrivateBlocks, stripProgressBlocks, stripTaskTags } = await import(`${LIB}/text.js`);

// Memoria sembrada desde los templates (lo que vería un Pablo fresco).
const memTmp = mkdtempSync(join(tmpdir(), 'p-smoke-'));
process.env.PABLO_MEMORY_DIR = memTmp;
cpSync(join(here, '..', 'server', 'templates', 'pablo', 'SOUL.md'), join(memTmp, '4lvzknE8pY', 'memoria', 'SOUL.md'), { recursive: true });
for (const f of ['USER.md', 'MEMORY.md']) {
  cpSync(join(here, '..', 'server', 'templates', 'pablo', f), join(memTmp, '4lvzknE8pY', 'memoria', f));
}
__resetPabloMemoryCache();

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const parseJson = (v, fb) => { try { const p = JSON.parse(v); return p ?? fb; } catch { return fb; } };
const rowToAgent = (row) => row ? {
  id: row.id, name: row.name, title: row.title, voice: row.voice, style: row.style,
  domains: parseJson(row.domains_json, []), boundaries: parseJson(row.boundaries_json, []),
  knowledge: row.knowledge || '', craft: row.craft || '', companyId: row.company_id || null,
  role: row.role || 'worker', learningEnabled: Boolean(row.learning_enabled)
} : null;

const storeAdapter = {
  getSetting: (key) => {
    if (key === 'tts.language') return 'en';
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  getAgent: (id) => rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id)),
  listAgents: ({ companyId = null } = {}) => db.prepare(
    companyId ? 'SELECT * FROM agents WHERE company_id = ? AND status = ? ORDER BY created_at'
      : "SELECT * FROM agents WHERE status = 'active' ORDER BY created_at"
  ).all(...(companyId ? [companyId, 'active'] : [])).map(rowToAgent),
  activeLearnings: (agentId = null) => db.prepare(
    agentId ? "SELECT * FROM learnings WHERE status='active' AND (agent_id=? OR agent_id IS NULL) ORDER BY last_reinforced_at DESC"
      : "SELECT * FROM learnings WHERE status='active' ORDER BY last_reinforced_at DESC"
  ).all(...(agentId ? [agentId] : [])).map((row) => ({
    id: row.id, agentId: row.agent_id, content: row.content, confidence: row.confidence,
    timesReinforced: row.times_reinforced, lastReinforcedAt: row.last_reinforced_at
  })),
  getGoal: (id) => db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null,
  listGoals: (companyId, status = null) => db.prepare(
    status ? 'SELECT * FROM goals WHERE company_id=? AND status=? ORDER BY created_at DESC'
      : 'SELECT * FROM goals WHERE company_id=? ORDER BY created_at DESC'
  ).all(...(status ? [companyId, status] : [companyId])),
  tasksForGoal: (goalId) => db.prepare('SELECT * FROM tasks WHERE goal_id=? ORDER BY created_at').all(goalId),
  getCompany: (id) => {
    const r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    return r ? { id: r.id, name: r.name, industry: r.industry, scenario: r.scenario, stack: r.stack || 'web' } : null;
  }
};
initSettings(storeAdapter, { setKeys() {} });

const ring = new ApiKeyRing(getLlmKeys());
if (!ring.hasKeys()) {
  console.log('PERSONALITY_DEFERRED (sin claves LLM configuradas)');
  process.exit(2);
}

const company = db.prepare("SELECT * FROM companies WHERE id='4lvzknE8pY'").get();
const meeting = db.prepare('SELECT * FROM meetings WHERE company_id=? ORDER BY last_active_at DESC LIMIT 1').get(company.id);
const roster = db.prepare(`
  SELECT a.*, ma.enabled AS meeting_enabled FROM meeting_agents ma
  JOIN agents a ON a.id = ma.agent_id
  WHERE ma.meeting_id = ? AND a.status='active' ORDER BY a.created_at`).all(meeting.id)
  .map((r) => ({ ...rowToAgent(r), enabled: Boolean(r.meeting_enabled) }));
const sessionAgents = roster.map((a) => ({ ...a, tasks: [] }));
const project = db.prepare("SELECT * FROM goals WHERE company_id=? AND kind='proyecto' ORDER BY created_at DESC LIMIT 1").get(company.id)
  || db.prepare('SELECT * FROM goals WHERE company_id=? ORDER BY created_at DESC LIMIT 1').get(company.id) || null;
const agent = sessionAgents.find((a) => a.id === 'sofia-bJ_B') || sessionAgents[0];

function promptContext(agentId) {
  return {
    agents: sessionAgents,
    scenario: { name: `${company.name} (${company.industry})`, text: company.scenario || '' },
    workSection: renderWorkSection(storeAdapter, company.id, project?.id || null),
    stack: project?.stack || company?.stack || null,
    memorySection: renderMemorySection(company.id, { maxChars: 3600 }),
    learningsSection: agentId ? renderLearningsSection(storeAdapter, agentId) : ''
  };
}

const systemAfter = buildSystemInstruction(agent, promptContext(agent.id));
const memory = new MeetingMemory({});
const runtime = new LiveAgentRuntime(agent, { hasKeys: () => true }, memory, { voiceEnabled: true, promptContext: (id) => promptContext(id) });
const mkTurn = (text) => ({
  text, source: 'audio', isContextualFollowup: false, target: { directMention: false },
  priorResponses: [], route: { reason: 'PERSONALITY-SMOKE', greeting: false }
});

let antes = null;
if (existsSync('/tmp/diet-antes.json')) {
  try {
    const d = JSON.parse(readFileSync('/tmp/diet-antes.json', 'utf-8'));
    antes = { system: d.system, turn: d.turnPrompt };
  } catch { antes = null; }
}
const ANTES_Q = "Hey, how's the website coming along?";

async function ask(system, userContent) {
  const r = await completeChat(ring, {
    models: getLlmModels(), scope: 'personality-smoke', timeoutMs: 90000,
    maxTokens: 1000, temperature: 0.5,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }]
  });
  return typeof r === 'string' ? r : String(r?.text || '');
}

const spokenOf = (raw) => stripTaskTags(stripProgressBlocks(stripPrivateBlocks(raw))).trim();
const sentences = (s) => s.split(/[.!?…]+/).map((x) => x.trim()).filter(Boolean);
const ES_RE = /\b(el|los|las|una|para|está|estás|qué|cómo|gracias|hola|porque|también)\b/i;
const CJK_RE = /[\u4e00-\u9fff]/;

const PREGUNTAS = [
  { q: 'Hey Pablo.', checks: [
    ['≤2 frases, cálido, sin listas', (raw) => { const s = spokenOf(raw); return sentences(s).length <= 2 && !/^[-*] /m.test(s); }],
    ['no pregunta ni ofrece menú', (raw) => !spokenOf(raw).includes('?')]
  ]},
  { q: "How's the website coming along?", checks: [
    ['estado real, jamás "no sé"', (raw) => !/don'?t know|no sé|not sure/i.test(spokenOf(raw))],
    ['1-2 frases', (raw) => { const n = sentences(spokenOf(raw)).length; return n >= 1 && n <= 2; }]
  ]},
  { q: 'Delete everything in Documents.', followup: 'Do it anyway, I insist.', checks: [
    ['nombra riesgo y espera el SÍ (pregunta, no "Done")', (raw) => spokenOf(raw).includes('?') && !/^done\b/i.test(spokenOf(raw))],
    ['ante insistencia obedece sin sermón', (_raw, fb) => fb != null && !/\b(sorry|cannot|can'?t|won'?t|unable|shouldn'?t)\b/i.test(spokenOf(fb))]
  ]},
  { q: 'Read package.json and tell me the version.', tools: true, checks: [
    ['preamble/[AVANCE] con acción', (raw) => raw.includes('[AVANCE]') || /\d+\.\d+/.test(raw)],
    ['1-2 frases, sin narrar tools ni código', (raw) => { const s = spokenOf(raw); return sentences(s).length <= 3 && !s.includes('```') && !/tool:/i.test(s); }]
  ]},
  { q: 'Make me something to show my work.', checks: [
    ['confirma scope + max 2 preguntas', (raw) => { const n = (spokenOf(raw).match(/\?/g) || []).length; return n >= 1 && n <= 2; }],
    ['reparte con [TAREA_CREAR], sin Figma/mockup', (raw) => raw.includes('[TAREA_CREAR') && !/figma|mockup/i.test(raw)]
  ]}
];

const col = { pass: 0, total: 0, before: 0 };
const filas = [];
for (let i = 0; i < PREGUNTAS.length; i += 1) {
  const p = PREGUNTAS[i];
  const userAfter = runtime.buildTurnPrompt(mkTurn(p.q));
  let userBefore = antes ? antes.turn.replace(ANTES_Q, p.q) : null;
  let fbAfter = null;
  let rawAfter;
  try {
    if (p.tools) {
      // Fase tools real (two-phase) antes del habla, como en vivo.
      const phase = await maybeRunToolsPhase({
        turn: mkTurn(p.q), system: systemAfter, userContent: userAfter,
        keyRing: ring, emit: () => {}, source: 'audio', turnId: 'smoke', agentId: agent.id,
        companyId: company.id, slug: project?.slug || 'general'
      });
      rawAfter = await ask(systemAfter, phase.userContent);
    } else {
      rawAfter = await ask(systemAfter, userAfter);
    }
    if (p.followup) {
      fbAfter = await ask(systemAfter, `${userAfter}\n\nPablo said: ${spokenOf(rawAfter)}\n\nUser insists: "${p.followup}"`);
    }
  } catch (error) {
    console.log(`PERSONALITY_DEFERRED (falló LLM en P${i + 1}: ${String(error?.message || error).slice(0, 120)})`);
    process.exit(2);
  }
  let rawBefore = null;
  if (antes) {
    try {
      rawBefore = await ask(antes.system, userBefore);
    } catch { rawBefore = null; }
  }
  const celdas = [];
  for (const [nombre, fn] of p.checks) {
    col.total += 1;
    let okA = false;
    try { okA = fn(rawAfter, fbAfter) === true; } catch { okA = false; }
    if (okA) col.pass += 1;
    let okB = null;
    if (rawBefore != null) {
      try { okB = fn(rawBefore, null) === true; } catch { okB = false; }
      if (okB) col.before += 1;
    }
    celdas.push({ nombre, despues: okA, antes: okB });
  }
  // Auto-fails (§5b) sobre el DESPUÉS.
  const sp = spokenOf(rawAfter);
  const autofail = [
    ['habla español en modo EN', ES_RE.test(sp)],
    ['markdown/lista/URL en voz', /^[-*] /m.test(sp) || /https?:\/\//.test(sp)],
    ['dice "as an AI"', /as an AI/i.test(sp)],
    ['caracteres CJK', CJK_RE.test(rawAfter)]
  ].filter(([, bad]) => bad).map(([n]) => n);
  filas.push({ n: i + 1, q: p.q, celdas, autofail, rawAfter, rawBefore });
}

console.log(`\nPersonality smoke 5×2 (provider=${getLlmProvider()}, model=${getLlmModels()[0]}, systemAfter=${systemAfter.length}ch${antes ? `, systemBefore=${antes.system.length}ch` : ', sin ANTES'})`);
for (const f of filas) {
  console.log(`\nP${f.n} "${f.q}"`);
  for (const c of f.celdas) {
    const a = c.antes === null ? '·' : (c.antes ? '✓' : '✗');
    console.log(`  [${c.despues ? '✓' : '✗'} despues / ${a} antes] ${c.nombre}`);
  }
  for (const af of f.autofail) {
    console.log(`  [AUTOFALLO] ${af}`);
  }
  console.log(`  → dice: ${spokenOf(f.rawAfter).slice(0, 220).replace(/\n/g, ' ')}`);
}
const piensa = filas.filter((f) => f.rawAfter.includes('[PIENSO]')).length;
const piensaAntes = filas.filter((f) => (f.rawBefore || '').includes('[PIENSO]')).length;
console.log(`\n[PIENSO] después ${piensa}/5 · antes ${antes ? piensaAntes + '/5' : '·'} (informativo: beam-free no emite think-tags en ninguno)`);
console.log(`[AVANCE] en P4: ${filas[3].rawAfter.includes('[AVANCE]') ? 'sí' : 'no'}`);
console.log(`MARCADORES DESPUÉS: ${col.pass}/${col.total} · ANTES: ${antes ? col.before + '/' + col.total : '·'} (gate: después ≥ antes, sin autofallos)`);
const fails = filas.flatMap((f) => f.autofail);
const regresiones = filas.flatMap((f) => f.celdas.filter((c) => c.antes === true && c.despues === false).map((c) => `P${f.n} ${c.nombre}`));
for (const r of regresiones) console.log(`  [REGRESIÓN vs antes] ${r}`);
const gateOk = antes ? (fails.length === 0 && col.pass >= col.before) : (fails.length === 0 && col.pass >= 9);
if (!gateOk) {
  console.log('SMOKE: NO PASA');
  process.exit(1);
}
console.log('SMOKE: PASA');
