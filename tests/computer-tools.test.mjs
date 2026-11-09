// Tests computer tools (Manos 2B): open_url / window_list / screenshot.
// CERO ventanas reales: toda interacción con el SO pasa por `computer`
// (which/run/display), reemplazado acá con fakes vía _setComputer().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sin proxy (misma razón que manos.test.mjs: Undici + stub local).
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'computer-tools-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const manos = await import('../server/lib/manos.js');
const { clasificarComando } = await import('../server/lib/herramientas.js');

const {
  getTool,
  renderManosPrompt,
  shouldUseTools,
  runToolLoop,
  _setComputer,
  _resetComputer
} = manos;

const EMPRESA = 'acme';
const SLUG = 'demo';
mkdirSync(path.join(TMPWS, EMPRESA, SLUG), { recursive: true });
const ctx = { companyId: EMPRESA, slug: SLUG };

test.after(() => {
  _resetComputer();
  rmSync(TMPWS, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------

function pngMinimo(ancho, alto) {
  const buf = Buffer.alloc(26);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(ancho, 16);
  buf.writeUInt32BE(alto, 20);
  return buf;
}

// Fake de computer: `instalados` = binarios que `which` encuentra;
// `respuestas` = run(cmd, args) -> {ok, salida, error, expiro?} o función
// que escribe archivos (screenshots) y devuelve el resultado.
function fakeComputer({ instalados = [], respuestas = {}, display = true, wayland = false } = {}) {
  const set = new Set(instalados);
  const llamadas = [];
  _resetComputer();
  _setComputer({
    which: async (cands) => cands.find((c) => set.has(c)) || null,
    run: async (cmd, args) => {
      llamadas.push({ cmd, args: [...args] });
      const clave = `${cmd} ${args[0] || ''}`;
      const r = typeof respuestas === 'function'
        ? await respuestas(cmd, args)
        : (respuestas[clave] ?? respuestas[cmd]);
      if (typeof r === 'function') return r(cmd, args);
      return r || { ok: true, codigo: 0, salida: '', error: '' };
    },
    hayDisplay: () => display,
    display: () => ':0',
    esWayland: () => wayland
  });
  return llamadas;
}

function tool(name) {
  const t = getTool(name);
  assert.ok(t, `${name} registrada`);
  return t;
}

// --- open_url ----------------------------------------------------------------

test('open_url: abre URL con xdg-open (sin shell, DISPLAY heredado)', async () => {
  const llamadas = fakeComputer({ instalados: ['xdg-open'] });
  const r = await tool('open_url').execute({ target: 'https://google.com' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /abierto https:\/\/google\.com/);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].cmd, 'xdg-open');
  assert.deepEqual(llamadas[0].args, ['https://google.com']);
});

test('open_url: target con ? & ; " llega como UN solo argv (prueba de no-shell)', async () => {
  const llamadas = fakeComputer({ instalados: ['xdg-open'] });
  const nasty = 'https://x.com/buscar?q=hola mundo&n=1"; rm -rf /tmp/pwn; echo "';
  const r = await tool('open_url').execute({ target: nasty }, ctx);
  assert.equal(r.ok, true);
  assert.equal(llamadas.length, 1);
  assert.deepEqual(llamadas[0].args, [nasty]);
});

test('open_url: pedido explícito manda — URL con token en query NO se niega', async () => {
  fakeComputer({ instalados: ['xdg-open'] });
  const r = await tool('open_url').execute({ target: 'https://app.com/reset?token=abc123' }, ctx);
  assert.equal(r.ok, true);
});

test('open_url: niega SOLO secretos/credenciales', async () => {
  fakeComputer({ instalados: ['xdg-open'] });
  for (const target of [
    '/home/tito/proyecto/.env',
    '~/.ssh/id_rsa',
    'certs/server.pem',
    'docs/credentials.json',
    '/etc/passwd'
  ]) {
    const r = await tool('open_url').execute({ target }, ctx);
    assert.equal(r.ok, false, `${target} debería negarse`);
    assert.match(r.error, /secreto\/credencial/);
  }
});

test('open_url: vacío y demasiado largo', async () => {
  fakeComputer({ instalados: ['xdg-open'] });
  const v = await tool('open_url').execute({ target: '   ' }, ctx);
  assert.equal(v.ok, false);
  assert.match(v.error, /vacío/);
  const l = await tool('open_url').execute({ target: `https://x.com/${'a'.repeat(600)}` }, ctx);
  assert.equal(l.ok, false);
  assert.match(l.error, /demasiado largo/);
});

test('open_url: sin xdg-open degrada con error claro', async () => {
  fakeComputer({ instalados: [] });
  const r = await tool('open_url').execute({ target: 'https://google.com' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /sin xdg-open/);
});

test('open_url: xdg-open falla → error con motivo (y pista si no hay DISPLAY)', async () => {
  fakeComputer({
    instalados: ['xdg-open'],
    display: false,
    respuestas: { 'xdg-open': { ok: false, codigo: 3, salida: '', error: 'no method available' } }
  });
  const r = await tool('open_url').execute({ target: 'https://google.com' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /no pude abrir/);
  assert.match(r.error, /sin DISPLAY/);
});

test('open_url: timeout = ambiguo-ok (la app suele quedar abierta)', async () => {
  fakeComputer({
    instalados: ['xdg-open'],
    respuestas: { 'xdg-open': { ok: false, codigo: -1, expiro: true, salida: '', error: 'timeout 15s' } }
  });
  const r = await tool('open_url').execute({ target: 'https://google.com' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /sin confirmación/);
});

// --- window_list ---------------------------------------------------------------

test('window_list: backend wmctrl parsea título + app', async () => {
  fakeComputer({
    instalados: ['wmctrl'],
    respuestas: {
      'wmctrl': {
        ok: true, codigo: 0,
        salida: '0x03a00001  0 gnome-terminal.Gnome-terminal  tito Terminal — bash\n'
          + '0x05c00002  0 firefox.Firefox  tito Google — Mozilla Firefox\n',
        error: ''
      }
    }
  });
  const r = await tool('window_list').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /2 ventana\(s\)/);
  assert.match(r.output, /Terminal — bash \(gnome-terminal\)/);
  assert.match(r.output, /Google — Mozilla Firefox \(firefox\)/);
});

test('window_list: backend xdotool (search + getwindowname por id)', async () => {
  const llamadas = fakeComputer({
    instalados: ['xdotool'],
    respuestas: async (cmd, args) => {
      if (args[0] === 'search') return { ok: true, codigo: 0, salida: '111\n222\n', error: '' };
      if (args[0] === 'getwindowname' && args[1] === '111') {
        return { ok: true, codigo: 0, salida: 'Editor — notas.txt\n', error: '' };
      }
      return { ok: true, codigo: 0, salida: '\n', error: '' }; // 222 sin título → se salta
    }
  });
  const r = await tool('window_list').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /1 ventana\(s\)/);
  assert.match(r.output, /Editor — notas\.txt/);
  assert.ok(llamadas.some((l) => l.args[0] === 'search'), 'hace search');
});

test('window_list: backend xwininfo (fallback real del box)', async () => {
  fakeComputer({
    instalados: ['xwininfo'],
    respuestas: {
      'xwininfo': {
        ok: true, codigo: 0,
        salida: 'xwininfo: Window id: 0x1c9 (the root window)\n'
          + '\n'
          + '  Root window id: 0x1c9 (the root window) (has no name)\n'
          + '  Parent window id: 0x0 (none)\n'
          + '     0x400001 "Terminal": ("gnome-terminal" "Gnome-terminal")  800x600+0+0\n'
          + '        0x400002 (has no name): ()  10x10 (hija anidada, se ignora)\n'
          + '     0x600001 "Calculadora": ("gnome-calc" "Gnome-calc")  300x400+10+10\n',
        error: ''
      }
    }
  });
  const r = await tool('window_list').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /2 ventana\(s\)/);
  assert.match(r.output, /Terminal \(Gnome-terminal\)/);
  assert.match(r.output, /Calculadora \(Gnome-calc\)/);
});

test('window_list: sin backend o sin display → error claro', async () => {
  fakeComputer({ instalados: [] });
  const sb = await tool('window_list').execute({}, ctx);
  assert.equal(sb.ok, false);
  assert.match(sb.error, /sin wmctrl\/xdotool\/xwininfo/);

  fakeComputer({ instalados: ['wmctrl'], display: false });
  const sd = await tool('window_list').execute({}, ctx);
  assert.equal(sd.ok, false);
  assert.match(sd.error, /sin sesión gráfica/);
});

test('window_list: backend falla → error con backend nombrado', async () => {
  fakeComputer({
    instalados: ['wmctrl'],
    respuestas: { 'wmctrl': { ok: false, codigo: 1, salida: '', error: 'Cannot open display' } }
  });
  const r = await tool('window_list').execute({}, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /wmctrl/);
});

test('window_list: cero ventanas → mensaje, no error', async () => {
  fakeComputer({
    instalados: ['wmctrl'],
    respuestas: { 'wmctrl': { ok: true, codigo: 0, salida: '\n', error: '' } }
  });
  const r = await tool('window_list').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /sin ventanas visibles/);
});

// --- screenshot ------------------------------------------------------------------

test('screenshot: scrot-ok guarda shots/<ts>.png y reporta dims del IHDR', async () => {
  fakeComputer({
    instalados: ['scrot'],
    respuestas: async (cmd, args) => {
      assert.equal(cmd, 'scrot');
      writeFileSync(args[0], pngMinimo(1920, 1080));
      return { ok: true, codigo: 0, salida: '', error: '' };
    }
  });
  const r = await tool('screenshot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /captura shots\/[\dT]+\.png \(1920x1080\)/);
  const dir = path.join(TMPWS, EMPRESA, SLUG, 'shots');
  assert.ok(existsSync(dir), 'crea shots/');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.png')).length, 1);
});

test('screenshot: fallback — si scrot falla prueba con gnome-screenshot', async () => {
  const llamadas = fakeComputer({
    instalados: ['scrot', 'gnome-screenshot'],
    respuestas: async (cmd, args) => {
      if (cmd === 'scrot') return { ok: false, codigo: 1, salida: '', error: 'unable to open display' };
      writeFileSync(args[args.length - 1], pngMinimo(800, 600));
      return { ok: true, codigo: 0, salida: '', error: '' };
    }
  });
  const r = await tool('screenshot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /\(800x600\)/);
  assert.deepEqual(llamadas.map((l) => l.cmd), ['scrot', 'gnome-screenshot']);
});

test('screenshot: ffmpeg usa x11grab con el display', async () => {
  const llamadas = fakeComputer({
    instalados: ['ffmpeg'],
    respuestas: async (cmd, args) => {
      writeFileSync(args[args.length - 1], pngMinimo(640, 480));
      return { ok: true, codigo: 0, salida: '', error: '' };
    }
  });
  const r = await tool('screenshot').execute({}, ctx);
  assert.equal(r.ok, true);
  const ff = llamadas.find((l) => l.cmd === 'ffmpeg');
  assert.ok(ff, 'llamó ffmpeg');
  assert.ok(ff.args.includes('x11grab'), 'usa x11grab');
  assert.ok(ff.args.includes(':0'), 'pasa display');
});

test('screenshot: xwd en dos pasos (xwd + ffmpeg convierte)', async () => {
  // ffmpeg-direct va ANTES que xwd en el orden: para llegar a xwd, el
  // x11grab directo tiene que fallar pero el binario ffmpeg existir.
  const llamadas = fakeComputer({
    instalados: ['xwd', 'ffmpeg'],
    respuestas: async (cmd, args) => {
      if (cmd === 'xwd') {
        writeFileSync(args[args.indexOf('-out') + 1], Buffer.from('XWDFAKE'));
        return { ok: true, codigo: 0, salida: '', error: '' };
      }
      if (args.includes('x11grab')) {
        return { ok: false, codigo: 1, salida: '', error: 'x11grab no anda acá' };
      }
      writeFileSync(args[args.length - 1], pngMinimo(320, 200));
      return { ok: true, codigo: 0, salida: '', error: '' };
    }
  });
  const r = await tool('screenshot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /\(320x200\)/);
  assert.deepEqual(llamadas.map((l) => l.cmd), ['ffmpeg', 'xwd', 'ffmpeg']);
});

test('screenshot: sin backend o sin display → error claro', async () => {
  fakeComputer({ instalados: [] });
  const sb = await tool('screenshot').execute({}, ctx);
  assert.equal(sb.ok, false);
  assert.match(sb.error, /sin capturador/);

  fakeComputer({ instalados: ['scrot'], display: false });
  const sd = await tool('screenshot').execute({}, ctx);
  assert.equal(sd.ok, false);
  assert.match(sd.error, /sin sesión gráfica/);
});

test('screenshot: PNG corrupto reporta tamaño desconocido (no rompe)', async () => {
  fakeComputer({
    instalados: ['scrot'],
    respuestas: async (cmd, args) => {
      writeFileSync(args[0], Buffer.from('no-es-un-png'));
      return { ok: true, codigo: 0, salida: '', error: '' };
    }
  });
  const r = await tool('screenshot').execute({}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /tamaño desconocido/);
});

// --- gate ------------------------------------------------------------------

test('gate: abre/navega/pantalla/captura/ventana matchean ES+EN', () => {
  for (const texto of [
    'abrí google en el navegador',
    'abre el archivo en el visor',
    'abrir el readme con otra app',
    'navegá a la página de AFIP',
    'sacá una captura de pantalla',
    'haceme un screenshot de esto',
    'qué ventanas tenés abiertas',
    'navigate to the docs',
    'browse the pricing page',
    'take a screenshot',
    'list open windows',
    'capture the screen'
  ]) {
    assert.equal(shouldUseTools(texto), true, `debería matchear: ${texto}`);
  }
});

test('gate: charla normal NO matchea (abril/listo son falsos amigos)', () => {
  for (const texto of [
    'hola, ¿cómo andás?',
    'contame un chiste',
    'qué hiciste en abril',
    'listo, gracias por hoy',
    'abril es un mes lindo'
  ]) {
    assert.equal(shouldUseTools(texto), false, `NO debería matchear: ${texto}`);
  }
});

// --- prompt ------------------------------------------------------------------

test('prompt: voz y full listan las 3 computer tools, 1 línea cada una', () => {
  for (const src of ['audio', 'text']) {
    const out = renderManosPrompt(src);
    for (const name of ['open_url', 'window_list', 'screenshot']) {
      const lineas = out.split('\n').filter((l) => l.includes(name));
      assert.equal(lineas.length, 1, `${src}: ${name} aparece 1 vez`);
      assert.match(lineas[0], /^- /);
    }
  }
});

// --- loop end-to-end (modelo fake) -------------------------------------------------

test('loop: turno "abrí google" usa open_url y resume', async () => {
  fakeComputer({ instalados: ['xdg-open'] });
  let n = 0;
  const { toolSummary, toolTurns } = await runToolLoop({
    system: 'test',
    messages: [{ role: 'user', content: 'abrí google en el navegador' }],
    source: { ...ctx, turnId: 't1', agentId: 'a1' },
    completeChat: async () => {
      n += 1;
      if (n === 1) return '```tool:open_url\n{"target": "https://google.com"}\n```';
      return 'Listo, te abrí Google en el navegador.';
    }
  });
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].calls[0].tool, 'open_url');
  assert.equal(toolTurns[0].calls[0].ok, true);
  assert.match(toolSummary, /open_url: ok/);
});

// --- regresión run_cmd -------------------------------------------------------

test('regresión: clasificarComando permite xdg-open/brave en vivo (ya andaba)', () => {
  for (const cmd of [
    'xdg-open https://google.com',
    'xdg-open "https://x.com/?a=1&b=2"',
    'brave https://google.com'
  ]) {
    const r = clasificarComando(cmd, { voice: true });
    assert.equal(r.permitido, true, `${cmd} permitido en vivo`);
  }
});
