// ワールド座標 ⇔ 背景画像座標 ⇔ 画面座標の変換。
// 描画と判定はすべてここを通すので、画面サイズや余白が変わってもずれない。
import { CAMERA, IMAGE_W, IMAGE_H } from './config.js';

const NEAR = 0.05;

/** ワールド座標 → 背景画像の正規化座標 (0〜1)。scale は 1m あたりの画像px。 */
export function project(p) {
  const z = Math.max(p[2], NEAR);
  const px = CAMERA.cx + (CAMERA.f * p[0]) / z;
  const py = CAMERA.cy - (CAMERA.f * (p[1] - CAMERA.eyeY)) / z;
  return { u: px / IMAGE_W, v: py / IMAGE_H, scale: CAMERA.f / z };
}

/** 背景画像の正規化座標と奥行き z から、その奥行きの面上のワールド座標を求める。 */
export function unprojectAtZ(u, v, z) {
  const px = u * IMAGE_W;
  const py = v * IMAGE_H;
  return [((px - CAMERA.cx) * z) / CAMERA.f, CAMERA.eyeY - ((py - CAMERA.cy) * z) / CAMERA.f, z];
}

/** 背景画像の正規化座標と x 一定の面（側壁）から、その面上のワールド座標を求める。 */
export function unprojectAtX(u, v, x) {
  const px = u * IMAGE_W;
  const py = v * IMAGE_H;
  const z = (CAMERA.f * x) / (px - CAMERA.cx);
  return [x, CAMERA.eyeY - ((py - CAMERA.cy) * z) / CAMERA.f, z];
}

/**
 * 画面（CSS px）に背景画像を収める変換。余白は上下または左右に付く（contain）。
 * セーフ範囲が画面端にあるため、切り抜き（cover）はしない。
 */
export function computeViewport(screenW, screenH) {
  const s = Math.min(screenW / IMAGE_W, screenH / IMAGE_H);
  const w = IMAGE_W * s;
  const h = IMAGE_H * s;
  return { x: (screenW - w) / 2, y: (screenH - h) / 2, w, h, s };
}

export function imageToScreen(vp, u, v) {
  return { x: vp.x + u * vp.w, y: vp.y + v * vp.h };
}

export function screenToImage(vp, x, y) {
  return { u: (x - vp.x) / vp.w, v: (y - vp.y) / vp.h };
}

/** 画像px（1536x1024 基準）→ 画面px */
export function imagePxToScreen(vp, px, py) {
  return { x: vp.x + px * vp.s, y: vp.y + py * vp.s };
}

export function worldToScreen(vp, p) {
  const q = project(p);
  return { x: vp.x + q.u * vp.w, y: vp.y + q.v * vp.h, scale: q.scale * vp.s };
}
