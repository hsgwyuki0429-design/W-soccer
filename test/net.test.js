import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CONFIG } from '../src/config.js';
import { createState, step, PHASE } from '../src/game.js';
import { encodeState, decodeState } from '../src/snapshot.js';
import { accept } from '../net/ws.js';
import { handleConnection } from '../net/rooms.js';

const DT = 1 / 60;
const S = CONFIG.world.scale;

function intentsAt(t) {
  const m = (a) => ({ x: Math.cos(t * 0.05 + a), y: Math.sin(t * 0.07 + a) });
  return [0, 1, 2, 3].map((i) => ({ move: m(i), flick: t % 50 === i * 7 ? m(i + 1) : null }));
}

test('スナップショットから復元した状態は、同じ入力で元と同じように進む', () => {
  const a = createState();
  for (let t = 0; t < 400; t++) step(a, intentsAt(t), DT);
  const b = createState();
  decodeState(b, JSON.parse(JSON.stringify(encodeState(a))));

  for (let t = 400; t < 460; t++) {
    step(a, intentsAt(t), DT);
    step(b, intentsAt(t), DT);
  }
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.hypot(a.units[i].x - b.units[i].x, a.units[i].y - b.units[i].y) < 1, `unit ${i}`);
  }
  assert.ok(Math.hypot(a.ball.x - b.ball.x, a.ball.y - b.ball.y) < 2);
  assert.equal(a.phase, b.phase);
  assert.deepEqual(a.score, b.score);
});

test('答え合わせでボールがずれても、駒に接している瞬間は当たり判定どおりの位置に描く', async () => {
  // サーバー役を手で動かせる WebSocket
  let sock = null;
  class FakeSocket {
    constructor() { sock = this; this.readyState = 1; }
    send() {}
    close() {}
  }
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  globalThis.location ??= { protocol: 'http:', host: 'localhost' };
  const { createNet } = await import('../src/net.js');
  const net = createNet();
  try {
    net.connect();
    sock.onopen();
    const deliver = (m) => sock.onmessage({ data: JSON.stringify(m) });
    deliver({ t: 'start', team: 0 });

    const rr = CONFIG.unit.radius + CONFIG.ball.radius;
    const s = createState();
    s.phase = PHASE.PLAY;
    const u = s.units[0];
    u.x = 400 * S; u.y = 500 * S;
    s.ball.x = u.x; s.ball.y = u.y - 90 * S;   // 駒から離れている
    const view = createState();
    deliver({ t: 's', n: 1, s: encodeState(s), k: [0, 0], m: [[0, 0], [0, 0], [0, 0], [0, 0]] });
    net.apply(view, DT);

    // サーバーの答え：実はボールはもう駒に接していた（見えている位置から大きくずれる）
    s.ball.x = u.x; s.ball.y = u.y - rr;
    deliver({ t: 's', n: 2, s: encodeState(s), k: [0, 0], m: [[0, 0], [0, 0], [0, 0], [0, 0]] });
    net.apply(view, DT);

    const vu = view.units[0], vb = view.ball;
    const gap = Math.hypot(vb.x - vu.x, vb.y - vu.y) - rr;
    assert.ok(Math.abs(gap) < 0.5, `描いた駒とボールの隙間 ${gap}`);
  } finally {
    net.disconnect();
    globalThis.WebSocket = saved;
  }
});

// ---------------------------------------------------------------- 通信を挟んだ試験

const LATENCY_MS = 80;   // 片道。往復 160ms の回線を想定

/** 送受信の両方を LATENCY_MS 遅らせる WebSocket */
class SlowSocket {
  constructor(url) {
    this.ws = new globalThis.RealWebSocket(url);
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.ws.onopen = () => setTimeout(() => this.onopen && this.onopen(), LATENCY_MS);
    this.ws.onmessage = (e) => setTimeout(() => this.onmessage && this.onmessage({ data: e.data }), LATENCY_MS);
    this.ws.onclose = () => setTimeout(() => this.onclose && this.onclose(), LATENCY_MS);
    this.ws.onerror = () => this.onerror && this.onerror();
  }
  get readyState() { return this.ws.readyState; }
  send(text) { setTimeout(() => { if (this.ws.readyState === 1) this.ws.send(text); }, LATENCY_MS); }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('往復160msでも自分の駒は入力した次のステップで動き、踏み込みは取りこぼさない', async () => {
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const conn = accept(req, socket, head);
    if (conn) handleConnection(conn);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  globalThis.RealWebSocket ??= globalThis.WebSocket;
  globalThis.WebSocket = SlowSocket;
  globalThis.location = { protocol: 'http:', host: `127.0.0.1:${port}` };
  const { createNet } = await import('../src/net.js');

  const A = createNet(), B = createNet();
  try {
  const localEvents = [];
  A.on('events', (evs) => { for (const e of evs) localEvents.push(e); });
  A.connect();
  await sleep(50);
  B.connect();
  for (let i = 0; i < 100 && (A.status !== 'playing' || B.status !== 'playing'); i++) await sleep(20);
  assert.equal(A.status, 'playing');
  assert.equal(B.status, 'playing');

  const me = A.myTeam;
  const viewA = createState();
  const viewB = createState();
  const still = { move: { x: 0, y: 0 }, flick: null };
  const toward = me === 0 ? -1 : 1;   // 相手ゴールの向き（y）
  const run = { move: { x: 0, y: toward }, flick: null };

  // 1ステップ目：押した瞬間に手元の駒が動く（サーバーの返事を待たない）
  A.apply(viewA, DT);
  const y0 = viewA.units[me * 2].y;
  A.tick(run, still);
  A.apply(viewA, DT);
  assert.ok((viewA.units[me * 2].y - y0) * toward > 0, '入力した直後のステップで動いている');

  // 60Hz で約2.7秒ぶん回す。途中で踏み込みを3回（クールダウン0.8秒より間を空ける）。
  const dashes = new Set([20, 80, 140]);
  let dashesSeen = 0;
  for (let t = 1; t < 160; t++) {
    const flick = dashes.has(t) ? { x: 0.3, y: toward } : null;
    const before = localEvents.length;
    A.tick({ move: run.move, flick }, still);
    B.tick(still, still);
    const fresh = localEvents.slice(before);
    if (flick) {
      // 自分の踏み込みの音・演出は、サーバーを待たずにその場で出る
      assert.ok(fresh.some((e) => e.type === 'dash' && e.unit === me * 2), `t=${t} の踏み込みが即座に出る`);
      dashesSeen++;
    }
    await sleep(1000 / 60);
    A.apply(viewA, DT);
    B.apply(viewB, DT);
  }
  assert.equal(dashesSeen, 3);

  // 止めて、サーバーの答えが追いつくのを待つ
  for (let t = 0; t < 40; t++) {
    A.tick(still, still);
    B.tick(still, still);
    await sleep(1000 / 60);
    A.apply(viewA, DT);
    B.apply(viewB, DT);
  }
  // 自分の画面・相手の画面の両方で、同じ位置に落ち着く（予測がサーバーの結果と一致）
  const ua = viewA.units[me * 2], ub = viewB.units[me * 2];
  assert.ok(Math.hypot(ua.x - ub.x, ua.y - ub.y) < 4 * S, `予測と確定のずれ ${Math.hypot(ua.x - ub.x, ua.y - ub.y)}`);
  // 駒は実際に前へ進んでいる（踏み込みも入力もサーバーで反映された）
  assert.ok((ua.y - y0) * toward > 200 * S, `進んだ距離 ${(ua.y - y0) * toward}`);
  assert.ok(A.pending < 30, `未確認の入力が溜まり続けていない (${A.pending})`);
  assert.notEqual(viewA.phase, undefined);
  assert.ok([PHASE.KICKOFF, PHASE.PLAY, PHASE.GOAL].includes(viewA.phase));
  } finally {
    A.disconnect();
    B.disconnect();
    await sleep(LATENCY_MS * 2 + 50);
    globalThis.WebSocket = globalThis.RealWebSocket;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('同じWi-Fiの直結：両者が対応していれば接続情報を中継し、ホストの知らせで直結の試合を始める', async () => {
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const conn = accept(req, socket, head);
    if (conn) handleConnection(conn);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const Socket = globalThis.RealWebSocket ?? globalThis.WebSocket;

  const open = (rtc) => new Promise((resolve) => {
    const ws = new Socket(`ws://127.0.0.1:${port}/ws`);
    ws.got = [];
    ws.onmessage = (e) => ws.got.push(JSON.parse(e.data));
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', rtc })); resolve(ws); };
  });
  const until = async (ws, t) => {
    for (let i = 0; i < 100; i++) {
      const m = ws.got.find((x) => x.t === t);
      if (m) return m;
      await sleep(10);
    }
    assert.fail(`${t} が届かない`);
  };

  try {
    // 両者とも対応：まず仲立ち（pair）。中継された接続情報が相手に届く
    const a = await open(true);
    await sleep(30);
    const b = await open(true);
    assert.equal((await until(a, 'pair')).team, 0);
    assert.equal((await until(b, 'pair')).team, 1);
    a.send(JSON.stringify({ t: 'rtc', d: { sdp: { type: 'offer', sdp: 'x' } } }));
    assert.deepEqual((await until(b, 'rtc')).d, { sdp: { type: 'offer', sdp: 'x' } });
    // ホスト以外の知らせは無視する
    b.send(JSON.stringify({ t: 'mode', p2p: true }));
    await sleep(50);
    assert.equal(a.got.find((x) => x.t === 'start'), undefined);
    a.send(JSON.stringify({ t: 'mode', p2p: true }));
    assert.equal((await until(a, 'start')).p2p, true);
    assert.equal((await until(b, 'start')).p2p, true);
    // 直結中はサーバーは試合を進めない
    await sleep(100);
    assert.equal(b.got.filter((x) => x.t === 's').length, 0);
    a.close(); b.close();

    // 片方が対応していなければ、仲立ちせずにサーバーで始める
    const c = await open(true);
    await sleep(30);
    const d = await open(false);
    assert.equal((await until(c, 'start')).p2p, false);
    assert.equal(c.got.find((x) => x.t === 'pair'), undefined);
    await until(d, 's');
    c.close(); d.close();
  } finally {
    await sleep(50);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('入力の届く間隔が揺れても（0個・2個・0個…）、駒は送った入力の数だけ進み、遅れた踏み込みも消えない', async () => {
  const { createMatch } = await import('../src/match.js');
  const got = [];
  const out = { open: true, buffered: 0, send: (text) => got.push(JSON.parse(text)) };
  const m = createMatch([out, { open: false, buffered: 0, send() {} }]);
  m.state.phase = PHASE.PLAY;
  const run = [0, -1, null, null];
  let n = 0;
  const send = (flick = null) => {
    n++;
    m.receive(0, { t: 'i', n, a: [run[0], run[1], flick ? flick[0] : null, flick ? flick[1] : null], b: [0, 0, null, null] });
  };

  // 同じ入力を手元で素直に進めたもの（＝送った側の予測）
  const ref = createState();
  ref.phase = PHASE.PLAY;
  const refStep = (flick) => step(ref, [{ move: { x: 0, y: -1 }, flick }, null, null, null], DT);

  send(); m.step(); refStep(null);
  let dashed = false;
  for (let t = 0; t < 40; t++) {
    // 偶数ステップは入力が間に合わず、奇数ステップで2つまとめて届く
    if (t % 2 === 1) {
      send(t === 21 ? [0, -1] : null);   // 遅れて届く入力に踏み込みを載せる
      send();
    }
    m.step();
    if (m.state.units[0].dashT > 0) dashed = true;
  }
  for (let t = 0; t < 40; t++) refStep(t === 20 ? { x: 0, y: -1 } : null);
  // 届いた入力はすべて使った扱いになっている（未確認の入力が溜まり続けない）
  assert.equal(got[got.length - 1].k[0], n);
  // 1ステップ余計に進んだり、戻されたりしていない
  const u = m.state.units[0], r = ref.units[0];
  assert.ok(Math.abs(u.y - r.y) < 30 * S, `送った入力の数と進んだ距離が合う (${(u.y - r.y).toFixed(1)})`);
  assert.ok(dashed, '遅れて届いた踏み込みも出る');
});
