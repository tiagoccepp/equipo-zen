// Manos browser (Track A, 09/11): tools browser_* sobre ~/agentes/bin/ab.
//
// Plan: /home/tito/research/flujo-manos-plan.md (Track A).
// El modelo maneja un Chrome real vía el wrapper `ab` (agent-browser +
// Chrome del sistema + --no-proxy-server). Spawn SIEMPRE sin shell (argv);
// la sesión sale del ctx (agentId sanitizado) o 'general'.
//
// Integración: main importa este módulo desde manos.js y llama
// registerBrowserTools() UNA vez al arrancar. Este módulo NO se
// auto-registra al importar: registerTool se usa solo dentro de la
// función, así el ciclo ESM manos.js ⇄ manos-browser.js es seguro.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerTool } from './manos.js';
// El resolvedor de paths es EL MISMO que usan las tools de manos.js:
// browser_shot no inventa rutas, pasa por safeWorkspacePath.
import { safeWorkspacePath } from './workforce.js';

// ---------------------------------------------------------------------------
// Constantes y configuración
// ---------------------------------------------------------------------------

export const BROWSER_TIMEOUT_MS = 30000;
export const BROWSER_OPEN_TIMEOUT_MS = 45000;
export const BROWSER_EVAL_MAX = 2000;
export const BROWSER_TYPE_MAX = 4000;
export const BROWSER_REF_MAX = 500;
export const BROWSER_URL_MAX = 2000;
export const BROWSER_NOMBRE_MAX = 200;
// Tope crudo por stream del hijo (memoria): el truncado final a 2000 con
// marcador lo pone el registry de manos.js (todas las tools iguales).
const BROWSER_STREAM_MAX = 65536;

const timeouts = {
  defaultMs: BROWSER_TIMEOUT_MS,
  openMs: BROWSER_OPEN_TIMEOUT_MS
};

// Solo tests: acortar timeouts para probar el kill sin esperar 30s.
export function _setBrowserTimeouts({ defaultMs = null, openMs = null } = {}) {
  if (Number(defaultMs) > 0) timeouts.defaultMs = Number(defaultMs);
  if (Number(openMs) > 0) timeouts.openMs = Number(openMs);
  return { ...timeouts };
}

export function _resetBrowserTimeouts() {
  timeouts.defaultMs = BROWSER_TIMEOUT_MS;
  timeouts.openMs = BROWSER_OPEN_TIMEOUT_MS;
  return { ...timeouts };
}

// ---------------------------------------------------------------------------
// Binario, sesión y env
// ---------------------------------------------------------------------------

// $HOME/agentes/bin/ab si existe y es ejecutable, si no `agent-browser`
// en PATH. EQUIPO_AB_BIN lo fuerza (seam de tests/entornos sin HOME real).
export function resolveAbBin() {
  const forzado = String(process.env.EQUIPO_AB_BIN || '').trim();
  if (forzado) return forzado;
  const home = process.env.HOME || os.homedir() || '';
  const candidato = path.join(home, 'agentes', 'bin', 'ab');
  try {
    accessSync(candidato, fsConstants.X_OK);
    return candidato;
  } catch {
    return 'agent-browser';
  }
}

// agentId → fragmento de sesión (minúsculas, [a-z0-9_-], tope 40).
// Vacío o ilegible = 'general'.
// NOTA: runToolLoop v1 pasa ctx={companyId, slug} sin agentId, así que en
// vivo la sesión es equipo-general hasta que main cablee agentId al ctx
// (propuesta §Main en el reporte del track).
export function sesionPara(agentId) {
  const limpio = String(agentId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return limpio || 'general';
}

function errorClaro(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Spawn (sin shell, con timeout, nunca throw)
// ---------------------------------------------------------------------------

function correrAb(argv, { timeoutMs = timeouts.defaultMs, stdinData = null, ctx = null } = {}) {
  return new Promise((resolve) => {
    const bin = resolveAbBin();
    const env = { ...process.env };
    // El proxy del gateway rompe la navegación del Chrome hijo: afuera.
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    env.AGENT_BROWSER_EXECUTABLE_PATH = '/usr/bin/google-chrome-stable';
    env.AGENT_BROWSER_ARGS = '--no-proxy-server';
    env.AGENT_BROWSER_SESSION = `equipo-${sesionPara(ctx?.agentId)}`;

    let hijo;
    try {
      hijo = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (error) {
      resolve({ ok: false, output: '', error: `no pude lanzar ${bin}: ${errorClaro(error)}` });
      return;
    }

    let out = '';
    let err = '';
    hijo.stdout.on('data', (d) => { if (out.length < BROWSER_STREAM_MAX) out += String(d); });
    hijo.stderr.on('data', (d) => { if (err.length < BROWSER_STREAM_MAX) err += String(d); });

    const nombre = argv[0] || 'ab';
    const limite = Number(timeoutMs) > 0 ? Number(timeoutMs) : timeouts.defaultMs;
    const reloj = setTimeout(() => {
      try { hijo.kill('SIGKILL'); } catch { /* ya murió */ }
      resolve({ ok: false, output: '', error: `timeout ${Math.round(limite / 1000)}s en browser (ab ${nombre})` });
    }, limite);

    hijo.on('error', (e) => {
      clearTimeout(reloj);
      resolve({ ok: false, output: '', error: `no pude lanzar ${bin}: ${errorClaro(e)}` });
    });
    hijo.on('close', (codigo) => {
      clearTimeout(reloj);
      if (codigo === 0) {
        const texto = out.trim() || '(sin salida)';
        // Corte a 2000 SIN marcador: el "…[salida recortada…]" lo pone el
        // registry de manos.js; si lo pusiéramos acá saldría dos veces.
        resolve({ ok: true, output: texto.slice(0, 2000) });
      } else {
        const motivo = (err.trim() || out.trim() || `código ${codigo}`).slice(0, 500);
        resolve({ ok: false, output: '', error: `ab ${nombre} falló: ${motivo}` });
      }
    });

    try {
      if (stdinData != null) {
        hijo.stdin.write(String(stdinData));
      }
      hijo.stdin.end();
    } catch { /* stdin roto: el close lo reporta */ }
  });
}

// ---------------------------------------------------------------------------
// Registro (solo al llamar a registerBrowserTools, nunca al importar)
// ---------------------------------------------------------------------------

export function registerBrowserTools() {
  registerTool({
    name: 'browser_open',
    description: 'Abre una URL en el Chrome del equipo (crea la sesión si no existe).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL, ej. "https://example.com"' } },
      required: ['url']
    },
    execute: async (args, ctx) => {
      try {
        const url = String(args?.url || '').trim();
        if (!url) {
          return { ok: false, output: '', error: 'url vacía: pasá una URL' };
        }
        if (url.length > BROWSER_URL_MAX) {
          return { ok: false, output: '', error: `url demasiado larga (máx ${BROWSER_URL_MAX} chars)` };
        }
        return await correrAb(['open', url], { timeoutMs: timeouts.openMs, ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_snapshot',
    description: 'Árbol de accesibilidad de la página (refs @eN para click/type).',
    parameters: {
      type: 'object',
      properties: { interactivas: { type: 'boolean', description: 'true = solo elementos interactivos (-i)' } },
      required: []
    },
    execute: async (args, ctx) => {
      try {
        const v = args?.interactivas;
        const solo = v === true || v === 1 || v === 'true' || v === 'sí' || v === 'si';
        return await correrAb(solo ? ['snapshot', '-i'] : ['snapshot'], { ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_click',
    description: 'Clic en un elemento de la página (ref @eN del snapshot o selector).',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Ref @eN o selector, ej. "@e1"' } },
      required: ['ref']
    },
    execute: async (args, ctx) => {
      try {
        const ref = String(args?.ref || '').trim();
        if (!ref) {
          return { ok: false, output: '', error: 'ref vacío: pasá un @eN del snapshot' };
        }
        if (ref.length > BROWSER_REF_MAX) {
          return { ok: false, output: '', error: `ref demasiado largo (máx ${BROWSER_REF_MAX} chars)` };
        }
        return await correrAb(['click', ref], { ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_type',
    description: 'Escribe texto en un campo de la página.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref @eN o selector del campo' },
        texto: { type: 'string', description: 'Texto a escribir' }
      },
      required: ['ref', 'texto']
    },
    execute: async (args, ctx) => {
      try {
        const ref = String(args?.ref || '').trim();
        const texto = String(args?.texto ?? '');
        if (!ref) {
          return { ok: false, output: '', error: 'ref vacío: pasá un @eN del snapshot' };
        }
        if (!texto) {
          return { ok: false, output: '', error: 'texto vacío: no hay nada que escribir' };
        }
        if (ref.length > BROWSER_REF_MAX) {
          return { ok: false, output: '', error: `ref demasiado largo (máx ${BROWSER_REF_MAX} chars)` };
        }
        if (texto.length > BROWSER_TYPE_MAX) {
          return { ok: false, output: '', error: `texto demasiado largo (máx ${BROWSER_TYPE_MAX} chars)` };
        }
        return await correrAb(['type', ref, texto], { ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_eval',
    description: 'Ejecuta JavaScript en la página (máx 2000 chars) y devuelve el resultado.',
    parameters: {
      type: 'object',
      properties: { js: { type: 'string', description: 'Código JS, ej. "document.title"' } },
      required: ['js']
    },
    execute: async (args, ctx) => {
      try {
        const js = String(args?.js ?? '');
        if (!js.trim()) {
          return { ok: false, output: '', error: 'js vacío: pasá código para evaluar' };
        }
        if (js.length > BROWSER_EVAL_MAX) {
          return { ok: false, output: '', error: `js demasiado largo (máx ${BROWSER_EVAL_MAX} chars): achicalo o partilo` };
        }
        // SIEMPRE por stdin (--stdin): el JS con comillas/saltos nunca
        // toca argv ni shell.
        return await correrAb(['eval', '--stdin'], { stdinData: js, ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_shot',
    description: 'Captura la página a shots/<nombre>.png dentro del proyecto. Es entregable: el modelo no la ve.',
    parameters: {
      type: 'object',
      properties: { nombre: { type: 'string', description: 'Nombre relativo, ej. "shots/home" (default auto)' } },
      required: []
    },
    execute: async (args, ctx) => {
      try {
        const companyId = ctx?.companyId;
        const slug = ctx?.slug || 'general';
        if (!companyId) {
          return { ok: false, output: '', error: 'falta companyId en el contexto' };
        }
        const pedido = String(args?.nombre || '').trim();
        if (pedido.length > BROWSER_NOMBRE_MAX) {
          return { ok: false, output: '', error: `nombre demasiado largo (máx ${BROWSER_NOMBRE_MAX} chars)` };
        }
        let rel;
        if (!pedido) {
          const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
          rel = `shots/browser-${ts}.png`;
        } else {
          rel = pedido;
          if (!path.extname(rel)) rel += '.png';
        }
        let destino;
        try {
          destino = safeWorkspacePath(companyId, slug, rel);
        } catch (error) {
          return { ok: false, output: '', error: `nombre inválido: ${errorClaro(error)}` };
        }
        await fs.mkdir(path.dirname(destino), { recursive: true });
        // Un solo posicional con path absoluto: ab lo toma como destino
        // (ver `agent-browser screenshot --help`: `screenshot ./x.png`).
        const r = await correrAb(['screenshot', destino], { ctx });
        if (!r.ok) return r;
        return { ok: true, output: `captura ${rel}` };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'browser_close',
    description: 'Cierra el Chrome de la sesión del equipo.',
    parameters: { type: 'object', properties: {} },
    execute: async (args, ctx) => {
      try {
        return await correrAb(['close'], { ctx });
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  return [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_eval',
    'browser_shot',
    'browser_close'
  ];
}
