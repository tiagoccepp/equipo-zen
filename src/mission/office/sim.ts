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
  /** 0..1+ age since spawn, used for pop-in/enter feel */
  spawnAge: number;
  /** when > 0 agent is leaving the office (fade/poof) */
  leaving: number;
  /** brief reaction timer when project is focused/opened */
  focusReact: number;
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
          // cancel leaving if agent reappears
          prev.leaving = 0;
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
            x: a.deskX + 10, y: a.deskY - 2,
            vx: 0, vy: 0,
            targetX: a.deskX + 10, targetY: a.deskY - 6,
            phase: Math.random() * Math.PI * 2,
            wanderT: Math.random() * 1.5,
            spawnAge: 0,
            leaving: 0,
            focusReact: 0
          });
        }
      }
    }
    // mark removed agents as leaving for a soft exit instead of popping out
    for (const [id, ag] of this.agents.entries()) {
      if (!seen.has(id) && ag.leaving <= 0) ag.leaving = 0.001;
    }
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

  setFocus(id: string | null) {
    const prev = this.focus;
    this.focus = id;
    // when opening/focusing a project, give its team a small "noticed you" reaction
    if (id && id !== prev) {
      for (const a of this.agents.values()) {
        if (a.projectId === id) a.focusReact = 0.9 + Math.random() * 0.4;
      }
    }
  }

  tick(dt: number) {
    for (const [id, a] of [...this.agents.entries()]) {
      a.spawnAge += dt;
      if (a.focusReact > 0) a.focusReact = Math.max(0, a.focusReact - dt);
      if (a.leaving > 0) {
        a.leaving += dt;
        a.y -= dt * 6; // drift up slightly while fading out
        if (a.leaving > 0.45) this.agents.delete(id);
        continue;
      }
      const animSpeed = a.state === 'working' ? 8 : a.state === 'speaking' ? 10 : a.state === 'blocked' ? 3 : a.state === 'offline' ? 1 : 2.5;
      a.phase += dt * animSpeed;
      a.wanderT -= dt;
      if ((a.state === 'idle' || a.state === 'offline') && a.wanderT <= 0) {
        // idle agents occasionally stroll a bit, look around, or stretch in place (more human)
        a.wanderT = a.state === 'offline' ? 2.5 + Math.random() * 4 : 1.2 + Math.random() * 2.8;
        const spread = a.state === 'offline' ? 6 : 18;
        a.targetX = a.deskX + 10 + (Math.random() - 0.5) * spread;
        a.targetY = a.deskY - 6 + (Math.random() - 0.5) * (spread * 0.55);
      } else if (a.state === 'working') {
        // typing rhythm + small posture shifts, as if focused at the monitor
        a.targetX = a.deskX + 10 + Math.sin(a.phase * 0.65) * 1.6;
        a.targetY = a.deskY - 6 + Math.sin(a.phase * 0.35) * 0.4;
      } else if (a.state === 'speaking') {
        // speaking: step forward slightly and gesture in place
        a.targetX = a.deskX + 12 + Math.sin(a.phase * 0.9) * 1.2;
        a.targetY = a.deskY - 7;
      } else if (a.state === 'blocked') {
        // blocked: restless pacing near desk / thinking
        a.targetX = a.deskX + 8 + Math.sin(a.phase * 0.4) * 6;
        a.targetY = a.deskY - 5;
      }
      // quick "noticed you" step when project is opened/focused
      if (a.focusReact > 0.45) {
        a.targetY = a.deskY - 8;
        a.targetX = a.deskX + 11;
      }
      const dx = a.targetX - a.x;
      const dy = a.targetY - a.y;
      const dist = Math.hypot(dx, dy);
      const speed = a.state === 'working' ? 22 : a.state === 'speaking' ? 26 : a.state === 'blocked' ? 14 : a.state === 'offline' ? 8 : 18;
      if (dist > 0.6) {
        a.vx = (dx / dist) * speed;
        a.vy = (dy / dist) * speed;
        a.x += a.vx * dt;
        a.y += a.vy * dt;
      } else {
        a.vx *= 0.6; a.vy *= 0.6;
      }
    }
  }

  getAgents(): SimAgent[] { return [...this.agents.values()]; }
}
