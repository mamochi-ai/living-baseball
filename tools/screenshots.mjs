// 画面確認用スクリーンショット（Playwright + Chromium）。
// 使い方: python3 -m http.server 8080 を起動した状態で  node tools/screenshots.mjs [出力先]
import { createRequire } from 'node:module';
import fs from 'node:fs';

// グローバルに入っている Playwright も使えるよう require で読み込む
const { chromium } = createRequire(import.meta.url)('playwright');

const out = process.argv[2] ?? 'screenshots';
const base = process.env.BASE_URL ?? 'http://localhost:8080/';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(base);
await page.waitForFunction(() => globalThis.__lrb?.app.phase === 'title');
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const wait = (ms) => page.waitForTimeout(ms);

await shot('01_title');
await page.click('#btn-versus');
await shot('02_handoff_pitcher');
await page.click('#btn-handoff');
await wait(200);
await shot('03_pitch_edit');
await page.click('#btn-try');
await wait(1300);
await shot('04_pitch_try');
await page.click('#btn-confirm');
await shot('05_handoff_batter');
await page.click('#btn-handoff');
await wait(100);
await shot('06_ready');
await page.click('#btn-ready');
await wait(2100);
await shot('07_windup');
await wait(1100);
await shot('08_pitch_flight');
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'result', null, { timeout: 8000 });
await wait(300);
await shot('09_result');

// 練習: 投球の到達に合わせて芯で打つ
await page.evaluate(() => globalThis.__lrb.startPractice());
await wait(200);
await shot('10_practice_ready');
await page.click('#btn-ready');
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'pitching');
await page.evaluate(() => {
  const { app, pressSwing } = globalThis.__lrb;
  const c = app.cur;
  const tHit = c.path.duration - 0.16;
  const p = c.path.posAt(c.path.duration);
  app.cursor = [p[0], p[1] - 0.03];
  const wait = (c.releaseAt + tHit) * 1000 - performance.now();
  setTimeout(pressSwing, wait);
});
await page.waitForFunction(() => globalThis.__lrb.app.cur?.swingAt, null, { timeout: 8000 });
await wait(170);
await shot('11_impact');
await wait(250);
await shot('12_batted');
await page.waitForFunction(() => globalThis.__lrb.app.phase === 'result', null, { timeout: 8000 });
await wait(200);
await shot('13_batted_result');

await page.evaluate(() => globalThis.__lrb.setPhase('zones'));
await wait(200);
await shot('14_zone_editor');

// 縦長・リサイズ確認
await page.setViewportSize({ width: 1366, height: 1024 });
await page.evaluate(() => globalThis.__lrb.startPractice());
await wait(200);
await shot('15_ipad_pro');

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
