// match.js — 対人戦の試合を「正解」として進める側（権威）。
//
// 普段はサーバー（net/rooms.js）がこれを動かす。同じWi-Fiで直結できたときは、
// 片方の端末（ホスト）のブラウザがこれを動かす。どちらでも同じコードが動くよう、
// Node やブラウザのAPIには触らない。
//
// クライアントは自分の入力で先に動かして（予測）、ここから届く状態で答え合わせをする。
// そのために：
//   - 入力には通し番号が付いてくる。1ステップにつき1つずつ順に使い、
//     どこまで使ったか（ack）をスナップショットに載せて返す
//   - スナップショットには step() が読む値をすべて載せる（再生できるように）
//   - 相手の予測に使えるよう、各駒がいま受けている移動入力も載せる

import { createState, step, restart, PHASE } from './game.js';
import { encodeState } from './snapshot.js';

export const TICK = 1 / 60;
// 状態は進めるたびに（60Hz）配る。間引くと、そのぶん相手やボールの答え合わせが遅れる。
// 溜めておく入力の上限（ステップ数）。これを超えたぶんは古い順に捨てて、
// 通信が詰まったあとに遅れを抱えたまま進むことがないようにする。
const MAX_QUEUE = 4;
// 入力が「常にこれ以上」溜まっている状態が TRIM_WINDOW ステップ続いたら、1つ捨てて縮める。
// 揺らぎで一度溜まった入力は、送る側と使う側が同じ速さなので自然には減らない。
// 放っておくと、そのぶんずっと反映が遅れたままになる。
const TRIM_ABOVE = 1;
const TRIM_WINDOW = 30;
// 送信待ちがこれを超えている相手には、状態を送らずに飛ばす（回線が細いときに遅れを積まない）。
// 状態は毎回丸ごとなので、1つ飛ばしても次ので追いつける。
const MAX_BUFFERED = 32 * 1024;
// 異常に送りつけられても、抱える入力はここまで（古いものから捨てる）
const HARD_QUEUE = 120;

const NO_INTENT = { move: { x: 0, y: 0 }, flick: null };

/**
 * outs[team] = { send(text, mustArrive), open, buffered } … チームごとの送り先。
 * 送り先は差し替えられる（outs をあとから書き換えてよい）。
 */
export function createMatch(outs) {
  const state = createState();
  const players = [0, 1].map((team) => ({
    team,
    // 届いた入力（通し番号つき）。ステップごとに1つずつ使う
    queue: [],
    ack: 0,
    // 入力が途切れたときに使い続ける、直近の移動入力（フリックは含めない）
    last: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    minQueue: Infinity,   // TRIM_WINDOW のあいだに見た、溜まっていた入力の最小数
    queueTicks: 0,
    events: [],           // まだこのチームへ送れていないイベント
  }));
  let seq = 0;
  let acc = 0;
  let moves = null;

  function readIntents(team, msg) {
    const p = players[team];
    const n = Number(msg.n);
    if (!Number.isInteger(n) || n <= p.ack) return;
    const q = p.queue;
    if (q.length && n <= q[q.length - 1].n) return;   // 古い・重複した入力
    q.push({ n, a: readSlot(msg.a), b: readSlot(msg.b) });
    if (q.length > HARD_QUEUE) q.splice(0, q.length - HARD_QUEUE);
  }

  /** このステップで使う2駒ぶんの意図を取り出す。 */
  function takeIntents(p) {
    const q = p.queue;
    // 溜まりすぎていたら古いものを捨てて追いつく。フリックだけは捨てずに次へ引き継ぐ
    // （踏み込みが消えると「押したのに出ない」になる）。
    while (q.length > MAX_QUEUE) skipOne(p);

    // ずっと余分に溜まっているなら1つ捨てて、反映を早める
    p.minQueue = Math.min(p.minQueue, q.length);
    if (++p.queueTicks >= TRIM_WINDOW) {
      if (p.minQueue > TRIM_ABOVE) skipOne(p);
      p.minQueue = Infinity;
      p.queueTicks = 0;
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

  /** 最も古い入力を使わずに捨てる。フリックは次の入力へ引き継ぐ。 */
  function skipOne(p) {
    const q = p.queue;
    const old = q.shift();
    if (q[0]) {
      if (old.a.flick && !q[0].a.flick) q[0].a.flick = old.a.flick;
      if (old.b.flick && !q[0].b.flick) q[0].b.flick = old.b.flick;
    }
    p.ack = old.n;
  }

  function broadcast() {
    // 共通部分は1回だけ文字列にし、イベントだけ相手ごとに足す
    const base = JSON.stringify({
      t: 's',
      n: ++seq,
      s: encodeState(state),
      k: [players[0].ack, players[1].ack],
      m: moves || [[0, 0], [0, 0], [0, 0], [0, 0]],
    });
    for (const p of players) {
      const out = outs[p.team];
      if (!out || !out.open) continue;
      if (out.buffered > MAX_BUFFERED) continue;   // 詰まっている。イベントは次で送る
      let text = base;
      const hasEvents = p.events.length > 0;
      if (hasEvents) {
        text = base.slice(0, -1) + ',"ev":' + JSON.stringify(p.events) + '}';
        p.events = [];
      }
      // 2つ目の引数は「落としてはいけないか」。直結では、イベントのない状態は
      // 届かなくてもよい経路で送る（次の状態が丸ごと上書きするので）
      try { out.send(text, hasEvents); } catch (_) {}
    }
  }

  return {
    state,
    outs,
    /** チーム team から届いたメッセージ（パース済み）を受け取る。 */
    receive(team, msg) {
      if (msg.t === 'i') readIntents(team, msg);
      else if (msg.t === 'restart' && state.phase === PHASE.OVER) {
        restart(state);
        for (const p of players) p.events.length = 0;
      }
    },
    /** 経過時間 dt（秒）ぶん進め、進んだら両チームへ状態を配る。 */
    advance(dt) {
      if (dt > 0.25) dt = 0.25;
      acc += dt;
      let steps = 0;
      while (acc >= TICK && steps < 5) {
        acc -= TICK;
        steps++;

        const intents = [null, null, null, null];
        for (const p of players) {
          const [a, b] = takeIntents(p);
          intents[p.team * 2] = a;
          intents[p.team * 2 + 1] = b;
        }
        for (let i = 0; i < 4; i++) if (!intents[i]) intents[i] = NO_INTENT;
        moves = intents.map((it) => [r2(it.move.x), r2(it.move.y)]);

        const evs = step(state, intents, TICK);
        for (const p of players) for (const e of evs) p.events.push(e);
      }
      if (steps > 0) broadcast();
    },
  };
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

function clamp1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

const r2 = (v) => Math.round(v * 100) / 100;
