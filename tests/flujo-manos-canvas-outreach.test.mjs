// Tests Track D (09/11): canvas_* sobre openpencil.js (stub) + outreach_*
// (draft escribe, send con gate de Tito). Workspace temporal, cero binarios
// reales: OpenPencil se reemplaza vía _setOpenpencil().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sin proxy (misma razón que manos.test.mjs: Undici + stubs locales).
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'canvas-outreach-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const manos = await import('../server/lib/manos.js');
const canvas = await import('../server/lib/manos-canvas.js');
const outreach = await import('../server/lib/manos-outreach.js');
canvas.registerCanvasTools();
outreach.registerOutreachTools();

const { getTool } = manos;

const EMPRESA = 'acme';
const SLUG = 'demo';
mkdirSync(path.join(TMPWS, EMPRESA, SLUG), { recursive: true });
const ctx = { companyId: EMPRESA, slug: SLUG };
const ctxOK = { companyId: EMPRESA, slug: SLUG, aprobadoOutreach: true };
const HOY = new Date().toISOString().slice(0, 10);

test.after(() => {
  canvas._resetOpenpencil();
  rmSync(TMPWS, { recursive: true, force: true });
});

function tool(name) {
  const t = getTool(name);
  assert.ok(t, `${name} registrada`);
  return t;
}

const VARS = {
  'color/fondo': { type: 'color', value: '#0F1226' },
  'espacio/md': { type: 'number', value: 16 }
};

function stubOp(over = {}) {
  canvas._resetOpenpencil();
  canvas._setOpenpencil({
    disponible: () => true,
    motivoNoDisponible: () => '',
    abrirDiseno: async () => ({ ok: true, puerto: 3342 }),
    cerrarDiseno: async () => {},
    leerTokensDelDiseno: async () => ({ ...VARS }),
    // tokensComoCodigo NO se stubbea: es puro, se usa el real.
    ...over
  });
}

// --- registro ----------------------------------------------------------------

test('registro: 4 canvas_* + 2 outreach_*', () => {
  for (const name of [
    'canvas_abrir', 'canvas_tokens', 'canvas_codigo', 'canvas_cerrar',
    'outreach_draft', 'outreach_send'
  ]) {
    assert.ok(getTool(name), `${name} registrada`);
  }
});

// --- canvas: degrada sin binarios ----------------------------------------------

test('canvas: las 4 degradan sin binarios con hint instalar-openpencil.sh', async () => {
  canvas._resetOpenpencil();
  canvas._setOpenpencil({
    disponible: () => false,
    motivoNoDisponible: () => 'Missing the OpenPencil CLI (op). Install it with scripts/instalar-openpencil.sh'
  });
  for (const [name, args] of [
    ['canvas_abrir', {}],
    ['canvas_tokens', {}],
    ['canvas_codigo', { stack: 'web' }],
    ['canvas_cerrar', {}]
  ]) {
    const r = await tool(name).execute(args, ctx);
    assert.equal(r.ok, false, `${name} falla sin binarios`);
    assert.match(r.error, /instalar-openpencil\.sh/, `${name} da hint de instalación`);
  }
  canvas._resetOpenpencil();
});

test('canvas: el hint se agrega aunque el motivo no lo traiga', async () => {
  canvas._resetOpenpencil();
  canvas._setOpenpencil({ disponible: () => false, motivoNoDisponible: () => 'algo roto' });
  const r = await tool('canvas_abrir').execute({}, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /algo roto/);
  assert.match(r.error, /instalar-openpencil\.sh/);
  canvas._resetOpenpencil();
});

// --- canvas: camino feliz (stub) --------------------------------------------------

test('canvas_abrir: reporta puerto y usa el workspace del ctx (mismo resolvedor)', async () => {
  let visto = null;
  stubOp({
    abrirDiseno: async (dir, clave) => {
      visto = { dir, clave };
      return { ok: true, puerto: 3350 };
    }
  });
  const r = await tool('canvas_abrir').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /puerto 3350/);
  assert.equal(visto.dir, path.join(TMPWS, EMPRESA, SLUG));
  assert.equal(visto.clave, `${EMPRESA}/${SLUG}`);
});

test('canvas_abrir: yaEstaba se reporta, fallo de op → error claro', async () => {
  stubOp({ abrirDiseno: async () => ({ ok: true, puerto: 3301, yaEstaba: true }) });
  const ya = await tool('canvas_abrir').execute({}, ctx);
  assert.equal(ya.ok, true);
  assert.match(ya.output, /ya estaba/);

  stubOp({ abrirDiseno: async () => ({ ok: false, motivo: 'The design editor failed to start.' }) });
  const mal = await tool('canvas_abrir').execute({}, ctx);
  assert.equal(mal.ok, false);
  assert.match(mal.error, /no pude abrir el diseño/);
});

test('canvas_tokens: vuelca variables; sin diseno.op avisa (no falla)', async () => {
  stubOp();
  const r = await tool('canvas_tokens').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /color\/fondo/);
  assert.match(r.output, /#0F1226/);

  stubOp({ leerTokensDelDiseno: async () => null });
  const vacio = await tool('canvas_tokens').execute({}, ctx);
  assert.equal(vacio.ok, true);
  assert.match(vacio.output, /sin tokens todavía/);
});

test('canvas_codigo: usa tokensComoCodigo real (web → tokens.css, movil-rn → theme.js)', async () => {
  stubOp();
  const web = await tool('canvas_codigo').execute({ stack: 'web' }, ctx);
  assert.equal(web.ok, true);
  assert.match(web.output, /tokens\.css/);
  assert.match(web.output, /--color-fondo: #0F1226/);
  assert.match(web.output, /--espacio-md: 16px/);

  const rn = await tool('canvas_codigo').execute({ stack: 'movil-rn' }, ctx);
  assert.equal(rn.ok, true);
  assert.match(rn.output, /src\/theme\.js/);
  assert.match(rn.output, /colorFondo/);

  const def = await tool('canvas_codigo').execute({}, ctx);
  assert.equal(def.ok, true, 'stack default = web');
  assert.match(def.output, /tokens\.css/);
});

test('canvas_codigo: sin tokens → error (no hay nada que generar)', async () => {
  stubOp({ leerTokensDelDiseno: async () => null });
  const r = await tool('canvas_codigo').execute({ stack: 'web' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /sin tokens/);
});

test('canvas_cerrar: cierra con dir+clave del workspace', async () => {
  let visto = null;
  stubOp({ cerrarDiseno: async (dir, clave) => { visto = { dir, clave }; } });
  const r = await tool('canvas_cerrar').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /cerrado/);
  assert.equal(visto.dir, path.join(TMPWS, EMPRESA, SLUG));
  assert.equal(visto.clave, `${EMPRESA}/${SLUG}`);
});

test('canvas: sin companyId → error, nunca throw', async () => {
  stubOp();
  for (const [name, args] of [
    ['canvas_abrir', {}],
    ['canvas_tokens', {}],
    ['canvas_codigo', { stack: 'web' }],
    ['canvas_cerrar', {}]
  ]) {
    const r = await tool(name).execute(args, {});
    assert.equal(r.ok, false, `${name} no tira`);
    assert.match(r.error, /companyId/);
  }
});

// --- outreach_draft ---------------------------------------------------------------

test('outreach_draft: valida canal/para/cuerpo', async () => {
  for (const [args, patron] of [
    [{}, /canal/],
    [{ canal: 'email' }, /para/],
    [{ canal: 'email', para: 'juan@x.com' }, /cuerpo/],
    [{ canal: '!!!', para: 'juan@x.com', cuerpo: 'hola' }, /canal/],
    [{ canal: 'email', para: '   ', cuerpo: 'hola' }, /para/],
    [{ canal: 'email', para: 'juan@x.com', cuerpo: '   ' }, /cuerpo/]
  ]) {
    const r = await tool('outreach_draft').execute(args, ctx);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, patron);
  }
});

test('outreach_draft: escribe outreach/<fecha>-<canal>.md con frontmatter + cuerpo', async () => {
  const r = await tool('outreach_draft').execute({
    canal: 'Email',
    para: 'juan@x.com',
    asunto: 'Propuesta web',
    cuerpo: 'Che Juan, ¿tomamos un café?'
  }, ctx);
  assert.equal(r.ok, true);
  const rel = `outreach/${HOY}-email.md`;
  assert.match(r.output, new RegExp(`borrador ${rel.replace(/[./]/g, (c) => `\\${c}`)}`));
  const abs = path.join(TMPWS, EMPRESA, SLUG, rel);
  assert.ok(existsSync(abs), 'el archivo existe');
  const texto = readFileSync(abs, 'utf-8');
  assert.match(texto, /^---\ncanal: email\n/m);
  assert.match(texto, /para: "juan@x\.com"/);
  assert.match(texto, /asunto: "Propuesta web"/);
  assert.match(texto, new RegExp(`fecha: ${HOY}`));
  assert.match(texto, /Che Juan, ¿tomamos un café\?/);
});

test('outreach_draft: mismo día+canal no pisa (sufijo -2)', async () => {
  const a = await tool('outreach_draft').execute({ canal: 'wa', para: 'Ana', cuerpo: 'uno' }, ctx);
  const b = await tool('outreach_draft').execute({ canal: 'wa', para: 'Beto', cuerpo: 'dos' }, ctx);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.match(a.output, new RegExp(`${HOY}-wa\\.md`));
  assert.match(b.output, new RegExp(`${HOY}-wa-2\\.md`));
  assert.ok(existsSync(path.join(TMPWS, EMPRESA, SLUG, `outreach/${HOY}-wa.md`)));
  assert.ok(existsSync(path.join(TMPWS, EMPRESA, SLUG, `outreach/${HOY}-wa-2.md`)));
});

test('outreach_draft: canal con traversal se sanea (no escapa del workspace)', async () => {
  const r = await tool('outreach_draft').execute(
    { canal: '../../etc', para: 'x', cuerpo: 'intento' }, ctx
  );
  assert.equal(r.ok, true);
  assert.match(r.output, /outreach\/[\d-]+-etc\.md/);
  assert.ok(!existsSync(path.join(TMPWS, 'etc.md')), 'nada fuera del proyecto');
});

test('outreach_draft: sin companyId → error, nunca throw', async () => {
  const r = await tool('outreach_draft').execute({ canal: 'email', para: 'x', cuerpo: 'y' }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /companyId/);
});

// --- outreach_send: gate ----------------------------------------------------------------

test('outreach_send: SIN aprobación rechaza (ausente, false, truthy-no-true)', async () => {
  const draft = await tool('outreach_draft').execute(
    { canal: 'email', para: 'gate@x.com', cuerpo: 'pendiente' }, ctx
  );
  assert.equal(draft.ok, true);
  const rel = draft.output.replace(/^borrador /, '');
  for (const cx of [
    { ...ctx },
    { ...ctx, aprobadoOutreach: false },
    { ...ctx, aprobadoOutreach: 'sí' },
    { ...ctx, aprobadoOutreach: 1 }
  ]) {
    const r = await tool('outreach_send').execute({ draft: rel }, cx);
    assert.equal(r.ok, false, `rechaza con aprobadoOutreach=${JSON.stringify(cx.aprobadoOutreach)}`);
    assert.match(r.error, /OK explícito de Tito/);
  }
  assert.ok(!existsSync(path.join(TMPWS, EMPRESA, SLUG, 'outbox')), 'nada encolado sin OK');
});

test('outreach_send: CON aprobación encola outbox/*.ready.json y NUNCA dice enviado', async () => {
  const draft = await tool('outreach_draft').execute(
    { canal: 'linkedin', para: 'María Gómez', asunto: 'Hola', cuerpo: 'Te escribo por…' }, ctx
  );
  assert.equal(draft.ok, true);
  const rel = draft.output.replace(/^borrador /, '');
  const r = await tool('outreach_send').execute({ draft: rel }, ctxOK);
  assert.equal(r.ok, true);
  assert.match(r.output, /encolado outbox\//);
  assert.match(r.output, /conector linkedin: entrega manual v1/);
  assert.match(r.output, /NO enviado todavía/);
  assert.ok(!/fue enviado|se envió|enviado con éxito|enviado a /i.test(r.output), 'jamás afirma envío real');

  const base = path.basename(rel, '.md');
  const abs = path.join(TMPWS, EMPRESA, SLUG, 'outbox', `${base}.ready.json`);
  assert.ok(existsSync(abs), 'el .ready.json existe');
  const payload = JSON.parse(readFileSync(abs, 'utf-8'));
  assert.equal(payload.canal, 'linkedin');
  assert.equal(payload.para, 'María Gómez');
  assert.equal(payload.asunto, 'Hola');
  assert.equal(payload.fecha, HOY);
  assert.equal(payload.aprobado, true);
  assert.equal(payload.draft, rel);
  assert.match(payload.cuerpo, /Te escribo/);
});

test('outreach_send: valida draft (vacío, fuera de outreach/, inexistente, sin frontmatter)', async () => {
  const v = await tool('outreach_send').execute({}, ctxOK);
  assert.equal(v.ok, false);
  assert.match(v.error, /falta draft/);

  const f = await tool('outreach_send').execute({ draft: 'notas/idea.md' }, ctxOK);
  assert.equal(f.ok, false);
  assert.match(f.error, /fuera de outreach/);

  const t = await tool('outreach_send').execute({ draft: '../../x.md' }, ctxOK);
  assert.equal(t.ok, false, 'traversal no tira');

  const x = await tool('outreach_send').execute({ draft: 'outreach/2099-01-01-email.md' }, ctxOK);
  assert.equal(x.ok, false);
  assert.match(x.error, /no pude leer el borrador/);
});

test('outreach_send: re-encolar el mismo draft no pisa (sufijo -2)', async () => {
  const draft = await tool('outreach_draft').execute(
    { canal: 'email', para: 're@x.com', cuerpo: 'otra vez' }, ctx
  );
  const rel = draft.output.replace(/^borrador /, '');
  const base = path.basename(rel, '.md');
  const a = await tool('outreach_send').execute({ draft: rel }, ctxOK);
  const b = await tool('outreach_send').execute({ draft: rel }, ctxOK);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const dir = path.join(TMPWS, EMPRESA, SLUG, 'outbox');
  const files = readdirSync(dir).filter((n) => n.startsWith(base));
  assert.equal(files.length, 2);
  assert.ok(files.includes(`${base}.ready.json`));
  assert.ok(files.includes(`${base}-2.ready.json`));
});
