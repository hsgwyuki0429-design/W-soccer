// 高難度CPU。観測できる盤面から予測し、通常の move / flick だけで実行する。
// 本物の試合を変更せず、踏み込み候補はコピー上の同じ物理で比較する。
import { CONFIG } from './config.js';
import { PHASE, step, goalMouth } from './game.js';

const F = CONFIG.field, U = CONFIG.unit, R = U.radius + CONFIG.ball.radius;
const DT = 1 / 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };
const point = (x, y) => ({ x: clamp(x, U.radius, F.w - U.radius), y: clamp(y, U.radius, F.h - U.radius) });

export function forecastBall(ball, seconds = 2) {
  const b = { ...ball }, path = [{ ...b, t: 0 }];
  const decay = Math.pow(CONFIG.ball.frictionPerSec, DT), mouth = goalMouth();
  for (let i = 1; i <= Math.round(seconds / DT); i++) {
    b.vx *= decay; b.vy *= decay;
    b.x += b.vx * DT; b.y += b.vy * DT;
    const r = CONFIG.ball.radius;
    if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * F.wallBounce; }
    if (b.x > F.w - r) { b.x = F.w - r; b.vx = -Math.abs(b.vx) * F.wallBounce; }
    if (b.x < mouth.left || b.x > mouth.right) {
      if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * F.wallBounce; }
      if (b.y > F.h - r) { b.y = F.h - r; b.vy = -Math.abs(b.vy) * F.wallBounce; }
    }
    path.push({ ...b, t: i * DT });
    if (b.y <= 0 || b.y >= F.h) break;
  }
  return path;
}

function interception(u, path) {
  for (const p of path) {
    if (distance(u, p) <= Math.max(0, p.t - u.stunT - 0.08) * U.maxSpeed + R) return p;
  }
  return path[path.length - 1];
}

// コース上へ到達できる相手までの余裕。動いている相手も予測する。
function clearance(s, from, to, team) {
  const d = unit(to.x - from.x, to.y - from.y), length = distance(from, to);
  let room = F.w;
  for (const foe of s.units) {
    if (foe.team === team || foe.stunT > 0.5) continue;
    const along = clamp((foe.x - from.x) * d.x + (foe.y - from.y) * d.y, 0, length);
    if (along < R * 1.3) continue;
    const t = Math.min(1.3, along / (CONFIG.ball.maxSpeed * 0.8));
    const future = { x: foe.x + foe.vx * t * 0.6, y: foe.y + foe.vy * t * 0.6 };
    const near = Math.min(distance(foe, { x: from.x + d.x * along, y: from.y + d.y * along }),
      distance(future, { x: from.x + d.x * along, y: from.y + d.y * along }));
    room = Math.min(room, near - R - Math.max(0, t - foe.stunT) * U.maxSpeed * 0.12);
  }
  return room;
}

function attackTarget(bot, s, me, mates) {
  const ball = s.ball, attackY = bot.team === 1 ? F.h : 0;
  const mouth = goalMouth(), center = F.w / 2;
  let best = null, bestScore = -Infinity;
  const samples = 3 + Math.round(bot.profile.expert * 8);
  for (let i = 0; i < samples; i++) {
    const x = mouth.left + CONFIG.ball.radius * 2
      + (F.goalWidth - CONFIG.ball.radius * 4) * i / (samples - 1);
    const target = { x, y: attackY, reason: 'shoot' };
    const lane = clearance(s, ball, target, bot.team);
    const score = Math.min(lane, 160) - distance(ball, target) * 0.08 - Math.abs(x - center) * 0.03;
    if (score > bestScore) { best = target; bestScore = score; }
  }
  // 遠いときはパスも候補。受け手の移動と空いたコースを同時に評価する。
  if (Math.abs(attackY - ball.y) > 380) {
    for (const mate of mates) {
      if (mate === me || mate.stunT > 0.2) continue;
      const target = point(mate.x + mate.vx * 0.3, mate.y + mate.vy * 0.3);
      const d = distance(ball, target);
      const gain = Math.abs(attackY - ball.y) - Math.abs(attackY - target.y);
      const lane = clearance(s, ball, target, bot.team);
      if (d < 140 || d > 650 || gain < 70 || lane < 5) continue;
      const score = Math.min(lane, 160) + gain * 0.35 - d * 0.08 - 60;
      if (score > bestScore) { best = { ...target, reason: 'pass' }; bestScore = score; }
    }
  }
  return best;
}

function chaseSpot(me, ball, intercept, aim) {
  const back = R - 4;
  const far = point(intercept.x - aim.x * back, intercept.y - aim.y * back);
  const d = distance(me, ball);
  if (d > R * 4) return far;
  const desired = Math.atan2(-aim.y, -aim.x), actual = Math.atan2(me.y - ball.y, me.x - ball.x);
  const delta = ((desired - actual + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(delta) < 0.3) return far;
  const angle = actual + Math.sign(delta) * Math.min(Math.abs(delta), 0.6);
  return point(ball.x + Math.cos(angle) * (R + 12), ball.y + Math.sin(angle) * (R + 12));
}

function movement(u, target, precision = false) {
  const d = distance(u, target), n = unit(target.x - u.x, target.y - u.y);
  const gain = clamp(d / (precision ? 20 : 45), 0, 1);
  const brake = d < 60 ? 0.15 : 0;
  let x = n.x * gain - u.vx / U.maxSpeed * brake;
  let y = n.y * gain - u.vy / U.maxSpeed * brake;
  const mag = Math.hypot(x, y);
  if (mag > 1) { x /= mag; y /= mag; }
  // 全力移動は人間と同じ1。速度の補正は付けない。
  return { x, y };
}

function planTeam(bot, s, mine) {
  const path = forecastBall(s.ball);
  const attackY = bot.team === 1 ? F.h : 0, ownY = F.h - attackY;
  const intercepts = new Map(mine.map((u) => [u.index, interception(u, path)]));
  const order = [...mine].sort((a, b) => {
    const cost = (u) => intercepts.get(u.index).t * U.maxSpeed + distance(u, s.ball) * 0.15 + u.stunT * U.maxSpeed;
    return cost(a) - cost(b);
  });
  const chaser = order[0];
  const target = attackTarget(bot, s, chaser, mine);
  const aim = unit(target.x - s.ball.x, target.y - s.ball.y);
  for (let rank = 0; rank < order.length; rank++) {
    const u = order[rank];
    let spot;
    if (rank === 0) {
      const predicted = distance(u, s.ball) < R * 2 ? s.ball : intercepts.get(u.index);
      spot = chaseSpot(u, s.ball, predicted, aim);
    } else if (rank === order.length - 1 && order.length >= 3) {
      // 最後尾は常にゴール側。飛んできたシュートには落下点へ先回りする。
      const danger = path.find((p) => Math.abs(p.y - ownY) < 65);
      spot = danger ? point(danger.x, ownY === 0 ? 65 : F.h - 65)
        : point(F.w / 2 + (s.ball.x - F.w / 2) * 0.45,
          ownY + Math.sign(attackY - ownY) * Math.min(400, Math.abs(s.ball.y - ownY) * 0.45));
    } else {
      const closestFoe = s.units.filter((v) => v.team !== bot.team).sort((a, b) => distance(a, s.ball) - distance(b, s.ball))[0];
      const attacking = distance(chaser, s.ball) < (closestFoe ? distance(closestFoe, s.ball) + 30 : Infinity);
      if (attacking && Math.abs(s.ball.y - ownY) > 300) {
        const side = s.ball.x < F.w / 2 ? 1 : -1;
        spot = point(s.ball.x + side * 210, s.ball.y + Math.sign(attackY - ownY) * 200);
      } else {
        spot = point(s.ball.x + (F.w / 2 - s.ball.x) * 0.3,
          s.ball.y + (ownY - s.ball.y) * 0.28);
      }
    }
    const error = bot.profile.noise * 80;
    spot = point(spot.x + (Math.random() * 2 - 1) * error, spot.y + (Math.random() * 2 - 1) * error);
    const want = rank === 0 ? target : attackTarget(bot, s, u, mine);
    bot.plans.set(u.index, { tx: spot.x, ty: spot.y, target: want, role: rank, chaser: rank === 0 });
  }
}

function cloneState(s) {
  return { ...s, units: s.units.map((u) => ({ ...u })), ball: { ...s.ball }, score: [...s.score], events: [] };
}

function value(s, before, team) {
  const sign = team === 1 ? 1 : -1;
  let score = (s.score[team] - before.score[team]) * 100000
    - (s.score[1 - team] - before.score[1 - team]) * 150000;
  const attackY = team === 1 ? F.h : 0, ownY = F.h - attackY;
  const projected = forecastBall(s.ball, 1.2).at(-1);
  if (projected.y <= 0 || projected.y >= F.h) score += (projected.y <= 0 ? 0 : 1) === team ? 15000 : -25000;
  score += (projected.y - before.ball.y) * sign * 1.4;
  score -= Math.abs(projected.x - F.w / 2) * 0.1;
  const myDist = Math.min(...s.units.filter((u) => u.team === team).map((u) => distance(u, s.ball) + u.stunT * U.maxSpeed));
  const foeDist = Math.min(...s.units.filter((u) => u.team !== team).map((u) => distance(u, s.ball) + u.stunT * U.maxSpeed));
  score += clamp(foeDist - myDist, -200, 200) * 0.8;
  if (Math.abs(projected.y - ownY) < 240) score -= 500;
  return score;
}

// 比較は実際の物理stepを使用。ダッシュ・衝突・スタン・クールダウンも同じ制約。
function chooseFlick(bot, s, me, move, plan) {
  if (me.cooldown > 0 || me.stunT > 0 || me.dashT > 0) return null;
  const d = distance(me, s.ball);
  const reach = CONFIG.dash.speed * CONFIG.dash.duration + R;
  let target = null, reason = 'tackle';
  if (d < reach) {
    target = s.ball;
    reason = plan.target.reason;
  } else {
    target = s.units.find((u) => u.team !== bot.team && u.stunT <= 0 && distance(u, s.ball) < 90 && distance(u, me) < reach);
    if (!target) return null;
  }
  const dir = unit(target.x - me.x, target.y - me.y);
  const candidates = [null, dir];
  if (bot.profile.expert > 0.5) {
    for (const angle of [-0.3, 0.3]) candidates.push({ x: dir.x * Math.cos(angle) - dir.y * Math.sin(angle),
      y: dir.x * Math.sin(angle) + dir.y * Math.cos(angle) });
  }
  let best = null, bestScore = -Infinity;
  for (const flick of candidates) {
    const future = cloneState(s);
    const inputs = future.units.map((u) => {
      const p = bot.plans.get(u.index);
      const speed = Math.max(U.maxSpeed, Math.hypot(u.vx, u.vy));
      return { move: u.team === bot.team && p ? movement(u, { x: p.tx, y: p.ty }, p.chaser)
        : { x: u.vx / speed, y: u.vy / speed }, flick: null };
    });
    inputs[me.index] = { move, flick };
    for (let tick = 0; tick < 20; tick++) {
      step(future, inputs, DT);
      inputs[me.index].flick = null;
      if (future.phase === PHASE.GOAL || future.phase === PHASE.OVER) break;
    }
    const score = value(future, s, bot.team) - (flick ? 25 : 0);
    if (score > bestScore) { bestScore = score; best = flick; }
  }
  return best ? { ...best, reason } : null;
}

export function updateExpertBot(bot, s, intents, dt) {
  const mine = s.units.filter((u) => u.team === bot.team);
  if (![PHASE.PLAY, PHASE.KICKOFF].includes(s.phase)) {
    bot.plans.clear(); bot.timer = 0;
    for (const u of mine) intents[u.index] = { move: { x: 0, y: 0 }, flick: null };
    return;
  }
  bot.timer -= dt * 1000;
  if (bot.timer <= 0) {
    planTeam(bot, s, mine);
    bot.timer = bot.profile.rethinkMs;
  }
  for (const u of mine) {
    const plan = bot.plans.get(u.index);
    const move = movement(u, { x: plan.tx, y: plan.ty }, plan.chaser);
    const flick = chooseFlick(bot, s, u, move, plan);
    intents[u.index] = { move, flick };
    if (flick) bot.stats[flick.reason]++;
  }
}
