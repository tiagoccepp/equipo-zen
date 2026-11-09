// Limpia artefactos del modelo (fences, prefijo de nombre) SIN decidir
// silencio: los tags [TAREA_*] se conservan para que el parser de tareas
// corra incluso cuando la respuesta hablada es SILENCIO.
export function cleanAgentText(value, agentName = '') {
  value = stripForeignScript(value);
  let text = String(value || '').trim();
  text = text.replace(/^```(?:json|text|markdown)?/i, '').replace(/```$/i, '').trim();
  if (agentName) {
    text = text.replace(new RegExp(`^${escapeRegExp(agentName)}\\s*:\\s*`, 'i'), '').trim();
  }
  text = text.replace(/^(julio|tomasa)\s*:\s*/i, '').trim();
  return text;
}

// MiniMax cuela caracteres chinos/japoneses en medio de una frase en español
// (~1% de las respuestas, medido). Las reglas del prompt lo bajan pero no lo
// eliminan, así que se limpian del texto: se reemplaza cada tramo por un
// espacio —no por vacío— para no pegar dos palabras, y la puntuación de ancho
// completo pasa a su equivalente.
const ESCRITURA_AJENA = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
const PUNTUACION_ANCHA = { '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '（': '(', '）': ')', '、': ',' };

export function stripForeignScript(value) {
  let text = String(value || '');
  if (!text) {
    return text;
  }
  text = text.replace(/[，。！？：；（）、]/g, (c) => PUNTUACION_ANCHA[c] || ' ');
  text = text.replace(ESCRITURA_AJENA, ' ');
  // El espacio que queda no puede duplicarse ni despegar la puntuación.
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
}

export function stripTaskTags(value) {
  return String(value || '').replace(/\[TAREA_[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

// Filtro incremental de etiquetas para el texto que se muestra EN VIVO.
// Las etiquetas [TAREA_CREAR: ...] llegan partidas entre deltas del stream;
// sin esto se ven un instante en pantalla y desaparecen al terminar el turno,
// que a la vista es un glitch.
const TAG_PREFIX = '[TAREA_';
const MAX_HELD = 300;

// ¿Lo retenido todavía puede terminar siendo una etiqueta? Mientras coincida
// con el principio de "[TAREA_", o ya lo tenga y falte el cierre, se espera.
function couldBeTag(held) {
  if (held.length > MAX_HELD) {
    return false;
  }
  return held.length <= TAG_PREFIX.length
    ? TAG_PREFIX.startsWith(held)
    : held.startsWith(TAG_PREFIX);
}

export function createTagFilter() {
  let buffer = '';

  const drain = (final) => {
    let out = '';
    for (;;) {
      const open = buffer.indexOf('[');
      if (open === -1) {
        out += buffer;
        buffer = '';
        return out;
      }
      out += buffer.slice(0, open);
      buffer = buffer.slice(open);

      const close = buffer.indexOf(']');
      if (close === -1) {
        // Sin cierre todavía: se retiene mientras pueda ser el principio de
        // una etiqueta; si ya se sabe que no lo es, se suelta.
        if (final || !couldBeTag(buffer)) {
          out += buffer[0];
          buffer = buffer.slice(1);
          continue;
        }
        return out;
      }

      const candidate = buffer.slice(0, close + 1);
      buffer = buffer.slice(close + 1);
      if (!/^\[TAREA_[A-Za-z]+\s*:/i.test(candidate)) {
        out += candidate;
      }
    }
  };

  return {
    push(delta) {
      buffer += String(delta || '');
      return drain(false);
    },
    flush() {
      const rest = drain(true);
      buffer = '';
      return rest;
    }
  };
}

export function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGreetingTurn(normalized) {
  if (!/\b(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|que tal|como estas|como estan|como andan|como va|como les va|hey|che|buenas)\b/.test(normalized)) {
    return false;
  }

  const leftover = normalized
    .replace(/\?/g, ' ')
    .replace(/\b(hola|buenas|buenos|buen|dias|dia|tardes|noches|que|tal|como|estas|estan|andan|va|les|a|al|el|la|los|las|equipo|ustedes|todos|ambos|dos|julio|tomasa|y|chicos|gente|amigos|compas|compañeros|seniores|senor|senora|doc|profe|master|bro|bros|familia|pibes|pibe|chicas|chico)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return leftover.length === 0;
}

export function isSilenceResponse(value) {
  return normalize(value) === 'silencio';
}

// El texto normalizado solo contiene letras, dígitos, espacios y '?', así
// que los límites de palabra son espacio, '?', inicio y fin. Con esto
// "sistema" ya no matchea dentro de "sistemática".
export function includesTerm(text, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) {
    return false;
  }
  const pattern = new RegExp(`(?:^|[\\s?])${escapeRegExp(normalizedTerm)}(?=[\\s?]|$)`);
  return pattern.test(text);
}

export function getMentionIndex(text, aliases) {
  let best = -1;
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias) {
      continue;
    }
    const pattern = new RegExp(`(?:^|[\\s?])(${escapeRegExp(normalizedAlias)})(?=[\\s?]|$)`);
    const match = pattern.exec(text);
    if (match) {
      const index = match.index + (match[0].length - match[1].length);
      if (best === -1 || index < best) {
        best = index;
      }
    }
  }
  return best;
}

export function getErrorText(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.stack || error.message || JSON.stringify(error);
}

export function getShortError(error) {
  return getErrorText(error).split('\n')[0].slice(0, 160);
}

export function cleanTranscript(value) {
  return String(value || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(transcripcion|transcripción)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Partes del stream (Fase 1: el LLM dueño de lo expresivo) ─────────────
// El modelo marca su stream con tags (case-insensitive):
//   [PIENSO]...[/PIENSO]  privado: NUNCA se muestra ni se habla
//   [AVANCE]...[/AVANCE]  progreso: se muestra en UI, NUNCA se habla
//   <think>...</think>    thinking nativo: igual que PIENSO
//   texto plano           hablado + mostrado (default: lo que no es tag se escucha)

export function stripPrivateBlocks(value) {
  let text = String(value || '');
  text = text.replace(/\[PIENSO\][\s\S]*?(\[\/PIENSO\]|$)/gi, ' ');
  text = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ');
  return text;
}

export function stripProgressBlocks(value) {
  return String(value || '').replace(/\[AVANCE\][\s\S]*?(\[\/AVANCE\]|$)/gi, ' ');
}

// Última defensa antes del TTS: pela TODO lo no-hablable. Si algo pasa,
// el usuario lo escucha — este filtro no puede fallar abierto.
export function stripSpeechLeaks(value) {
  let text = stripPrivateBlocks(stripProgressBlocks(value));
  text = stripTaskTags(text);
  // Restos de tags en mayúsculas ([HABLA], [/AVANCE] huérfanos): fuera.
  // Minúsculas entre corchetes se conservan (pueden ser prosa).
  text = text.replace(/\[\/?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ _/-]*\]/g, ' ');
  // Restos de tags angulados con solo letras (<think> huérfano). <3 sobrevive.
  text = text.replace(/<\/?[A-Za-z][A-Za-z]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

const PART_TAG_RE = /\[(PIENSO|AVANCE)\]|\[\/(PIENSO|AVANCE)\]|<think>|<\/think>/i;

function partialTagTail(buffer) {
  // ¿Termina el buffer con algo que podría ser el principio de un tag?
  // Se retiene hasta decidir (evita hablar "[PIE" suelto).
  const m1 = buffer.match(/\[[A-Za-z/]{0,9}$/);
  if (m1) {
    return m1[0].length;
  }
  const m2 = buffer.match(/<[A-Za-z/]{0,8}$/);
  if (m2) {
    return m2[0].length;
  }
  return 0;
}

// Parser incremental: los tags llegan partidos entre deltas. Callbacks:
// onSpeak(texto hablable), onThink(contenido, cerrado?), onProgress(texto).
// Todo tag desconocido pasa como texto (fail-open a hablar).
export function createPartsParser({ onSpeak, onThink, onProgress }) {
  let buffer = '';
  let mode = 'speak'; // speak | think | progress
  let held = '';

  const emitHeld = (closed) => {
    if (mode === 'think') {
      if (held) {
        onThink?.(held, closed);
      }
    } else if (mode === 'progress') {
      if (held.trim()) {
        onProgress?.(held);
      }
    }
    held = '';
  };

  const route = (text) => {
    if (!text) {
      return;
    }
    if (mode === 'speak') {
      onSpeak?.(text);
    } else {
      held += text;
    }
  };

  const drain = (final) => {
    for (;;) {
      const m = buffer.match(PART_TAG_RE);
      if (!m || m.index === undefined) {
        let text = buffer;
        buffer = '';
        if (!final) {
          const hold = partialTagTail(text);
          if (hold > 0) {
            buffer = text.slice(text.length - hold);
            text = text.slice(0, text.length - hold);
          }
        }
        route(text);
        return;
      }
      route(buffer.slice(0, m.index));
      const tag = m[0].toUpperCase();
      buffer = buffer.slice(m.index + m[0].length);
      if (tag === '[PIENSO]' || tag === '<THINK>') {
        emitHeld(true);
        mode = 'think';
      } else if (tag === '[AVANCE]') {
        emitHeld(true);
        mode = 'progress';
      } else {
        // Cierre (o cierre huérfano): vuelta a habla.
        emitHeld(true);
        mode = 'speak';
      }
    }
  };

  return {
    push(delta) {
      buffer += String(delta || '');
      drain(false);
    },
    flush() {
      drain(true);
      // Sin cerrar al final: el think se descarta (nunca se habla),
      // el avance se muestra igual.
      emitHeld(false);
      mode = 'speak';
    }
  };
}
