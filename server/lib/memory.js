export class MeetingMemory {
  // With store+meetingId every turn is persisted (WAL); RAM keeps the
  // 80-turn cap only for building prompts. Without a store it behaves like
  // the original volatile memory (tests, one-off uses).
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

  // Consumed by meeting rehydration (persistence workstream)
  // and by the per-agent Live session seed.
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
