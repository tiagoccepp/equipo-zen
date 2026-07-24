import { escapeRegExp, getMentionIndex, isGreetingTurn, normalize } from './text.js';

export class AgentRouter {
  constructor(agents) {
    this.agents = agents;
  }

  route(text, memory) {
    const normalized = normalize(text);
    const closingSignal = /\b(ok|okay|listo|perfecto|entendido|ya entendi|queda claro|sigamos|cambiemos de tema|pasemos a otra cosa|no sigas|para|alto|gracias)\b/.test(normalized);
    const lastAgent = memory?.lastAgentTurn?.();
    if (closingSignal && lastAgent?.agentId) {
      const agent = this.agents.find((item) => item.id === lastAgent.agentId);
      if (agent) {
        return {
          closing: true,
          responses: [],
          targets: [{
            agentId: agent.id,
            name: agent.name,
            score: 99,
            directMention: false,
            matchedDomains: ['cierre de tema']
          }],
          reason: 'El usuario cerro el tema; el agente confirma y se calla.'
        };
      }
    }

    const groupAddressed = /\b(equipo|ambos|los dos|todos|reunion|ustedes|analicemos|pensemos|discutamos|revisemos|conversemos)\b/.test(normalized);
    const collaborationSignal = /\b(solucion|cliente|empresa|sistema|implementar|disenar|validar|riesgo|propuesta|operacion|operaciones|pedido|pedidos|stock|inventario|reparto|ventas|cobranza|dashboard|api|endpoint)\b/.test(normalized);
    const mentionedAgents = this.agents
      .map((agent, index) => ({
        agent,
        index,
        mentionIndex: getMentionIndex(normalized, agent.aliases)
      }))
      .filter((item) => item.mentionIndex >= 0);

    if (isGreetingTurn(normalized)) {
      const selectedAgents = mentionedAgents.length > 0
        ? mentionedAgents
        : this.agents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        greeting: true,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => ({
          agentId: agent.id,
          name: agent.name,
          score: 10,
          directMention: mentionedAgents.length > 0,
          mentionIndex,
          matchedDomains: ['saludo']
        })),
        reason: mentionedAgents.length > 0
          ? 'El usuario saludo a agentes mencionados; responden breve como apertura.'
          : 'El usuario hizo un saludo general; ambos agentes responden breve como apertura.'
      };
    }

    if (groupAddressed || mentionedAgents.length > 1) {
      const selectedAgents = mentionedAgents.length > 1
        ? mentionedAgents.sort((a, b) => a.mentionIndex - b.mentionIndex)
        : this.agents.map((agent, index) => ({ agent, index, mentionIndex: index }));

      return {
        groupAddressed: true,
        responses: [],
        targets: selectedAgents.map(({ agent, mentionIndex }) => {
          const domainMatches = agent.domains.filter((domain) => normalized.includes(normalize(domain)));
          return {
            agentId: agent.id,
            name: agent.name,
            score: 9 + domainMatches.length * 2,
            directMention: true,
            mentionIndex,
            matchedDomains: domainMatches.length ? domainMatches : ['mencion grupal']
          };
        }),
        reason: mentionedAgents.length > 1
          ? 'El usuario menciono a varios agentes; todos los mencionados responden breve desde su rol.'
          : 'El usuario hablo al grupo; ambos agentes responden breve desde su rol.'
      };
    }

    const targets = [];

    for (const agent of this.agents) {
      const mentionIndex = getMentionIndex(normalized, agent.aliases);
      const mentionScore = mentionIndex >= 0 ? 8 : 0;
      const domainMatches = agent.domains.filter((domain) => normalized.includes(normalize(domain)));
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

    return {
      responses: [],
      targets,
      reason: targets.length > 0
        ? 'El orquestador encontro contexto compatible para asignar la palabra.'
        : 'No hubo contexto suficiente para que algun agente responda sin inventar.'
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

    for (const agent of this.agents) {
      if (alreadySpoke.has(agent.id)) {
        continue;
      }
      const handoffSignal = new RegExp(`\\b(${agent.aliases.map((alias) => escapeRegExp(normalize(alias))).join('|')})\\b`).test(context);
      if (!handoffSignal) {
        continue;
      }
      const domainMatches = agent.domains.filter((domain) => context.includes(normalize(domain)));
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
