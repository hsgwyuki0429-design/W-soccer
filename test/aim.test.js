import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState, step, PHASE } from '../src/game.js';
import { aimTackle } from '../src/aim.js';

const RB = CONFIG.unit.radius + CONFIG.ball.radius;   // 駒とボールが接している中心間距離
const RU = CONFIG.unit.radius * 2;                    // 駒どうしが接している中心間距離
const GAP = CONFIG.aimBall.gap;
const DT = 1 / 60;

/** 自分の駒 units[0] だけが (600, 900) にいて、ほかは遠くに置いた状態 */
function scene() {
  const s = createState();
  s.phase = PHASE.PLAY;
  const u = s.units[0];
  u.x = 600; u.y = 900; u.vx = u.vy = 0;
  s.units.slice(1).forEach((o, i) => { o.x = 80 + i * 60; o.y = 80; o.vx = o.vy = 0; });
  s.ball.x = 1200; s.ball.y = 1500; s.ball.vx = s.ball.vy = 0;
  return s;
}
const near = (a, b, eps = 1e-9) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

test('近くへ補正：止まっているボールがすぐそばなら、駒の中心→ボールの向きに変わる', () => {
  const s = scene(), u = s.units[0];
  const d = RB + GAP * 0.5;
  s.ball.x = u.x + d * 0.6; s.ball.y = u.y - d * 0.8;
  assert.ok(near(aimTackle({ x: -1, y: 0 }, u, s), { x: 0.6, y: -0.8 }));
  // 向きが立っていない踏み込み（0,0）でも、ボールへ向く
  assert.ok(near(aimTackle({ x: 0, y: 0 }, u, s), { x: 0.6, y: -0.8 }));
});

test('近くへ補正：距離の外なら操作どおり。補正する距離を伸ばすと届く', () => {
  const s = scene(), u = s.units[0];
  const flick = { x: -1, y: 0 };
  s.ball.x = u.x + RB + GAP * 3; s.ball.y = u.y;
  assert.equal(aimTackle(flick, u, s), flick, '既定（いちばん短い）では補正しない');
  assert.ok(near(aimTackle(flick, u, s, GAP * 4), { x: 1, y: 0 }), '距離を伸ばせば補正する');
  assert.equal(aimTackle(null, u, s, GAP * 4), null, '踏み込んでいなければ何もしない');
});

test('近くへ補正：相手の駒にも向く。ボールと相手の両方が近ければ、指を払った向きに近いほう', () => {
  const s = scene(), u = s.units[0];
  const opp = s.units.find((o) => o.team !== u.team);
  const mate = s.units.find((o) => o !== u && o.team === u.team);
  // ボールは右、相手は上、味方は左（味方は狙わない）
  s.ball.x = u.x + RB + GAP * 0.5; s.ball.y = u.y;
  opp.x = u.x; opp.y = u.y - RU - GAP * 0.5;
  mate.x = u.x - RU - GAP * 0.1; mate.y = u.y;
  assert.ok(near(aimTackle({ x: 0.3, y: -1 }, u, s), { x: 0, y: -1 }), '上寄りに払えば相手へ');
  assert.ok(near(aimTackle({ x: 1, y: -0.3 }, u, s), { x: 1, y: 0 }), '右寄りに払えばボールへ');
  assert.ok(near(aimTackle({ x: -1, y: 0 }, u, s), { x: 1, y: 0 }) || near(aimTackle({ x: -1, y: 0 }, u, s), { x: 0, y: -1 }),
    '味方の向きに払っても、味方には向かない');
  // ボールが遠ければ、相手だけが候補
  s.ball.x = 1200; s.ball.y = 1500;
  assert.ok(near(aimTackle({ x: 1, y: 0 }, u, s), { x: 0, y: -1 }));
  // 潰れている相手は狙わない（上塗りできないので）
  opp.stunT = 0.5;
  const f = { x: 1, y: 0 };
  assert.equal(aimTackle(f, u, s), f);
});

test('近くへ補正：動いているボールには、当たる瞬間に踏み込みの向きがボールの面に直角（正面）になるよう向ける', () => {
  for (const [vx, vy] of [[300, 0], [-250, 120], [0, 400], [180, -180]]) {
    const s = scene(), u = s.units[0];
    // ボールは右斜め前。そこから動いている
    s.ball.x = u.x + 60; s.ball.y = u.y - 40;
    s.ball.vx = vx; s.ball.vy = vy;
    const aim = aimTackle({ x: 0, y: -1 }, u, s, GAP * 6);

    let hit = null;
    for (let t = 0; t < 40 && !hit; t++) {
      const bx = s.ball.x, by = s.ball.y, ux = u.x, uy = u.y;
      step(s, [{ move: { x: 0, y: 0 }, flick: t === 0 ? aim : null }, null, null, null], DT);
      if (s.lastTouch === 0) hit = { bx, by, ux, uy };   // 当たる直前の位置
    }
    assert.ok(hit, `v=(${vx},${vy}) で当たる`);
    // 当たる直前の中心どうしを結ぶ線と、踏み込みの向きが揃っている
    const nx = hit.bx - hit.ux, ny = hit.by - hit.uy, nl = Math.hypot(nx, ny);
    const cos = (nx * aim.x + ny * aim.y) / nl;
    assert.ok(cos > 0.99, `v=(${vx},${vy}) 正面から当たる (cos=${cos.toFixed(4)})`);
  }
});

test('近くへ補正：止まっているボールへ斜めに払っても、ボールは駒→ボールの線の向きへまっすぐ飛ぶ', () => {
  const s = scene(), u = s.units[0];
  const d = RB + GAP * 0.6;
  const want = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  s.ball.x = u.x + want.x * d; s.ball.y = u.y + want.y * d;
  const flick = aimTackle({ x: 0, y: -1 }, u, s);
  step(s, [{ move: { x: 0, y: 0 }, flick }, null, null, null], DT);
  for (let t = 0; t < 20; t++) step(s, [null, null, null, null], DT);
  const sp = Math.hypot(s.ball.vx, s.ball.vy);
  assert.ok(sp > 100, `ボールが飛んでいる (${sp.toFixed(0)})`);
  assert.ok((s.ball.vx * want.x + s.ball.vy * want.y) / sp > 0.995);
});

test('近くへ補正：補正する角度を絞ると、指を払った向きからその角度より外れた相手・ボールへは向けない', () => {
  const s = scene(), u = s.units[0];
  const opp = s.units.find((o) => o.team !== u.team);
  // ボールは真右、相手は真上
  s.ball.x = u.x + RB + GAP * 0.5; s.ball.y = u.y;
  opp.x = u.x; opp.y = u.y - RU - GAP * 0.5;
  const at = (deg) => ({ x: Math.cos((deg * Math.PI) / 180), y: -Math.sin((deg * Math.PI) / 180) });   // 0°=右, 90°=上

  // 右から30°上へ払う：ボールまで30°、相手まで60°
  assert.ok(near(aimTackle(at(30), u, s, GAP, 180), { x: 1, y: 0 }), '180°（全方向）なら近いほう＝ボール');
  assert.ok(near(aimTackle(at(30), u, s, GAP, 45), { x: 1, y: 0 }), '±45° ならボールだけが内側');
  const f = at(30);
  assert.equal(aimTackle(f, u, s, GAP, 15), f, '±15° ならどちらも外。操作どおり');
  // 真左へ払う：ボールまで180°、相手まで90°
  assert.ok(near(aimTackle(at(180), u, s, GAP, 90), { x: 0, y: -1 }), '±90° なら相手だけが内側');
  const g = at(180);
  assert.equal(aimTackle(g, u, s, GAP, 75), g, '±75° ならどちらも外');
  // 払う向きが無い踏み込みは角度で絞らない
  assert.ok(near(aimTackle({ x: 0, y: 0 }, u, s, GAP, 15), { x: 1, y: 0 }));
});
