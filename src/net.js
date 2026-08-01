// net.js — 対人戦のクライアント。
//
// 試合を進めるのはサーバー。ここがやるのは3つだけ。
//   1. 自分の2駒ぶんの「意図」を送る
//   2. 届いたスナップショットを溜める
//   3. 少し過去（BUFFER_MS）を描くように補間して、state へ書き戻す
//
// わざと遅らせて描くのは、30Hzで届く位置をそのまま出すとカクつくため。
// 遅らせたぶん、到着のばらつきを吸収して滑らかに繋げられる。
// イベント（キック音やゴール演出）も、その遅らせた時刻に合わせて発火させる。
// でないと音だけ先に鳴る。

const BUFFER_MS = 100;
const MAX_BUFFER = 40;

export function createNet() {
  let ws = null;
  let status = 'idle';       // idle | connecting | waiting | playing | gone | error
  let myTeam = 0;
  const buf = [];
  const listeners = { status: [], events: [] };

  function emit(kind, ...a) { for (const fn of listeners[kind]) fn(...a); }
  function setStatus(s, info) { status = s; emit('status', s, info); }

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  return {
    get status() { return status; },
    get myTeam() { return myTeam; },
    on(kind, fn) { listeners[kind].push(fn); },

    connect() {
      if (ws && (status === 'connecting' || status === 'waiting' || status === 'playing')) return;
      buf.length = 0;
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
            buf.length = 0;
            setStatus('playing', { team: myTeam });
            break;
          case 'gone': setStatus('gone'); break;
          case 's':
            m.recv = performance.now();
            m.fired = false;
            buf.push(m);
            while (buf.length > MAX_BUFFER) buf.shift();
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
      buf.length = 0;
      setStatus('idle');
    },

    restart() {
      if (ws && status === 'playing') {
        try { ws.send(JSON.stringify({ t: 'restart' })); } catch (_) {}
      }
    },

    /** 自分の2駒ぶん。a = 画面左側の駒、b = 画面右側の駒 */
    sendIntents(a, b) {
      if (!ws || status !== 'playing' || ws.readyState !== 1) return;
      const pack = (it) => [
        it.move.x, it.move.y,
        it.flick ? it.flick.x : null,
        it.flick ? it.flick.y : null,
      ];
      try {
        ws.send(JSON.stringify({ t: 'i', a: pack(a), b: pack(b) }));
      } catch (_) {}
    },

    /**
     * 溜めたスナップショットから、BUFFER_MS ぶん過去の状態を作って state へ書く。
     * 位置は前後2つの線形補間、離散値（フェーズやスコア）は新しい側をそのまま使う。
     */
    apply(state, now) {
      if (buf.length === 0) return false;
      const target = now - BUFFER_MS;

      let older = null, newer = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].recv <= target) { older = buf[i]; newer = buf[i + 1] || null; break; }
      }
      if (!older) older = buf[0];
      if (!newer) newer = older;

      const span = newer.recv - older.recv;
      const k = span > 1 ? Math.min(1, Math.max(0, (target - older.recv) / span)) : 1;
      const lerp = (a, b) => a + (b - a) * k;

      for (let i = 0; i < 4; i++) {
        const u = state.units[i];
        const A = older.u[i], B = newer.u[i];
        if (!A || !B) continue;
        u.x = lerp(A[0], B[0]);
        u.y = lerp(A[1], B[1]);
        u.vx = lerp(A[2], B[2]);
        u.vy = lerp(A[3], B[3]);
        u.cooldown = newer.u[i][4];
        u.dashT = newer.u[i][5];
      }
      state.ball.x = lerp(older.b[0], newer.b[0]);
      state.ball.y = lerp(older.b[1], newer.b[1]);
      state.ball.vx = lerp(older.b[2], newer.b[2]);
      state.ball.vy = lerp(older.b[3], newer.b[3]);

      state.phase = newer.ph;
      state.score[0] = newer.sc[0];
      state.score[1] = newer.sc[1];
      state.kickoffTeam = newer.ko;
      state.heatT = newer.ht;
      state.chain = newer.ch;
      state.winner = newer.w;

      // 描いている時刻を追い越したスナップショットのイベントだけを発火する
      for (const snap of buf) {
        if (snap.fired || snap.recv > target) continue;
        snap.fired = true;
        if (snap.ev && snap.ev.length) emit('events', snap.ev);
      }
      // 使い終わった古いものは捨てる
      while (buf.length > 2 && buf[1].recv < target - 500) buf.shift();
      return true;
    },
  };
}
