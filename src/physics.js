// 衝突判定。球の位置はワールド座標で管理し、フレーム間（サブステップ間）の移動線分で
// 面との交差を求める。最も早い衝突を採用し、結果はその1回だけで確定する。
import { ROOM, BALL_RADIUS, PHYSICS, PLATE } from './config.js';
import { project, unprojectAtZ } from './projection.js';
import { pointInPolygon, pointInEllipse } from './zones.js';

// 同時刻で並んだときの優先度（小さいほど優先）。アウト側の遮蔽物を先に見る。
const PRIORITY = { pitcher: 0, lamp: 1, obstacle: 2, safeTarget: 3, wall: 4 };

function crossAxis(p0, p1, axis, value) {
  const a = p0[axis] - value;
  const b = p1[axis] - value;
  if (a === b) return null;
  if ((a > 0 && b > 0) || (a < 0 && b < 0)) return null;
  const t = a / (a - b);
  if (t < 0 || t > 1) return null;
  return t;
}

const lerp3 = (p0, p1, t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];

const uv = (p) => {
  const q = project(p);
  return [q.u, q.v];
};

/**
 * 線分 p0→p1 と判定対象の最初の衝突を返す。
 * mode: 'batted'（打球）/ 'pitch'（投球。床・天井・電球のみ）
 * 戻り値: { t, point, kind, id, result: 'safe'|'out', label } または null
 */
export function firstCollision(p0, p1, zones, mode = 'batted') {
  const hits = [];
  const add = (t, kind, id, result, label) => {
    if (t === null) return;
    hits.push({ t, point: lerp3(p0, p1, t), kind, id, result, label });
  };
  const r = BALL_RADIUS;

  // 床・天井（球の半径ぶん内側の面）
  add(crossAxis(p0, p1, 1, ROOM.floorY + r), 'wall', 'floor', 'out', '床');
  add(crossAxis(p0, p1, 1, ROOM.ceilingY - r), 'wall', 'ceiling', 'out', '天井');

  // 電球（奥行き一定の面上の楕円）
  const lt = crossAxis(p0, p1, 2, zones.lamp.depthZ);
  if (lt !== null && pointInEllipse(uv(lerp3(p0, p1, lt)), zones.lamp)) add(lt, 'lamp', 'lamp', 'out', '電球');

  if (mode === 'batted') {
    // 投手の守備範囲（背景上でセーフ区域と重なっていても先にここを通ればアウト）
    const pz = zones.pitcherCatchZone;
    const pt = crossAxis(p0, p1, 2, pz.depthZ);
    if (pt !== null && pointInEllipse(uv(lerp3(p0, p1, pt)), pz)) add(pt, 'pitcher', 'pitcher', 'out', 'ピッチャー');

    // 手前の障害物（テレビ・花瓶など）
    for (const o of zones.obstacles) {
      const ot = crossAxis(p0, p1, 2, o.depthZ);
      if (ot !== null && pointInPolygon(uv(lerp3(p0, p1, ot)), o.polygon)) add(ot, 'obstacle', o.id, 'out', o.label);
    }

    // 奥行き一定の面に置かれたセーフ区域（左奥のタンスの上など）
    for (const zn of zones.safeZones) {
      if (zn.surface.type !== 'depth') continue;
      const st = crossAxis(p0, p1, 2, zn.surface.z);
      if (st !== null && pointInPolygon(uv(lerp3(p0, p1, st)), zn.polygon)) add(st, 'safeTarget', zn.id, 'safe', zn.label);
    }

    // 部屋の壁。壁面上のセーフ区域に入っていればセーフ、それ以外はアウト。
    const walls = [
      { axis: 2, value: ROOM.backZ - r, id: 'backWall', label: '奥の壁' },
      { axis: 0, value: ROOM.rightX - r, id: 'rightWall', label: '右の壁' },
      { axis: 0, value: ROOM.leftX + r, id: 'leftWall', label: '左の壁' },
      { axis: 2, value: ROOM.behindZ, id: 'behind', label: '後ろ' },
    ];
    for (const w of walls) {
      const wt = crossAxis(p0, p1, w.axis, w.value);
      if (wt === null) continue;
      const pt2 = lerp3(p0, p1, wt);
      const zone = zones.safeZones.find((zn) => zn.surface.type === w.id && pointInPolygon(uv(pt2), zn.polygon));
      if (zone) add(wt, 'safeTarget', zone.id, 'safe', zone.label);
      else add(wt, 'wall', w.id, 'out', w.label);
    }
  }

  if (!hits.length) return null;
  hits.sort((a, b) => a.t - b.t || PRIORITY[a.kind] - PRIORITY[b.kind]);
  return hits[0];
}

/**
 * 打球を固定刻みで積分し、最初の衝突で結果を確定する。
 * 返す path は描画用（衝突後の短い跳ね返りを含むが結果は変えない）。
 */
export function simulateBattedBall(start, velocity, zones, opts = {}) {
  const dt = opts.dt ?? PHYSICS.dt;
  const g = PHYSICS.gravity;
  const k = PHYSICS.drag;
  let p = [...start];
  let v = [...velocity];
  const path = [{ t: 0, p: [...p] }];
  let t = 0;
  let hit = null;
  while (t < PHYSICS.maxTime) {
    v = [v[0] - k * v[0] * dt, v[1] - (g + k * v[1]) * dt, v[2] - k * v[2] * dt];
    const np = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
    const c = firstCollision(p, np, zones, 'batted');
    if (c) {
      t += dt * c.t;
      hit = { ...c, time: t };
      path.push({ t, p: c.point });
      break;
    }
    t += dt;
    p = np;
    path.push({ t, p: [...p] });
  }
  if (!hit) {
    hit = { kind: 'wall', id: 'timeout', result: 'out', label: '失速', time: t, point: p };
  }
  // 見た目用の跳ね返り（判定には使わない）
  const bounce = bouncePath(hit, v, dt);
  return { hit, path, bounce };
}

function bouncePath(hit, v, dt) {
  const out = [];
  let p = [...hit.point];
  let bv = [...v];
  if (hit.id === 'floor' || hit.id === 'ceiling') bv[1] = -bv[1] * 0.6;
  else if (hit.id === 'rightWall' || hit.id === 'leftWall') bv[0] = -bv[0] * 0.5;
  else bv[2] = -bv[2] * 0.4;
  bv = bv.map((c) => c * 0.7);
  let t = hit.time;
  for (let i = 0; i < 120; i++) {
    bv[1] -= PHYSICS.gravity * dt;
    p = [p[0] + bv[0] * dt, p[1] + bv[1] * dt, p[2] + bv[2] * dt];
    if (p[1] < BALL_RADIUS) {
      p[1] = BALL_RADIUS;
      bv[1] = Math.abs(bv[1]) * 0.5;
    }
    p[0] = Math.min(ROOM.rightX - BALL_RADIUS, Math.max(ROOM.leftX + BALL_RADIUS, p[0]));
    p[2] = Math.min(ROOM.backZ - BALL_RADIUS, Math.max(ROOM.behindZ, p[2]));
    t += dt;
    out.push({ t, p: [...p] });
  }
  return out;
}

/**
 * 投球（バットに当たらなかった場合）を判定面まで追い、
 * 先に床・天井・電球に当たったか、判定面をどこで通過したかを返す。
 */
export function tracePitch(path, zones, dt = PHYSICS.dt) {
  let prev = path.posAt(0);
  let plateCross = null;
  for (let t = dt; t <= path.endTime + 1e-9; t += dt) {
    const tt = Math.min(t, path.endTime);
    const cur = path.posAt(tt);
    const c = firstCollision(prev, cur, zones, 'pitch');
    const pc = crossAxis(prev, cur, 2, PLATE.z);
    const tPlate = pc === null ? null : tt - dt + dt * pc;
    const tHit = c ? tt - dt + dt * c.t : null;
    if (c && (plateCross === null) && (tPlate === null || tHit <= tPlate)) {
      return { obstacle: { ...c, time: tHit }, plateCross: null };
    }
    if (pc !== null && plateCross === null) {
      plateCross = { time: tPlate, point: lerp3(prev, cur, pc) };
    }
    prev = cur;
  }
  return { obstacle: null, plateCross };
}

/** 判定面上の通過点がストライクか（球が少しでもゾーンにかかればストライク） */
export function isStrike(point) {
  const r = BALL_RADIUS;
  return (
    point[0] >= PLATE.zoneX[0] - r &&
    point[0] <= PLATE.zoneX[1] + r &&
    point[1] >= PLATE.zoneY[0] - r &&
    point[1] <= PLATE.zoneY[1] + r
  );
}

/** 画像上の位置と奥行き面から、ワールド座標の目標点を得る（テスト・調整用） */
export function imageTargetToWorld(u, v, z) {
  return unprojectAtZ(u, v, z);
}
