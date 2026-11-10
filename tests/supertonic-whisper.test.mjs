import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Store } from '../server/lib/store.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import {
  TTS_ENGINE_OPTIONS,
  WHISPER_MODEL_OPTIONS,
  applySettings,
  getTtsEngine,
  getWhisperModel,
  initSettings,
  publicSettings,
  ttsLocalOrder
} from '../server/lib/settings.js';
import { __resetParakeetHealth, transcribeLocal } from '../server/lib/stt.js';

// Local backup 09/11: Supertonic (:7788) + Whisper-tiny-lazy (:7789).
// All with stubs/fakes: nothing touches the real network or needs live sidecars.

function freshSettings() {
  initSettings(new Store(':memory:'), new ApiKeyRing([]));
}

function stubTranscriber(text) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/transcribe') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text, confidence: 0.9 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ── tts.engine ───────────────────────────────────────────────────────

test('tts.engine: default auto, valid options', () => {
  freshSettings();
  assert.deepEqual(TTS_ENGINE_OPTIONS, ['auto', 'piper', 'supertonic']);
  assert.equal(getTtsEngine(), 'auto');
  assert.equal(publicSettings().tts.engine, 'auto');
  assert.deepEqual(publicSettings().tts.engineOptions, ['auto', 'piper', 'supertonic']);
});

test('tts.engine: applySettings accepts valid ones and rejects garbage', () => {
  freshSettings();
  assert.deepEqual(applySettings({ 'tts.engine': 'supertonic' }), ['tts.engine']);
  assert.equal(getTtsEngine(), 'supertonic');
  assert.deepEqual(applySettings({ 'tts.engine': ' elevenlabs ' }), []);
  assert.equal(getTtsEngine(), 'supertonic');
  applySettings({ 'tts.engine': '' });
  assert.equal(getTtsEngine(), 'auto');
});

test('ttsLocalOrder: supertonic reverses, the rest keep Piper first', () => {
  assert.deepEqual(ttsLocalOrder('auto'), ['piper', 'supertonic']);
  assert.deepEqual(ttsLocalOrder('piper'), ['piper', 'supertonic']);
  assert.deepEqual(ttsLocalOrder('supertonic'), ['supertonic', 'piper']);
  assert.deepEqual(ttsLocalOrder('basura'), ['piper', 'supertonic']);
  assert.deepEqual(ttsLocalOrder(), ['piper', 'supertonic']);
});

// ── whisper tiny ─────────────────────────────────────────────────────

test('whisper: tiny in options and default', () => {
  freshSettings();
  assert.ok(WHISPER_MODEL_OPTIONS.includes('tiny'));
  // Default tiny unless WHISPER_MODEL in env (same as small before).
  assert.equal(getWhisperModel(), process.env.WHISPER_MODEL || 'tiny');
  assert.deepEqual(applySettings({ 'stt.whisperModel': 'tiny' }), ['stt.whisperModel']);
  assert.equal(getWhisperModel(), 'tiny');
  assert.deepEqual(applySettings({ 'stt.whisperModel': 'xxl' }), []);
});

// ── STT fallback parakeet-down → whisper ────────────────────────────

test('stt: with parakeet down uses whisper if it answers', async () => {
  freshSettings();
  __resetParakeetHealth();
  const whisper = await stubTranscriber('hola desde whisper');
  try {
    // Closed port = parakeet down: health rejects instantly.
    const res = await transcribeLocal('d2F2', {
      parakeetUrl: 'http://127.0.0.1:9',
      whisperUrl: whisper.url,
      parakeetTimeoutMs: 2000,
      whisperTimeoutMs: 5000
    });
    assert.equal(res.text, 'hola desde whisper');
  } finally {
    whisper.server.close();
  }
});
