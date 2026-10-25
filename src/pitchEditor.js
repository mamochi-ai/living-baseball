// 投球編集。上から見た左右の曲がり（x）と横から見た高さ（y）を、
// 共通の横軸「投手→打者の進行度」に対して編集する。制御点ドラッグとフリーハンドの2方式。
import { PITCH_LIMITS, PLATE } from './config.js';
import { buildPitchPath, constrainPitch, knotS } from './pitch.js';

const S_MAX = 1.08; // 判定面の少し先まで描く

export class PitchEditor {
  constructor({ topCanvas, sideCanvas, lamp, onChange }) {
    this.views = [
      { canvas: topCanvas, axis: 'xs', range: PITCH_LIMITS.xRange, labels: ['右', '左'], title: '上から見た曲がり' },
      { canvas: sideCanvas, axis: 'ys', range: PITCH_LIMITS.yRange, labels: ['高い', '床'], title: '横から見た高さ' },
    ];
    this.lamp = lamp; // { s, y0, y1 } 横から見た電球の位置（危険マーク）
    this.mode = 'points';
    this.onChange = onChange;
    this.pitch = null;
    for (const view of this.views) this.bind(view);
  }

  setPitch(p) {
    this.pitch = constrainPitch(p);
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
  }

  setLamp(lamp) {
    this.lamp = lamp;
    this.draw();
  }

  // ----- 座標変換（エディタ内の CSS px ⇔ s / 値） -----
  geom(view) {
    const c = view.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const padL = 34;
    const padR = 14;
    const padT = 18;
    const padB = 18;
    return {
      w,
      h,
      sx: (s) => padL + (s / S_MAX) * (w - padL - padR),
      vy: (v) => padT + (1 - (v - view.range[0]) / (view.range[1] - view.range[0])) * (h - padT - padB),
      sOf: (x) => ((x - padL) / (w - padL - padR)) * S_MAX,
      vOf: (y) => view.range[0] + (1 - (y - padT) / (h - padT - padB)) * (view.range[1] - view.range[0]),
    };
  }

  bind(view) {
    const c = view.canvas;
    let drag = null;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.pitch || drag) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      const g = this.geom(view);
      if (this.mode === 'points') {
        // 一番近い制御点（始点は固定なので除く）
        let best = -1;
        let bestD = 40;
        this.pitch[view.axis].forEach((v, i) => {
          if (i === 0) return;
          const d = Math.hypot(g.sx(knotS(i)) - x, g.vy(v) - y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best < 0) {
          // 点から離れた場所: 横位置が最も近い点をその高さへ
          const s = g.sOf(x);
          best = Math.max(1, Math.min(PITCH_LIMITS.points - 1, Math.round(s * (PITCH_LIMITS.points - 1))));
        }
        drag = { id: e.pointerId, kind: 'point', index: best };
        this.movePoint(view, best, g.vOf(y));
      } else {
        drag = { id: e.pointerId, kind: 'free', samples: [[g.sOf(x), g.vOf(y)]] };
        this.stroke = { view, samples: drag.samples };
        this.draw();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      const [x, y] = local(e);
      const g = this.geom(view);
      if (drag.kind === 'point') this.movePoint(view, drag.index, g.vOf(y));
      else {
        drag.samples.push([g.sOf(x), g.vOf(y)]);
        this.draw();
      }
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.kind === 'free') this.applyStroke(view, drag.samples);
      drag = null;
      this.stroke = null;
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  movePoint(view, i, value) {
    const vals = [...this.pitch[view.axis]];
    vals[i] = value;
    this.update({ ...this.pitch, [view.axis]: vals });
  }

  /** フリーハンドの線を制御点に変換する。線が通っていない区間の点はそのまま。 */
  applyStroke(view, samples) {
    const pts = samples.filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return;
    const vals = [...this.pitch[view.axis]];
    for (let i = 1; i < PITCH_LIMITS.points; i++) {
      const s = knotS(i);
      if (s < pts[0][0] - 0.05 || s > pts[pts.length - 1][0] + 0.05) continue;
      vals[i] = interp(pts, s);
    }
    this.update({ ...this.pitch, [view.axis]: vals });
  }

  update(p) {
    this.pitch = constrainPitch(p);
    this.draw();
    this.onChange?.(this.pitch);
  }

  draw() {
    if (!this.pitch) return;
    const path = buildPitchPath(this.pitch);
    for (const view of this.views) this.drawView(view, path);
  }

  drawView(view, path) {
    const c = view.canvas;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = this.geom(view);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff8ea';
    ctx.fillRect(0, 0, w, h);

    // 補助線
    ctx.strokeStyle = 'rgba(120,90,60,0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < PITCH_LIMITS.points; i++) {
      ctx.beginPath();
      ctx.moveTo(g.sx(knotS(i)), g.vy(view.range[0]));
      ctx.lineTo(g.sx(knotS(i)), g.vy(view.range[1]));
      ctx.stroke();
    }
    // ストライクゾーン（判定面）
    const zr = view.axis === 'xs' ? PLATE.zoneX : PLATE.zoneY;
    ctx.fillStyle = 'rgba(60,160,255,0.22)';
    ctx.fillRect(g.sx(1) - 5, g.vy(zr[1]), 10, g.vy(zr[0]) - g.vy(zr[1]));
    ctx.strokeStyle = 'rgba(60,140,240,0.8)';
    ctx.beginPath();
    ctx.moveTo(g.sx(1), g.vy(view.range[0]));
    ctx.lineTo(g.sx(1), g.vy(view.range[1]));
    ctx.stroke();
    // 横から見たときは電球を危険マークとして表示
    if (view.axis === 'ys' && this.lamp) {
      ctx.fillStyle = 'rgba(255,170,0,0.3)';
      const x = g.sx(this.lamp.s);
      ctx.fillRect(x - 6, g.vy(Math.min(this.lamp.y1, view.range[1])), 12, g.vy(this.lamp.y0) - g.vy(Math.min(this.lamp.y1, view.range[1])));
      ctx.fillStyle = '#b06a00';
      ctx.font = '11px sans-serif';
      ctx.fillText('電球', x + 8, g.vy(view.range[1]) + 12);
    }
    if (view.axis === 'ys') {
      ctx.strokeStyle = 'rgba(120,70,30,0.6)';
      ctx.beginPath();
      ctx.moveTo(g.sx(0), g.vy(0));
      ctx.lineTo(g.sx(S_MAX), g.vy(0));
      ctx.stroke();
    }

    // 軌道
    const idx = view.axis === 'xs' ? 0 : 1;
    ctx.strokeStyle = '#e0452b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const s = (i / 80) * S_MAX;
      const v = path.posAtS(s)[idx];
      if (i === 0) ctx.moveTo(g.sx(s), g.vy(v));
      else ctx.lineTo(g.sx(s), g.vy(v));
    }
    ctx.stroke();

    // 制御点
    this.pitch[view.axis].forEach((v, i) => {
      ctx.beginPath();
      ctx.arc(g.sx(knotS(i)), g.vy(v), i === 0 ? 6 : 10, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#777' : '#fff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = i === 0 ? '#555' : '#e0452b';
      ctx.stroke();
    });

    // フリーハンド中の線
    if (this.stroke && this.stroke.view === view) {
      ctx.strokeStyle = 'rgba(40,40,40,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.stroke.samples.forEach(([s, v], i) => {
        if (i === 0) ctx.moveTo(g.sx(s), g.vy(v));
        else ctx.lineTo(g.sx(s), g.vy(v));
      });
      ctx.stroke();
    }

    // ラベル
    ctx.fillStyle = '#5a3a1a';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(view.title, 38, 13);
    ctx.font = '11px sans-serif';
    ctx.fillText(view.labels[0], 4, g.vy(view.range[1]) + 10);
    ctx.fillText(view.labels[1], 4, g.vy(view.range[0]));
    ctx.fillText('投手', g.sx(0) - 4, h - 4);
    ctx.fillText('打者', g.sx(1) - 12, h - 4);
  }
}

function interp(pts, s) {
  if (s <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= s) {
      const [s0, v0] = pts[i - 1];
      const [s1, v1] = pts[i];
      return s1 === s0 ? v1 : v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
    }
  }
  return pts[pts.length - 1][1];
}
