// rooms.js — 対人戦のマッチングと権威サーバー。
//
// 試合はサーバー側だけで進める。クライアントから来るのは「意図」だけで、
// 位置はサーバーが計算して配る。src/game.js をそのまま使う（純粋なので
// Node でも同じものが動く）。これが「game.js をブラウザAPIから切り離す」
// と決めた理由そのもの。
//
// クライアントは自分の入力で先に動かして（予測）、ここから届く状態で答え合わせをする。
// そのために：
//   - 入力には通し番号が付いてくる。1ステップにつき1つずつ順に使い、
//     どこまで使ったか（ack）をスナップショットに載せて返す
//   - スナップショットには step() が読む値をすべて載せる（再生できるように）
//   - 相手の予測に使えるよう、各駒がいま受けている移動入力も載せる

import { createState, step, restart, PHASE } from '../src/game.js';
import { encodeState } from '../src/snapshot.js';

const TICK = 1 / 60;
const SNAPSHOT_HZ = 30;
// 溜めておく入力の上限（ステップ数）。これを超えたぶんは古い順に捨てて、
// 通信が詰まったあとに遅れを抱えたまま進むことがないようにする。
const MAX_QUEUE = 4;
// 異常に送りつけられても、抱える入力はここまで（古いものから捨てる）
const HARD_QUEUE = 120;

const waiting = [];        // 相手待ちのクライアント
const rooms = new Set();

const NO_INTENT = { move: { x: 0, y: 0 }, flick: null };

let nextId = 1;

export function handleConnection(conn) {
  const client = {
    id: nextId++,
    conn,
    room: null,
    team: -1,
    // 届いた入力（通し番号つき）。ステップごとに1つずつ使う
    queue: [],
    ack: 0,
    // 入力が途切れたときに使い続ける、直近の移動入力（フリックは含めない）
    last: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
  };

  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'join': join(client); break;
      case 'i': readIntents(client, msg); break;
      case 'restart':
        if (client.room && client.room.state.phase === PHASE.OVER) {
          restart(client.room.state);
          client.room.pending = [];
        }
        break;
      case 'leave': drop(client); break;
    }
  });

  conn.on('close', () => drop(client));
  send(conn, { t: 'hello' });
}

function send(conn, obj) {
  try { conn.send(JSON.stringify(obj)); } catch (_) {}
}

function join(client) {
  if (client.room) return;
  const i = waiting.indexOf(client);
  if (i >= 0) return;                 // すでに待っている

  const other = waiting.shift();
  if (!other || !other.conn.open) {
    waiting.push(client);
    send(client.conn, { t: 'wait' });
    return;
  }
  makeRoom(other, client);
}

function makeRoom(a, b) {
  const room = {
    state: createState(),
    players: [a, b],
    pending: [],          // 直近スナップショット以降に出たイベント
    seq: 0,
    acc: 0,
    snapAcc: 0,
    timer: null,
    last: process.hrtime.bigint(),
  };
  a.room = b.room = room;
  a.team = 0;
  b.team = 1;
  for (const p of room.players) {
    p.queue.length = 0;
    p.ack = 0;
    p.last[0].x = p.last[0].y = p.last[1].x = p.last[1].y = 0;
  }
  rooms.add(room);

  for (const p of room.players) {
    send(p.conn, { t: 'start', team: p.team });
  }

  room.timer = setInterval(() => tickRoom(room), 1000 / 60);
}

function readIntents(client, msg) {
  if (!client.room) return;
  const n = Number(msg.n);
  if (!Number.isInteger(n) || n <= client.ack) return;
  const q = client.queue;
  if (q.length && n <= q[q.length - 1].n) return;   // 古い・重複した入力
  q.push({ n, a: readSlot(msg.a), b: readSlot(msg.b) });
  if (q.length > HARD_QUEUE) q.splice(0, q.length - HARD_QUEUE);
}

function readSlot(arr) {
  if (!Array.isArray(arr)) return { move: { x: 0, y: 0 }, flick: null };
  return {
    move: { x: clamp1(arr[0]), y: clamp1(arr[1]) },
    flick: (typeof arr[2] === 'number' && typeof arr[3] === 'number')
      ? { x: clamp1(arr[2]), y: clamp1(arr[3]) }
      : null,
  };
}

/** このステップで使う2駒ぶんの意図を取り出す。 */
function takeIntents(p) {
  const q = p.queue;
  // 溜まりすぎていたら古いものを捨てて追いつく。フリックだけは捨てずに次へ引き継ぐ
  // （踏み込みが消えると「押したのに出ない」になる）。
  while (q.length > MAX_QUEUE) {
    const old = q.shift();
    if (old.a.flick && !q[0].a.flick) q[0].a.flick = old.a.flick;
    if (old.b.flick && !q[0].b.flick) q[0].b.flick = old.b.flick;
    p.ack = old.n;
  }
  const inp = q.shift();
  if (!inp) {
    // まだ届いていない。直前の移動を続ける（止めるとカクつく）
    return [{ move: { ...p.last[0] }, flick: null }, { move: { ...p.last[1] }, flick: null }];
  }
  p.ack = inp.n;
  p.last[0].x = inp.a.move.x; p.last[0].y = inp.a.move.y;
  p.last[1].x = inp.b.move.x; p.last[1].y = inp.b.move.y;
  return [inp.a, inp.b];
}

function clamp1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

function tickRoom(room) {
  const now = process.hrtime.bigint();
  let dt = Number(now - room.last) / 1e9;
  room.last = now;
  if (dt > 0.25) dt = 0.25;

  room.acc += dt;
  let steps = 0;
  while (room.acc >= TICK && steps < 5) {
    room.acc -= TICK;
    steps++;

    const intents = [null, null, null, null];
    for (const p of room.players) {
      const [a, b] = takeIntents(p);
      intents[p.team * 2] = a;
      intents[p.team * 2 + 1] = b;
    }
    for (let i = 0; i < 4; i++) if (!intents[i]) intents[i] = NO_INTENT;
    room.moves = intents.map((it) => [r2(it.move.x), r2(it.move.y)]);

    const evs = step(room.state, intents, TICK);
    for (const e of evs) room.pending.push(e);
  }

  room.snapAcc += dt;
  const period = 1 / SNAPSHOT_HZ;
  if (room.snapAcc >= period) {
    room.snapAcc -= period;
    if (room.snapAcc > period) room.snapAcc = 0;   // 大きく遅れたら追いつこうとしない
    broadcast(room);
  }
}

function broadcast(room) {
  const ack = [0, 0];
  for (const p of room.players) ack[p.team] = p.ack;
  const snap = {
    t: 's',
    n: ++room.seq,
    s: encodeState(room.state),
    k: ack,
    m: room.moves || [[0, 0], [0, 0], [0, 0], [0, 0]],
    ev: room.pending.length ? room.pending : undefined,
  };
  room.pending = [];
  const text = JSON.stringify(snap);
  for (const p of room.players) {
    if (p.conn.open) { try { p.conn.send(text); } catch (_) {} }
  }
}

const r2 = (v) => Math.round(v * 100) / 100;

function drop(client) {
  const i = waiting.indexOf(client);
  if (i >= 0) waiting.splice(i, 1);

  const room = client.room;
  if (!room) return;
  client.room = null;
  clearInterval(room.timer);
  rooms.delete(room);
  for (const p of room.players) {
    p.room = null;
    if (p !== client && p.conn.open) send(p.conn, { t: 'gone' });
  }
}

export function stats() {
  return { waiting: waiting.length, rooms: rooms.size };
}
