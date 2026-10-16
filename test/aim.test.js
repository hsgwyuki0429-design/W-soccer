import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState, step, PHASE } from '../src/game.js';
import { aimAtNearBall } from '../src/aim.js';

const R = CONFIG.unit.radius + CONFIG.ball.radius;   // 接している中心間距離
const GAP = CONFIG.aimBall.gap;

test('近いボールへ向ける：ボールがすぐそばなら、駒の中心→ボールの向きに変わる', () => {
  const u = { x: 100, y: 100 };
  const d = R + GAP * 0.5;
  const ball = { x: 100 + d * 0.6, y: 100 - d * 0.8 };
  const a = aimAtNearBall({ x: -1, y: 0 }, u, ball);
  assert.ok(Math.abs(a.x - 0.6) < 1e-9 && Math.abs(a.y + 0.8) < 1e-9);
  // 向きが立っていない踏み込み（0,0）でも、ボールへ向く
  const z = aimAtNearBall({ x: 0, y: 0 }, u, ball);
  assert.ok(Math.abs(z.x - 0.6) < 1e-9);
});

test('近いボールへ向ける：離れていれば操作どおり。踏み込んでいなければ何もしない', () => {
  const u = { x: 100, y: 100 };
  const flick = { x: -1, y: 0 };
  assert.equal(aimAtNearBall(flick, u, { x: 100 + R + GAP + 1, y: 100 }), flick);
  assert.equal(aimAtNearBall(null, u, { x: 100 + R, y: 100 }), null);
});

test('近いボールへ向ける：操作の向きがずれていても、ボールは駒→ボールの線の向きへまっすぐ飛ぶ', () => {
  const s = createState();
  s.phase = PHASE.PLAY;
  const u = s.units[0];
  u.x = 600; u.y = 900; u.vx = u.vy = 0;
  for (const o of s.units.slice(1)) { o.x = 100; o.y = 100; }
  const d = R + GAP * 0.6;
  const want = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };   // 右斜め前にボール
  s.ball.x = u.x + want.x * d; s.ball.y = u.y + want.y * d; s.ball.vx = s.ball.vy = 0;

  const flick = aimAtNearBall({ x: 0, y: -1 }, u, s.ball);   // 操作は真上
  step(s, [{ move: { x: 0, y: 0 }, flick }, null, null, null], 1 / 60);
  for (let t = 0; t < 20; t++) step(s, [null, null, null, null], 1 / 60);
  const sp = Math.hypot(s.ball.vx, s.ball.vy);
  assert.ok(sp > 100, `ボールが飛んでいる (${sp.toFixed(0)})`);
  const cos = (s.ball.vx * want.x + s.ball.vy * want.y) / sp;
  assert.ok(cos > 0.995, `駒→ボールの向きへ飛ぶ (cos=${cos.toFixed(4)})`);
});
