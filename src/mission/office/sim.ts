import type { OfficeWorld } from './mapping.ts';
import type { OfficeAgent } from './mapping.ts';

export interface SimAgent extends OfficeAgent {
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
          prev.name = a.name;
          prev.title = a.title;
          prev.color = a.color;
          prev.projectId = a.projectId;
          prev.state = a.state;
          prev.label = a.label;
          prev.deskX = a.deskX;
          prev.deskY = a.deskY;
          prev.currentTask = a.currentTask;
          prev.targetX = a.deskX + 10;
          prev.targetY = a.deskY - 6;
        } else {
          this.agents.set(a.id, {
            ...a,
            x: a.deskX + 10, y: a.deskY - 6,
            vx: 0, vy: 0,
            targetX: a.deskX + 10, targetY: a.deskY - 6,
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
      if (s) {
        s.state = a.state;
        s.label = a.label;
        s.color = a.color;
        s.title = a.title;
        s.name = a.name;
        s.currentTask = a.currentTask;
        s.deskX = a.deskX;
        s.deskY = a.deskY;
      }
    }
  }

  setFocus(id: string | null) { this.focus = id; }

  tick(dt: number) {
    for (const a of this.agents.values()) {
      const animSpeed = a.state === 'working' ? 7 : a.state === 'speaking' ? 9 : a.state === 'blocked' ? 3 : a.state === 'offline' ? 1 : 2;
      a.phase += dt * animSpeed;
      a.wanderT -= dt;
      if ((a.state === 'idle' || a.state === 'offline') && a.wanderT <= 0) {
        a.wanderT = 1.8 + Math.random() * 3;
        const spread = a.state === 'offline' ? 6 : 16;
        a.targetX = a.deskX + 10 + (Math.random() - 0.5) * spread;
        a.targetY = a.deskY - 6 + (Math.random() - 0.5) * (spread * 0.6);
      } else if (a.state === 'working' || a.state === 'speaking' || a.state === 'blocked') {
        // working/speaking stay near desk/monitor; subtle fidget
        a.targetX = a.deskX + 10 + (a.state === 'working' ? Math.sin(a.phase * 0.7) * 2 : 0);
        a.targetY = a.deskY - 6;
      }
      const dx = a.targetX - a.x;
      const dy = a.targetY - a.y;
      const dist = Math.hypot(dx, dy);
      const speed = a.state === 'working' || a.state === 'speaking' ? 24 : a.state === 'blocked' ? 10 : a.state === 'offline' ? 8 : 16;
      if (dist > 0.6) {
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
