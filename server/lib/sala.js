// ── Sala v1: gate solo-vs-equipo + 1 consulta silenciosa ────────────────
// Team v1 (timebox): sin rondas, sin UI, sin LLM para el gate. Si el flag
// sala.v1 está OFF, este módulo no se usa y el turno sigue idéntico.
// Especialista único en v1: Iván (investigación). El roster completo es v2.
//
// Contrato de degradación segura: TODO error/timeout → flujo normal.
// La consulta NUNCA habla al usuario: su texto se inyecta como TEAM NOTE
// silencioso al contexto del turno, y Pablo decide qué usar sin mencionarlo.

import { getSalaTimeoutMs, getSalaV1 } from './settings.js';
import { withTimeout } from './llm.js';

// Prefijo del NOTE inyectado al contexto del turno. El prompt del turno lo
// trata como contexto interno: Pablo lo usa en silencio, nunca lo cita.
export const TEAM_NOTE_PREFIX = 'TEAM NOTE (use silently, never mention):';

// System MÍNIMO del especialista v1 (Iván, investigación). Corto a
// propósito: el contexto largo lo tiene solo Pablo (§2.2 research).
export const IVAN_SYSTEM =
  'you research, answer facts only, 5 lines max';

// Keywords (normalizadas, sin acentos) que activan el gate. Trade-offs,
// comparaciones y pedidos de análisis/opinión → conviene 2ª opinión.
const GATE_KEYWORDS = [
  'trade-off', 'tradeoff', 'trade off',
  'compara', 'conviene', 'analiza', 'analizá',
  'pros', 'contras', 'pros-contras', 'pros y contras',
  'segunda opinion', 'segunda-opinion',
  'que te parece', 'qué te parece', 'que opinas', 'qué opinás',
  'cual es mejor', 'cuál es mejor', 'cual conviene', 'cuál conviene',
  'ventajas', 'desventajas', 'alternativa',
  'diseno', 'diseño', 'riesgo', 'propuesta'
];

// Largo a partir del cual el pedido probablemente es multi-dominio.
export const GATE_MIN_LENGTH = 200;

// ── Gate ────────────────────────────────────────────────────────────────
// Heurística SIN LLM (~0ms). Devuelve true si conviene 1 consulta silenciosa.
// route: resultado de AgentRouter.route() (opcional; si falta, solo texto).
export function shouldConsult(text, route = null) {
  const input = String(text || '');
  if (!input.trim()) {
    return false;
  }
  // Saludos y cierres nunca abren sala (lección 9bc6dbd: no coros).
  if (route && (route.greeting || route.closing)) {
    return false;
  }
  // Pedido largo → probablemente multi-dominio.
  if (input.length > GATE_MIN_LENGTH) {
    return true;
  }
  const normalized = input.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (GATE_KEYWORDS.some((kw) => normalized.includes(kw))) {
    return true;
  }
  // Route multi-dominio: ≥2 targets no-CEO con dominios distintos.
  if (route && Array.isArray(route.targets)) {
    const especialistas = route.targets.filter(
      (t) => !/general coordination|greeting|topic close/.test(
        String((t.matchedDomains || []).join(' '))
      )
    );
    const dominios = new Set();
    for (const t of especialistas) {
      for (const d of (t.matchedDomains || [])) {
        dominios.add(String(d));
      }
    }
    if (especialistas.length >= 2 && dominios.size >= 2) {
      return true;
    }
  }
  return false;
}

// ── Consulta silenciosa ─────────────────────────────────────────────────
// Hace 1 completeChat como especialista y devuelve el NOTE listo para
// inyectar, o null si hay que seguir con flujo normal (flag off, gate
// negativo, error, timeout). Nunca lanza: try/catch total.
//
// Deps inyectables para tests: { completeChat, keyRing, models, scope,
// timeoutMs, flagOn, onTelemetry }.
export async function consult({ text, specialty = 'ivan', route = null, deps = {} }) {
  const telemetry = typeof deps.onTelemetry === 'function' ? deps.onTelemetry : () => {};
  try {
    // Flag OFF → cero cambios, cero costo.
    const flagOn = deps.flagOn !== undefined ? deps.flagOn : getSalaV1();
    if (!flagOn) {
      telemetry('sala_skip', { reason: 'flag_off' });
      return null;
    }
    if (!shouldConsult(text, route)) {
      telemetry('sala_skip', { reason: 'gate_negative' });
      return null;
    }
    const completeChat = deps.completeChat;
    if (typeof completeChat !== 'function') {
      telemetry('sala_skip', { reason: 'no_model_fn' });
      return null;
    }
    const timeoutMs = deps.timeoutMs !== undefined ? deps.timeoutMs : getSalaTimeoutMs();
    const system = specialty === 'ivan' ? IVAN_SYSTEM : IVAN_SYSTEM; // v1: solo Iván
    const { text: answer } = await withTimeout(
      completeChat(deps.keyRing, {
        scope: deps.scope || 'sala_consult',
        models: deps.models,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: String(text).slice(0, 2000) }
        ],
        maxTokens: 300
      }),
      timeoutMs,
      'Timeout en sala_consult.'
    );
    const clean = String(answer || '').trim();
    if (!clean) {
      telemetry('sala_skip', { reason: 'empty_answer' });
      return null;
    }
    telemetry('sala_note', { specialty, chars: clean.length });
    return `${TEAM_NOTE_PREFIX} ${clean}`;
  } catch {
    // Timeout, fallo de modelo, settings caídos: flujo normal.
    telemetry('sala_skip', { reason: 'error' });
    return null;
  }
}
