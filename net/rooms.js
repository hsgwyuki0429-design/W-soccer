// rooms.js — 対人戦のマッチングと権威サーバー。
//
// 試合はサーバー側で進める。クライアントから来るのは「意図」だけで、
// 位置はサーバーが計算して配る。進め方そのものは src/match.js にあり、
// ブラウザ（直結時のホスト）でも同じものが動く。
//
// 同じWi-Fiにいる2人は、サーバーを経由せず端末どうしで直結（WebRTC）できる。
// 2人とも直結に対応していれば、試合を始める前にその仲立ちをする：
//   1. 'pair' を送り、両者の接続情報（'rtc'）をそのまま相手へ中継する
//   2. ホスト（チーム0）が結果を 'mode' で知らせてくる
//   3. 直結できたなら、試合はホストの端末が進める。サーバーは進めない
//      できなかったら（別のネットワークなど）、これまでどおりサーバーで進める

import { createMatch } from '../src/match.js';

// 直結を試す時間の上限。ホストが返事をしなければサーバーで始める
const NEGOTIATE_MS = 6000;

const waiting = [];        // 相手待ちのクライアント
const rooms = new Set();

let nextId = 1;

export function handleConnection(conn) {
  const client = {
    id: nextId++,
    conn,
    room: null,
    team: -1,
    rtc: false,           // 直結を試せるクライアントか
  };

  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    const room = client.room;
    switch (msg.t) {
      case 'join':
        client.rtc = msg.rtc === true;
        join(client);
        break;
      case 'i':
      case 'restart':
        if (room && room.mode === 'server') room.match.receive(client.team, msg);
        break;
      case 'rtc':
        // 接続情報の中継。中身は見ずに相手へ渡す（大きすぎるものは捨てる）
        if (room && room.mode === 'nego' && text.length < 16384) {
          const other = room.players[1 - client.team];
          if (other.conn.open) send(other.conn, { t: 'rtc', d: msg.d });
        }
        break;
      case 'mode':
        if (room && room.mode === 'nego' && client.team === 0) begin(room, msg.p2p === true);
        break;
      case 'leave': drop(client); break;
      // 通信の往復時間を測るためのもの。受け取った値をそのまま返す
      case 'p': send(conn, { t: 'P', c: Number(msg.c) || 0 }); break;
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
    players: [a, b],
    mode: 'nego',          // nego（直結を試し中） | server | p2p
    match: null,
    timer: null,
    last: 0,
  };
  a.room = b.room = room;
  a.team = 0;
  b.team = 1;
  rooms.add(room);

  if (a.rtc && b.rtc) {
    for (const p of room.players) send(p.conn, { t: 'pair', team: p.team });
    room.timer = setTimeout(() => begin(room, false), NEGOTIATE_MS);
  } else {
    begin(room, false);
  }
}

function begin(room, p2p) {
  if (room.mode !== 'nego') return;
  clearTimeout(room.timer);
  room.mode = p2p ? 'p2p' : 'server';
  for (const p of room.players) send(p.conn, { t: 'start', team: p.team, p2p });
  if (p2p) return;   // 試合はホストの端末が進める。ここは退出の知らせだけ受け持つ

  room.match = createMatch(room.players.map((p) => p.conn));
  room.last = process.hrtime.bigint();
  room.timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const dt = Number(now - room.last) / 1e9;
    room.last = now;
    room.match.advance(dt);
  }, 1000 / 60);
}

function drop(client) {
  const i = waiting.indexOf(client);
  if (i >= 0) waiting.splice(i, 1);

  const room = client.room;
  if (!room) return;
  client.room = null;
  clearTimeout(room.timer);
  clearInterval(room.timer);
  rooms.delete(room);
  for (const p of room.players) {
    p.room = null;
    if (p !== client && p.conn.open) send(p.conn, { t: 'gone' });
  }
}

export function stats() {
  let p2p = 0;
  for (const r of rooms) if (r.mode === 'p2p') p2p++;
  return { waiting: waiting.length, rooms: rooms.size, p2p };
}
