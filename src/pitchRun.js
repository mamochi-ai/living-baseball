// 1投球の進行と判定。結果は1投球につき1回だけ確定する。
// 時刻はリリース=0。描画とは独立しており、テストからも同じ手順で動かせる。
import { SWING, PLATE } from './config.js';
import { tracePitch, simulateBattedBall, isStrike } from './physics.js';
import { computeContact } from './batting.js';

export class PitchRun {
  constructor(path, zones) {
    this.path = path;
    this.zones = zones;
    this.trace = tracePitch(path, zones);
    this.swing = null; // { press, impact, done, contact }
    this.batted = null; // simulateBattedBall の結果 + start
    this.outcome = null; // { type, reason, ... }
    // 見送りの判定を出す時刻: 球が打撃可能な奥行きを過ぎたとき
    const z0 = path.posAtS(0)[2];
    const passS = (z0 - (PLATE.z - SWING.depthWindow)) / (z0 - PLATE.z);
    this.calledTime = path.duration * passS;
  }

  get resolved() {
    return this.outcome !== null;
  }

  /** 打つボタン。1投球で1回だけ受け付ける。 */
  pressSwing(t) {
    if (this.swing || this.resolved) return false;
    this.swing = { press: t, impact: t + SWING.impactDelay, done: false, contact: null };
    return true;
  }

  /** 時刻 t まで進める。cursor はその時点のミートカーソル。 */
  update(t, cursor) {
    if (this.resolved) return this.outcome;
    const obs = this.trace.obstacle;
    const sw = this.swing;

    // 先に起きる出来事から順に処理する
    const events = [];
    if (obs) events.push({ time: obs.time, kind: 'obstacle' });
    if (sw && !sw.done) events.push({ time: sw.impact, kind: 'impact' });
    if (!obs && (!sw || sw.done)) events.push({ time: this.calledTime, kind: 'called' });
    events.sort((a, b) => a.time - b.time);

    for (const e of events) {
      if (e.time > t || this.resolved) break;
      if (e.kind === 'obstacle') {
        this.outcome = {
          type: 'ball',
          reason: 'pitchObstacle',
          obstacle: obs,
          time: obs.time,
        };
      } else if (e.kind === 'impact') {
        sw.done = true;
        const contact = computeContact(this.path, sw.impact, cursor);
        sw.contact = contact;
        if (contact) {
          const sim = simulateBattedBall(contact.point, contact.velocity, this.zones);
          this.batted = { ...sim, start: sw.impact, contact };
          this.outcome = {
            type: sim.hit.result === 'safe' ? 'hit' : 'out',
            reason: 'batted',
            hit: sim.hit,
            time: sw.impact,
            showAt: sw.impact + sim.hit.time,
          };
        } else {
          this.outcome = { type: 'strike', reason: 'swingMiss', time: sw.impact };
        }
      } else if (e.kind === 'called') {
        const pc = this.trace.plateCross;
        const strike = pc ? isStrike(pc.point) : false;
        this.outcome = { type: strike ? 'strike' : 'ball', reason: 'called', plateCross: pc, time: this.calledTime };
      }
    }
    // 見送り判定の前に打撃イベントが後から入った場合（ボタンが遅い）も上のループで処理される
    return this.outcome;
  }

  /** 演出上、球を消して結果を見せてよい時刻 */
  finishTime() {
    if (!this.outcome) return Infinity;
    if (this.outcome.reason === 'batted') return this.outcome.showAt + 0.35;
    if (this.outcome.reason === 'pitchObstacle') return this.outcome.time + 0.5;
    return Math.max(this.outcome.time, this.path.endTime);
  }
}
