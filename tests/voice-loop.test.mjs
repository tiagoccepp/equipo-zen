// E2E test of the voice turn (node:test, skippable).
// Requires the app live: if there is no backend on the detected port, it skips
// with instructions to run it post-merge. The logic lives in
// scripts/voice-smoke.mjs; here it is only adapted to node:test.
//
// Correr:
//   node --test tests/voice-loop.test.mjs
//   VOICE_PORT=46609 node --test tests/voice-loop.test.mjs   (explicit port)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CASOS, detectPort, runVoiceCaseWithRetry } from '../scripts/voice-smoke.mjs';

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
  test(`voice turn E2E [${caso}]`, { timeout: 180_000 }, async (t) => { // 2 attempts × (30s synth+collect) under suite load exceed 90s
    if (!PORT) {
      t.skip('app DOWN: sin puerto (server.log ausente y sin VOICE_PORT). Post-merge: node scripts/voice-smoke.mjs [PORT] both');
      return;
    }
    const base = `http://127.0.0.1:${PORT}`;
    if (!(await appViva(base))) {
      t.skip(`app DOWN en ${base}. Post-merge: levantar la app y correr node scripts/voice-smoke.mjs ${PORT} both`);
      return;
    }
    const res = await runVoiceCaseWithRetry(base, caso, 2);
    t.diagnostic(`intentos=${res.intentos} fuente=${res.fuente} degraded=${res.degraded} transcript=«${res.transcript.slice(0, 100)}»`);
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
