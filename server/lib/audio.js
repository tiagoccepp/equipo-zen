// Audio routing (PipeWire/WirePlumber): list sinks/sources, move app
// streams, default, volume/mute and test tone.
//
// Box reality (09/11, verified): wpctl has NO --json nor move.
// - Primary listing: `pw-dump` (JSON). Fallback: parsing `wpctl status`.
// - Defaults: `pw-metadata -n default` (keys default.audio.sink/source).
// - Move stream: `pw-metadata -n default <stream> target.node <sink>`
//   (verified live with our own silent stream; -1 = auto).
// - Volume/mute set: `wpctl set-volume/set-mute`; reads via pw-dump
//   (wpctl doesn't expose mute on read).
//
// Everything runs through injectable `run(cmd, args)`: argv spawn with no shell,
// with timeout. Tests inject fakes; this module never touches real audio
// when given a fake runner.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';

export const AUDIO_TIMEOUT_MS = 5000;
export const AUDIO_MAX_BUFFER = 8 * 1024 * 1024;
// Own streams: the equipo/equipo-node ones (app name, node or binary).
export const APP_STREAM_RE = /equipo/i;

export function audioError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Default runner: direct argv (no shell), timeout with SIGKILL.
export function runCommand(cmd, args = [], { timeoutMs = AUDIO_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(audioError('AUDIO_UNAVAILABLE', `no se pudo ejecutar ${cmd}: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      reject(audioError('AUDIO_TIMEOUT', `${cmd} ${args.join(' ')} tardó más de ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < AUDIO_MAX_BUFFER) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        reject(audioError('AUDIO_UNAVAILABLE', `falta el comando ${cmd} (¿PipeWire/WirePlumber instalado?)`));
      } else {
        reject(audioError('AUDIO_SPAWN', `no se pudo ejecutar ${cmd}: ${err?.message || err}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function asRun(run) {
  return typeof run === 'function' ? run : (cmd, args, opts) => runCommand(cmd, args, opts);
}

async function mustOk(run, cmd, args, opts) {
  const res = await asRun(run)(cmd, args, opts);
  if (res.code !== 0) {
    throw audioError('AUDIO_CMD', `${cmd} ${args.join(' ')} salió ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`);
  }
  return res.stdout;
}

// ── Pure parsers ─────────────────────────────────────────────────────

function avgVolume(vols) {
  if (!Array.isArray(vols) || vols.length === 0) return null;
  const nums = vols.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function propsOf(obj) {
  return obj?.info?.props || {};
}

function firstPropsParams(obj) {
  const list = obj?.info?.params?.Props;
  return (Array.isArray(list) && list[0]) || {};
}

// Full pw-dump → sinks/sources/streams. Streams: only exact classes
// Stream/Output/Audio and Stream/Input/Audio (*/Internal ones are filters).
export function parsePwDump(jsonText) {
  let arr;
  try {
    arr = JSON.parse(String(jsonText || ''));
  } catch {
    throw audioError('AUDIO_PARSE', 'pw-dump devolvió JSON inválido');
  }
  if (!Array.isArray(arr)) throw audioError('AUDIO_PARSE', 'pw-dump devolvió forma inesperada');
  const sinks = [];
  const sources = [];
  const streams = [];
  for (const obj of arr) {
    if (obj?.type !== 'PipeWire:Interface:Node') continue;
    const props = propsOf(obj);
    const mediaClass = String(props['media.class'] || '');
    const id = Number(obj.id);
    if (!Number.isInteger(id)) continue;
    if (mediaClass === 'Audio/Sink' || mediaClass === 'Audio/Source') {
      const params = firstPropsParams(obj);
      const volume = avgVolume(params.channelVolumes) ?? (Number.isFinite(params.volume) ? params.volume : null);
      const entry = {
        id,
        name: String(props['node.name'] || ''),
        description: String(props['node.description'] || props['media.name'] || props['node.name'] || `node ${id}`),
        volume,
        muted: typeof params.mute === 'boolean' ? params.mute : null,
        isDefault: false
      };
      if (mediaClass === 'Audio/Sink') sinks.push(entry);
      else sources.push(entry);
    } else if (mediaClass === 'Stream/Output/Audio' || mediaClass === 'Stream/Input/Audio') {
      streams.push({
        id,
        nodeName: String(props['node.name'] || ''),
        app: String(props['application.name'] || ''),
        binary: String(props['application.process.binary'] || ''),
        mediaClass,
        driverId: Number.isInteger(props['node.driver-id']) ? props['node.driver-id'] : null
      });
    }
  }
  const byId = (a, b) => a.id - b.id;
  sinks.sort(byId);
  sources.sort(byId);
  streams.sort(byId);
  return { sinks, sources, streams };
}

// `pw-metadata -n default` → default names. Prefers default.audio.*
// over default.configured.audio.* (the effective over the configured one).
export function parseDefaultMetadata(text) {
  let sink = null;
  let source = null;
  let cfgSink = null;
  let cfgSource = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/key:'(default\.(?:configured\.)?audio\.(sink|source))'\s+value:'(\{.*?\})'/);
    if (!m) continue;
    let name = null;
    try {
      name = JSON.parse(m[3])?.name ?? null;
    } catch {
      continue;
    }
    if (typeof name !== 'string' || !name) continue;
    const isSink = m[2] === 'sink';
    if (m[1].includes('configured')) {
      if (isSink) cfgSink = name;
      else cfgSource = name;
    } else if (isSink) sink = name;
    else source = name;
  }
  return { sink: sink || cfgSink, source: source || cfgSource };
}

// `wpctl status` (descriptions or -n names) → ids, volumes, defaults.
// Sinks/Sources sections: lines `│  [*]  ID. NAME  [vol: x]`. Streams:
// client lines only (indent 7-8 depending on id digits); Video is ignored.
export function parseWpctlStatus(text) {
  const sinks = [];
  const sources = [];
  const streams = [];
  let section = null;
  let video = false; // Video brings its own Sinks/Sources: not audio.
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*Audio\s*$/.test(line)) { video = false; section = null; continue; }
    if (/^\s*Video\s*$/.test(line)) { video = true; section = null; continue; }
    if (video) continue;
    if (/Sinks:/.test(line)) { section = 'sinks'; continue; }
    if (/Sources:/.test(line)) { section = 'sources'; continue; }
    if (/Streams:/.test(line)) { section = 'streams'; continue; }
    if (/Devices:|Filters:|Clients:|Video|Settings|Default Configured/.test(line)) { section = null; continue; }
    if (!section) continue;
    if (section === 'streams') {
      // Client at indent 7-8 (id is right-aligned); ports at 12+.
      const m = line.match(/^ {7,8}(\d+)\.\s+(\S(?:.*?\S)?)\s*$/);
      if (!m) continue;
      streams.push({ id: Number(m[1]), nodeName: '', app: m[2].trim(), binary: '', mediaClass: '', driverId: null });
      continue;
    }
    const m = line.match(/([* ])\s+(\d+)\.\s+(.+?)(?:\s+\[vol:\s*([\d.]+)\])?\s*$/);
    if (!m) continue;
    const entry = {
      id: Number(m[2]),
      name: m[3].trim(),
      description: m[3].trim(),
      volume: m[4] !== undefined ? Number(m[4]) : null,
      muted: null,
      isDefault: m[1] === '*'
    };
    if (section === 'sinks') sinks.push(entry);
    else sources.push(entry);
  }
  return { sinks, sources, streams };
}

export function isAppStream(stream) {
  if (!stream) return false;
  return [stream.app, stream.nodeName, stream.binary].some((v) => typeof v === 'string' && APP_STREAM_RE.test(v));
}

// ref: numeric id ('80'/80) or node.name. Returns the node or null.
export function resolveNode(nodes, ref) {
  if (ref === null || ref === undefined) return null;
  const s = String(ref).trim();
  if (!s || s.toLowerCase() === 'default') return null;
  const asId = Number(s);
  if (Number.isInteger(asId)) {
    const byId = (nodes || []).find((n) => n.id === asId);
    if (byId) return byId;
  }
  return (nodes || []).find((n) => n.name === s) || null;
}

// ── Operations ───────────────────────────────────────────────────────

function markDefaults(devices, defaults) {
  if (defaults?.sink) {
    for (const s of devices.sinks) s.isDefault = s.name === defaults.sink;
  }
  if (defaults?.source) {
    for (const s of devices.sources) s.isDefault = s.name === defaults.source;
  }
  return devices;
}

async function listViaPwDump(run) {
  const dump = await mustOk(run, 'pw-dump', []);
  const devices = parsePwDump(dump);
  try {
    const meta = await mustOk(run, 'pw-metadata', ['-n', 'default']);
    markDefaults(devices, parseDefaultMetadata(meta));
  } catch {
    // Without metadata we still serve the listing (isDefault=false).
  }
  return { ...devices, backend: 'pw-dump', available: true };
}

async function listViaWpctl(run) {
  // -n gives node.names; plain status gives nice descriptions. Merge by id.
  const [names, desc] = await Promise.all([
    mustOk(run, 'wpctl', ['status', '-n']),
    mustOk(run, 'wpctl', ['status'])
  ]);
  const a = parseWpctlStatus(names);
  const b = parseWpctlStatus(desc);
  const byId = (list) => new Map(list.map((n) => [n.id, n]));
  const merge = (primary, secondary) => primary.map((n) => ({
    ...n,
    name: n.name,
    description: byId(secondary).get(n.id)?.description || n.name
  }));
  const sinks = merge(a.sinks, b.sinks);
  const sources = merge(a.sources, b.sources);
  return { sinks, sources, streams: a.streams, backend: 'wpctl', available: true };
}

export async function listDevices({ run } = {}) {
  try {
    return await listViaPwDump(run);
  } catch (err) {
    if (err?.code !== 'AUDIO_UNAVAILABLE' && err?.code !== 'AUDIO_CMD' && err?.code !== 'AUDIO_PARSE') throw err;
    // Fallback to text wpctl; if that's missing too, single clear error.
    try {
      return await listViaWpctl(run);
    } catch {
      throw audioError(
        'AUDIO_UNAVAILABLE',
        'PipeWire no disponible: faltan pw-dump/wpctl o el daemon no responde (¿sesión sin PipeWire?)'
      );
    }
  }
}

export async function setDefaultNode(ref, { run, devices } = {}) {
  const dev = devices || (await listDevices({ run }));
  const node = resolveNode([...dev.sinks, ...dev.sources], ref);
  if (!node) throw audioError('AUDIO_NO_DEVICE', `dispositivo de audio desconocido: ${String(ref).slice(0, 120)}`);
  await mustOk(run, 'wpctl', ['set-default', String(node.id)]);
  return node;
}

export function formatVolume(volume) {
  const v = Math.max(0, Math.min(1, Number(volume)));
  if (!Number.isFinite(v)) throw audioError('AUDIO_BAD_VOLUME', `volumen inválido: ${String(volume).slice(0, 32)}`);
  return String(Math.round(v * 100) / 100);
}

export async function setNodeVolume(ref, volume, { run, devices } = {}) {
  const dev = devices || (await listDevices({ run }));
  const node = resolveNode([...dev.sinks, ...dev.sources], ref);
  if (!node) throw audioError('AUDIO_NO_DEVICE', `dispositivo de audio desconocido: ${String(ref).slice(0, 120)}`);
  await mustOk(run, 'wpctl', ['set-volume', String(node.id), formatVolume(volume)]);
  return node;
}

export async function setNodeMute(ref, muted, { run, devices } = {}) {
  const dev = devices || (await listDevices({ run }));
  const node = resolveNode([...dev.sinks, ...dev.sources], ref);
  if (!node) throw audioError('AUDIO_NO_DEVICE', `dispositivo de audio desconocido: ${String(ref).slice(0, 120)}`);
  await mustOk(run, 'wpctl', ['set-mute', String(node.id), muted ? '1' : '0']);
  return node;
}

// Moves the app's LIVE streams to the given sink/source. kind:
// 'playback' (Stream/Output/Audio → sink) or 'capture' (Stream/Input/Audio →
// source). No live streams is not a failure: nothing to move.
export async function moveAppStreams(targetRef, { run, devices, kind = 'playback' } = {}) {
  const dev = devices || (await listDevices({ run }));
  const pool = kind === 'capture' ? dev.sources : dev.sinks;
  const target = resolveNode(pool, targetRef);
  if (!target) throw audioError('AUDIO_NO_DEVICE', `dispositivo de audio desconocido: ${String(targetRef).slice(0, 120)}`);
  const wanted = kind === 'capture' ? 'Stream/Input/Audio' : 'Stream/Output/Audio';
  const ours = dev.streams.filter((s) => (s.mediaClass === wanted || (!s.mediaClass && kind === 'playback')) && isAppStream(s));
  const moved = [];
  for (const s of ours) {
    await mustOk(run, 'pw-metadata', ['-n', 'default', String(s.id), 'target.node', String(target.id)]);
    moved.push(s.id);
  }
  return { target, moved };
}

// Unpin: streams go back to following the system default.
export async function unpinAppStreams({ run, devices } = {}) {
  const dev = devices || (await listDevices({ run }));
  const ours = dev.streams.filter(isAppStream);
  const unpinned = [];
  for (const s of ours) {
    await mustOk(run, 'pw-metadata', ['-n', 'default', String(s.id), 'target.node', '-1']);
    unpinned.push(s.id);
  }
  return { unpinned };
}

// 16-bit mono WAV: tone with fade in/out (no clicks). Pure → testable.
export function beepWavBytes({ freq = 880, ms = 400, rate = 48000 } = {}) {
  const n = Math.max(1, Math.floor((rate * ms) / 1000));
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  const fade = Math.min(Math.floor(n / 10), Math.floor(rate * 0.02));
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let amp = 0.5;
    if (i < fade) amp *= i / fade;
    if (i >= n - fade) amp *= (n - 1 - i) / fade;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * amp * 32767), 44 + i * 2);
  }
  return data;
}

// Test tone to the given sink (or the default if ref is empty/'default').
export async function playTestTone(sinkRef, { run, tmpFile } = {}) {
  const file = tmpFile || join(tmpdir(), `equipo-beep-${process.pid}-${Date.now()}.wav`);
  const owned = !tmpFile;
  await writeFile(file, beepWavBytes());
  try {
    const args = [];
    const s = String(sinkRef || '').trim();
    if (s && s.toLowerCase() !== 'default') args.push('--target', s);
    args.push(file);
    await mustOk(run, 'pw-play', args, { timeoutMs: 10000 });
    return { ok: true, file: owned ? null : file };
  } finally {
    if (owned) await unlink(file).catch(() => {});
  }
}

// Applies the saved selection. Never throws: returns {ok, error?} so
// the settings PUT reports without breaking the save.
export async function applyAudioSettings(selection = {}, { run } = {}) {
  const { output = 'default', input = 'default', followDefault = true } = selection;
  try {
    const devices = await listDevices({ run });
    if (followDefault) {
      const { unpinned } = await unpinAppStreams({ run, devices });
      return { ok: true, followed: true, unpinned };
    }
    const moved = [];
    if (output && String(output).toLowerCase() !== 'default') {
      await setDefaultNode(output, { run, devices });
      const r = await moveAppStreams(output, { run, devices, kind: 'playback' });
      moved.push(...r.moved);
    }
    if (input && String(input).toLowerCase() !== 'default') {
      await setDefaultNode(input, { run, devices });
      const r = await moveAppStreams(input, { run, devices, kind: 'capture' });
      moved.push(...r.moved);
    }
    return { ok: true, followed: false, moved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
