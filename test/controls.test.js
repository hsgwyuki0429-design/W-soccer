import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState, step, PHASE } from '../src/game.js';

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

test('向きを渡さない踏み込み（タップ）は、駒が向いている方へ出る', () => {
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
