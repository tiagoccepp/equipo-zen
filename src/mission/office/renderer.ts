import type { OfficeRoom, OfficeWorld } from './mapping.ts';
import type { SimAgent } from './sim.ts';

export class OfficeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: OfficeWorld | null = null;
  private agents: SimAgent[] = [];
  private focus: string | null = null;
  private ro: ResizeObserver;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  setWorld(world: OfficeWorld) { this.world = world; this.resize(); }
  updateTransient(world: OfficeWorld) { this.world = world; }
  setSimAgents(agents: SimAgent[]) { this.agents = agents; }
  setFocus(id: string | null) { this.focus = id; }
  destroy() { this.ro.disconnect(); }

  private resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    this.dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const w = Math.max(320, Math.floor(rect.width || 320));
    const h = Math.max(300, Math.floor(rect.height || 300));
    if (this.canvas.width !== w * this.dpr || this.canvas.height !== h * this.dpr) {
      this.canvas.width = w * this.dpr;
      this.canvas.height = h * this.dpr;
    }
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  hitTest(px: number, py: number): string | null {
    if (!this.world) return null;
    const { scale, ox, oy } = this.transform();
    const x = (px / this.dpr - ox) / scale;
    const y = (py / this.dpr - oy) / scale;
    for (let i = this.world.rooms.length - 1; i >= 0; i--) {
      const r = this.world.rooms[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  private transform() {
    const cw = this.canvas.width / this.dpr;
    const ch = this.canvas.height / this.dpr;
    const ww = this.world?.width || 900;
    const wh = this.world?.height || 640;
    let scale = Math.min(cw / Math.max(1, ww), ch / Math.max(1, wh));
    scale = Math.max(0.42, Math.min(1.4, scale));
    let ox = (cw - ww * scale) / 2;
    let oy = (ch - wh * scale) / 2;
    if (this.focus && this.world) {
      const r = this.world.rooms.find((x) => x.id === this.focus);
      if (r) {
        scale = Math.min(cw / (r.w + 90), ch / (r.h + 120));
        scale = Math.max(0.8, Math.min(2.4, scale));
        ox = cw / 2 - (r.x + r.w / 2) * scale;
        oy = ch / 2 - (r.y + r.h / 2) * scale;
      }
    }
    return { scale, ox, oy };
  }

  draw(t: number) {
    const ctx = this.ctx;
    const cw = this.canvas.width / this.dpr;
    const ch = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, cw, ch);
    // office floor background
    ctx.fillStyle = '#141418';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#19191f';
    for (let y = 0; y < ch; y += 16) for (let x = (y / 16 % 2) * 8; x < cw; x += 16) ctx.fillRect(x, y, 8, 8);

    if (!this.world) {
      this.drawMessage(ctx, cw, ch, 'Loading project office…');
      return;
    }
    if (!this.world.rooms.length) {
      this.drawMessage(ctx, cw, ch, 'No projects yet — each project will get its own office room');
      return;
    }

    const { scale, ox, oy } = this.transform();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    for (const room of this.world.rooms) this.drawRoom(ctx, room, t);
    const sorted = [...this.agents].sort((a, b) => a.y - b.y);
    for (const a of sorted) this.drawAgent(ctx, a, t);
    ctx.restore();
  }

  private drawMessage(ctx: CanvasRenderingContext2D, cw: number, ch: number, text: string) {
    ctx.fillStyle = '#8f8f8a';
    ctx.font = '12px monospace';
    const w = ctx.measureText(text).width;
    ctx.fillText(text, Math.max(16, (cw - w) / 2), ch / 2);
  }

  private drawRoom(ctx: CanvasRenderingContext2D, room: OfficeRoom, t: number) {
    const focused = this.focus === room.id;
    const dim = !!this.focus && !focused;
    ctx.globalAlpha = dim ? 0.28 : 1;

    // outer shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(room.x + 4, room.y + 5, room.w, room.h);

    // wall
    ctx.fillStyle = '#26262d';
    ctx.fillRect(room.x, room.y, room.w, room.h);
    // floor
    ctx.fillStyle = '#2b2b33';
    ctx.fillRect(room.x + 4, room.y + 26, room.w - 8, room.h - 30);
    for (let gy = room.y + 28; gy < room.y + room.h - 8; gy += 8) {
      for (let gx = room.x + 6; gx < room.x + room.w - 8; gx += 8) {
        ctx.fillStyle = ((gx + gy) / 8) % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.04)';
        ctx.fillRect(gx, gy, 8, 8);
      }
    }

    // border
    ctx.strokeStyle = focused ? '#9ec5ff' : dim ? '#3a3a42' : '#555561';
    ctx.lineWidth = focused ? 3 : 2;
    ctx.strokeRect(room.x + 1, room.y + 1, room.w - 2, room.h - 2);
    ctx.strokeStyle = focused ? 'rgba(158,197,255,0.35)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(room.x + 4, room.y + 4, room.w - 8, room.h - 8);

    // header sign
    ctx.fillStyle = focused ? '#314055' : '#30303a';
    ctx.fillRect(room.x + 4, room.y + 4, room.w - 8, 20);
    ctx.fillStyle = focused ? '#dff0ff' : '#f5f4ef';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(trunc(room.name, 24), room.x + 10, room.y + 17);

    // status tags on header
    if (room.live) {
      drawTag(ctx, room.x + room.w - 66, room.y + 7, 'LIVE', '#173322', '#4ade80');
    } else {
      drawTag(ctx, room.x + room.w - 66, room.y + 7, 'OPEN', '#2a2a33', '#9aa0aa');
    }

    // door
    ctx.fillStyle = '#1f1f25';
    ctx.fillRect(room.x + room.w / 2 - 10, room.y + room.h - 14, 20, 10);
    ctx.fillStyle = focused ? '#8fb3ff' : '#666675';
    ctx.fillRect(room.x + room.w / 2 + 4, room.y + room.h - 10, 3, 3);

    // plant/decoration
    ctx.fillStyle = '#3a4a38';
    ctx.fillRect(room.x + 8, room.y + room.h - 22, 8, 8);
    ctx.fillStyle = '#5f8a58';
    ctx.fillRect(room.x + 9, room.y + room.h - 28, 6, 7);

    // desks and monitors per agent slot
    const perRow = 3;
    const count = Math.max(room.agents.length, 1);
    for (let i = 0; i < count; i++) {
      const dc = i % perRow; const dr = Math.floor(i / perRow);
      const dx = room.x + 12 + dc * 92; const dy = room.y + 50 + dr * 50;
      // desk
      ctx.fillStyle = '#3b3631';
      ctx.fillRect(dx, dy + 10, 54, 16);
      ctx.fillStyle = '#4a443d';
      ctx.fillRect(dx, dy + 10, 54, 3);
      // chair
      ctx.fillStyle = '#2f3340';
      ctx.fillRect(dx + 16, dy + 24, 18, 8);
      // monitor
      ctx.fillStyle = '#5e6672';
      ctx.fillRect(dx + 34, dy - 4, 16, 13);
      const agent = room.agents[i];
      const screen = screenColor(agent?.state || 'idle', t + i);
      ctx.fillStyle = screen;
      ctx.fillRect(dx + 36, dy - 2, 12, 9);
      if (agent?.state === 'working' || agent?.state === 'speaking') {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        const blink = Math.floor((t * (agent.state === 'speaking' ? 8 : 4) + i) % 3);
        for (let l = 0; l < 2; l++) ctx.fillRect(dx + 37, dy + l * 3, 4 + ((blink + l) % 2) * 3, 1);
      }
      // keyboard
      ctx.fillStyle = '#20242b';
      ctx.fillRect(dx + 12, dy + 6, 18, 4);
    }

    // room footer mini stats
    ctx.fillStyle = 'rgba(10,10,14,0.45)';
    ctx.fillRect(room.x + 6, room.y + room.h - 24, Math.min(room.w - 12, 170), 10);
    ctx.fillStyle = '#c9c9c3';
    ctx.font = '8px monospace';
    ctx.fillText(trunc(room.taskSummary, 30), room.x + 9, room.y + room.h - 16);

    ctx.globalAlpha = 1;
  }

  private drawAgent(ctx: CanvasRenderingContext2D, a: SimAgent, t: number) {
    const roomFocused = this.focus === a.projectId;
    const dim = !!this.focus && !roomFocused;
    ctx.globalAlpha = dim ? 0.18 : (a.state === 'offline' ? 0.55 : 1);
    const bob = a.state === 'idle' ? Math.sin(a.phase) * 1.3 : a.state === 'working' ? Math.abs(Math.sin(a.phase * 0.8)) * 1.0 : a.state === 'speaking' ? Math.sin(a.phase) * 1.8 : a.state === 'blocked' ? Math.sin(a.phase * 0.5) * 0.5 : Math.sin(a.phase * 0.4) * 0.4;
    const x = Math.round(a.x);
    const y = Math.round(a.y + bob);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 5, y + 9, 10, 2);

    // legs
    ctx.fillStyle = '#252833';
    ctx.fillRect(x - 4, y + 4, 3, 5);
    ctx.fillRect(x + 1, y + 4, 3, 5);
    // torso
    ctx.fillStyle = a.color || '#7491ff';
    ctx.fillRect(x - 5, y - 3, 10, 8);
    // arms
    if (a.state === 'working') {
      const arm = Math.floor((t * 6 + a.phase) % 2) === 0 ? -1 : 0;
      ctx.fillRect(x - 7, y - 1 + arm, 2, 5);
      ctx.fillRect(x + 5, y - 1 - arm, 2, 5);
    } else if (a.state === 'speaking') {
      ctx.fillRect(x - 7, y - 3, 2, 4);
      ctx.fillRect(x + 5, y - 4, 2, 5);
    } else {
      ctx.fillRect(x - 7, y - 1, 2, 5);
      ctx.fillRect(x + 5, y - 1, 2, 5);
    }
    // head
    ctx.fillStyle = a.state === 'offline' ? '#cdbda6' : '#f2d6b3';
    ctx.fillRect(x - 4, y - 11, 8, 8);
    // hair/hat tint
    ctx.fillStyle = shade(a.color || '#7491ff', -20);
    ctx.fillRect(x - 4, y - 11, 8, 2);
    // eyes
    ctx.fillStyle = a.state === 'offline' ? '#555' : '#1d1f24';
    ctx.fillRect(x - 2, y - 8, 2, 2);
    ctx.fillRect(x + 1, y - 8, 2, 2);

    // state indicator
    if (a.state === 'working') {
      ctx.fillStyle = '#8fb3ff';
      ctx.fillRect(x + 7, y - 5, 5, 4);
      ctx.fillStyle = '#dff0ff';
      ctx.fillRect(x + 8, y - 4, 3, 2);
    } else if (a.state === 'blocked') {
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(x - 1, y - 18, 2, 5);
      ctx.fillRect(x - 1, y - 12, 2, 2);
    } else if (a.state === 'speaking') {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 1;
      const r = 3.5 + (Math.sin(t * 9 + a.phase) + 1) * 1.2;
      ctx.strokeRect(x + 7, y - 14, r + 1, r + 1);
      ctx.strokeRect(x + 9, y - 12, Math.max(1, r - 3), Math.max(1, r - 3));
    } else if (a.state === 'offline') {
      ctx.fillStyle = '#777';
      ctx.fillRect(x + 7, y - 14, 5, 5);
      ctx.fillStyle = '#1a1a1f';
      ctx.fillRect(x + 8, y - 13, 3, 3);
    }

    // name label
    ctx.font = '9px monospace';
    const name = trunc(a.name, 10);
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = 'rgba(14,14,18,0.82)';
    ctx.fillRect(x - tw / 2 - 3, y + 11, tw + 6, 11);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(x - tw / 2 - 3, y + 11, tw + 6, 11);
    ctx.fillStyle = a.state === 'offline' ? '#a0a09b' : '#efeee8';
    ctx.fillText(name, x - tw / 2, y + 20);

    // activity bubble: show for focused room agents or important states
    const showBubble = roomFocused || a.state === 'speaking' || a.state === 'blocked' || (a.state === 'working' && !!this.focus);
    if (showBubble && a.label) {
      const msg = trunc(a.label, roomFocused ? 30 : 22);
      const mw = ctx.measureText(msg).width;
      const bx = Math.round(x - mw / 2 - 5);
      const by = Math.round(y - 30);
      const bg = a.state === 'blocked' ? '#3a2024' : a.state === 'speaking' ? '#183126' : '#24303a';
      const border = a.state === 'blocked' ? '#fb7185' : a.state === 'speaking' ? '#4ade80' : a.state === 'working' ? '#8fb3ff' : '#666';
      roundRect(ctx, bx, by, mw + 10, 14, 3);
      ctx.fillStyle = bg; ctx.fill();
      ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#1f1f25';
      ctx.fillRect(x - 2, by + 14, 4, 3);
      ctx.fillStyle = '#f5f4ef';
      ctx.fillText(msg, bx + 5, by + 10);
    }

    ctx.globalAlpha = 1;
  }
}

function trunc(s: string, n: number): string { const t = String(s || ''); return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t; }

function drawTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string) {
  ctx.font = '8px monospace';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, 12);
  ctx.strokeStyle = fg;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 11);
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 4, y + 9);
}

function screenColor(state: string, t: number): string {
  if (state === 'working') return '#2f5f8f';
  if (state === 'speaking') return '#2f6b4a';
  if (state === 'blocked') return '#6b3038';
  if (state === 'offline') return '#2a2d33';
  return (Math.floor(t * 0.7) % 5 === 0) ? '#334055' : '#2d3442';
}

function shade(hexOrHsl: string, amt: number): string {
  // best-effort: for hsl strings just return original; for hex shade
  if (!hexOrHsl || hexOrHsl.startsWith('hsl')) return hexOrHsl || '#555';
  const m = /^#?([0-9a-f]{6})$/i.exec(hexOrHsl);
  if (!m) return hexOrHsl;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
