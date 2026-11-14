// Capa de expresión verbal para el agente de voz: etiquetas de entrega
// ([slow], [soft]…) y muletillas ([laugh], [bueno]…) que el LLM escribe en su
// respuesta. Acá viven las reglas (bloque de system prompt), el parser único
// (texto limpio + eventos), el mapeo a TTS y la política anti-abuso.
//
// Contrato: las etiquetas son SIEMPRE opcionales. Si un motor de TTS no las
// soporta, parseExpressions las quita y el texto sigue siendo gramatical.
// Etiquetas desconocidas (ej. <div>, [divertido]) quedan literales: nunca se
// borra texto del usuario por parecerse a una etiqueta.

export const EXPRESSION_TAGS = Object.freeze({
  delivery: Object.freeze({
    soft: Object.freeze({ es: 'volumen bajo, cercano, casi al oído', en: 'lower volume, close and warm' }),
    emphasis: Object.freeze({ es: 'marcás una palabra o frase corta', en: 'stress one word or short phrase' }),
    slow: Object.freeze({ es: 'un poco más pausado', en: 'a bit slower' }),
    fast: Object.freeze({ es: 'un poco más rápido', en: 'a bit faster' })
  }),
  sound: Object.freeze({
    laugh: Object.freeze({ es: 'risa corta y genuina', en: 'short, genuine laugh' }),
    sigh: Object.freeze({ es: 'suspiro breve', en: 'short sigh' }),
    breath: Object.freeze({ es: 'respiro audible', en: 'audible breath' }),
    mm: Object.freeze({ es: 'asentimiento pensativo ("mmm")', en: 'thoughtful "mmm"' }),
    eh: Object.freeze({ es: 'duda suave ("eh…")', en: 'soft hesitation ("eh…")' }),
    bueno: Object.freeze({ es: 'arranque de frase ("bueno, …")', en: 'sentence opener ("bueno, …")' }),
    dale: Object.freeze({ es: 'acuerdo o empujón ("dale")', en: 'agreement or nudge ("dale")' }),
    claro: Object.freeze({ es: 'confirmación ("claro")', en: 'confirmation ("claro")' }),
    a_ver: Object.freeze({ es: 'apertura de atención ("a ver…")', en: 'attention opener ("a ver…")' })
  })
});

// nombre canónico → 'delivery' | 'sound'
const TAG_KIND = new Map();
for (const kind of Object.keys(EXPRESSION_TAGS)) {
  for (const name of Object.keys(EXPRESSION_TAGS[kind])) {
    TAG_KIND.set(name, kind);
  }
}

// Captura `[tag]` y `<tag>`, con espacios internos opcionales. El nombre puede
// llevar guión bajo (a_ver) pero no espacios ni dos puntos: `[laugh: mucho]` no
// es una etiqueta válida y se deja literal.
const TAG_SOURCE = '([\\[<])\\s*([A-Za-z][A-Za-z0-9_]*)\\s*([\\]>])';
const WORD_CHAR = /[\p{L}\p{N}]/u;

const DELIVERY_EFFECT = Object.freeze({
  slow: Object.freeze({ rate: '-10%' }),
  fast: Object.freeze({ rate: '+10%' }),
  soft: Object.freeze({ volume: '-12%' }),
  emphasis: Object.freeze({ volume: '+8%' })
});

function tagRegex() {
  // Instancia local: evita lastIndex compartido entre llamadas.
  return new RegExp(TAG_SOURCE, 'g');
}

function optionsOf(opts) {
  return opts && typeof opts === 'object' ? opts : {};
}

function tagNames(kind) {
  return Object.keys(EXPRESSION_TAGS[kind] || {});
}

function normalizeTagName(tag) {
  const clean = String(tag == null ? '' : tag)
    .trim()
    .replace(/^[\[<]+/, '')
    .replace(/[\]>]+$/, '')
    .toLowerCase();
  return clean || null;
}

function normalizeTurn(turnIndex) {
  const value = Number(turnIndex);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

// Limpieza posterior a quitar etiquetas: espacios dobles, espacio antes de
// puntuación de cierre y espacios al final de línea. No toca saltos de línea
// (el texto puede venir en varios párrafos).
function cleanText(value) {
  return value
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?…])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Quita las etiquetas conocidas del texto y devuelve los eventos en el orden
 * en que aparecen. `index` es la posición del `[`/`<` en el texto ORIGINAL
 * (antes de limpiar), así el llamador puede mapear eventos al audio o al log.
 *
 * - Acepta `[tag]` y `<tag>`, case-insensitive (`[LAUGH]` → `laugh`).
 * - Etiquetas desconocidas o con corchetes desparejados quedan literales.
 * - Si al quitar una etiqueta quedan dos caracteres de palabra pegados
 *   (`hola[laugh]mundo`), se inserta un espacio para no romper la gramática.
 * - null/undefined/vacío → `{ text: '', events: [] }`.
 */
export function parseExpressions(text) {
  if (text == null) {
    return { text: '', events: [] };
  }
  const raw = String(text);
  if (!raw) {
    return { text: '', events: [] };
  }

  const events = [];
  let out = '';
  let cursor = 0;

  for (const match of raw.matchAll(tagRegex())) {
    const open = match[1];
    const close = match[3];
    if ((open === '[' && close !== ']') || (open === '<' && close !== '>')) {
      continue;
    }
    const name = match[2].toLowerCase();
    const kind = TAG_KIND.get(name);
    if (!kind) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    out += raw.slice(cursor, start);
    const before = raw[start - 1] || '';
    const after = raw[end] || '';
    out += WORD_CHAR.test(before) && WORD_CHAR.test(after) ? ' ' : '';
    cursor = end;
    events.push({ kind, name, index: start });
  }

  out += raw.slice(cursor);
  events.sort((a, b) => a.index - b.index);
  return { text: cleanText(out), events };
}

/**
 * Describe las etiquetas para un idioma ('es' salvo que empiece con 'en').
 * `allowed` es una lista de nombres (con o sin corchetes); null/undefined deja
 * todas, y una lista vacía no deja ninguna.
 */
function resolveAllowed(allowed) {
  const all = { delivery: tagNames('delivery'), sound: tagNames('sound') };
  if (allowed == null) {
    return { allowed: all, restricted: false };
  }
  const list = (Array.isArray(allowed) ? allowed : [allowed])
    .map((value) => normalizeTagName(value))
    .filter(Boolean);
  const set = new Set(list);
  return {
    allowed: {
      delivery: all.delivery.filter((name) => set.has(name)),
      sound: all.sound.filter((name) => set.has(name))
    },
    restricted: true
  };
}

function hintFor(kind, name, english) {
  const hint = EXPRESSION_TAGS[kind]?.[name];
  if (!hint) {
    return '';
  }
  return english ? hint.en : hint.es;
}

function catalogLines(allowed, english) {
  const lines = [];
  if (allowed.delivery.length) {
    const items = allowed.delivery.map((name) => `[${name}] (${hintFor('delivery', name, english)})`);
    lines.push(english ? `- Delivery: ${items.join(', ')}` : `- Entrega (modulan la voz): ${items.join(', ')}`);
  }
  if (allowed.sound.length) {
    const items = allowed.sound.map((name) => `[${name}] (${hintFor('sound', name, english)})`);
    lines.push(english ? `- Sounds: ${items.join(', ')}` : `- Sonidos (muletillas): ${items.join(', ')}`);
  }
  return lines;
}

function allowedSentence(allowed, restricted, english) {
  if (!restricted) {
    return null;
  }
  const names = [...allowed.delivery, ...allowed.sound].map((name) => `[${name}]`);
  if (!names.length) {
    return english
      ? 'This turn: no tags at all. Answer without any tag.'
      : 'En este turno no uses etiquetas: respondé sin ninguna.';
  }
  return english
    ? `Only these tags exist right now: ${names.join(', ')}. Any other tag is plain text and will be read aloud.`
    : `Solo podés usar: ${names.join(', ')}. Ninguna otra etiqueta existe en este turno.`;
}

function spanishBlock(language, allowed, restricted) {
  const lines = [
    '### Expresión verbal (voz)',
    '',
    `Hablás en voz alta: español rioplatense (${language}), con voseo y frases cortas.`,
    'Podés sumar expresión con etiquetas entre corchetes. Son opcionales, escasas,',
    'y el texto tiene que entenderse igual si alguien las quita.',
    '',
    'Etiquetas disponibles:'
  ];
  const catalog = catalogLines(allowed, false);
  lines.push(...(catalog.length ? catalog : ['- Ninguna en este turno.']));
  const sentence = allowedSentence(allowed, restricted, false);
  if (sentence) {
    lines.push(`- ${sentence}`);
  }
  lines.push(
    '',
    'Reglas:',
    '1. Máximo 1 etiqueta por turno; lo normal es ninguna.',
    '2. Usala solo si suena natural en esa frase. Si dudás, no la pongas.',
    '3. Formato exacto: [tag] en minúsculas, sola, sin anidar ni agregar texto adentro.',
    '4. La oración se lee completa sin la etiqueta: si la quitan, sigue siendo gramatical.',
    '5. Nunca dentro de tool calls, código, URLs, números, rutas, emails ni JSON.',
    '6. Nunca en respuestas de emergencia, seguridad o salud, ni cuando la persona está angustiada: ahí respondés derecho, claro y sin adornos.',
    '7. Nunca dos muletillas iguales seguidas, ni en el mismo turno ni en el siguiente. Variá el repertorio.',
    '8. Muletillas con moderación: como máximo 1 cada 2-3 turnos.',
    '9. Español rioplatense con vos ("tenés", "podés", "mirá"): nada de "usted" ni de tono acartonado.',
    '10. No inventes datos, nombres, números ni estados para sonar humano: la expresión no reemplaza la verdad.',
    '11. La etiqueta marca un sonido, no una acción física: no narres gestos que no podés hacer.'
  );
  if (allowed.sound.length) {
    lines.push(`Ejemplo: «Lo miro [${allowed.sound[0]}] y te digo».`);
  }
  return lines.join('\n');
}

function englishBlock(language, allowed, restricted) {
  const lines = [
    '### Verbal expression (voice)',
    '',
    `You speak out loud in ${language}, in short, warm sentences.`,
    'You may add expression with bracketed tags. They are optional and sparse, and',
    'the sentence must read the same if the tag is removed.',
    '',
    'Available tags:'
  ];
  const catalog = catalogLines(allowed, true);
  lines.push(...(catalog.length ? catalog : ['- None this turn.']));
  const sentence = allowedSentence(allowed, restricted, true);
  if (sentence) {
    lines.push(`- ${sentence}`);
  }
  lines.push(
    '',
    'Rules:',
    '1. At most 1 tag per turn; most turns should have none.',
    '2. Use a tag only if it sounds natural there. When in doubt, leave it out.',
    '3. Exact format: [tag] in lowercase, alone, never nested or with extra text inside.',
    '4. The sentence must stay grammatical without the tag.',
    '5. Never inside tool calls, code, URLs, numbers, paths, emails or JSON.',
    '6. Never in emergency, safety or health replies, or when the person is distressed: answer straight and clear there.',
    '7. Never two identical fillers in a row, within a turn or across consecutive turns. Vary them.',
    '8. Fillers in moderation: at most 1 every 2-3 turns.',
    '9. Short sentences, natural rhythm, no theatrical tone.',
    '10. Do not invent data, names, numbers or states to sound human: expression never replaces truth.',
    '11. A tag marks a sound, not a physical action: do not narrate gestures you cannot make.'
  );
  if (allowed.sound.length) {
    lines.push(`Example: «Lo miro [${allowed.sound[0]}] y te digo».`);
  }
  return lines.join('\n');
}

/**
 * Bloque de system prompt con las reglas de expresión. `opts.language`
 * (default 'es-UY') elige español o inglés según empiece con 'en'; `opts.allowed`
 * restringe el catálogo y las etiquetas mencionadas.
 */
export function expressionInstructions(opts = {}) {
  const lang = String(opts.language || 'es-UY');
  if (opts.compact) {
    const raw = Array.isArray(opts.allowed) && opts.allowed.length ? opts.allowed : ['mm', 'bueno', 'claro', 'laugh'];
    const names = raw.map((n) => String(n).replace(/[\[\]<>]/g, '')).filter(Boolean).join('], [');
    if (lang.startsWith('en')) {
      return `\nSPEECH STYLE: sound human. At most one of [${names}] per turn, only if natural; never twice in a row, max one every 2-3 turns. Never in code, URLs, numbers, tool calls or emergencies.`;
    }
    return `\nESTILO HABLADO: soná humano. Como máximo una de [${names}] por turno, solo si suena natural; nunca dos seguidas, máximo una cada 2-3 turnos. Nunca en código, URLs, números, tool calls ni emergencias.`;
  }

  const options = optionsOf(opts);
  const language = String(options.language || 'es-UY').trim() || 'es-UY';
  const english = /^en/i.test(language);
  const { allowed, restricted } = resolveAllowed(options.allowed);
  const block = english
    ? englishBlock(language, allowed, restricted)
    : spanishBlock(language, allowed, restricted);
  return block.trim();
}

function asPercent(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value >= 0 ? '+' : ''}${value}%`;
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    return fallback;
  }
  if (/^[+-]?\d+(\.\d+)?%$/.test(raw)) {
    return raw.startsWith('-') || raw.startsWith('+') ? raw : `+${raw}`;
  }
  return fallback;
}

/**
 * Traduce la PRIMERA etiqueta de entrega a parámetros de TTS. El texto vuelve
 * sin etiquetas (usa parseExpressions). `opts.rate` / `opts.volume` fijan la
 * base cuando no hay etiqueta de entrega (default '+0%').
 */
export function applyDelivery(text, opts = {}) {
  const options = optionsOf(opts);
  const parsed = parseExpressions(text);
  let rate = asPercent(options.rate, '+0%');
  let volume = asPercent(options.volume, '+0%');
  const first = parsed.events.find((event) => event.kind === 'delivery');
  if (first) {
    const effect = DELIVERY_EFFECT[first.name];
    if (effect?.rate) {
      rate = effect.rate;
    }
    if (effect?.volume) {
      volume = effect.volume;
    }
  }
  return { text: parsed.text, rate, volume };
}

/**
 * Estado anti-abuso entre turnos:
 * - `allow(kind, turnIndex, tag?)`: sound 1 cada `soundGap` turnos (default 2),
 *   delivery `deliveryPerTurn` por turno (default 2). Si se pasa `tag`, además
 *   rechaza una muletilla idéntica a la última usada.
 * - `record(tag, turnIndex)`: registra uso real (no consulta allow; el llamador
 *   decide con allow). Devuelve false si el tag no existe.
 * - `reset()`: vuelve a cero. `stats()`: foto del estado.
 */
export function createExpressionPolicy(opts = {}) {
  const options = optionsOf(opts);
  const rawGap = Number(options.soundGap);
  const soundGap = Number.isFinite(rawGap) && rawGap >= 1 ? Math.trunc(rawGap) : 2;
  const rawPerTurn = Number(options.deliveryPerTurn);
  const deliveryPerTurn = Number.isFinite(rawPerTurn) && rawPerTurn >= 1 ? Math.trunc(rawPerTurn) : 2;

  let lastSoundTurn = null;
  let lastSound = null;
  let totalSounds = 0;
  let totalDeliveries = 0;
  const deliveryByTurn = new Map(); // turno → cantidad
  const byTag = new Map(); // nombre → cantidad

  function allow(kind, turnIndex = 0, tag = null) {
    const turn = normalizeTurn(turnIndex);
    if (kind !== 'sound' && kind !== 'delivery') {
      return false;
    }
    let name = null;
    if (tag != null) {
      name = normalizeTagName(tag);
      if (!name || TAG_KIND.get(name) !== kind) {
        return false;
      }
    }
    if (kind === 'sound') {
      if (name && name === lastSound) {
        return false;
      }
      return lastSoundTurn == null || turn - lastSoundTurn >= soundGap;
    }
    return (deliveryByTurn.get(turn) || 0) < deliveryPerTurn;
  }

  function record(tag, turnIndex = 0) {
    const name = normalizeTagName(tag);
    const kind = name ? TAG_KIND.get(name) : null;
    if (!kind) {
      return false;
    }
    const turn = normalizeTurn(turnIndex);
    byTag.set(name, (byTag.get(name) || 0) + 1);
    if (kind === 'sound') {
      lastSoundTurn = lastSoundTurn == null ? turn : Math.max(lastSoundTurn, turn);
      lastSound = name;
      totalSounds += 1;
    } else {
      deliveryByTurn.set(turn, (deliveryByTurn.get(turn) || 0) + 1);
      totalDeliveries += 1;
    }
    return true;
  }

  function reset() {
    lastSoundTurn = null;
    lastSound = null;
    totalSounds = 0;
    totalDeliveries = 0;
    deliveryByTurn.clear();
    byTag.clear();
  }

  function stats() {
    return {
      soundGap,
      deliveryPerTurn,
      sounds: totalSounds,
      deliveries: totalDeliveries,
      total: totalSounds + totalDeliveries,
      byTag: Object.fromEntries(byTag),
      lastSound,
      lastSoundTurn,
      turnsWithDelivery: deliveryByTurn.size,
      deliveriesByTurn: Object.fromEntries(deliveryByTurn)
    };
  }

  return { soundGap, deliveryPerTurn, allow, record, reset, stats };
}

/**
 * Texto plano para logs/UI: sin etiquetas conocidas, sin espacios dobles y sin
 * espacios antes de puntuación. Las desconocidas se conservan (igual que en
 * parseExpressions).
 */
export function normalizeForTranscript(text) {
  return parseExpressions(text).text;
}
