#!/usr/bin/env node
// Revisión de la instalación: qué falta y el comando exacto para arreglarlo.
//
// La app degrada sola (sin voz, sin transcripción local) y eso solo se ve como
// una línea perdida en el log. Acá se dice de frente qué está bien, qué no y
// cómo se soluciona, sin tener que leer el README entero.

import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const FIN = '\x1b[0m';
const NEGRITA = '\x1b[1m';

const resultados = [];

function anotar(estado, titulo, detalle, arreglo) {
  resultados.push({ estado, titulo, detalle, arreglo });
}

async function existe(relativo) {
  try {
    await access(path.join(raiz, relativo));
    return true;
  } catch {
    return false;
  }
}

async function puertoLibre(puerto) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(puerto, '127.0.0.1');
  });
}

async function responde(url, timeoutMs = 1500) {
  const control = new AbortController();
  const t = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: control.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ── Node ────────────────────────────────────────────────────────────────
const mayor = Number(process.versions.node.split('.')[0]);
if (mayor >= 22) {
  anotar('ok', `Node ${process.versions.node}`, 'sirve para TypeScript sin compilar y para node:sqlite');
} else {
  anotar('falla', `Node ${process.versions.node} es viejo`, 'hacen falta 22 o más', 'Instalá Node 22+ (nvm install 22 && nvm use 22)');
}

// ── Dependencias de node ────────────────────────────────────────────────
anotar(
  (await existe('node_modules')) ? 'ok' : 'falla',
  'Dependencias de node',
  (await existe('node_modules')) ? 'node_modules está' : 'falta node_modules',
  'npm install'
);

// ── Claves de los proveedores de razonamiento ───────────────────────────
const env = (await existe('.env')) ? await readFile(path.join(raiz, '.env'), 'utf-8') : '';
function claveDe(nombre) {
  return (process.env[nombre] || (env.match(new RegExp(`^${nombre}=(.+)$`, 'm')) || [])[1] || '').trim();
}

const proveedores = [
  { nombre: 'MiniMax', variable: 'MINIMAX_API_KEY', donde: 'minimax.io' },
  { nombre: 'DeepSeek', variable: 'DEEPSEEK_API_KEY', donde: 'platform.deepseek.com' }
];
const configurados = proveedores.filter((p) => claveDe(p.variable));

if (configurados.length > 0) {
  anotar(
    'ok',
    'Cerebro configurado',
    configurados.map((p) => `${p.nombre} (…${claveDe(p.variable).slice(-4)})`).join(', ')
  );
  for (const p of proveedores.filter((x) => !claveDe(x.variable))) {
    anotar('aviso', `Sin clave de ${p.nombre}`, 'no vas a poder elegirlo en Ajustes', `${p.variable}=tu-clave en .env (se saca en ${p.donde})`);
  }
} else {
  anotar(
    'falla',
    'Falta la clave del modelo',
    'sin ninguna, los empleados no piensan ni trabajan',
    'Copiá .env.example a .env y poné MINIMAX_API_KEY o DEEPSEEK_API_KEY'
  );
}

// ── Voz (Supertonic) ────────────────────────────────────────────────────
const tieneVenv = await existe('.venv-tts');
const tieneSupertonic = await existe('.venv-tts/bin/supertonic');
if (tieneSupertonic) {
  const vivo = await responde('http://127.0.0.1:7788/docs');
  anotar(
    'ok',
    'Voz local (Supertonic)',
    vivo ? 'instalada y respondiendo en :7788' : 'instalada (arranca sola con npm run dev)'
  );
} else {
  anotar(
    'aviso',
    'Sin voz local',
    tieneVenv ? 'el entorno existe pero falta supertonic' : 'falta el entorno .venv-tts',
    "python3 -m venv .venv-tts && .venv-tts/bin/pip install 'supertonic[serve]' faster-whisper fastapi uvicorn"
  );
}

// ── Transcripción (Whisper) ─────────────────────────────────────────────
if (tieneVenv) {
  let tieneWhisper = false;
  try {
    await run(path.join(raiz, '.venv-tts/bin/python'), ['-c', 'import faster_whisper'], { timeout: 8000 });
    tieneWhisper = true;
  } catch {
    tieneWhisper = false;
  }
  if (tieneWhisper) {
    const vivo = await responde('http://127.0.0.1:7789/health');
    anotar('ok', 'Transcripción local (Whisper)', vivo ? 'instalada y respondiendo en :7789' : 'instalada (arranca sola con npm run dev)');
  } else {
    anotar('aviso', 'Sin transcripción local', 'falta faster-whisper (opcional): el STT local es Parakeet; sin él, Groq/Deepgram/hint', ".venv-tts/bin/pip install faster-whisper fastapi uvicorn");
  }
} else {
  anotar('aviso', 'Sin transcripción local', 'se usa la del navegador (menos preciso)', "python3 -m venv .venv-tts && .venv-tts/bin/pip install 'supertonic[serve]' faster-whisper fastapi uvicorn");
}

// ── Datos y entorno aislado ─────────────────────────────────────────────
const db = 'server/data/meetings.db';
if (await existe(db)) {
  const { size } = await stat(path.join(raiz, db));
  anotar('ok', 'Base de datos', `${(size / 1024).toFixed(0)} kB en ${db}`);
} else {
  anotar('ok', 'Base de datos', 'se crea sola en el primer arranque');
}
anotar('ok', 'Entorno aislado', 'todo lo que genere el equipo va a workspace/<empresa>/<proyecto>/');

// ── Puertos ─────────────────────────────────────────────────────────────
const servicios = [
  { puerto: 8787, nombre: 'backend', prueba: 'http://127.0.0.1:8787/api/companies' },
  { puerto: 7788, nombre: 'voz', prueba: 'http://127.0.0.1:7788/docs' },
  { puerto: 7789, nombre: 'transcripción', prueba: 'http://127.0.0.1:7789/health' }
];
const propios = [];
const ajenos = [];
for (const s of servicios) {
  if (await puertoLibre(s.puerto)) {
    continue;
  }
  // Ocupado: si contesta lo nuestro, es el sistema andando, no un estorbo.
  if (await responde(s.prueba)) {
    propios.push(`${s.nombre} (:${s.puerto})`);
  } else {
    ajenos.push(s.puerto);
  }
}
if (propios.length) {
  anotar('ok', 'Ya está corriendo', propios.join(', '));
}
if (ajenos.length) {
  anotar(
    'aviso',
    `Puertos tomados por otra cosa: ${ajenos.join(', ')}`,
    'algo ajeno los está usando y el sistema no va a poder levantarlos',
    `lsof -ti:${ajenos[0]} -sTCP:LISTEN | xargs kill -9`
  );
}
if (!propios.length && !ajenos.length) {
  anotar('ok', 'Puertos', '8787, 7788 y 7789 libres');
}

// ── Informe ─────────────────────────────────────────────────────────────
console.log(`\n${NEGRITA}Revisión de la instalación${FIN}\n`);
for (const r of resultados) {
  const marca = r.estado === 'ok' ? `${VERDE}✓${FIN}` : r.estado === 'aviso' ? `${AMARILLO}!${FIN}` : `${ROJO}✗${FIN}`;
  console.log(` ${marca} ${NEGRITA}${r.titulo}${FIN}${r.detalle ? ` ${GRIS}— ${r.detalle}${FIN}` : ''}`);
  if (r.arreglo && r.estado !== 'ok') {
    console.log(`     ${GRIS}→${FIN} ${r.arreglo}`);
  }
}

const fallas = resultados.filter((r) => r.estado === 'falla').length;
const avisos = resultados.filter((r) => r.estado === 'aviso').length;
console.log('');
if (fallas > 0) {
  console.log(` ${ROJO}Falta lo esencial${FIN}: corregí lo de arriba y volvé a correr ${NEGRITA}npm run doctor${FIN}.\n`);
} else if (avisos > 0) {
  console.log(` ${AMARILLO}Anda, con limitaciones${FIN}: podés usar todo por texto; la voz necesita lo marcado con !\n`);
} else {
  console.log(` ${VERDE}Todo listo${FIN}: arrancá con ${NEGRITA}npm run dev${FIN} y abrí la dirección que muestre Vite.\n`);
}
process.exit(fallas > 0 ? 1 : 0);
