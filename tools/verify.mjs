// ブラウザ上での動作確認（Playwright + Chromium）。
// 使い方: python3 -m http.server 8080 を起動した状態で  node tools/verify.mjs [スクリーンショット出力先]
import { createRequire } from 'node:module';
import fs from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] ?? 'screenshots';
const base = process.env.BASE_URL ?? 'http://localhost:8080/';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.waitForFunction(() => globalThis.__lrb?.app.phase === 'title');
const wait = (ms) => page.waitForTimeout(ms);
const phase = () => page.evaluate(() => globalThis.__lrb.app.phase);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- 受け渡しで投球設定が見えない
await page.click('#btn-versus');
await page.click('#btn-handoff');
await wait(100);
// ---- 投球編集: 制御点ドラッグとフリーハンド
{
  const top = await page.locator('#ed-top').boundingBox();
  const side = await page.locator('#ed-side').boundingBox();
  const before = await page.evaluate(() => structuredClone(globalThis.__lrb.app.pitches[1]));
  // 点モード: 横から見た図の3番目の点を下へ
  const g = (box, s, frac) => [box.x + 34 + (s / 1.08) * (box.width - 48), box.y + 18 + frac * (box.height - 36)];
  let [x, y] = g(side, 0.5, 0.2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  [x, y] = g(side, 0.5, 0.75);
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up();
  const afterPoint = await page.evaluate(() => structuredClone(globalThis.__lrb.app.pitches[1]));
  check('制御点を指で動かせる', afterPoint.ys[2] < before.ys[2], `${before.ys[2].toFixed(2)} → ${afterPoint.ys[2].toFixed(2)}`);
  // フリーハンド: 上から見た図に大きく蛇行する線を描く（上限で抑えられる）
  await page.click('#mode-free');
  [x, y] = g(top, 0.02, 0.5);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    const s = 0.02 + (i / 40) * 1.0;
    [x, y] = g(top, s, i % 2 ? 0.0 : 1.0);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  const free = await page.evaluate(async () => {
    const { PITCH_LIMITS } = await import('./src/config.js');
    const p = globalThis.__lrb.app.pitches[1];
    const steps = p.xs.slice(1).map((v, i) => Math.abs(v - p.xs[i]));
    return { xs: p.xs, maxStep: Math.max(...steps), limit: PITCH_LIMITS.maxStep, range: PITCH_LIMITS.xRange };
  });
  check(
    'フリーハンド入力でも曲がり・範囲の上限内に収まる',
    free.maxStep <= free.limit + 1e-9 && free.xs.every((v) => v >= free.range[0] - 1e-9 && v <= free.range[1] + 1e-9),
    free.xs.map((v) => v.toFixed(2)).join(','),
  );
  // 球速: バーを指でなぞって変えられる（つまみ以外から触り始めてもよい）
  {
    const cdpS = await ctx.newCDPSession(page);
    const bar = await page.locator('#speed').boundingBox();
    const y0 = bar.y + bar.height / 2;
    const speeds = [];
    await cdpS.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bar.x + 4, y: y0, id: 9 }] });
    speeds.push(await page.evaluate(() => globalThis.__lrb.app.pitches[1].speed));
    for (let i = 1; i <= 10; i++) {
      await cdpS.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bar.x + 4 + (i / 10) * (bar.width - 8), y: y0, id: 9 }] });
    }
    speeds.push(await page.evaluate(() => globalThis.__lrb.app.pitches[1].speed));
    await cdpS.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('球速スライダーを指でなぞって変えられる', speeds[0] === 1 && speeds[1] === 10, speeds.join(' → '));
  }
  await page.click('#btn-try');
  await wait(1250);
  await page.screenshot({ path: `${out}/v00_pitch_edit_try.png` });
}
await page.click('#btn-confirm');
{
  const vis = await page.evaluate(() => ({
    panel: !document.getElementById('pitch-panel').classList.contains('hidden'),
    handoff: !document.getElementById('screen-handoff').classList.contains('hidden'),
    bg: getComputedStyle(document.getElementById('screen-handoff')).backgroundImage,
  }));
  check('受け渡し中は投球設定パネルが非表示で、画面は不透明な受け渡し画面', !vis.panel && vis.handoff && vis.bg.includes('gradient'));
  await page.screenshot({ path: `${out}/v01_handoff.png` });
}
await page.click('#btn-handoff');
await wait(100);
{
  // 打者準備画面で予告線が描かれていないこと: 準備画面のピクセルと、予告線なしで描いた画面を比較する代わりに状態を確認
  const st = await page.evaluate(() => ({ phase: globalThis.__lrb.app.phase, preview: globalThis.__lrb.app.preview }));
  check('打者準備画面では予告線・終点を出さない（編集画面以外では軌道を描かない）', st.phase === 'ready' && st.preview === null);
}

// ---- マルチタッチ: 左手でカーソルを動かしながら右手で打つ
const cdp = await ctx.newCDPSession(page);
const stick = await page.locator('#stick').boundingBox();
const swing = await page.locator('#btn-swing').boundingBox();
const sx = stick.x + stick.width / 2;
const sy = stick.y + stick.height / 2;
const bx = swing.x + swing.width / 2;
const by = swing.y + swing.height / 2;
const before = await page.evaluate(() => [...globalThis.__lrb.app.cursor]);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
for (let i = 1; i <= 5; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + i * 8, y: sy - i * 4, id: 1 }] });
}
const mid = await page.evaluate(() => [...globalThis.__lrb.app.cursor]);
check('左手のドラッグでミートカーソルが動く', mid[0] > before[0] && mid[1] > before[1], `${before.map((n) => n.toFixed(2))} → ${mid.map((n) => n.toFixed(2))}`);

await page.click('#btn-ready');
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'pitching');
await page.waitForFunction(() => performance.now() / 1000 > globalThis.__lrb.app.cur.releaseAt + 0.1);
// 指1を押したまま、指2で「打つ」を連打。さらに指1を動かす
const logBefore = await page.evaluate(() => globalThis.__lrb.app.game.log.length);
for (let k = 0; k < 4; k++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx + 40, y: sy - 20, id: 1 }, { x: bx, y: by, id: 2 + k }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + 30, y: sy - 10, id: 1 }, { x: bx, y: by, id: 2 + k }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: sx + 30, y: sy - 10, id: 1 }] });
}
const sw = await page.evaluate(() => {
  const c = globalThis.__lrb.app.cur;
  return { swung: !!c.swingAt, swing: c.run.swing && { press: c.run.swing.press } };
});
const cur2 = await page.evaluate(() => [...globalThis.__lrb.app.cursor]);
check('マルチタッチ: カーソル操作中でも「打つ」が効き、カーソル操作も継続', sw.swung && cur2[0] !== mid[0], JSON.stringify(sw));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

// ---- 投球中のリサイズ
await page.setViewportSize({ width: 1024, height: 700 });
await wait(80);
await page.setViewportSize({ width: 1180, height: 820 });
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'result', null, { timeout: 8000 });
const after = await page.evaluate(() => globalThis.__lrb.app.game.log.length);
check('連打しても1投球の結果は1回だけ記録', after - logBefore === 1, `log +${after - logBefore}`);
// 同じ投球・同じスイング時刻・同じカーソルで再計算しても結果が一致する（リサイズや描画に依存しない）
const same = await page.evaluate(async () => {
  const { PitchRun } = await import('./src/pitchRun.js');
  const c = globalThis.__lrb.app.cur;
  const r = new PitchRun(c.path, globalThis.__lrb.app.zones);
  r.pressSwing(c.run.swing.press);
  const cur = c.run.swing.contact ? [c.run.swing.contact.point[0] - c.run.swing.contact.offset[0], c.run.swing.contact.point[1] - c.run.swing.contact.offset[1]] : [9, 9];
  for (let t = 0; t < 10 && !r.resolved; t += 1 / 60) r.update(t, cur);
  return { a: c.run.outcome.type, b: r.outcome.type };
});
check('投球中にリサイズしても判定は描画と無関係に同じ', same.a === same.b, JSON.stringify(same));
await page.screenshot({ path: `${out}/v02_result.png` });

// ---- 電球: 投球が電球に先に当たるとボール＆破損演出
await page.evaluate(async () => {
  const { app, setPhase } = globalThis.__lrb;
  const { releasePoint, constrainPitch } = await import('./src/pitch.js');
  const r = releasePoint();
  app.pendingPitch = constrainPitch({ speed: 1, xs: [r[0], r[0] + 0.05, r[0] + 0.1, 0, -0.1], ys: [r[1], 1.1, 1.6, 1.6, 1.6] });
  setPhase('ready');
});
await page.click('#btn-ready');
await page.waitForFunction(() => globalThis.__lrb.app.lamp.broken, null, { timeout: 8000 });
await wait(700);
await page.screenshot({ path: `${out}/v03_lamp_kora.png` });
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'result', null, { timeout: 8000 });
const lampRes = await page.evaluate(() => globalThis.__lrb.app.cur.run.outcome);
check('投球が先に電球に当たったら1ボール（打者アウトではない）', lampRes.type === 'ball' && lampRes.obstacle.id === 'lamp');

// ---- 打球が電球に当たる → アウト、テレビ → 揺れ
async function battedTo(id) {
  return page.evaluate(async (id) => {
    const { buildPitchPath, releasePoint, constrainPitch } = await import('./src/pitch.js');
    const { computeContact } = await import('./src/batting.js');
    const { simulateBattedBall } = await import('./src/physics.js');
    const { SWING } = await import('./src/config.js');
    const { app } = globalThis.__lrb;
    const r = releasePoint();
    const pitch = constrainPitch({ speed: 4, xs: [r[0], -0.18, -0.15, -0.12, -0.1], ys: [r[1], 0.5, 0.4, 0.33, 0.28] });
    const path = buildPitchPath(pitch);
    for (let dt = -0.12; dt <= 0.12; dt += 0.01)
      for (let dx = -0.12; dx <= 0.12; dx += 0.012)
        for (let dy = -0.12; dy <= 0.12; dy += 0.012) {
          const ti = path.duration + dt;
          const b = path.posAt(ti);
          const cur = [b[0] - dx, b[1] - dy];
          const c = computeContact(path, ti, cur);
          if (!c) continue;
          const s = simulateBattedBall(c.point, c.velocity, app.zones);
          if (s.hit.id === id) return { pitch, press: ti - SWING.impactDelay, cursor: cur };
        }
    return null;
  }, id);
}
async function playBatted(id, shotName) {
  const plan = await battedTo(id);
  if (!plan) return check(`打球「${id}」を再現`, false, '打ち方が見つからない');
  await page.evaluate((plan) => {
    const { app, setPhase } = globalThis.__lrb;
    app.pendingPitch = plan.pitch;
    app.cursor = plan.cursor;
    setPhase('ready');
  }, plan);
  await page.click('#btn-ready');
  await page.waitForFunction(() => globalThis.__lrb.app.phase === 'pitching');
  // 押下時刻はフレーム単位でずれるため、ここでは計画どおりの時刻で直接スイングを登録する
  // （画面のボタン入力そのものはマルチタッチの確認で別に検証している）
  await page.evaluate((plan) => {
    const { app } = globalThis.__lrb;
    const c = app.cur;
    c.run.pressSwing(plan.press);
    c.swingAt = c.releaseAt + plan.press;
    c.swingCursor = plan.cursor;
    app.cursor = plan.cursor;
  }, plan);
  await page.waitForFunction((id) => globalThis.__lrb.app.cur?.fired.has(id), id, { timeout: 8000 }).catch(() => {});
  await wait(id === 'lamp' ? 700 : 120);
  await page.screenshot({ path: `${out}/${shotName}.png` });
  await page.waitForFunction(() => globalThis.__lrb.app.phase === 'result', null, { timeout: 8000 });
  return page.evaluate(() => globalThis.__lrb.app.cur.run.outcome);
}
await page.evaluate(() => globalThis.__lrb.setPhase('ready'));
for (const [id, expect] of [
  ['lamp', 'out'],
  ['tv', 'out'],
  ['pitcher', 'out'],
  ['between_curtains', 'hit'],
  ['right_door', 'hit'],
  ['calendar', 'hit'],
  ['rear_left_cabinet_top', 'hit'],
]) {
  const o = await playBatted(id, `v04_batted_${id}`);
  if (o) check(`実画面で打球が「${id}」に当たり ${expect}`, o.type === expect && o.hit.id === id, `${o.type} / ${o.hit?.id}`);
}

// ---- 再戦で全状態初期化
await page.evaluate(() => {
  const { app } = globalThis.__lrb;
  app.game = { ...app.game, over: true };
  globalThis.__lrb.setPhase('gameover');
});
await page.click('#btn-rematch');
const reset = await page.evaluate(async () => {
  const { newGame } = await import('./src/rules.js');
  const { app } = globalThis.__lrb;
  const g = newGame(app.game.innings);
  return JSON.stringify(app.game) === JSON.stringify(g) && app.pitches.every((p) => p === null) && !app.lamp.broken && !app.vaseBroken;
});
check('再戦で試合・投球・破損状態がすべて初期化', reset);

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
process.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1);
