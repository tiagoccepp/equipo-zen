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
