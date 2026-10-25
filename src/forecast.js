// 打者向けの「予報円」。台風の予報円のように、投球が近づくほど小さくなる円で
// 判定面を通過するおおよその位置を示す。実際の通過点は常に円の内側にある。
// 表示のための仕組みで、判定には使わない。
import { FORECAST } from './config.js';

/** 円の中心のずらし方（-1〜1 の単位ベクトル内）を投球ごとに1回決める */
export function randomForecastOffset(rand = Math.random) {
  const a = rand() * Math.PI * 2;
  const m = Math.sqrt(rand());
  return [Math.cos(a) * m, Math.sin(a) * m];
}

/**
 * @param pass 判定面の通過点 [x, y]
 * @param offset randomForecastOffset の結果
 * @param t リリースからの秒
 * @param T リリースから判定面までの秒
 * @returns { center: [x, y], r }（判定面上のワールド座標・m）
 */
export function forecastCircle(pass, offset, t, T) {
  const k = Math.min(1, Math.max(0, 1 - t / T)); // 1=投げた直後, 0=到達
  const r = FORECAST.minRadius + (FORECAST.maxRadius - FORECAST.minRadius) * k;
  // 中心のずれは半径に比例させ、通過点が必ず円の内側に残るようにする
  const d = FORECAST.offsetRatio * r;
  return { center: [pass[0] + offset[0] * d, pass[1] + offset[1] * d], r };
}
