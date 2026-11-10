#!/usr/bin/env node
// E2E harness for the voice turn: synthesizes audio (Piper) or uses a synthetic
// beep (DEGRADED), sends it over WS as audio_chunk frames and validates
// the full loop: STT → turn → agent reply → TTS.
//
// Usage:
//   node scripts/voice-smoke.mjs [PORT] [caso]
//   PORT: backend port (default: autodetected from server.log)
//   caso: en | es | both (default: both)
//
// Exit: 0 = all PASS, 1 = some FAIL, 2 = infra DOWN (app or network down).
//
// All localhost: doesn't go through the proxy (Tito rule 08/11 N/A here).

import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// All localhost (backend + Piper on 127.0.0.1): no_proxy='*' so the
// environment proxy doesn't break fetches. NOTE: deleting HTTP_PROXY at runtime
// does NOT work (undici reads it at startup); no_proxy is evaluated per request.
process.env.no_proxy = '*';
process.env.NO_PROXY = '*';

// --- Test cases: text to synthesize + keywords for the fuzzy match ---
export const CASOS = {
  en: {
    texto: 'The quick brown fox jumps over the lazy dog.',
    vozPiper: 'lessac', // English, masculine
    keywords: ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'],
  },
  es: {
    texto: 'Hola Pablo, ¿cuánto es dos más dos?',
    vozPiper: 'sharvard', // Spanish, masculine
    keywords: ['hola', 'pablo', 'cuanto', 'dos', 'mas'],
  },
};

const PIPER_URL = process.env.PIPER_URL || 'http://127.0.0.1:7791';
// Parakeet does ITN ("dos" → "2"): the fuzzy match expands digits to ES+EN words.
const DIGITO_ES = { 0: 'cero', 1: 'uno', 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho', 9: 'nueve' };
const DIGITO_EN = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' };
const FRAME_SAMPLES = 480; // 30 ms @ 16k, same as the client worklet
const COLECTA_MS = 30_000;

// --- Port: arg > desktop server.log ---
export function detectPort(arg) {
  if (arg && /^\d+$/.test(arg)) return Number(arg);
  const logPath = join(homedir(), '.local/share/com.tiagoccepp.equipo/server.log');
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf8');
    const m = log.match(/Backend listo en http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// --- WAV: minimal RIFF parsing (pcm Int16 mono + rate) ---
function wavToPcm(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('no es WAV');
  let offset = 12;
  let rate = 16000;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d7420) rate = view.getUint32(offset + 12, true); // 'fmt '
    else if (id === 0x64617461) { // 'data'
      const pcm = Buffer.from(buffer.subarray(offset + 8, offset + 8 + size));
      return { pcm: new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)), rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV sin chunk data');
}

// --- Linear resample to 16k mono ---
function resample16k(pcm, rate) {
  if (rate === 16000) return Int16Array.from(pcm);
  const ratio = rate / 16000;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

// --- Test audio: Piper first, synthetic beep if DOWN ---
export async function synthesizeCase(caso) {
  const def = CASOS[caso];
  try {
    const r = await fetch(`${PIPER_URL}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: def.texto, voice: def.vozPiper }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Piper HTTP ${r.status}`);
    const { pcm, rate } = wavToPcm(Buffer.from(await r.arrayBuffer()));
    return { pcm16k: resample16k(pcm, rate), degraded: false, fuente: `piper:${def.vozPiper}@${rate}Hz` };
  } catch (err) {
    // DEGRADED: 440Hz beep 0.5s + silence 0.5s + beep 0.5s. Only validates
    // plumbing (the STT will return empty/noise, and that's fine).
    const beep = (s) => {
      const n = Math.floor(16000 * s);
      const o = new Int16Array(n);
      for (let i = 0; i < n; i++) o[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 20000);
      return o;
    };
    const parts = [beep(0.5), new Int16Array(8000), beep(0.5)];
    const total = parts.reduce((a, p) => a + p.length, 0);
    const pcm16k = new Int16Array(total);
    let off = 0;
    for (const p of parts) { pcm16k.set(p, off); off += p.length; }
    return { pcm16k, degraded: true, fuente: `beep-sintetico (Piper DOWN: ${err.message})` };
  }
}

function pcmToFrames(pcm16k) {
  const frames = [];
  for (let i = 0; i < pcm16k.length; i += FRAME_SAMPLES) {
    const slice = pcm16k.slice(i, i + FRAME_SAMPLES);
    frames.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64'));
  }
  return frames;
}

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- One full E2E case against the live backend ---
export async function runVoiceCase(base, caso) {
  const def = CASOS[caso];
  const resultado = { caso, asserts: [], timings: {}, transcript: '', degraded: false, fuente: '' };
  const assert = (nombre, pass, detalle = '') => {
    resultado.asserts.push({ nombre, pass, detalle });
  };

  // 1) Test audio.
  const { pcm16k, degraded, fuente } = await synthesizeCase(caso);
  resultado.degraded = degraded;
  resultado.fuente = fuente;
  const frames = pcmToFrames(pcm16k);

  // 2) Test company + project (same as charla-e2e.mjs).
  const api = async (ruta, opciones = {}) => {
    const r = await fetch(`${base}${ruta}`, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
    });
    if (!r.ok) throw new Error(`${ruta} → ${r.status}`);
    return r.json();
  };
  const { company } = await api('/api/companies', {
    method: 'POST', body: JSON.stringify({ templateId: 'web' }),
  });
  const { project } = await api(`/api/companies/${company.id}/projects`, {
    method: 'POST', body: JSON.stringify({ title: `voice-smoke-${caso}-${Date.now()}` }),
  });

  // 3) WS: hello + set_voice + frames + audio_end (no transcriptHint: the
  // real STT is tested, not the browser shortcut).
  const ws = new WebSocket(base.replace('http', 'ws') + '/meeting');
  const mensajes = [];
  let tAudioEnd = 0;
  const t = {};
  await new Promise((resolve, reject) => {
    const fin = setTimeout(resolve, COLECTA_MS);
    const terminar = () => { clearTimeout(fin); resolve(); };
    // Early exit: voice turn resolved (answered or empty) + grace.
    // TTS arrives AFTER the text: if there's no audio yet, wait up to
    // 10s (the old fixed 2s cut collection short and made audio-tts flaky); when
    // the audio arrives, the grace goes back to 2s to gather stragglers.
    let graceTimer = null;
    const finTurno = () => {
      if (!graceTimer) graceTimer = setTimeout(terminar, t.agenteAudio === undefined ? 10000 : 2000);
    };
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'hello', companyId: company.id, goalId: project.id }));
    });
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      mensajes.push(m);
      const ahora = Date.now();
      if (m.type === 'meeting_ready') {
        (async () => {
          ws.send(JSON.stringify({ type: 'set_voice', enabled: true }));
          ws.send(JSON.stringify({ type: 'audio_start' }));
          for (const f of frames) {
            ws.send(JSON.stringify({ type: 'audio_chunk', data: f, mimeType: 'audio/pcm;rate=16000' }));
            await new Promise((r) => setTimeout(r, 10)); // ~3x realtime
          }
          tAudioEnd = Date.now();
          ws.send(JSON.stringify({ type: 'audio_end' }));
        })().catch(reject);
      }
      if (m.type === 'user_audio_turn_final' && t.transcript === undefined) {
        t.transcript = ahora - tAudioEnd;
        resultado.transcript = m.text;
      }
      // In DEGRADED there's no transcript: measure until the empty one (the STT ran anyway).
      if (m.type === 'audio_transcription_empty' && t.vacio === undefined) {
        t.vacio = ahora - tAudioEnd;
      }
      if ((m.type === 'agent_transcript_delta' || m.type === 'agent_progress' || m.type === 'agent_turn_complete')
        && m.text !== undefined && t.agenteTexto === undefined && String(m.text || m.delta || '').length > 0) {
        t.agenteTexto = ahora - tAudioEnd;
      }
      if (m.type === 'agent_transcript_delta' && m.delta && t.agenteTexto === undefined) {
        t.agenteTexto = ahora - tAudioEnd;
      }
      if ((m.type === 'agent_audio_chunk' || m.type === 'agent_audio_mp3' || m.type === 'agent_audio_start')
        && t.agenteAudio === undefined) {
        t.agenteAudio = ahora - tAudioEnd;
        // The audio arrived and the turn is already resolved: 2s more is enough.
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = setTimeout(terminar, 2000);
        }
      }
      if (['agent_turn_complete', 'no_agent_response', 'audio_transcription_empty'].includes(m.type)) finTurno();
    });
  });
  ws.close();
  resultado.timings = {
    finAudioMs: pcm16k.length / 16, // duration of the audio sent
    finAudioATranscriptMs: t.transcript ?? null,
    finAudioAVacioMs: t.vacio ?? null,
    finAudioAPrimerTextoMs: t.agenteTexto ?? null,
    finAudioAPrimerAudioMs: t.agenteAudio ?? null,
  };

  // 4) Asserts.
  const finales = mensajes.filter((m) => m.type === 'user_audio_turn_final');
  const vacios = mensajes.filter((m) => m.type === 'audio_transcription_empty');
  const dupRecibidos = mensajes.filter((m) => m.type === 'user_turn_received' && m.source === 'audio');
  const errores = mensajes.filter((m) => m.type === 'error');

  if (degraded) {
    // Plumbing only: the pipeline answered something (final or empty) with no errors.
    assert('pipeline-respondio', finales.length + vacios.length >= 1,
      `finales=${finales.length} vacios=${vacios.length}`);
  } else {
    assert('exactamente-1-final', finales.length === 1, `finales=${finales.length}`);
  }
  assert('cero-user_turn_received-audio', dupRecibidos.length === 0, `dups=${dupRecibidos.length}`);
  assert('cero-errores', errores.length === 0,
    errores.map((e) => e.message).join(' | ').slice(0, 200));

  if (degraded) {
    assert('transcript-fuzzy', null, 'SKIP (DEGRADED: beep sin palabras)');
    assert('texto-agente', null, 'SKIP (DEGRADED: sin turno no hay respuesta)');
    assert('audio-tts', null, 'SKIP (DEGRADED: sin turno no hay TTS)');
  } else {
    let norm = ` ${normalizar(resultado.transcript)} `;
    // Parakeet emits digits (ITN): «2» must match keyword «dos».
    norm = norm.replace(/\b(\d)\b/g, (m, d) => `${m} ${DIGITO_ES[d] || ''} ${DIGITO_EN[d] || ''}`);
    const hits = def.keywords.filter((k) => norm.includes(` ${k} `) || norm.includes(` ${k}`) || norm.includes(`${k} `));
    const ratio = def.keywords.length ? hits.length / def.keywords.length : 0;
    assert('transcript-fuzzy', ratio >= 0.6,
      `${hits.length}/${def.keywords.length} keywords (${Math.round(ratio * 100)}%) «${resultado.transcript.slice(0, 80)}»`);
    const textoAgente = mensajes.some((m) =>
      (m.type === 'agent_turn_complete' && String(m.text || '').trim()) ||
      (m.type === 'agent_transcript_delta' && String(m.delta || '').trim()) ||
      (m.type === 'agent_progress' && String(m.text || '').trim()));
    assert('texto-agente', textoAgente, textoAgente ? 'llegó texto' : 'sin texto del agente');
    const audioTts = mensajes.some((m) =>
      ['agent_audio_chunk', 'agent_audio_mp3', 'agent_audio_start'].includes(m.type));
    assert('audio-tts', audioTts, audioTts ? 'llegó audio' : 'sin audio TTS (¿voz caída?)');
  }

  return resultado;
}

// Best of N attempts (default 2): backends aren't deterministic
// (the LLM sometimes declines by protocol; Deepgram sometimes returns empty
// with ES audio and forced language=en). Each attempt uses a fresh company.
// Asserts stay strict: if the best attempt fails, the case fails.
export async function runVoiceCaseWithRetry(base, caso, intentos = 2) {
  let best = null;
  let bestFails = Infinity;
  for (let i = 1; i <= intentos; i++) {
    const res = await runVoiceCase(base, caso);
    const fails = res.asserts.filter((a) => a.pass === false).length;
    if (!best || fails < bestFails) {
      best = res;
      bestFails = fails;
    }
    best.intentos = i;
    if (fails === 0) {
      break;
    }
  }
  return best;
}

// --- CLI ---
const esMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (esMain) {
  const portArg = process.argv[2];
  const casoArg = (process.argv[3] || 'both').toLowerCase();
  const casos = casoArg === 'both' ? ['en', 'es'] : [casoArg];
  if (!casos.every((c) => CASOS[c])) {
    console.error(`caso inválido: ${casoArg} (usá en | es | both)`);
    process.exit(2);
  }
  const port = detectPort(portArg);
  if (!port) {
    console.error('INFRA DOWN: no se detectó el puerto (¿app corriendo? pasalo como arg).');
    process.exit(2);
  }
  const base = `http://127.0.0.1:${port}`;
  // Quick check that the app answers before spending TTS.
  try {
    const r = await fetch(`${base}/api/companies`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`INFRA DOWN: app no responde en ${base} (${err.message}).`);
    process.exit(2);
  }

  let failCount = 0;
  for (const caso of casos) {
    console.log(`\n=== caso ${caso} (${CASOS[caso].texto}) ===`);
    let res;
    try {
      res = await runVoiceCaseWithRetry(base, caso, 2);
    } catch (err) {
      console.error(`INFRA DOWN durante el caso ${caso}: ${err.message}`);
      process.exit(2);
    }
    console.log(`fuente audio: ${res.fuente}${res.degraded ? ' [DEGRADED]' : ''} (intentos: ${res.intentos})`);
    for (const a of res.asserts) {
      const tag = a.pass === null ? 'SKIP' : a.pass ? 'PASS' : 'FAIL';
      if (a.pass === false) failCount++;
      console.log(`  [${tag}] ${a.nombre}${a.detalle ? ` — ${a.detalle}` : ''}`);
    }
    const tm = res.timings;
    console.log('TIMINGS (ms desde audio_end): ' +
      `audio=${Math.round(tm.finAudioMs)} transcript=${tm.finAudioATranscriptMs ?? tm.finAudioAVacioMs ?? '-'} ` +
      `primer-texto=${tm.finAudioAPrimerTextoMs ?? '-'} primer-audio=${tm.finAudioAPrimerAudioMs ?? '-'}`);
  }
  console.log(failCount ? `\nSMOKE: ${failCount} FAIL` : '\nSMOKE: todo PASS');
  process.exit(failCount ? 1 : 0);
}
