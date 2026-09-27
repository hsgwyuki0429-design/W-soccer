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
