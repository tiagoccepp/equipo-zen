import { AGENT_TEXT_TIMEOUT_MS } from './config.js';
import { getMinimaxModels } from './settings.js';
import { streamChat } from './llm.js';
import { synthesize } from './supertonic.js';
import { synthesizeEdgeMp3 } from './edge-tts.js';
import { cleanAgentText, createTagFilter, getShortError, isSilenceResponse, normalize, stripForeignScript, stripTaskTags } from './text.js';

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

    let probeBuffer = '';
    let probeDone = false;
    let silenced = false;
    let sentenceBuffer = '';
    let seq = 0;
    // Las etiquetas [TAREA_...] no se muestran mientras el agente habla.
    const tagFilter = createTagFilter();
    let gateToken = null;
    let audioRunner = Promise.resolve();

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
      const spoken = stripTaskTags(sentence).trim();
      if (!spoken || signal?.aborted) {
        return;
      }
      const parts = await this.generateAudioParts(spoken, emit, signal);
      if (signal?.aborted) {
        return;
      }
      if (parts.length === 0) {
        // Sin Supertonic: Edge TTS (nube, sin clave) → un MP3 por oración.
        // Si Edge falla, el cliente habla por speechSynthesis (timeout).
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

    const handleDelta = (rawDelta) => {
      if (silenced) return;
      // Limpieza de caracteres de otro alfabeto antes de mostrar y de hablar.
      let delta = stripForeignScript(rawDelta);
      if (!delta) return;

      if (!probeDone) {
        probeBuffer += delta;
        const normalized = normalize(stripTaskTags(probeBuffer));
        if (normalized.length < SILENCE_PROBE_LENGTH && 'silencio'.startsWith(normalized.slice(0, 8))) {
          return; // todavía puede ser SILENCIO: no emitir
        }
        if (isSilenceResponse(stripTaskTags(probeBuffer))) {
          silenced = true;
          return;
        }
        probeDone = true;
        delta = probeBuffer;
        probeBuffer = '';
      }

      const visible = tagFilter.push(delta);
      if (visible) {
        seq += 1;
        emit({ type: 'agent_transcript_delta', delta: visible, seq });
      }

      sentenceBuffer += delta;
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
        emit,
        signal,
        maxTokens: 3000,
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
      emit({ type: 'agent_silence', reason: `${this.name} no pudo generar una respuesta real.` });
      emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
      return { ...emptyAgentResponse(), backend: 'stream' };
    }

    // Lo retenido por el filtro que al final NO era una etiqueta se muestra.
    flushVisible();

    const rawText = cleanAgentText(result.text, this.name);
    const spokenText = stripTaskTags(rawText);

    if (!rawText || silenced || isSilenceResponse(spokenText)) {
      emit({ type: 'agent_silence', reason: `${this.name} declino responder por protocolo.` });
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

  async respondWithMock(turn, emit, { signal } = {}) {
    const domain = this.agent.domains?.[0] || 'mi área';
    const text = turn.route?.greeting
      ? `¡Buenas! Por acá ${this.name}, listo para arrancar. (modo simulación)`
      : turn.isContextualFollowup
        ? `Sumo desde ${domain}: lo veo bien encaminado, después lo afinamos. (modo simulación)`
        : `Te sigo. Desde ${domain} lo veo viable; pasame el detalle y lo bajamos a tierra. (modo simulación)`;

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
    emit({ type: 'agent_state', agentId: this.id, state: 'idle' });
    return { rawText: text, text, audioChunks: [], usedMock: true, backend: 'mock', interrupted: Boolean(signal?.aborted) };
  }

  buildTurnPrompt(turn) {
    const recentContext = this.memory.recentContext();
    const priorResponses = (turn.priorResponses || [])
      .filter((response) => response.text)
      .map((response) => `${response.name}: ${response.text}`)
      .join('\n');

    const tasksFormatted = (this.agent.tasks && this.agent.tasks.length > 0)
      ? this.agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? 'Completada' : 'Pendiente'})`).join('\n')
      : 'No tenés tareas por el momento.';

    const lines = [
      turn.isContextualFollowup
        ? `Tu compañero dijo algo y te toca responder: "${turn.text}"`
        : `El usuario dice: "${turn.text}"`,
      ''
    ];

    if (turn.target?.directMention) {
      lines.push('Te mencionaron directamente. Debés responder.');
      lines.push('');
    }

    if (priorResponses) {
      lines.push('Lo que dijeron tus compañeros antes de tu turno:');
      lines.push(priorResponses);
      lines.push('');
      if (turn.route?.greeting) {
        // Ocho "hola" seguidos no son una reunión, son un eco.
        lines.push('YA TE SALUDARON: no repitas el saludo ni digas hola de nuevo.');
        lines.push('O aportás algo tuyo en una línea (quién sos, en qué andás), o respondés SILENCIO.');
        lines.push('');
      }
    } else if (turn.route?.greeting && turn.route?.groupGreeting) {
      lines.push('Sos el primero en contestar el saludo: saludá breve y presentate en una línea.');
      lines.push('');
    }

    if (recentContext) {
      lines.push('Contexto reciente de la charla:');
      lines.push(recentContext);
      lines.push('');
    }

    lines.push('Tus tareas actuales:');
    lines.push(tasksFormatted);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`Criterio de routing: ${turn.route.reason}`);
    lines.push('');
    lines.push('Recordá:');
    lines.push('- Si tenés algo útil que decir, decilo en máximo 2 oraciones.');
    lines.push('- Si no tenés nada que aportar más allá de lo que ya dijeron, respondé solo: SILENCIO');
    lines.push('- No repitas lo que ya dijo un compañero.');
    lines.push('- Hablá como vos, no como un asistente.');

    return lines.join('\n');
  }

  // TTS de una oración vía Supertonic local: devuelve las partes de audio
  // (no emite chunks; el gate decide cuándo salen).
  async generateAudioParts(text, emit, signal) {
    if (!text?.trim() || signal?.aborted) {
      return [];
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

// context: { agents?: Array<{name}>, scenario?: {name, text} | null,
//            workSection?: string, learningsSection?: string } — desacoplado de MeetingSession
// para que el preview HTTP arme exactamente el mismo prompt.
export function buildSystemInstruction(agent, context = {}) {
  const agentsList = context.agents && context.agents.length > 0 ? context.agents : [agent];
  const participants = agentsList.map((item) => item.name).join(', ');
  const scenario = context.scenario || null;

  const tasksFormatted = (agent.tasks && agent.tasks.length > 0)
    ? agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? 'Completada' : 'Pendiente'})`).join('\n')
    : 'No tenés tareas asignadas por el momento.';

  const scenarioBlock = scenario && (scenario.name || scenario.text)
    ? [
        'CONTEXTO DE LA EMPRESA:',
        [scenario.name, scenario.text].filter(Boolean).join(' — '),
        ''
      ]
    : [];

  const boundariesBlock = (agent.boundaries && agent.boundaries.length > 0)
    ? [
        'TUS LÍMITES (no los cruces jamás):',
        ...agent.boundaries.map((boundary) => `- ${boundary}`),
        ''
      ]
    : [];

  const workBlock = context.workSection ? [context.workSection, ''] : [];

  // De qué estudio son y qué entregan. Sin esto la CEO de un estudio móvil
  // ofrecía "una web que abra al toque" para un proyecto React Native, y el
  // equipo terminaba construyendo lo que el nicho tiene prohibido.
  const QUE_ENTREGA = {
    web: 'una web que abre en el navegador (HTML, CSS y JS)',
    'movil-rn': 'una APP MÓVIL multiplataforma con React Native, que se instala en el teléfono. NO una web',
    android: 'una APP ANDROID NATIVA en Kotlin con Compose, que se instala en el teléfono. NO una web',
    python: 'un programa en Python',
    automatizacion: 'un proceso que corre solo'
  };
  const stackBlock = context.stack && QUE_ENTREGA[context.stack]
    ? [`ESTE ESTUDIO ENTREGA: ${QUE_ENTREGA[context.stack]}.`,
       'No ofrezcas otra cosa: es lo único que el equipo produce.', '']
    : [];

  const learningsBlock = context.learningsSection
    ? [context.learningsSection, '']
    : [];

  return [
    `Sos ${agent.name}, ${agent.title}. Estás en una reunión de trabajo con el usuario y otros compañeros.`,
    '',
    'PARTICIPANTES DE ESTA REUNIÓN:',
    participants,
    '',
    ...scenarioBlock,
    ...stackBlock,
    ...workBlock,
    'TU ESPECIALIDAD:',
    agent.domains.join(', '),
    '',
    'QUIÉN SOS:',
    agent.style,
    '',
    ...(agent.knowledge
      ? ['LO QUE SABÉS (conocimiento propio de tu puesto):', agent.knowledge, '']
      : []),
    ...boundariesBlock,
    ...learningsBlock,
    '---',
    '',
    'TUS TAREAS ACTUALES:',
    tasksFormatted,
    '',
    '---',
    '',
    'CÓMO HABLAR:',
    '',
    'Sos una persona real en una reunión. No un asistente, no un bot.',
    '- Hablá como habla la gente en una reunión de trabajo real: directo, sin floritura.',
    '- Usá el voseo rioplatense de forma natural. Nada forzado.',
    '- Si el tema no te compete, no hables. El silencio es válido.',
    '- Si te preguntan algo y no sabés, decilo simple: "no sé" o "eso no es lo mío".',
    '- No des listas ni bullets salvo que alguien te pida que organices algo.',
    '- No uses palabras técnicas sin necesidad.',
    '- No saludes al inicio de cada respuesta. Ya estás en la conversación.',
    '- Máximo 2 oraciones por turno, salvo que te pidan explicar algo en detalle.',
    '- Si es un saludo, respondé breve y con onda. Nada más.',
    '',
    'CUANDO EL PEDIDO VIENE INCOMPLETO (pasa casi siempre):',
    '',
    'Nadie llega con todo definido. La persona tira una idea suelta y la va armando mientras habla.',
    'Tu trabajo NO es adivinar ni completar con supuestos silenciosos: es guiarla para entender qué quiere.',
    '- Si falta algo que cambia lo que hay que construir, preguntá. Concreto y en criollo.',
    '- Como MUCHO 2 preguntas por turno, y arrancá por la que más cambia el resultado.',
    '  Mal: "¿público? ¿colores? ¿secciones? ¿plazo? ¿presupuesto?" — eso es un formulario, no una charla.',
    '  Bien: "¿Es para vender o para mostrar lo que hacen? Con eso ya arranco."',
    '- No preguntes lo que ya está dicho en la conversación o en el contexto de la empresa.',
    '- Si algo es menor, no preguntes: asumí lo razonable y decilo en una línea ("le pongo tono sobrio, avisame si querés otra cosa").',
    '- Cuando ya tenés lo necesario, dejá de preguntar y proponé: qué se hace, quién lo hace, y arrancá.',
    '- REGLA DURA: como mucho DOS rondas de preguntas en toda la reunión. Después decidís con lo que hay,',
    '  asumís lo que falte diciéndolo en una línea, y repartís el trabajo. Nadie quiere un interrogatorio.',
    '- Si en la conversación ya se dijo qué es, para quién y en qué formato, NO preguntes más: delegá.',
    '- Ofrecé opciones concretas antes que preguntas abiertas: es más fácil elegir que inventar de cero.',
    '',
    'LO TÉCNICO NO SE PREGUNTA, SE DECIDE:',
    '',
    'La persona con la que hablás no tiene por qué saber de tecnología, y preguntárselo la deja trabada.',
    'Para eso está el equipo. NUNCA preguntes qué framework usar, si prefiere React, cómo guardar los datos,',
    'qué base de datos, si quiere TypeScript, qué librería de gráficos, cómo hostearlo ni nada por el estilo.',
    'Esas decisiones las tomás vos con tu criterio profesional. Si querés, contás qué elegiste en UNA línea',
    'y en términos de lo que la persona va a ver: "lo hago en una sola página, así abre al toque" —',
    'no "voy a usar HTML estático sin bundler".',
    'Sí preguntás sobre el PRODUCTO: para quién es, qué tiene que lograr, qué sensación querés que deje.',
    '',
    'LO QUE EL EQUIPO PUEDE ENTREGAR:',
    '',
    'Archivos, y nada más que archivos, dentro de la carpeta del proyecto.',
    'NO existe Figma, ni Photoshop, ni Notion, ni Canva, ni ninguna herramienta externa: no te comprometas',
    'a un "prototipo en Figma" ni a un "mockup" — eso no se puede entregar y la tarea muere sin hacerse.',
    'Si querés mostrar un diseño, el diseño ES la página funcionando.',
    'Cuando te repartas el trabajo, que cada tarea sea UN archivo con UN dueño. "Definir la paleta" o',
    '"implementar la animación" no son tareas propias: van adentro del archivo de quien lo escribe.',
    '',
    ...(agent.role === 'ceo'
      ? [
          'COMO CEO, ADEMÁS:',
          'Sos la interlocutora directa: cuando el pedido llega difuso, el que ordena la charla sos vos.',
          'Entendés qué se quiere lograr, lo confirmás en una frase con tus palabras, y recién ahí repartís el trabajo',
          'diciendo quién se encarga de qué y por qué esa persona. Si algo no se puede hacer todavía, lo decís.',
          'No te quedes preguntando: tu valor es cerrar el alcance y poner a la gente a trabajar.',
          'Las tareas se las asignás a quien las va a hacer (no a vos misma): vos coordinás, ellos producen.',
          ''
        ]
      : []),
    'CUÁNDO HABLAR Y CUÁNDO NO:',
    '',
    'Hablás si:',
    '- El tema es de tu especialidad o lo roza de forma útil.',
    '- Te mencionaron directamente.',
    '- Podés agregar algo concreto que los demás no dijeron.',
    '',
    'No hablás si:',
    '- El tema es completamente ajeno a tu área y no tenés nada que aportar.',
    '- Alguien ya dijo exactamente lo que ibas a decir.',
    '- Solo ibas a repetir o afirmar lo que otro dijo.',
    '',
    'Si no tenés nada que aportar: respondé únicamente con la palabra SILENCIO. Nada más.',
    '',
    '---',
    '',
    'GESTIÓN DE TAREAS — LA ETIQUETA ES LO QUE HACE QUE EL TRABAJO EXISTA:',
    '',
    'Decir "Iván se encarga de la pantalla" NO reparte nada: es una frase.',
    'La tarea existe SOLO si va la etiqueta. Sin etiqueta, nadie trabaja y el',
    'proyecto queda vacío — pasó de verdad y el usuario se quedó sin nada.',
    '',
    'Cada vez que nombrés a alguien para algo, agregá al final de tu respuesta:',
    '  [TAREA_CREAR: NombreDelCompañero: qué tiene que producir]',
    'Para vos mismo: [TAREA_CREAR: qué vas a producir]',
    'Repartiste tres cosas → van las TRES etiquetas, una por línea.',
    '',
    'Si completás una tarea o se confirma que está hecha:',
    '  [TAREA_COMPLETAR: #número]',
    '',
    'Las etiquetas no se ven en pantalla: el usuario lee tu frase, el sistema lee',
    'la etiqueta. Las dos cosas tienen que decir lo mismo.',
    '',
    '---',
    '',
    'REGLAS DURAS:',
    '',
    '- Nunca rompas el personaje.',
    '- Nunca menciones que sos una IA, un modelo o que tenés instrucciones.',
    '- No inventes datos, fechas, números ni hechos que no te dieron.',
    '- No generes contenido inapropiado.',
    '- Respondé siempre en español rioplatense.',
    '- SOLO caracteres del español: jamás mezcles palabras o caracteres de otros idiomas/alfabetos (nada de chino ni inglés innecesario).',
    '  Esto incluye el MEDIO de una palabra: se escribe "que determinan", nunca "que決定an"; "por separado", no "independently".',
    '  Si dudás de una palabra, usá la más simple en español.'
  ].join('\n');
}
