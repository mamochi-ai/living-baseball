// 画面遷移と試合進行。
// 投球編集 → 端末受け渡し → 打者準備 → カウントダウン → 投球 → 打撃／見送り → 結果 → 次の投球 or 交代
import { PITCHER_ANIM, BATTER_ANIM, BATTER_IDLE_FRAME, PLATE, CAMERA, SWING, GAME, PITCH_LIMITS } from './config.js';
import { loadAssets } from './assets.js';
import { Renderer } from './render.js';
import { buildPitchPath, defaultPitch, constrainPitch, releasePoint } from './pitch.js';
import { PitchRun } from './pitchRun.js';
import { clampCursor } from './batting.js';
import { newGame, applyPitchResult, offense, defense, winner } from './rules.js';
import { normalizeZones, loadSavedZones, saveZones, clearSavedZones } from './zones.js';
import { PitchEditor } from './pitchEditor.js';
import { ZoneEditor } from './zoneEditor.js';
import { initAudio, setMuted, isMuted, sfx } from './audio.js';
import { project } from './projection.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.now() / 1000;
const show = (el, on = true) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);

const WINDUP_TOTAL = PITCHER_ANIM.windup.reduce((a, b) => a + b, 0);
const SETTINGS_KEY = 'lrb.settings.v1';
const PLAYER = ['1P', '2P'];

// ---------------------------------------------------------------- 状態
const app = {
  phase: 'loading',
  mode: 'versus', // 'versus' | 'practice'
  settings: { innings: GAME.innings, mute: false, practiceZones: true },
  zones: null,
  initialZones: null,
  game: newGame(),
  pitches: [null, null], // 各プレイヤーが最後に作った球（自分だけが見る）
  cursor: [-0.1, 0.28],
  cur: null, // 進行中の投球 { path, run, windupStart, releaseAt, swingAt, fired:Set, resultShown }
  preview: null, // 試し投げ { path, windupStart, releaseAt }
  lamp: { broken: false, at: 0 },
  vaseBroken: false,
  shakeUntil: 0,
  countdownAt: 0,
};

let renderer;
let pitchEditor;
let zoneEditor;
let images;

// ---------------------------------------------------------------- 起動
async function boot() {
  loadSettings();
  setMuted(app.settings.mute);
  try {
    const res = await fetch('zones.initial.json');
    app.initialZones = normalizeZones(await res.json());
  } catch (e) {
    $('loading-text').textContent = 'zones.initial.json を読み込めません';
    throw e;
  }
  app.zones = loadSavedZones() ?? app.initialZones;
  images = await loadAssets((d, n) => ($('loading-text').textContent = `読み込み中… ${d}/${n}`));
  renderer = new Renderer($('game'), images);
  pitchEditor = new PitchEditor({
    topCanvas: $('ed-top'),
    sideCanvas: $('ed-side'),
    lamp: lampSideMarker(),
    onChange: (p) => {
      app.pitches[defense(app.game)] = p;
      app.preview = null;
      updateSpeedLabel();
    },
  });
  zoneEditor = new ZoneEditor($('zone-canvas'), images.background);
  bindUi();
  setPhase('title');
  requestAnimationFrame(frame);
}

function loadSettings() {
  try {
    Object.assign(app.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch {
    /* 既定値のまま */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
  } catch {
    /* 保存できなくても遊べる */
  }
}

/** 横から見た編集画面に出す電球の位置（進行度 s と高さ） */
function lampSideMarker() {
  const l = app.zones.lamp;
  const r = releasePoint();
  const s = (r[2] - l.depthZ) / (r[2] - PLATE.z);
  const top = (l.center[1] - l.radius[1]) * 1024;
  const bot = (l.center[1] + l.radius[1]) * 1024;
  const yAt = (py) => CAMERA.eyeY - ((py - CAMERA.cy) * l.depthZ) / CAMERA.f;
  return { s, y0: yAt(bot), y1: yAt(top) };
}

// ---------------------------------------------------------------- 画面遷移
const SCREENS = [
  'screen-loading',
  'screen-title',
  'screen-howto',
  'screen-settings',
  'screen-handoff',
  'screen-ready',
  'screen-result',
  'screen-menu',
  'screen-gameover',
  'screen-zones',
  'pitch-panel',
  'bat-controls',
  'hud',
  'countdown',
];

function setPhase(phase, opts = {}) {
  app.phase = phase;
  for (const id of SCREENS) show(id, false);
  document.body.classList.toggle('editing', phase === 'pitchEdit');
  if (phase !== 'result' && phase !== 'pitching') hideBanner();
  const inGame = ['pitchEdit', 'ready', 'countdown', 'pitching', 'result'].includes(phase);
  show('hud', inGame);
  show('btn-menu', inGame && phase !== 'countdown' && phase !== 'pitching');
  show('bases-row', app.mode === 'versus');
  switch (phase) {
    case 'title':
      show('screen-title');
      break;
    case 'howto':
      show('screen-howto');
      break;
    case 'settings':
      $('set-innings').value = String(app.settings.innings);
      $('set-mute').checked = app.settings.mute;
      $('set-practice-zones').checked = app.settings.practiceZones;
      show('screen-settings');
      break;
    case 'handoff':
      $('handoff-msg').textContent = opts.msg;
      $('handoff-sub').textContent = opts.sub ?? '';
      app.handoffNext = opts.next;
      show('screen-handoff');
      break;
    case 'pitchEdit': {
      resetBreakables();
      const pl = defense(app.game);
      $('pitch-title').textContent = `${PLAYER[pl]}（投手）の球をつくる`;
      app.pitches[pl] ??= defaultPitch();
      pitchEditor.setLamp(lampSideMarker());
      show('pitch-panel');
      pitchEditor.setPitch(app.pitches[pl]);
      $('speed').value = String(app.pitches[pl].speed);
      updateSpeedLabel();
      app.preview = null;
      break;
    }
    case 'ready':
      if (app.mode === 'practice') resetBreakables();
      $('ready-msg').textContent =
        app.mode === 'versus'
          ? `${PLAYER[offense(app.game)]}（打者）: 左手でカーソル、右手で「打つ」`
          : '打撃練習: 左手でカーソル、右手で「打つ」';
      show('screen-ready');
      show('bat-controls');
      $('btn-swing').classList.remove('used');
      app.cur = null;
      break;
    case 'countdown':
      show('bat-controls');
      show('countdown');
      app.countdownAt = now();
      app.lastCount = null;
      break;
    case 'pitching':
      show('bat-controls');
      break;
    case 'result':
      show('screen-result');
      show('bat-controls', false);
      $('btn-next').disabled = true;
      setTimeout(() => ($('btn-next').disabled = false), 700);
      break;
    case 'menu':
      $('btn-mute-toggle').textContent = `音: ${isMuted() ? 'オフ' : 'オン'}`;
      show('hud');
      show('screen-menu');
      break;
    case 'gameover': {
      show('screen-gameover');
      const g = app.game;
      $('final-score').textContent = `1P ${g.score[0]} - ${g.score[1]} 2P`;
      const w = winner(g);
      $('final-winner').textContent = w === 'draw' ? '引き分け！' : `${PLAYER[w]} の勝ち！`;
      break;
    }
    case 'zones':
      show('screen-zones');
      show('z-json', false);
      $('z-status').textContent = '';
      zoneEditor.open(app.zones);
      break;
  }
  updateHud();
}

function resetBreakables() {
  app.lamp = { broken: false, at: 0 };
  app.vaseBroken = false;
}

// ---------------------------------------------------------------- 試合の流れ
function startVersus() {
  app.mode = 'versus';
  app.game = newGame(Number(app.settings.innings));
  app.pitches = [null, null];
  app.cur = null;
  app.preview = null;
  resetBreakables();
  app.cursor = [-0.1, 0.28];
  handoffToPitcher('プレイボール！');
}

function startPractice() {
  app.mode = 'practice';
  app.game = newGame(1);
  app.cur = null;
  resetBreakables();
  app.cursor = [-0.1, 0.28];
  setPhase('ready');
}

function handoffToPitcher(prefix = '') {
  const pl = defense(app.game);
  setPhase('handoff', {
    msg: `${prefix ? prefix + '\n' : ''}${PLAYER[pl]}（投手）に渡してください`,
    sub: `次の打者は ${PLAYER[offense(app.game)]}。打者は画面を見ないでね`,
    next: () => setPhase('pitchEdit'),
  });
}

function confirmPitch() {
  const pl = defense(app.game);
  app.pitches[pl] = constrainPitch(pitchEditor.pitch);
  app.pendingPitch = app.pitches[pl];
  app.preview = null;
  setPhase('handoff', {
    msg: `${PLAYER[offense(app.game)]}（打者）に渡してください`,
    sub: '投球の設定は見えません',
    next: () => setPhase('ready'),
  });
}

function startPitch() {
  const pitch = app.mode === 'versus' ? app.pendingPitch : machinePitch();
  const path = buildPitchPath(pitch);
  const t = now();
  app.cur = {
    path,
    run: new PitchRun(path, app.zones),
    windupStart: t,
    releaseAt: t + WINDUP_TOTAL,
    swingAt: null,
    fired: new Set(),
    resultShown: false,
  };
  setPhase('pitching');
}

/** 練習用のピッチングマシン（球種の選択だけ乱数。打球の結果には乱数を使わない） */
function machinePitch() {
  const r = releasePoint();
  const cx = (PLATE.zoneX[0] + PLATE.zoneX[1]) / 2;
  const kinds = [
    { speed: 4, tx: cx, ty: 0.37, bx: 0, by: 0 },
    { speed: 7, tx: cx + 0.08, ty: 0.3, bx: 0, by: 0 },
    { speed: 5, tx: cx + 0.15, ty: 0.35, bx: -0.25, by: 0 },
    { speed: 5, tx: cx - 0.1, ty: 0.2, bx: 0, by: 0.3 },
    { speed: 2, tx: cx, ty: 0.45, bx: 0.1, by: 0.2 },
    { speed: 6, tx: cx + 0.45, ty: 0.4, bx: 0, by: 0 },
  ];
  const k = kinds[Math.floor(Math.random() * kinds.length)];
  const xs = [];
  const ys = [];
  for (let i = 0; i < PITCH_LIMITS.points; i++) {
    const s = i / (PITCH_LIMITS.points - 1);
    const bump = Math.sin(Math.PI * s);
    xs.push(r[0] + (k.tx - r[0]) * s + k.bx * bump);
    ys.push(r[1] + (k.ty - r[1]) * s + k.by * bump);
  }
  return constrainPitch({ speed: k.speed, xs, ys });
}

function pressSwing() {
  if (app.phase !== 'pitching' || !app.cur) return;
  const t = now() - app.cur.releaseAt;
  if (app.cur.run.pressSwing(t)) {
    app.cur.swingAt = now();
    $('btn-swing').classList.add('used');
    sfx.swing();
  }
}

const OUT_TEXT = {
  pitcher: 'ピッチャーが捕った',
  lamp: '電球に当たった',
  floor: '床に落ちた',
  ceiling: '天井に当たった',
  backWall: '奥の壁に当たった',
  leftWall: '左の壁に当たった',
  rightWall: '右の壁に当たった',
  behind: 'うしろへ飛んだ',
  tv: 'テレビに当たった',
  vase: '花瓶に当たった',
  timeout: '失速した',
};

function finishPitch() {
  const run = app.cur.run;
  const o = run.outcome;
  const before = app.game;
  let main = '';
  let sub = '';
  if (o.type === 'hit') {
    main = 'セーフ！ヒット';
    sub = o.hit.label;
  } else if (o.type === 'out') {
    main = 'アウト！';
    sub = OUT_TEXT[o.hit.id] ?? o.hit.label;
  } else if (o.type === 'strike') {
    main = o.reason === 'swingMiss' ? '空振り！ストライク' : 'ストライク！';
  } else {
    main = 'ボール';
    if (o.reason === 'pitchObstacle') sub = o.obstacle.id === 'lamp' ? '投球が電球に当たった' : '投球が床に当たった';
  }
  if (app.mode === 'versus') {
    app.game = applyPitchResult(before, o.type);
    const last = app.game.log[app.game.log.length - 1];
    if (last?.how === 'strikeout') main = '三振！アウト';
    if (last?.how === 'walk') main = 'フォアボール！';
    if (last?.runs) sub += `${sub ? '\n' : ''}${last.runs}点！`;
    if (app.game.changed && !app.game.over) sub += `${sub ? '\n' : ''}チェンジ`;
  }
  if (o.type === 'hit') sfx.safe();
  else if (o.type === 'out') sfx.out();
  else if (o.type === 'strike') sfx.strike();
  else sfx.ball();
  if (!(app.cur.fired.has('lamp') && performance.now() - app.koraShownAt < 800)) showBanner(main, sub);
  else setTimeout(() => app.phase === 'result' && showBanner(main, sub), 900);
  setPhase('result');
}

function nextAfterResult() {
  if (app.phase !== 'result') return;
  sfx.tap();
  if (app.mode === 'practice') return setPhase('ready');
  if (app.game.over) return setPhase('gameover');
  handoffToPitcher(app.game.changed ? '攻守交代！' : '');
}

// ---------------------------------------------------------------- 演出
let bannerTimer = null;
function showBanner(text, sub = '', cls = '', ms = 0) {
  const b = $('banner');
  b.className = cls;
  b.innerHTML = '';
  b.append(document.createTextNode(text));
  if (sub) {
    const s = document.createElement('span');
    s.className = 'small';
    s.textContent = sub;
    b.append(s);
  }
  // アニメーションをやり直す
  void b.offsetWidth;
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(hideBanner, ms);
}

function hideBanner() {
  clearTimeout(bannerTimer);
  show('banner', false);
}

function breakLamp() {
  if (app.lamp.broken) return;
  app.lamp = { broken: true, at: now() };
  sfx.glass();
  showBanner('パリン！', '', '', 0);
  setTimeout(() => {
    if (['pitching', 'result'].includes(app.phase)) {
      showBanner('こらー！', '', 'kora', 900);
      app.koraShownAt = performance.now();
    }
  }, 550);
}

/** 球が実際に当たった時刻に、効果音や破損を出す（判定は既に確定している） */
function fireEffects(t) {
  const c = app.cur;
  const run = c.run;
  const once = (key, fn) => {
    if (!c.fired.has(key)) {
      c.fired.add(key);
      fn();
    }
  };
  if (run.batted) {
    if (t >= run.batted.start) once('contact', () => sfx.hit());
    const ht = run.batted.start + run.batted.hit.time;
    if (t >= ht) {
      const id = run.batted.hit.id;
      once(id, () => {
        if (id === 'lamp') breakLamp();
        else if (id === 'tv') {
          app.shakeUntil = now() + 0.45;
          sfx.thud();
        } else if (id === 'vase') {
          app.vaseBroken = true;
          sfx.glass();
        } else if (id === 'pitcher') sfx.bounce();
        else if (run.batted.hit.result === 'out') sfx.bounce();
      });
    }
  } else if (run.outcome?.reason === 'pitchObstacle' && t >= run.outcome.time) {
    once('pitchObstacle', () => (run.outcome.obstacle.id === 'lamp' ? breakLamp() : sfx.bounce()));
  }
}

// ---------------------------------------------------------------- 球の位置（描画用）
function ballPosAt(c, t) {
  const run = c.run;
  if (t < 0) return null;
  if (run.batted && t >= run.batted.start) {
    const tb = t - run.batted.start;
    const pts = run.batted.path;
    if (tb <= run.batted.hit.time) return samplePath(pts, tb);
    const bo = run.batted.bounce;
    if (!bo.length || tb > bo[bo.length - 1].t) return null;
    return samplePath(bo, tb);
  }
  if (run.outcome?.reason === 'pitchObstacle' && t >= run.outcome.time) {
    const ob = run.outcome.obstacle;
    const dt = t - ob.time;
    if (dt > 0.6) return null;
    // 投球の勢いで少しだけ跳ねる見た目
    const a = c.path.posAt(ob.time - 0.02);
    const v = ob.point.map((x, i) => (x - a[i]) / 0.02);
    const vy = ob.id === 'floor' ? -v[1] * 0.5 : v[1] * 0.3;
    return [ob.point[0] + v[0] * 0.4 * dt, Math.max(0.02, ob.point[1] + vy * dt - 4.9 * dt * dt), ob.point[2] + v[2] * 0.4 * dt];
  }
  if (t <= c.path.endTime) return c.path.posAt(t);
  return null;
}

function samplePath(pts, t) {
  // pts は時刻順。二分探索して線形補間
  let lo = 0;
  let hi = pts.length - 1;
  if (t <= pts[0].t) return pts[0].p;
  if (t >= pts[hi].t) return pts[hi].p;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].t <= t) lo = m;
    else hi = m;
  }
  const a = pts[lo];
  const b = pts[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  return a.p.map((x, i) => x + (b.p[i] - x) * k);
}

function ballWithTrail(c, t) {
  const pos = ballPosAt(c, t);
  if (!pos) return null;
  const trail = [];
  for (let k = 5; k >= 1; k--) {
    const p = ballPosAt(c, t - k * 0.018);
    if (p) trail.push(p);
  }
  return { pos, trail };
}

// ---------------------------------------------------------------- アニメーション
function pitcherFrameAt(tRel) {
  // tRel: リリースからの秒（負は振りかぶり中）
  if (tRel === null) return 1;
  if (tRel < 0) {
    let acc = -WINDUP_TOTAL;
    for (let i = 0; i < PITCHER_ANIM.windup.length; i++) {
      acc += PITCHER_ANIM.windup[i];
      if (tRel < acc) return i + 1;
    }
    return 7;
  }
  if (tRel < PITCHER_ANIM.release) return 8;
  let acc = PITCHER_ANIM.release;
  for (let i = 0; i < PITCHER_ANIM.follow.length; i++) {
    acc += PITCHER_ANIM.follow[i];
    if (tRel < acc) return 9 + i;
  }
  return 12;
}

function batterFrameAt(swingAt, t) {
  if (swingAt === null) return BATTER_IDLE_FRAME;
  let acc = 0;
  const dt = t - swingAt;
  for (const step of BATTER_ANIM) {
    acc += step.dur;
    if (dt < acc) return step.frame;
  }
  return BATTER_ANIM[BATTER_ANIM.length - 1].frame;
}

// ---------------------------------------------------------------- 毎フレーム
const keys = new Set();

function frame() {
  requestAnimationFrame(frame);
  if (!renderer || app.phase === 'zones') return;
  const t = now();

  // キーボード（PCでの確認用）
  if (keys.size && ['ready', 'countdown', 'pitching'].includes(app.phase)) {
    const d = 0.012;
    let [x, y] = app.cursor;
    if (keys.has('ArrowLeft') || keys.has('a')) x -= d;
    if (keys.has('ArrowRight') || keys.has('d')) x += d;
    if (keys.has('ArrowUp') || keys.has('w')) y += d;
    if (keys.has('ArrowDown') || keys.has('s')) y -= d;
    app.cursor = clampCursor([x, y]);
  }

  let pitcherFrame = 1;
  let batterFrame = BATTER_IDLE_FRAME;
  let ball = null;
  let previewPath = null;

  if (app.phase === 'countdown') {
    const n = 3 - Math.floor((t - app.countdownAt) / 0.6);
    if (n !== app.lastCount) {
      app.lastCount = n;
      if (n >= 1) {
        $('countdown').textContent = String(n);
        sfx.count(false);
      }
    }
    if (n <= 0) {
      sfx.count(true);
      startPitch();
    }
  }

  if (app.cur && ['pitching', 'result'].includes(app.phase)) {
    const c = app.cur;
    const tp = t - c.releaseAt;
    pitcherFrame = pitcherFrameAt(tp);
    batterFrame = batterFrameAt(c.swingAt, t);
    if (tp >= 0 && !c.fired.has('throw')) {
      c.fired.add('throw');
      sfx.throw();
    }
    if (app.phase === 'pitching') {
      c.run.update(Math.max(0, tp), app.cursor);
      fireEffects(tp);
      if (c.run.resolved && tp >= c.run.finishTime() && !c.resultShown) {
        c.resultShown = true;
        finishPitch();
      }
    }
    ball = ballWithTrail(c, tp);
  }

  if (app.phase === 'pitchEdit' && pitchEditor.pitch) {
    const path = buildPitchPath(pitchEditor.pitch);
    previewPath = [];
    for (let i = 0; i <= 40; i++) previewPath.push(path.posAtS((i / 40) * (path.endTime / path.duration)));
    if (app.preview) {
      const tp = t - app.preview.releaseAt;
      pitcherFrame = pitcherFrameAt(tp);
      const fake = { path: app.preview.path, run: { outcome: null, batted: null } };
      ball = ballWithTrail(fake, tp);
      if (tp > app.preview.path.endTime + 0.6) app.preview = null;
    }
  }

  renderer.setInsetRight(app.phase === 'pitchEdit' ? $('pitch-panel').offsetWidth : 0);
  const showZones =
    app.mode === 'practice' && app.settings.practiceZones && ['ready', 'countdown', 'pitching', 'result'].includes(app.phase);
  const inPlay = ['pitchEdit', 'ready', 'countdown', 'pitching', 'result'].includes(app.phase);

  renderer.draw({
    zones: app.zones,
    pitcherFrame,
    batterFrame,
    ball,
    lampBroken: app.lamp.broken,
    lampBrokenAt: app.lamp.at,
    vaseBroken: app.vaseBroken,
    showZones,
    previewPath,
    showStrikeZone: inPlay,
    cursor: ['ready', 'countdown', 'pitching'].includes(app.phase) ? app.cursor : null,
    shake: t < app.shakeUntil ? (app.shakeUntil - t) / 0.45 : 0,
    time: t,
  });
}

// ---------------------------------------------------------------- 表示更新
function updateHud() {
  const g = app.game;
  $('score').textContent = `${g.score[0]} - ${g.score[1]}`;
  $('inning').textContent = app.mode === 'versus' ? `${g.inning}回${g.half === 0 ? '表' : '裏'}` : '練習';
  $('balls').textContent = dots(g.balls, GAME.ballsForWalk - 1);
  $('strikes').textContent = dots(g.strikes, GAME.strikesForOut - 1);
  $('bases').textContent = ['一', '二', '三'].map((n, i) => `${n}${g.bases[i] ? '◆' : '◇'}`).join(' ');
  document.querySelectorAll('#scoreboard .who').forEach((el) => {
    el.classList.toggle('batting', app.mode === 'versus' && Number(el.dataset.p) === offense(g));
  });
}

const dots = (n, max) => '●'.repeat(Math.min(n, max)) + '○'.repeat(Math.max(0, max - n));

function updateSpeedLabel() {
  const p = pitchEditor.pitch;
  if (!p) return;
  const T = buildPitchPath(p).duration;
  $('speed-val').textContent = `${T.toFixed(2)}秒`;
}

// ---------------------------------------------------------------- 入力
function bindUi() {
  // 初回タップで音を有効化
  const unlock = () => initAudio();
  window.addEventListener('pointerdown', unlock, { capture: true });

  // ブラウザのズーム・スクロールを抑える
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!e.target.closest('.howto, textarea')) e.preventDefault();
    },
    { passive: false },
  );

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

  const click = (id, fn) =>
    $(id).addEventListener('click', () => {
      sfx.tap();
      fn();
    });

  click('btn-versus', startVersus);
  click('btn-practice', startPractice);
  click('btn-howto', () => setPhase('howto'));
  click('btn-settings', () => setPhase('settings'));
  document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => setPhase('title')));

  $('set-innings').addEventListener('change', (e) => {
    app.settings.innings = Number(e.target.value);
    saveSettings();
  });
  $('set-mute').addEventListener('change', (e) => {
    app.settings.mute = e.target.checked;
    setMuted(app.settings.mute);
    saveSettings();
  });
  $('set-practice-zones').addEventListener('change', (e) => {
    app.settings.practiceZones = e.target.checked;
    saveSettings();
  });
  click('btn-zone-editor', () => setPhase('zones'));

  click('btn-handoff', () => app.handoffNext?.());

  // 投球編集
  bindSpeedSlider();
  const setMode = (m) => {
    pitchEditor.setMode(m);
    $('mode-points').classList.toggle('on', m === 'points');
    $('mode-free').classList.toggle('on', m === 'free');
  };
  click('mode-points', () => setMode('points'));
  click('mode-free', () => setMode('free'));
  click('btn-reset', () => {
    const p = defaultPitch();
    pitchEditor.update(p);
    $('speed').value = String(p.speed);
  });
  click('btn-try', () => {
    const t = now();
    app.preview = { path: buildPitchPath(pitchEditor.pitch), windupStart: t, releaseAt: t + WINDUP_TOTAL };
  });
  click('btn-confirm', confirmPitch);

  // 打者
  click('btn-ready', () => setPhase('countdown'));
  bindBatControls();

  click('btn-next', nextAfterResult);

  // メニュー
  let menuReturn = null;
  click('btn-menu', () => {
    menuReturn = app.phase;
    setPhase('menu');
  });
  click('btn-resume', () => setPhase(menuReturn ?? 'title'));
  click('btn-mute-toggle', () => {
    app.settings.mute = !isMuted();
    setMuted(app.settings.mute);
    saveSettings();
    $('btn-mute-toggle').textContent = `音: ${isMuted() ? 'オフ' : 'オン'}`;
  });
  click('btn-quit', () => {
    app.cur = null;
    setPhase('title');
  });
  click('btn-rematch', startVersus);
  click('btn-to-title', () => setPhase('title'));

  bindZoneEditor();

  window.addEventListener('keydown', (e) => {
    keys.add(e.key);
    if (e.key === ' ') {
      e.preventDefault();
      pressSwing();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key));
}

function onResize() {
  renderer.resize();
  if (app.phase === 'pitchEdit') pitchEditor.draw();
  if (app.phase === 'zones') zoneEditor.resize();
}

/** 左手: ミートカーソル（相対ドラッグ）、右手: 打つ。指のIDごとに分けて干渉させない。 */
function bindBatControls() {
  const area = $('stick-area');
  const knob = $('stick-knob');
  let stick = null; // { id, x0, y0, lx, ly }
  area.addEventListener('pointerdown', (e) => {
    if (stick) return;
    e.preventDefault();
    area.setPointerCapture(e.pointerId);
    stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY };
  });
  area.addEventListener('pointermove', (e) => {
    if (!stick || e.pointerId !== stick.id) return;
    e.preventDefault();
    const pxPerM = (CAMERA.f / PLATE.z) * renderer.vp.s;
    const gain = 1.3;
    const dx = (e.clientX - stick.lx) / pxPerM;
    const dy = (e.clientY - stick.ly) / pxPerM;
    stick.lx = e.clientX;
    stick.ly = e.clientY;
    if (['ready', 'countdown', 'pitching'].includes(app.phase)) {
      app.cursor = clampCursor([app.cursor[0] + dx * gain, app.cursor[1] - dy * gain]);
    }
    const ox = Math.max(-55, Math.min(55, e.clientX - stick.x0));
    const oy = Math.max(-55, Math.min(55, e.clientY - stick.y0));
    knob.style.transform = `translate(${ox}px, ${oy}px)`;
  });
  const end = (e) => {
    if (!stick || e.pointerId !== stick.id) return;
    stick = null;
    knob.style.transform = '';
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);

  const btn = $('btn-swing');
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressSwing();
  });
}

/**
 * 球速スライダー。iPad では標準のスライダーがつまみ以外をなぞっても動かないため、
 * バー上のどこを触っても、指でなぞった位置の値になるよう自前で処理する。
 */
function bindSpeedSlider() {
  const input = $('speed');
  const area = input.closest('.speed');
  let id = null;
  const setFromX = (clientX) => {
    const r = input.getBoundingClientRect();
    const min = Number(input.min);
    const max = Number(input.max);
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = Math.round(min + k * (max - min));
    if (v === Number(input.value) && pitchEditor.pitch?.speed === v) return;
    input.value = String(v);
    pitchEditor.update({ ...pitchEditor.pitch, speed: v });
  };
  area.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    area.setPointerCapture(id);
    setFromX(e.clientX);
  });
  area.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    e.preventDefault();
    setFromX(e.clientX);
  });
  const end = (e) => {
    if (e.pointerId === id) id = null;
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  // キーボード操作（PC）は標準のまま
  input.addEventListener('input', () => pitchEditor.update({ ...pitchEditor.pitch, speed: Number(input.value) }));
}

function bindZoneEditor() {
  const status = (m) => ($('z-status').textContent = m);
  $('z-save').addEventListener('click', () => {
    try {
      app.zones = normalizeZones(zoneEditor.zones);
      status(saveZones(app.zones) ? '保存しました' : '保存できません（この端末の保存領域）');
    } catch (e) {
      status(e.message);
    }
  });
  // 確認ダイアログが使えない環境もあるので、2回押しで確定する
  let resetArmed = null;
  $('z-reset').addEventListener('click', () => {
    const btn = $('z-reset');
    if (!resetArmed) {
      btn.textContent = 'もう一度押すと初期化';
      resetArmed = setTimeout(() => {
        resetArmed = null;
        btn.textContent = '初期化';
      }, 3000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    btn.textContent = '初期化';
    clearSavedZones();
    app.zones = app.initialZones;
    zoneEditor.open(app.zones);
    status('初期値に戻しました');
  });
  $('z-export').addEventListener('click', () => {
    const text = JSON.stringify(normalizeZones(zoneEditor.zones), null, 2);
    $('z-text').value = text;
    show('z-json');
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'zones.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      /* ダウンロードできない環境では下のテキストをコピーしてもらう */
    }
    status('書き出しました');
  });
  $('z-import').addEventListener('click', () => {
    $('z-text').value = '';
    show('z-json');
  });
  $('z-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) $('z-text').value = await f.text();
  });
  $('z-apply').addEventListener('click', () => {
    try {
      const z = normalizeZones(JSON.parse($('z-text').value));
      zoneEditor.open(z);
      show('z-json', false);
      status('読み込みました（保存で確定）');
    } catch (e) {
      status(`読み込めません: ${e.message}`);
    }
  });
  $('z-json-close').addEventListener('click', () => show('z-json', false));
  $('z-close').addEventListener('click', () => setPhase('settings'));
}

// テスト・スクリーンショット用の窓口
globalThis.__lrb = { app, setPhase, startVersus, startPractice, pressSwing, confirmPitch, project };

boot().catch((e) => {
  console.error(e);
  $('loading-text').textContent = `エラー: ${e.message}`;
});
