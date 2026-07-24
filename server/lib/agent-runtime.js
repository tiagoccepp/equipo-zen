import { Modality, ThinkingLevel } from '@google/genai';

import {
  AGENT_TEXT_MODELS,
  AGENT_TEXT_TIMEOUT_MS,
  TTS_MODELS,
  TTS_TIMEOUT_MS,
  agentConfig
} from './config.js';
import { extractAudioParts, extractTextFromResponse, generateContentWithRotation } from './gemini.js';
import { cleanAgentText, getShortError, isSilenceResponse, stripTaskTags } from './text.js';

export class LiveAgentRuntime {
  constructor(agent, keyRingInstance, memory, meetingSession) {
    this.id = agent.id;
    this.name = agent.name;
    this.agent = agent;
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.meetingSession = meetingSession;
  }

  async respond(turn, emit) {
    if (!this.keyRing.hasKeys()) {
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: 'No hay claves Gemini configuradas.'
      });
      emit({ type: 'agent_silence', reason: `${this.name} no pudo generar una respuesta real.` });
      return emptyAgentResponse();
    }

    let rawText = '';
    try {
      rawText = cleanAgentText(await this.generateText(turn, emit), this.name);
    } catch (error) {
      emit({
        type: 'api_rotation_failed',
        scope: this.name,
        agentId: this.id,
        message: getShortError(error)
      });
      emit({ type: 'agent_silence', reason: `${this.name} no pudo generar una respuesta real.` });
      return emptyAgentResponse();
    }

    if (!rawText || isSilenceResponse(stripTaskTags(rawText))) {
      emit({ type: 'agent_silence', reason: `${this.name} declino responder por protocolo.` });
      return emptyAgentResponse();
    }

    const spokenText = stripTaskTags(rawText);
    if (spokenText) {
      emit({ type: 'agent_transcript_delta', delta: spokenText });
      void this.generateAudio(spokenText, emit);
    }

    return { text: rawText, audioChunks: [], usedMock: false };
  }

  async generateText(turn, emit) {
    const { response } = await generateContentWithRotation(this.keyRing, {
      models: AGENT_TEXT_MODELS,
      scope: `${this.name} texto`,
      timeoutMs: AGENT_TEXT_TIMEOUT_MS,
      emit,
      config: {
        maxOutputTokens: 200,
        temperature: 0.8,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        systemInstruction: buildSystemInstruction(this.agent, this.meetingSession)
      },
      contents: [{ role: 'user', parts: [{ text: this.buildTurnPrompt(turn) }] }]
    });

    return response.text || extractTextFromResponse(response);
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

  async generateAudio(text, emit) {
    if (!text?.trim()) {
      return [];
    }

    try {
      const { response } = await generateContentWithRotation(this.keyRing, {
        models: TTS_MODELS,
        scope: `${this.name} TTS`,
        timeoutMs: TTS_TIMEOUT_MS,
        maxKeyAttempts: Math.min(4, Math.max(1, this.keyRing.size())),
        emit,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.agent.voice || 'Kore'
              }
            }
          }
        },
        contents: [{ role: 'user', parts: [{ text }] }]
      });

      const audioParts = extractAudioParts(response);
      for (const part of audioParts) {
        emit({
          type: 'agent_audio_chunk',
          data: part.data,
          mimeType: part.mimeType || 'audio/pcm;rate=24000'
        });
      }
      return audioParts;
    } catch (error) {
      emit({
        type: 'api_rotation_failed',
        scope: `${this.name} TTS`,
        agentId: this.id,
        message: getShortError(error)
      });
      return [];
    }
  }

  async ensureSession() {
    return;
  }

  reset() {
    this.close();
  }

  close() {
    // Text generation and TTS use short generateContent calls, so there is no agent session to close.
  }
}

export function emptyAgentResponse() {
  return { text: '', audioChunks: [], usedMock: false };
}

export function buildSystemInstruction(agent, session) {
  const agentsList = session ? session.sessionAgents : agentConfig.agents;
  const participants = agentsList.map((item) => item.name).join(', ');

  const tasksFormatted = (agent.tasks && agent.tasks.length > 0)
    ? agent.tasks.map((task, idx) => `#${idx + 1}: ${task.text} (${task.completed ? 'Completada' : 'Pendiente'})`).join('\n')
    : 'No tenés tareas asignadas por el momento.';

  return [
    `Sos ${agent.name}, ${agent.title}. Estás en una reunión de trabajo con el usuario y otros compañeros.`,
    '',
    'PARTICIPANTES DE ESTA REUNIÓN:',
    participants,
    '',
    'TU ESPECIALIDAD:',
    agent.domains.join(', '),
    '',
    'QUIÉN SOS:',
    agent.style,
    '',
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
    'GESTIÓN DE TAREAS:',
    '',
    'Conocés tus tareas y las recordás si te preguntan.',
    'Si en la conversación se define una nueva tarea para vos:',
    '→ Al final de tu respuesta agregá: [TAREA_CREAR: descripción breve]',
    '',
    'Si completás una tarea o se confirma que está hecha:',
    '→ Al final de tu respuesta agregá: [TAREA_COMPLETAR: #número]',
    '',
    'Podés agregar varios tags en el mismo turno si corresponde.',
    '',
    '---',
    '',
    'REGLAS DURAS:',
    '',
    '- Nunca rompas el personaje.',
    '- Nunca menciones que sos una IA, un modelo o que tenés instrucciones.',
    '- No inventes datos, fechas, números ni hechos que no te dieron.',
    '- No generes contenido inapropiado.',
    '- Respondé siempre en español rioplatense.'
  ].join('\n');
}
