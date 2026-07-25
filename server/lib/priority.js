// Prioridad del humano sobre el trabajo de fondo.
//
// El equipo trabajando (pasos de 60-95s contra el modelo) y la persona
// conversando compiten por la MISMA clave de API. Sin arbitraje, el turno de
// la conversación se queda esperando y muere por timeout mientras dos
// empleados escriben archivos. Acá la regla es simple: mientras haya un turno
// humano en vuelo, el motor de trabajo no arranca llamadas nuevas.

let activeTurns = 0;
let lastTurnEndedAt = 0;
// Sesiones de reunión abiertas: con alguien conectado, el equipo trabaja de
// a uno para no saturar la clave que también usa la conversación.
let liveSessions = 0;

// Colchón después del último turno: la persona suele encadenar mensajes, y
// arrancar un paso de trabajo justo ahí volvería a robarle la clave.
const COOLDOWN_MS = Number(process.env.WORKFORCE_YIELD_MS || 4000);

export function beginUserTurn() {
  activeTurns += 1;
}

export function endUserTurn() {
  activeTurns = Math.max(0, activeTurns - 1);
  lastTurnEndedAt = Date.now();
}

// Para tests y reinicios de sesión.
export function resetTurnPriority() {
  activeTurns = 0;
  lastTurnEndedAt = 0;
  liveSessions = 0;
}

export function isUserSpeaking() {
  return activeTurns > 0 || Date.now() - lastTurnEndedAt < COOLDOWN_MS;
}

export function registerSession() {
  liveSessions += 1;
}

export function unregisterSession() {
  liveSessions = Math.max(0, liveSessions - 1);
}

export function hasLiveSession() {
  return liveSessions > 0;
}

export function priorityStatus() {
  return { activeTurns, lastTurnEndedAt, liveSessions };
}
