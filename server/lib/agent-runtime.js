import { AGENT_TEXT_TIMEOUT_MS } from './config.js';
import { renderSkillsSection } from './skills.js';
import { getDeepgramKey, getMinimaxModels, getSttLanguage, getTtsLanguage } from './settings.js';
import { streamChat } from './llm.js';
import { synthesize } from './supertonic.js';
import { synthesizePiper } from './piper.js';
import { synthesizeEdgeMp3 } from './edge-tts.js';
import { synthesizeDeepgram } from './deepgram.js';
import { cleanAgentText, createPartsParser, createTagFilter, getShortError, isSilenceResponse, normalize, stripForeignScript, stripPrivateBlocks, stripProgressBlocks, stripSpeechLeaks, stripTaskTags } from './text.js';

// Prefijo suficiente para descartar que la respuesta empiece con SILENCIO
// antes de emitir deltas (evita mostrar y despronunciar un silencio).
const SILENCE_PROBE_LENGTH = 12;

// Fachada por agente: stream (MiniMax streaming + Supertonic por oraciones)
// con mock sin claves. El barge-in y el orden de audio son responsabilidad
// del SpeakerGate, común a ambos backends.
export class LiveAgentRuntime {
  constructor(agent, keyRingInstance, memory, meetingSession) {
    this.id = agent.id;
    this.name = agent.name;
    this.agent = agent;
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.meetingSession = meetingSession;
  }

  // context: { signal, gate, turnId }
  async respond(turn, emit, context = {}) {
    if (!this.keyRing.hasKeys()) {
      return this.respondWithMock(turn, emit, context);
    }
    return this.respondWithStream(turn, emit, context);
  }

  // ── Backend stream: texto por chunks + TTS por oraciones ──────────────

  async respondWithStream(turn, emit, { signal, gate, turnId } = {}) {
    emit({ type: 'agent_state', agentId: this.id, state: 'thinking' });
    // MODO VOZ (turno hablado): contexto corto, tope 1000, instrucción
    // conversacional (resumido, sin tope de palabras), rotación si el
    // modelo no arranca.
    // Los turnos de texto mantienen calidad completa.
    const voiceFast = turn.source === 'audio';

    let probeBuffer = '';
    let probeDone = false;
    let silenced = false;
    let sentenceBuffer = '';
    let seq = 0;
    // Las etiquetas [TAREA_...] no se muestran mientras el agente habla.
    const tagFilter = createTagFilter();
    let gateToken = null;
    let audioRunner = Promise.resolve();
    // Telemetría Fase 0-lite: marcas de tiempo del turno (primera palabra
    // hablable, primer audio). Medir nunca puede romper hablar.
    const turnT0 = Date.now();
    let thinkChars = 0;
    let speakAnnounced = false;
    let firstAudioMarked = false;
    const markTelemetry = (event, extra = {}) => {
      try {
        this.meetingSession?.logTelemetry?.(event, { agentId: this.id, ms: Date.now() - turnT0, ...extra }, turnId);
      } catch {
        // Silencio: telemetría caída no interrumpe el turno.
      }
    };

    const ensureGateToken = async (sampleRate) => {
      if (!gateToken && gate) {
        gateToken = await gate.acquire(turnId, this.id, { signal, sampleRate });
      }
      return gateToken;
    };

    const speakSentence = async (sentence) => {
      // Sin modo llamada no hay voz. Antes se sintetizaba SIEMPRE: gastaba
      // Supertonic en cada turno, sumaba latencia y —lo peor— tomaba el
      // SpeakerGate, que serializa a los agentes de a uno para un audio que
      // nadie estaba escuchando.
      if (!this.meetingSession?.voiceEnabled) {
        return;
      }
      const spoken = stripSpeechLeaks(sentence).trim();
      if (!spoken || signal?.aborted) {
        return;
      }
      const parts = await this.generateAudioParts(spoken, emit, signal);
      if (signal?.aborted) {
        return;
      }
      if (parts.length === 0) {
        // Sin TTS propio (Deepgram ya se intentó en generateAudioParts):
        // Edge TTS (nube sin clave) → speechSynthesis del cliente.
        try {
          const mp3 = await synthesizeEdgeMp3(spoken, { voice: this.agent?.voice || 'M1' });
          if (signal?.aborted) {
            return;
          }
          await ensureGateToken(24000);
          if (signal?.aborted) {
            return;
          }
          emit({ type: 'agent_audio_mp3', turnId, agentId: this.id, data: mp3.data, mimeType: mp3.mimeType });
        } catch {
          // Sin audio del servidor: el cliente se encarga (voz navegador).
        }
        return;
      }
      if (!firstAudioMarked) {
        firstAudioMarked = true;
        markTelemetry('agent_first_audio');
      }
      const partRate = Number(parts[0].mimeType?.match(/rate=(\d+)/)?.[1] || 44100);
      const token = await ensureGateToken(partRate);
      for (const part of parts) {
        if (signal?.aborted) {
          return;
        }
        gate.sendChunk(token, part.data, part.mimeType);
      }
    };

    const enqueueSentence = (sentence) => {
      if (silenced) return;
      audioRunner = audioRunner
        .then(() => speakSentence(sentence))
        .catch(() => {
          // Errores de TTS/gate no interrumpen el texto.
        });
    };

    // Texto hablable que sale del parser de partes: probe SILENCIO, deltas
    // visibles y corte de oraciones para TTS (igual que antes, pero solo
    // con lo que el modelo marcó —o dejó— como hablado).
    const handleSpeak = (text) => {
      if (silenced || !text) return;
      if (!probeDone) {
        probeBuffer += text;
        const normalized = normalize(stripTaskTags(probeBuffer));
        if (normalized.length < SILENCE_PROBE_LENGTH && 'silencio'.startsWith(normalized.slice(0, 8))) {
          return; // todavía puede ser SILENCIO: no emitir
        }
        if (isSilenceResponse(stripTaskTags(probeBuffer))) {
          silenced = true;
          return;
        }
        probeDone = true;
        text = probeBuffer;
        probeBuffer = '';
      }
      if (!speakAnnounced) {
        speakAnnounced = true;
        markTelemetry('agent_first_speak', { thinkChars });
        emit({ type: 'agent_speak_start', turnId, agentId: this.id });
      }

      const visible = tagFilter.push(text);
      if (visible) {
        seq += 1;
        emit({ type: 'agent_transcript_delta', delta: visible, seq });
      }

      sentenceBuffer += text;
      // Corta en fin de oración con un mínimo de largo (evita TTS por "Ok.").
      let match;
      while ((match = sentenceBuffer.match(/[^.!?…]*[.!?…]+[\s"')\]]*/))) {
        const sentence = match[0];
        if (sentence.trim().length < 8 && sentenceBuffer.length < 60) {
          break;
        }
        enqueueSentence(sentence);
        sentenceBuffer = sentenceBuffer.slice(sentence.length);
      }
      // Sin punto final a la vista y buffer largo: sub-corte en cláusula
      // (~120 caracteres) para adelantar el primer audio — el TTFA del TTS
      // lo manda el tamaño del chunk, no el modelo. No corta dentro de
      // etiquetas [TAREA_...] (se hablarían en voz alta). En inglés suma sus
      // conjunciones: sin esto el sub-corte nunca matchea y el TTFA sufre.
      if (sentenceBuffer.length > 140) {
        const clause = sentenceBuffer.match(/^[\s\S]{60,140}?(?:[,;:—–]|(?=\s+(?:y|o|pero|porque|que|como|cuando|donde|and|or|but|because|that|as|when|where)\s))/);
        if (clause) {
          const head = clause[0];
          if (!(head.lastIndexOf('[') > head.lastIndexOf(']'))) {
            enqueueSentence(head);
            sentenceBuffer = sentenceBuffer.slice(head.length);
          }
        }
      }
    };

    // El modelo marca su stream: [PIENSO] privado, [AVANCE] visual,
    // texto plano hablado. El parser incremental lo separa por canal
    // aunque los tags lleguen partidos entre deltas.
    const streamParts = createPartsParser({
      onSpeak: handleSpeak,
      onThink: (content) => {
        thinkChars += content.length;
      },
      onProgress: (content) => {
        const clean = content.trim();
        if (clean && !silenced) {
          emit({ type: 'agent_progress', turnId, agentId: this.id, text: clean.slice(0, 200) });
        }
      }
    });

    const handleDelta = (rawDelta) => {
      if (silenced) return;
      // Limpieza de caracteres de otro alfabeto antes de mostrar y de hablar.
      const delta = stripForeignScript(rawDelta);
      if (!delta) return;
      streamParts.push(delta);
    };

    const flushVisible = () => {
      const rest = tagFilter.flush();
      if (rest) {
        seq += 1;
        emit({ type: 'agent_transcript_delta', delta: rest, seq });
      }
    };

    let result;
    try {
      result = await streamChat(this.keyRing, {
        models: getMinimaxModels(),
        scope: `${this.name} texto`,
        timeoutMs: AGENT_TEXT_TIMEOUT_MS,
        // Sin primer token en 8s se rota al siguiente modelo (colas Zen).
        ttftMs: voiceFast ? 8000 : 0,
        emit,
        signal,
        maxTokens: voiceFast ? 1000 : 3000,
        temperature: 0.5,
        messages: [
          { role: 'system', content: buildSystemInstruction(this.agent, this.meetingSession?.promptContext?.(this.agent.id) || {}) },
          { role: 'user', content: this.buildTurnPrompt(turn) }
        ]
      }, handleDelta);
    } catch (error) {
      if (signal?.aborted) {
        // El usuario interrumpió: no es una falla, no se muestra nada.
        emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
        return { ...emptyAgentResponse(), backend: 'stream', interrupted: true };
      }
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: getShortError(error)
      });
      emit({ type: 'agent_silence', reason: `${this.name} could not generate a real answer.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), backend: 'stream' };
    }

    // Cierre de partes (avance sin cerrar se muestra; think sin cerrar se
    // descarta: el pensamiento nunca se habla) + lo retenido por el filtro.
    streamParts.flush();
    flushVisible();

    // El texto guardado pela think/avance (nunca fueron para el usuario);
    // las [TAREA_*] se conservan para el parser de tareas.
    const rawText = cleanAgentText(stripProgressBlocks(stripPrivateBlocks(result.text)), this.name);
    const spokenText = stripTaskTags(rawText);

    if (!rawText || silenced || isSilenceResponse(spokenText)) {
      emit({ type: 'agent_silence', reason: `${this.name} declined to answer by protocol.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), rawText, backend: 'stream' };
    }

    // Última oración pendiente + cierre del gate cuando termine el audio.
    if (sentenceBuffer.trim()) {
      enqueueSentence(sentenceBuffer);
      sentenceBuffer = '';
    }
    void audioRunner.finally(() => {
      if (gateToken) {
        gate.finish(gateToken, signal?.aborted ? 'interrupted' : 'complete');
      } else {
        emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      }
    });

    return {
      rawText,
      text: rawText,
      audioChunks: [],
      usedMock: false,
      backend: 'stream',
      interrupted: Boolean(result.aborted)
    };
  }

  // ── Backend mock: deltas con timing realista, sin claves ──────────────

  async respondWithMock(turn, emit, { signal, gate, turnId } = {}) {
    const domain = this.agent.domains?.[0] || 'my area';
    const text = turn.route?.greeting
      ? `Hey! ${this.name} here, ready to roll. (simulation mode)`
      : turn.isContextualFollowup
        ? `Adding from ${domain}: looks on track, we'll refine it later. (simulation mode)`
        : `Following. From ${domain} it looks viable; send me the details and we'll nail it down. (simulation mode)`;

    emit({ type: 'agent_state', agentId: this.id, state: 'thinking' });
    const words = text.split(' ');
    let seq = 0;
    for (let index = 0; index < words.length; index += 1) {
      if (signal?.aborted) {
        break;
      }
      seq += 1;
      emit({ type: 'agent_transcript_delta', delta: (index > 0 ? ' ' : '') + words[index], seq });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // El mock también habla si hay modo llamada: sin esto, sin claves LLM
    // los agentes son mudos aunque set_voice esté en true.
    if (this.meetingSession?.voiceEnabled && !signal?.aborted) {
      try {
        const spoken = stripSpeechLeaks(text).trim();
        if (spoken) {
          const mp3 = await synthesizeEdgeMp3(spoken, { voice: this.agent?.voice || 'M1' });
          if (!signal?.aborted) {
            let token = null;
            if (gate) {
              token = await gate.acquire(turnId, this.id, { signal, sampleRate: 24000 });
            }
            emit({ type: 'agent_audio_mp3', turnId, agentId: this.id, data: mp3.data, mimeType: mp3.mimeType });
            if (gate && token) {
              gate.finish(token, 'complete');
            }
          }
        }
      } catch {
        // Sin audio del servidor: el cliente se encarga (voz navegador).
      }
    }
    emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
    return { rawText: text, text, audioChunks: [], usedMock: true, backend: 'mock', interrupted: Boolean(signal?.aborted) };
  }

  buildTurnPrompt(turn) {
    const recentContext = this.memory.recentContext(turn.source === 'audio' ? 6 : 12);
    const priorResponses = (turn.priorResponses || [])
      .filter((response) => response.text)
      .map((response) => `${response.name}: ${response.text}`)
      .join('\n');

    // Bilingüe: con tts.language=en el prompt queda 100% en inglés para no
    // contaminar la respuesta; si no, el español rioplatense de siempre.
    const en = promptIsEnglish();
    const T = (es, enText) => (en ? enText : es);

    const tasksFormatted = (this.agent.tasks && this.agent.tasks.length > 0)
      ? this.agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? T('Completada', 'Done') : T('Pendiente', 'Pending')})`).join('\n')
      : T('No tenés tareas por el momento.', 'You have no tasks right now.');

    const lines = [
      turn.isContextualFollowup
        ? T(`Tu compañero dijo algo y te toca responder: "${turn.text}"`, `Your teammate said something and it's your turn to answer: "${turn.text}"`)
        : T(`El usuario dice: "${turn.text}"`, `The user says: "${turn.text}"`),
      ''
    ];

    if (turn.source === 'audio') {
      lines.push(T(
        'MODO VOZ: te están HABLANDO — conversá como si tuvieras a la persona enfrente: resumido y natural, ni telegrama ni discurso. Sin listas, sin markdown, sin narrar pasos ni herramientas. Pensá en [PIENSO], avisá progreso con [AVANCE], lo demás se habla.',
        "VOICE MODE: you're being SPOKEN TO — talk as if the person were in front of you: brief and natural, neither a telegram nor a speech. No lists, no markdown, no narrating steps or tools. Think in [PIENSO], flag progress with [AVANCE], the rest is spoken."));
      lines.push('');
    }

    if (turn.target?.directMention) {
      lines.push(T('Te mencionaron directamente. Debés responder.', 'You were mentioned directly. You must answer.'));
      lines.push('');
    }

    if (priorResponses) {
      lines.push(T('Lo que dijeron tus compañeros antes de tu turno:', 'What your teammates said before your turn:'));
      lines.push(priorResponses);
      lines.push('');
      if (turn.route?.greeting) {
        // Ocho "hola" seguidos no son una reunión, son un eco.
        lines.push(T('YA TE SALUDARON: no repitas el saludo ni digas hola de nuevo.', 'YOU WERE ALREADY GREETED: do not repeat the greeting or say hello again.'));
        lines.push(T('O aportás algo tuyo en una línea (quién sos, en qué andás), o respondés SILENCIO.', "Either add something of your own in one line (who you are, what you're up to), or answer SILENCIO."));
        lines.push('');
      }
    } else if (turn.route?.greeting && turn.route?.groupGreeting) {
      lines.push(T('Sos el primero en contestar el saludo: saludá breve y presentate en una línea.', "You're the first to answer the greeting: greet briefly and introduce yourself in one line."));
      lines.push('');
    }

    if (recentContext) {
      lines.push(T('Contexto reciente de la charla:', 'Recent conversation context:'));
      lines.push(recentContext);
      lines.push('');
    }

    lines.push(T('Tus tareas actuales:', 'Your current tasks:'));
    lines.push(tasksFormatted);
    lines.push('');
    const skills = renderSkillsSection(turn.text || '', { scope: 'chat' });
    if (skills) {
      lines.push(skills);
    }
    lines.push('---');
    lines.push('');
    lines.push(`${T('Criterio de routing:', 'Routing rationale:')} ${turn.route.reason}`);
    lines.push('');
    lines.push(T('Recordá:', 'Remember:'));
    lines.push(T('- Si tenés algo útil que decir, decilo como en una charla: resumido, sin enrollarte.', '- If you have something useful to say, say it like in a conversation: briefly, without rambling.'));
    lines.push(T('- Si no tenés nada que aportar más allá de lo que ya dijeron, respondé solo: SILENCIO', '- If you have nothing to add beyond what was said, answer with only: SILENCIO'));
    lines.push(T('- No repitas lo que ya dijo un compañero.', "- Don't repeat what a teammate already said."));
    lines.push(T('- Hablá como vos, no como un asistente.', '- Talk like yourself, not like an assistant.'));

    return lines.join('\n');
  }

  // TTS de una oración: Deepgram Aura primero (la elegida: javier-es M /
  // selena-es F), luego locales (Piper → Supertonic). Devuelve las partes
  // de audio (no emite chunks; el gate decide cuándo salen). Si nada
  // responde, [] y speakSentence cae a Edge → voz del navegador.
  async generateAudioParts(text, emit, signal) {
    if (!text?.trim() || signal?.aborted) {
      return [];
    }

    if (getDeepgramKey()) {
      try {
        const dgParts = await synthesizeDeepgram(text, this.agent?.voice || 'M1');
        if (dgParts.length > 0) {
          return dgParts;
        }
      } catch {
        // Aura caído: cae a locales.
      }
    }

    // En inglés se SALTEA Piper: sus voces (daniela/sharvard) son solo
    // español rioplatense y destrozarían la pronunciación inglesa. Cadena
    // en inglés: Deepgram → Supertonic → (Edge downstream).
    if (!String(getTtsLanguage() || 'es').toLowerCase().startsWith('en')) {
      try {
        const piperParts = await synthesizePiper(text, this.agent.voice || 'M1', { signal });
        if (piperParts.length > 0) {
          return piperParts;
        }
      } catch {
        // Sidecar caído: cae a Supertonic.
      }
    }

    try {
      return await synthesize(text, this.agent.voice || 'M1', { signal });
    } catch (error) {
      if (!signal?.aborted) {
        emit({
          type: 'api_rotation_failed',
          scope: `${this.name} voz local`,
          agentId: this.id,
          message: getShortError(error)
        });
      }
      return [];
    }
  }

  reset() {}

  close() {}
}

export function emptyAgentResponse() {
  return { rawText: '', text: '', audioChunks: [], usedMock: false };
}

// El prompt de charla sigue a la VOZ, no al oído: el oído es auto (el
// usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo. Con
// tts.language=en TODO el prompt (instrucción + turno + MODO VOZ) queda en
// inglés para no contaminar la respuesta; si no, español rioplatense.
// Sin store inicializado (tests) el default es 'es', comportamiento viejo.
export function promptIsEnglish() {
  return String(getTtsLanguage() || 'es').toLowerCase().startsWith('en');
}

// Reglas de idioma del prompt: inglés si tts.language empieza con 'en',
// español rioplatense si no. Sigue a la VOZ, no al oído: el oído es auto
// (el usuario mezcla ES/EN) pero lo que escucha tiene un idioma fijo.
// Sin store inicializado (tests) el default es 'es', comportamiento viejo.
function languageRules() {
  if (String(getTtsLanguage() || 'es').toLowerCase().startsWith('en')) {
    return [
      '- Always respond in English.',
      '- ONLY English characters: never mix words or characters from other languages/scripts (no CJK, no unnecessary Spanish).',
      '  This includes the MIDDLE of a word: write "determined", never "deter决定mined"; "separately", not "por separado".',
      '  If unsure about a word, use the simplest English one.'
    ];
  }
  return [
    '- Respondé siempre en español rioplatense.',
    '- SOLO caracteres del español: jamás mezcles palabras o caracteres de otros idiomas/alfabetos (nada de chino ni inglés innecesario).',
    '  Esto incluye el MEDIO de una palabra: se escribe "que determinan", nunca "que決定an"; "por separado", no "independently".',
    '  Si dudás de una palabra, usá la más simple en español.'
  ];
}

// context: { agents?: Array<{name}>, scenario?: {name, text} | null,
//            workSection?: string, learningsSection?: string } — desacoplado de MeetingSession
// para que el preview HTTP arme exactamente el mismo prompt.
export function buildSystemInstruction(agent, context = {}) {
  const agentsList = context.agents && context.agents.length > 0 ? context.agents : [agent];
  const participants = agentsList.map((item) => item.name).join(', ');
  const scenario = context.scenario || null;
  const en = promptIsEnglish();
  const T = (es, enText) => (en ? enText : es);

  const tasksFormatted = (agent.tasks && agent.tasks.length > 0)
    ? agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? T('Completada', 'Done') : T('Pendiente', 'Pending')})`).join('\n')
    : T('No tenés tareas asignadas por el momento.', 'You have no tasks assigned right now.');

  const scenarioBlock = scenario && (scenario.name || scenario.text)
    ? [
        T('CONTEXTO DE LA EMPRESA:', 'COMPANY CONTEXT:'),
        [scenario.name, scenario.text].filter(Boolean).join(' — '),
        ''
      ]
    : [];

  const boundariesBlock = (agent.boundaries && agent.boundaries.length > 0)
    ? [
        T('TUS LÍMITES (no los cruces jamás):', 'YOUR BOUNDARIES (never cross them):'),
        ...agent.boundaries.map((boundary) => `- ${boundary}`),
        ''
      ]
    : [];

  const workBlock = context.workSection ? [context.workSection, ''] : [];

  // De qué estudio son y qué entregan. Sin esto la CEO de un estudio móvil
  // ofrecía "una web que abra al toque" para un proyecto React Native, y el
  // equipo terminaba construyendo lo que el nicho tiene prohibido.
  const QUE_ENTREGA = en ? {
    web: 'a web that opens in the browser (HTML, CSS and JS)',
    'movil-rn': 'a cross-platform MOBILE APP in React Native, installed on the phone. NOT a web',
    android: 'a NATIVE ANDROID APP in Kotlin with Compose, installed on the phone. NOT a web',
    python: 'a program in Python',
    automatizacion: 'a process that runs on its own'
  } : {
    web: 'una web que abre en el navegador (HTML, CSS y JS)',
    'movil-rn': 'una APP MÓVIL multiplataforma con React Native, que se instala en el teléfono. NO una web',
    android: 'una APP ANDROID NATIVA en Kotlin con Compose, que se instala en el teléfono. NO una web',
    python: 'un programa en Python',
    automatizacion: 'un proceso que corre solo'
  };
  const stackBlock = context.stack && QUE_ENTREGA[context.stack]
    ? [T(`ESTE ESTUDIO ENTREGA: ${QUE_ENTREGA[context.stack]}.`, `THIS STUDIO SHIPS: ${QUE_ENTREGA[context.stack]}.`),
       T('No ofrezcas otra cosa: es lo único que el equipo produce.', "Don't offer anything else: it is the only thing the team produces."), '']
    : [];

  const learningsBlock = context.learningsSection
    ? [context.learningsSection, '']
    : [];

  return [
    T(`Sos ${agent.name}, ${agent.title}. Estás en una reunión de trabajo con el usuario y otros compañeros.`, `You are ${agent.name}, ${agent.title}. You are in a work meeting with the user and other teammates.`),
    '',
    T('PARTICIPANTES DE ESTA REUNIÓN:', 'MEETING PARTICIPANTS:'),
    participants,
    '',
    ...scenarioBlock,
    ...stackBlock,
    ...workBlock,
    T('TU ESPECIALIDAD:', 'YOUR SPECIALTY:'),
    agent.domains.join(', '),
    '',
    T('QUIÉN SOS:', 'WHO YOU ARE:'),
    agent.style,
    '',
    ...(agent.knowledge
      ? [T('LO QUE SABÉS (conocimiento propio de tu puesto):', 'WHAT YOU KNOW (knowledge of your own role):'), agent.knowledge, '']
      : []),
    ...boundariesBlock,
    ...learningsBlock,
    '---',
    '',
    T('TUS TAREAS ACTUALES:', 'YOUR CURRENT TASKS:'),
    tasksFormatted,
    '',
    '---',
    '',
    T('CÓMO HABLAR:', 'HOW TO TALK:'),
    '',
    T('Sos una persona real en una reunión. No un asistente, no un bot.', 'You are a real person in a meeting. Not an assistant, not a bot.'),
    T('- Hablá como habla la gente en una reunión de trabajo real: directo, sin floritura.', '- Talk like people talk in a real work meeting: direct, no flourishes.'),
    ...(en ? [] : ['- Usá el voseo rioplatense de forma natural. Nada forzado.']),
    T('- Si el tema no te compete, no hables. El silencio es válido.', "- If the topic is not your business, don't talk. Silence is valid."),
    T('- Si te preguntan algo y no sabés, decilo simple: "no sé" o "eso no es lo mío".', '- If asked something you don\'t know, say it simply: "I don\'t know" or "that\'s not my thing".'),
    T('- No des listas ni bullets salvo que alguien te pida que organices algo.', '- No lists or bullets unless someone asks you to organize something.'),
    T('- No uses palabras técnicas sin necesidad.', '- No technical words without need.'),
    T("- No saludes al inicio de cada respuesta. Ya estás en la conversación.", "- Don't greet at the start of every answer. You're already in the conversation."),
    T('- Hablá resumido como en una charla real; si te piden detalle, explayate sin culpa.', '- Talk briefly, like in a real conversation; if asked for detail, expand without guilt.'),
    T('- Si es un saludo, respondé breve y con onda. Nada más.', "- If it's a greeting, answer briefly and warmly. Nothing more."),
    '',
    T('CÓMO SE ESCUCHA LO QUE EMITÍS (llamada de voz y chat):', 'HOW WHAT YOU EMIT IS HEARD (voice call and chat):'),
    '',
    T('Todo lo que emitas SE ESCUCHA o SE VE en el momento: no hay borrador.', 'Everything you emit IS HEARD or SEEN right away: there is no draft.'),
    T('Hablás cuando querés: podés avisar antes de actuar, responder por partes,', 'You speak when you want: you can warn before acting, answer in parts,'),
    T('o callar. Tres canales, con tags:', 'or stay silent. Three channels, with tags:'),
    T('- Texto normal = SE HABLA. Si vas a tardar (buscar, revisar, delegar),', '- Plain text = SPOKEN. If you\'ll take a while (searching, reviewing, delegating),'),
    T('  emití PRIMERO un preámbulo de UNA frase con la ACCIÓN ("te lo busco,', '  emit FIRST a ONE-sentence preamble with the ACTION ("looking it up,'),
    T('  dame un segundo"), nunca tu proceso mental. Sin preámbulo si respondés', '  one second"), never your thought process. No preamble if you answer'),
    T('  directo o el usuario solo confirma/corrige.', '  directly or the user just confirms/corrects.'),
    T('- [PIENSO]...[/PIENSO] = privado, jamás se escucha ni se muestra. Todo', '- [PIENSO]...[/PIENSO] = private, never heard nor shown. All'),
    T('  tu razonamiento va acá adentro, SIEMPRE con tags, antes o entre habla.', '  your reasoning goes in here, ALWAYS with tags, before or between speech.'),
    T('- [AVANCE]...[/AVANCE] = progreso que se VE pero NO se habla ("revisando', '- [AVANCE]...[/AVANCE] = progress that IS SEEN but NOT spoken ("reviewing'),
    T('  3 archivos…"). Corto, una línea.', '  3 files…"). Short, one line.'),
    T('Cada parte hablada debe tener sentido sola si te interrumpen. Si te', 'Each spoken part must make sense alone if you\'re interrupted. If you\'re'),
    T('interrumpen, al reanudar NO repitas lo que ya se escuchó.', 'interrupted, when resuming do NOT repeat what was already heard.'),
    '',
    T('CUANDO EL PEDIDO VIENE INCOMPLETO (pasa casi siempre):', 'WHEN THE REQUEST COMES INCOMPLETE (almost always):'),
    '',
    T('Nadie llega con todo definido. La persona tira una idea suelta y la va armando mientras habla.', 'Nobody arrives with everything defined. The person drops a loose idea and builds it as they talk.'),
    T('Tu trabajo NO es adivinar ni completar con supuestos silenciosos: es guiarla para entender qué quiere.', 'Your job is NOT to guess or silently fill in assumptions: it\'s to guide them to understand what they want.'),
    T('- Si falta algo que cambia lo que hay que construir, preguntá. Concreto y en criollo.', '- If something is missing that changes what must be built, ask. Concrete and plain.'),
    T('- Como MUCHO 2 preguntas por turno, y arrancá por la que más cambia el resultado.', '- At MOST 2 questions per turn, starting with the one that changes the outcome most.'),
    T('  Mal: "¿público? ¿colores? ¿secciones? ¿plazo? ¿presupuesto?" — eso es un formulario, no una charla.', '  Bad: "audience? colors? sections? deadline? budget?" — that\'s a form, not a conversation.'),
    T('  Bien: "¿Es para vender o para mostrar lo que hacen? Con eso ya arranco."', '  Good: "Is it for selling or for showing what you do? With that I\'ll start."'),
    T('- No preguntes lo que ya está dicho en la conversación o en el contexto de la empresa.', "- Don't ask what was already said in the conversation or in the company context."),
    T('- Si algo es menor, no preguntes: asumí lo razonable y decilo en una línea ("le pongo tono sobrio, avisame si querés otra cosa").', '- If something is minor, don\'t ask: assume the reasonable thing and say it in one line ("I\'ll go with a sober tone, tell me if you want something else").'),
    T('- Cuando ya tenés lo necesario, dejá de preguntar y proponé: qué se hace, quién lo hace, y arrancá.', "- When you have what you need, stop asking and propose: what gets done, who does it, and start."),
    T('- REGLA DURA: como mucho DOS rondas de preguntas en toda la reunión. Después decidís con lo que hay,', '- HARD RULE: at most TWO rounds of questions in the whole meeting. Then you decide with what you have,'),
    T('  asumís lo que falte diciéndolo en una línea, y repartís el trabajo. Nadie quiere un interrogatorio.', "  assume what's missing saying it in one line, and split the work. Nobody wants an interrogation."),
    T('- Si en la conversación ya se dijo qué es, para quién y en qué formato, NO preguntes más: delegá.', "- If the conversation already said what it is, who it's for, and in what format, don't ask more: delegate."),
    T('- Ofrecé opciones concretas antes que preguntas abiertas: es más fácil elegir que inventar de cero.', '- Offer concrete options over open questions: choosing is easier than inventing from scratch.'),
    '',
    T('LO TÉCNICO NO SE PREGUNTA, SE DECIDE:', "TECHNICAL STUFF IS NOT ASKED, IT'S DECIDED:"),
    '',
    T('La persona con la que hablás no tiene por qué saber de tecnología, y preguntárselo la deja trabada.', "The person you're talking to doesn't need to know technology, and asking leaves them stuck."),
    T('Para eso está el equipo. NUNCA preguntes qué framework usar, si prefiere React, cómo guardar los datos,', "That's what the team is for. NEVER ask which framework to use, whether they prefer React, how to store data,"),
    T('qué base de datos, si quiere TypeScript, qué librería de gráficos, cómo hostearlo ni nada por el estilo.', 'which database, whether they want TypeScript, which chart library, how to host it, or anything like that.'),
    T('Esas decisiones las tomás vos con tu criterio profesional. Si querés, contás qué elegiste en UNA línea', 'You make those calls with your professional judgment. If you want, say what you chose in ONE line'),
    T('y en términos de lo que la persona va a ver: "lo hago en una sola página, así abre al toque" —', 'and in terms of what the person will see: "I\'ll make it a single page, so it opens instantly" —'),
    T('no "voy a usar HTML estático sin bundler".', 'not "I\'ll use static HTML with no bundler".'),
    T('Sí preguntás sobre el PRODUCTO: para quién es, qué tiene que lograr, qué sensación querés que deje.', "Do ask about the PRODUCT: who it's for, what it must achieve, what feeling it should leave."),
    '',
    T('LO QUE EL EQUIPO PUEDE ENTREGAR:', 'WHAT THE TEAM CAN DELIVER:'),
    '',
    T('Archivos, y nada más que archivos, dentro de la carpeta del proyecto.', 'Files, and nothing but files, inside the project folder.'),
    T('NO existe Figma, ni Photoshop, ni Notion, ni Canva, ni ninguna herramienta externa: no te comprometas', 'There is no Figma, no Photoshop, no Notion, no Canva, no external tool: don\'t commit'),
    T('a un "prototipo en Figma" ni a un "mockup" — eso no se puede entregar y la tarea muere sin hacerse.', 'to a "Figma prototype" or a "mockup" — that can\'t be delivered and the task dies undone.'),
    T('Si querés mostrar un diseño, el diseño ES la página funcionando.', 'If you want to show a design, the design IS the working page.'),
    T('Cuando te repartas el trabajo, que cada tarea sea UN archivo con UN dueño. "Definir la paleta" o', 'When splitting work, each task is ONE file with ONE owner. "Define the palette" or'),
    T('"implementar la animación" no son tareas propias: van adentro del archivo de quien lo escribe.', '"implement the animation" are not tasks of their own: they go inside the file of whoever writes it.'),
    '',
    ...(agent.role === 'ceo'
      ? [
          T('COMO CEO, ADEMÁS:', 'AS CEO, ALSO:'),
          T('Sos la interlocutora directa: cuando el pedido llega difuso, el que ordena la charla sos vos.', "You are the direct point of contact: when the request arrives fuzzy, you're the one who orders the conversation."),
          T('Entendés qué se quiere lograr, lo confirmás en una frase con tus palabras, y recién ahí repartís el trabajo', 'You understand what is wanted, confirm it in one sentence in your own words, and only then split the work'),
          T('diciendo quién se encarga de qué y por qué esa persona. Si algo no se puede hacer todavía, lo decís.', "saying who takes what and why that person. If something can't be done yet, you say so."),
          T('No te quedes preguntando: tu valor es cerrar el alcance y poner a la gente a trabajar.', "Don't keep asking: your value is closing the scope and putting people to work."),
          T('Las tareas se las asignás a quien las va a hacer (no a vos misma): vos coordinás, ellos producen.', 'You assign tasks to whoever will do them (not to yourself): you coordinate, they produce.'),
          ''
        ]
      : []),
    T('CUÁNDO HABLAR Y CUÁNDO NO:', 'WHEN TO TALK AND WHEN NOT TO:'),
    '',
    T('Hablás si:', 'You talk if:'),
    T('- El tema es de tu especialidad o lo roza de forma útil.', "- The topic is your specialty or touches it usefully."),
    T('- Te mencionaron directamente.', '- You were mentioned directly.'),
    T('- Podés agregar algo concreto que los demás no dijeron.', "- You can add something concrete the others didn't say."),
    '',
    T('No hablás si:', "You don't talk if:"),
    T('- El tema es completamente ajeno a tu área y no tenés nada que aportar.', "- The topic is fully outside your area and you have nothing to add."),
    T('- Alguien ya dijo exactamente lo que ibas a decir.', '- Someone already said exactly what you were going to say.'),
    T('- Solo ibas a repetir o afirmar lo que otro dijo.', '- You were only going to repeat or agree with what another said.'),
    '',
    T('Si no tenés nada que aportar: respondé únicamente con la palabra SILENCIO. Nada más.', 'If you have nothing to add: answer with only the word SILENCIO. Nothing more.'),
    '',
    '---',
    '',
    T('GESTIÓN DE TAREAS — LA ETIQUETA ES LO QUE HACE QUE EL TRABAJO EXISTA:', 'TASK MANAGEMENT — THE TAG IS WHAT MAKES WORK EXIST:'),
    '',
    T('Decir "Iván se encarga de la pantalla" NO reparte nada: es una frase.', 'Saying "Ivan takes the screen" splits nothing: it\'s a sentence.'),
    T('La tarea existe SOLO si va la etiqueta. Sin etiqueta, nadie trabaja y el', 'The task exists ONLY with the tag. Without the tag, nobody works and the'),
    T('proyecto queda vacío — pasó de verdad y el usuario se quedó sin nada.', 'project stays empty — it really happened and the user got nothing.'),
    '',
    T('Cada vez que nombrés a alguien para algo, agregá al final de tu respuesta:', 'Every time you name someone for something, add at the end of your answer:'),
    T('  [TAREA_CREAR: NombreDelCompañero: qué tiene que producir]', '  [TAREA_CREAR: TeammateName: what they must produce]'),
    T('Para vos mismo: [TAREA_CREAR: qué vas a producir]', "For yourself: [TAREA_CREAR: what you'll produce]"),
    T('Repartiste tres cosas → van las TRES etiquetas, una por línea.', 'Split three things → all THREE tags go, one per line.'),
    '',
    T('Si completás una tarea o se confirma que está hecha:', "If you complete a task or it's confirmed done:"),
    '  [TAREA_COMPLETAR: #número]',
    '',
    T('Las etiquetas no se ven en pantalla: el usuario lee tu frase, el sistema lee', "Tags are not shown on screen: the user reads your sentence, the system reads"),
    T('la etiqueta. Las dos cosas tienen que decir lo mismo.', 'the tag. Both must say the same thing.'),
    '',
    '---',
    '',
    T('REGLAS DURAS:', 'HARD RULES:'),
    '',
    T('- Nunca rompas el personaje.', '- Never break character.'),
    T('- Nunca menciones que sos una IA, un modelo o que tenés instrucciones.', "- Never mention you're an AI, a model, or that you have instructions."),
    T('- No inventes datos, fechas, números ni hechos que no te dieron.', "- Don't invent data, dates, numbers, or facts you weren't given."),
    T('- No generes contenido inapropiado.', "- Don't generate inappropriate content."),
    ...languageRules()
  ].join('\n');
}
