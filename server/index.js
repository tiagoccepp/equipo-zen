import 'dotenv/config';

import { createServer } from 'node:http';

import { DB_PATH, HOST, PORT, collectApiKeys, companyTemplates } from './lib/config.js';
import { createApp } from './lib/http.js';
import { ApiKeyRing } from './lib/key-ring.js';
import { initSettings } from './lib/settings.js';
import { Store } from './lib/store.js';
import { whisperHealthy } from './lib/stt.js';
import { LEGACY_VOICE_MAP, isAvailable as ttsAvailable } from './lib/supertonic.js';
import { telemetry } from './lib/telemetry.js';
import { attachMeetingServer } from './lib/ws.js';

const store = new Store(DB_PATH);
const seededCompany = store.ensureCompanies(companyTemplates, LEGACY_VOICE_MAP);
if (seededCompany) {
  console.log(`Empresa inicial creada: ${seededCompany.name}.`);
}

const app = createApp({ store });
const server = createServer(app);
const keyRing = new ApiKeyRing(collectApiKeys());
keyRing.setTelemetry(telemetry);
initSettings(store, keyRing);
attachMeetingServer(server, keyRing, store);

server.listen(PORT, HOST, () => {
  console.log(`Backend listo en http://${HOST}:${PORT} (DB: ${DB_PATH})`);
  if (!keyRing.hasKeys()) {
    console.log('Sin claves MiniMax (MINIMAX_API_KEY): los agentes responden en modo simulación.');
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
  }, 4000);
});
