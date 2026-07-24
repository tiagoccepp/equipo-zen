import 'dotenv/config';

import { createServer } from 'node:http';

import { DB_PATH, HOST, PORT, agentConfig, collectApiKeys } from './lib/config.js';
import { createApp } from './lib/http.js';
import { ApiKeyRing } from './lib/key-ring.js';
import { validateConfiguredModels } from './lib/model-registry.js';
import { Store } from './lib/store.js';
import { telemetry } from './lib/telemetry.js';
import { attachMeetingServer } from './lib/ws.js';

const store = new Store(DB_PATH);
const seeded = store.seedAgentsIfEmpty(agentConfig);
if (seeded) {
  console.log('Base de datos inicializada con los agentes de agents.config.json.');
}

const app = createApp({ store });
const server = createServer(app);
const keyRing = new ApiKeyRing(collectApiKeys());
keyRing.setTelemetry(telemetry);
attachMeetingServer(server, keyRing, store);

server.listen(PORT, HOST, () => {
  console.log(`Backend listo en http://${HOST}:${PORT} (DB: ${DB_PATH})`);
  if (!keyRing.hasKeys()) {
    console.log('Sin claves Gemini: la app usara respuestas simuladas hasta que configures .env.');
  }
  void validateConfiguredModels(keyRing).then((result) => {
    if (result?.missing?.length === 0) {
      console.log('Todos los modelos configurados existen en la API.');
    }
  });
});
