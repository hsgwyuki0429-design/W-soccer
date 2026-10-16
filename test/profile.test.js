import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, eloDelta, cleanName, START_RATING } from '../src/profile.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('レート：同じレートなら勝ちで +16・負けで -16、格上に勝つほど大きく上がる', () => {
  assert.equal(eloDelta(1500, 1500, 1), 16);
  assert.equal(eloDelta(1500, 1500, 0), -16);
  assert.ok(eloDelta(1500, 1700, 1) > 16);
  assert.ok(eloDelta(1500, 1300, 1) < 16);
});

test('成績：始まった試合だけを数え、勝ち負けとレートを端末に保存する', () => {
  const st = memStorage();
  const p = createProfile(st);
  assert.equal(p.rating, START_RATING);
  assert.equal(p.finish(true), null, '始まっていない試合は数えない');
  p.begin(1500);
  const r = p.finish(true);
  assert.deepEqual(r, { delta: 16, rating: 1516 });
  assert.equal(p.finish(true), null, '同じ試合を二重に数えない');
  p.begin(1600);
  p.finish(false);
  assert.equal(p.wins, 1);
  assert.equal(p.losses, 1);
  const again = createProfile(st);
  assert.equal(again.rating, p.rating);
  assert.equal(again.wins, 1);
  assert.equal(again.losses, 1);
});

test('成績：試合の途中でアプリを閉じたら、次に開いたときに負けとして数える', () => {
  const st = memStorage();
  const p = createProfile(st);
  p.begin(1500);
  // ここでアプリを閉じた（finish が呼ばれない）
  const next = createProfile(st);
  assert.equal(next.losses, 1);
  assert.equal(next.rating, 1484);
  assert.deepEqual(next.abandoned, { delta: -16, rating: 1484 });
  assert.equal(createProfile(st).losses, 1, '一度数えたら、もう数えない');
});

test('名前：前後の空白と制御文字を落として12文字まで。空ならゲスト', () => {
  assert.equal(cleanName('  たろう  '), 'たろう');
  assert.equal(cleanName('a\u0000b\nc'), 'abc');
  assert.equal(cleanName('あいうえおかきくけこさしすせそ'), 'あいうえおかきくけこさし');
  assert.equal(cleanName('   '), 'ゲスト');
  const p = createProfile(memStorage());
  p.setName('  ');
  assert.equal(p.name, '');
  assert.equal(p.displayName, 'ゲスト');
  p.setName('ハナコ');
  assert.equal(p.displayName, 'ハナコ');
});
