// rooms.js — 対人戦のマッチングと権威サーバー。
//
// 試合はサーバー側だけで進める。クライアントから来るのは「意図」だけで、
// 位置はサーバーが計算して配る。src/game.js をそのまま使う（純粋なので
// Node でも同じものが動く）。これが「game.js をブラウザAPIから切り離す」
// と決めた理由そのもの。

import { createState, step, restart, PHASE } from '../src/game.js';

const TICK = 1 / 60;
const SNAPSHOT_HZ = 30;

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
    // このクライアントが担当する2駒ぶんの意図
    intents: [{ move: { x: 0, y: 0 }, flick: null }, { move: { x: 0, y: 0 }, flick: null }],
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
          client.room.pending.length = 0;
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
  rooms.add(room);

  for (const p of room.players) {
    send(p.conn, { t: 'start', team: p.team });
  }

  room.timer = setInterval(() => tickRoom(room), 1000 / 60);
}

function readIntents(client, msg) {
  const put = (slot, arr) => {
    const it = client.intents[slot];
    if (!Array.isArray(arr)) { it.move.x = it.move.y = 0; it.flick = null; return; }
    it.move.x = clamp1(arr[0]);
    it.move.y = clamp1(arr[1]);
    it.flick = (typeof arr[2] === 'number' && typeof arr[3] === 'number')
      ? { x: clamp1(arr[2]), y: clamp1(arr[3]) }
      : null;
  };
  put(0, msg.a);
  put(1, msg.b);
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
      const base = p.team * 2;
      for (let k = 0; k < 2; k++) {
        const src = p.intents[k];
        // ここで写しを作る。src をそのまま渡して直後に flick を消すと、
        // 同じオブジェクトなので step が見る前に消える。
        intents[base + k] = { move: { x: src.move.x, y: src.move.y }, flick: src.flick };
        src.flick = null;   // フリックは1ステップだけ有効
      }
    }
    for (let i = 0; i < 4; i++) if (!intents[i]) intents[i] = NO_INTENT;

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
  const s = room.state;
  const snap = {
    t: 's',
    n: ++room.seq,
    u: s.units.map((u) => [r1(u.x), r1(u.y), r1(u.vx), r1(u.vy), r2(u.cooldown), r2(u.dashT)]),
    b: [r1(s.ball.x), r1(s.ball.y), r1(s.ball.vx), r1(s.ball.vy)],
    ph: s.phase,
    sc: s.score,
    ko: s.kickoffTeam,
    ht: r2(s.heatT),
    ch: s.chain,
    w: s.winner,
    ev: room.pending.length ? room.pending : undefined,
  };
  room.pending = [];
  const text = JSON.stringify(snap);
  for (const p of room.players) {
    if (p.conn.open) { try { p.conn.send(text); } catch (_) {} }
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
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
