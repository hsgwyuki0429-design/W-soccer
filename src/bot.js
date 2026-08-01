// bot.js — AI。
// プレイヤーと完全に同じインターフェース（move + flick）だけを使う。
// ボールに直接速度を代入するようなズルは一切しない。

import { CONFIG, TEAM_BOT } from './config.js';
import { PHASE, goalMouth } from './game.js';

const F = CONFIG.field;
const B = CONFIG.bot;
const S = CONFIG.world.scale;

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

  if (s.phase !== PHASE.PLAY) {
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
    const gain = clamp(d / 46, 0, 1) * B.speedMultiplier;
    const n = norm(dx, dy);
    intents[u.index] = {
      move: { x: n.x * gain, y: n.y * gain },
      flick: plan.flick,
    };
    if (plan.flick && plan.flick.reason) bot.stats[plan.flick.reason]++;
    plan.flick = null; // フリックは1フレームだけ
  }
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

  // ボールの予測位置へリード
  const lead = predictBall(ball, u, CONFIG.unit.maxSpeed * B.speedMultiplier);
  // ゴール方向の「裏」に回り込む
  const toGoal = norm(mouth.left + F.goalWidth / 2 - lead.x, attackY - lead.y);
  const back = CONFIG.unit.radius + CONFIG.ball.radius - 6 * S;
  plan.tx = clamp(lead.x - toGoal.x * back + rnd(18 * S * B.noise / 0.15), 16 * S, F.w - 16 * S);
  plan.ty = clamp(lead.y - toGoal.y * back + rnd(18 * S * B.noise / 0.15), 16 * S, F.h - 16 * S);

  const dist = Math.hypot(ball.x - u.x, ball.y - u.y);
  const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

  if (u.cooldown > 0) { plan.flick = null; return; }

  if (dist <= reach) {
    plan.flick = chooseKick(s, u, mate, attackY, mouth);
    return;
  }

  // タックルダッシュ：相手がボールを持っていて、自分がやや遠いとき
  const foe = nearestFoe(s, u.team, ball.x, ball.y);
  if (foe && Math.hypot(foe.x - ball.x, foe.y - ball.y) < 46 * S &&
      dist < B.tackleRange && dist > reach + 12 * S && Math.random() < 0.45) {
    const d = norm(ball.x - u.x, ball.y - u.y);
    plan.flick = { x: d.x + rnd(B.noise), y: d.y + rnd(B.noise), reason: 'tackle' };
    return;
  }
  plan.flick = null;
}

function chooseKick(s, u, mate, attackY, mouth) {
  const ball = s.ball;
  const goalX = mouth.left + F.goalWidth / 2 + rnd(F.goalWidth * 0.28);
  const goalDist = Math.hypot(goalX - ball.x, attackY - ball.y);

  // 1) シュートコースが空いていればシュート（至近ならコースを問わず打つ）
  if (goalDist < B.shootRange &&
      (goalDist < B.pointBlank || laneClear(s, ball, { x: goalX, y: attackY }, u.team, u.index))) {
    const d = norm(goalX - ball.x, attackY - ball.y);
    return { x: d.x + rnd(B.noise * 0.5), y: d.y + rnd(B.noise * 0.5), reason: 'shoot' };
  }

  // 2) 相方の位置が良ければ必ずパス
  if (mate && mate !== u) {
    // ボールの到達時間ぶんだけ相方の動きを先読みする
    const raw = Math.hypot(mate.x - ball.x, mate.y - ball.y);
    const lead = clamp(raw / (380 * S), 0, 0.6);
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
      return { x: d.x + rnd(B.noise * 0.4), y: d.y + rnd(B.noise * 0.4), reason: 'pass' };
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
    return { x: d.x, y: d.y, reason: 'clear' };
  }

  // 4) それ以外はドリブル（= 蹴らずに体で運ぶ。リスクは受け入れる）
  return null;
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
  if (u.cooldown <= 0 && dist <= reach) {
    plan.flick = chooseKick(s, u, chaser, attackY, goalMouth());
  } else {
    plan.flick = null;
  }
}

// ---------------------------------------------------------------- utils

function getPlan(bot, u) {
  let p = bot.plans.get(u.index);
  if (!p) { p = { tx: u.x, ty: u.y, flick: null }; bot.plans.set(u.index, p); }
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
    t = Math.min(t, 0.85);
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
