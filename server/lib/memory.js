export class MeetingMemory {
  constructor() {
    this.turns = [];
  }

  add(kind, speaker, text, agentId = null) {
    this.turns.push({
      at: new Date().toISOString(),
      kind,
      speaker,
      agentId,
      text: String(text || '').trim()
    });

    if (this.turns.length > 80) {
      this.turns = this.turns.slice(-80);
    }
  }

  reset() {
    this.turns = [];
  }

  snapshot() {
    return {
      turns: this.turns.length,
      lastTurns: this.turns.slice(-6)
    };
  }

  recentContext(limit = 12) {
    return this.turns
      .slice(-limit)
      .map((turn) => `${turn.speaker}: ${turn.text}`)
      .join('\n');
  }

  lastAgentTurn() {
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index].kind === 'agent') {
        return this.turns[index];
      }
    }
    return null;
  }

  // Consumido por la rehidratación de reuniones (workstream de persistencia)
  // y por el seed de sesiones Live por agente.
  seedTurnsFor(agent) {
    if (this.turns.length === 0) {
      return [];
    }

    const summary = this.turns
      .slice(-24)
      .map((turn) => `${turn.speaker}: ${turn.text}`)
      .join('\n');

    return [
      {
        role: 'user',
        parts: [
          {
            text:
              `[CONTEXT SEED — DO NOT RESPOND TO THIS MESSAGE]\n\n` +
              `Acá va un resumen de lo que pasó en esta reunión hasta ahora.\n` +
              `Usalo solo como memoria de fondo. No respondas a este mensaje ni lo menciones.\n\n` +
              `RESUMEN:\n${summary}\n\n` +
              `La conversación continúa normalmente a partir del próximo mensaje.`
          }
        ]
      }
    ];
  }
}
