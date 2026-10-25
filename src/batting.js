// 打撃。ボタン押下から一定時間後のインパクト時刻だけで当たりを判定する。
// 打球方向はタイミング（球の奥行きのずれ）と芯からの上下左右のずれで連続的に決まり、乱数は使わない。
import { SWING, PLATE } from './config.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param path buildPitchPath の結果
 * @param impactTime インパクト時刻（リリース=0）
 * @param cursor 判定面上のミートカーソル [x, y]
 * @returns 当たった場合 { point, velocity, quality, timing, offset }、空振りは null
 */
export function computeContact(path, impactTime, cursor) {
  if (impactTime < 0 || impactTime > path.endTime) return null;
  const ball = path.posAt(impactTime);
  const dz = ball[2] - PLATE.z; // 正＝球がまだ奥＝振り遅れでなく「早い」
  if (Math.abs(dz) > SWING.depthWindow) return null;
  const dx = ball[0] - cursor[0];
  const dy = ball[1] - cursor[1];
  const dist = Math.hypot(dx, dy);
  if (dist > SWING.contactRadius) return null;
  return { point: ball, ...launchFromOffsets(dz, dx, dy) };
}

/** タイミングと芯ずれ → 打球の初速ベクトル */
export function launchFromOffsets(dz, dx, dy) {
  const dist = Math.hypot(dx, dy);
  const quality = 1 - 0.5 * (dist / SWING.contactRadius) ** 2 - 0.3 * (Math.abs(dz) / SWING.depthWindow) ** 2;
  const yaw = clamp(-dz * SWING.yawPerDepth + dx * SWING.yawPerOffsetX, -1.25, 1.25);
  const launch = clamp(SWING.baseLaunch + dy * SWING.launchPerOffsetY, ...SWING.launchRange);
  const speed = SWING.speedMax * (SWING.speedMinRatio + (1 - SWING.speedMinRatio) * clamp(quality, 0, 1));
  const velocity = [
    speed * Math.cos(launch) * Math.sin(yaw),
    speed * Math.sin(launch),
    speed * Math.cos(launch) * Math.cos(yaw),
  ];
  return { velocity, quality, timing: dz, offset: [dx, dy], yaw, launch, speed };
}

export function clampCursor([x, y]) {
  return [clamp(x, ...SWING.cursorRangeX), clamp(y, ...SWING.cursorRangeY)];
}
