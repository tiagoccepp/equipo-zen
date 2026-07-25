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
    return 'Error desconocido';
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
