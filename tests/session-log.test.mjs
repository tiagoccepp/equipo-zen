import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolated directory BEFORE importing the module (it resolves it at load time).
const dir = mkdtempSync(path.join(tmpdir(), 'equipo-log-'));
process.env.SESSION_LOG_DIR = dir;
const { flushLog, logEvent, readLog } = await import('../server/lib/session-log.js');

test('what the person asked the team is recorded, as text', async () => {
  logEvent('mensaje_usuario', {
    empresa: 'NovaTech',
    via: 'voz',
    texto: 'che, necesito algo para mostrar lo que hacemos'
  });
  await flushLog();

  const entries = await readLog({ kind: 'mensaje_usuario' });
  const last = entries.at(-1);
  assert.equal(last.kind, 'mensaje_usuario');
  assert.equal(last.texto, 'che, necesito algo para mostrar lo que hacemos');
  assert.equal(last.via, 'voz');
  assert.ok(last.at, 'lleva marca de tiempo');
});

test('a key is never written to disk, neither loose nor inside the text', async () => {
  logEvent('mensaje_usuario', {
    texto: 'mi clave es sk-abcdefghijklmnopqrstuvwxyz por si la necesitás',
    apiKey: 'sk-otra-clave-secreta-123456'
  });
  await flushLog();

  const entries = await readLog({ kind: 'mensaje_usuario' });
  const dump = JSON.stringify(entries.at(-1));
  assert.ok(!dump.includes('abcdefghijklmnopqrstuvwxyz'), 'la clave del texto queda tapada');
  assert.ok(!dump.includes('sk-otra-clave-secreta'), 'el campo de clave queda tapado');
  assert.ok(dump.includes('secreto oculto'));
});

test('a whole conversation can be rebuilt in order', async () => {
  // The real use case: something failed and you need to see what happened, in sequence.
  logEvent('mensaje_usuario', { texto: 'quiero una web', turnId: 't1' });
  logEvent('respuesta_agente', { agente: 'Renata', texto: '¿Es para vender o para mostrar?' });
  logEvent('mensaje_usuario', { texto: 'para mostrar', turnId: 't2' });
  logEvent('interrupcion', { motivo: 'barge_in', agenteInterrumpido: 'Bruno' });
  logEvent('error_modelo', { scope: 'Bruno texto', error: 'Timeout en 20000ms' });
  await flushLog();

  const historia = await readLog({ limit: 500 });
  const kinds = historia.map((e) => e.kind);
  const i = kinds.lastIndexOf('error_modelo');
  assert.deepEqual(
    kinds.slice(i - 4, i + 1),
    ['mensaje_usuario', 'respuesta_agente', 'mensaje_usuario', 'interrupcion', 'error_modelo'],
    'la secuencia queda tal cual pasó'
  );
});

test('can filter by type and search text (that is how I find the failing case)', async () => {
  logEvent('mensaje_usuario', { texto: 'la página del catálogo quedó rota' });
  await flushLog();

  const soloErrores = await readLog({ kind: 'error_modelo' });
  assert.ok(soloErrores.every((e) => e.kind === 'error_modelo'));

  const busqueda = await readLog({ search: 'catálogo' });
  assert.ok(busqueda.some((e) => String(e.texto || '').includes('catálogo')));
});

test('a huge text is trimmed instead of blowing up the file', async () => {
  logEvent('mensaje_usuario', { texto: 'a'.repeat(50000) });
  await flushLog();
  const last = (await readLog({ kind: 'mensaje_usuario' })).at(-1);
  assert.ok(last.texto.length < 9000);
  assert.match(last.texto, /recortado 50000 chars/);
});

test('a broken log never brings the conversation down', async () => {
  // Payload with a circular reference: must not throw upwards.
  const circular = { nombre: 'bucle' };
  circular.yo = circular;
  assert.doesNotThrow(() => logEvent('mensaje_usuario', { texto: 'hola', circular }));
  await flushLog();
});


test('the payload cannot overwrite the entry type', async () => {
  // Work events carry their own "kind" inside; without protection,
  // the journal ended up misclassifying its own entries.
  logEvent('trabajo_file_written', { kind: 'file_written', path: 'index.html', agentName: 'Bruno' });
  await flushLog();

  const entries = await readLog({ kind: 'trabajo_file_written' });
  assert.equal(entries.at(-1).kind, 'trabajo_file_written');
  assert.equal(entries.at(-1).path, 'index.html');
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
