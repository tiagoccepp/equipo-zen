// Turn latency tracking (M-12 base + T6 extensions).
// Records per-turn timings for "first sound", "first useful response",
// and optional stage timings (STT/LLM/TTS/end-to-end) when available.

function n(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function msSince(start, at) {
  const s = n(start);
  const a = n(at);
  if (s === null || a === null) return null;
  return Math.max(0, a - s);
}

// M-12-compatible latency tracker used by agent-runtime.
// start/t0: turn start timestamp (ms). now: injectable clock for tests.
export function createTurnLatency(startOrT0 = Date.now(), now = () => Date.now()) {
  const start = n(startOrT0) ?? Date.now();
  let soundAt = null;
  let usefulAt = null;
  let endAt = null;
  const marks = Object.create(null);
  const meta = Object.create(null);

  const mark = (key, at = now()) => {
    if (!key || marks[key] != null) return;
    marks[key] = at;
  };

  return {
    // M-12: primer sonido audible (cualquier audio/earcon/anuncio).
    markSound(at = now()) {
      if (soundAt === null) soundAt = at;
      mark('first_sound', at);
    },
    // M-12: primera respuesta útil hablable con contenido.
    markUseful(at = now()) {
      if (usefulAt === null) usefulAt = at;
      mark('first_useful', at);
    },
    // T6 extensions (best-effort, never required).
    markLlmFirstToken(at = now()) { mark('llm_first_token', at); },
    markTtsFirstAudio(at = now()) { mark('tts_first_audio', at); mark('first_sound', at); if (soundAt === null) soundAt = at; },
    markSttDone(at = now()) { mark('stt_done', at); },
    markEnd(at = now()) { if (endAt === null) endAt = at; mark('turn_end', at); },
    setMeta(key, value) { if (key) meta[key] = value; },
    addMeta(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) meta[k] = v;
    },
    snapshot(at = now()) {
      const end = endAt ?? at;
      // M-12 shape must remain exactly { ttfsMs, ttfrMs } for existing tests/consumers.
      const base = {
        ttfsMs: soundAt === null ? null : Math.max(0, soundAt - start),
        ttfrMs: usefulAt === null ? null : Math.max(0, usefulAt - start),
      };
      // T6 additive timings: exposed via properties/toJSON without breaking M-12 deepEqual.
      const extra = {
        e2eMs: msSince(start, end),
        llmTtfbMs: msSince(start, marks.llm_first_token ?? marks.first_useful),
        ttsTtfbMs: msSince(start, marks.tts_first_audio ?? marks.first_sound),
        sttMs: n(meta.sttMs),
        startedAt: start,
        endedAt: endAt,
      };
      for (const [k, v] of Object.entries(extra)) {
        Object.defineProperty(base, k, { value: v, enumerable: false, configurable: true });
      }
      Object.defineProperty(base, 'toJSON', {
        value() {
          return { ttfsMs: this.ttfsMs, ttfrMs: this.ttfrMs, ...extra };
        },
        enumerable: false,
        configurable: true
      });
      return base;
    },
  };
}

export function normalizeTurnLatencyRecord(input = {}) {
  const latency = input.latency || input.timings || {};
  const nOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.round(x) : null;
  };
  return {
    turnId: input.turnId ?? null,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    source: input.source ?? null,
    backend: input.backend ?? null,
    interrupted: Boolean(input.interrupted),
    usedMock: Boolean(input.usedMock),
    spoke: input.spoke == null ? null : Boolean(input.spoke),
    at: nOrNull(input.at) ?? Date.now(),
    latency: {
      ttfsMs: nOrNull(latency.ttfsMs),
      ttfrMs: nOrNull(latency.ttfrMs),
      e2eMs: nOrNull(latency.e2eMs),
      llmTtfbMs: nOrNull(latency.llmTtfbMs),
      ttsTtfbMs: nOrNull(latency.ttsTtfbMs),
      sttMs: nOrNull(latency.sttMs),
    },
  };
}
