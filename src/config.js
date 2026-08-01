// PAIR KICK — 全チューニング値
// 数値の変更はこのファイルだけで完結すること。

// --------------------------------------------------------------- スケール
//
// WORLD : コートの拡大率（各辺）。面積は WORLD² 倍。
// PIECE : 駒とボールの大きさ。現行の見た目を 1 とした比率。
//
// カメラは常にコート全体を画面に収める（= 画面倍率は 1/WORLD になる）ので、
// 「コートを大きくする」と「駒を小さく見せる」は同じ操作になる。
// WORLD=2, PIECE=0.5 で コート面積4倍 / 駒は画面上で半分の大きさ。
// もっと小さくしたければ PIECE を 0.25 に。逆に大きくしたければ 1 に。
//
// 距離・速度は WORLD に追従させてある。したがってコートを広げても
// 「端から端まで何秒か」「キック1発がコートの何割を進むか」は変わらない。
const WORLD = 2;
const PIECE = 0.5;

export const WORLD_SCALE = WORLD;
const w = (v) => v * WORLD;          // 距離・速度（ワールド空間）
const p = (v) => v * WORLD * PIECE;  // 駒とボールの半径

export const CONFIG = {
  world: { scale: WORLD, piece: PIECE },

  field: {
    w: w(450),
    h: w(800),
    goalWidth: w(160),
    goalDepth: w(26),   // ゴールネットの奥行き（描画とボール停止用）
    postRadius: w(5),
    wallBounce: 0.8,
  },

  unit: {
    radius: p(22),
    maxSpeed: w(260),
    cooldown: 0.4,     // キック/ダッシュ共有
    accelSmoothing: 0.2,
    bounce: 0.35,      // 駒同士の押し合い（柔らかく）
    mass: 1,
  },

  ball: {
    radius: p(12),
    maxSpeed: w(750),
    bounce: 0.7,
    frictionPerSec: 0.18, // v *= pow(f, dt)  芝が長いイメージ
  },

  kick: {
    speed: w(640),
    reachPad: w(10),
  },

  dash: {
    speed: w(520),
    duration: 0.15,
  },

  // スティックは指のインターフェースなので、画面上の物理サイズを保つために
  // WORLD ぶんだけ論理値を大きくする（画面倍率が 1/WORLD になるため）。
  stick: {
    maxRadius: w(60),
    knobRadius: w(25),
    releaseWindowMs: 110,  // 指を離す直前のこの時間だけを見る
    releaseDist: w(26),    // その間にこれだけ動いていればアクション
  },

  heat: {
    rampSeconds: 25,
    maxMultiplier: 1.25,
  },

  bot: {
    speedMultiplier: 0.9,
    rethinkMs: 120,
    noise: 0.15,
    shootRange: w(240),
    pointBlank: w(140),
    passRange: [w(90), w(340)],
    laneClearRadius: w(18),
    laneFootSkip: w(44),
    tackleRange: w(150),
  },

  match: {
    winScore: 3,
    goalPause: 1.2,
    readySeconds: 1.1,
    stuckSeconds: 3,
    stuckSpeed: w(22),
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
  padX: w(12),
  padTop: w(76),
  padBottom: w(30),
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
