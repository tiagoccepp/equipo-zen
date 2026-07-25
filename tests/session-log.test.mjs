import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Directorio aislado ANTES de importar el módulo (lo resuelve al cargarse).
const dir = mkdtempSync(path.join(tmpdir(), 'equipo-log-'));
process.env.SESSION_LOG_DIR = dir;
const { flushLog, logEvent, readLog } = await import('../server/lib/session-log.js');

test('queda registrado, textual, lo que la persona le pidió al equipo', async () => {
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

test('nunca se escribe una clave al disco, ni suelta ni dentro del texto', async () => {
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

test('se puede reconstruir una conversación entera en orden', async () => {
  // El caso de uso real: algo falló y hay que ver qué pasó, en secuencia.
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

test('se puede filtrar por tipo y buscar texto (así encuentro el caso que falló)', async () => {
  logEvent('mensaje_usuario', { texto: 'la página del catálogo quedó rota' });
  await flushLog();

  const soloErrores = await readLog({ kind: 'error_modelo' });
  assert.ok(soloErrores.every((e) => e.kind === 'error_modelo'));

  const busqueda = await readLog({ search: 'catálogo' });
  assert.ok(busqueda.some((e) => String(e.texto || '').includes('catálogo')));
});

test('un texto enorme se recorta en vez de reventar el archivo', async () => {
  logEvent('mensaje_usuario', { texto: 'a'.repeat(50000) });
  await flushLog();
  const last = (await readLog({ kind: 'mensaje_usuario' })).at(-1);
  assert.ok(last.texto.length < 9000);
  assert.match(last.texto, /recortado 50000 chars/);
});

test('un log roto nunca tumba la conversación', async () => {
  // Payload con referencia circular: no debe lanzar hacia arriba.
  const circular = { nombre: 'bucle' };
  circular.yo = circular;
  assert.doesNotThrow(() => logEvent('mensaje_usuario', { texto: 'hola', circular }));
  await flushLog();
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
