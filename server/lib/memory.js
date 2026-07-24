export class MeetingMemory {
  // Con store+meetingId cada turno se persiste (WAL); la RAM mantiene el
  // cap de 80 turnos solo para armar prompts. Sin store se comporta como
  // la memoria volátil original (tests, usos sueltos).
  constructor({ store = null, meetingId = null } = {}) {
    this.turns = [];
    this.store = store;
    this.meetingId = meetingId;
  }

  hydrate(rows) {
    this.turns = (rows || []).map((row) => ({
      at: row.at,
      kind: row.kind,
      speaker: row.speaker,
      agentId: row.agent_id ?? row.agentId ?? null,
      text: row.text,
      dbId: row.id ?? null,
      turnId: row.turn_id ?? row.turnId ?? null
    })).slice(-80);
  }

  add(kind, speaker, text, agentId = null, turnId = null) {
    const entry = {
      at: new Date().toISOString(),
      kind,
      speaker,
      agentId,
      text: String(text || '').trim(),
      dbId: null,
      turnId
    };

    if (this.store && this.meetingId) {
      entry.dbId = this.store.appendTurn(this.meetingId, {
        turnId,
        kind,
        speaker,
        agentId,
        text: entry.text
      });
    }

    this.turns.push(entry);

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
