// Manos outreach (Track D, 09/11): borradores + cola con gate de Tito.
//
// outreach_draft: escribe workspace/outreach/<fecha>-<canal>.md (frontmatter
//   + cuerpo) y devuelve el path. Siempre permitido: redactar no envía nada.
// outreach_send: NUNCA afirma envío real. Sin ctx.aprobadoOutreach===true
//   rechaza; con él, encola en workspace/outbox/<base>.ready.json para
//   entrega MANUAL (v1 no tiene conectores SMTP/API).
// El contrato aprobadoOutreach (brief → opts → turn → ctx) lo cablea main;
// acá solo se LEE ctx.aprobadoOutreach con igualdad estricta.
//
// Registro diferido: registerOutreachTools() SOLO se ejecuta cuando main la
// llama (seguro en ciclo ESM, mismo patrón que manos-browser).

import fs from 'node:fs/promises';
import path from 'node:path';

import { registerTool } from './manos.js';
import { safeWorkspacePath } from './workforce.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIR_DRAFTS = 'outreach';
const DIR_OUTBOX = 'outbox';
const CUERPO_MAX = 20000;
const PARA_MAX = 300;

function ctxWs(ctx) {
  const companyId = ctx?.companyId;
  const slug = ctx?.slug || 'general';
  if (!companyId) {
    throw new Error('falta companyId en el contexto');
  }
  return { companyId, slug };
}

function errorClaro(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 300);
}

function fechaHoy() {
  return new Date().toISOString().slice(0, 10);
}

// 'Email' → 'email', 'WhatsApp!!' → 'whatsapp'. Vacío si no queda nada.
function sanearCanal(canal) {
  return String(canal || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function armarFrontmatter({ canal, para, asunto, fecha, cuerpo }) {
  return [
    '---',
    `canal: ${canal}`,
    `para: ${JSON.stringify(para)}`,
    `asunto: ${JSON.stringify(asunto || '')}`,
    `fecha: ${fecha}`,
    '---',
    '',
    cuerpo,
    ''
  ].join('\n');
}

function parsearFrontmatter(texto) {
  const m = String(texto || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return null;
  }
  const campos = {};
  for (const linea of m[1].split('\n')) {
    const kv = linea.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    try {
      campos[kv[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      campos[kv[1]] = raw;
    }
  }
  return { campos, cuerpo: (m[2] || '').trim() };
}

async function existe(ruta) {
  try {
    await fs.access(ruta);
    return true;
  } catch {
    return false;
  }
}

// rel base → rel libre (sufijo -2, -3… si ya existe). Evita pisar borradores
// del mismo día/canal.
async function relLibre(companyId, slug, relBase) {
  const ext = path.extname(relBase);
  const sinExt = relBase.slice(0, -ext.length);
  let rel = relBase;
  for (let n = 2; n < 100; n += 1) {
    const abs = safeWorkspacePath(companyId, slug, rel);
    if (!await existe(abs)) {
      return rel;
    }
    rel = `${sinExt}-${n}${ext}`;
  }
  throw new Error('demasiados archivos con el mismo nombre');
}

// outbox/<base>.ready.json libre: el sufijo va ANTES de .ready.json para
// que TODO lo encolado matchee el glob *.ready.json (X-2.ready.json, jamás
// X.ready-2.json).
async function relOutboxLibre(companyId, slug, base) {
  let rel = `${DIR_OUTBOX}/${base}.ready.json`;
  for (let n = 2; n < 100; n += 1) {
    const abs = safeWorkspacePath(companyId, slug, rel);
    if (!await existe(abs)) {
      return rel;
    }
    rel = `${DIR_OUTBOX}/${base}-${n}.ready.json`;
  }
  throw new Error('demasiados archivos con el mismo nombre');
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function registerOutreachTools() {
  registerTool({
    name: 'outreach_draft',
    description: 'Redacta un borrador de outreach (NO envía). Lo guarda en outreach/<fecha>-<canal>.md.',
    parameters: {
      type: 'object',
      properties: {
        canal: { type: 'string', description: 'email, whatsapp, linkedin…' },
        para: { type: 'string', description: 'destinatario (nombre, email o handle)' },
        asunto: { type: 'string', description: 'asunto (opcional)' },
        cuerpo: { type: 'string', description: 'cuerpo del mensaje' }
      },
      required: ['canal', 'para', 'cuerpo']
    },
    execute: async (args, ctx) => {
      try {
        const { companyId, slug } = ctxWs(ctx);
        const canal = sanearCanal(args?.canal);
        const para = String(args?.para || '').trim();
        const asunto = String(args?.asunto || '').trim();
        const cuerpo = String(args?.cuerpo || '').trim();
        if (!canal) {
          return { ok: false, output: '', error: 'canal vacío o inválido: pasá email, whatsapp, linkedin…' };
        }
        if (!para) {
          return { ok: false, output: '', error: 'falta para: destinatario (nombre, email o handle)' };
        }
        if (para.length > PARA_MAX) {
          return { ok: false, output: '', error: `para demasiado largo (máx ${PARA_MAX} chars)` };
        }
        if (!cuerpo) {
          return { ok: false, output: '', error: 'falta cuerpo: el mensaje no puede ir vacío' };
        }
        if (cuerpo.length > CUERPO_MAX) {
          return { ok: false, output: '', error: `cuerpo demasiado largo (máx ${CUERPO_MAX} chars)` };
        }
        const fecha = fechaHoy();
        const rel = await relLibre(companyId, slug, `${DIR_DRAFTS}/${fecha}-${canal}.md`);
        const target = safeWorkspacePath(companyId, slug, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, armarFrontmatter({ canal, para, asunto, fecha, cuerpo }), 'utf-8');
        return { ok: true, output: `borrador ${rel}` };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });

  registerTool({
    name: 'outreach_send',
    description: 'Encola un borrador para entrega MANUAL (NO envía solo: necesita OK explícito de Tito por voz a Pablo).',
    parameters: {
      type: 'object',
      properties: { draft: { type: 'string', description: 'path del borrador, ej. "outreach/2026-11-09-email.md"' } },
      required: ['draft']
    },
    execute: async (args, ctx) => {
      try {
        // Gate PRIMERO y estricto: solo true booleano aprueba. 'sí', 1 o
        // cualquier truthy NO alcanzan (el OK es de Tito por voz, no un
        // default optimista).
        if (ctx?.aprobadoOutreach !== true) {
          return {
            ok: false,
            output: '',
            error: 'falta OK explícito de Tito por voz a Pablo: este envío queda pendiente hasta que Tito lo apruebe'
          };
        }
        const { companyId, slug } = ctxWs(ctx);
        const relDraft = String(args?.draft || '').trim();
        if (!relDraft) {
          return { ok: false, output: '', error: 'falta draft: path del borrador (ej. "outreach/2026-11-09-email.md")' };
        }
        if (!relDraft.startsWith(`${DIR_DRAFTS}/`)) {
          return { ok: false, output: '', error: `draft fuera de ${DIR_DRAFTS}/: solo se encolan borradores propios` };
        }
        let texto = '';
        try {
          texto = await fs.readFile(safeWorkspacePath(companyId, slug, relDraft), 'utf-8');
        } catch (error) {
          return { ok: false, output: '', error: `no pude leer el borrador ${relDraft.slice(0, 80)}: ${errorClaro(error)}` };
        }
        const parsed = parsearFrontmatter(texto);
        const canal = String(parsed?.campos?.canal || '').trim();
        const para = String(parsed?.campos?.para || '').trim();
        if (!parsed || !canal || !para) {
          return { ok: false, output: '', error: `borrador sin frontmatter válido (canal/para): ${relDraft.slice(0, 80)}` };
        }
        const base = path.basename(relDraft, path.extname(relDraft));
        const relOut = await relOutboxLibre(companyId, slug, base);
        const target = safeWorkspacePath(companyId, slug, relOut);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const payload = {
          canal,
          para,
          asunto: String(parsed.campos.asunto || ''),
          fecha: String(parsed.campos.fecha || fechaHoy()),
          draft: relDraft,
          cuerpo: parsed.cuerpo,
          aprobado: true,
          encolado: new Date().toISOString()
        };
        await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        // OJO el wording: "encolado", jamás "enviado". v1 = entrega manual.
        return {
          ok: true,
          output: `encolado ${relOut} (conector ${canal}: entrega manual v1 — NO enviado todavía, pendiente de entrega manual)`
        };
      } catch (error) {
        return { ok: false, output: '', error: errorClaro(error) };
      }
    }
  });
}
