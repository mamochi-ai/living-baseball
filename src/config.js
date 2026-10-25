// ゲーム全体の定数。論理座標はメートル相当の「ワールド座標」。
//   x: 打者カメラから見て右が正 / y: 床から上が正 / z: カメラから奥が正
// 背景画像の画素座標（1536x1024）とは src/projection.js の透視投影で対応づける。

export const IMAGE_W = 1536;
export const IMAGE_H = 1024;

// 背景 living_room.png に合わせた固定カメラ（打者の後ろ・子供の目線）。
// 消失点・奥の壁の床線・部屋の幅から推定した値。
export const CAMERA = {
  cx: 845, // 消失点の x（画像px）
  cy: 270, // 地平線の y（画像px）
  f: 1097, // 焦点距離（画像px）
  eyeY: 1.1, // カメラの高さ
};

export const ROOM = {
  floorY: 0,
  ceilingY: 1.81,
  leftX: -1.61,
  rightX: 1.99,
  backZ: 5.2,
  behindZ: 0.35, // これより手前（カメラ側）へ戻った打球はアウト
};

export const BALL_RADIUS = 0.02;

// 投手と打者の位置
export const PITCHER = {
  feet: [0, 0, 4.4],
  releaseZ: 4.3,
  // pitcher_08 の手の位置（480x440 キャンバス内 px）。リリース点はここから逆算する。
  handCanvas: [140, 172],
};

export const PLATE = {
  z: 1.6, // 打者前の判定面
  // ストライクゾーン（判定面上）
  zoneX: [-0.3, 0.1],
  zoneY: [0.06, 0.5],
  passZ: 0.9, // 投球はここまで進んで消える
};

// 投球編集の制約（暴走防止）
export const PITCH_LIMITS = {
  points: 5, // 制御点数（リリース〜判定面を4等分）
  xRange: [-0.75, 0.95],
  yRange: [0.0, 1.6],
  maxStep: 0.5, // 隣り合う制御点の差の上限（m）
  maxBend: 0.3, // 2階差分の上限（曲がりの急さ＝加速度の上限）
  durationSlow: 1.6, // 球速スライダー最小時のリリース→判定面の秒数
  durationFast: 0.5, // 最大時
  speedSteps: 10,
};

// 打撃
export const SWING = {
  impactDelay: 0.16, // ボタン押下からインパクトまで（一定）
  depthWindow: 0.35, // インパクト時に球が判定面から前後この範囲なら打撃可能
  contactRadius: 0.13, // ミートカーソル中心からの当たり範囲
  yawPerDepth: 2.4, // 早い（球がまだ奥）→左へ引っ張る
  yawPerOffsetX: 1.2,
  baseLaunch: 0.4, // 芯で捉えたときの打ち出し角（rad）
  launchPerOffsetY: 3.5, // 球が芯より上→バットが下に入り打ち上げる
  launchRange: [-0.6, 1.1],
  speedMax: 10,
  speedMinRatio: 0.6,
  cursorRangeX: [-0.7, 0.5],
  cursorRangeY: [0.0, 1.05],
};

// 打者向けの予報円（通過位置のめやす）
export const FORECAST = {
  maxRadius: 0.3, // 投げた直後の半径（m）
  minRadius: 0.07, // 判定面に届くときの半径
  offsetRatio: 0.7, // 円の中心を通過点からずらす最大量（半径に対する割合）
};

export const PHYSICS = {
  gravity: 9.8,
  drag: 0.3, // 線形空気抵抗（ピンポン玉なので少し効かせる）
  dt: 1 / 240,
  maxTime: 4,
};

// 画面表示（画像px基準）。素材ごとの表示補正はここで調整する。
export const SPRITES = {
  pitcher: {
    canvas: [480, 440],
    anchor: [240, 420],
    scale: 0.6, // 画像px / 素材px
    // コマごとの補正 [dx, dy]（素材px）。原画の姿勢差・縮尺差の吸収用。
    frameOffset: {},
  },
  batter: {
    canvas: [480, 440],
    anchor: [240, 420],
    // 足元の画像px（画面下にはみ出す）。位置は固定で、動くのはミートカーソルだけ。
    // 構え（01）の頭とバットが投手に重ならない位置・大きさ。
    pos: [465, 1028],
    scale: 1.6,
    depthZ: 1.3, // 描画順の基準（判定面より手前）
    frameOffset: {},
  },
  lamp: {
    anchor: [210, 0], // intact / broken 共通アンカー（コードの吊り元）
    pos: [853, 14],
    scale: 0.45,
    frameOffset: { lamp_intact: [0, 0], lamp_broken: [0, 0] },
  },
  vase: {
    intactAnchor: [128, 327],
    brokenAnchor: [290, 215],
    pos: [215, 346],
    scale: 0.25,
    brokenScale: 0.2,
  },
};

// アニメーションのタイムライン（秒）
export const PITCHER_ANIM = {
  windup: [0.16, 0.14, 0.14, 0.16, 0.14, 0.12, 0.1], // 01〜07。08がリリース
  release: 0.1, // 08 表示時間（リリース瞬間＝08の開始）
  follow: [0.14, 0.16, 0.25, 0.3], // 09〜12
};

// 打者: 05,06 で引き、07 でインパクト。06→07 の差が大きいので 06 を短めにする。
export const BATTER_ANIM = [
  { frame: 5, dur: 0.07 },
  { frame: 6, dur: 0.07 },
  { frame: 7, dur: 0.06 }, // impactDelay(0.16) はこの区間内
  { frame: 8, dur: 0.06 },
  { frame: 9, dur: 0.08 },
  { frame: 10, dur: 0.12 },
  { frame: 11, dur: 0.14 },
  { frame: 12, dur: 0.3 },
];
export const BATTER_IDLE_FRAME = 1;

export const GAME = {
  innings: 3,
  ballsForWalk: 4,
  strikesForOut: 3,
  outsPerHalf: 1,
};
