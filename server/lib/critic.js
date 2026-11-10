// critic.js — peer review between specialists (track C, team flow).
//
// Hard rule (master plan protocol 5): ONLY emits a review when there is a concrete
// improvement (what + why + how). No improvement = structured silence.
// All pure and deterministic: no I/O, no LLM. The specialist's LLM proposes;
// this validates/structures against per-role checklists.
//
// Review(test): tests/flujo-tester.test.mjs

import { normalize } from './text.js';

export const SEVERIDADES = ['bug', 'mejora', 'nit'];
const ORDEN_SEV = { bug: 0, mejora: 1, nit: 2 };
const DEDUP_JACCARD = 0.6;

// Checklist = concrete signals the reviewer role can detect.
// Each signal: id, severidad, que/porque/como (templates; {ev} = evidence),
// test(texto, norm) -> string|null (returns quoted evidence or null).
// `como` includes concrete fix steps. No match = no improvement = silence.
export const CHECKLISTS_ROL = {
  backend: [
    {
      id: 'todo-pendiente',
      severidad: 'mejora',
      que: 'Quedó un TODO/FIXME sin resolver en la entrega',
      porque: 'un TODO en entregado es deuda que nadie trackea y se pudre',
      como: 'Resolverlo ahora, o convertirlo en tarea trackeada con dueño y sacarlo del código entregado. Evidencia: "{ev}"',
      test: (t) => cita(t, /\b(TODO|FIXME|XXX|HACK)\b.{0,80}/i)
    },
    {
      id: 'error-silenciado',
      severidad: 'bug',
      que: 'Error silenciado (catch vacío o que solo loguea)',
      porque: 'los errores tragados vuelven como bugs “imposibles de reproducir”',
      como: 'Propagar el error, mapearlo a respuesta de error explícita, o justificar con comentario por qué se ignora. Evidencia: "{ev}"',
      test: (t) => cita(t, /catch\s*\([^)]*\)\s*\{\s*(console\.[a-z]+\([^)]*\)\s*;?\s*)?\}/)
    },
    {
      id: 'query-n1',
      severidad: 'mejora',
      que: 'Posible N+1: query/await dentro de un loop',
      porque: 'escala lineal con los datos y mata la latencia en producción',
      como: 'Batch: traer todo con una sola query (IN / join) o Promise.all fuera del loop. Evidencia: "{ev}"',
      test: (t) => cita(t, /for\s*\([^)]*\)\s*\{[^}]{0,200}await\s+\w+/s) || cita(t, /\.forEach\([^)]*async/s)
    },
    {
      id: 'sin-validacion',
      severidad: 'bug',
      que: 'Input externo usado sin validación visible',
      porque: 'input sin validar = crash o inyección esperando turno',
      como: 'Validar tipo/rango/largo al borde (zod/manual) y rechazar con 400 + mensaje. Evidencia: "{ev}"',
      test: (t) => cita(t, /req\.(body|query|params)(\.\w+)+\s*[^\n]*;/i) && /valid|zod|schema|assert/i.test(t) ? null : cita(t, /req\.(body|query|params)(\.\w+)+/i)
    }
  ],
  frontend: [
    {
      id: 'sin-estado-carga',
      severidad: 'mejora',
      que: 'Fetch/render sin estado de carga ni error',
      porque: 'el usuario ve pantalla vacía o rota mientras carga',
      como: 'Agregar loading + error + empty states donde haya fetch. Evidencia: "{ev}"',
      test: (t) => /fetch\(|useEffect|axios/i.test(t) && !/loading|isLoading|skeleton|cargando/i.test(t)
        ? 'fetch sin estado de carga visible' : null
    },
    {
      id: 'key-faltante',
      severidad: 'bug',
      que: 'Render de lista sin key estable',
      porque: 'sin key React re-renderiza mal y mezcla estado entre filas',
      como: 'Agregar key={item.id} con id estable (nunca index). Evidencia: "{ev}"',
      test: (t) => cita(t, /\.map\(\s*\([^)]*\)\s*=>\s*<\w+[^>]*>/s) && !/key=/.test(t) ? 'map a JSX sin key=' : null
    },
    {
      id: 'any-ts',
      severidad: 'nit',
      que: 'Uso de `any` en TypeScript',
      porque: 'apaga el type-check justo donde más sirve',
      como: 'Tipar explícito o `unknown` + narrowing. Evidencia: "{ev}"',
      test: (t) => cita(t, /:\s*any\b/)
    }
  ],
  diseño: [
    {
      id: 'sin-responsive',
      severidad: 'mejora',
      que: 'Sin mención de responsive/mobile',
      porque: 'más de la mitad del tráfico es mobile; desktop-only es entrega a medias',
      como: 'Definir breakpoints (mínimo 390px y 768px) y verificar que nada se rompa ni se solape. Evidencia: "{ev}"',
      test: (t) => /layout|pantalla|diseño|css|maqueta|mockup/i.test(t) && !/responsive|mobile|breakpoint|390|768/i.test(t)
        ? 'habla de layout sin mencionar responsive' : null
    },
    {
      id: 'sin-contraste',
      severidad: 'nit',
      que: 'Colores sin chequeo de contraste',
      porque: 'texto lindo ilegible = texto inútil (y falla accesibilidad)',
      como: 'Pasar pares texto/fondo por WCAG AA (4.5:1) y ajustar. Evidencia: "{ev}"',
      test: (t) => /color|paleta|#([0-9a-f]{3,6})\b/i.test(t) && !/contraste|contrast|wcag|aa\b/i.test(t)
        ? 'define colores sin mencionar contraste' : null
    },
    {
      id: 'sin-estados',
      severidad: 'mejora',
      que: 'Faltan estados (hover/disabled/error/empty)',
      porque: 'un componente sin estados se ve roto en la mitad de los casos reales',
      como: 'Diseñar hover, focus, disabled, error y empty para cada interactivo. Evidencia: "{ev}"',
      test: (t) => /componente|botón|boton|formulario|input/i.test(t) && !/hover|disabled|error|empty|estado/i.test(t)
        ? 'describe componentes sin estados' : null
    }
  ],
  copy: [
    {
      id: 'muletilla-ia',
      severidad: 'mejora',
      que: 'Muletillas de IA en el texto',
      porque: 'el lector las huele a 10 metros y la marca pierde credibilidad',
      como: 'Reescribir con voz activa y palabras concretas; prohibidas: robusto, sin fisuras, de vanguardia, aprovechar, profundizar, perfecto. Evidencia: "{ev}"',
      test: (t) => cita(t, /\b(robusto|sin fisuras|de vanguardia|aprovech(ar|a|ando)|profundiz(ar|a)|perfecto|leverage|robust|seamless|cutting-edge|delve)\b.{0,40}/i)
    },
    {
      id: 'voz-pasiva',
      severidad: 'nit',
      que: 'Voz pasiva / nominalización que afloja el texto',
      porque: 'la pasiva esconde quién hace qué y el texto suena burocrático',
      como: 'Pasar a voz activa con sujeto claro. Evidencia: "{ev}"',
      test: (t) => cita(t, /\b(fue|fueron|será|serán|es|son)\s+\w+(ado|ada|ados|adas|ido|ida|idos|idas)\b.{0,30}/)
    },
    {
      id: 'lorem-placeholder',
      severidad: 'bug',
      que: 'Placeholder sin reemplazar (lorem / XXX / “texto aquí”)',
      porque: 'sale a producción y queda para siempre en la screenshot de alguien',
      como: 'Reemplazar por el texto final o marcar explícito como pendiente con dueño. Evidencia: "{ev}"',
      test: (t) => cita(t, /\b(lorem ipsum|texto aqu[ií]|t[ií]tulo aqu[ií]|XXX+)\b.{0,30}/i)
    }
  ],
  marketing: [
    {
      id: 'sin-cta',
      severidad: 'mejora',
      que: 'Pieza sin llamado a la acción claro',
      porque: 'interés sin CTA = interés perdido',
      como: 'Un CTA único, visible y con verbo (“Agendá”, “Probá gratis”). Evidencia: "{ev}"',
      test: (t) => /landing|pieza|campaña|anuncio|hero|página/i.test(t) && !/cta|llamado|botón|boton|agendá|probá|contact|empez/i.test(t)
        ? 'describe pieza sin CTA visible' : null
    },
    {
      id: 'sin-metrica',
      severidad: 'nit',
      que: 'Propuesta sin métrica de éxito',
      porque: 'sin métrica no se sabe si funcionó ni qué iterar',
      como: 'Definir 1 métrica (CTR, conversión, replies) + objetivo numérico. Evidencia: "{ev}"',
      test: (t) => /campaña|propuesta|estrategia|lanzamiento/i.test(t) && !/%|ctr|conversi|métrica|metrica|objetivo|kpi/i.test(t)
        ? 'propuesta sin métrica' : null
    }
  ],
  ventas: [
    {
      id: 'sin-siguiente-paso',
      severidad: 'mejora',
      que: 'Mensaje/propuesta sin siguiente paso concreto',
      porque: 'si el prospecto tiene que pensar qué sigue, no sigue nada',
      como: 'Cerrar con fecha/hora propuesta o pregunta de sí/no. Evidencia: "{ev}"',
      test: (t) => /propuesta|mensaje|mail|seguimiento|prospecto/i.test(t) && !/mañana|llamada|reuni|agend|fecha|cuándo|cuando|sí o no/i.test(t)
        ? 'mensaje comercial sin siguiente paso' : null
    }
  ],
  data: [
    {
      id: 'sin-tamano',
      severidad: 'nit',
      que: 'Análisis sin tamaño de muestra',
      porque: 'un % sin N es decoración, no dato',
      como: 'Reportar N junto a cada métrica + período cubierto. Evidencia: "{ev}"',
      test: (t) => /%|por ciento|promedio|correlación|métrica/i.test(t) && !/\bn\s*=|muestra|registros|filas|casos|n=\d/i.test(t)
        ? 'menciona métricas sin tamaño de muestra' : null
    },
    {
      id: 'numero-sin-fuente',
      severidad: 'mejora',
      que: 'Número afirmado sin fuente ni método',
      porque: 'dato sin fuente no se puede defender ni auditar',
      como: 'Citar fuente + query/método reproducible. Evidencia: "{ev}"',
      test: (t) => cita(t, /\b\d+(\.\d+)?\s*%/) && !/fuente|query|sql|según|metodolog/i.test(t)
        ? 'porcentaje sin fuente' : null
    }
  ],
  devops: [
    {
      id: 'secreto-codigo',
      severidad: 'bug',
      que: 'Posible secreto hardcodeado',
      porque: 'un secret en código es un incidente de seguridad con fecha',
      como: 'Mover a variable de entorno / secret manager y rotar el valor expuesto. Evidencia: "{ev}"',
      test: (t) => cita(t, /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{6,}['"]/i)
    },
    {
      id: 'sin-healthcheck',
      severidad: 'mejora',
      que: 'Servicio/deploy sin healthcheck',
      porque: 'sin healthcheck el orquestador no sabe si estás vivo o zombie',
      como: 'Agregar endpoint /health + chequeo en el deploy. Evidencia: "{ev}"',
      test: (t) => /deploy|docker|service|servicio|contenedor/i.test(t) && !/health|healthcheck|\/health|readiness|liveness/i.test(t)
        ? 'habla de deploy sin healthcheck' : null
    }
  ]
};

function cita(texto, regex) {
  const m = String(texto || '').match(regex);
  if (!m) return null;
  return m[0].slice(0, 120).trim();
}

function tokenSet(value) {
  return new Set(normalize(value).split(' ').filter((t) => t.length > 2));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// Same improvement twice = 1. Key = que+como similarity (Jaccard ≥ 0.6,
// same threshold as learning.js). Keeps the most severe one.
export function dedup(mejoras) {
  const out = [];
  for (const m of mejoras) {
    const sig = tokenSet(`${m.que} ${m.como}`);
    const idx = out.findIndex((o) => jaccard(sig, tokenSet(`${o.que} ${o.como}`)) >= DEDUP_JACCARD);
    if (idx === -1) {
      out.push(m);
    } else if (ORDEN_SEV[m.severidad] < ORDEN_SEV[out[idx].severidad]) {
      out[idx] = m;
    }
  }
  return out;
}

function ordenarPorSeveridad(mejoras) {
  return [...mejoras].sort((a, b) => ORDEN_SEV[a.severidad] - ORDEN_SEV[b.severidad]);
}

// Pure review: entrega vs the reviewer role's checklist.
// entrega: { texto, autor?, rolAutor?, artefacto? }
// criterioRol: { rol, checklist? } — optional custom checklist, else CHECKLISTS_ROL[rol].
// -> { silencio: true, motivo } | { silencio: false, mejoras: [...] }
export function revisar(entrega, criterioRol = {}) {
  const texto = String(entrega?.texto || '');
  const rol = criterioRol?.rol || 'backend';
  const checklist = Array.isArray(criterioRol?.checklist) && criterioRol.checklist.length > 0
    ? criterioRol.checklist
    : (CHECKLISTS_ROL[rol] || []);
  if (texto.trim().length === 0 || checklist.length === 0) {
    return { silencio: true, motivo: 'sin_mejora_concreta' };
  }
  const norm = normalize(texto);
  const mejoras = [];
  for (const senal of checklist) {
    let ev = null;
    try {
      ev = typeof senal.test === 'function' ? senal.test(texto, norm) : null;
    } catch {
      ev = null;
    }
    if (!ev) continue;
    mejoras.push({
      id: senal.id,
      severidad: SEVERIDADES.includes(senal.severidad) ? senal.severidad : 'mejora',
      que: senal.que,
      porque: senal.porque,
      como: String(senal.como || '').replace('{ev}', ev),
      evidencia: ev
    });
  }
  const unicas = ordenarPorSeveridad(dedup(mejoras));
  if (unicas.length === 0) {
    return { silencio: true, motivo: 'sin_mejora_concreta' };
  }
  return { silencio: false, rol, mejoras: unicas };
}
