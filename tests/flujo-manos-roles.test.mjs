// Track C (flujo-manos-plan): allow-list por rol + ctx.aprobadoOutreach.
// Fakes puros sobre manos.js; NO importa capabilities.js (lo cablea main).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'manos-roles-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const manos = await import('../server/lib/manos.js');
const { renderManosPrompt, runToolLoop, registerTool, getTool, toolRegistry } = manos;

const EMPRESA = 'acme';
const SLUG = 'roles';
mkdirSync(path.join(TMPWS, EMPRESA, SLUG), { recursive: true });
const SRC = { companyId: EMPRESA, slug: SLUG };

// ---------------------------------------------------------------- prompt

test('prompt filtra por allow (full)', () => {
  const p = renderManosPrompt('text', { allow: ['now'] });
  assert.ok(p.includes('- now:'), 'incluye la permitida');
  // Ojo: el ejemplo de FORMATO menciona read_file literal; lo que filtra
  // es la LISTA de tools (líneas '- nombre:').
  assert.ok(!p.includes('- read_file:'), 'excluye read_file');
  assert.ok(!p.includes('- run_cmd:'), 'excluye run_cmd');
});

test('prompt filtra por allow (audio)', () => {
  const p = renderManosPrompt('audio', { allow: ['now'] });
  assert.ok(p.includes('now'), 'incluye la permitida');
  assert.ok(!p.includes('read_file'), 'excluye read_file');
});

test('prompt allow=null lista todo (conducta histórica)', () => {
  const def = renderManosPrompt();
  const nul = renderManosPrompt('text', { allow: null });
  for (const n of ['read_file', 'write_file', 'run_cmd', 'fetch_url', 'now']) {
    assert.ok(def.includes(n), `default incluye ${n}`);
    assert.ok(nul.includes(n), `allow=null incluye ${n}`);
  }
  assert.equal(nul, def, 'allow=null idéntico al default');
});

// ---------------------------------------------------------------- loop

test('loop rechaza fuera de allow sin ejecutar', async () => {
  let llamadas = 0;
  registerTool({
    name: 'roles_test_espia',
    description: 'test',
    execute: async () => {
      llamadas += 1;
      return { ok: true, output: 'no debería correr' };
    }
  });
  try {
    let n = 0;
    const fake = async () => {
      n += 1;
      if (n === 1) {
        return { text: '```tool:roles_test_espia\n{}\n```\n```tool:now\n{}\n```' };
      }
      return { text: 'listo' };
    };
    const { toolTurns, toolSummary } = await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      completeChat: fake,
      source: SRC,
      allow: ['now'],
      maxTurns: 3,
      deadlineMs: 10000
    });
    assert.equal(toolTurns.length, 1);
    assert.equal(toolTurns[0].calls.length, 2);
    const [bloqueada, permitida] = toolTurns[0].calls;
    assert.equal(bloqueada.tool, 'roles_test_espia');
    assert.equal(bloqueada.ok, false);
    assert.match(bloqueada.error || '', /tool no permitida para tu rol: roles_test_espia/);
    assert.equal(permitida.tool, 'now');
    assert.equal(permitida.ok, true);
    assert.equal(llamadas, 0, 'la bloqueada no se ejecuta');
    assert.match(toolSummary, /roles_test_espia/);
  } finally {
    toolRegistry.delete('roles_test_espia');
  }
});

test('loop allow=null ejecuta todo', async () => {
  let n = 0;
  const fake = async () => {
    n += 1;
    return n === 1 ? { text: '```tool:now\n{}\n```' } : { text: 'listo' };
  };
  const { toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'x' }],
    completeChat: fake,
    source: SRC,
    allow: null,
    maxTurns: 3,
    deadlineMs: 10000
  });
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].calls[0].tool, 'now');
  assert.equal(toolTurns[0].calls[0].ok, true);
});

test('loop sin allow (omitido) ejecuta todo', async () => {
  const t = getTool('now');
  assert.ok(t, 'now registrada');
  let n = 0;
  const fake = async () => {
    n += 1;
    return n === 1 ? { text: '```tool:now\n{}\n```' } : { text: 'listo' };
  };
  const { toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'x' }],
    completeChat: fake,
    source: SRC,
    maxTurns: 2,
    deadlineMs: 10000
  });
  assert.equal(toolTurns[0].calls[0].ok, true);
});

// ---------------------------------------------------------------- ctx.aprobadoOutreach

test('ctx.aprobadoOutreach default false', async () => {
  let visto = 'no-corrido';
  registerTool({
    name: 'roles_test_ctx',
    description: 'test',
    execute: async (_args, ctx) => {
      visto = ctx?.aprobadoOutreach;
      return { ok: true, output: 'ok' };
    }
  });
  try {
    let n = 0;
    const fake = async () => {
      n += 1;
      return n === 1 ? { text: '```tool:roles_test_ctx\n{}\n```' } : { text: 'listo' };
    };
    await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      completeChat: fake,
      source: SRC,
      maxTurns: 2,
      deadlineMs: 10000
    });
    assert.equal(visto, false, 'default false, no undefined');
  } finally {
    toolRegistry.delete('roles_test_ctx');
  }
});

test('ctx.aprobadoOutreach llega desde source y desde top-level', async () => {
  let visto = null;
  registerTool({
    name: 'roles_test_ctx2',
    description: 'test',
    execute: async (_args, ctx) => {
      visto = ctx?.aprobadoOutreach;
      return { ok: true, output: 'ok' };
    }
  });
  const unTurno = (tool) => {
    let n = 0;
    return async () => {
      n += 1;
      return n === 1 ? { text: `\`\`\`tool:${tool}\n{}\n\`\`\`` } : { text: 'listo' };
    };
  };
  try {
    await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      completeChat: unTurno('roles_test_ctx2'),
      source: { ...SRC, aprobadoOutreach: true },
      maxTurns: 2,
      deadlineMs: 10000
    });
    assert.equal(visto, true, 'desde source objeto');
    await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      completeChat: unTurno('roles_test_ctx2'),
      source: 'text',
      companyId: EMPRESA,
      slug: SLUG,
      aprobadoOutreach: true,
      maxTurns: 2,
      deadlineMs: 10000
    });
    assert.equal(visto, true, 'desde top-level con source string');
  } finally {
    toolRegistry.delete('roles_test_ctx2');
  }
});

test('teardown: limpio el workspace temporal', () => {
  rmSync(TMPWS, { recursive: true, force: true });
  assert.ok(true);
});
