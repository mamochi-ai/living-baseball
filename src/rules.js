// 簡易得点ルール（純粋関数）。
// - ヒットと四球: 打者が一塁へ、既存走者は全員1つ進む。ホーム到達で1点。カウントはリセット。
// - 3ストライク（三振）または打球アウトで1アウト → 走者・カウントをリセットして攻守交代。
// - 4ボールで出塁し攻撃続行。
// - 標準3回。各回とも両者が1アウトずつ攻撃し、最終回も両者の攻撃を終えてから比較。同点は引き分け。
import { GAME } from './config.js';

export function newGame(innings = GAME.innings) {
  return {
    innings,
    inning: 1,
    half: 0, // 0=表（1Pの攻撃） 1=裏（2Pの攻撃）
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [false, false, false],
    score: [0, 0],
    over: false,
    log: [],
  };
}

export const offense = (s) => s.half; // 攻撃中のプレイヤー（0=1P, 1=2P）
export const defense = (s) => 1 - s.half;

function advanceAll(s) {
  const bases = [...s.bases];
  let runs = 0;
  if (bases[2]) runs++;
  const next = [true, bases[0], bases[1]];
  return { bases: next, runs };
}

function reachBase(s, how) {
  const { bases, runs } = advanceAll(s);
  const score = [...s.score];
  score[offense(s)] += runs;
  return { ...s, bases, score, balls: 0, strikes: 0, log: [...s.log, { how, runs }] };
}

function recordOut(s, how) {
  let n = { ...s, outs: s.outs + 1, balls: 0, strikes: 0, log: [...s.log, { how, runs: 0 }] };
  if (n.outs < GAME.outsPerHalf) return n;
  // 攻守交代
  n = { ...n, outs: 0, bases: [false, false, false] };
  if (n.half === 0) return { ...n, half: 1, changed: true };
  if (n.inning >= n.innings) return { ...n, over: true, changed: true };
  return { ...n, half: 0, inning: n.inning + 1, changed: true };
}

/**
 * 1投球の結果を適用する。
 * result: 'strike' | 'ball' | 'hit' | 'out'
 */
export function applyPitchResult(state, result) {
  if (state.over) return state;
  const s = { ...state, changed: false };
  switch (result) {
    case 'strike': {
      const strikes = s.strikes + 1;
      if (strikes >= GAME.strikesForOut) return recordOut(s, 'strikeout');
      return { ...s, strikes, log: [...s.log, { how: 'strike', runs: 0 }] };
    }
    case 'ball': {
      const balls = s.balls + 1;
      if (balls >= GAME.ballsForWalk) return reachBase(s, 'walk');
      return { ...s, balls, log: [...s.log, { how: 'ball', runs: 0 }] };
    }
    case 'hit':
      return reachBase(s, 'hit');
    case 'out':
      return recordOut(s, 'out');
    default:
      throw new Error(`unknown result: ${result}`);
  }
}

export function winner(state) {
  if (!state.over) return null;
  if (state.score[0] === state.score[1]) return 'draw';
  return state.score[0] > state.score[1] ? 0 : 1;
}
