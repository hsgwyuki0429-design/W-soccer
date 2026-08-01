// game.js — 試合ロジックと物理
// 純粋モジュール。DOM / Canvas / Audio / window に一切触れないこと。
// 入力は「意図」だけを受け取り、出力は「試合状態」と「発生イベント」だけ。
//
//   intent = { move: {x, y}, flick: {x, y} | null }
//   intents = [intent, intent, intent, intent]   // units と同じ並び
//
// キックとダッシュの振り分けは flick を受けた側（ここ）が決める。
// 呼び出し側はボールとの距離を知る必要がない。

import { CONFIG, TEAM_PLAYER, TEAM_BOT } from './config.js';

export const PHASE = {
  KICKOFF: 'kickoff',   // センターのボールに、失点した側が触れるまで待つ
  PLAY: 'play',
  GOAL: 'goal',
  OVER: 'over',
};

const F = CONFIG.field;
const S = CONFIG.world.scale;              // 距離はこれに追従
const V = S * CONFIG.world.pace;           // 速度はこれに追従（PACE を含む）
const goalLeft = () => (F.w - F.goalWidth) / 2;
const goalRight = () => (F.w + F.goalWidth) / 2;

export function goalMouth() {
  return { left: goalLeft(), right: goalRight() };
}

// ---------------------------------------------------------------- helpers

const len = (x, y) => Math.hypot(x, y);

function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function limitSpeed(body, max) {
  const s = Math.hypot(body.vx, body.vy);
  if (s > max) {
    const k = max / s;
    body.vx *= k;
    body.vy *= k;
  }
}

// ---------------------------------------------------------------- state

function makeUnit(index, team, x, y) {
  return {
    index,
    team,
    side: index % 2,     // 0 = 左担当, 1 = 右担当（固定・入れ替わらない）
    x, y,
    vx: 0, vy: 0,
    cooldown: 0,
    dashT: 0,
    dashX: 0, dashY: 0,
    contact: false,      // 直前ステップでボールに触れていたか（イベント連打防止）
    faceX: 0,
    faceY: team === TEAM_PLAYER ? -1 : 1,
  };
}

export function createState() {
  const s = {
    time: 0,
    phase: PHASE.KICKOFF,
    phaseT: 0,
    score: [0, 0],
    winner: -1,
    units: [
      makeUnit(0, TEAM_PLAYER, 150 * S, 600 * S),
      makeUnit(1, TEAM_PLAYER, 300 * S, 600 * S),
      makeUnit(2, TEAM_BOT, 150 * S, 200 * S),
      makeUnit(3, TEAM_BOT, 300 * S, 200 * S),
    ],
    ball: { x: F.w / 2, y: 665 * S, vx: 0, vy: 0 },
    heatT: 0,          // 秒。0..rampSeconds
    kicker: -1,        // 直近にボールを蹴った駒（受け手が触るまで有効）
    lastTouch: -1,
    chain: 0,          // 自陣内パス連鎖（コンボ）
    chainTeam: -1,
    kickoffTeam: TEAM_PLAYER,
    stuckT: 0,
    squeezeT: 0,
    wallCool: 0,
    events: [],
  };
  placeKickoff(s, TEAM_PLAYER);
  return s;
}

export function restart(s) {
  s.score[0] = 0;
  s.score[1] = 0;
  s.winner = -1;
  s.time = 0;
  s.heatT = 0;
  placeKickoff(s, TEAM_PLAYER);
  s.phase = PHASE.KICKOFF;
  s.phaseT = 0;
  s.events.length = 0;
}

// 失点した側（= possess）のボールで再開。ボールは必ずセンター。
// 蹴る側は自陣側からセンターへ寄せ、守る側は自陣に下げる。
function placeKickoff(s, possess) {
  const cy = F.h / 2;
  for (const u of s.units) {
    // team0 の自陣は下（y 大）、team1 は上
    const own = u.team === TEAM_PLAYER ? 1 : -1;
    u.x = (u.side === 0 ? 150 : 300) * S;
    u.y = cy + own * (u.team === possess ? 65 : 190) * S;   // 設計値(450x800基準)なので S 倍
    u.vx = u.vy = 0;
    u.cooldown = 0;
    u.dashT = 0;
    u.contact = false;
    u.faceX = 0;
    u.faceY = u.team === TEAM_PLAYER ? -1 : 1;
  }
  s.ball.x = F.w / 2;
  s.ball.y = cy;
  s.ball.vx = 0;
  s.ball.vy = 0;
  s.kicker = -1;
  s.lastTouch = -1;
  s.chain = 0;
  s.chainTeam = -1;
  s.stuckT = 0;
  s.squeezeT = 0;
  s.heatT = 0;
  s.possess = possess;
  s.kickoffTeam = possess;   // このキックオフで動けるのはこちらだけ
}

export function heatRatio(s) {
  return clamp(s.heatT / CONFIG.heat.rampSeconds, 0, 1);
}

export function heatMultiplier(s) {
  return 1 + heatRatio(s) * (CONFIG.heat.maxMultiplier - 1);
}

export function isMatchPoint(s) {
  return s.score[0] === CONFIG.match.winScore - 1 &&
         s.score[1] === CONFIG.match.winScore - 1;
}

function emit(s, e) {
  s.events.push(e);
}

// ---------------------------------------------------------------- step

const NO_INTENT = { move: { x: 0, y: 0 }, flick: null };

/**
 * 1ステップ進める（固定タイムステップ想定）。
 * @returns {Array} このステップで発生したイベント（次の step で破棄される）
 */
export function step(s, intents, dt) {
  s.events.length = 0;

  switch (s.phase) {
    case PHASE.GOAL:
      s.phaseT -= dt;
      if (s.phaseT <= 0) {
        if (s.winner >= 0) {
          s.phase = PHASE.OVER;
          emit(s, { type: 'matchend', winner: s.winner });
        } else {
          placeKickoff(s, s.concededBy);
          s.phase = PHASE.KICKOFF;
          s.phaseT = 0;
        }
      }
      return s.events;

    case PHASE.OVER:
      return s.events;
  }

  // ---- KICKOFF / PLAY ----
  // キックオフ中も物理はそのまま動かす。違うのは2点だけ：
  //   守る側は動けない / ボールに触れた瞬間に試合が始まる。
  const kickoff = s.phase === PHASE.KICKOFF;

  s.wallCool = Math.max(0, (s.wallCool || 0) - dt);
  if (kickoff) {
    s.phaseT += dt;
  } else {
    s.time += dt;
    s.heatT = Math.min(s.heatT + dt, CONFIG.heat.rampSeconds);
  }
  const heat = heatMultiplier(s);

  for (let i = 0; i < s.units.length; i++) {
    const u = s.units[i];
    const held = kickoff && u.team !== s.kickoffTeam;
    applyIntent(s, u, held ? NO_INTENT : (intents[i] || NO_INTENT), dt, heat);
  }

  integrateUnits(s, dt);
  integrateBall(s, dt, heat);

  resolveUnitUnit(s);
  resolveUnitBall(s, heat, dt);
  resolvePosts(s);

  if (kickoff) {
    // 蹴る側が触れたら開始。誰も触らないまま固まらないよう保険の時間切れも見る。
    const touched = s.lastTouch >= 0 && s.units[s.lastTouch].team === s.kickoffTeam;
    if (touched || s.phaseT >= CONFIG.match.kickoffTimeout) {
      s.phase = PHASE.PLAY;
      emit(s, { type: 'kickoff', team: s.kickoffTeam, touched });
    }
    return s.events;
  }

  checkStuck(s, dt);
  checkGoal(s);

  return s.events;
}

// ---------------------------------------------------------------- intent

function applyIntent(s, u, intent, dt, heat) {
  const mv = intent.move || NO_INTENT.move;
  const mag = clamp(len(mv.x, mv.y), 0, 1);

  if (u.cooldown > 0) u.cooldown = Math.max(0, u.cooldown - dt);

  // 向き（キーボード時のフリック方向などに使う）
  if (mag > 0.15) {
    const n = norm(mv.x, mv.y);
    u.faceX = n.x;
    u.faceY = n.y;
  }

  // フリック解決：ボール至近ならキック、そうでなければダッシュ。
  if (intent.flick && u.cooldown <= 0) {
    const d = norm(intent.flick.x, intent.flick.y);
    if (d.x !== 0 || d.y !== 0) {
      const b = s.ball;
      const dist = Math.hypot(b.x - u.x, b.y - u.y);
      const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

      if (dist <= reach) {
        const speed = CONFIG.kick.speed * heat;
        b.vx = d.x * speed;
        b.vy = d.y * speed;
        // 蹴った瞬間に足元から離す（吸着を作らないための最小限の押し出し）
        const away = norm(b.x - u.x, b.y - u.y);
        const sep = CONFIG.unit.radius + CONFIG.ball.radius + 0.5;
        b.x = u.x + (away.x || d.x) * sep;
        b.y = u.y + (away.y || d.y) * sep;

        registerTouch(s, u, true);
        u.cooldown = CONFIG.unit.cooldown;
        u.faceX = d.x; u.faceY = d.y;
        emit(s, {
          type: 'kick',
          unit: u.index, team: u.team,
          x: b.x, y: b.y, dx: d.x, dy: d.y,
          power: speed / CONFIG.kick.speed,
        });
      } else {
        u.dashT = CONFIG.dash.duration;
        u.dashX = d.x;
        u.dashY = d.y;
        u.cooldown = CONFIG.unit.cooldown;
        u.faceX = d.x; u.faceY = d.y;
        emit(s, { type: 'dash', unit: u.index, team: u.team, x: u.x, y: u.y, dx: d.x, dy: d.y });
      }
    }
  }

  // 移動
  if (u.dashT > 0) {
    u.dashT = Math.max(0, u.dashT - dt);
    u.vx = u.dashX * CONFIG.dash.speed;
    u.vy = u.dashY * CONFIG.dash.speed;
  } else {
    const targetX = mv.x * CONFIG.unit.maxSpeed;
    const targetY = mv.y * CONFIG.unit.maxSpeed;
    const k = CONFIG.unit.accelSmoothing;
    u.vx += (targetX - u.vx) * k;
    u.vy += (targetY - u.vy) * k;
  }
}

// ---------------------------------------------------------------- physics

function integrateUnits(s, dt) {
  const r = CONFIG.unit.radius;
  for (const u of s.units) {
    u.x += u.vx * dt;
    u.y += u.vy * dt;
    if (u.x < r) { u.x = r; u.vx = Math.max(0, u.vx); }
    if (u.x > F.w - r) { u.x = F.w - r; u.vx = Math.min(0, u.vx); }
    if (u.y < r) { u.y = r; u.vy = Math.max(0, u.vy); }
    if (u.y > F.h - r) { u.y = F.h - r; u.vy = Math.min(0, u.vy); }
  }
}

function integrateBall(s, dt, heat) {
  const b = s.ball;
  const r = CONFIG.ball.radius;

  b.vx *= Math.pow(CONFIG.ball.frictionPerSec, dt);
  b.vy *= Math.pow(CONFIG.ball.frictionPerSec, dt);
  limitSpeed(b, CONFIG.ball.maxSpeed * heat);

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  const bounce = F.wallBounce;
  if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * bounce; wall(s, b); }
  if (b.x > F.w - r) { b.x = F.w - r; b.vx = -Math.abs(b.vx) * bounce; wall(s, b); }

  const gl = goalLeft(), gr = goalRight();
  const inMouth = b.x > gl && b.x < gr;
  if (!inMouth) {
    if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * bounce; wall(s, b); }
    if (b.y > F.h - r) { b.y = F.h - r; b.vy = -Math.abs(b.vy) * bounce; wall(s, b); }
  }
}

function wall(s, b) {
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > 60 * V && s.wallCool <= 0) {
    s.wallCool = 0.08;
    emit(s, { type: 'wall', x: b.x, y: b.y, strength: clamp(sp / (500 * V), 0, 1) });
  }
}

// 駒同士は敵味方問わず柔らかく押し合う（自分の2駒も例外なし）
function resolveUnitUnit(s) {
  const r2 = CONFIG.unit.radius * 2;
  for (let i = 0; i < s.units.length; i++) {
    for (let j = i + 1; j < s.units.length; j++) {
      const a = s.units[i], b = s.units[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= r2) continue;
      if (d < 1e-4) { dx = 1; dy = 0; d = 1e-4; }
      const nx = dx / d, ny = dy / d;
      const overlap = (r2 - d) * 0.5;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;

      const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rvn < 0) {
        const imp = -(1 + CONFIG.unit.bounce) * rvn * 0.5;
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
        if (Math.abs(rvn) > 180 * V) {
          emit(s, {
            type: 'bump',
            x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
            strength: clamp(Math.abs(rvn) / (600 * V), 0, 1),
          });
        }
      }
    }
  }
}

// 駒とボールの衝突。マグネットも吸着も無し、素直な反発だけ。
function resolveUnitBall(s, heat, dt) {
  const b = s.ball;
  const rr = CONFIG.unit.radius + CONFIG.ball.radius;
  for (const u of s.units) {
    let dx = b.x - u.x, dy = b.y - u.y;
    let d = Math.hypot(dx, dy);
    if (d >= rr) { u.contact = false; continue; }
    if (d < 1e-4) { dx = 0; dy = 1; d = 1e-4; }
    const nx = dx / d, ny = dy / d;

    b.x = u.x + nx * rr;
    b.y = u.y + ny * rr;

    const rvx = b.vx - u.vx, rvy = b.vy - u.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const j = -(1 + CONFIG.ball.bounce) * vn;
      b.vx += j * nx;
      b.vy += j * ny;
      limitSpeed(b, CONFIG.ball.maxSpeed * heat);

      // 接触の「入り」だけをイベントにする。押し続けている間は鳴らさない。
      if (!u.contact) {
        emit(s, {
          type: 'touch',
          unit: u.index, team: u.team,
          x: b.x, y: b.y,
          strength: clamp(Math.abs(vn) / (420 * V), 0, 1),
        });
      }
      registerTouch(s, u, false);
    }
    u.contact = true;
  }

  clampBall(b);
  unpinBall(s, dt);
}

function clampBall(b) {
  const r = CONFIG.ball.radius;
  const gl = goalLeft(), gr = goalRight();
  if (b.x < r) b.x = r;
  if (b.x > F.w - r) b.x = F.w - r;
  if (!(b.x > gl && b.x < gr)) {
    if (b.y < r) b.y = r;
    if (b.y > F.h - r) b.y = F.h - r;
  }
}

// 壁と駒に挟まれたボールは、壁に沿って横へ逃がす。
// （挟んだまま押し続ける = 実質的な吸着になってしまうため）
function unpinBall(s, dt) {
  const b = s.ball;
  const r = CONFIG.ball.radius;
  const rr = CONFIG.unit.radius + r;
  const gl = goalLeft(), gr = goalRight();
  const inMouth = b.x > gl && b.x < gr;

  const vertical = b.x <= r + 0.5 || b.x >= F.w - r - 0.5;      // 左右の壁
  const horizontal = !inMouth && (b.y <= r + 0.5 || b.y >= F.h - r - 0.5);

  let squeezed = false;

  if (vertical || horizontal) {
    for (const u of s.units) {
      const dx = b.x - u.x, dy = b.y - u.y;
      if (Math.hypot(dx, dy) >= rr - 0.5) continue;
      squeezed = true;

      if (vertical && !horizontal) {
        const need = Math.sqrt(Math.max(1, rr * rr - dx * dx));
        const sign = dy >= 0 ? 1 : -1;
        b.y = u.y + sign * need;
        b.vy += sign * 110 * V;
      } else if (horizontal && !vertical) {
        const need = Math.sqrt(Math.max(1, rr * rr - dy * dy));
        const sign = dx >= 0 ? 1 : -1;
        b.x = u.x + sign * need;
        b.vx += sign * 110 * V;
      }
    }
    clampBall(b);
  }

  // 逃げ場のない角での押し込み。一定時間続いたら中央側へ弾き出す。
  if (squeezed && stillOverlapping(s)) {
    s.squeezeT += dt;
    if (s.squeezeT > 0.3) {
      const n = norm(F.w / 2 - b.x, F.h / 2 - b.y);
      b.x += n.x * (rr + 2);
      b.y += n.y * (rr + 2);
      b.vx = n.x * 260 * V;
      b.vy = n.y * 260 * V;
      s.squeezeT = 0;
      clampBall(b);
      emit(s, { type: 'nudge', x: b.x, y: b.y });
    }
  } else {
    s.squeezeT = 0;
  }
}

function stillOverlapping(s) {
  const rr = CONFIG.unit.radius + CONFIG.ball.radius - 0.5;
  for (const u of s.units) {
    if (Math.hypot(s.ball.x - u.x, s.ball.y - u.y) < rr) return true;
  }
  return false;
}

// ゴールポストは円として扱う（跳ね返りの面白さのため）
function resolvePosts(s) {
  const gl = goalLeft(), gr = goalRight();
  const posts = [
    { x: gl, y: 0 }, { x: gr, y: 0 },
    { x: gl, y: F.h }, { x: gr, y: F.h },
  ];
  const b = s.ball;
  for (const p of posts) {
    circleVsPost(b, CONFIG.ball.radius, p, CONFIG.field.wallBounce, s);
    for (const u of s.units) circleVsPost(u, CONFIG.unit.radius, p, 0, null);
  }
}

function circleVsPost(body, radius, p, bounce, s) {
  const rr = radius + CONFIG.field.postRadius;
  let dx = body.x - p.x, dy = body.y - p.y;
  let d = Math.hypot(dx, dy);
  if (d >= rr) return;
  if (d < 1e-4) { dx = 0; dy = 1; d = 1e-4; }
  const nx = dx / d, ny = dy / d;
  body.x = p.x + nx * rr;
  body.y = p.y + ny * rr;
  const vn = body.vx * nx + body.vy * ny;
  if (vn < 0) {
    body.vx -= (1 + bounce) * vn * nx;
    body.vy -= (1 + bounce) * vn * ny;
    if (s) emit(s, { type: 'post', x: body.x, y: body.y });
  }
}

// ---------------------------------------------------------------- touch / pass

function registerTouch(s, u, isKick) {
  // 直前に別の味方が蹴ったボールに触れた = パス成立
  if (s.kicker >= 0 && s.kicker !== u.index) {
    const prev = s.units[s.kicker];
    if (prev.team === u.team) {
      s.chain = s.chainTeam === u.team ? s.chain + 1 : 1;
      s.chainTeam = u.team;
      emit(s, {
        type: 'pass',
        team: u.team,
        from: prev.index, to: u.index,
        fx: prev.x, fy: prev.y, tx: u.x, ty: u.y,
        chain: s.chain,
      });
    } else {
      // ボールを失った：コンボリセット（音は鳴らさない）
      s.chain = 0;
      s.chainTeam = -1;
    }
  } else if (s.lastTouch >= 0 && s.units[s.lastTouch].team !== u.team) {
    s.chain = 0;
    s.chainTeam = -1;
  }

  s.lastTouch = u.index;
  s.possess = u.team;
  s.kicker = isKick ? u.index : -1;
}

// ---------------------------------------------------------------- stuck / goal

function checkStuck(s, dt) {
  const b = s.ball;
  if (Math.hypot(b.vx, b.vy) < CONFIG.match.stuckSpeed) {
    s.stuckT += dt;
    if (s.stuckT >= CONFIG.match.stuckSeconds) {
      const n = norm(F.w / 2 - b.x, F.h / 2 - b.y);
      b.vx += n.x * 160 * V;
      b.vy += n.y * 160 * V;
      s.stuckT = 0;
      emit(s, { type: 'nudge', x: b.x, y: b.y });
    }
  } else {
    s.stuckT = 0;
  }
}

function checkGoal(s) {
  const b = s.ball;
  const gl = goalLeft(), gr = goalRight();
  if (!(b.x > gl && b.x < gr)) return;

  let scorer = -1;
  if (b.y <= 0) scorer = TEAM_PLAYER;        // 上のゴール = プレイヤーの攻撃方向
  else if (b.y >= F.h) scorer = TEAM_BOT;
  if (scorer < 0) return;

  const conceded = 1 - scorer;
  s.score[scorer]++;
  // ネットの中へ少しだけ押し込む（線上でピタッと止まらないように）
  b.y = scorer === TEAM_PLAYER
    ? -F.goalDepth * 0.45
    : F.h + F.goalDepth * 0.45;
  b.vx = 0; b.vy = 0;

  s.concededBy = conceded;
  s.phase = PHASE.GOAL;
  s.phaseT = CONFIG.match.goalPause;
  if (s.score[scorer] >= CONFIG.match.winScore) s.winner = scorer;

  // オウンゴールは「失点側が蹴って、その後だれも触らずに入った」場合だけ。
  // s.kicker は誰かが触った時点で -1 になるので、そのまま使える。
  // 守備に当たって入った失点まで自殺点にすると、ほとんどの得点が
  // オウンゴール表記になってしまう（実測で約半分）。
  const own = s.kicker >= 0 && s.units[s.kicker].team === conceded;
  emit(s, { type: 'goal', team: scorer, ownGoal: own, x: b.x, y: b.y, chain: s.chain });

  s.chain = 0;
  s.chainTeam = -1;
  s.kicker = -1;
}
