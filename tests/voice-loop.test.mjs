// Test E2E del turno de voz (node:test, skipeable).
// Requiere la app viva: si no hay backend en el puerto detectado, se skipea
// con la instrucción para correrlo post-merge. La lógica vive en
// scripts/voice-smoke.mjs; acá solo se adapta a node:test.
//
// Correr:
//   node --test tests/voice-loop.test.mjs
//   VOICE_PORT=46609 node --test tests/voice-loop.test.mjs   (puerto explícito)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CASOS, detectPort, runVoiceCase } from '../scripts/voice-smoke.mjs';

const PORT = detectPort(process.env.VOICE_PORT || process.argv.find((a) => /^\d+$/.test(a)));

async function appViva(base) {
  try {
    const r = await fetch(`${base}/api/companies`, { signal: AbortSignal.timeout(5000) });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}

for (const caso of Object.keys(CASOS)) {
  test(`turno de voz E2E [${caso}]`, { timeout: 90_000 }, async (t) => {
    if (!PORT) {
      t.skip('app DOWN: sin puerto (server.log ausente y sin VOICE_PORT). Post-merge: node scripts/voice-smoke.mjs [PORT] both');
      return;
    }
    const base = `http://127.0.0.1:${PORT}`;
    if (!(await appViva(base))) {
      t.skip(`app DOWN en ${base}. Post-merge: levantar la app y correr node scripts/voice-smoke.mjs ${PORT} both`);
      return;
    }
    const res = await runVoiceCase(base, caso);
    t.diagnostic(`fuente=${res.fuente} degraded=${res.degraded} transcript=«${res.transcript.slice(0, 100)}»`);
    t.diagnostic(`timings=${JSON.stringify(res.timings)}`);
    for (const a of res.asserts) {
      if (a.pass === null) {
        t.diagnostic(`SKIP ${a.nombre}: ${a.detalle}`);
        continue;
      }
      assert.equal(a.pass, true, `${a.nombre}: ${a.detalle}`);
    }
  });
}
