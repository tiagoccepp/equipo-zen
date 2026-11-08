import 'dotenv/config';

import { createServer } from 'node:http';

import { DB_PATH, DEFAULT_LLM_PROVIDER, HOST, LLM_PROVIDERS, PORT, collectProviderKeys, companyTemplates } from './lib/config.js';
import { createApp } from './lib/http.js';
import { ApiKeyRing } from './lib/key-ring.js';
import { broadcastToCompany } from './lib/meeting-session.js';
import { initSettings } from './lib/settings.js';
import { Store } from './lib/store.js';
import { whisperHealthy } from './lib/stt.js';
import { LEGACY_VOICE_MAP, isAvailable as ttsAvailable, synthesize } from './lib/supertonic.js';

// Calienta TTS (una frase corta) y STT Parakeet (0.5s de silencio) para que
// el primer turno real no pague la carga de modelos. Fire-and-forget.
async function prewarmLocalModels() {
  const out = { tts: 'skip', stt: 'skip' };
  try {
    const parts = await synthesize('Hola.', 'M1', {});
    out.tts = parts.length > 0 ? 'warm' : 'empty';
  } catch {
    out.tts = 'down';
  }
  try {
    // WAV 16k mono, 0.5s de silencio.
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
    const wav = Buffer.concat([header, pcm]).toString('base64');
    const url = process.env.PARAKEET_URL || 'http://127.0.0.1:7790';
    const res = await fetch(`${url}/v1/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: wav, language: 'es' }),
      signal: AbortSignal.timeout(60000)
    });
    out.stt = res.ok ? 'warm' : `http${res.status}`;
  } catch {
    out.stt = 'down';
  }
  return out;
}
import { telemetry } from './lib/telemetry.js';
import { Workforce } from './lib/workforce.js';
import { attachMeetingServer } from './lib/ws.js';

const store = new Store(DB_PATH);
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
  setTimeout(() => {
    void ttsAvailable().then((ok) => {
      console.log(ok
        ? 'Supertonic TTS local: OK (los empleados hablan con voz).'
        : 'Supertonic TTS no responde todavía: reunión sin voz hasta que levante.');
    });
    void whisperHealthy().then((ok) => {
      console.log(ok
        ? 'Whisper local: OK (tu voz se transcribe en la máquina).'
        : 'Whisper local no responde todavía: el STT usará el hint del navegador.');
    });
    // Prewarm: calentar TTS/STT en fondo para que el primer turno no pague
    // la carga del modelo (Parakeet frío 3.4s → tibio 0.4s).
    void prewarmLocalModels().then((r) => {
      console.log(`Prewarm modelos: tts=${r.tts} stt=${r.stt}`);
    });
  }, 4000);
});
