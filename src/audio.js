// audio.js — WebAudio合成のみ。音源ファイルなし。
// 質感の目標：ブロックブラスト。明るく、丸く、湿度のあるマリンバ／木琴的な倍音。

import { CONFIG } from './config.js';

// ペンタトニック C-D-E-G-A を2オクターブぶん。パス1回で1段上がる。
const PENTA = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];

const detune = () => 1 + (Math.random() * 2 - 1) * 0.02; // ±2%

export function createAudio() {
  const A = {
    ctx: null,
    master: null,
    reverbSend: null,
    active: 0,
    heat: 0,
    muted: false,
    lastTouch: 0,
  };

  function ensure() {
    if (A.ctx) {
      if (A.ctx.state === 'suspended') A.ctx.resume();
      return A.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    A.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(comp);
    A.master = master;

    // 共通の短いリバーブセンド。これが一気にブロックブラスト的にする。
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, 1.0, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    conv.connect(wet);
    wet.connect(master);

    const send = ctx.createGain();
    send.gain.value = 0.22;
    send.connect(conv);
    A.reverbSend = send;

    return ctx;
  }

  function makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  function slot(important = false) {
    if (A.muted) return false;
    if (!important && A.active >= CONFIG.audio.maxVoices) return false;
    A.active++;
    return true;
  }
  const release = () => { A.active = Math.max(0, A.active - 1); };

  function noiseBuffer(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** マリンバ的な1音。基音 + 4倍・10倍の部分音（実際の木琴の比率）。 */
  function marimba(freq, when, gain, decay, sendAmt = 1) {
    const ctx = A.ctx;
    if (!slot()) return;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(A.master);
    const s = ctx.createGain();
    s.gain.value = 0.55 * sendAmt;
    out.connect(s);
    s.connect(A.reverbSend);

    const dec = decay * (1 + A.heat * 0.28);
    const parts = [
      { m: 1, g: 1.0, d: 1.0, type: 'sine' },
      { m: 3.99, g: 0.24, d: 0.42, type: 'sine' },
      { m: 9.6, g: 0.07, d: 0.2, type: 'sine' },
      { m: 2.0, g: 0.12, d: 0.6, type: 'triangle' },
    ];
    let ended = 0;
    for (const p of parts) {
      const o = ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = freq * p.m * detune();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gain * p.g, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dec * p.d);
      o.connect(g);
      g.connect(out);
      o.start(when);
      o.stop(when + dec * p.d + 0.05);
      o.onended = () => { if (++ended === parts.length) release(); };
    }

    // 木づちのアタック
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.02);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(freq * 6, 6000);
    bp.Q.value = 1.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.32, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    src.connect(bp); bp.connect(ng); ng.connect(out);
    src.start(when);
    src.stop(when + 0.06);
  }

  function woodHit(freq, when, gain, decay) {
    const ctx = A.ctx;
    if (!slot()) return;
    const out = ctx.createGain();
    out.connect(A.master);
    const s = ctx.createGain();
    s.gain.value = 0.3;
    out.connect(s); s.connect(A.reverbSend);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq * 1.7 * detune(), when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    o.connect(g); g.connect(out);
    o.start(when); o.stop(when + decay + 0.03);
    o.onended = release;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.03);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.5, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    src.connect(hp); hp.connect(ng); ng.connect(out);
    src.start(when); src.stop(when + 0.06);
  }

  // ------------------------------------------------------------ public

  return {
    unlock() { ensure(); },
    get ready() { return !!A.ctx; },
    setMuted(v) { A.muted = v; if (A.master) A.master.gain.value = v ? 0 : 0.85; },
    /** ヒート 0..1。残響がわずかに長くなる。 */
    setHeat(h) {
      A.heat = h;
      if (A.reverbSend) A.reverbSend.gain.value = 0.2 + h * 0.16;
    },

    kick(power = 1) {
      if (!ensure()) return;
      const t = A.ctx.currentTime;
      woodHit(170 + power * 130, t, 0.42, 0.14);
    },

    /** パス成立。コンボで1段ずつ上へ。8段でトップを維持。 */
    pass(chain) {
      if (!ensure()) return;
      const t = A.ctx.currentTime;
      const i = Math.min(Math.max(chain, 1), CONFIG.audio.comboSteps) - 1;
      marimba(PENTA[i], t, 0.4, 0.85, 1.2);
      marimba(PENTA[i] * 2, t + 0.012, 0.12, 0.5, 1.4);
    },

    dash() {
      if (!ensure()) return;
      const ctx = A.ctx, t = ctx.currentTime;
      if (!slot()) return;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 3.2;
      bp.frequency.setValueAtTime(320, t);
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.19);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      src.connect(bp); bp.connect(g); g.connect(A.master);
      src.start(t); src.stop(t + 0.3);
      src.onended = release;
    },

    /** ボール接触。頻繁に鳴るので控えめ + スロットル。 */
    touch(strength = 0.5) {
      if (!ensure()) return;
      const now = A.ctx.currentTime;
      if (now - A.lastTouch < 0.055) return;
      A.lastTouch = now;
      if (!slot()) return;
      const o = A.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = (620 + strength * 420) * detune();
      const g = A.ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.035 + strength * 0.05, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      o.connect(g); g.connect(A.master);
      o.start(now); o.stop(now + 0.08);
      o.onended = release;
    },

    wall(strength = 0.5) {
      if (!ensure()) return;
      const t = A.ctx.currentTime;
      woodHit(120 + strength * 90, t, 0.12 + strength * 0.12, 0.08);
    },

    /** ゴール：上昇アルペジオ + スパークル + 低域インパクト の3層。 */
    goal() {
      if (!ensure()) return;
      const ctx = A.ctx, t = ctx.currentTime;
      const arp = [0, 2, 3, 5, 7];
      arp.forEach((n, i) => {
        const f = PENTA[n % PENTA.length] * (n >= PENTA.length ? 2 : 1);
        marimba(f, t + i * 0.062, 0.36, 1.0, 1.3);
      });
      // スパークル層
      for (let i = 0; i < 7; i++) {
        const when = t + 0.08 + Math.random() * 0.5;
        if (!slot(true)) break;
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 1600 + Math.random() * 2400;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(0.055, when + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);
        o.connect(g); g.connect(A.master);
        const s = ctx.createGain(); s.gain.value = 0.8;
        g.connect(s); s.connect(A.reverbSend);
        o.start(when); o.stop(when + 0.36);
        o.onended = release;
      }
      // 低域インパクト
      if (slot(true)) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.4);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.5, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.connect(g); g.connect(A.master);
        o.start(t); o.stop(t + 0.6);
        o.onended = release;
      }
    },

    /** キックオフ：澄んだ2音のチャイム */
    kickoff() {
      if (!ensure()) return;
      const t = A.ctx.currentTime;
      marimba(PENTA[3] * 2, t, 0.26, 0.7, 1.1);
      marimba(PENTA[5] * 2, t + 0.14, 0.26, 0.9, 1.1);
    },

    /** ジョイスティック出現：触覚的なごく短いソフトクリック */
    click() {
      if (!ensure()) return;
      const ctx = A.ctx, t = ctx.currentTime;
      if (!slot()) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 1150 * detune();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      o.connect(g); g.connect(A.master);
      o.start(t); o.stop(t + 0.05);
      o.onended = release;
    },

    result(win) {
      if (!ensure()) return;
      const t = A.ctx.currentTime;
      const seq = win ? [0, 2, 4, 5, 7] : [7, 4, 2, 0];
      seq.forEach((n, i) => marimba(PENTA[n], t + i * 0.1, 0.3, 1.2, 1.2));
    },
  };
}
