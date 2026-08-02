// bot.js — AI。
// プレイヤーと完全に同じインターフェース（move + flick）だけを使う。
// ボールに直接速度を代入するようなズルは一切しない。
//
// キックは「駒の中心 → ボール」の向きへ飛ぶ（入力では向きを決められない）。
// つまりボットも人間と同じで、狙いは体の置き方でしかつけられない。
// だから思考は2段になる：
//   1. どこへ蹴りたいか（want）を決める
//   2. その向きの「裏」へ回り込み、向きが揃ってから蹴る

import { CONFIG, TEAM_BOT } from './config.js';
import { PHASE, goalMouth } from './game.js';

const F = CONFIG.field;
const B = CONFIG.bot;
const S = CONFIG.world.scale;
const P = CONFIG.world.pace;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a) => (Math.random() * 2 - 1) * a;

function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

export function createBot(team = TEAM_BOT) {
  return {
    team,
    timer: 0,
    plans: new Map(),   // unitIndex -> { tx, ty, flick }
    stats: { shoot: 0, pass: 0, clear: 0, dribble: 0, tackle: 0 },
  };
}

/**
 * ボットの意図を intents 配列に書き込む。
 * @param {object} bot   createBot() の戻り
 * @param {object} s     試合状態（読み取り専用として扱う）
 * @param {Array}  intents  4要素の意図配列（該当インデックスだけ埋める）
 * @param {number} dt
 */
export function updateBot(bot, s, intents, dt) {
  const mine = s.units.filter((u) => u.team === bot.team);

  // キックオフ中も動かす（自分たちが蹴る側ならボールへ向かう必要がある）
  if (s.phase !== PHASE.PLAY && s.phase !== PHASE.KICKOFF) {
    for (const u of mine) intents[u.index] = { move: { x: 0, y: 0 }, flick: null };
    bot.plans.clear();
    bot.timer = 0;
    return;
  }

  bot.timer -= dt * 1000;
  if (bot.timer <= 0) {
    bot.timer = B.rethinkMs * (0.8 + Math.random() * 0.4);
    think(bot, s, mine);
  }

  for (const u of mine) {
    const plan = bot.plans.get(u.index);
    if (!plan) {
      intents[u.index] = { move: { x: 0, y: 0 }, flick: null };
      continue;
    }
    const dx = plan.tx - u.x;
    const dy = plan.ty - u.y;
    const d = Math.hypot(dx, dy);
    // 近づいたら減速（人間の詰め方に近づける）
    const gain = clamp(d / (46 * S), 0, 1) * B.speedMultiplier;
    const n = norm(dx, dy);
    intents[u.index] = {
      move: { x: n.x * gain, y: n.y * gain },
      flick: fire(plan, s, u, dt),
    };
    if (intents[u.index].flick) bot.stats[intents[u.index].flick.reason]++;
  }
}

/**
 * 踏み込む瞬間の判定。think ではなく毎フレーム見る。
 * 向きが揃うのは一瞬なので、思考の間隔（rethinkMs）で待っていると撃ち逃す。
 *
 * 動作はひとつしかない（踏み込み）ので、ボールを叩くのも相手を潰すのも同じ意図。
 * 違うのは踏み込む向きと、そのとき前に何があるかだけ。
 */
function fire(plan, s, u, dt) {
  const ball = s.ball;
  const dist = Math.hypot(ball.x - u.x, ball.y - u.y);
  const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

  if (u.stunT > 0 || u.cooldown > 0) { plan.aimT = 0; return null; }

  // 離れた所から踏み込むと、届くころには位置関係が変わっていて狙いが崩れる
  // （実測：踏み込み118回に対しボールへ当たったのは64回、オウンゴール22件）。
  // 接触距離まで詰めてから踏み抜く。
  if (dist <= reach) {
    const opts = plan.options;
    if (!opts || !opts.length) { plan.aimT = 0; return null; }
    // 実際に飛ぶ向き（駒の中心 → ボール）に、既に乗っている選択肢があれば撃つ。
    // 一番いい狙いに揃うのを待つのではなく、体が向いている先で使えるものを取る。
    // 揃うまで待つほど妥協幅は広がるが、後ろ向きの選択肢はそもそも入っていない。
    plan.aimT = (plan.aimT || 0) + dt;
    const now = norm(ball.x - u.x, ball.y - u.y);
    for (const o of opts) {
      // 許容角は狙いごとに違う。ゴール口は広いが、相方は点なので狭い。
      // 一律にすると、遠いパスが的から大きく外れる（40度ずれ = 200先で137のずれ）。
      // 待つほど緩めるが、緩めきっても的の倍までにする。
      const limit = Math.min(o.tol + plan.aimT * B.aimSlackGrow, o.tol * B.aimSlackStretch, B.aimSlackMax);
      if (now.x * o.x + now.y * o.y >= Math.cos(limit)) {
        plan.aimT = 0;
        return { x: o.x, y: o.y, reason: o.reason };
      }
    }
    return null;
  }

  plan.aimT = 0;
  // 踏み込みは積んだ思考の次のフレームで使い切る。持ち越すと、条件が揃った
  // 瞬間に必ず踏み込むことになって、踏み込みばかりの試合になる。
  const t = plan.tackle;
  plan.tackle = null;
  return t;
}

// ---------------------------------------------------------------- 思考

function think(bot, s, mine) {
  const ball = s.ball;
  const attackY = bot.team === TEAM_BOT ? F.h : 0;
  const defendY = bot.team === TEAM_BOT ? 0 : F.h;
  const mouth = goalMouth();

  // ボール担当（駒A）は「到達が早いほう」
  let chaser = mine[0];
  let best = Infinity;
  for (const u of mine) {
    const t = Math.hypot(ball.x - u.x, ball.y - u.y) / CONFIG.unit.maxSpeed;
    if (t < best) { best = t; chaser = u; }
  }
  const support = mine.find((u) => u !== chaser) || mine[0];

  planChaser(bot, s, chaser, support, attackY, mouth);
  planSupport(bot, s, support, chaser, attackY, defendY);
}

function planChaser(bot, s, u, mate, attackY, mouth) {
  const ball = s.ball;
  const plan = getPlan(bot, u);

  // 先に「どこへ蹴りたいか」を決める。回り込む先がこれで決まる。
  plan.options = kickOptions(s, u, mate, attackY, mouth);
  plan.want = plan.options[0] || null;

  // ボールの予測位置へリード
  const lead = predictBall(ball, u, CONFIG.unit.maxSpeed * B.speedMultiplier);
  // 蹴りたい向きの「裏」へ回り込む。蹴る先が無い（ドリブル）ならゴール方向の裏。
  const aim = plan.want || norm(mouth.left + F.goalWidth / 2 - lead.x, attackY - lead.y);
  const spot = standPoint(u, ball, lead, aim);
  plan.tx = clamp(spot.x + rnd(18 * S * B.noise / 0.15), 16 * S, F.w - 16 * S);
  plan.ty = clamp(spot.y + rnd(18 * S * B.noise / 0.15), 16 * S, F.h - 16 * S);

  const dist = Math.hypot(ball.x - u.x, ball.y - u.y);
  const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

  plan.tackle = null;   // 体当たりは支援側の仕事（planSupport）
}

/**
 * 蹴りたい向き aim の「裏」に立つための目標点。
 *
 * まっすぐ裏へ向かうと、既にボールの近くにいる場合はボールを突っ切ってしまい、
 * 押してしまって狙いが崩れる。近くにいて向きが合っていないときは、
 * 触れない半径でボールの周りを回る。
 */
function standPoint(u, ball, lead, aim) {
  const back = CONFIG.unit.radius + CONFIG.ball.radius - 6 * S;
  const far = { x: lead.x - aim.x * back, y: lead.y - aim.y * back };

  const d = Math.hypot(u.x - ball.x, u.y - ball.y);
  const orbitR = CONFIG.unit.radius + CONFIG.ball.radius + B.orbitPad;
  if (d > orbitR * B.orbitEnter) return far;   // 遠いなら普通に裏へ向かう

  const wantAng = Math.atan2(-aim.y, -aim.x);                  // ボールから見て立ちたい角度
  const nowAng = Math.atan2(u.y - ball.y, u.x - ball.x);
  let diff = ((wantAng - nowAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(diff) < B.orbitSettle) return far;              // ほぼ合っている

  // 近いほうの回転方向へ、一歩ぶんだけ回った点を目指す
  const step = nowAng + Math.sign(diff) * Math.min(Math.abs(diff), B.orbitStep);
  return { x: ball.x + Math.cos(step) * orbitR, y: ball.y + Math.sin(step) * orbitR };
}

/** 幅 half の的が距離 dist にあるときに許せる角度のずれ */
function tolFor(half, dist) {
  return clamp(Math.atan2(half, Math.max(dist, 1)), B.aimSlack, B.aimSlackMax);
}

/**
 * 蹴り先の候補を優先順に並べて返す。
 *
 * 1つに絞らないのは、飛ぶ向きが体の置き方で決まるから。一番いい狙いに
 * 揃うまで待つより、既に体が向いている先で使えるものを取るほうが速い。
 * 後ろ向きの候補は入れない（そのまま自陣へ蹴り込むことになる）。
 */
function kickOptions(s, u, mate, attackY, mouth) {
  const out = [];
  const ball = s.ball;
  const goalX = mouth.left + F.goalWidth / 2 + rnd(F.goalWidth * 0.28);
  const goalDist = Math.hypot(goalX - ball.x, attackY - ball.y);

  // 1) シュートコースが空いていればシュート（至近ならコースを問わず打つ）
  if (goalDist < B.shootRange &&
      (goalDist < B.pointBlank || laneClear(s, ball, { x: goalX, y: attackY }, u.team, u.index))) {
    const d = norm(goalX - ball.x, attackY - ball.y);
    out.push({ x: d.x + rnd(B.noise * 0.5), y: d.y + rnd(B.noise * 0.5), reason: 'shoot',
               tol: tolFor(F.goalWidth * 0.42, goalDist) });
  }

  // 2) 相方の位置が良ければ必ずパス
  if (mate && mate !== u) {
    // ボールの到達時間ぶんだけ相方の動きを先読みする
    const raw = Math.hypot(mate.x - ball.x, mate.y - ball.y);
    const lead = clamp(raw / B.passLeadSpeed, 0, 0.6 / CONFIG.world.pace);
    const mateLead = {
      x: mate.x + mate.vx * lead,
      y: mate.y + mate.vy * lead,
    };
    const md = Math.hypot(mateLead.x - ball.x, mateLead.y - ball.y);
    const forward = (attackY - ball.y) * (attackY - mate.y) >= 0 &&
                    Math.abs(attackY - mate.y) <= Math.abs(attackY - ball.y) + 90 * S;
    if (md > B.passRange[0] && md < B.passRange[1] && forward &&
        laneClear(s, ball, mateLead, u.team, u.index)) {
      const d = norm(mateLead.x - ball.x, mateLead.y - ball.y);
      out.push({ x: d.x + rnd(B.noise * 0.4), y: d.y + rnd(B.noise * 0.4), reason: 'pass',
                 tol: tolFor(CONFIG.unit.radius * 3, md) });
    }
  }

  // 3) 押し込まれているなら大きくクリア
  const pressure = nearestFoe(s, u.team, u.x, u.y);
  const inOwnThird = Math.abs(u.y - (attackY === 0 ? F.h : 0)) < F.h * 0.3;
  if (inOwnThird && pressure && Math.hypot(pressure.x - u.x, pressure.y - u.y) < 70 * S) {
    const d = norm(
      (u.x < F.w / 2 ? -0.5 : 0.5) + rnd(0.3),
      (attackY - u.y) > 0 ? 1 : -1
    );
    out.push({ x: d.x, y: d.y, reason: 'clear', tol: B.aimSlackMax });   // 前へ飛べばいい
  }

  // 何も無ければドリブル（= 蹴らずに体で運ぶ。リスクは受け入れる）
  return out;
}

function planSupport(bot, s, u, chaser, attackY, defendY) {
  const ball = s.ball;
  const plan = getPlan(bot, u);
  const attacking = s.possess === bot.team;
  const jitter = 26 * S * (B.noise / 0.15);

  if (attacking) {
    // パスを受けられる位置：ボールより少し前、逆サイド寄り
    const side = ball.x < F.w / 2 ? 1 : -1;
    plan.tx = clamp(ball.x + side * 118 * S + rnd(jitter), 40 * S, F.w - 40 * S);
    plan.ty = clamp(ball.y + (attackY > ball.y ? 1 : -1) * 120 * S + rnd(jitter), 40 * S, F.h - 40 * S);
  } else {
    // 守備：ボールと自ゴールを結ぶ線上
    const gx = F.w / 2;
    const t = 0.42;
    plan.tx = clamp(ball.x + (gx - ball.x) * t + rnd(jitter), 30 * S, F.w - 30 * S);
    plan.ty = clamp(ball.y + (defendY - ball.y) * t + rnd(jitter), 30 * S, F.h - 30 * S);
  }

  // 支援側もボールが目の前に転がってきたら蹴る
  const dist = Math.hypot(ball.x - u.x, ball.y - u.y);
  const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

  // 体当たりは支援側の仕事。ボールを持っている相手そのものを潰しに行く。
  //
  // ボールへ突っ込むのではない。踏み込みでボールを叩くと飛ぶ向きは位置関係で
  // 決まるので、自陣へ叩き返すほうが多くなる（実測でオウンゴールが得点の18%）。
  // 相手を潰せば1秒動けなくなり、そのあいだに追う側がボールを拾える。
  //
  // 追う側にはやらせない。両チームの追う側同士が至近で潰し合うと、
  // ボールが誰の物にもならないまま試合が進まなくなる（実測で1点59秒）。
  const foe = nearestFoe(s, u.team, ball.x, ball.y);
  const foeDist = foe ? Math.hypot(foe.x - u.x, foe.y - u.y) : Infinity;
  if (u.cooldown <= 0 && u.stunT <= 0 && foe && foe.stunT <= 0 &&
      Math.hypot(foe.x - ball.x, foe.y - ball.y) < 40 * S &&
      foeDist < B.tackleRange && foeDist > CONFIG.unit.radius * 2 &&
      Math.random() < B.tackleChance) {
    const d = norm(foe.x - u.x, foe.y - u.y);
    plan.tackle = { x: d.x + rnd(B.noise * 0.5), y: d.y + rnd(B.noise * 0.5), reason: 'tackle' };
  } else {
    plan.tackle = null;
  }
  if (dist <= reach * 2.2) {
    // 蹴れる距離の少し手前から狙いを決めておく。転がってきた所を蹴るには、
    // 触れてから考えていては間に合わない（向きは体の置き方でしか作れない）。
    plan.options = kickOptions(s, u, chaser, attackY, goalMouth());
    plan.want = plan.options[0] || null;
    if (plan.want) {
      const spot = standPoint(u, ball, ball, plan.want);
      plan.tx = clamp(spot.x, 16 * S, F.w - 16 * S);
      plan.ty = clamp(spot.y, 16 * S, F.h - 16 * S);
    }
  } else {
    plan.options = null;
    plan.want = null;
  }
}

// ---------------------------------------------------------------- utils

function getPlan(bot, u) {
  let p = bot.plans.get(u.index);
  if (!p) { p = { tx: u.x, ty: u.y, want: null, options: null, tackle: null, aimT: 0 }; bot.plans.set(u.index, p); }
  return p;
}

// 摩擦つきの弾道を数回反復して落ち合う点を推定
function predictBall(ball, u, speed) {
  const f = CONFIG.ball.frictionPerSec;
  const k = Math.log(1 / f);
  let t = 0;
  let px = ball.x, py = ball.y;
  for (let i = 0; i < 4; i++) {
    const decay = (1 - Math.pow(f, t)) / k;
    px = ball.x + ball.vx * decay;
    py = ball.y + ball.vy * decay;
    t = Math.hypot(px - u.x, py - u.y) / Math.max(speed, 1);
    t = Math.min(t, 0.85 / P);   // 先読みの上限は時間。ボールが遅くなれば伸ばす
  }
  return {
    x: clamp(px, 10 * S, F.w - 10 * S),
    y: clamp(py, 10 * S, F.h - 10 * S),
  };
}

function nearestFoe(s, team, x, y) {
  let best = null, bd = Infinity;
  for (const u of s.units) {
    if (u.team === team) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}

// from→to の線分上に敵がいないか。
// 足元（= from のごく近く）にいる相手は「コース」ではなく寄せなので数えない。
// ここを見落とすと、密集した瞬間に一切シュートもパスも選ばなくなる。
function laneClear(s, from, to, team, ignoreIndex) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1) return true;
  const len = Math.sqrt(l2);
  for (const u of s.units) {
    if (u.team === team || u.index === ignoreIndex) continue;
    let t = ((u.x - from.x) * dx + (u.y - from.y) * dy) / l2;
    t = clamp(t, 0, 1);
    if (t * len < B.laneFootSkip) continue;                     // 足元は無視
    const px = from.x + dx * t, py = from.y + dy * t;
    if (Math.hypot(u.x - px, u.y - py) < CONFIG.unit.radius + B.laneClearRadius) return false;
  }
  return true;
}
