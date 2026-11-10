// Manos v1 tests: parse, gate, registry, tools with temp workspace,
// loop with fake model. No external network: fetch uses a local HTTP stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// No proxy: Undici routes even 127.0.0.1 through the gateway proxy and the
// local stub dies with 403. The tests use no external network anyway.
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

// The workspace resolves from env when importing workforce: it must be set
// BEFORE the dynamic import. Each test process gets its own tmpdir.
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

test('parse: a single call', () => {
  const calls = parseToolCalls('```tool:read_file\n{"path": "a.txt"}\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].args, { path: 'a.txt' });
  assert.equal(calls[0].error, undefined);
});

test('parse: multiple calls in one message', () => {
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

test('parse: broken JSON does not throw, returns an error item', () => {
  const calls = parseToolCalls('```tool:read_file\n{"path": \n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.match(calls[0].error || '', /JSON inválido/);
});

test('parse: text without calls yields empty', () => {
  assert.deepEqual(parseToolCalls('Hola, ¿cómo andás? Todo bien por acá.'), []);
  assert.deepEqual(parseToolCalls(''), []);
  assert.deepEqual(parseToolCalls('```js\nconst x = 1;\n```'), []);
});

// ---------------------------------------------------------------- gate

test('gate: Spanish positive', () => {
  for (const t of [
    'leé el archivo package.json',
    'escribí una nota en ideas.md',
    'ejecutá los tests',
    'corré el script',
    'buscá el precio en la web',
    'abrí el readme',
    'creá un archivo nuevo',
    'qué hora es',
    'fijate si compila',
    'listá los archivos del proyecto',
    'qué archivos hay acá'
  ]) {
    assert.equal(shouldUseTools(t), true, t);
  }
});

test('gate: English positive', () => {
  for (const t of [
    'read the file app.js',
    'what files are here',
    'write a summary',
    'run the tests',
    'fetch that url',
    'create a new doc',
    'what time is it'
  ]) {
    assert.equal(shouldUseTools(t), true, t);
  }
});

test('gate: normal chat does not trigger', () => {
  for (const t of [
    'Hola, ¿cómo estás?',
    'Contame un cuento',
    'Qué lindo día para tomar mate',
    'Gracias por tu ayuda',
    'Listo, gracias',
    'Dale, listo'
  ]) {
    assert.equal(shouldUseTools(t), false, t);
  }
});

// ---------------------------------------------------------------- registry

test('registry: builtins registered + prompt lists them', () => {
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

test('registry: output truncated to 2000 chars', async () => {
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

test('truncarSalida leaves short texts alone', () => {
  assert.equal(truncarSalida('hola'), 'hola');
  assert.equal(truncarSalida(''), '');
});

// ---------------------------------------------------------------- files

test('read/write: roundtrip in temp workspace', async () => {
  const w = getTool('write_file');
  const r = getTool('read_file');
  const wr = await w.execute({ path: 'notas/hola.txt', content: 'Hola Manos' }, ctx);
  assert.equal(wr.ok, true);
  const rd = await r.execute({ path: 'notas/hola.txt' }, ctx);
  assert.equal(rd.ok, true);
  assert.equal(rd.output, 'Hola Manos');
});

test('read/write: escape denied with a clear error', async () => {
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

test('run_cmd: long command rejected', async () => {
  const t = getTool('run_cmd');
  const r = await t.execute({ cmd: 'echo ' + 'x'.repeat(600) }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /demasiado largo/);
});

test('voice:true denies risky ones, voice:false (workforce) allows them', () => {
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
    // git push --force is always FORBIDDEN; the rest ask for justification.
    if (cmd.startsWith('git push')) {
      assert.equal(diferido.permitido, false);
    } else {
      assert.equal(diferido.permitido, true, `diferido permite: ${cmd}`);
      assert.equal(diferido.riesgoso, true, `diferido marca riesgoso: ${cmd}`);
    }
  }
  // Healthy ones pass in both modes.
  for (const cmd of ['echo hola', 'npm install', 'ls -la', 'node app.js']) {
    assert.equal(clasificarComando(cmd, { voice: true }).permitido, true, cmd);
    assert.equal(clasificarComando(cmd).permitido, true, cmd);
  }
});

test('run_cmd: risky denied with voice:true', async () => {
  const t = getTool('run_cmd');
  const r = await t.execute({ cmd: 'rm -rf node_modules' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /negado en vivo/);
});

// ---------------------------------------------------------------- fetch (local stub)

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
    const srv = createServer(() => { /* never responds */ });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('fetch_url: 200 returns text without tags or scripts', async () => {
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

test('fetch_url: timeout against hung stub', async () => {
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

test('fetch_url: http/https only', async () => {
  const t = getTool('fetch_url');
  const r = await t.execute({ url: 'file:///etc/passwd' }, ctx);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- now

test('now: ISO + zone', async () => {
  const t = getTool('now');
  const r = await t.execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// ---------------------------------------------------------------- loop

test('loop: 2 turns (tool + close) → summary and events', async () => {
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

test('loop: no calls returns empty summary', async () => {
  const { toolSummary, toolTurns } = await runToolLoop({
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: async () => ({ text: 'Hola, ¿qué tal?' }),
    source: { companyId: EMPRESA, slug: SLUG },
    deadlineMs: 5000
  });
  assert.equal(toolTurns.length, 0);
  assert.match(toolSummary, /Sin acciones/);
});

test('loop: maxTurns cuts off with partial summary', async () => {
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

test('loop: deadline cuts off with partial summary', async () => {
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

test('loop: unknown tool and broken JSON are reported, not fatal', async () => {
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

test('loop: runs serially and in order', async () => {
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

test('list_files: root lists relative, sorted, no hidden files or dependencies', async () => {
  const w = getTool('write_file');
  await w.execute({ path: 'zeta.txt', content: 'z' }, ctx);
  await w.execute({ path: 'alfa.txt', content: 'a' }, ctx);
  await w.execute({ path: 'sub/nota.txt', content: 'n' }, ctx);
  const t = getTool('list_files');
  const r = await t.execute({}, ctx);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.output.includes('alfa.txt'));
  assert.ok(r.output.includes('zeta.txt'));
  assert.ok(r.output.includes('sub/'), 'carpetas con /');
  assert.ok(r.output.indexOf('alfa.txt') < r.output.indexOf('zeta.txt'), 'ordenado');
});

test('list_files: subfolder + ignores node_modules and hidden files', async () => {
  const w = getTool('write_file');
  await w.execute({ path: 'node_modules/fake.txt', content: 'x' }, ctx);
  const t = getTool('list_files');
  const raiz = await t.execute({}, ctx);
  assert.equal(raiz.ok, true);
  assert.ok(!raiz.output.includes('node_modules'), 'dependencias afuera');
  const sub = await t.execute({ dir: 'sub' }, ctx);
  assert.equal(sub.ok, true, sub.error);
  assert.ok(sub.output.includes('nota.txt'));
});

test('list_files: escape and missing denied with clear error', async () => {
  const t = getTool('list_files');
  for (const evil of ['../../../etc', '/tmp', '..', '.oculto']) {
    const r = await t.execute({ dir: evil }, ctx);
    assert.equal(r.ok, false, `dir ${evil}`);
    assert.ok(r.error, 'con motivo');
  }
  const ausente = await t.execute({ dir: 'no-existe-xyz' }, ctx);
  assert.equal(ausente.ok, false);
});

test('list_files: 100-entry cap with notice', async () => {
  const w = getTool('write_file');
  for (let i = 0; i < 105; i += 1) {
    await w.execute({ path: `muchos/f${String(i).padStart(3, '0')}.txt`, content: 'x' }, ctx);
  }
  const t = getTool('list_files');
  const r = await t.execute({ dir: 'muchos' }, ctx);
  assert.equal(r.ok, true, r.error);
  const lineas = r.output.split('\n');
  assert.equal(lineas.filter((l) => l.endsWith('.txt')).length, 100);
  assert.match(r.output, /tope 100/);
});

test('bindManosCompleteChat: raw array wrapped in {messages, scope manos} (Zen 400 regression)', async () => {
  const { bindManosCompleteChat } = await import('../server/lib/agent-runtime.js');
  // Keyless ring: the real completeChat throws BEFORE network, and the message
  // includes options.scope — if the array arrived raw, scope would be undefined.
  const noKeys = { hasKeys: () => false };
  const bound = bindManosCompleteChat(noKeys);
  const chat = [{ role: 'system', content: 's' }, { role: 'user', content: 'hola' }];
  await assert.rejects(() => bound(chat), /manos/);
});

test('runToolLoop + live adapter: chat arrives as {messages:[...]} at the model', async () => {
  const manos = await import('../server/lib/manos.js');
  const { bindManosCompleteChat } = await import('../server/lib/agent-runtime.js');
  let seenOpts = null;
  // Adapter with the SAME signature bindManosCompleteChat produces live:
  // the loop passes a raw array; the model must receive {messages: array}.
  const liveShaped = (ring) => (...args) => {
    const only = args[0];
    const opts = Array.isArray(only) ? { messages: only, scope: 'manos' } : only;
    seenOpts = opts;
    assert.ok(Array.isArray(opts.messages), 'el modelo recibe messages array');
    return { text: '```tool:now\n{}\n```' };
  };
  const out = await manos.runToolLoop({
    system: 'test', messages: [{ role: 'user', content: 'qué hora es' }],
    completeChat: liveShaped({}), emit: () => {}, maxTurns: 2,
    deadlineMs: 15000, companyId: 'test', slug: 'general'
  });
  assert.ok(seenOpts && Array.isArray(seenOpts.messages));
  assert.ok((out.toolSummary || '').length > 0);
  assert.equal(typeof bindManosCompleteChat, 'function');
});

test('teardown: clean the temp workspace', () => {
  rmSync(TMPWS, { recursive: true, force: true });
  assert.ok(true);
});
