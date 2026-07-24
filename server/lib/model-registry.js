import { GoogleGenAI } from '@google/genai';

import {
  AGENT_LIVE_MODEL,
  AGENT_TEXT_MODELS,
  MODEL,
  ROUTER_MODELS,
  TRANSCRIBE_MODEL,
  TTS_MODELS
} from './config.js';
import { telemetry } from './telemetry.js';

// Validación de arranque: los IDs de modelo son config, no supuestos.
// Con ≥1 clave consulta models.list y reporta qué configurados faltan;
// nunca tira el proceso (los fallbacks por modelo ya degradan solos).
export async function validateConfiguredModels(keyRing) {
  if (!keyRing.hasKeys()) {
    return null;
  }
  const key = keyRing.acquire();
  if (!key) {
    return null;
  }

  const configured = [
    ...new Set([
      MODEL,
      TRANSCRIBE_MODEL,
      AGENT_LIVE_MODEL,
      ...AGENT_TEXT_MODELS,
      ...ROUTER_MODELS,
      ...TTS_MODELS
    ])
  ].filter(Boolean);

  try {
    const ai = new GoogleGenAI({ apiKey: key.value });
    const available = new Set();
    const pager = await ai.models.list();
    for await (const model of pager) {
      const name = String(model.name || '').replace(/^models\//, '');
      available.add(name);
    }
    const missing = configured.filter((model) => !available.has(model));
    telemetry.add({
      type: 'model_validation',
      payload: {
        configured: configured.length,
        available: available.size,
        missing
      }
    });
    if (missing.length > 0) {
      console.warn(`Modelos configurados que la API no lista: ${missing.join(', ')}`);
    }
    return { missing, available: available.size };
  } catch (error) {
    telemetry.add({
      type: 'model_validation_failed',
      payload: { error: String(error?.message || error).slice(0, 200) }
    });
    return null;
  }
}
