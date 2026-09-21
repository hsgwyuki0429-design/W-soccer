import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { cpuProfile, normalizeCpuLevel } from '../src/cpu.js';
import { createBot, updateBot } from '../src/bot.js';
import { createState, step, PHASE } from '../src/game.js';

const DT = 1 / 60;
function seedRandom(t, seed = 42) {
  t.mock.method(Math, 'random', () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  });
}

test('CPUレベルは1〜100の整数。不正値・未指定はLv.3', () => {
  for (const value of [undefined, null, '', ' ', {}, [], true, 'bad', NaN, Infinity]) {
    assert.equal(normalizeCpuLevel(value), 3);
  }
  assert.equal(normalizeCpuLevel(-10), 1);
  assert.equal(normalizeCpuLevel(500), 100);
  assert.equal(normalizeCpuLevel('52'), 52);
  assert.equal(normalizeCpuLevel(5.7), 6);
});

test('Lv.3は従来の判断設定。全100段階で反応・精度が向上する', () => {
  const baseline = cpuProfile(3);
  for (const [key, value] of Object.entries(CONFIG.bot)) assert.deepEqual(baseline[key], value);
  assert.equal(baseline.tactics, 0);
  assert.equal(baseline.prediction, 1);
  assert.equal(baseline.tackleProbability, CONFIG.bot.tackleChance);
  for (let level = 2; level <= 100; level++) {
    const a = cpuProfile(level - 1), b = cpuProfile(level);
    assert.ok(b.rethinkMs < a.rethinkMs);
    assert.ok(b.noise < a.noise);
    assert.ok(b.aimSlack <= a.aimSlack);
    assert.ok(b.tackleProbability >= 0 && b.tackleProbability <= 1);
  }
});

test('全レベル・両駒が全力移動でき、人間と同じ入力倍率になる', () => {
  for (let level = 1; level <= 100; level++) {
    const s = createState(), bot = createBot(1, level), intents = [];
    bot.timer = 1000;
    for (const u of s.units.filter((u) => u.team === 1)) {
      bot.plans.set(u.index, { tx: u.x + 200, ty: u.y, options: [], tackle: null });
    }
    updateBot(bot, s, intents, DT);
    for (const index of [2, 3]) assert.deepEqual(intents[index].move, { x: 1, y: 0 });
  }
});

test('CPUの判断は試合状態と共通設定を書き換えず、有限で合法な入力だけを出す', (t) => {
  seedRandom(t);
  const config = structuredClone(CONFIG);
  for (let level = 1; level <= 100; level++) {
    const s = createState();
    const bots = [createBot(0, level), createBot(1, level)];
    for (let tick = 0; tick < 360; tick++) {
      const intents = [];
      const before = structuredClone(s);
      for (const bot of bots) updateBot(bot, s, intents, DT);
      assert.deepEqual(s, before);
      for (const intent of intents) {
        assert.ok(Number.isFinite(intent.move.x) && Number.isFinite(intent.move.y));
        assert.ok(Math.hypot(intent.move.x, intent.move.y) <= 1.000001);
        if (intent.flick) assert.ok(Number.isFinite(intent.flick.x) && Number.isFinite(intent.flick.y));
      }
      step(s, intents, DT);
      for (const body of [...s.units, s.ball]) {
        for (const key of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(body[key]));
      }
    }
  }
  assert.deepEqual(CONFIG, config);
});

test('レベルで物理は変わらない。同じ入力で移動・踏み込み・キック結果が一致', () => {
  let expected;
  for (let level = 1; level <= 100; level++) {
    const bot = createBot(1, level), s = createState();
    const unused = [];
    updateBot(bot, s, unused, DT);
    s.phase = PHASE.PLAY;
    s.units[2].x = CONFIG.field.w / 2;
    s.units[2].y = CONFIG.field.h / 2 - CONFIG.unit.radius - CONFIG.ball.radius - 2;
    for (let tick = 0; tick < 60; tick++) {
      const intents = [];
      intents[2] = { move: { x: 0, y: 1 }, flick: tick === 0 ? { x: 0, y: 1 } : null };
      step(s, intents, DT);
    }
    const actual = { units: s.units, ball: s.ball, score: s.score };
    if (!expected) expected = structuredClone(actual);
    assert.deepEqual(actual, expected);
  }
});

test('高レベルは中央を守る相手から離れたシュートコースを選ぶ', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  function shootDirection(level) {
    const s = createState(); s.phase = PHASE.PLAY;
    s.ball.x = CONFIG.field.w / 2; s.ball.y = CONFIG.field.h - 200;
    const [foe, otherFoe, me, mate] = s.units;
    foe.x = s.ball.x; foe.y = CONFIG.field.h - 35;
    otherFoe.x = 100; otherFoe.y = 100;
    me.x = s.ball.x; me.y = s.ball.y - 80;
    mate.x = 100; mate.y = 100;
    const bot = createBot(1, level);
    updateBot(bot, s, [], DT);
    const shot = bot.plans.get(me.index).options.find((o) => o.reason === 'shoot');
    assert.ok(shot);
    return shot.x;
  }
  assert.equal(shootDirection(3), 0);
  assert.ok(Math.abs(shootDirection(100)) > 0.1);
});

test('同じレベルのCPUは共通設定を持ち、作り直すと古い判断を持ち越さない', () => {
  const first = createBot(1, 100);
  updateBot(first, createState(), [], DT);
  const replay = createBot(1, 1);
  assert.equal(replay.profile.level, 1);
  assert.equal(replay.timer, 0);
  assert.equal(replay.plans.size, 0);
  assert.equal(first.profile.level, 100);
  assert.deepEqual(createBot(0, 50).profile, createBot(1, 50).profile);
});
