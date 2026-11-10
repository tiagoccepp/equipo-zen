import {
  REFLECTION_ENABLED,
  ROUTER_AUTO_APPLY_VOCAB,
  ROUTER_TUNING_ENABLED
} from './config.js';
import { getMinimaxModels, getTtsLanguage } from './settings.js';
import { completeChat, parseJsonFromModel } from './llm.js';
import { normalize } from './text.js';
import { telemetry } from './telemetry.js';

const REFLECTION_DEBOUNCE_MS = 90000;
const MIN_TURNS_FOR_REFLECTION = 6;
const MAX_AUTO_VOCAB_PER_REFLECTION = 3;
const MIN_VOCAB_TERM_LENGTH = 4;

// Palabras demasiado comunes para volverse dominio/alias por más que se
// repitan (la clase de bug "para"/"alto" no se auto-reintroduce).
const VOCAB_STOPWORDS = new Set([
  'para', 'alto', 'como', 'donde', 'cuando', 'entonces', 'ahora', 'antes',
  'despues', 'tambien', 'entre', 'sobre', 'hasta', 'desde', 'porque',
  'bueno', 'listo', 'dale', 'gracias', 'tema', 'cosa', 'cosas', 'todo',
  'todos', 'reunion', 'equipo', 'sistema', 'empresa'
]);

const REFLECTION_FORMAT_ES = [
  'Respondé ÚNICAMENTE con un JSON válido, sin markdown, con esta forma exacta:',
  '{"title":"título corto en español (máx 8 palabras)","summary":"resumen de 2-4 oraciones en español","vocab":[{"agentId":"<id>","term":"término del negocio"}],"styleHints":[{"agentId":"<id>","hint":"sugerencia de estilo"}]}',
  'vocab y styleHints pueden ser listas vacías.'
].join('\n');

const REFLECTION_FORMAT_EN = [
  'Respond with ONLY valid JSON, no markdown, with this exact shape:',
  '{"title":"short title in English (max 8 words)","summary":"2-4 sentence summary in English","vocab":[{"agentId":"<id>","term":"business term"}],"styleHints":[{"agentId":"<id>","hint":"style suggestion"}]}',
  'vocab and styleHints may be empty lists.',
  'Write the title and summary in English.'
].join('\n');

function reflectionFormat() {
  const en = String(getTtsLanguage() || 'en').toLowerCase().startsWith('en');
  return en ? REFLECTION_FORMAT_EN : REFLECTION_FORMAT_ES;
}

// Reflexión post-reunión: resume, sugiere vocabulario para el router y
// propone ajustes de estilo. Vocabulario aditivo se auto-aplica con
// guardarraíles (y changelog + snapshot); estilo/límites SIEMPRE quedan
// como sugerencias pendientes de aprobación del usuario.
export class ReflectionRunner {
  constructor(store, keyRing) {
    this.store = store;
    this.keyRing = keyRing;
    this.timers = new Map();
  }

  // Al cerrar la sesión WS: debounce que se cancela si la reunión resume
  // (protege del ciclo de auto-reconexión del cliente).
  scheduleForMeeting(meetingId) {
    if (!REFLECTION_ENABLED || !this.keyRing.hasKeys()) {
      return;
    }
    this.cancelForMeeting(meetingId);
    const timer = setTimeout(() => {
      this.timers.delete(meetingId);
      void this.run(meetingId).catch((error) => {
        telemetry.add({ type: 'reflection_failed', payload: { meetingId, error: String(error?.message || error).slice(0, 200) } });
      });
    }, REFLECTION_DEBOUNCE_MS);
    this.timers.set(meetingId, timer);
  }

  runNow(meetingId) {
    if (!REFLECTION_ENABLED || !this.keyRing.hasKeys()) {
      return;
    }
    this.cancelForMeeting(meetingId);
    void this.run(meetingId).catch((error) => {
      telemetry.add({ type: 'reflection_failed', payload: { meetingId, error: String(error?.message || error).slice(0, 200) } });
    });
  }

  cancelForMeeting(meetingId) {
    const timer = this.timers.get(meetingId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(meetingId);
    }
  }

  async run(meetingId) {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting || meeting.turn_count < MIN_TURNS_FOR_REFLECTION || meeting.summary) {
      return;
    }

    const turns = this.store.recentTurns(meetingId, 200);
    const agents = this.store.listAgents();
    const transcript = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');

    const prompt = [
      'Sos el analista post-reunión de un sistema de agentes IA.',
      'Analizá la transcripción y devolvé el JSON pedido.',
      '',
      'Para "vocab": SOLO términos específicos del negocio que el usuario usó varias veces',
      'y que el agente correspondiente NO tiene en sus dominios (mirá la lista). Nada genérico.',
      'Para "styleHints": solo si hubo fricción evidente (respuestas muy largas, tono equivocado). Máximo 2.',
      '',
      `AGENTES Y SUS DOMINIOS: ${JSON.stringify(agents.map((agent) => ({ id: agent.id, name: agent.name, domains: agent.domains })))}`,
      '',
      'TRANSCRIPCIÓN:',
      transcript.slice(0, 24000)
    ].join('\n');

    const { text: responseText } = await completeChat(this.keyRing, {
      models: getMinimaxModels(),
      scope: 'reflexion',
      timeoutMs: 20000,
      maxTokens: 1800,
      temperature: 0,
      messages: [{ role: 'user', content: `${prompt}\n\n${reflectionFormat()}` }]
    });

    const parsed = parseJsonFromModel(responseText);
    if (!parsed?.summary) {
      return;
    }

    this.store.updateMeeting(meetingId, {
      title: String(parsed.title || '').slice(0, 120) || null,
      summary: String(parsed.summary).slice(0, 1200)
    });
    this.store.logChange('reflection', 'meeting', meetingId, 'update', { title: parsed.title });
    telemetry.add({ type: 'reflection_completed', payload: { meetingId, title: parsed.title } });

    if (ROUTER_TUNING_ENABLED) {
      this.applyVocabTuning(parsed.vocab || [], agents);
      this.queueStyleHints(parsed.styleHints || [], agents);
    }
  }

  applyVocabTuning(vocab, agents) {
    let applied = 0;
    for (const item of vocab) {
      if (applied >= MAX_AUTO_VOCAB_PER_REFLECTION) {
        break;
      }
      const agent = agents.find((candidate) => candidate.id === item.agentId);
      const term = normalize(String(item.term || '')).trim();
      if (!agent || term.length < MIN_VOCAB_TERM_LENGTH || VOCAB_STOPWORDS.has(term)) {
        continue;
      }
      if (agent.domains.some((domain) => normalize(domain) === term)) {
        continue;
      }
      // Colisión con vocabulario de otro agente → sugerencia, no auto.
      const collision = agents.some((other) =>
        other.id !== agent.id && (
          other.domains.some((domain) => normalize(domain) === term) ||
          other.aliases.some((alias) => normalize(alias) === term)
        )
      );
      if (collision || !ROUTER_AUTO_APPLY_VOCAB) {
        this.insertSuggestion(agent.id, 'add_domain', term, { reason: collision ? 'colisiona con otro agente' : 'auto-apply deshabilitado' });
        continue;
      }
      this.store.updateAgent(agent.id, { domains: [...agent.domains, term] }, 'router_tuner', `vocabulario detectado en reunión`);
      telemetry.add({ type: 'router_vocab_applied', payload: { agentId: agent.id, term } });
      applied += 1;
    }
  }

  queueStyleHints(styleHints, agents) {
    for (const item of styleHints.slice(0, 2)) {
      const agent = agents.find((candidate) => candidate.id === item.agentId);
      const hint = String(item.hint || '').trim().slice(0, 300);
      if (!agent || !hint) {
        continue;
      }
      this.insertSuggestion(agent.id, 'style_hint', hint, { source: 'reflection' });
    }
  }

  insertSuggestion(agentId, kind, value, evidence) {
    const pending = this.store.listSuggestions('pending');
    if (pending.some((suggestion) => suggestion.agentId === agentId && suggestion.kind === kind && normalize(suggestion.value) === normalize(value))) {
      return;
    }
    this.store.insertSuggestion(agentId, kind, value, evidence);
    telemetry.add({ type: 'router_suggestion_queued', payload: { agentId, kind, value } });
  }
}

// Aplica una sugerencia aprobada por el usuario.
export function applySuggestion(store, suggestion) {
  const agent = store.getAgent(suggestion.agentId);
  if (!agent) {
    return false;
  }
  if (suggestion.kind === 'add_domain' && !agent.domains.some((domain) => normalize(domain) === normalize(suggestion.value))) {
    store.updateAgent(agent.id, { domains: [...agent.domains, suggestion.value] }, 'user', 'sugerencia aprobada');
  } else if (suggestion.kind === 'add_alias' && !agent.aliases.some((alias) => normalize(alias) === normalize(suggestion.value))) {
    store.updateAgent(agent.id, { aliases: [...agent.aliases, suggestion.value] }, 'user', 'sugerencia aprobada');
  } else if (suggestion.kind === 'style_hint') {
    store.updateAgent(agent.id, { style: `${agent.style}\nAjuste aprendido: ${suggestion.value}` }, 'user', 'sugerencia de estilo aprobada');
  } else if (suggestion.kind === 'boundary_hint' && !agent.boundaries.includes(suggestion.value)) {
    store.updateAgent(agent.id, { boundaries: [...agent.boundaries, suggestion.value] }, 'user', 'sugerencia de límite aprobada');
  }
  return true;
}
