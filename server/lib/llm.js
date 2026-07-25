import {
  MINIMAX_API_URL,
  MINIMAX_MODELS,
  RESPONSE_TIMEOUT_MS
} from './config.js';
import { getErrorText, getShortError } from './text.js';

// Cliente MiniMax (endpoint OpenAI-compatible: /v1/chat/completions).
// - streaming SSE con delta.content
// - thinking deshabilitado por defecto (reuniones = baja latencia); los
//   bloques <think>…</think> se filtran defensivamente igual.
// - rotación clave×modelo con la misma semántica que tenía gemini.js:
//   en streaming solo se re-rota si aún no se emitió ningún chunk.

function buildBody(options, stream) {
  return JSON.stringify({
    model: options.model,
    messages: options.messages,
    stream,
    temperature: options.temperature ?? 0.7,
    max_completion_tokens: options.maxTokens ?? 2000,
    thinking: { type: options.thinking || 'disabled' }
  });
}

// Filtro incremental de <think>…</think> para streaming.
function createThinkFilter() {
  let inThink = false;
  let carry = '';
  return (chunk) => {
    let text = carry + chunk;
    carry = '';
    let out = '';
    while (text.length > 0) {
      if (inThink) {
        const end = text.indexOf('</think>');
        if (end === -1) {
          return out; // todo pensamiento; descartar
        }
        text = text.slice(end + 8);
        inThink = false;
      } else {
        const start = text.indexOf('<think>');
        if (start === -1) {
          // guardar cola por si un tag quedó cortado entre chunks
          const partial = text.lastIndexOf('<');
          if (partial !== -1 && partial >= text.length - 7 && '<think>'.startsWith(text.slice(partial))) {
            out += text.slice(0, partial);
            carry = text.slice(partial);
          } else {
            out += text;
          }
          return out;
        }
        out += text.slice(0, start);
        text = text.slice(start + 7);
        inThink = true;
      }
    }
    return out;
  };
}

function stripThink(value) {
  return String(value || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function requestChat(key, options, stream) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || RESPONSE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`Timeout en ${options.scope}`)), timeoutMs);
  const abortListener = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abortListener, { once: true });

  try {
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.value}`
      },
      body: buildBody(options, stream),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`MiniMax HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortListener);
  }
}

async function* sseEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              yield JSON.parse(payload);
            } catch {
              // chunk malformado: ignorar
            }
          }
        }
      }
    }
  }
}

// onDelta(texto, acumulado). Devuelve { text, model, aborted?, partial? }.
export async function streamChat(keyRing, options, onDelta) {
  if (!keyRing.hasKeys()) {
    throw new Error(`No hay claves MiniMax configuradas para ${options.scope}.`);
  }
  const models = options.models || MINIMAX_MODELS;
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt < Math.max(1, keyRing.size()); attempt += 1) {
      const key = keyRing.acquire();
      if (!key) {
        break;
      }
      const startTime = Date.now();
      let emitted = '';
      const filter = createThinkFilter();
      try {
        const response = await requestChat(key, { ...options, model }, true);
        for await (const event of sseEvents(response)) {
          if (options.signal?.aborted) {
            break;
          }
          const rawDelta = event?.choices?.[0]?.delta?.content || '';
          if (!rawDelta) {
            continue;
          }
          const delta = filter(rawDelta);
          if (delta) {
            emitted += delta;
            onDelta?.(delta, emitted);
          }
        }

        if (!emitted.trim()) {
          lastError = new Error(`MiniMax ${model} devolvió stream vacío.`);
          keyRing.reportFailure(key, lastError);
          continue;
        }
        keyRing.reportSuccess(key);
        keyRing.logKey('api_call_success', {
          scope: options.scope,
          model,
          keyId: key.id,
          elapsedMs: Date.now() - startTime,
          streamed: true
        });
        return { text: emitted, model };
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) {
          return { text: emitted, model, aborted: true };
        }
        if (emitted) {
          keyRing.reportFailure(key, error);
          return { text: emitted, model, partial: true };
        }
        keyRing.reportFailure(key, error);
        keyRing.logKey('api_call_error', {
          scope: options.scope,
          model,
          keyId: key.id,
          elapsedMs: Date.now() - startTime,
          error: getShortError(error),
          streamed: true
        });
        options.emit?.({
          type: 'api_rotation_start',
          scope: options.scope,
          message: `Rotando clave para ${options.scope}.`
        });
      }
    }
    if (!isModelNotFound(lastError)) {
      break;
    }
  }
  throw lastError || new Error(`No hay claves disponibles para ${options.scope}.`);
}

// Llamada no-streaming (router/observador/reflexión). Devuelve texto limpio.
export async function completeChat(keyRing, options) {
  if (!keyRing.hasKeys()) {
    throw new Error(`No hay claves MiniMax configuradas para ${options.scope}.`);
  }
  const models = options.models || MINIMAX_MODELS;
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt < Math.max(1, keyRing.size()); attempt += 1) {
      const key = keyRing.acquire();
      if (!key) {
        break;
      }
      const startTime = Date.now();
      try {
        const response = await requestChat(key, { ...options, model }, false);
        const body = await response.json();
        const message = body?.choices?.[0]?.message;
        const text = stripThink(
          message?.content && typeof message.content === 'string'
            ? message.content
            : ''
        );
        if (!text) {
          lastError = new Error(`MiniMax ${model} devolvió respuesta vacía.`);
          keyRing.reportFailure(key, lastError);
          continue;
        }
        keyRing.reportSuccess(key);
        keyRing.logKey('api_call_success', {
          scope: options.scope,
          model,
          keyId: key.id,
          elapsedMs: Date.now() - startTime,
          tokens: body?.usage?.total_tokens || null
        });
        return { text, model };
      } catch (error) {
        lastError = error;
        keyRing.reportFailure(key, error);
        keyRing.logKey('api_call_error', {
          scope: options.scope,
          model,
          keyId: key.id,
          elapsedMs: Date.now() - startTime,
          error: getShortError(error)
        });
      }
    }
    if (!isModelNotFound(lastError)) {
      break;
    }
  }
  throw lastError || new Error(`No hay claves disponibles para ${options.scope}.`);
}

function isModelNotFound(error) {
  return /model.*(not found|invalid|does not exist)|2013|1004/i.test(getErrorText(error));
}

export function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function parseJsonFromModel(value) {
  const text = stripThink(value);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
