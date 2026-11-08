// VAD neuronal Silero (v5, 644KB ONNX, ~1-4ms por ventana en CPU).
// Compuerta pre-STT: si el turno capturado no contiene habla real
// (teclado, ventilador, silencio), se descarta SIN transcribir — ahorra
// 1-2s de STT y mata las alucinaciones ("Thank you.") de raíz.
// Si el modelo no carga, verdict=null y todo sigue como antes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = 512; // muestras @16kHz por ventana (32ms)
const STRIDE = 4; // se evalúa 1 de cada 4 ventanas (sobra para binario)
const THRESHOLD = 0.5; // prob de habla por ventana (default oficial)
const MIN_RATIO = 0.12; // fracción mínima de ventanas con habla
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let sessionPromise = null;
let unavailable = false;

async function getSession() {
  if (unavailable) {
    return null;
  }
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const ort = await import('onnxruntime-node');
        const session = await ort.InferenceSession.create(
          path.join(REPO_ROOT, 'models', 'silero_vad.onnx')
        );
        return { ort, session };
      } catch {
        unavailable = true;
        return null;
      }
    })();
  }
  return sessionPromise;
}

function pcmChunksToFloat(chunks) {
  const bufs = [];
  let total = 0;
  for (const b64 of chunks) {
    if (!b64) {
      continue;
    }
    const buf = Buffer.from(String(b64), 'base64');
    bufs.push(buf);
    total += buf.length;
  }
  const raw = Buffer.concat(bufs, total);
  const count = Math.floor(raw.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = raw.readInt16LE(i * 2) / 32768;
  }
  return out;
}

// Veredicto sobre un turno capturado (chunks base64 PCM16 @16k).
// Devuelve null si Silero no está disponible (seguir con STT como siempre).
export async function speechVerdict(chunks) {
  const handle = await getSession();
  if (!handle) {
    return null;
  }
  const { ort, session } = handle;
  const pcm = pcmChunksToFloat(chunks);
  const windows = Math.floor(pcm.length / WIN);
  if (windows < 1) {
    return { speech: false, maxProb: 0, speechRatio: 0, windows: 0 };
  }
  let h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  let c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  let maxProb = 0;
  let speechWins = 0;
  let evaluated = 0;
  const feeds = {};
  // Primer segundo sin salteo (el LSTM arranca frío y los turnos cortos
  // como "sí" necesitan todas sus ventanas); después stride para velocidad.
  let w = 0;
  while (w < windows) {
    const slice = pcm.subarray(w * WIN, w * WIN + WIN);
    const x = new ort.Tensor('float32', Float32Array.from(slice), [1, WIN]);
    feeds[session.inputNames[0]] = x;
    feeds[session.inputNames[1]] = h;
    feeds[session.inputNames[2]] = c;
    const out = await session.run(feeds);
    const prob = out[session.outputNames[0]].data[0];
    h = out[session.outputNames[1]];
    c = out[session.outputNames[2]];
    evaluated += 1;
    if (prob > maxProb) {
      maxProb = prob;
    }
    if (prob >= THRESHOLD) {
      speechWins += 1;
    }
    w += (w < 32 ? 1 : STRIDE);
  }
  const speechRatio = evaluated > 0 ? speechWins / evaluated : 0;
  // Habla si algún momento es claro O si una fracción sostiene habla
  // (turnos cortos como "sí" tienen pocas ventanas pero pico alto).
  const speech = maxProb >= THRESHOLD || speechRatio >= MIN_RATIO;
  return { speech, maxProb, speechRatio, windows: evaluated };
}

export function sileroAvailable() {
  return !unavailable;
}
