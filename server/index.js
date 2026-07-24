import 'dotenv/config';

import { createServer } from 'node:http';

import { HOST, PORT, collectApiKeys } from './lib/config.js';
import { createApp } from './lib/http.js';
import { ApiKeyRing } from './lib/key-ring.js';
import { telemetry } from './lib/telemetry.js';
import { attachMeetingServer } from './lib/ws.js';

const app = createApp();
const server = createServer(app);
const keyRing = new ApiKeyRing(collectApiKeys());
keyRing.setTelemetry(telemetry);
attachMeetingServer(server, keyRing);

server.listen(PORT, HOST, () => {
  console.log(`Backend listo en http://${HOST}:${PORT}`);
  if (!keyRing.hasKeys()) {
    console.log('Sin claves Gemini: la app usara respuestas simuladas hasta que configures .env.');
  }
});
