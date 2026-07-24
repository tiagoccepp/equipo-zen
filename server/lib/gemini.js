import { GoogleGenAI } from '@google/genai';

import { RESPONSE_TIMEOUT_MS, uniqueModelList } from './config.js';
import { getErrorText, getShortError } from './text.js';

export async function generateContentWithRotation(keyRingInstance, options) {
  const models = uniqueModelList(options.models || [options.model]);
  if (!keyRingInstance.hasKeys()) {
    throw new Error(`No hay claves Gemini configuradas para ${options.scope}.`);
  }

  let lastError = null;

  for (const model of models) {
    const attempts = Math.max(1, Math.min(keyRingInstance.size(), options.maxKeyAttempts || keyRingInstance.size()));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = keyRingInstance.acquire();
      if (!key) {
        break;
      }

      const startTime = Date.now();
      try {
        const ai = new GoogleGenAI({ apiKey: key.value });
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            config: options.config,
            contents: options.contents
          }),
          options.timeoutMs || RESPONSE_TIMEOUT_MS,
          `Timeout en ${options.scope}`
        );

        const elapsedMs = Date.now() - startTime;
        const hasContent = response?.candidates?.[0]?.content?.parts?.length > 0;
        if (!hasContent) {
          lastError = new Error(`Modelo ${model} devolvió respuesta vacía.`);
          keyRingInstance.reportFailure(key, lastError);
          keyRingInstance.logKey('api_call_empty_response', {
            scope: options.scope,
            model,
            keyId: key.id,
            attempt: attempt + 1,
            elapsedMs
          });
          options.emit?.({
            type: 'api_rotation_start',
            scope: options.scope,
            message: `Respuesta vacía de ${model}; rotando clave.`
          });
          continue;
        }

        keyRingInstance.reportSuccess(key);
        keyRingInstance.logKey('api_call_success', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs,
          tokens: response?.usageMetadata?.totalTokenCount || null
        });
        options.emit?.({
          type: 'api_rotation_resolved',
          scope: options.scope,
          keyId: key.id,
          model
        });
        return { response, key, model };
      } catch (error) {
        const elapsedMs = Date.now() - startTime;
        lastError = error;
        keyRingInstance.reportFailure(key, error);

        keyRingInstance.logKey('api_call_error', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs,
          error: getShortError(error)
        });

        if (isModelConfigurationError(error)) {
          break;
        }

        options.emit?.({
          type: 'api_rotation_start',
          scope: options.scope,
          message: `Rotando clave para ${options.scope}.`
        });
      }
    }

    if (!isModelConfigurationError(lastError)) {
      break;
    }
  }

  throw lastError || new Error(`No hay claves disponibles para ${options.scope}.`);
}

// Variante streaming: rota clave/modelo SOLO si todavía no se emitió ningún
// chunk; después del primer delta, un fallo a mitad de stream finaliza con
// el texto parcial (no se re-genera para no duplicar lo ya mostrado).
// onDelta(texto) se llama por chunk; devuelve el texto completo.
export async function streamTextWithRotation(keyRingInstance, options, onDelta) {
  const models = uniqueModelList(options.models || [options.model]);
  if (!keyRingInstance.hasKeys()) {
    throw new Error(`No hay claves Gemini configuradas para ${options.scope}.`);
  }

  let lastError = null;

  for (const model of models) {
    const attempts = Math.max(1, Math.min(keyRingInstance.size(), options.maxKeyAttempts || keyRingInstance.size()));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = keyRingInstance.acquire();
      if (!key) {
        break;
      }

      const startTime = Date.now();
      let emitted = '';
      try {
        const ai = new GoogleGenAI({ apiKey: key.value });
        const stream = await withTimeout(
          ai.models.generateContentStream({
            model,
            config: { ...options.config, abortSignal: options.signal },
            contents: options.contents
          }),
          options.timeoutMs || RESPONSE_TIMEOUT_MS,
          `Timeout en ${options.scope}`
        );

        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            break;
          }
          const delta = chunk.text || '';
          if (delta) {
            emitted += delta;
            onDelta?.(delta, emitted);
          }
        }

        if (!emitted.trim()) {
          lastError = new Error(`Modelo ${model} devolvió stream vacío.`);
          keyRingInstance.reportFailure(key, lastError);
          continue;
        }

        keyRingInstance.reportSuccess(key);
        keyRingInstance.logKey('api_call_success', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs: Date.now() - startTime,
          streamed: true
        });
        return { text: emitted, key, model };
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) {
          return { text: emitted, key, model, aborted: true };
        }
        if (emitted) {
          // Fallo a mitad de stream: quedarse con lo emitido.
          keyRingInstance.reportFailure(key, error);
          return { text: emitted, key, model, partial: true };
        }
        keyRingInstance.reportFailure(key, error);
        keyRingInstance.logKey('api_call_error', {
          scope: options.scope,
          model,
          keyId: key.id,
          attempt: attempt + 1,
          elapsedMs: Date.now() - startTime,
          error: getShortError(error),
          streamed: true
        });
        if (isModelConfigurationError(error)) {
          break;
        }
        options.emit?.({
          type: 'api_rotation_start',
          scope: options.scope,
          message: `Rotando clave para ${options.scope}.`
        });
      }
    }

    if (!isModelConfigurationError(lastError)) {
      break;
    }
  }

  throw lastError || new Error(`No hay claves disponibles para ${options.scope}.`);
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

export function isModelConfigurationError(error) {
  const text = getErrorText(error);
  return /model .*not found|models\/.+not found|not found for api version|not supported.*model|not supported.*generateContent|response modalit|voice.*not found|invalid.*voice/i.test(text);
}

export function extractTextFromResponse(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').filter(Boolean).join('').trim();
}

export function extractAudioParts(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part.inlineData)
    .filter((inlineData) => inlineData?.data)
    .map((inlineData) => ({
      data: inlineData.data,
      mimeType: inlineData.mimeType || 'audio/pcm;rate=24000'
    }));
}

export function parseJsonFromModel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
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
