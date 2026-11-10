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
import { speechVerdict } from './lib/silero.js';

// 16k mono WAV, 0.5s of silence, in base64. Last resort if there's no
// fixture nor Piper: warming up with something always wins.
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

// PCM rate returned by Piper (mimeType audio/pcm;rate=NN).
function piperPcmRate(mimeType) {
  const m = /rate=(\d+)/.exec(String(mimeType || ''));
  return m ? Number(m[1]) : 22050;
}

// Warms up in parallel what is actually used (plan §2d): Piper (TTS
// first: one ES sentence + one EN), Parakeet (STT first) and Whisper (STT
// fallback), plus Supertonic as a bonus because it cost one line.
// STT warms up with REAL SPEECH (09/11: silence emits ~0 tokens and
// kswapd still evicts the encoder when idle): a Piper sentence if it answers,
// else the bundled fixture, else silence. All with a cap and
// fire-and-forget: nothing blocks boot, not even a down Piper.
async function prewarmLocalModels() {
  const fixture = loadWarmupWavBase64();
  const fallbackWav = firstNonEmpty(fixture, silenceWavBase64());
  const parakeetUrl = process.env.PARAKEET_URL || 'http://127.0.0.1:7790';
  const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:7789';
  // Piper with its own cap: if it's slow or DOWN, the STT still warms
  // up with the fixture (boot never waits extra).
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
  const [sttParakeet, sttWhisper, ttsSupertonic, vadSilero] = await Promise.all([
    warmStt(parakeetUrl, sttWav),
    warmStt(whisperUrl, sttWav),
    (async () => {
      try {
        const parts = await synthesize('Hola.', 'M1', {});
        return parts.length > 0 ? 'warm' : 'empty';
      } catch {
        return 'down';
      }
    })(),
    // Silero VAD (opt 09/11 #8): it was outside the prewarm and the first
    // voice turn paid the ONNX import + model (1-3s). 512 samples of
    // silence are enough to load runtime + session.
    (async () => {
      try {
        const silence = Buffer.alloc(512 * 2).toString('base64');
        const verdict = await speechVerdict([silence]);
        return verdict ? 'warm' : 'unavailable';
      } catch {
        return 'down';
      }
    })()
  ]);
  return { ttsPiper: ttsPiper.status, sttParakeet, sttWhisper, ttsSupertonic, vadSilero };
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
// Saved audio: if Tito picked a fixed output/input, apply it at startup
// (set-default + move streams; with followDefault nothing is touched).
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
  // Sidecar watchdog (§3b layer 2): watches STT/TTS and relaunches the
  // fallen ones. Outside tests (there the sidecars are injected fakes).
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
    // Prewarm: warm TTS/STT in the background so the first turn doesn't pay
    // the model load (cold Parakeet 3.4s → warm 0.4s).
    void prewarmLocalModels().then((r) => {
      console.log(`Prewarm modelos: piper=${r.ttsPiper} parakeet=${r.sttParakeet} whisper=${r.sttWhisper} supertonic=${r.ttsSupertonic}`);
    });
  }, 4000);
});
