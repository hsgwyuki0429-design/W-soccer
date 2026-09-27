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
function flicksAlong(path, seconds, hz = 60, cfg = undefined) {
  const f = createFlickDetector(cfg);
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
    // ふつうの速さの切り返し（左端から右端まで 0.3 秒。自然に加速・減速する）
    const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));
    assert.equal(flicksAlong((t) => ({ x: 45 + 110 * ease((t - 0.2) / 0.3), y: 300 }), 0.8, hz).length, 0);
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

/** 軌跡をなぞって、最後に離す。押さえている間と離したときの発火を別々に返す。 */
function flickThenRelease(path, seconds, upDelayMs, hz = 60) {
  const f = createFlickDetector();
  const p0 = path(0);
  f.reset(p0.x, p0.y, 0);
  const held = [];
  let lastT = 0;
  for (let i = 1; i <= Math.round(seconds * hz); i++) {
    const t = i / hz;
    const p = path(t);
    const d = f.feed(p.x, p.y, t * 1000);
    if (d) held.push(d);
    lastT = t;
  }
  const end = path(lastT);
  // pointerup は最後の move と同じ座標で、少し遅れて届く
  const released = f.release(end.x, end.y, lastT * 1000 + upDelayMs);
  return { held, released };
}

for (const hz of [60, 120]) {
  test(`軽いはじき（24pxを30ms）でも突進する。初版の重さでは出なかった（${hz}Hz）`, () => {
    const path = (t) => (t < 0.2 ? { x: 100, y: 300 } : t < 0.23 ? { x: 100 + 24 * (t - 0.2) / 0.03, y: 300 } : { x: 124, y: 300 });
    const got = flicksAlong(path, 0.6, hz);
    assert.equal(got.length, 1);
    assert.ok(got[0].x > 0.95);
    const first = { ...CONFIG.stick, flickDist: 22, flickSpeed: 1100 };   // 初版の重さ
    assert.equal(flicksAlong(path, 0.6, hz, first).length, 0);
  });

  test(`はじきながら離しても突進する。遅れて届く pointerup でも出る（${hz}Hz）`, () => {
    // ゆっくり動かしてから、最後に上へ 30px を 30ms ではじいてそのまま離す
    for (const delay of [0, 30, 60]) {
      const path = (t) => (t < 0.3 ? { x: 100 + 20 * t / 0.3, y: 300 } : { x: 120, y: 300 - 30 * Math.min(1, (t - 0.3) / 0.03) });
      // 押さえている間にはじき終わる前に離す（はじいている最中の点で終わる）
      const { held, released } = flickThenRelease(path, 0.3 + 0.02, delay, hz);
      const fired = held.length ? held[0] : released;
      assert.ok(fired, `delay=${delay}ms で出る`);
      assert.ok(fired.y < -0.9, `上向き (${fired.x.toFixed(2)}, ${fired.y.toFixed(2)})`);
      assert.equal(held.length + (released ? 1 : 0), 1, '1回だけ');
    }
  });

  test(`止めてから離したとき・ゆっくり動かしながら離したときは突進しない（${hz}Hz）`, () => {
    // 右へはじかずに動かし、止めて 200ms 後に離す
    const stop = flickThenRelease((t) => ({ x: 100 + 50 * Math.min(1, t / 0.3), y: 300 }), 0.5, 0, hz);
    assert.equal(stop.held.length, 0);
    assert.equal(stop.released, null);
    // 舵取りの速さ（約330px/s）で動かしながら離す
    const moving = flickThenRelease((t) => ({ x: 100 + 330 * t, y: 300 }), 0.3, 10, hz);
    assert.equal(moving.held.length, 0);
    assert.equal(moving.released, null);
  });
}

test('離した位置で初めてはじきになる場合（最後のひと払い）も突進する', () => {
  const f = createFlickDetector();
  f.reset(100, 330, 0);
  // ゆっくり上へ（押さえている間は出ない）
  for (let t = 16; t <= 300; t += 16) assert.equal(f.feed(100, 330 - t / 10, t), null);
  // 最後の move（288ms, y=301.2）から 12ms 後、15px 上で離す（1250px/s）
  const d = f.release(100, 286.2, 300);
  assert.ok(d && d.y < -0.95, `上へ出る ${JSON.stringify(d)}`);
});

test('押さえている間にもう出ていたら、離したときには重ねて出ない', () => {
  const f = createFlickDetector();
  f.reset(100, 300, 0);
  assert.ok(f.feed(100, 270, 20));          // 30px を 20ms（出る）
  assert.equal(f.release(100, 255, 32), null);
});
