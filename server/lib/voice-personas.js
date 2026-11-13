// F-10c: personas de voz — identidad vocal estable por agente en TODOS
// los motores. Une los mapeos dispersos (piper/supertonic/edge/deepgram)
// en una superficie + auditoría de cobertura.

import { mapVoiceToPiper } from './piper.js';
import { normalizeVoice } from './supertonic.js';
import { mapVoiceToEdge } from './edge-tts.js';
import { mapVoiceToDeepgram } from './deepgram.js';

export const PERSONA_ENGINES = ['piper', 'supertonic', 'edge', 'deepgram'];

// Voz canónica (M1..M5/F1..F5, legacy migrado) → nombre por motor.
export function personaFor(voice, engine) {
  const canon = normalizeVoice(String(voice || '').trim() || 'M1');
  switch (engine) {
    case 'piper':
      return mapVoiceToPiper(canon);
    case 'supertonic':
      return canon;
    case 'edge':
      return mapVoiceToEdge(canon);
    case 'deepgram':
      return mapVoiceToDeepgram(canon);
    default:
      return null;
  }
}

export function personaAllEngines(voice) {
  return Object.fromEntries(PERSONA_ENGINES.map((e) => [e, personaFor(voice, e)]));
}

// Auditoría: cada voz del roster resuelve en todos los motores (no vacío).
// Devuelve {ok, missing: [{voice, engine}]}.
export function auditPersonaCoverage(voices) {
  const missing = [];
  for (const v of voices || []) {
    for (const e of PERSONA_ENGINES) {
      let name = null;
      try {
        name = personaFor(v, e);
      } catch {
        name = null;
      }
      if (!name) {
        missing.push({ voice: v, engine: e });
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
