// PAIR KICK — 全チューニング値
// 数値の変更はこのファイルだけで完結すること。

export const CONFIG = {
  field: {
    w: 450,
    h: 800,
    goalWidth: 160,
    goalDepth: 26,     // ゴールネットの奥行き（描画とボール停止用）
    postRadius: 5,
    wallBounce: 0.8,
  },

  unit: {
    radius: 22,
    maxSpeed: 260,
    cooldown: 0.4,     // キック/ダッシュ共有
    accelSmoothing: 0.2,
    bounce: 0.35,      // 駒同士の押し合い（柔らかく）
    mass: 1,
  },

  ball: {
    radius: 12,
    maxSpeed: 750,
    bounce: 0.7,
    frictionPerSec: 0.18, // v *= pow(f, dt)  芝が長いイメージ
  },

  kick: {
    speed: 640,
    reachPad: 10,
  },

  dash: {
    speed: 520,
    duration: 0.15,
  },

  stick: {
    maxRadius: 60,
    flickWindowMs: 90,
    flickDist: 26,
    flickLockMs: 140,  // 連続誤爆防止
  },

  heat: {
    rampSeconds: 25,
    maxMultiplier: 1.25,
  },

  bot: {
    speedMultiplier: 0.9,
    rethinkMs: 120,
    noise: 0.15,
    shootRange: 240,
    passRange: [90, 340],
    laneClearRadius: 18,
    tackleRange: 150,
  },

  match: {
    winScore: 3,
    goalPause: 1.2,
    readySeconds: 1.1,
    stuckSeconds: 3,
    stuckSpeed: 22,
  },

  audio: {
    maxVoices: 16,
    comboSteps: 8,
  },
};

// チームカラーと画面まわり（描画専用の定数）
// 上は「ゴールネット + スコアHUDの帯」、下はネットぶんだけ。
// 上下を同じにするとデスクトップ幅でHUDが相手ゴールに被る。
export const VIEW = {
  padX: 12,
  padTop: 76,
  padBottom: 30,
  get w() { return CONFIG.field.w + this.padX * 2; },
  get h() { return CONFIG.field.h + this.padTop + this.padBottom; },
};

export const COLORS = {
  turfA: '#17472e',
  turfB: '#1a5334',
  line: 'rgba(255,255,255,0.10)',
  team: ['#ff6b57', '#3ecfc4'],
  teamGlow: ['rgba(255,107,87,', 'rgba(62,207,196,'],
  ball: '#ffffff',
  heatMid: '#ffd166',
  heatHot: '#ff8c42',
  gold: '#ffd700',
};

export const TEAM_PLAYER = 0;
export const TEAM_BOT = 1;
