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
const WIDE  = 1.5;   // コートの横だけを伸ばす比率。縦は変えない

export const WORLD_SCALE = WORLD;
const w = (v) => v * WORLD;                 // 距離
const p = (v) => v * WORLD * PIECE;         // 駒とボールの半径
const v = (val) => val * WORLD * PACE;      // 速度

export const CONFIG = {
  world: { scale: WORLD, piece: PIECE, pace: PACE, wide: WIDE },

  field: {
    w: w(450 * WIDE),
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
    // 体当たりを食らった側は、この時間だけ動けなくなる（表面に ✕ が出る）。
    // 実時間で1秒。PACE で割らないのは、これがルールとして数える長さだから。
    stunTime: 1,
  },

  ball: {
    radius: p(12),
    maxSpeed: v(750),
    // 駒とボールの反発は、ぶつかる速さで変える。
    //
    // 一律 0.7 だと、体で触れただけでボールが自分より速く飛び出して、常に
    // 置いていかれた。かといって一律で寝かせると、シュートが守備の体で死ぬので
    // こぼれ球が出ず、ボットの試合が守り合いのまま終わらなくなった
    // （実測：120試合で決着なしが 0 → 3 件）。
    //
    // 「普通に触れた」＝ 駒の足の速さ程度（260）までは跳ね返さず押すだけ。
    // 「叩きつけられた」＝ キック速度（640）付近では従来どおり弾く。
    // ダッシュ（520）はその中間で、体当たりとして効く。
    bounce: 0.08,        // 触れただけのとき
    bounceHard: 0.7,     // 叩きつけられたとき
    softSpeed: v(300),   // これ以下の相対速度は「触れただけ」
    hardSpeed: v(620),   // これ以上は「叩きつけられた」
    // v *= pow(f, dt)。芝が長いイメージ。PACE で到達距離が変わらないよう f^PACE。
    frictionPerSec: Math.pow(0.18, PACE),
  },

  // 「蹴る」という専用の動作は無い。アクションは常に踏み込み（体当たり）ひとつ。
  // ボールを持っていようがいまいが同じことをする。踏み込んだ先にボールがあれば
  // 体が当たって飛び、相手がいれば相手が潰れる。
  // だから飛ぶ向きは入力ではなく、駒の中心 → ボールの向きで決まる。
  kick: {
    reachPad: w(10),   // ボットが「もう当てられる」と見なす余裕
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
    // アクションは「離す直前に指が動いていれば」出る。速さは見ない。
    // 出ないのは、指を止めてから離したときだけ。
    // 向きは、離す直前の移動から取る（dirDist ぶん遡って安定させる）。
    restMs: 120,        // ms。離す直前にこれ以上その場で止まっていたら発火しない
    dirDist: 20,        // CSS px。向きを取るために遡る移動量の目安
    dirWindowMs: 200,   // ms。これより古くは遡らない
    minDist: 3,         // CSS px。窓の中でこれ未満しか動いていなければ「動いていない」
  },

  // カメラ。注視点（ボールと自分の2駒）に合わせて寄り引きする。
  camera: {
    minVisibleH: 0.40,   // 画面に必ず入れるコート縦の割合
    minVisibleW: 0.55,   // 同じく横
    edgeMargin: w(70),   // コート外をここまで見せてよい（端の駒が画面際に貼り付かないように）
  },

  // 進行方向の矢印。動かしているあいだ、駒の前に短く太く出す。
  // ボールがどこへ飛ぶかの予告ではない（それは体の置き方で決まる）。
  moveArrow: {
    gap: w(6),        // 駒の縁からの隙間
    length: w(30),    // 短く
    width: w(9),      // 太く
    head: w(20),
    alpha: 0.45,      // 半透明（芝の上で読める下限。これ以下だと茶色く沈む）
    minInput: 0.18,   // 倒し量がこれ未満なら出さない
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
    tackleRange: w(80),      // 踏み込みが届く範囲（dash は 156 しか進まない）
    tackleChance: 0.25,      // 思考1回あたり。上げると潰し合いで試合が進まなくなる
    passLeadSpeed: v(380),   // パスの到達時間の見積もりに使う代表速度
    // キックの向きは体の置き方で決まるので、ボットも「裏へ回り込んで待つ」。
    // 待ち続けて何も起きないのが一番まずいので、待つほど妥協させる。
    // 許容するずれは狙いごとに決める（的の幅と距離から）。これはその下限と上限。
    aimSlack: 0.16,          // rad。どんなに遠い的でもここまでは許す（約9度）
    aimSlackGrow: 0.9,       // rad/秒。揃わないまま待つと広がる
    aimSlackStretch: 2.2,    // 待って緩めても、的の許容角のこの倍まで
    aimSlackMax: 0.70,       // rad。約40度。これ以上妥協させると自陣へ蹴り込む
    // 回り込み。ボールを突っ切らずに、触れない半径で回る。
    orbitPad: w(9),          // 接触距離からこれだけ離れて回る
    orbitEnter: 2.1,         // 回り込み半径のこの倍率より近いときだけ回る
    orbitSettle: 0.45,       // rad。これ以内なら回らずまっすぐ裏へ
    orbitStep: 1.0,          // rad。1回の目標で回る角度の上限
  },

  match: {
    winScore: 3,
    goalPause: 1.2,
    kickoffTimeout: 12,   // 誰も触らないまま固まらないための保険
    // 膠着の判定は「速さ」ではなく「移動量」で見る。
    // 小突かれ続けているボールは毎フレーム動いているので、速さで見ると素通りする。
    stuckSeconds: 3 / PACE,
    stuckRadius: w(35),   // この円から出られないまま stuckSeconds 経ったら中央へ押し出す
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
