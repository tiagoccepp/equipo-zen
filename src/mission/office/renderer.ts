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
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(280, Math.floor(rect.height));
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
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
    const ww = this.world?.width || 800;
    const wh = this.world?.height || 600;
    let scale = Math.min(cw / ww, ch / wh);
    scale = Math.max(0.45, Math.min(1.5, scale));
    let ox = (cw - ww * scale) / 2;
    let oy = (ch - wh * scale) / 2;
    if (this.focus && this.world) {
      const r = this.world.rooms.find((x) => x.id === this.focus);
      if (r) {
        scale = Math.min(cw / (r.w + 80), ch / (r.h + 100));
        scale = Math.max(0.7, Math.min(2.2, scale));
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
    ctx.fillStyle = '#17171b';
    ctx.fillRect(0, 0, cw, ch);
    if (!this.world) {
      ctx.fillStyle = '#8f8f8a';
      ctx.font = '12px monospace';
      ctx.fillText('Loading office…', 16, 24);
      return;
    }
    if (!this.world.rooms.length) {
      ctx.fillStyle = '#8f8f8a';
      ctx.font = '12px monospace';
      ctx.fillText('No projects to display', 16, 24);
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

  private drawRoom(ctx: CanvasRenderingContext2D, room: OfficeRoom, _t: number) {
    const dim = this.focus && this.focus !== room.id;
    ctx.globalAlpha = dim ? 0.22 : 1;
    ctx.fillStyle = '#232328';
    ctx.fillRect(room.x, room.y, room.w, room.h);
    ctx.strokeStyle = dim ? '#333' : '#4a4a52';
    ctx.lineWidth = 2;
    ctx.strokeRect(room.x + 1, room.y + 1, room.w - 2, room.h - 2);
    // floor grid
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let gx = room.x + 8; gx < room.x + room.w - 8; gx += 16) for (let gy = room.y + 24; gy < room.y + room.h - 8; gy += 16) ctx.fillRect(gx, gy, 1, 1);
    // header
    ctx.fillStyle = '#2c2c33';
    ctx.fillRect(room.x + 2, room.y + 2, room.w - 4, 20);
    ctx.fillStyle = '#f5f4ef';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(trunc(room.name, 26), room.x + 8, room.y + 15);
    // desks
    const perRow = 3;
    const count = Math.max(room.agents.length, 1);
    for (let i = 0; i < count; i++) {
      const dc = i % perRow; const dr = Math.floor(i / perRow);
      const dx = room.x + 12 + dc * 88; const dy = room.y + 40 + dr * 44;
      ctx.fillStyle = '#35353d';
      ctx.fillRect(dx, dy, 52, 18);
      ctx.fillStyle = '#5f6b7a';
      ctx.fillRect(dx + 34, dy - 10, 14, 10); // monitor
      ctx.fillStyle = '#8fb3ff';
      ctx.fillRect(dx + 36, dy - 8, 10, 6);
    }
    ctx.globalAlpha = 1;
  }

  private drawAgent(ctx: CanvasRenderingContext2D, a: SimAgent, t: number) {
    const dim = this.focus && this.focus !== a.projectId;
    ctx.globalAlpha = dim ? 0.18 : 1;
    const bob = a.state === 'idle' ? Math.sin(a.phase) * 1.2 : a.state === 'working' ? Math.sin(a.phase) * 0.6 : Math.sin(a.phase) * 1.6;
    const x = Math.round(a.x);
    const y = Math.round(a.y + bob);
    // body (pixel sprite-ish)
    ctx.fillStyle = a.color;
    ctx.fillRect(x - 5, y - 2, 10, 10); // torso
    ctx.fillStyle = '#f2d6b3';
    ctx.fillRect(x - 4, y - 10, 8, 8); // head
    ctx.fillStyle = '#222';
    ctx.fillRect(x - 2, y - 7, 2, 2);
    ctx.fillRect(x + 1, y - 7, 2, 2);
    // state accents
    if (a.state === 'working') {
      ctx.fillStyle = '#8fb3ff';
      ctx.fillRect(x + 6, y + 1, 4, 3);
    } else if (a.state === 'blocked') {
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(x - 1, y - 16, 3, 5);
      ctx.fillRect(x - 1, y - 10, 3, 2);
    } else if (a.state === 'speaking') {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x + 10, y - 12, 4 + Math.sin(t * 8) * 1.5, 0, Math.PI * 2); ctx.stroke();
    }
    // name label
    ctx.font = '9px monospace';
    const name = trunc(a.name, 10);
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = 'rgba(20,20,24,0.75)';
    ctx.fillRect(x - tw / 2 - 2, y + 10, tw + 4, 11);
    ctx.fillStyle = '#eae9e4';
    ctx.fillText(name, x - tw / 2, y + 19);
    if (!dim && (a.state === 'speaking' || a.state === 'blocked' || a.state === 'working')) {
      const msg = trunc(a.label, 22);
      const mw = ctx.measureText(msg).width;
      const bx = x - mw / 2 - 4;
      const by = y - 28;
      ctx.fillStyle = a.state === 'blocked' ? '#3a2024' : '#24303a';
      ctx.strokeStyle = a.state === 'blocked' ? '#fb7185' : '#4ade80';
      roundRect(ctx, bx, by, mw + 8, 14, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f5f4ef';
      ctx.fillText(msg, bx + 4, by + 10);
    }
    ctx.globalAlpha = 1;
  }
}

function trunc(s: string, n: number): string { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
