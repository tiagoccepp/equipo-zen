import 'dotenv/config';

import { createServer } from 'node:http';

import { applyAudioSettings } from './lib/audio.js';

import { DB_PATH, DEFAULT_LLM_PROVIDER, HOST, LLM_PROVIDERS, PORT, collectProviderKeys, companyTemplates } from './lib/config.js';
import { createApp } from './lib/http.js';
import { ApiKeyRing } from './lib/key-ring.js';
import { broadcastToCompany } from './lib/meeting-session.js';
import { synthesizePiper } from './lib/piper.js';
import { getAudioFollowDefault, getAudioInput, getAudioOutput, initSettings } from './lib/settings.js';
import { firstNonEmpty, loadWarmupWavBase64, pcmToWav16kBase64, startSidecarWatchdog, withTimeoutMs } from './lib/sidecars.js';
import { Store } from './lib/store.js';
import { whisperHealthy } from './lib/stt.js';
import { LEGACY_VOICE_MAP, isAvailable as ttsAvailable, synthesize } from './lib/supertonic.js';

// WAV 16k mono, 0.5s de silencio, en base64. Último recurso si no hay
// fixture ni Piper: calentar con algo siempre gana.
function silenceWavBase64() {
  const pcm = Buffer.alloc(16000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

async function warmStt(url, wav) {
  try {
    const res = await fetch(`${url}/v1/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: wav, language: 'es' }),
      signal: AbortSignal.timeout(60000)
    });
    return res.ok ? 'warm' : `http${res.status}`;
  } catch {
    return 'down';
  }
}

// Tasa del PCM que devuelve Piper (mimeType audio/pcm;rate=NN).
function piperPcmRate(mimeType) {
  const m = /rate=(\d+)/.exec(String(mimeType || ''));
  return m ? Number(m[1]) : 22050;
}

// Calienta en paralelo lo que realmente se usa (plan §2d): Piper (TTS
// primero: una frase ES + una EN), Parakeet (STT primero) y Whisper (STT
// fallback), más Supertonic de yapa porque salía gratis (una línea).
// El STT se calienta con HABLA REAL (09/11: el silencio emite ~0 tokens y
// kswapd igual saca el encoder en idle): frase de Piper si responde, si
// no el fixture bundledo, si no silencio. Todo con techo y
// fire-and-forget: nada bloquea el boot, ni Piper caído.
async function prewarmLocalModels() {
  const fixture = loadWarmupWavBase64();
  const fallbackWav = firstNonEmpty(fixture, silenceWavBase64());
  const parakeetUrl = process.env.PARAKEET_URL || 'http://127.0.0.1:7790';
  const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:7789';
  // Piper con techo propio: si tarda o está DOWN, el STT igual se
  // calienta con el fixture (el boot nunca espera de más).
  const ttsPiper = await withTimeoutMs((async () => {
    try {
      const [es, en, warm] = await Promise.all([
        synthesizePiper('Hola.', 'F1', {}),
        synthesizePiper('Hello.', 'F1', {}),
        synthesizePiper('warming up speech recognition.', 'F1', {})
      ]);
      const spoken = warm?.[0] || es?.[0] || en?.[0] || null;
      const asWav = spoken?.data ? pcmToWav16kBase64(spoken.data, piperPcmRate(spoken.mimeType)) : null;
      return {
        status: es.length > 0 && en.length > 0 ? 'warm' : 'empty',
        wav: firstNonEmpty(asWav, fixture, silenceWavBase64())
      };
    } catch {
      return { status: 'down', wav: fallbackWav };
    }
  })(), 10000, { status: 'down', wav: fallbackWav });
  const sttWav = ttsPiper.wav || fallbackWav;
  const [sttParakeet, sttWhisper, ttsSupertonic] = await Promise.all([
    warmStt(parakeetUrl, sttWav),
    warmStt(whisperUrl, sttWav),
    (async () => {
      try {
        const parts = await synthesize('Hola.', 'M1', {});
        return parts.length > 0 ? 'warm' : 'empty';
      } catch {
        return 'down';
      }
    })()
  ]);
  return { ttsPiper: ttsPiper.status, sttParakeet, sttWhisper, ttsSupertonic };
}
import { telemetry } from './lib/telemetry.js';
import { Workforce } from './lib/workforce.js';
import { attachMeetingServer } from './lib/ws.js';

const store = new Store(DB_PATH);
if (process.env.EQUIPO_EPHEMERAL_MEETINGS === '1') {
  const n = store.clearEphemeral();
  console.log(`Modo test: reuniones efímeras (${n} filas limpiadas).`);
}
const seededCompany = store.ensureCompanies(companyTemplates, LEGACY_VOICE_MAP);
if (seededCompany) {
  console.log(`Empresa inicial creada: ${seededCompany.name}.`);
}
store.ensureLeadership(companyTemplates);
store.ensureGoalSlugs();

const app = createApp({ store });
const server = createServer(app);
const keyRing = new ApiKeyRing(collectProviderKeys(DEFAULT_LLM_PROVIDER));
keyRing.setTelemetry(telemetry);
initSettings(store, keyRing);
// Audio guardado: si Tito eligió salida/entrada fija, aplicarla al arrancar
// (set-default + mover streams; con followDefault no se toca nada).
if (!getAudioFollowDefault()) {
  void applyAudioSettings({
    output: getAudioOutput(),
    input: getAudioInput(),
    followDefault: false
  }).then((r) => {
    console.log(r.ok
      ? `Audio guardado aplicado (streams movidos: ${(r.moved || []).join(',') || 'ninguno vivo'}).`
      : `Audio guardado NO aplicado: ${r.error}`);
  });
}
attachMeetingServer(server, keyRing, store);
const workforce = new Workforce(store, keyRing, {
  onEvent: (companyId, payload) => broadcastToCompany(companyId, payload)
});
workforce.start();

server.listen(PORT, HOST, () => {
  console.log(`Backend listo en http://${HOST}:${PORT} (DB: ${DB_PATH})`);
  if (!keyRing.hasKeys()) {
    console.log(`Sin claves de ${LLM_PROVIDERS[DEFAULT_LLM_PROVIDER].label} (${LLM_PROVIDERS[DEFAULT_LLM_PROVIDER].envKey}): los agentes responden en modo simulación.`);
  }
  // Watchdog de sidecars (§3b capa 2): vigila STT/TTS y relanza los
  // caídos. Fuera de tests (ahí los sidecars son fakes inyectados).
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    startSidecarWatchdog();
    console.log('Watchdog de sidecars: activo (parakeet/piper/whisper/supertonic cada 20s).');
  }
  setTimeout(() => {
    void ttsAvailable().then((ok) => {
      console.log(ok
        ? 'Supertonic TTS local: OK (los empleados hablan con voz).'
        : 'Supertonic TTS no responde todavía: reunión sin voz hasta que levante.');
    });
    void whisperHealthy().then((ok) => {
      console.log(ok
        ? 'Whisper local: OK (tu voz se transcribe en la máquina).'
        : 'Whisper local caído: STT = Parakeet → Groq/Deepgram si hay keys → hint del navegador.');
    });
    // Prewarm: calentar TTS/STT en fondo para que el primer turno no pague
    // la carga del modelo (Parakeet frío 3.4s → tibio 0.4s).
    void prewarmLocalModels().then((r) => {
      console.log(`Prewarm modelos: piper=${r.ttsPiper} parakeet=${r.sttParakeet} whisper=${r.sttWhisper} supertonic=${r.ttsSupertonic}`);
    });
  }, 4000);
});
