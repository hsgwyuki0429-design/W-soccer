// net.js — 対人戦のクライアント。
//
// 試合の正解はサーバーが持つ。ただしサーバーの答えを待ってから動かすと、
// 往復の通信時間ぶん操作が遅れる（= ラグ）。そこで：
//
//   1. 入力は通し番号を付けて送り、同時に手元でも同じ step() で1ステップ進める（予測）
//   2. サーバーから状態が届いたら、それを正解として置き直し、
//      サーバーがまだ使っていない自分の入力を再生して「今」に戻す（答え合わせ）
//   3. 答え合わせで生じた位置のずれは、瞬間移動させずに数フレームかけて寄せる
//
// 相手の入力は届かないので、最後に分かっている移動入力を続けているものとして予測する。
//
// イベント（音・演出）は二重に鳴らないよう、出どころを種類で分ける：
//   - 自分の操作で起きるもの・物理の反応 → 手元の予測から即座に出す
//   - 相手の踏み込み／キック／体当たり、ゴール・キックオフ・決着 → サーバーから出す

import { CONFIG } from './config.js';
import { createState, step } from './game.js';
import { decodeState, copyState } from './snapshot.js';

const STEP = 1 / 60;
const MAX_PENDING = 180;     // 未確認の入力をこれ以上は抱えない（3秒）
const SMOOTH_RATE = 14;      // 答え合わせのずれを寄せる速さ（1/秒）
const TELEPORT = 150 * CONFIG.world.scale;   // これ以上ずれたら寄せずに飛ばす（キックオフの配置換えなど）

const SERVER_ONLY = new Set(['goal', 'kickoff', 'matchend']);

export function createNet() {
  let ws = null;
  let status = 'idle';       // idle | connecting | waiting | playing | gone | error
  let myTeam = 0;
  const listeners = { status: [], events: [] };

  const sim = createState();          // 予測している「今」
  let pending = [];                   // サーバーがまだ使っていない自分の入力
  let seq = 0;
  let latest = null;                  // まだ答え合わせに使っていない最新の状態
  let moves = [[0, 0], [0, 0], [0, 0], [0, 0]];   // 各駒がいま受けている移動入力
  let serverEvents = [];
  const offsets = { units: sim.units.map(() => ({ x: 0, y: 0 })), ball: { x: 0, y: 0 } };

  const mine = (unitIndex) => (unitIndex >> 1) === myTeam;

  /** このイベントはサーバーからのものを使うか（手元の予測からは出さない） */
  function fromServer(e) {
    if (SERVER_ONLY.has(e.type)) return true;
    if (e.type === 'dash' || e.type === 'kick') return !mine(e.unit);
    if (e.type === 'stun') return !mine(e.by);
    return false;
  }

  function emit(kind, ...a) { for (const fn of listeners[kind]) fn(...a); }
  function setStatus(s, info) { status = s; emit('status', s, info); }

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function reset() {
    const fresh = createState();
    sim.units = fresh.units;
    copyState(sim, fresh);
    pending = [];
    seq = 0;
    latest = null;
    moves = [[0, 0], [0, 0], [0, 0], [0, 0]];
    serverEvents = [];
    for (const o of offsets.units) o.x = o.y = 0;
    offsets.ball.x = offsets.ball.y = 0;
  }

  /** 手元の状態を1ステップ進める。a, b は自分の駒（番号順）の意図。 */
  function advance(a, b) {
    const intents = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      if (mine(i)) intents[i] = (i & 1) ? b : a;
      else intents[i] = { move: { x: moves[i][0], y: moves[i][1] }, flick: null };
    }
    return step(sim, intents, STEP);
  }

  /** 届いた状態を正解として置き直し、未確認の入力を再生する。 */
  function reconcile() {
    const snap = latest;
    latest = null;

    // 置き直す前に「いま見えている位置」を覚えておく
    const seenU = sim.units.map((u, i) => ({ x: u.x + offsets.units[i].x, y: u.y + offsets.units[i].y }));
    const seenB = { x: sim.ball.x + offsets.ball.x, y: sim.ball.y + offsets.ball.y };

    decodeState(sim, snap.s);
    if (Array.isArray(snap.m)) moves = snap.m;
    const ack = snap.k ? snap.k[myTeam] | 0 : 0;
    let i = 0;
    while (i < pending.length && pending[i].seq <= ack) i++;
    if (i) pending = pending.slice(i);
    for (const p of pending) advance(p.a, p.b);   // 再生中のイベントは既に出したか、サーバーから出る

    // 見えている位置は変えずに、ずれをオフセットとして持つ
    sim.units.forEach((u, k) => {
      const o = offsets.units[k];
      o.x = seenU[k].x - u.x;
      o.y = seenU[k].y - u.y;
      if (Math.hypot(o.x, o.y) > TELEPORT) o.x = o.y = 0;
    });
    offsets.ball.x = seenB.x - sim.ball.x;
    offsets.ball.y = seenB.y - sim.ball.y;
    if (Math.hypot(offsets.ball.x, offsets.ball.y) > TELEPORT) offsets.ball.x = offsets.ball.y = 0;
  }

  const clone = (it) => ({
    move: { x: it.move.x, y: it.move.y },
    flick: it.flick ? { x: it.flick.x, y: it.flick.y } : null,
  });

  return {
    get status() { return status; },
    get myTeam() { return myTeam; },
    get pending() { return pending.length; },
    on(kind, fn) { listeners[kind].push(fn); },

    connect() {
      if (ws && (status === 'connecting' || status === 'waiting' || status === 'playing')) return;
      reset();
      setStatus('connecting');
      try {
        ws = new WebSocket(url());
      } catch (_) {
        setStatus('error');
        return;
      }
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join' }));
      ws.onerror = () => { if (status !== 'playing') setStatus('error'); };
      ws.onclose = () => { if (status === 'playing' || status === 'waiting') setStatus('gone'); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        switch (m.t) {
          case 'wait': setStatus('waiting'); break;
          case 'start':
            myTeam = m.team | 0;
            reset();
            setStatus('playing', { team: myTeam });
            break;
          case 'gone': setStatus('gone'); break;
          case 's':
            if (!m.s || !Array.isArray(m.s.u)) break;
            latest = m;   // 状態は丸ごと入っているので、最新の1つだけあればよい
            if (m.ev) for (const ev of m.ev) if (fromServer(ev)) serverEvents.push(ev);
            break;
        }
      };
    },

    disconnect() {
      if (ws) {
        try { ws.send(JSON.stringify({ t: 'leave' })); } catch (_) {}
        try { ws.close(); } catch (_) {}
      }
      ws = null;
      reset();
      setStatus('idle');
    },

    restart() {
      if (ws && status === 'playing') {
        try { ws.send(JSON.stringify({ t: 'restart' })); } catch (_) {}
      }
    },

    /**
     * 固定ステップ1回ぶん。自分の2駒の意図を送り、同じものを手元でも進める。
     * a = 駒番号の小さい側、b = 大きい側（世界座標の向き）。
     */
    tick(a, b) {
      if (!ws || status !== 'playing' || ws.readyState !== 1) return;
      const pa = clone(a), pb = clone(b);
      seq++;
      const pack = (it) => [
        it.move.x, it.move.y,
        it.flick ? it.flick.x : null,
        it.flick ? it.flick.y : null,
      ];
      try {
        ws.send(JSON.stringify({ t: 'i', n: seq, a: pack(pa), b: pack(pb) }));
      } catch (_) {}
      pending.push({ seq, a: pa, b: pb });
      if (pending.length > MAX_PENDING) pending.shift();

      const evs = advance(pa, pb).filter((e) => !fromServer(e));
      if (evs.length) emit('events', evs);
    },

    /**
     * 届いた状態で答え合わせをしてから、予測した「今」を state へ書く。
     * 答え合わせのずれは dt をかけて少しずつ消す。
     */
    apply(state, dt) {
      if (latest) reconcile();
      if (serverEvents.length) {
        const evs = serverEvents;
        serverEvents = [];
        emit('events', evs);
      }

      const k = Math.exp(-SMOOTH_RATE * dt);
      copyState(state, sim);
      state.units.forEach((u, i) => {
        const o = offsets.units[i];
        if (!o) return;
        o.x *= k; o.y *= k;
        u.x += o.x; u.y += o.y;
      });
      offsets.ball.x *= k; offsets.ball.y *= k;
      state.ball.x += offsets.ball.x;
      state.ball.y += offsets.ball.y;
      return true;
    },
  };
}
