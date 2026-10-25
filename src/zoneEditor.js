// 判定範囲の調整画面。背景上の頂点・楕円を指で動かし、保存・初期化・JSON書き出し／読み込みを行う。
// 描画と判定は同じ projection.js の変換を使う。
import { computeViewport, imageToScreen, screenToImage } from './projection.js';

const HANDLE_R = 11;
const GRAB_R = 26;

export class ZoneEditor {
  constructor(canvas, background) {
    this.canvas = canvas;
    this.bg = background;
    this.zones = null;
    this.drag = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
  }

  open(zones) {
    this.zones = JSON.parse(JSON.stringify(zones));
    this.resize();
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.vp = computeViewport(w, h);
    this.draw();
  }

  handles() {
    const z = this.zones;
    const out = [];
    z.safeZones.forEach((zn, zi) =>
      zn.polygon.forEach((p, pi) => out.push({ kind: 'poly', group: 'safeZones', zi, pi, uv: p })),
    );
    z.obstacles.forEach((o, zi) => o.polygon.forEach((p, pi) => out.push({ kind: 'poly', group: 'obstacles', zi, pi, uv: p })));
    for (const key of ['pitcherCatchZone', 'lamp']) {
      const e = z[key];
      out.push({ kind: 'center', key, uv: e.center });
      out.push({ kind: 'rx', key, uv: [e.center[0] + e.radius[0], e.center[1]] });
      out.push({ kind: 'ry', key, uv: [e.center[0], e.center[1] + e.radius[1]] });
    }
    return out;
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  down(e) {
    if (!this.zones || this.drag) return;
    const [x, y] = this.local(e);
    let best = null;
    let bestD = GRAB_R;
    for (const h of this.handles()) {
      const s = imageToScreen(this.vp, h.uv[0], h.uv[1]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (!best) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, h: best };
  }

  move(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    e.preventDefault();
    const [x, y] = this.local(e);
    const p = screenToImage(this.vp, x, y);
    const u = Math.min(1, Math.max(0, p.u));
    const v = Math.min(1, Math.max(0, p.v));
    const h = this.drag.h;
    const z = this.zones;
    if (h.kind === 'poly') z[h.group][h.zi].polygon[h.pi] = [round(u), round(v)];
    else if (h.kind === 'center') z[h.key].center = [round(u), round(v)];
    else if (h.kind === 'rx') z[h.key].radius[0] = round(Math.max(0.005, Math.abs(u - z[h.key].center[0])));
    else if (h.kind === 'ry') z[h.key].radius[1] = round(Math.max(0.005, Math.abs(v - z[h.key].center[1])));
    this.draw();
  }

  up(e) {
    if (this.drag && e.pointerId === this.drag.id) this.drag = null;
  }

  draw() {
    if (!this.zones) return;
    const ctx = this.canvas.getContext('2d');
    const { vp } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.drawImage(this.bg, vp.x, vp.y, vp.w, vp.h);
    const scr = ([u, v]) => imageToScreen(vp, u, v);

    const poly = (pts, fill, stroke, label) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = scr(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
      const c = scr(pts[0]);
      ctx.font = 'bold 13px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(label, c.x + 4, c.y - 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, c.x + 4, c.y - 6);
    };
    this.zones.safeZones.forEach((zn, i) => poly(zn.polygon, 'rgba(40,220,90,0.3)', '#3ddc6a', `${i + 1} ${zn.label}`));
    this.zones.obstacles.forEach((o) => poly(o.polygon, 'rgba(150,150,150,0.25)', '#ddd', `${o.label}（アウト）`));
    const ell = (e, color, label) => {
      const c = scr(e.center);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, e.radius[0] * vp.w, e.radius[1] * vp.h, 0, 0, Math.PI * 2);
      ctx.fillStyle = color.replace('1)', '0.2)');
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = 'bold 13px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(label, c.x - 30, c.y - e.radius[1] * vp.h - 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, c.x - 30, c.y - e.radius[1] * vp.h - 6);
    };
    ell(this.zones.pitcherCatchZone, 'rgba(255,80,80,1)', '投手守備範囲（アウト）');
    ell(this.zones.lamp, 'rgba(255,170,0,1)', '電球（アウト）');

    for (const h of this.handles()) {
      const s = scr(h.uv);
      ctx.beginPath();
      ctx.arc(s.x, s.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = h.kind === 'poly' ? (h.group === 'safeZones' ? 'rgba(40,220,90,0.9)' : 'rgba(200,200,200,0.9)') : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

const round = (n) => Math.round(n * 10000) / 10000;
