// PAIR KICK — 全チューニング値
// 数値の変更はこのファイルだけで完結すること。

// --------------------------------------------------------------- スケール
//
// WORLD : コートの拡大率（各辺）。面積は WORLD² 倍。
// PIECE : 駒とボールの大きさ。現行の見た目を 1 とした比率。
// PACE  : 全体の速さ。0.5 で「すべてが半分の速さ」。
//
// カメラは常にコート全体を画面に収める（= 画面倍率は 1/WORLD になる）ので、
// 「コートを大きくする」と「駒を小さく見せる」は同じ操作になる。
// WORLD=2, PIECE=0.5 で コート面積4倍 / 駒は画面上で半分の大きさ。
// もっと小さくしたければ PIECE を 0.25 に。逆に大きくしたければ 1 に。
//
// 距離・速度は WORLD に追従させてある。したがってコートを広げても
// 「端から端まで何秒か」「キック1発がコートの何割を進むか」は変わらない。
//
// PACE は「速さ」だけを変え、軌道の形と届く距離は変えない。
//
// 速度を半分にしただけだと、摩擦がそのままなのでボールの到達距離も半分になり、
// キック1発がコート長辺の23%しか進まなくなる（= パスが武器でなくなる）。
// そうならないよう、PACE は「シミュレーションの時間を引き伸ばす」ものとして
// 扱う：速度に PACE を掛け、時定数を PACE で割る。摩擦だけは指数減衰なので
// f^PACE。結果として v'(t) = PACE·v(PACE·t)、x'(t) = x(PACE·t) が成り立ち、
// 同じ試合をそのまま半分の速さで見ているのと同じになる。
//
// 時定数のうち PACE に追従するのはシミュレーション側だけ。
// ゴール後の停止（goalPause）は演出の間合いなので据え置く。
const WORLD = 2;
const PIECE = 0.5;
const PACE  = 0.5;

export const WORLD_SCALE = WORLD;
const w = (v) => v * WORLD;                 // 距離
const p = (v) => v * WORLD * PIECE;         // 駒とボールの半径
const v = (val) => val * WORLD * PACE;      // 速度

export const CONFIG = {
  world: { scale: WORLD, piece: PIECE, pace: PACE },

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
    maxSpeed: v(260),
    cooldown: 0.4 / PACE,       // 移動距離あたりの行動回数を変えない
    accelSmoothing: 1 - Math.pow(0.8, PACE),   // 最高速に乗るまでの距離を変えない
    bounce: 0.35,      // 駒同士の押し合い（柔らかく）
    mass: 1,
  },

  ball: {
    radius: p(12),
    maxSpeed: v(750),
    bounce: 0.7,
    // v *= pow(f, dt)。芝が長いイメージ。PACE で到達距離が変わらないよう f^PACE。
    frictionPerSec: Math.pow(0.18, PACE),
  },

  kick: {
    speed: v(640),
    reachPad: w(10),
  },

  dash: {
    speed: v(520),
    duration: 0.15 / PACE,   // 速さが落ちても踏み込む距離は変えない
  },

  // スティックは指のインターフェースなので、単位は CSS px。
  // カメラが寄ろうが引こうが、指に対する大きさは変わらない。
  stick: {
    maxRadius: 60,      // CSS px
    knobRadius: 25,     // CSS px
    // 離した瞬間、スティックがこれ以上倒れていればアクションが出る。
    // 倒し量そのものを見るので、スワイプする必要はない。
    // 逆に、中央へ戻してから離せば何も起きない（これが唯一の「撃たない」方法）。
    releaseTilt: 0.2,
  },

  // 操作方法。stick = 置いた地点を支点にした相対操作、
  // point = 進んでほしい場所に指を置く絶対操作。
  control: {
    defaultMode: 'stick',
    pointDamp: w(45),    // 目的地までこの距離を切ると減速する（行き過ぎて震えない範囲で最短に）
    pointFire: w(30),    // 離した時にこれ以上離れていればアクションが出る
  },

  heat: {
    rampSeconds: 25 / PACE,   // ヒートはラリーの長さに追従させる（実時間ではなく）
    maxMultiplier: 1.25,
  },

  bot: {
    speedMultiplier: 0.9,
    rethinkMs: 120 / PACE,   // 反応の遅れも引き伸ばす。据え置くと遅い試合ほどボットが鋭くなる
    noise: 0.15,
    shootRange: w(240),
    pointBlank: w(140),
    passRange: [w(90), w(340)],
    laneClearRadius: w(18),
    laneFootSkip: w(44),
    tackleRange: w(150),
    passLeadSpeed: v(380),   // パスの到達時間の見積もりに使う代表速度
  },

  match: {
    winScore: 3,
    goalPause: 1.2,
    kickoffTimeout: 12,   // 誰も触らないまま固まらないための保険
    stuckSeconds: 3 / PACE,
    stuckSpeed: v(22),
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
