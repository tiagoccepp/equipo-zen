// Limpia artefactos del modelo (fences, prefijo de nombre) SIN decidir
// silencio: los tags [TAREA_*] se conservan para que el parser de tareas
// corra incluso cuando la respuesta hablada es SILENCIO.
export function cleanAgentText(value, agentName = '') {
  let text = String(value || '').trim();
  text = text.replace(/^```(?:json|text|markdown)?/i, '').replace(/```$/i, '').trim();
  if (agentName) {
    text = text.replace(new RegExp(`^${escapeRegExp(agentName)}\\s*:\\s*`, 'i'), '').trim();
  }
  text = text.replace(/^(julio|tomasa)\s*:\s*/i, '').trim();
  return text;
}

export function stripTaskTags(value) {
  return String(value || '').replace(/\[TAREA_[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
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
