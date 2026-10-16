// spectate.js — 観戦のクライアント。
//
// 観戦者は操作しないので、予測も答え合わせも要らない。届いた状態を少し（DELAY_MS）
// 遅らせて、前後2つの状態のあいだを時刻で補って描く。状態は約30Hzで届き、
// 届く間隔も揺れるので、遅らせずに描くとカクつく。
//
// 試合の一覧は /rooms（HTTP）から取る。

import { createState } from './game.js';
import { decodeState, copyState } from './snapshot.js';

const DELAY_MS = 110;     // 描く時刻を、届いた時刻からこれだけ遅らせる
const KEEP = 12;          // 抱えておく状態の数
const TELEPORT = 300;     // 前後でこれ以上離れていたら補わない（キックオフの配置換えなど）

/** 観戦できる試合の一覧。サーバーが無い（静的配信など）ときは null */
export async function fetchRooms() {
  try {
    const res = await fetch(`${location.origin}/rooms`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j.rooms) ? j.rooms : null;
  } catch (_) {
    return null;
  }
}

export function createSpectator() {
  let ws = null;
  let status = 'idle';     // idle | connecting | watching | ended | error
  let info = null;         // { id, names, ratings }
  const listeners = { status: [], events: [] };
  let snaps = [];          // { at, st } 古い順
  let lastN = 0;
  const pool = [];
  let evq = [];            // { at, evs } 描く時刻に追いついたら出すイベント

  function emit(kind, ...a) { for (const fn of listeners[kind]) fn(...a); }
  function setStatus(s, extra) { status = s; emit('status', s, extra); }

  function close() {
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch (_) {}
    }
    ws = null;
    snaps = [];
    lastN = 0;
    evq = [];
  }

  function onState(m) {
    if (!m.s || !Array.isArray(m.s.u)) return;
    // 音や演出は、その状態を描くときに出す（絵より先に鳴らない）
    if (m.ev && m.ev.length) evq.push({ at: performance.now(), evs: m.ev });
    const n = Number(m.n) || 0;
    if (n && n <= lastN) return;
    lastN = n;
    const st = pool.pop() || createState();
    decodeState(st, m.s);
    snaps.push({ at: performance.now(), st });
    while (snaps.length > KEEP) pool.push(snaps.shift().st);
  }

  return {
    get status() { return status; },
    /** 見ている試合 { id, names, ratings } */
    get info() { return info; },
    on(kind, fn) { listeners[kind].push(fn); },

    watch(id) {
      close();
      info = null;
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`);
      } catch (_) {
        setStatus('error');
        return;
      }
      ws.onopen = () => ws.send(JSON.stringify({ t: 'watch', id }));
      ws.onerror = () => { if (status === 'connecting') setStatus('error'); };
      ws.onclose = () => { if (status === 'watching' || status === 'connecting') setStatus('ended'); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        switch (m.t) {
          case 'watching':
            info = { id: m.id, names: m.names || ['?', '?'], ratings: m.ratings || [] };
            setStatus('watching', info);
            break;
          case 'nowatch': close(); setStatus('error', { full: !!m.full }); break;
          case 'ended': close(); setStatus('ended'); break;
          case 's': onState(m); break;
        }
      };
    },

    stop() {
      close();
      info = null;
      setStatus('idle');
    },

    /**
     * 描く時刻（今 − DELAY_MS）の状態を state へ書く。まだ何も届いていなければ false。
     */
    apply(state, now = performance.now()) {
      if (!snaps.length) return false;
      const t = now - DELAY_MS;
      while (evq.length && evq[0].at <= t) emit('events', evq.shift().evs);
      let i = snaps.length - 1;
      while (i > 0 && snaps[i - 1].at > t) i--;
      // snaps[i-1] と snaps[i] のあいだ。描く時刻より新しい状態が無ければ最新をそのまま
      const b = snaps[i], a = i > 0 ? snaps[i - 1] : null;
      copyState(state, b.st);
      if (!a || t >= b.at) return true;
      const k = Math.max(0, Math.min(1, (t - a.at) / Math.max(1, b.at - a.at)));
      const lerp = (dst, p, q) => {
        if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > TELEPORT) return;
        dst.x = p.x + (q.x - p.x) * k;
        dst.y = p.y + (q.y - p.y) * k;
      };
      lerp(state.ball, a.st.ball, b.st.ball);
      for (let j = 0; j < state.units.length && j < a.st.units.length; j++) {
        lerp(state.units[j], a.st.units[j], b.st.units[j]);
      }
      return true;
    },
  };
}
