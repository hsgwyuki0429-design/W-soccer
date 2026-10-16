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
//
// 直結の試合でも、やりとりはサーバー経由でも二重に流す（ゲストの入力 → ホスト、
// ホストの状態 → ゲスト）。受け取る側は先に届いたほうを使うので、直結とサーバー経由の
// うち、その時々で速いほうが使われる。片方が詰まっても、もう片方で試合が続く。
//
// 観戦：進行中の試合は /rooms で一覧でき、'watch' でその試合の状態を受け取れる。
// サーバーで進めている試合はここから配る。直結の試合は、ホストが送ってくる状態を
// そのまま観戦者へ渡す（間引いて約30Hz。イベントつきの状態は必ず渡す）。
//
// 名前とレートはクライアントが名乗ったものをそのまま相手へ伝える（保存はしない）。

import { createMatch } from '../src/match.js';
import { cleanName } from '../src/profile.js';

// 直結を試す時間の上限。ホストが返事をしなければサーバーで始める
const NEGOTIATE_MS = 6000;
// 1つの試合を観戦できる人数の上限（サーバーの帯域を守る）
const MAX_WATCHERS = 20;
// 直結のホストから中継する状態の大きさの上限
const MAX_RELAY = 8192;
// 中継先の送信待ちがこれを超えていたら送らない（詰まっている相手に遅れを積まない）。
// 状態は毎回丸ごとなので小さく（古い状態を溜めない）、入力は落とせないので大きめに。
// イベントつきの状態も落とせないので入力と同じ扱い
const RELAY_BUFFERED = 4 * 1024;
const RELAY_INPUT_BUFFERED = 32 * 1024;

const waiting = [];        // 相手待ちのクライアント
const rooms = new Set();

let nextId = 1;
let nextRoomId = 1;

function cleanRating(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(4000, Math.max(0, n)) : 1500;
}

export function handleConnection(conn) {
  const client = {
    id: nextId++,
    conn,
    room: null,
    team: -1,
    rtc: false,           // 直結を試せるクライアントか
    name: 'ゲスト',
    rating: 1500,
    watching: null,       // 観戦している試合
  };

  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    const room = client.room;
    switch (msg.t) {
      case 'join':
        client.rtc = msg.rtc === true;
        client.name = cleanName(msg.name);
        client.rating = cleanRating(msg.rating);
        join(client);
        break;
      case 'watch': watch(client, Number(msg.id)); break;
      case 's':
        // 直結のホストが送ってくる状態。ゲストへ（直結と二重に）、観戦者へは間引いて渡す
        if (room && room.mode === 'p2p' && client.team === 0 && text.length < MAX_RELAY) {
          const guest = room.players[1];
          const hasEvents = text.includes('"ev":');
          const limit = hasEvents ? RELAY_INPUT_BUFFERED : RELAY_BUFFERED;
          if (guest.conn.open && guest.conn.buffered < limit) guest.conn.send(text);
          if (room.watchers.size && (hasEvents || room.relayN++ % 2 === 0)) {
            for (const w of room.watchers) if (w.conn.open && w.conn.buffered < limit) w.conn.send(text);
          }
        }
        break;
      case 'score':
        // 直結の試合の得点（一覧に出すため）
        if (room && room.mode === 'p2p' && client.team === 0 && Array.isArray(msg.s)) {
          room.score = [msg.s[0] | 0, msg.s[1] | 0];
        }
        break;
      case 'i':
      case 'restart':
        if (room && room.mode === 'server') room.match.receive(client.team, msg);
        // 直結の試合：ゲストの入力をホストへ中継する（直結と二重。先に届いたほうが使われる）
        else if (room && room.mode === 'p2p' && client.team === 1 && text.length < MAX_RELAY) {
          const host = room.players[0];
          if (host.conn.open && host.conn.buffered < RELAY_INPUT_BUFFERED) host.conn.send(text);
        }
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
  if (client.room || client.watching) return;
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
    id: nextRoomId++,
    players: [a, b],
    watchers: new Set(),
    score: [0, 0],
    relayN: 0,
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
    for (const p of room.players) send(p.conn, { t: 'pair', team: p.team, opp: oppOf(room, p) });
    room.timer = setTimeout(() => begin(room, false), NEGOTIATE_MS);
  } else {
    begin(room, false);
  }
}

function begin(room, p2p) {
  if (room.mode !== 'nego') return;
  clearTimeout(room.timer);
  room.mode = p2p ? 'p2p' : 'server';
  for (const p of room.players) send(p.conn, { t: 'start', team: p.team, p2p, opp: oppOf(room, p) });
  if (p2p) {
    // 試合はホストの端末が進める。ここは退出の知らせと観戦の中継だけ受け持つ
    tellWatchers(room);
    return;
  }

  room.match = createMatch(room.players.map((p) => p.conn));
  for (const w of room.watchers) room.match.watch(w.conn);
  room.last = process.hrtime.bigint();
  room.timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const dt = Number(now - room.last) / 1e9;
    room.last = now;
    room.match.advance(dt);
  }, 1000 / 60);
}

function oppOf(room, p) {
  const o = room.players[1 - p.team];
  return { name: o.name, rating: o.rating };
}

/** 観戦を始める。 */
function watch(client, id) {
  if (client.room || client.watching) return;
  let room = null;
  for (const r of rooms) if (r.id === id) room = r;
  if (!room) { send(client.conn, { t: 'nowatch' }); return; }
  if (room.watchers.size >= MAX_WATCHERS) { send(client.conn, { t: 'nowatch', full: true }); return; }
  const i = waiting.indexOf(client);
  if (i >= 0) waiting.splice(i, 1);
  client.watching = room;
  room.watchers.add(client);
  send(client.conn, {
    t: 'watching',
    id: room.id,
    names: room.players.map((p) => p.name),
    ratings: room.players.map((p) => p.rating),
  });
  if (room.match) room.match.watch(client.conn);
  tellWatchers(room);
}

/** 観戦者の人数を両プレイヤーへ知らせる（画面に出す）。 */
function tellWatchers(room) {
  for (const p of room.players) {
    if (p.conn.open) send(p.conn, { t: 'watchers', n: room.watchers.size });
  }
}

function drop(client) {
  const i = waiting.indexOf(client);
  if (i >= 0) waiting.splice(i, 1);

  const watched = client.watching;
  if (watched) {
    client.watching = null;
    watched.watchers.delete(client);
    if (watched.match) watched.match.unwatch(client.conn);
    if (rooms.has(watched)) tellWatchers(watched);
  }

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
  for (const w of room.watchers) {
    w.watching = null;
    if (w.conn.open) send(w.conn, { t: 'ended' });
  }
  room.watchers.clear();
}

/** 観戦できる試合の一覧（/rooms）。 */
export function listRooms() {
  const out = [];
  for (const r of rooms) {
    if (r.mode === 'nego') continue;
    out.push({
      id: r.id,
      names: r.players.map((p) => p.name),
      ratings: r.players.map((p) => p.rating),
      score: r.match ? [...r.match.state.score] : r.score,
      direct: r.mode === 'p2p',
      watchers: r.watchers.size,
    });
  }
  return out;
}

export function stats() {
  let p2p = 0, watchers = 0;
  for (const r of rooms) {
    if (r.mode === 'p2p') p2p++;
    watchers += r.watchers.size;
  }
  return { waiting: waiting.length, rooms: rooms.size, p2p, watchers };
}
