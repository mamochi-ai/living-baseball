// 投球軌道。横軸は「投手→打者の進行度 s」で統一し、
// 上から見た左右 (x) と横から見た高さ (y) を同じ s に対して編集する。
// s=0 がリリース点、s=1 が打者前の判定面。奥行き z は s に比例して単調に前進する。
import { PITCH_LIMITS, PITCHER, PLATE, SPRITES, IMAGE_W, IMAGE_H } from './config.js';
import { project, unprojectAtZ } from './projection.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** pitcher_08 の手の位置から逆算したリリース点（描画と同じ変換を使う） */
export function releasePoint() {
  const sp = SPRITES.pitcher;
  const feet = project(PITCHER.feet);
  const off = sp.frameOffset[8] ?? [0, 0];
  const px = feet.u * IMAGE_W + (PITCHER.handCanvas[0] + off[0] - sp.anchor[0]) * sp.scale;
  const py = feet.v * IMAGE_H + (PITCHER.handCanvas[1] + off[1] - sp.anchor[1]) * sp.scale;
  return unprojectAtZ(px / IMAGE_W, py / IMAGE_H, PITCHER.releaseZ);
}

export function knotS(i) {
  return i / (PITCH_LIMITS.points - 1);
}

/** まっすぐストライクゾーン中央へ向かう初期設定 */
export function defaultPitch() {
  const r = releasePoint();
  const n = PITCH_LIMITS.points;
  const tx = (PLATE.zoneX[0] + PLATE.zoneX[1]) / 2;
  const ty = (PLATE.zoneY[0] + PLATE.zoneY[1]) / 2;
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) {
    const s = knotS(i);
    xs.push(r[0] + (tx - r[0]) * s);
    ys.push(r[1] + (ty - r[1]) * s);
  }
  return constrainPitch({ speed: 5, xs, ys });
}

/**
 * 1軸ぶんの制御点に上限をかける。始点は固定。
 * 範囲 → 1階差（速さ）→ 2階差（曲がり＝加速度）の順で、両立できない場合は範囲と速さを優先する。
 */
export function constrainAxis(values, range, first) {
  const { maxStep, maxBend } = PITCH_LIMITS;
  const out = values.map((v) => (Number.isFinite(v) ? v : first));
  out[0] = first;
  for (let i = 1; i < out.length; i++) {
    let lo = Math.max(range[0], out[i - 1] - maxStep);
    let hi = Math.min(range[1], out[i - 1] + maxStep);
    if (i >= 2) {
      const pred = 2 * out[i - 1] - out[i - 2];
      const blo = Math.max(lo, pred - maxBend);
      const bhi = Math.min(hi, pred + maxBend);
      if (blo <= bhi) {
        lo = blo;
        hi = bhi;
      }
    }
    if (lo > hi) lo = hi = clamp(out[i - 1], range[0], range[1]);
    out[i] = clamp(out[i], lo, hi);
  }
  return out;
}

export function constrainPitch(p) {
  const r = releasePoint();
  return {
    speed: clamp(Math.round(p.speed ?? 5), 1, PITCH_LIMITS.speedSteps),
    xs: constrainAxis(p.xs, PITCH_LIMITS.xRange, r[0]),
    ys: constrainAxis(p.ys, PITCH_LIMITS.yRange, r[1]),
  };
}

/** 球速スライダー → リリースから判定面までの所要時間 */
export function pitchDuration(speed) {
  const { durationSlow, durationFast, speedSteps } = PITCH_LIMITS;
  const k = (clamp(speed, 1, speedSteps) - 1) / (speedSteps - 1);
  return durationSlow + (durationFast - durationSlow) * k;
}

// 単調3次エルミート（PCHIP）。制御点の間で行き過ぎ（オーバーシュート）しない。
function pchipSlopes(ys, h) {
  const n = ys.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / h);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  }
  return m;
}

function pchipEval(ys, m, h, s) {
  const n = ys.length;
  if (s >= 1) return ys[n - 1] + m[n - 1] * (s - 1); // 判定面の先は接線方向に直進
  if (s <= 0) return ys[0];
  const i = Math.min(n - 2, Math.floor(s / h));
  const t = (s - i * h) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[i] +
    (t3 - 2 * t2 + t) * h * m[i] +
    (-2 * t3 + 3 * t2) * ys[i + 1] +
    (t3 - t2) * h * m[i + 1]
  );
}

/**
 * 投球設定から、時刻 t（リリース=0）の位置を返す関数群を作る。
 * プレビュー（試し投げ）と本番は同じこの結果を使う。
 */
export function buildPitchPath(pitchIn) {
  const p = constrainPitch(pitchIn);
  const h = 1 / (PITCH_LIMITS.points - 1);
  const mx = pchipSlopes(p.xs, h);
  const my = pchipSlopes(p.ys, h);
  const z0 = PITCHER.releaseZ;
  const z1 = PLATE.z;
  const T = pitchDuration(p.speed);
  const sEnd = (z0 - PLATE.passZ) / (z0 - z1);
  return {
    pitch: p,
    duration: T, // リリース→判定面
    endTime: T * sEnd, // 判定面を過ぎて消えるまで
    sAt: (t) => t / T,
    posAtS(s) {
      return [pchipEval(p.xs, mx, h, s), pchipEval(p.ys, my, h, s), z0 + (z1 - z0) * s];
    },
    posAt(t) {
      return this.posAtS(t / T);
    },
  };
}
