// キャンバス描画。背景・人物・小物・球・判定範囲は同じビューポート変換で描く。
import { SPRITES, PITCHER, PLATE, BALL_RADIUS, IMAGE_W, IMAGE_H } from './config.js';
import { computeViewport, imageToScreen, imagePxToScreen, project, unprojectAtZ, worldToScreen } from './projection.js';

export class Renderer {
  constructor(canvas, images) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.images = images;
    this.vp = computeViewport(1, 1);
    this.resize();
  }

  /** 画面サイズ変更時。投球中でも論理座標は変わらないので描画だけ追従する。 */
  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || globalThis.innerWidth;
    const h = this.canvas.clientHeight || globalThis.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    this.vp = computeViewport(w - (this.insetRight ?? 0), h);
  }

  /** 右側にパネルがあるとき（投球編集）は、その左の領域に部屋を収める */
  setInsetRight(px) {
    if (px === (this.insetRight ?? 0)) return;
    this.insetRight = px;
    this.vp = computeViewport(this.cssW - px, this.cssH);
  }

  /**
   * scene: {
   *   zones, pitcherFrame (1-12), batterFrame (1-12), ball: {pos, trail} | null,
   *   lampBroken, lampBrokenAt, vaseBroken, showZones, previewPath, cursor, shake, time
   * }
   */
  draw(scene) {
    const { ctx, vp } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#2a1a10';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    if (scene.shake > 0) {
      const a = scene.shake * 8;
      ctx.translate(Math.sin(scene.time * 70) * a, Math.cos(scene.time * 55) * a * 0.6);
    }
    // 背景の外へ人物がはみ出しても余白には描かない
    ctx.beginPath();
    ctx.rect(vp.x, vp.y, vp.w, vp.h);
    ctx.clip();
    ctx.drawImage(this.images.background, vp.x, vp.y, vp.w, vp.h);

    if (scene.showZones) this.drawZones(scene.zones, scene.showZones === 'full');
    if (scene.ball) this.drawShadow(scene.ball.pos);
    if (scene.lampBroken) this.drawShards(scene);

    // 奥から順に描く
    const items = [
      { z: PITCHER.feet[2], draw: () => this.drawPitcher(scene.pitcherFrame) },
      { z: scene.zones.lamp.depthZ, draw: () => this.drawLamp(scene.lampBroken) },
      { z: vaseDepth(scene.zones), draw: () => this.drawVase(scene.vaseBroken) },
      { z: SPRITES.batter.depthZ, draw: () => this.drawBatter(scene.batterFrame) },
    ];
    if (scene.previewPath) items.push({ z: 99, draw: () => this.drawPreviewPath(scene.previewPath) });
    if (scene.showStrikeZone) items.push({ z: PLATE.z + 0.01, draw: () => this.drawStrikeZone() });
    if (scene.cursor) items.push({ z: PLATE.z - 0.01, draw: () => this.drawCursor(scene.cursor) });
    if (scene.ball) items.push({ z: scene.ball.pos[2], draw: () => this.drawBall(scene.ball) });
    items.sort((a, b) => b.z - a.z);
    for (const it of items) it.draw();
    ctx.restore();
  }

  sprite(img, anchor, posPx, scale, offset = [0, 0]) {
    const { vp } = this;
    const s = scale * vp.s;
    const p = imagePxToScreen(vp, posPx[0], posPx[1]);
    this.ctx.drawImage(
      img,
      p.x + (offset[0] - anchor[0]) * s,
      p.y + (offset[1] - anchor[1]) * s,
      (img.naturalWidth || img.width) * s,
      (img.naturalHeight || img.height) * s,
    );
  }

  drawPitcher(frame) {
    const sp = SPRITES.pitcher;
    const f = project(PITCHER.feet);
    this.sprite(this.images.pitcher[frame - 1], sp.anchor, [f.u * IMAGE_W, f.v * IMAGE_H], sp.scale, sp.frameOffset[frame]);
  }

  drawBatter(frame) {
    const sp = SPRITES.batter;
    this.sprite(this.images.batter[frame - 1], sp.anchor, sp.pos, sp.scale, sp.frameOffset[frame]);
  }

  drawLamp(broken) {
    const sp = SPRITES.lamp;
    const key = broken ? 'lamp_broken' : 'lamp_intact';
    this.sprite(this.images.props[key], sp.anchor, sp.pos, sp.scale, sp.frameOffset[key]);
  }

  drawVase(broken) {
    const sp = SPRITES.vase;
    if (broken) this.sprite(this.images.props.vase_broken, sp.brokenAnchor, sp.pos, sp.brokenScale);
    else this.sprite(this.images.props.vase_intact, sp.intactAnchor, sp.pos, sp.scale);
  }

  drawShards(scene) {
    // 電球の真下の床へガラス片が落ちる
    const lamp = scene.zones.lamp;
    const k = Math.min(1, Math.max(0, (scene.time - (scene.lampBrokenAt ?? 0)) / 0.45));
    const top = [lamp.center[0] * IMAGE_W, (lamp.center[1] + lamp.radius[1] * 0.6) * IMAGE_H];
    const floorPt = project([unprojectX(lamp), 0, lamp.depthZ]);
    const bottom = [floorPt.u * IMAGE_W, floorPt.v * IMAGE_H];
    const y = top[1] + (bottom[1] - top[1]) * k * k;
    const img = this.images.props.glass_fragments;
    const scale = 0.22 + 0.08 * k;
    this.sprite(img, [img.width / 2, img.height / 2], [top[0], y], scale);
  }

  drawShadow(pos) {
    const { ctx } = this;
    const s = worldToScreen(this.vp, [pos[0], 0, pos[2]]);
    const r = BALL_RADIUS * s.scale * 1.3;
    const fade = Math.max(0.08, 0.45 - pos[1] * 0.25);
    ctx.fillStyle = `rgba(40,20,5,${fade})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.2, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawBall(ball) {
    const { ctx } = this;
    const img = this.images.props.pingpong_ball;
    // 短い残像
    ball.trail.forEach((p, i) => {
      const s = worldToScreen(this.vp, p);
      const r = Math.max(1.5, BALL_RADIUS * s.scale);
      ctx.fillStyle = `rgba(255,250,235,${0.08 + (0.25 * (i + 1)) / ball.trail.length})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
    });
    const s = worldToScreen(this.vp, ball.pos);
    const r = Math.max(2.5, BALL_RADIUS * s.scale);
    // 素材は 200x215 の中に直径約150pxの球
    const k = (2 * r) / 150;
    ctx.drawImage(img, s.x - 100 * k, s.y - 106 * k, 200 * k, 215 * k);
  }

  drawStrikeZone() {
    const { ctx, vp } = this;
    const a = worldToScreen(vp, [PLATE.zoneX[0], PLATE.zoneY[1], PLATE.z]);
    const b = worldToScreen(vp, [PLATE.zoneX[1], PLATE.zoneY[0], PLATE.z]);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    roundRect(ctx, a.x, a.y, b.x - a.x, b.y - a.y, 6);
    ctx.fill();
    ctx.stroke();
  }

  drawCursor(c) {
    const { ctx, vp } = this;
    const s = worldToScreen(vp, [c[0], c[1], PLATE.z]);
    const r = 0.06 * s.scale; // 芯（見た目）。当たり範囲はもう少し広い
    ctx.strokeStyle = 'rgba(255,225,60,0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r, r * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,225,60,0.9)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawPreviewPath(points) {
    const { ctx, vp } = this;
    ctx.strokeStyle = 'rgba(255,90,60,0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = worldToScreen(vp, p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawZones(zones, full) {
    const { ctx, vp } = this;
    const poly = (pts, fill, stroke) => {
      ctx.beginPath();
      pts.forEach(([u, v], i) => {
        const s = imageToScreen(vp, u, v);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    const ell = (e, fill, stroke) => {
      const c = imageToScreen(vp, e.center[0], e.center[1]);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, e.radius[0] * vp.w, e.radius[1] * vp.h, 0, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const z of zones.safeZones) poly(z.polygon, full ? 'rgba(40,220,90,0.30)' : 'rgba(40,220,90,0.16)', 'rgba(40,220,90,0.8)');
    if (full) for (const o of zones.obstacles) poly(o.polygon, 'rgba(120,120,120,0.25)', 'rgba(200,200,200,0.8)');
    ell(zones.pitcherCatchZone, 'rgba(255,60,60,0.14)', 'rgba(255,80,80,0.9)');
    ell(zones.lamp, 'rgba(255,170,0,0.14)', 'rgba(255,170,0,0.9)');
  }
}

function vaseDepth(zones) {
  return zones.obstacles.find((o) => o.id === 'vase')?.depthZ ?? 2.87;
}

function unprojectX(lamp) {
  return unprojectAtZ(lamp.center[0], lamp.center[1], lamp.depthZ)[0];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
