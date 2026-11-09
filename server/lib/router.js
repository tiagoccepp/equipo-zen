import { escapeRegExp, getMentionIndex, includesTerm, isGreetingTurn, normalize } from './text.js';

// Saludo dirigido al grupo: ahí sí contesta el equipo. Sin acentos porque el
// texto llega normalizado ("compañeros" → "companeros").
const GROUP_GREETING = /\b(equipo|chicos|chicas|gente|todos|todas|ustedes|muchachos|muchachas|pibes|amigos|companeros|companeras|compas|familia|banda|gurises|a todos)\b/;

// Frases que cierran el tema a cualquier longitud del enunciado.
const CLOSING_PHRASES = /\b(ya entendi|queda claro|quedo claro|cambiemos de tema|pasemos a otra cosa|no sigas|dejemoslo ahi|tema cerrado)\b/;
// Palabras sueltas que solo cierran si el enunciado es corto (≤ 3 palabras):
// "¿qué API usamos para el dashboard?" no es un cierre.
const CLOSING_SHORT_WORDS = /\b(ok|okay|listo|perfecto|entendido|sigamos|para|alto|gracias|dale)\b/;

export function isClosingSignal(normalized) {
  if (normalized.includes('?')) {
    return false;
  }
  if (CLOSING_PHRASES.test(normalized)) {
    return true;
  }
  const wordCount = normalized.split(' ').filter(Boolean).length;
  return wordCount > 0 && wordCount <= 3 && CLOSING_SHORT_WORDS.test(normalized);
}

export class AgentRouter {
  constructor(agents) {
    this.agents = agents;
  }

  // Los agentes deshabilitados para la reunión siguen en el roster (UI)
  // pero no reciben la palabra.
  get activeAgents() {
    return this.agents.filter((agent) => agent.enabled !== false);
  }

  route(text, memory) {
    const normalized = normalize(text);
    const closingSignal = isClosingSignal(normalized);
    const lastAgent = memory?.lastAgentTurn?.();
    if (closingSignal && lastAgent?.agentId) {
      const agent = this.activeAgents.find((item) => item.id === lastAgent.agentId);
      if (agent) {
        return {
          closing: true,
          responses: [],
          targets: [{
            agentId: agent.id,
            name: agent.name,
            score: 99,
            directMention: false,
            matchedDomains: ['topic close']
          }],
          reason: 'The user closed the topic; the agent confirms and goes quiet.'
        };
      }
    }

    // "presentense" y "cada uno" también son ronda completa: el usuario quiere
    // escuchar a cada voz, no solo a la interlocutora. ("presentacion" como
    // sustantivo queda afuera a propósito: un entregable no convoca al grupo.)
    const groupAddressed = /\b(equipo|ambos|los dos|todos|reunion|ustedes|analicemos|pensemos|discutamos|revisemos|conversemos|presentense|presentaos|cada un[oa]s?)\b/.test(normalized);
    const collaborationSignal = /\b(solucion|cliente|empresa|sistema|implementar|disenar|validar|riesgo|propuesta|operacion|operaciones|pedido|pedidos|stock|inventario|reparto|ventas|cobranza|dashboard|api|endpoint)\b/.test(normalized);
    const mentionedAgents = this.activeAgents
      .map((agent, index) => ({
        agent,
        index,
        mentionIndex: getMentionIndex(normalized, agent.aliases)
      }))
      .filter((item) => item.mentionIndex >= 0);

    if (isGreetingTurn(normalized)) {
      // Un "hola" pelado no puede hacer que hablen los ocho: contesta la CEO,
      // que es la interlocutora. Solo si el saludo es al grupo ("hola chicos",
      // "buenas equipo") responden todos.
      const groupGreeting = GROUP_GREETING.test(normalized);
      if (mentionedAgents.length === 0 && !groupGreeting) {
        const ceo = this.activeAgents.find((agent) => agent.role === 'ceo') || this.activeAgents[0];
        if (ceo) {
          return {
            greeting: true,
            responses: [],
            targets: [{
              agentId: ceo.id,
              name: ceo.name,
              score: 10,
              directMention: false,
              mentionIndex: 0,
              matchedDomains: ['greeting']
            }],
            reason: 'Simple greeting: only the CEO answers, not the whole team in chorus.'
          };
        }
      }

      const selectedAgents = mentionedAgents.length > 0
        ? mentionedAgents
        : this.activeAgents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        greeting: true,
        groupGreeting: groupGreeting && mentionedAgents.length === 0,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => ({
          agentId: agent.id,
          name: agent.name,
          score: 10,
          directMention: mentionedAgents.length > 0,
          mentionIndex,
          matchedDomains: ['greeting']
        })),
        reason: mentionedAgents.length > 0
          ? 'The user greeted mentioned agents; they answer briefly as an opening.'
          : 'The user greeted the group; they answer without repeating the greeting back.'
      };
    }

    if (groupAddressed || mentionedAgents.length > 1) {
      const selectedAgents = mentionedAgents.length > 1
        ? mentionedAgents.sort((a, b) => a.mentionIndex - b.mentionIndex)
        : this.activeAgents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        groupAddressed: true,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => {
          const domainMatches = agent.domains.filter((domain) => includesTerm(normalized, domain));
          return {
            agentId: agent.id,
            name: agent.name,
            score: 9 + domainMatches.length * 2,
            directMention: true,
            mentionIndex,
            matchedDomains: domainMatches.length ? domainMatches : ['group mention']
          };
        }),
        reason: mentionedAgents.length > 1
          ? 'The user mentioned several agents; everyone mentioned answers briefly from their role.'
          : 'The user addressed the group; the agents answer briefly from their roles.'
      };
    }

    const targets = [];

    for (const agent of this.activeAgents) {
      const mentionIndex = getMentionIndex(normalized, agent.aliases);
      const mentionScore = mentionIndex >= 0 ? 8 : 0;
      const domainMatches = agent.domains.filter((domain) => includesTerm(normalized, domain));
      const lexicalScore = domainMatches.length * 2;
      const questionBoost = /[?]|que opin|como|cuando|por que|recomiend|deberiamos|conviene/.test(normalized) ? 1 : 0;
      const contextBoost = collaborationSignal && lexicalScore > 0 ? 1 : 0;
      const score = mentionScore + lexicalScore + questionBoost + contextBoost;
      const shouldSpeak =
        mentionScore > 0 ||
        (groupAddressed && lexicalScore > 0) ||
        (collaborationSignal && lexicalScore > 0) ||
        lexicalScore >= 4;

      if (shouldSpeak) {
        targets.push({
          agentId: agent.id,
          name: agent.name,
          score,
          directMention: mentionScore > 0,
          mentionIndex,
          matchedDomains: domainMatches
        });
      }
    }

    targets.sort((a, b) => {
      if (a.directMention && b.directMention) {
        return a.mentionIndex - b.mentionIndex;
      }
      return b.directMention - a.directMention || b.score - a.score;
    });

    // Fallback ejecutivo: si ningún especialista tiene señal, la CEO toma
    // el punto (es la interlocutora directa del humano).
    if (targets.length === 0) {
      const ceo = this.activeAgents.find((agent) => agent.role === 'ceo');
      if (ceo) {
        targets.push({
          agentId: ceo.id,
          name: ceo.name,
          score: 3,
          directMention: false,
          matchedDomains: ['general coordination'],
          mentionIndex: 0
        });
        return {
          responses: [],
          targets,
          reason: 'No clear domain: the CEO takes the point to coordinate.'
        };
      }
    }

    return {
      responses: [],
      targets,
      reason: targets.length > 0
        ? 'The orchestrator found matching context to assign the floor.'
        : 'Not enough context for any agent to answer without making things up.'
    };
  }

  nextContextualTarget(originalText, route, memory) {
    const last = memory.lastAgentTurn();
    if (!last?.text) {
      return null;
    }

    const alreadySpoke = new Set((route.targets || []).map((target) => target.agentId));
    const context = normalize(`${originalText} ${last.text}`);
    const candidates = [];

    for (const agent of this.activeAgents) {
      if (alreadySpoke.has(agent.id)) {
        continue;
      }
      const handoffSignal = new RegExp(`\\b(${agent.aliases.map((alias) => escapeRegExp(normalize(alias))).join('|')})\\b`).test(context);
      if (!handoffSignal) {
        continue;
      }
      const domainMatches = agent.domains.filter((domain) => includesTerm(context, domain));
      const score = domainMatches.length * 2 + 4;
      if (score >= 5) {
        candidates.push({
          agentId: agent.id,
          name: agent.name,
          score,
          directMention: false,
          matchedDomains: domainMatches
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }
}
