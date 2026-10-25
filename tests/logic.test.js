import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { newGame, applyPitchResult, winner } from '../src/rules.js';
import { normalizeZones, pointInPolygon } from '../src/zones.js';
import { firstCollision, simulateBattedBall, isStrike } from '../src/physics.js';
import { launchFromOffsets, computeContact } from '../src/batting.js';
import { buildPitchPath, bendLimit, constrainPitch, defaultPitch, releasePoint, pitchDuration } from '../src/pitch.js';
import { PitchRun } from '../src/pitchRun.js';
import { forecastCircle, randomForecastOffset } from '../src/forecast.js';
import { project, unprojectAtZ, unprojectAtX, computeViewport, imageToScreen, screenToImage } from '../src/projection.js';
import { PITCH_LIMITS, PLATE, SWING, ROOM } from '../src/config.js';

const zonesJson = JSON.parse(fs.readFileSync(new URL('../zones.initial.json', import.meta.url)));
const zones = () => normalizeZones(structuredClone(zonesJson));

const play = (s, ...rs) => rs.reduce((a, r) => applyPitchResult(a, r), s);

// ---------- ルール ----------
test('4ボールで出塁し、攻守交代しない', () => {
  const s = play(newGame(), 'ball', 'ball', 'ball', 'ball');
  assert.equal(s.half, 0);
  assert.deepEqual(s.bases, [true, false, false]);
  assert.equal(s.balls, 0);
  assert.equal(s.strikes, 0);
});

test('3ストライクで1アウト→交代、走者とカウントはリセット', () => {
  let s = play(newGame(), 'hit', 'ball', 'strike', 'strike');
  assert.equal(s.half, 0);
  s = applyPitchResult(s, 'strike');
  assert.equal(s.half, 1);
  assert.deepEqual(s.bases, [false, false, false]);
  assert.equal(s.balls + s.strikes, 0);
});

test('ヒット後はカウントがリセットされ、走者は1つずつ進む', () => {
  const s = play(newGame(), 'ball', 'strike', 'strike', 'hit');
  assert.equal(s.balls, 0);
  assert.equal(s.strikes, 0);
  const s2 = play(s, 'hit', 'hit');
  assert.deepEqual(s2.bases, [true, true, true]);
  assert.equal(s2.score[0], 0);
  const s3 = applyPitchResult(s2, 'hit');
  assert.equal(s3.score[0], 1);
  const s4 = play(s3, 'ball', 'ball', 'ball', 'ball');
  assert.equal(s4.score[0], 2, '四球でも全員進塁して得点');
});

test('3回まで両者が攻撃して終了。同点は引き分け', () => {
  let s = newGame(3);
  for (let i = 0; i < 5; i++) s = applyPitchResult(s, 'out');
  assert.equal(s.over, false);
  assert.equal(s.inning, 3);
  assert.equal(s.half, 1, '最終回の裏も攻撃する');
  s = applyPitchResult(s, 'out');
  assert.equal(s.over, true);
  assert.equal(winner(s), 'draw');
  assert.equal(applyPitchResult(s, 'hit'), s, '終了後は変化しない');
});

test('再戦で全状態が初期化される', () => {
  const a = newGame();
  const b = play(a, 'hit', 'hit', 'out');
  assert.notDeepEqual(b, a);
  assert.deepEqual(newGame(), a);
});

// ---------- 座標変換 ----------
test('投影と逆投影が一致し、余白付きの画面変換もずれない', () => {
  const p = [0.4, 0.7, 3.3];
  const q = project(p);
  const r = unprojectAtZ(q.u, q.v, 3.3);
  p.forEach((c, i) => assert.ok(Math.abs(c - r[i]) < 1e-9));
  for (const [w, h] of [[1180, 820], [1366, 1024], [800, 1200], [2000, 700]]) {
    const vp = computeViewport(w, h);
    const s = imageToScreen(vp, q.u, q.v);
    const back = screenToImage(vp, s.x, s.y);
    assert.ok(Math.abs(back.u - q.u) < 1e-9 && Math.abs(back.v - q.v) < 1e-9);
    assert.ok(vp.x >= 0 && vp.y >= 0 && vp.w <= w + 1e-9 && vp.h <= h + 1e-9);
  }
});

test('縁はセーフ側（内側）として扱う', () => {
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pointInPolygon([1, 0.5], sq), true);
  assert.equal(pointInPolygon([0.5, 0], sq), true);
  assert.equal(pointInPolygon([1.0001, 0.5], sq), false);
});

// ---------- 打球判定 ----------
// 打球が狙った区域に届く打ち方（タイミング・芯ずれ）が存在するか
function findShot(zns, id) {
  for (let dz = -SWING.depthWindow; dz <= SWING.depthWindow + 1e-9; dz += 0.025) {
    for (let dx = -0.13; dx <= 0.13 + 1e-9; dx += 0.013) {
      for (let dy = -0.13; dy <= 0.13 + 1e-9; dy += 0.013) {
        if (Math.hypot(dx, dy) > SWING.contactRadius) continue;
        const l = launchFromOffsets(dz, dx, dy);
        const sim = simulateBattedBall([-0.1, 0.28, PLATE.z + dz], l.velocity, zns);
        if (sim.hit.id === id) return { dz, dx, dy, sim };
      }
    }
  }
  return null;
}

for (const id of ['between_curtains', 'right_door', 'calendar', 'rear_left_cabinet_top']) {
  test(`セーフ区域「${id}」へ打てる`, () => {
    const shot = findShot(zones(), id);
    assert.ok(shot, `${id} に届く打ち方がない`);
    assert.equal(shot.sim.hit.result, 'safe');
  });
}

test('投手・床・壁・テレビはアウト', () => {
  const z = zones();
  for (const id of ['pitcher', 'floor', 'backWall', 'leftWall', 'rightWall', 'tv', 'photo']) {
    const shot = findShot(z, id);
    assert.ok(shot, `${id} に当たる打球が見つからない`);
    assert.equal(shot.sim.hit.result, 'out');
  }
});

test('投手の守備範囲は奥のセーフ区域より優先（先に通過したらアウト）', () => {
  const z = zones();
  // 背景上で投手の円と「カーテンの間」が重なる点をめがけてまっすぐ飛ばす
  const target = unprojectAtZ(0.56, 0.40, ROOM.backZ - 0.05);
  const start = [0.1, 0.4, PLATE.z];
  const dir = target.map((c, i) => c - start[i]);
  const hit = firstCollision(start, target.map((c, i) => c + dir[i] * 0.1), z);
  assert.equal(hit.id, 'pitcher');
  assert.equal(hit.result, 'out');
  // 同じ画像位置でも投手範囲を外せばセーフ
  const z2 = zones();
  z2.pitcherCatchZone.radius = [0.001, 0.001];
  assert.equal(firstCollision(start, target.map((c, i) => c + dir[i] * 0.1), z2).id, 'between_curtains');
});

test('写真立てはセーフ区域の中にあってもアウト', () => {
  const z = zones();
  const photo = z.obstacles.find((o) => o.id === 'photo');
  const cabinet = z.safeZones.find((s) => s.id === 'rear_left_cabinet_top');
  const c = [(photo.polygon[0][0] + photo.polygon[1][0]) / 2, (photo.polygon[0][1] + photo.polygon[2][1]) / 2];
  assert.ok(pointInPolygon(c, cabinet.polygon), '写真立てはセーフ区域の内側にある');
  const target = unprojectAtZ(c[0], c[1], cabinet.surface.z);
  const start = [-0.1, 0.3, PLATE.z];
  const end = start.map((v, i) => v + (target[i] - v) * 1.2);
  const hit = firstCollision(start, end, z);
  assert.equal(hit.id, 'photo');
  assert.equal(hit.result, 'out');
  // 写真立てから外れた位置ならセーフ
  const t2 = unprojectAtZ(0.2, 0.2, cabinet.surface.z);
  assert.equal(firstCollision(start, start.map((v, i) => v + (t2[i] - v) * 1.2), z).id, 'rear_left_cabinet_top');
});

test('右の区域は天井近くと右奥の壁もセーフ', () => {
  const z = zones();
  const start = [-0.1, 0.3, PLATE.z];
  for (const [u, v] of [[0.84, 0.15], [0.97, 0.06], [0.86, 0.3]]) {
    const target = unprojectAtX(u, v, ROOM.rightX);
    const hit = firstCollision(start, start.map((c, i) => c + (target[i] - c) * 1.05), z);
    assert.equal(hit.id, 'right_door', `${u},${v}`);
  }
});

test('電球が先なら奥がセーフでもアウト', () => {
  const z = zones();
  // 電球の奥までセーフ区域を広げても、電球に先に当たればアウト
  z.safeZones[0].polygon = [[0.3, 0.0], [0.8, 0.0], [0.8, 0.6], [0.3, 0.6]];
  const lampPt = unprojectAtZ(z.lamp.center[0], z.lamp.center[1], z.lamp.depthZ);
  const start = [0.1, 0.5, PLATE.z];
  const end = start.map((c, i) => c + (lampPt[i] - c) * 1.8);
  const hit = firstCollision(start, end, z);
  assert.equal(hit.id, 'lamp');
  assert.equal(hit.result, 'out');
});

test('画面上で区域に重なっても、まだ手前にある球はヒットにならない', () => {
  const z = zones();
  // 「カーテンの間」に画面上で重なる位置だが、奥行きはまだ手前（z=2.5）で床に落ちる線分
  const a = unprojectAtZ(0.55, 0.3, 2.5);
  const b = [a[0], -0.5, 2.6];
  const hit = firstCollision(a, b, z);
  assert.equal(hit.id, 'floor');
});

test('高速の球でも面をすり抜けない（移動線分で判定）', () => {
  const z = zones();
  const target = unprojectAtZ(0.56, 0.46, 4.4);
  // 1ステップで投手の面を大きく飛び越える線分
  const a = [target[0], target[1], 1.0];
  const b = [target[0], target[1], 50];
  const hit = firstCollision(a, b, z);
  assert.equal(hit.id, 'pitcher');
  // 打球シミュレーションでも、1ステップで数mも進む速さ・粗い刻みで投手を検出する
  const start = [0.1, 0.4, PLATE.z];
  const dir = target.map((c, i) => c - start[i]);
  const len = Math.hypot(...dir);
  const sim = simulateBattedBall(start, dir.map((c) => (c / len) * 120), z, { dt: 1 / 30 });
  assert.equal(sim.hit.id, 'pitcher');
});

test('打球方向は連続的で乱数を使わない（早い→左、遅い→右）', () => {
  const early = launchFromOffsets(0.2, 0, 0);
  const late = launchFromOffsets(-0.2, 0, 0);
  assert.ok(early.velocity[0] < 0 && late.velocity[0] > 0);
  assert.deepEqual(launchFromOffsets(0.1, 0.02, 0.03), launchFromOffsets(0.1, 0.02, 0.03));
  const up = launchFromOffsets(0, 0, 0.05);
  const down = launchFromOffsets(0, 0, -0.05);
  assert.ok(up.launch > down.launch);
});

// ---------- 投球 ----------
test('投球の制御点は範囲・1階差に収まり、始点はリリース点に固定', () => {
  const r = releasePoint();
  const wild = constrainPitch({ speed: 99, xs: [5, -9, 9, -9, 9], ys: [7, 7, -3, 99, -99] });
  assert.equal(wild.speed, PITCH_LIMITS.speedSteps);
  assert.equal(wild.xs[0], r[0]);
  assert.equal(wild.ys[0], r[1]);
  for (const [vals, range] of [[wild.xs, PITCH_LIMITS.xRange], [wild.ys, PITCH_LIMITS.yRange]]) {
    for (let i = 1; i < vals.length; i++) {
      assert.ok(vals[i] >= range[0] - 1e-9 && vals[i] <= range[1] + 1e-9);
      assert.ok(Math.abs(vals[i] - vals[i - 1]) <= PITCH_LIMITS.maxStep + 1e-9);
    }
  }
});

test('奥行きは単調に前進し、軌道は制御点の範囲を超えない', () => {
  const path = buildPitchPath({ speed: 7, xs: [0, 0.4, -0.3, 0.5, -0.2], ys: [0.6, 1.2, 0.2, 0.9, 0.1] });
  let prevZ = Infinity;
  const xs = path.pitch.xs;
  for (let i = 0; i <= 200; i++) {
    const p = path.posAtS(i / 200);
    assert.ok(p[2] < prevZ);
    prevZ = p[2];
    assert.ok(p[0] >= Math.min(...xs) - 1e-9 && p[0] <= Math.max(...xs) + 1e-9, 'PCHIPで行き過ぎない');
  }
});

test('試し投げと本番は同じ計算結果', () => {
  const pitch = { speed: 4, xs: [0, 0.2, 0.3, 0.2, 0.1], ys: [0.6, 0.8, 0.7, 0.4, 0.3] };
  const a = buildPitchPath(pitch);
  const b = buildPitchPath(structuredClone(pitch));
  for (let t = 0; t < a.endTime; t += 0.05) assert.deepEqual(a.posAt(t), b.posAt(t));
  assert.equal(a.duration, pitchDuration(4));
});

// ---------- 1投球の判定 ----------
const straightTo = (x, y, speed = 5) => {
  const r = releasePoint();
  const xs = [];
  const ys = [];
  for (let i = 0; i < 5; i++) {
    xs.push(r[0] + (x - r[0]) * (i / 4));
    ys.push(r[1] + (y - r[1]) * (i / 4));
  }
  return buildPitchPath({ speed, xs, ys });
};

const runUntilDone = (run, cursor = [0, 0]) => {
  for (let t = 0; t < 10 && !run.resolved; t += 1 / 60) run.update(t, cursor);
  return run.outcome;
};

test('見送り: ゾーン内はストライク、ゾーン外はボール', () => {
  const z = zones();
  const cx = (PLATE.zoneX[0] + PLATE.zoneX[1]) / 2;
  assert.equal(runUntilDone(new PitchRun(straightTo(cx, 0.4), z)).type, 'strike');
  assert.equal(runUntilDone(new PitchRun(straightTo(cx + 0.6, 0.4), z)).type, 'ball');
  assert.equal(runUntilDone(new PitchRun(straightTo(cx, 0.9), z)).type, 'ball');
  assert.ok(isStrike([PLATE.zoneX[1] + 0.01, 0.3, PLATE.z]), 'ゾーンにかかればストライク');
});

test('空振りはコースによらずストライク', () => {
  const z = zones();
  const run = new PitchRun(straightTo(0.7, 0.9), z);
  run.pressSwing(0.1);
  assert.equal(runUntilDone(run, [-0.5, 0]).type, 'strike');
  assert.equal(run.outcome.reason, 'swingMiss');
});

test('投球が先に床に当たったら1ボール', () => {
  const z = zones();
  const r = releasePoint();
  const path = buildPitchPath({ speed: 5, xs: [r[0], 0, 0.05, 0.1, 0.1], ys: [r[1], 0.3, 0.0, 0.0, 0.0] });
  const out = runUntilDone(new PitchRun(path, z));
  assert.equal(out.type, 'ball');
  assert.equal(out.reason, 'pitchObstacle');
});

test('芯で捉えれば打てる。連打しても1投球の結果は1回だけ', () => {
  const z = zones();
  const path = straightTo(-0.1, 0.28, 5);
  const run = new PitchRun(path, z);
  const press = path.duration - SWING.impactDelay; // インパクトで判定面に到達
  assert.equal(run.pressSwing(press), true);
  assert.equal(run.pressSwing(press + 0.01), false);
  assert.equal(run.pressSwing(press + 0.02), false);
  const ball = path.posAt(path.duration);
  const out = runUntilDone(run, [ball[0], ball[1]]);
  assert.equal(out.reason, 'batted');
  const first = run.outcome;
  run.update(20, [0, 0]);
  assert.equal(run.outcome, first, '結果は変わらない');
});

test('打撃可能な奥行きの外ではバットに当たらない', () => {
  const path = straightTo(-0.1, 0.28, 5);
  const tooEarly = path.duration * 0.5;
  const ball = path.posAt(tooEarly);
  assert.equal(computeContact(path, tooEarly, [ball[0], ball[1]]), null);
});

// ---------- 予報円 ----------
test('予報円は近づくほど小さくなり、通過点は常に円の内側', () => {
  const pass = [0.05, 0.3];
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 200; n++) {
    const off = randomForecastOffset(rand);
    let prevR = Infinity;
    for (let t = 0; t <= 1.0; t += 0.05) {
      const f = forecastCircle(pass, off, t, 1.0);
      assert.ok(f.r <= prevR + 1e-12);
      prevR = f.r;
      assert.ok(Math.hypot(f.center[0] - pass[0], f.center[1] - pass[1]) < f.r, '通過点が円の外');
    }
  }
});

test('遅い球ほど曲げられ、速い球ほど曲げられない', () => {
  const r = releasePoint();
  // 大きく蛇行させようとした同じ入力を、球速だけ変えて制限する
  const wild = { xs: [r[0], 0.6, -0.5, 0.6, -0.5], ys: [r[1], 1.2, 0.1, 1.2, 0.1] };
  let prevBend = Infinity;
  for (let speed = 1; speed <= PITCH_LIMITS.speedSteps; speed++) {
    const p = constrainPitch({ ...wild, speed });
    const lim = bendLimit(speed);
    assert.ok(lim < prevBend, '速いほど上限が小さい');
    prevBend = lim;
    // 実際の曲がり（2階差分の最大）も上限以内
    let bend = 0;
    for (const vals of [p.xs, p.ys]) {
      for (let i = 2; i < vals.length; i++) bend = Math.max(bend, Math.abs(vals[i] - 2 * vals[i - 1] + vals[i - 2]));
    }
    assert.ok(bend <= lim + 1e-9, `speed ${speed}: ${bend} > ${lim}`);
  }
  // 最速はほぼまっすぐ、最遅ははっきり曲がる
  const curve = (speed) => {
    const p = constrainPitch({ ...wild, speed });
    return Math.max(...[2, 3, 4].map((i) => Math.abs(p.xs[i] - 2 * p.xs[i - 1] + p.xs[i - 2])));
  };
  assert.ok(curve(10) <= 0.03 + 1e-9);
  assert.ok(curve(1) > 0.3);
});
