// Tests Manos v1: parse, gate, registry, tools con workspace temporal,
// loop con modelo fake. Sin red externa: fetch usa stub HTTP local.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Sin proxy: Undici routea hasta 127.0.0.1 por el proxy del gateway y el
// stub local muere con 403. Los tests no usan red externa igual.
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

// El workspace se resuelve por env al importar workforce: hay que fijarlo
// ANTES del import dinámico. Cada proceso de test tiene su tmpdir.
const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'manos-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const manos = await import('../server/lib/manos.js');
const { clasificarComando } = await import('../server/lib/herramientas.js');

const {
  parseToolCalls,
  renderManosPrompt,
  shouldUseTools,
  runToolLoop,
  registerTool,
  getTool,
  listTools,
  toolRegistry,
  truncarSalida
} = manos;

const EMPRESA = 'acme';
const SLUG = 'demo';

function asegurarProyecto() {
  mkdirSync(path.join(TMPWS, EMPRESA, SLUG), { recursive: true });
}
asegurarProyecto();

const ctx = { companyId: EMPRESA, slug: SLUG };

// ---------------------------------------------------------------- parse

test('parse: una llamada', () => {
  const calls = parseToolCalls('```tool:read_file\n{"path": "a.txt"}\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].args, { path: 'a.txt' });
  assert.equal(calls[0].error, undefined);
});

test('parse: varias llamadas en un mensaje', () => {
  const calls = parseToolCalls([
    'Leo dos cosas:',
    '```tool:read_file',
    '{"path": "a.txt"}',
    '```',
    'y',
    '```tool:now',
    '{}',
    '```'
  ].join('\n'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['read_file', 'now']);
});

test('parse: JSON roto no tira, devuelve item de error', () => {
  const calls = parseToolCalls('```tool:read_file\n{"path": \n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.match(calls[0].error || '', /JSON inválido/);
});

test('parse: texto sin llamadas da vacío', () => {
  assert.deepEqual(parseToolCalls('Hola, ¿cómo andás? Todo bien por acá.'), []);
  assert.deepEqual(parseToolCalls(''), []);
  assert.deepEqual(parseToolCalls('```js\nconst x = 1;\n```'), []);
});

// ---------------------------------------------------------------- gate

test('gate: español positivo', () => {
  for (const t of [
    'leé el archivo package.json',
    'escribí una nota en ideas.md',
    'ejecutá los tests',
    'corré el script',
    'buscá el precio en la web',
    'abrí el readme',
    'creá un archivo nuevo',
    'qué hora es',
    'fijate si compila'
  ]) {
    assert.equal(shouldUseTools(t), true, t);
  }
});

test('gate: inglés positivo', () => {
  for (const t of [
    'read the file app.js',
    'write a summary',
    'run the tests',
    'fetch that url',
    'create a new doc',
    'what time is it'
  ]) {
    assert.equal(shouldUseTools(t), true, t);
  }
});

test('gate: charla normal no dispara', () => {
  for (const t of [
    'Hola, ¿cómo estás?',
    'Contame un cuento',
    'Qué lindo día para tomar mate',
    'Gracias por tu ayuda'
  ]) {
    assert.equal(shouldUseTools(t), false, t);
  }
});

// ---------------------------------------------------------------- registry

test('registry: builtins registradas + prompt las lista', () => {
  for (const n of ['read_file', 'write_file', 'run_cmd', 'fetch_url', 'now']) {
    assert.ok(getTool(n), n);
  }
  const prompt = renderManosPrompt();
  for (const n of ['read_file', 'write_file', 'run_cmd', 'fetch_url', 'now']) {
    assert.ok(prompt.includes(n), n);
  }
  assert.ok(prompt.includes('tool:'), 'muestra el formato');
  assert.ok(listTools().length >= 5);
});

test('registry: salida truncada a 2000 chars', async () => {
  registerTool({
    name: 'manos_test_ruidosa',
    description: 'test',
    execute: async () => ({ ok: true, output: 'x'.repeat(5000) })
  });
  try {
    const t = getTool('manos_test_ruidosa');
    const r = await t.execute({}, {});
    assert.equal(r.ok, true);
    assert.ok(r.output.length <= 2100, `largo ${r.output.length}`);
    assert.match(r.output, /recortada/);
  } finally {
    toolRegistry.delete('manos_test_ruidosa');
  }
});

test('truncarSalida respeta textos cortos', () => {
  assert.equal(truncarSalida('hola'), 'hola');
  assert.equal(truncarSalida(''), '');
});

// ---------------------------------------------------------------- archivos

test('read/write: roundtrip en workspace temporal', async () => {
  const w = getTool('write_file');
  const r = getTool('read_file');
  const wr = await w.execute({ path: 'notas/hola.txt', content: 'Hola Manos' }, ctx);
  assert.equal(wr.ok, true);
  const rd = await r.execute({ path: 'notas/hola.txt' }, ctx);
  assert.equal(rd.ok, true);
  assert.equal(rd.output, 'Hola Manos');
});

test('read/write: escape denegado con error claro', async () => {
  const w = getTool('write_file');
  const r = getTool('read_file');
  for (const evil of ['../../../etc/manos-evil.txt', '/tmp/manos-evil.txt', '.oculto/x.txt']) {
    const a = await w.execute({ path: evil, content: 'x' }, ctx);
    assert.equal(a.ok, false, `write ${evil}`);
    assert.ok(a.error, 'con motivo');
  }
  const b = await r.execute({ path: '../../../etc/hostname' }, ctx);
  assert.equal(b.ok, false);
});

// ---------------------------------------------------------------- run_cmd

test('run_cmd: echo OK', async () => {
  const t = getTool('run_cmd');
  const r = await t.execute({ cmd: 'echo hola-manos' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /hola-manos/);
});

test('run_cmd: comando largo rechazado', async () => {
  const t = getTool('run_cmd');
  const r = await t.execute({ cmd: 'echo ' + 'x'.repeat(600) }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /demasiado largo/);
});

test('voice:true niega riesgosos, voice:false (workforce) los permite', () => {
  const riesgosos = [
    'rm -rf node_modules',
    'rm -rf dist',
    'mv a.txt b.txt',
    'dd if=/dev/zero of=x bs=1k count=1',
    'chmod -R 777 .',
    'git push --force origin main',
    ':(){ :|:& };:'
  ];
  for (const cmd of riesgosos) {
    const vivo = clasificarComando(cmd, { voice: true });
    assert.equal(vivo.permitido, false, `vivo niega: ${cmd}`);
    const diferido = clasificarComando(cmd);
    // git push --force ya es PROHIBIDO siempre; el resto pide justificación.
    if (cmd.startsWith('git push')) {
      assert.equal(diferido.permitido, false);
    } else {
      assert.equal(diferido.permitido, true, `diferido permite: ${cmd}`);
      assert.equal(diferido.riesgoso, true, `diferido marca riesgoso: ${cmd}`);
    }
  }
  // Sanos pasan en ambos modos.
  for (const cmd of ['echo hola', 'npm install', 'ls -la', 'node app.js']) {
    assert.equal(clasificarComando(cmd, { voice: true }).permitido, true, cmd);
    assert.equal(clasificarComando(cmd).permitido, true, cmd);
  }
});

test('run_cmd: riesgoso negado con voice:true', async () => {
  const t = getTool('run_cmd');
  const r = await t.execute({ cmd: 'rm -rf node_modules' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /negado en vivo/);
});

// ---------------------------------------------------------------- fetch (stub local)

function stubOk() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><style>p{color:red}</style></head><body><h1>Hola</h1><script>var x=1;</script><p>Mundo stub</p></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function stubColgado() {
  return new Promise((resolve) => {
    const srv = createServer(() => { /* nunca responde */ });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('fetch_url: 200 devuelve texto sin tags ni scripts', async () => {
  const srv = await stubOk();
  try {
    const t = getTool('fetch_url');
    const r = await t.execute({ url: `http://127.0.0.1:${srv.address().port}/` }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.output, /Hola/);
    assert.match(r.output, /Mundo stub/);
    assert.ok(!r.output.includes('<'), 'sin tags');
    assert.ok(!r.output.includes('var x'), 'sin scripts');
  } finally {
    srv.close();
  }
});

test('fetch_url: timeout contra stub colgado', async () => {
  const srv = await stubColgado();
  try {
    const t = getTool('fetch_url');
    const r = await t.execute({ url: `http://127.0.0.1:${srv.address().port}/`, timeoutMs: 200 }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.error, 'con motivo');
  } finally {
    srv.close();
  }
});

test('fetch_url: solo http/https', async () => {
  const t = getTool('fetch_url');
  const r = await t.execute({ url: 'file:///etc/passwd' }, ctx);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- now

test('now: ISO + zona', async () => {
  const t = getTool('now');
  const r = await t.execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// ---------------------------------------------------------------- loop

test('loop: 2 turnos (tool + cierre) → resumen y eventos', async () => {
  const eventos = [];
  let n = 0;
  const fake = async () => {
    n += 1;
    if (n === 1) {
      return { text: '```tool:now\n{}\n```' };
    }
    return { text: 'Listo, ya sé la hora.' };
  };
  const { toolSummary, toolTurns } = await runToolLoop({
    system: 'test',
    messages: [{ role: 'user', content: 'qué hora es' }],
    completeChat: fake,
    source: { companyId: EMPRESA, slug: SLUG, turnId: 't1', agentId: 'a1' },
    emit: (e) => eventos.push(e),
    maxTurns: 6,
    deadlineMs: 10000
  });
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].calls.length, 1);
  assert.equal(toolTurns[0].calls[0].tool, 'now');
  assert.equal(toolTurns[0].calls[0].ok, true);
  assert.match(toolSummary, /now/);
  const tipos = eventos.map((e) => e.type);
  assert.deepEqual(tipos, ['agent_tool_call', 'agent_tool_done']);
  assert.equal(eventos[0].turnId, 't1');
  assert.equal(eventos[0].agentId, 'a1');
});

test('loop: sin llamadas devuelve resumen vacío', async () => {
  const { toolSummary, toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: async () => ({ text: 'Hola, ¿qué tal?' }),
    source: { companyId: EMPRESA, slug: SLUG },
    deadlineMs: 5000
  });
  assert.equal(toolTurns.length, 0);
  assert.match(toolSummary, /Sin acciones/);
});

test('loop: maxTurns corta con resumen parcial', async () => {
  const { toolSummary, toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'hora' }],
    completeChat: async () => ({ text: '```tool:now\n{}\n```' }),
    source: { companyId: EMPRESA, slug: SLUG },
    maxTurns: 2,
    deadlineMs: 10000
  });
  assert.equal(toolTurns.length, 2);
  assert.match(toolSummary, /tope de turnos/);
});

test('loop: deadline corta con resumen parcial', async () => {
  const { toolSummary, toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'hora' }],
    completeChat: async () => ({ text: '```tool:now\n{}\n```' }),
    source: { companyId: EMPRESA, slug: SLUG },
    maxTurns: 10,
    deadlineMs: 0
  });
  assert.equal(toolTurns.length, 0);
  assert.match(toolSummary, /por tiempo/);
});

test('loop: tool desconocida y JSON roto se reportan, no rompen', async () => {
  let n = 0;
  const fake = async () => {
    n += 1;
    if (n === 1) {
      return { text: '```tool:no_existe\n{"a":1}\n```' };
    }
    if (n === 2) {
      return { text: '```tool:now\n{roto\n```' };
    }
    return { text: 'listo' };
  };
  const { toolSummary, toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'x' }],
    completeChat: fake,
    source: { companyId: EMPRESA, slug: SLUG },
    maxTurns: 5,
    deadlineMs: 10000
  });
  assert.equal(toolTurns.length, 2);
  assert.equal(toolTurns[0].calls[0].ok, false);
  assert.match(toolTurns[0].calls[0].error, /desconocida/);
  assert.equal(toolTurns[1].calls[0].ok, false);
  assert.match(toolTurns[1].calls[0].error, /JSON inválido/);
  assert.match(toolSummary, /fallaron/);
});

test('loop: ejecuta en serie y en orden', async () => {
  const orden = [];
  registerTool({
    name: 'manos_test_orden',
    description: 'test',
    execute: async (args) => {
      orden.push(args.id);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, output: `ok ${args.id}` };
    }
  });
  try {
    await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      completeChat: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n === 1) {
            return {
              text: '```tool:manos_test_orden\n{"id": 1}\n```\n```tool:manos_test_orden\n{"id": 2}\n```'
            };
          }
          return { text: 'listo' };
        };
      })(),
      source: { companyId: EMPRESA, slug: SLUG },
      maxTurns: 3,
      deadlineMs: 10000
    });
    assert.deepEqual(orden, [1, 2]);
  } finally {
    toolRegistry.delete('manos_test_orden');
  }
});

test('teardown: limpio el workspace temporal', () => {
  rmSync(TMPWS, { recursive: true, force: true });
  assert.ok(true);
});
