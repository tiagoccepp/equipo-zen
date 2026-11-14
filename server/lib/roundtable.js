// ── Mesa redonda: discusión grupal entre agentes (núcleo PURO) ──────────────
// Misma idea que el WorkerBus de Pipecat: varios agentes con rol discuten un
// tema y cierran con una conclusión. Este módulo NO habla con ningún LLM ni
// toca I/O: el llamador inyecta `callAgent`, así toda la política de turnos
// se testea determinista. El cableado real (prompt + proveedor + streaming)
// vive fuera, en el orquestador que consuma estas funciones.
//
// Política de turnos (round-robin con pesos):
//   - `config.agents` define el roster y el rol de cada uno.
//   - Si hay `speakerWeights` ({ agentId: número }), el ORDEN de la ronda se
//     ordena por peso descendente (empate: orden de declaración; sin peso: 0).
//   - El recorrido es round-robin sobre ese orden: cada vuelta completa pasa
//     una vez por cada agente. Los pesos NO dan turnos extra: solo definen
//     quién abre la ronda y en qué orden hablan dentro de ella.
//   - `turn` es 1-based y cuenta INTENTOS (llamadas a `callAgent`), no
//     contribuciones: un turno salteado o fallado igual consume cupo. Por eso
//     `maxTurns` es una cota dura anti-loop-infinito.

export const RT_DEFAULTS = Object.freeze({
  maxTurns: 6,
  maxCharsPerTurn: 400,
  maxTotalChars: 4000,
});

export const RT_LIMITS = Object.freeze({
  minTurns: 2,
  maxTurns: 20,
  minCharsPerTurn: 80,
  maxCharsPerTurn: 2000,
  maxConsecutiveSkips: 3,
  maxConsecutiveErrors: 2,
});

export const RT_STOP_REASONS = Object.freeze([
  'max_turns',
  'max_chars',
  'done',
  'skipped',
  'errors',
]);

// Normaliza texto de agente: trim + colapso de espacios/saltos.
export function normalizeTurnText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isIntWithin(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function capText(text, max) {
  if (text.length <= max) {
    return text;
  }
  return max > 1 ? `${text.slice(0, max - 1)}…` : text.slice(0, Math.max(0, max));
}

// Primera oración de un texto (para resúmenes compactos).
function firstSentence(text) {
  const clean = normalizeTurnText(text);
  if (!clean) {
    return '';
  }
  const match = clean.match(/^(.+?[.!?…])(?:\s|$)/);
  return match ? match[1] : clean;
}

// Valida la config SIN normalizar. `maxTurns`/`maxCharsPerTurn` ausentes son
// válidos a propósito: `createRoundtable` aplica defaults.
export function validateRoundtableConfig(config = {}) {
  const errors = [];
  const source = config && typeof config === 'object' ? config : {};
  const agents = Array.isArray(source.agents) ? source.agents : [];

  if (agents.length < 2) {
    errors.push(`se necesitan al menos 2 agentes (recibidos: ${agents.length})`);
  }

  const ids = new Set();
  const names = new Set();
  agents.forEach((agent, i) => {
    const id = typeof agent?.id === 'string' ? agent.id.trim() : '';
    const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
    if (!id) {
      errors.push(`agente[${i}]: falta id`);
    } else if (ids.has(id)) {
      errors.push(`agente[${i}]: id duplicado "${id}"`);
    } else {
      ids.add(id);
    }
    if (!name) {
      errors.push(`agente[${i}]: falta name`);
    } else {
      const key = name.toLowerCase();
      if (names.has(key)) {
        errors.push(`agente[${i}]: name duplicado "${name}"`);
      } else {
        names.add(key);
      }
    }
  });

  const topic = typeof source.topic === 'string' ? source.topic.trim() : '';
  if (!topic) {
    errors.push('topic vacío');
  }

  if (source.maxTurns !== undefined && source.maxTurns !== null
    && !isIntWithin(source.maxTurns, RT_LIMITS.minTurns, RT_LIMITS.maxTurns)) {
    errors.push(`maxTurns debe ser entero entre ${RT_LIMITS.minTurns} y ${RT_LIMITS.maxTurns} (recibido: ${source.maxTurns})`);
  }

  if (source.maxCharsPerTurn !== undefined && source.maxCharsPerTurn !== null
    && !isIntWithin(source.maxCharsPerTurn, RT_LIMITS.minCharsPerTurn, RT_LIMITS.maxCharsPerTurn)) {
    errors.push(`maxCharsPerTurn debe ser entero entre ${RT_LIMITS.minCharsPerTurn} y ${RT_LIMITS.maxCharsPerTurn} (recibido: ${source.maxCharsPerTurn})`);
  }

  return { ok: errors.length === 0, errors };
}

// Crea la mesa redonda con config normalizada. Tira si la config es inválida
// (el error lleva `.errors` con el detalle).
export function createRoundtable(config = {}) {
  const { ok, errors } = validateRoundtableConfig(config);
  if (!ok) {
    const error = new Error(`roundtable: config inválida → ${errors.join('; ')}`);
    error.code = 'ROUNDTABLE_CONFIG';
    error.errors = errors;
    throw error;
  }

  const agents = config.agents.map((agent) => ({
    id: agent.id.trim(),
    name: agent.name.trim(),
    role: normalizeTurnText(agent.role) || 'generalista',
  }));

  const speakerWeights = {};
  if (config.speakerWeights && typeof config.speakerWeights === 'object') {
    for (const agent of agents) {
      const weight = config.speakerWeights[agent.id];
      if (Number.isFinite(weight)) {
        speakerWeights[agent.id] = weight;
      }
    }
  }

  const topic = normalizeTurnText(config.topic);
  const maxTurns = config.maxTurns ?? RT_DEFAULTS.maxTurns;
  const maxCharsPerTurn = config.maxCharsPerTurn ?? RT_DEFAULTS.maxCharsPerTurn;
  const requestedTotal = Number(config.maxTotalChars);
  const maxTotalChars = Number.isFinite(requestedTotal) && requestedTotal > 0
    ? Math.floor(requestedTotal)
    : RT_DEFAULTS.maxTotalChars;

  return {
    config: Object.freeze({
      topic,
      agents: Object.freeze(agents),
      maxTurns,
      maxCharsPerTurn,
      maxTotalChars,
      speakerWeights: Object.freeze(speakerWeights),
    }),
  };
}

// Orden de habla de la ronda (no muta agents). Exportado para inspección.
export function turnOrder(config) {
  const weights = config?.speakerWeights || {};
  return (config?.agents || [])
    .map((agent, position) => ({
      agent,
      position,
      weight: Number.isFinite(weights[agent.id]) ? weights[agent.id] : 0,
    }))
    .sort((a, b) => (b.weight - a.weight) || (a.position - b.position))
    .map((entry) => entry.agent);
}

// Corre la discusión. `callAgent` puede ser sync o async y puede tirar:
//   ({ agent, role, topic, transcript, turn }) => { text, done?, skip? }
export async function runRoundtable(roundtable, { callAgent } = {}) {
  if (!roundtable?.config) {
    throw new Error('runRoundtable: falta el objeto de createRoundtable()');
  }
  if (typeof callAgent !== 'function') {
    throw new TypeError('runRoundtable: callAgent debe ser una función');
  }

  const { topic, maxTurns, maxCharsPerTurn, maxTotalChars } = roundtable.config;
  const order = turnOrder(roundtable.config);
  const transcript = [];
  const errors = [];
  const lastTextByAgent = new Map();

  let turn = 0;
  let chars = 0;
  let skipStreak = 0;
  let errorStreak = 0;
  let reason = null;

  while (turn < maxTurns) {
    if (chars >= maxTotalChars) {
      reason = 'max_chars';
      break;
    }

    turn += 1;
    const agent = order[(turn - 1) % order.length];
    const role = agent.role;

    let output;
    try {
      output = await callAgent({
        agent: { ...agent },
        role,
        topic,
        transcript: transcript.map((entry) => ({ ...entry })),
        turn,
      });
    } catch (error) {
      errors.push({
        turn,
        agentId: agent.id,
        message: String(error?.message || error),
      });
      errorStreak += 1;
      // Un error corta la racha de skips: no fue un turno salteado.
      skipStreak = 0;
      if (errorStreak >= RT_LIMITS.maxConsecutiveErrors) {
        reason = 'errors';
        break;
      }
      continue;
    }

    errorStreak = 0;
    const result = output && typeof output === 'object' ? output : {};
    const normalized = normalizeTurnText(result.text);

    // Vacío o skip explícito: no entra al transcript.
    if (result.skip || !normalized) {
      skipStreak += 1;
      if (skipStreak >= RT_LIMITS.maxConsecutiveSkips) {
        reason = 'skipped';
        break;
      }
      continue;
    }

    // Repetir lo último del MISMO agente se considera turno salteado.
    if (lastTextByAgent.get(agent.id) === normalized) {
      skipStreak += 1;
      if (skipStreak >= RT_LIMITS.maxConsecutiveSkips) {
        reason = 'skipped';
        break;
      }
      continue;
    }

    let text = capText(normalized, maxCharsPerTurn);
    const cappedForAgent = text;
    const remaining = maxTotalChars - chars;
    let clippedByTotal = false;
    if (text.length > remaining) {
      text = capText(text, remaining);
      clippedByTotal = true;
    }

    transcript.push({
      index: turn,
      agentId: agent.id,
      name: agent.name,
      role,
      text,
    });
    lastTextByAgent.set(agent.id, cappedForAgent);
    chars += text.length;
    skipStreak = 0;

    if (result.done) {
      reason = 'done';
      break;
    }
    if (clippedByTotal || chars >= maxTotalChars) {
      reason = 'max_chars';
      break;
    }
  }

  if (!reason) {
    // Cota dura: `turn` ya vale maxTurns (o el tope efectivo del presupuesto).
    reason = 'max_turns';
  }

  return {
    topic,
    transcript,
    stopped: { reason, turn },
    errors,
    chars,
  };
}

// Resumen Markdown compacto para inyectar en un prompt: mejor intervención
// por agente (la más larga como proxy de sustancia), primera oración, y una
// línea de conclusión si la mesa cerró con done.
export function summarizeRoundtable(result, { maxChars = 700 } = {}) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 700;
  if (limit === 0) {
    return '';
  }
  const topic = normalizeTurnText(result?.topic) || 'sin tema';
  const entries = Array.isArray(result?.transcript) ? result.transcript : [];

  const isDone = result?.stopped?.reason === 'done' && entries.length > 0;
  const closing = isDone ? entries[entries.length - 1] : null;
  // La conclusión se muestra aparte: si un agente tiene más de una
  // intervención, su turno de cierre no compite como "mejor" línea propia.
  const spokenCount = new Map();
  for (const entry of entries) {
    spokenCount.set(entry.agentId, (spokenCount.get(entry.agentId) || 0) + 1);
  }
  const pool = closing
    ? entries.filter((entry) => !(entry.index === closing.index && spokenCount.get(entry.agentId) > 1))
    : entries;

  const bestByAgent = new Map();
  for (const entry of pool) {
    const current = bestByAgent.get(entry.agentId);
    if (!current || entry.text.length > current.text.length) {
      bestByAgent.set(entry.agentId, entry);
    }
  }

  const lines = [`### Mesa redonda: ${topic}`];
  for (const entry of bestByAgent.values()) {
    lines.push(`- **${entry.name}** (${entry.role}): ${firstSentence(entry.text)}`);
  }
  if (closing) {
    lines.push(`Conclusión: ${firstSentence(closing.text)}`);
  }

  const joined = lines.join('\n');
  return capText(joined, limit);
}

// Prompt de instrucciones para un agente de la mesa. Incluye rol, tema, lo
// ya dicho (últimos 8 turnos recortados) y pide 1-3 oraciones sin repetir,
// cerrando con done:true cuando el tema esté agotado.
export function buildAgentPrompt({ agent, role, topic, transcript } = {}) {
  const name = normalizeTurnText(agent?.name) || 'Agente';
  const roleName = normalizeTurnText(role || agent?.role) || 'generalista';
  const subject = normalizeTurnText(topic) || '(sin tema)';
  const entries = Array.isArray(transcript) ? transcript : [];

  const said = entries.length === 0
    ? 'Todavía no habló nadie: abrí la discusión.'
    : entries
      .slice(-8)
      .map((entry) => `- ${entry.name} (${entry.role}): ${capText(normalizeTurnText(entry.text), 220)}`)
      .join('\n');

  return [
    `Sos ${name}, ${roleName}, en una mesa redonda de agentes.`,
    `Tema: ${subject}`,
    'Lo que se dijo hasta ahora:',
    said,
    'Reglas:',
    `- Respondé en 1 a 3 oraciones, en castellano, concreto y sin relleno.`,
    '- No repitas lo que ya dijeron los demás: sumá un ángulo nuevo, un matiz o una objeción.',
    '- Si el tema ya está agotado y podés cerrar, respondé con la conclusión y marcá done:true.',
  ].join('\n');
}
