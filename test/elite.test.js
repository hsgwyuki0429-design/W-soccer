import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { cpuTeamSize, cpuProfile } from '../src/cpu.js';
import { createState, restart, step, PHASE } from '../src/game.js';
import { createBot, updateBot } from '../src/bot.js';
import { forecastBall } from '../src/expert-bot.js';

const DT = 1 / 60;

test('Lv.79は2対2、Lv.80〜100は自分2人対CPU3人', () => {
  for (let level = 1; level <= 100; level++) {
    const count = level >= 80 ? 3 : 2;
    assert.equal(cpuTeamSize(level), count);
    const s = createState(cpuTeamSize(level));
    assert.deepEqual(s.units.map((u) => u.index), count === 3 ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]);
    assert.equal(s.units.filter((u) => u.team === 0).length, 2);
    assert.equal(s.units.filter((u) => u.team === 1).length, count);
    for (let i = 0; i < s.units.length; i++) for (let j = i + 1; j < s.units.length; j++) {
      assert.ok(Math.hypot(s.units[i].x - s.units[j].x, s.units[i].y - s.units[j].y) > CONFIG.unit.radius * 2);
    }
  }
});

test('再戦・難度切替・対人戦への復帰で人数と接触参照をリセット', () => {
  const s = createState(3);
  s.lastTouch = 4; s.kicker = 4; s.score = [1, 2];
  restart(s);
  assert.equal(s.units.length, 5);
  restart(s, 2);
  assert.equal(s.units.length, 4);
  assert.equal(s.lastTouch, -1); assert.equal(s.kicker, -1);
  assert.deepEqual(s.score, [0, 0]);
  restart(s, 3);
  assert.equal(s.units.length, 5);
});

test('3人目にも別の守備計画と入力があり、通常の物理で動く', () => {
  const s = createState(3); s.phase = PHASE.PLAY;
  const bot = createBot(1, 100), inputs = [];
  updateBot(bot, s, inputs, DT);
  assert.equal(bot.plans.size, 3);
  assert.deepEqual([...bot.plans.values()].map((p) => p.role).sort(), [0, 1, 2]);
  assert.ok(inputs[4]);
  const before = { ...s.units[4] };
  step(s, inputs, DT);
  assert.ok(Math.hypot(s.units[4].x - before.x, s.units[4].y - before.y) > 0);
  assert.ok(Math.hypot(s.units[4].vx, s.units[4].vy) <= CONFIG.dash.speed);
});

test('3人目が最後に触れたボールでも得点・ゴール後・再戦が成立', () => {
  const s = createState(3); s.phase = PHASE.PLAY;
  s.ball.x = CONFIG.field.w / 2;
  s.ball.y = CONFIG.field.h - 1; s.ball.vy = 300;
  s.lastTouch = s.kicker = 4;
  const events = step(s, [], DT);
  assert.ok(events.some((e) => e.type === 'goal' && e.team === 1 && !e.ownGoal));
  for (let i = 0; i < 100; i++) step(s, [], DT);
  assert.equal(s.units.length, 5);
  assert.equal(s.phase, PHASE.KICKOFF);
  restart(s, 3);
  assert.equal(s.units.length, 5);
});

test('Lv.100は毎フレーム判断、狙いのランダム誤差ゼロ', () => {
  const p = cpuProfile(100);
  assert.ok(p.rethinkMs <= 1000 / 60 + 1e-10);
  assert.equal(p.noise, 0);
  const s = createState(3), bot = createBot(1, 100);
  updateBot(bot, s, [], DT);
  const first = bot.plans.get(2);
  s.ball.x += 250;
  updateBot(bot, s, [], DT);
  assert.notEqual(bot.plans.get(2), first);
});

test('先読みは摩擦・壁反射・ゴールラインを考慮し、元のボールを変更しない', () => {
  const ball = { x: CONFIG.ball.radius + 1, y: 700, vx: -500, vy: 100 };
  const before = { ...ball }, path = forecastBall(ball);
  assert.deepEqual(ball, before);
  assert.ok(path.some((p) => p.vx > 0));
  assert.ok(Math.hypot(path.at(-1).vx, path.at(-1).vy) < Math.hypot(ball.vx, ball.vy));
  const shot = forecastBall({ x: CONFIG.field.w / 2, y: CONFIG.field.h - 100, vx: 0, vy: 600 });
  assert.ok(shot.at(-1).y >= CONFIG.field.h);
});

test('物理予測中も試合・相手の入力を改変せず、人数分の合法入力だけを返す', () => {
  const s = createState(3); s.phase = PHASE.PLAY;
  s.units[2].x = s.ball.x; s.units[2].y = s.ball.y - 45;
  const before = structuredClone(s), human = { move: { x: 0.3, y: 0.4 }, flick: null };
  const intents = [human, human];
  updateBot(createBot(1, 100), s, intents, DT);
  assert.deepEqual(s, before);
  assert.equal(intents[0], human); assert.equal(intents[1], human);
  for (const i of [2, 3, 4]) {
    assert.ok(Number.isFinite(intents[i].move.x) && Number.isFinite(intents[i].move.y));
    assert.ok(Math.hypot(intents[i].move.x, intents[i].move.y) <= 1.000001);
  }
});
