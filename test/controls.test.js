import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState, step, PHASE } from '../src/game.js';
import { createFlickDetector } from '../src/input.js';

const DT = 1 / 60;
const RR = CONFIG.unit.radius + CONFIG.ball.radius;

/** 駒の真上（-y）にボールを置き、deg だけ傾けた向きへ踏み込む。飛んだ向き（度）と速さを返す。 */
function kickAt(deg, flick) {
  const s = createState();
  s.phase = PHASE.PLAY;
  for (const u of s.units) { u.x = 100; u.y = 100; }
  const u = s.units[0];
  u.x = 600; u.y = 900;
  s.ball.x = u.x; s.ball.y = u.y - RR - 4;
  const r = (deg - 90) * Math.PI / 180;   // 0° = 真上
  const intents = [{ move: { x: 0, y: 0 }, flick: flick || { x: Math.cos(r), y: Math.sin(r) } }, null, null, null];
  for (let t = 0; t < 30; t++) {
    const ev = step(s, intents, DT);
    intents[0].flick = null;
    if (ev.some((e) => e.type === 'kick')) {
      return { angle: Math.atan2(s.ball.vy, s.ball.vx) * 180 / Math.PI + 90, speed: Math.hypot(s.ball.vx, s.ball.vy) };
    }
  }
  return null;
}

test('キックは踏み込んだ向きへ飛ぶ（体の置き方だけで狙わなくてよい）', () => {
  for (const deg of [-30, -15, 0, 15, 30]) {
    const k = kickAt(deg);
    assert.ok(k, `${deg}°で当たる`);
    assert.ok(Math.abs(k.angle - deg) < 1, `${deg}°へ踏み込んだら ${k.angle.toFixed(1)}°へ飛んだ`);
    assert.ok(k.speed > CONFIG.kick.speed * 0.9, `${deg}°でも蹴ったと分かる強さ (${k.speed.toFixed(0)})`);
  }
});

test('芯で当てるほど強く、かすめるほど弱い。寝すぎた向きは面の側へ寄る', () => {
  const center = kickAt(0), side = kickAt(30), graze = kickAt(60);
  assert.ok(center.speed > side.speed && side.speed > graze.speed);
  // 当たった面から maxAngle を超えて寝た向きへは飛ばない
  assert.ok(graze.angle < 60);
});

test('向きを渡さない踏み込み（キーボード）は、駒が向いている方へ出る', () => {
  const s = createState();
  s.phase = PHASE.PLAY;
  const u = s.units[0];
  u.x = 600; u.y = 900;
  s.ball.x = 100; s.ball.y = 100;
  // 右へ動かして向きを作ってから、向き無しで踏み込む
  for (let t = 0; t < 20; t++) step(s, [{ move: { x: 1, y: 0 }, flick: null }, null, null, null], DT);
  step(s, [{ move: { x: 0, y: 0 }, flick: { x: 0, y: 0 } }, null, null, null], DT);
  assert.ok(u.dashT > 0);
  assert.ok(u.vx > 0 && Math.abs(u.vy) < 1e-6, `右へ踏み込む (${u.vx}, ${u.vy})`);
});

// ---------------------------------------------------------------- はじき

/**
 * 指の軌跡を hz の間隔で流し込み、撃った向きの一覧を返す。
 * path(t) は t 秒後の指の位置（CSS px）。
 */
function flicksAlong(path, seconds, hz = 60) {
  const f = createFlickDetector();
  const p0 = path(0);
  f.reset(p0.x, p0.y, 0);
  const out = [];
  for (let i = 1; i <= Math.round(seconds * hz); i++) {
    const t = i / hz;
    const p = path(t);
    const d = f.feed(p.x, p.y, t * 1000);
    if (d) out.push({ t, ...d });
  }
  return out;
}

for (const hz of [60, 120]) {
  test(`ふつうの舵取りでは突進しない（${hz}Hz）`, () => {
    // ゆっくり倒す → 大きく円を描く → 左端から右端へ切り返す
    assert.equal(flicksAlong((t) => ({ x: 100 + 60 * Math.min(1, t / 0.3), y: 300 }), 1, hz).length, 0);
    assert.equal(flicksAlong((t) => ({ x: 100 + 55 * Math.cos(t * 6), y: 300 + 55 * Math.sin(t * 6) }), 2, hz).length, 0);
    assert.equal(flicksAlong((t) => ({ x: 100 + Math.max(-55, Math.min(55, -55 + 110 * (t - 0.2) / 0.15)), y: 300 }), 0.6, hz).length, 0);
  });

  test(`指を離さずにはじくと、その向きへ1回だけ突進する（${hz}Hz）`, () => {
    // 右へ動かしてから、上へ 60px を 40ms ではじき、そのまま押さえ続ける
    const path = (t) => {
      if (t < 0.3) return { x: 100 + 40 * t / 0.3, y: 300 };
      if (t < 0.34) return { x: 140, y: 300 - 60 * (t - 0.3) / 0.04 };
      return { x: 140, y: 240 };
    };
    const got = flicksAlong(path, 1, hz);
    assert.equal(got.length, 1);
    assert.ok(got[0].y < -0.95, `上向き (${got[0].x.toFixed(2)}, ${got[0].y.toFixed(2)})`);
    assert.ok(got[0].t >= 0.3 && got[0].t <= 0.36, `はじいている最中に出る (${got[0].t})`);
  });

  test(`はじいて止めたら、次のはじきでまた突進できる（${hz}Hz）`, () => {
    const path = (t) => {
      if (t < 0.04) return { x: 100 + 60 * t / 0.04, y: 300 };            // 右へはじく
      if (t < 0.5) return { x: 160, y: 300 };                              // 止める
      if (t < 0.54) return { x: 160 - 60 * (t - 0.5) / 0.04, y: 300 };     // 左へはじく
      return { x: 100, y: 300 };
    };
    const got = flicksAlong(path, 1, hz);
    assert.equal(got.length, 2);
    assert.ok(got[0].x > 0.95 && got[1].x < -0.95);
  });
}
