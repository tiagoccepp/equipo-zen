// Audio routing: parsers con fixtures reales + operaciones con run fakes.
// NUNCA toca audio real: todo comando PipeWire pasa por un runner inyectado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_STREAM_RE,
  applyAudioSettings,
  beepWavBytes,
  formatVolume,
  isAppStream,
  listDevices,
  moveAppStreams,
  parseDefaultMetadata,
  parsePwDump,
  parseWpctlStatus,
  playTestTone,
  resolveNode,
  setDefaultNode,
  setNodeMute,
  setNodeVolume,
  unpinAppStreams
} from '../server/lib/audio.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(FIX, name), 'utf8');

// Runner fake: mapa 'cmd args...' → {code, stdout}. Registra argv exactos.
function fakeRun(routes, log = []) {
  return async (cmd, args = []) => {
    log.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    if (Object.hasOwn(routes, key)) {
      const r = routes[key];
      return typeof r === 'string' ? { code: 0, stdout: r, stderr: '' } : r;
    }
    throw Object.assign(new Error(`unexpected call: ${key}`), { code: 'AUDIO_UNAVAILABLE' });
  };
}

const DUMP = read('pw-dump.json');
const META = read('pw-metadata-default.txt');
const WPCTL = read('wpctl-status.txt');
const WPCTL_NAMES = read('wpctl-status-names.txt');

test('parsePwDump: sinks/sources/streams reales del box', () => {
  const { sinks, sources, streams } = parsePwDump(DUMP);
  assert.deepEqual(sinks.map((s) => s.id), [60, 70, 80]);
  assert.ok(sinks.every((s) => s.name && s.description));
  assert.ok(sinks.find((s) => s.id === 80).name.startsWith('bluez_output'));
  assert.ok(sources.some((s) => s.id === 59));
  // Streams de la app: equipo 101+110; Brave 112 no es nuestro.
  const ours = streams.filter(isAppStream).map((s) => s.id);
  assert.deepEqual(ours, [101, 110]);
  assert.equal(isAppStream(streams.find((s) => s.id === 112)), false);
  // Volumen/mute parseados (sink 80: mute false, vol numérico).
  const awk = sinks.find((s) => s.id === 80);
  assert.equal(awk.muted, false);
  assert.ok(typeof awk.volume === 'number' && awk.volume > 0);
});

test('parsePwDump rechaza JSON inválido', () => {
  assert.throws(() => parsePwDump('no-json{{'), /JSON inválido/);
  assert.throws(() => parsePwDump('{"a":1}'), /inesperada/);
});

test('parseDefaultMetadata: efectivo sobre configurado', () => {
  const d = parseDefaultMetadata(META);
  assert.equal(d.sink, 'bluez_output.0D_45_E7_0E_0B_A8.1');
  assert.equal(d.source, 'alsa_input.pci-0000_00_1f.3.analog-stereo');
  assert.deepEqual(parseDefaultMetadata('nada útil\n'), { sink: null, source: null });
});

test('parseWpctlStatus: ids, volúmenes y defaults (descripciones)', () => {
  const { sinks, sources, streams } = parseWpctlStatus(WPCTL);
  assert.deepEqual(sinks.map((s) => s.id), [60, 70, 80]);
  assert.deepEqual(sinks.filter((s) => s.isDefault).map((s) => s.id), [80]);
  assert.deepEqual(sources.filter((s) => s.isDefault).map((s) => s.id), [59]);
  assert.equal(sinks.find((s) => s.id === 80).volume, 0.73);
  // Streams: solo clientes (101/110/112/33), no puertos (109, 111...).
  assert.deepEqual(streams.map((s) => s.id), [33, 101, 110, 112]);
  assert.ok(streams.every((s) => s.app.length > 0));
});

test('parseWpctlStatus -n: node.names', () => {
  const { sinks } = parseWpctlStatus(WPCTL_NAMES);
  assert.ok(sinks.find((s) => s.id === 80).name.startsWith('bluez_output'));
});

test('isAppStream matchea equipo/equipo-node, no el resto', () => {
  assert.ok(APP_STREAM_RE.test('equipo-node'));
  assert.equal(isAppStream({ app: 'Brave', nodeName: 'Brave', binary: 'brave' }), false);
  assert.equal(isAppStream({ app: 'WebKitWebProcess', nodeName: 'x', binary: 'y' }), false);
  assert.equal(isAppStream(null), false);
});

test('resolveNode: por id o nombre; default → null', () => {
  const nodes = [{ id: 80, name: 'bluez_x' }, { id: 60, name: 'alsa_y' }];
  assert.equal(resolveNode(nodes, 80).name, 'bluez_x');
  assert.equal(resolveNode(nodes, '80').name, 'bluez_x');
  assert.equal(resolveNode(nodes, 'alsa_y').id, 60);
  assert.equal(resolveNode(nodes, 'default'), null);
  assert.equal(resolveNode(nodes, 'nope'), null);
  assert.equal(resolveNode(nodes, ''), null);
});

test('listDevices vía pw-dump marca defaults (fake, sin audio real)', async () => {
  const devices = await listDevices({
    run: fakeRun({ 'pw-dump': DUMP, 'pw-metadata -n default': META })
  });
  assert.equal(devices.backend, 'pw-dump');
  assert.equal(devices.sinks.find((s) => s.isDefault).id, 80);
  assert.equal(devices.sources.find((s) => s.isDefault).id, 59);
});

test('listDevices fallback a wpctl si falta pw-dump', async () => {
  const log = [];
  const devices = await listDevices({
    run: fakeRun({
      'pw-dump': { code: 1, stdout: '', stderr: 'not found' },
      'wpctl status -n': WPCTL_NAMES,
      'wpctl status': WPCTL
    }, log)
  });
  assert.equal(devices.backend, 'wpctl');
  assert.deepEqual(devices.sinks.map((s) => s.id), [60, 70, 80]);
  // Nombres de -n + descripciones lindas del status normal.
  assert.ok(devices.sinks.find((s) => s.id === 60).name.startsWith('alsa_output'));
  assert.match(devices.sinks.find((s) => s.id === 60).description, /Audio Interno/);
  assert.ok(devices.sinks.every((s) => s.muted === null));
  assert.ok(log[0][0] === 'pw-dump', 'intenta pw-dump primero');
});

test('listDevices sin backend → error claro', async () => {
  await assert.rejects(
    () => listDevices({ run: fakeRun({}) }),
    /PipeWire no disponible/
  );
});

test('moveAppStreams pinnea 101+110 al sink (argv exacto, sin shell)', async () => {
  const log = [];
  const devices = await listDevices({ run: fakeRun({ 'pw-dump': DUMP, 'pw-metadata -n default': META }) });
  const routes = {
    'pw-metadata -n default 101 target.node 60': '',
    'pw-metadata -n default 110 target.node 60': ''
  };
  const r = await moveAppStreams('alsa_output.pci-0000_00_1f.3.analog-stereo', {
    run: fakeRun(routes, log), devices
  });
  assert.deepEqual(r.moved, [101, 110]);
  assert.equal(r.target.id, 60);
  assert.deepEqual(log, [
    ['pw-metadata', '-n', 'default', '101', 'target.node', '60'],
    ['pw-metadata', '-n', 'default', '110', 'target.node', '60']
  ]);
});

test('moveAppStreams sin streams vivos no falla', async () => {
  const log = [];
  const r = await moveAppStreams(80, {
    run: fakeRun({}, log),
    devices: { sinks: [{ id: 80, name: 's' }], sources: [], streams: [] }
  });
  assert.deepEqual(r.moved, []);
  assert.deepEqual(log, []);
});

test('unpinAppStreams vuelve a -1 (auto)', async () => {
  const log = [];
  const devices = await listDevices({ run: fakeRun({ 'pw-dump': DUMP, 'pw-metadata -n default': META }) });
  const r = await unpinAppStreams({
    run: fakeRun({
      'pw-metadata -n default 101 target.node -1': '',
      'pw-metadata -n default 110 target.node -1': ''
    }, log),
    devices
  });
  assert.deepEqual(r.unpinned, [101, 110]);
});

test('setDefaultNode resuelve nombre → id', async () => {
  const log = [];
  const n = await setDefaultNode('bluez_output.0D_45_E7_0E_0B_A8.1', {
    run: fakeRun({ 'wpctl set-default 80': '' }, log),
    devices: { sinks: [{ id: 80, name: 'bluez_output.0D_45_E7_0E_0B_A8.1' }], sources: [], streams: [] }
  });
  assert.equal(n.id, 80);
  assert.deepEqual(log, [['wpctl', 'set-default', '80']]);
  await assert.rejects(
    () => setDefaultNode('no-existe', {
      run: fakeRun({}), devices: { sinks: [], sources: [], streams: [] }
    }),
    /desconocido/
  );
});

test('setNodeVolume/mute: clamp + argv', async () => {
  const log = [];
  const devices = { sinks: [{ id: 80, name: 's' }], sources: [], streams: [] };
  await setNodeVolume(80, 0.733, { run: fakeRun({ 'wpctl set-volume 80 0.73': '' }, log), devices });
  await setNodeVolume(80, 9, { run: fakeRun({ 'wpctl set-volume 80 1': '' }, log), devices });
  await setNodeMute('s', true, { run: fakeRun({ 'wpctl set-mute 80 1': '' }, log), devices });
  assert.deepEqual(log, [
    ['wpctl', 'set-volume', '80', '0.73'],
    ['wpctl', 'set-volume', '80', '1'],
    ['wpctl', 'set-mute', '80', '1']
  ]);
  assert.equal(formatVolume(0.5), '0.5');
  assert.throws(() => formatVolume('xx'), /inválido/);
});

test('beepWavBytes: WAV 16-bit válido', () => {
  const wav = beepWavBytes({ freq: 880, ms: 400, rate: 48000 });
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.length, 44 + 48000 * 0.4 * 2);
  assert.equal(wav.readUInt16LE(20), 1); // PCM
});

test('playTestTone usa --target y limpia el tmp', async () => {
  const log2 = [];
  const r2 = await playTestTone('bluez_output.x', {
    run: async (cmd, args) => {
      log2.push([cmd, ...args]);
      assert.equal(cmd, 'pw-play');
      assert.equal(args[0], '--target');
      assert.equal(args[1], 'bluez_output.x');
      assert.match(args[2], /equipo-beep-.*\.wav/);
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(r2.ok, true);
  assert.equal(log2.length, 1);
  // Sin sink → sin --target (va al default del sistema).
  const log3 = [];
  await playTestTone('', {
    run: async (cmd, args) => {
      log3.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(log3[0][0], 'pw-play');
  assert.equal(log3[0].length, 2, 'solo [pw-play, file]');
});

test('applyAudioSettings followDefault → unpin, no set-default', async () => {
  const log = [];
  const r = await applyAudioSettings(
    { output: 'x', input: 'y', followDefault: true },
    {
      run: fakeRun({
        'pw-dump': DUMP,
        'pw-metadata -n default': META,
        'pw-metadata -n default 101 target.node -1': '',
        'pw-metadata -n default 110 target.node -1': ''
      }, log)
    }
  );
  assert.equal(r.ok, true);
  assert.equal(r.followed, true);
  assert.ok(log.every((argv) => argv[0] !== 'wpctl' || argv[1] !== 'set-default'), 'sin set-default');
});

test('applyAudioSettings output fijo → set-default + move', async () => {
  const log = [];
  const r = await applyAudioSettings(
    { output: 'alsa_output.pci-0000_00_1f.3.analog-stereo', input: 'default', followDefault: false },
    {
      run: fakeRun({
        'pw-dump': DUMP,
        'pw-metadata -n default': META,
        'wpctl set-default 60': '',
        'pw-metadata -n default 101 target.node 60': '',
        'pw-metadata -n default 110 target.node 60': ''
      }, log)
    }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved, [101, 110]);
  assert.ok(log.some((a) => a.join(' ') === 'wpctl set-default 60'));
});

test('applyAudioSettings sink inexistente → {ok:false}, sin tirar', async () => {
  const r = await applyAudioSettings(
    { output: 'no-existe', input: 'default', followDefault: false },
    { run: fakeRun({ 'pw-dump': DUMP, 'pw-metadata -n default': META }) }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /desconocido/);
});

test('applyAudioSettings sin backend → {ok:false}', async () => {
  const r = await applyAudioSettings(
    { output: 'x', input: 'default', followDefault: false },
    { run: fakeRun({}) }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /PipeWire no disponible/);
});

// ── Settings keys (store fake, sin SQLite) ──────────────────────────

import {
  applySettings,
  getAudioFollowDefault,
  getAudioInput,
  getAudioOutput,
  initSettings,
  publicSettings
} from '../server/lib/settings.js';

function fakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getSetting: (k) => map.get(k) ?? null,
    setSetting: (k, v) => map.set(k, v),
    deleteSetting: (k) => map.delete(k),
    logChange: () => {}
  };
}

test('settings audio: defaults (followDefault true)', () => {
  initSettings(fakeStore(), { setKeys: () => {} });
  assert.equal(getAudioOutput(), 'default');
  assert.equal(getAudioInput(), 'default');
  assert.equal(getAudioFollowDefault(), true);
  assert.deepEqual(publicSettings().audio, { output: 'default', input: 'default', followDefault: true });
});

test('settings audio: patch válido aplica + inválido se descarta', () => {
  const store = fakeStore();
  initSettings(store, { setKeys: () => {} });
  const applied = applySettings({
    'audio.output': 'bluez_output.0D_45_E7_0E_0B_A8.1',
    'audio.input': 'alsa_input.pci-0000_00_1f.3.analog-stereo',
    'audio.followDefault': 'false'
  });
  assert.deepEqual(applied.sort(), ['audio.followDefault', 'audio.input', 'audio.output']);
  assert.equal(getAudioOutput(), 'bluez_output.0D_45_E7_0E_0B_A8.1');
  assert.equal(getAudioFollowDefault(), false);
  // Inválidos: nombre con shell chars, followDefault no-booleano.
  const applied2 = applySettings({ 'audio.output': 'x; rm -rf /', 'audio.followDefault': 'maybe' });
  assert.deepEqual(applied2, []);
  assert.equal(getAudioOutput(), 'bluez_output.0D_45_E7_0E_0B_A8.1', 'no pisa con inválido');
  // Vacío borra override → vuelve a default.
  applySettings({ 'audio.output': '' });
  assert.equal(getAudioOutput(), 'default');
});
