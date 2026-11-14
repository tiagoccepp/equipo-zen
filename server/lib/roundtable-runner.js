// Mesa redonda entre agentes: orquestación pura (roundtable.js) conectada a un proveedor de chat.
//
// Inspirado en el WorkerBus de Pipecat y en las "meeting" de LiveKit: varios agentes con rol
// discuten un tema y producen una conclusión acotada, sin bucles infinitos.
//
// El módulo es testeable sin red: `callChat` se inyecta.

import {
  buildAgentPrompt,
  createRoundtable,
  runRoundtable,
  summarizeRoundtable
} from './roundtable.js';
import { normalizeForTranscript } from './expressive.js';

function normalizeText(text) {
  return normalizeForTranscript(String(text ?? '')).replace(/\s+/g, ' ').trim();
}

// Sin esto una mesa puede colgar el request para siempre: el proveedor tarda o no responde.
// Cada turno tiene techo propio; al vencerlo el turno cuenta como error y la mesa sigue
// (roundtable corta sola tras 2 errores consecutivos).
function withTurnTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`turno excedió ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Corre una mesa redonda usando un proveedor de chat inyectado.
 *
 * @param {object} opts
 * @param {string} opts.topic tema a discutir
 * @param {Array<{id:string,name:string,role?:string}>} opts.agents 2..5 agentes
 * @param {number} [opts.maxTurns] default 6 (2..12 acá, el validador acepta 2..20)
 * @param {(args:{system:string,user:string,agent:object,turn:number}) => Promise<string|{text:string}>} opts.callChat
 * @returns {Promise<{topic:string, transcript:Array, stopped:object, errors:Array, chars:number, summary:string}>}
 */
export async function runRoundtableWithChat({ topic, agents, maxTurns = 6, callChat, timeoutMs = 20000 }) {
  if (typeof callChat !== 'function') {
    throw new Error('callChat es requerido');
  }
  const turnTimeoutMs = Math.min(Math.max(Number(timeoutMs) || 20000, 3000), 45000);

  const rt = createRoundtable({
    topic,
    agents,
    maxTurns: Math.min(Math.max(Number(maxTurns) || 6, 2), 12),
    maxCharsPerTurn: 400,
    maxTotalChars: 3200
  });

  const result = await runRoundtable(rt, {
    callAgent: async ({ agent, role, topic: mesaTopic, transcript, turn }) => {
      const system = buildAgentPrompt({ agent, role, topic: mesaTopic, transcript });
      const user = `Tema: ${mesaTopic}\nTurno ${turn}. Respondé solo con tu intervención.`;

      const reply = await withTurnTimeout(callChat({ system, user, agent, turn }), turnTimeoutMs);
      const raw = typeof reply === 'string' ? reply : reply?.text;
      const text = normalizeText(raw);

      return {
        text,
        done: typeof reply === 'object' && reply !== null ? Boolean(reply.done) : false,
        skip: typeof reply === 'object' && reply !== null ? Boolean(reply.skip) : false
      };
    }
  });

  return {
    topic: result.topic,
    transcript: result.transcript,
    stopped: result.stopped,
    errors: result.errors,
    chars: result.chars,
    summary: summarizeRoundtable(result, { maxChars: 700 })
  };
}
