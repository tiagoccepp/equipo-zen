// ═══════════════════════════════════════════════════════════════════════
// Barge-in: la decisión de "callá al agente, está hablando la persona".
//
// Vive acá afuera del pipeline de micrófono para poder probarla sin
// navegador: es una función pura que recibe el estado acumulado y un frame
// de audio, y devuelve qué hacer con el audio del agente.
//
// El razonamiento, en criollo:
//
//  1. Apenas entra algo por encima del umbral de voz bajamos el volumen del
//     agente (duck). Es instantáneo y reversible: si era un carraspeo, no
//     pasó nada; si era la persona arrancando a hablar, ya la escuchamos
//     por encima del agente.
//  2. Recién cortamos al agente cuando la voz se SOSTIENE por encima de
//     1.4× el umbral durante `confirmMs`. El factor 1.4 existe por el eco:
//     el parlante devuelve al micrófono la voz del propio agente con un RMS
//     moderado y sostenido, apenas arriba del umbral de arranque. Ese eco
//     hace duck (inofensivo, y encima baja el eco) pero nunca llega a
//     confirmar, así que el agente no se interrumpe solo.
//  3. Un golpe seco (portazo, el mouse contra la mesa) es un frame muy alto
//     y nada más: no llega a `confirmMs` y se descarta.
//  4. Las pausas entre sílabas no borran lo acumulado: recién soltamos el
//     duck y limpiamos el contador después de `releaseMs` de silencio. Sin
//     esa histéresis el volumen del agente bombearía en cada respiración.
// ═══════════════════════════════════════════════════════════════════════

export type BargeInState = {
  // ms de voz "fuerte" (≥ confirmRatio × umbral) acumulados en la ráfaga actual.
  loudMs: number;
  // ms seguidos por debajo del umbral desde el último frame con voz.
  quietMs: number;
  // Si el audio del agente está atenuado y le debemos una restauración.
  ducked: boolean;
};

export type BargeInInput = {
  // RMS del frame (0..1), tal como lo calcula el AudioWorklet de captura.
  rms: number;
  // Duración del frame en ms (60 ms con la captura actual).
  durationMs: number;
  // Umbral de arranque de voz del VAD (depende de la sensibilidad elegida).
  startThreshold: number;
  // ¿Hay un agente sonando o con audio en vuelo? Si no, no hay a quién cortar.
  agentSpeaking: boolean;
  // ¿La persona ya está en su turno? Entonces el barge-in ya cumplió.
  userSpeaking?: boolean;
};

export type BargeInDecision = {
  // Atenuá el audio del agente ahora (latencia cero, sin avisar al servidor).
  duck: boolean;
  // Confirmado: mandá `interrupt` al servidor, cortá el audio y restaurá el volumen.
  interrupt: boolean;
  // Falso positivo o el agente ya terminó: devolvé el volumen y limpiá.
  reset: boolean;
  // Estado a guardar para el próximo frame (la función no muta nada).
  state: BargeInState;
};

// Umbrales del barge-in en un solo lugar (los tests importan estos valores
// en vez de repetir números sueltos).
export const BARGE_IN = {
  // Cuánto más fuerte que el umbral de voz tiene que ser un frame para
  // contar como "la persona está hablando" y no como eco del agente.
  confirmRatio: 1.4,
  // Voz fuerte sostenida necesaria para cortar al agente. Son 4 frames de
  // 60 ms: con 250 ms la cuantización empujaba la confirmación al quinto
  // frame (300 ms de voz fuerte + el ataque = ~360 ms desde que la persona
  // abre la boca), y se sentía tarde. 240 ms sigue siendo mucho más que
  // cualquier transitorio (un portazo dura menos de 100 ms).
  confirmMs: 240,
  // Silencio necesario para soltar el duck (histéresis entre sílabas).
  releaseMs: 160,
  // Cuánto audio previo guardamos para que la frase que dispara el
  // barge-in llegue entera al servidor: la ventana de confirmación más
  // margen para el ataque de la primera palabra.
  preBufferMs: 640
} as const;

export function idleBargeInState(): BargeInState {
  return { loudMs: 0, quietMs: 0, ducked: false };
}

const IDLE: BargeInDecision['state'] = { loudMs: 0, quietMs: 0, ducked: false };

export function evaluateBargeIn(state: BargeInState, input: BargeInInput): BargeInDecision {
  const rms = Number.isFinite(input.rms) ? Math.max(0, input.rms) : 0;
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
  const startThreshold = Number.isFinite(input.startThreshold)
    ? Math.max(0.0001, input.startThreshold)
    : 0.0001;

  // Sin agente hablando (o con la persona ya en su turno) no hay barge-in:
  // el estado vuelve a cero y solo queda devolver el volumen si lo bajamos.
  // Sin esto, un contador a medio llenar sobrevive al turno y el próximo
  // portazo interrumpe al agente siguiente de una.
  if (!input.agentSpeaking || input.userSpeaking) {
    return { duck: false, interrupt: false, reset: state.ducked, state: { ...IDLE } };
  }

  if (rms >= startThreshold) {
    const loudMs = rms >= startThreshold * BARGE_IN.confirmRatio
      ? state.loudMs + durationMs
      : state.loudMs;

    if (loudMs >= BARGE_IN.confirmMs) {
      // Confirmado: el que llama corta el audio, avisa al servidor y
      // restaura el volumen, así que el estado arranca limpio.
      return { duck: false, interrupt: true, reset: false, state: { ...IDLE } };
    }

    return {
      duck: true,
      interrupt: false,
      reset: false,
      state: { loudMs, quietMs: 0, ducked: true }
    };
  }

  // Silencio con nada pendiente: el estado ya está limpio, no lo ensuciamos
  // contando ms de calma que no le importan a nadie.
  if (!state.ducked && state.loudMs === 0) {
    return { duck: false, interrupt: false, reset: false, state: { ...IDLE } };
  }

  const quietMs = state.quietMs + durationMs;
  if (quietMs >= BARGE_IN.releaseMs) {
    return {
      duck: false,
      interrupt: false,
      reset: state.ducked,
      state: { ...IDLE }
    };
  }

  // Pausa corta: seguimos atenuados y no perdemos lo acumulado.
  return {
    duck: false,
    interrupt: false,
    reset: false,
    state: { loudMs: state.loudMs, quietMs, ducked: state.ducked }
  };
}

// Pre-buffer de la captura: los frames previos al arranque del habla que se
// mandan al servidor cuando el VAD confirma voz. Tiene que cubrir toda la
// ventana de confirmación del barge-in; si no, la frase que interrumpe llega
// cortada ("…dón, pará" en vez de "perdón, pará").
export function trimPreBuffer<T extends { durationMs: number }>(
  chunks: T[],
  budgetMs: number = BARGE_IN.preBufferMs
): T[] {
  let total = 0;
  const kept: T[] = [];
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    kept.push(chunk);
    total += Math.max(0, chunk.durationMs);
    if (total >= budgetMs) {
      break;
    }
  }
  return kept.reverse();
}
