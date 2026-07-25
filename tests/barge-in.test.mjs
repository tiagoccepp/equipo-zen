import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BARGE_IN, evaluateBargeIn, idleBargeInState, trimPreBuffer } from '../src/lib/barge-in.ts';

// El AudioWorklet de captura manda frames de 60 ms (16 kHz mono).
const FRAME_MS = 60;

// Umbral real con la sensibilidad por defecto (55): 0.062 - 0.55 * 0.052.
const START = 0.0334;
// Por encima de esto un frame cuenta para confirmar (1.4 × START ≈ 0.0468).
const LOUD = START * BARGE_IN.confirmRatio;

// Niveles RMS medidos en el pipeline real (0..1 sobre PCM 16 bit):
//   sala en silencio con noiseSuppression   ~0.004
//   ventilador / aire acondicionado          ~0.020  (bajo el umbral)
//   eco del agente por el parlante           ~0.040  (sobre el umbral, bajo 1.4×)
//   voz normal a 30 cm                        0.09 – 0.18
//   portazo / golpe en la mesa                0.60 en un solo frame
const SALA = 0.004;
const VENTILADOR = 0.02;
const ECO_DEL_AGENTE = 0.04;
const PORTAZO = 0.6;

// Corre una tira de frames por el evaluador y devuelve la bitácora. `atMs`
// es el momento en que la decisión está disponible: el worklet entrega el
// frame recién cuando terminó de grabarlo, así que es el FIN del frame.
function reproducir(frames, opciones = {}) {
  const { agentSpeaking = true, userSpeaking = false, state = idleBargeInState() } = opciones;
  let actual = state;
  let elapsedMs = 0;
  const eventos = [];
  for (const frame of frames) {
    const rms = typeof frame === 'number' ? frame : frame.rms;
    const durationMs = typeof frame === 'number' ? FRAME_MS : (frame.durationMs ?? FRAME_MS);
    const decision = evaluateBargeIn(actual, {
      rms,
      durationMs,
      startThreshold: START,
      agentSpeaking: typeof frame === 'object' && 'agentSpeaking' in frame ? frame.agentSpeaking : agentSpeaking,
      userSpeaking
    });
    elapsedMs += durationMs;
    actual = decision.state;
    if (decision.duck) eventos.push({ tipo: 'duck', atMs: elapsedMs, rms });
    if (decision.interrupt) eventos.push({ tipo: 'interrupt', atMs: elapsedMs, rms });
    if (decision.reset) eventos.push({ tipo: 'reset', atMs: elapsedMs, rms });
  }
  return { eventos, state: actual, elapsedMs };
}

const primero = (eventos, tipo) => eventos.find((evento) => evento.tipo === tipo);
const contar = (eventos, tipo) => eventos.filter((evento) => evento.tipo === tipo).length;
const repetir = (valor, veces) => Array.from({ length: veces }, () => valor);

test('un "perdón—" murmurado baja el volumen del agente pero no lo interrumpe', () => {
  // Interjección bajo el aliento: ataque, un núcleo fuerte de 120 ms y se
  // apaga. La persona no siguió hablando, así que el agente tiene que
  // recuperar el volumen y seguir su turno.
  const { eventos, state } = reproducir([
    ...repetir(SALA, 5),
    0.041, // "per-" arranca flojo: alcanza para duck, no para confirmar
    0.098, // "-dón" núcleo
    0.072,
    0.030, // se apaga
    ...repetir(SALA, 6)
  ]);

  assert.equal(contar(eventos, 'interrupt'), 0, 'un carraspeo corto no puede cortar al agente');
  const duck = primero(eventos, 'duck');
  assert.ok(duck, 'igual hay que bajarle el volumen al agente');
  assert.equal(duck.atMs - 5 * FRAME_MS, FRAME_MS, 'el duck sale con el primer frame de voz, sin esperar nada');

  const reset = primero(eventos, 'reset');
  assert.ok(reset, 'al quedarse callada hay que devolver el volumen');
  // 240 ms de silencio (2 frames por debajo del umbral + histéresis de 160 ms).
  assert.ok(reset.atMs - 9 * FRAME_MS <= 240, `el volumen vuelve rápido (tardó ${reset.atMs - 9 * FRAME_MS} ms)`);
  assert.deepEqual(state, idleBargeInState(), 'y el estado queda limpio');
});

test('la persona arranca a hablar y sostiene la voz: corta al agente en ~300 ms', () => {
  // Envolvente real de "perdón, pará un segundo": ataque suave y después
  // energía sostenida de voz cerca del micrófono.
  const voz = [0.042, 0.104, 0.155, 0.121, 0.168, 0.132, 0.149, 0.118];
  const { eventos } = reproducir([...repetir(SALA, 3), ...voz]);

  const inicioVozMs = 3 * FRAME_MS; // la persona abre la boca acá
  const duck = primero(eventos, 'duck');
  const interrupt = primero(eventos, 'interrupt');

  assert.ok(duck, 'el duck es inmediato');
  assert.equal(duck.atMs - inicioVozMs, FRAME_MS, 'el agente baja el volumen apenas llega el primer frame de voz');
  assert.ok(interrupt, 'la voz sostenida sí interrumpe');

  const latencia = interrupt.atMs - inicioVozMs;
  assert.ok(latencia >= BARGE_IN.confirmMs, `no puede cortar antes de ${BARGE_IN.confirmMs} ms (cortó a ${latencia} ms)`);
  assert.ok(latencia <= 320, `tiene que cortar dentro de ~250-300 ms (cortó a ${latencia} ms)`);
});

test('el ruido de fondo constante por debajo del umbral no toca al agente', () => {
  // 5 segundos de ventilador con micro-variaciones.
  const frames = Array.from({ length: 84 }, (_, index) => VENTILADOR + (index % 5) * 0.002);
  const { eventos, state } = reproducir(frames);

  assert.deepEqual(eventos, [], 'ni duck ni interrupt: el agente ni se entera');
  assert.deepEqual(state, idleBargeInState());
});

test('un golpe seco (portazo) no alcanza para interrumpir', () => {
  // Un único frame altísimo y de vuelta el silencio de la sala.
  const { eventos, state } = reproducir([...repetir(SALA, 4), PORTAZO, ...repetir(SALA, 8)]);

  assert.equal(contar(eventos, 'interrupt'), 0, 'un transitorio no es una persona hablando');
  assert.equal(contar(eventos, 'duck'), 1, 'baja el volumen por las dudas…');
  assert.equal(contar(eventos, 'reset'), 1, '…y lo devuelve al ver que no siguió nadie');
  assert.deepEqual(state, idleBargeInState());
});

test('el eco del propio agente por los parlantes no lo hace interrumpirse solo', () => {
  // Caso peligroso: el parlante devuelve al micrófono la voz del agente.
  // El eco es SOSTENIDO (dura todo el turno) y queda apenas por encima del
  // umbral de arranque, pero por debajo de 1.4× el umbral. Por eso existe
  // ese factor: si confirmáramos con el umbral pelado, el agente se
  // cortaría solo a los 250 ms de empezar a hablar.
  const ecoSostenido = Array.from({ length: 50 }, (_, index) => ECO_DEL_AGENTE + (index % 3) * 0.002);
  assert.ok(ecoSostenido.every((rms) => rms > START && rms < LOUD), 'el eco vive entre el umbral y 1.4×');

  const { eventos, state } = reproducir(ecoSostenido);

  assert.equal(contar(eventos, 'interrupt'), 0, 'el agente nunca se interrumpe a sí mismo');
  assert.equal(state.loudMs, 0, 'el eco no acumula nada hacia la confirmación');
  assert.ok(contar(eventos, 'duck') > 0, 'sí baja el volumen, lo que además reduce el propio eco');
});

test('las pausas entre sílabas no borran lo acumulado, un silencio largo sí', () => {
  const conPausaCorta = reproducir([
    0.12, 0.14, // 120 ms de voz
    SALA, SALA, // 120 ms de aire entre palabras (< releaseMs)
    0.13, 0.15, 0.12 // sigue hablando
  ]);
  assert.ok(primero(conPausaCorta.eventos, 'interrupt'), 'hablar entrecortado igual interrumpe');

  const conPausaLarga = reproducir([
    0.12, 0.14, // 120 ms de voz
    ...repetir(SALA, 5), // 300 ms de silencio (> releaseMs): se soltó el duck
    0.13, 0.15, 0.12 // vuelve a arrancar: la cuenta empieza de cero
  ]);
  assert.equal(contar(conPausaLarga.eventos, 'interrupt'), 0, 'después de un silencio largo hay que sostener de nuevo');
  assert.ok(primero(conPausaLarga.eventos, 'reset'), 'y el volumen del agente volvió durante el silencio');
});

test('después de interrumpir, el estado queda limpio para la próxima', () => {
  // 4 frames de voz fuerte y el corte sale en el último.
  const primeraVez = reproducir(repetir(0.14, BARGE_IN.confirmMs / FRAME_MS));
  const interrupt = primero(primeraVez.eventos, 'interrupt');

  assert.ok(interrupt);
  assert.deepEqual(primeraVez.state, idleBargeInState(), 'sin residuos del corte anterior');

  // Desde el corte la persona pasa a tener el turno: el resto de su frase ya
  // no es barge-in y no tiene que ensuciar nada.
  const restoDeLaFrase = reproducir(repetir(0.15, 12), { state: primeraVez.state, userSpeaking: true });
  assert.deepEqual(restoDeLaFrase.state, idleBargeInState());

  // Contesta otro agente: un frame suelto no puede cortarlo.
  const siguiente = reproducir([PORTAZO, ...repetir(SALA, 5)], { state: restoDeLaFrase.state });
  assert.equal(contar(siguiente.eventos, 'interrupt'), 0, 'la próxima interrupción vuelve a exigir voz sostenida');
});

test('lo acumulado no sobrevive al final del turno del agente', () => {
  // La persona empieza a hablar justo cuando el agente está terminando:
  // acumula 180 ms y el audio del agente se acaba solo. Ese resto no puede
  // quedar guardado para cortar al agente siguiente con un solo golpe.
  const casiConfirmado = reproducir(repetir(0.14, 3));
  assert.equal(casiConfirmado.state.loudMs, 180);

  const agenteTerminó = reproducir([SALA, SALA], { state: casiConfirmado.state, agentSpeaking: false });
  assert.deepEqual(agenteTerminó.state, idleBargeInState(), 'se limpia al quedarse sin agente hablando');
  assert.ok(primero(agenteTerminó.eventos, 'reset'), 'y devuelve el volumen que había bajado');

  const agenteNuevo = reproducir([PORTAZO, SALA], { state: agenteTerminó.state });
  assert.equal(contar(agenteNuevo.eventos, 'interrupt'), 0, 'el agente nuevo no se come el resto del anterior');
});

test('mientras la persona ya tiene el turno no se evalúa barge-in', () => {
  const { eventos, state } = reproducir(repetir(0.2, 6), { userSpeaking: true });
  assert.equal(contar(eventos, 'interrupt'), 0, 'ya está grabando su turno: no hay a quién cortar');
  assert.equal(contar(eventos, 'duck'), 0);
  assert.deepEqual(state, idleBargeInState());
});

test('valores raros (NaN, duración cero, umbral inválido) no disparan nada', () => {
  const decision = evaluateBargeIn(idleBargeInState(), {
    rms: Number.NaN,
    durationMs: Number.NaN,
    startThreshold: 0,
    agentSpeaking: true
  });
  assert.equal(decision.interrupt, false);
  assert.equal(decision.duck, false);
});

test('el pre-buffer guarda toda la ventana de confirmación: la frase llega entera', () => {
  // Cada frame que se pierde del pre-buffer es un pedazo de la primera
  // palabra que Whisper nunca ve.
  const frames = Array.from({ length: 40 }, (_, index) => ({ id: index, durationMs: FRAME_MS }));
  const guardados = trimPreBuffer(frames);
  const msGuardados = guardados.reduce((total, frame) => total + frame.durationMs, 0);

  assert.ok(
    msGuardados >= BARGE_IN.confirmMs + FRAME_MS,
    `hay que guardar al menos la ventana de confirmación (guardó ${msGuardados} ms)`
  );
  assert.equal(guardados.at(-1).id, 39, 'el frame más nuevo siempre queda');
  assert.deepEqual(guardados.map((frame) => frame.id), guardados.map((frame) => frame.id).sort((a, b) => a - b), 'en orden cronológico');
  assert.ok(guardados.length < frames.length, 'pero no se guarda todo el turno');
  assert.deepEqual(trimPreBuffer([]), [], 'sin frames no explota');
});
