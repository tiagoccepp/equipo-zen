import type { OfficeAgent, OfficeWorld } from './mapping.ts';

interface SimAgent extends OfficeAgent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  phase: number;
  wanderT: number;
}

export class OfficeSim {
  private agents = new Map<string, SimAgent>();
  private focus: string | null = null;

  setWorld(world: OfficeWorld) {
    const seen = new Set<string>();
    for (const room of world.rooms) {
      for (const a of room.agents) {
        seen.add(a.id);
        const prev = this.agents.get(a.id);
        if (prev) {
          Object.assign(prev, a);
          prev.targetX = a.deskX + 8;
          prev.targetY = a.deskY - 8;
        } else {
          this.agents.set(a.id, {
            ...a,
            x: a.deskX + 8, y: a.deskY - 8,
            vx: 0, vy: 0,
            targetX: a.deskX + 8, targetY: a.deskY - 8,
            phase: Math.random() * Math.PI * 2,
            wanderT: Math.random() * 2
          });
        }
      }
    }
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id);
  }

  updateTransient(world: OfficeWorld) {
    for (const room of world.rooms) for (const a of room.agents) {
      const s = this.agents.get(a.id);
      if (s) { s.state = a.state; s.label = a.label; s.color = a.color; }
    }
  }

  setFocus(id: string | null) { this.focus = id; }

  tick(dt: number) {
    for (const a of this.agents.values()) {
      a.phase += dt * (a.state === 'working' ? 6 : a.state === 'speaking' ? 8 : 2);
      a.wanderT -= dt;
      if (a.state === 'idle' && a.wanderT <= 0) {
        a.wanderT = 1.5 + Math.random() * 2.5;
        a.targetX = a.deskX + 8 + (Math.random() - 0.5) * 18;
        a.targetY = a.deskY - 8 + (Math.random() - 0.5) * 10;
      } else if (a.state !== 'idle') {
        a.targetX = a.deskX + 8;
        a.targetY = a.deskY - 8;
      }
      const dx = a.targetX - a.x;
      const dy = a.targetY - a.y;
      const dist = Math.hypot(dx, dy);
      const speed = a.state === 'idle' ? 18 : 28;
      if (dist > 1) {
        a.vx = (dx / dist) * speed;
        a.vy = (dy / dist) * speed;
        a.x += a.vx * dt;
        a.y += a.vy * dt;
      } else {
        a.vx = 0; a.vy = 0;
      }
    }
  }

  getAgents(): SimAgent[] { return [...this.agents.values()]; }
}

export type { SimAgent };
