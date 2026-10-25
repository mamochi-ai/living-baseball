// 効果音は Web Audio で短く合成する（音声ファイルは使わない）。初回タップで有効化。
let ctx = null;
let master = null;
let muted = false;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.6;
  master.connect(ctx.destination);
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.6;
}

export const isMuted = () => muted;

function tone(freq, dur, { type = 'sine', gain = 0.4, delay = 0, slideTo = null } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.3, delay = 0, freq = 2000, q = 1, type = 'bandpass' } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t0);
}

export const sfx = {
  tap: () => tone(880, 0.05, { type: 'triangle', gain: 0.15 }),
  count: (last) => tone(last ? 1320 : 880, last ? 0.25 : 0.12, { type: 'square', gain: 0.12 }),
  throw: () => noise(0.18, { freq: 900, q: 0.7, gain: 0.25 }),
  swing: () => noise(0.16, { freq: 600, q: 0.6, gain: 0.35 }),
  hit: () => {
    tone(1500, 0.06, { type: 'triangle', gain: 0.5 });
    noise(0.05, { freq: 3000, q: 2, gain: 0.3 });
  },
  bounce: () => tone(2100, 0.04, { type: 'sine', gain: 0.25 }),
  thud: () => {
    tone(120, 0.25, { type: 'sine', gain: 0.6, slideTo: 60 });
    noise(0.12, { freq: 300, q: 0.8, gain: 0.3 });
  },
  glass: () => {
    noise(0.35, { freq: 5000, q: 0.5, gain: 0.35, type: 'highpass' });
    [3100, 4200, 2600, 5200, 3700].forEach((f, i) => tone(f, 0.18, { gain: 0.12, delay: i * 0.035 }));
  },
  safe: () => [660, 880, 1100, 1320].forEach((f, i) => tone(f, 0.16, { type: 'triangle', gain: 0.2, delay: i * 0.08 })),
  out: () => tone(400, 0.35, { type: 'sawtooth', gain: 0.12, slideTo: 180 }),
  strike: () => tone(520, 0.12, { type: 'square', gain: 0.1 }),
  ball: () => tone(300, 0.1, { type: 'triangle', gain: 0.15 }),
};
