// Manos canvas (Track D, 09/11): herramientas canvas_* sobre openpencil.js.
//
// El modelo NO corre `op` a mano: estas tools envuelven abrirDiseno /
// leerTokensDelDiseno / tokensComoCodigo / cerrarDiseno con el workspace del
// ctx (mismo resolvedor que manos.js: projectDir via companyId/slug).
// Sin binarios → {ok:false} con hint de instalación, nunca throw.
//
// Registro diferido: registerCanvasTools() SOLO se ejecuta cuando main la
// llama (seguro en ciclo ESM, mismo patrón que manos-browser).

import { registerTool } from './manos.js';
import * as openpencil from './openpencil.js';
import { projectDir } from './workforce.js';

// ---------------------------------------------------------------------------
// Inyección para tests (mismo precedente que `computer` en manos.js)
// ---------------------------------------------------------------------------

const opDefaults = {
  disponible: (...args) => openpencil.disponible(...args),
  motivoNoDisponible: (...args) => openpencil.motivoNoDisponible(...args),
  abrirDiseno: (...args) => openpencil.abrirDiseno(...args),
  cerrarDiseno: (...args) => openpencil.cerrarDiseno(...args),
  leerTokensDelDiseno: (...args) => openpencil.leerTokensDelDiseno(...args),
  tokensComoCodigo: (...args) => openpencil.tokensComoCodigo(...args)
};

export const op = { ...opDefaults };
export function _setOpenpencil(over) { Object.assign(op, over || {}); }
export function _resetOpenpencil() { Object.assign(op, opDefaults); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HINT_INSTALAR = 'scripts/instalar-openpencil.sh';

function ctxDir(ctx) {
  const companyId = ctx?.companyId;
  const slug = ctx?.slug || 'general';
  if (!companyId) {
    throw new Error('falta companyId en el contexto');
  }
  return { dir: projectDir(companyId, slug), clave: `${companyId}/${slug}` };
}

function errorClaro(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 300);
}

function noDisponible() {
  let motivo = '';
  try {
    motivo = String(op.motivoNoDisponible() || '');
  } catch {
    motivo = '';
  }
  if (!motivo) {
    motivo = 'OpenPencil no disponible.';
  }
  if (!motivo.includes('instalar-openpencil')) {
    motivo += ` Instalalo con ${HINT_INSTALAR}.`;
  }
  return { ok: false, output: '', error: motivo.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function registerCanvasTools() {
  registerTool({
    name: 'canvas_abrir',
    description: 'Abre el diseño OpenPencil del proyecto (diseno.op). Necesita binarios instalados.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      try {
        if (!op.disponible()) {
          return noDisponible();
        }
        const { dir, clave } = ctxDir(ctx);
        const r = await op.abrirDiseno(dir, clave);
        if (!r?.ok) {
          return { ok: false, output: '', error: `no pude abrir el diseño: ${errorClaro(r?.motivo)}` };
        }
        return {
          ok: true,
          output: r.yaEstaba
            ? `diseño abierto (puerto ${r.puerto}, ya estaba)`
            : `diseño abierto (puerto ${r.puerto})`
        };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'canvas_tokens',
    description: 'Lee los tokens del diseño (diseno.op). Sin tokens = la diseñadora aún no definió variables.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      try {
        if (!op.disponible()) {
          return noDisponible();
        }
        const { dir } = ctxDir(ctx);
        const vars = await op.leerTokensDelDiseno(dir);
        if (!vars || Object.keys(vars).length === 0) {
          return { ok: true, output: '(sin tokens todavía: diseno.op no existe o no define variables)' };
        }
        return { ok: true, output: JSON.stringify(vars, null, 2) };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'canvas_codigo',
    description: 'Genera el código de tokens desde el diseño (tokensComoCodigo). stack: web (default), movil-rn, android.',
    parameters: {
      type: 'object',
      properties: { stack: { type: 'string', description: 'web, movil-rn o android (default web)' } },
      required: []
    },
    execute: async (args, ctx) => {
      try {
        if (!op.disponible()) {
          return noDisponible();
        }
        const { dir } = ctxDir(ctx);
        const stack = String(args?.stack || 'web').trim() || 'web';
        const vars = await op.leerTokensDelDiseno(dir);
        if (!vars || Object.keys(vars).length === 0) {
          return { ok: false, output: '', error: 'sin tokens en diseno.op: la diseñadora todavía no definió variables' };
        }
        const gen = op.tokensComoCodigo(vars, stack);
        if (!gen) {
          return { ok: false, output: '', error: `no pude generar código para stack ${stack.slice(0, 40)}` };
        }
        return { ok: true, output: `${gen.archivo}:\n${gen.contenido}` };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'canvas_cerrar',
    description: 'Cierra el servidor de diseño OpenPencil del proyecto.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      try {
        if (!op.disponible()) {
          return noDisponible();
        }
        const { dir, clave } = ctxDir(ctx);
        await op.cerrarDiseno(dir, clave);
        return { ok: true, output: 'diseño cerrado' };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });
}
