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
// 同じWi-Fiにいる相手とは、端末どうしで直結（WebRTC）する。
// そのときは片方（ホスト＝チーム0）の端末が match.js で試合を進め、もう片方へ配る。
// やりとりの中身はサーバー経由と同じなので、予測・答え合わせはそのまま使う。
// 直結を試すのはマッチングのあと・試合の前だけで、つながらなければサーバー経由で始める。
//
// 直結の試合でも、入力と状態は直結とサーバー経由の両方で送る。受け取る側は通し番号で
// 先に届いたほうだけを使うので、その時々で速いほうの経路が使われる（Wi-Fiが一瞬詰まっても
// サーバー経由が埋める）。片方の経路が切れても、もう片方で試合を続ける。
//
// イベント（音・演出）は二重に鳴らないよう、出どころを種類で分ける：
//   - 自分の操作で起きるもの・物理の反応 → 手元の予測から即座に出す
//   - 相手の踏み込み／キック／体当たり、ゴール・キックオフ・決着 → サーバーから出す

import { CONFIG } from './config.js';
import { createState, step } from './game.js';
import { decodeState, copyState } from './snapshot.js';
import { createMatch } from './match.js';

const STEP = 1 / 60;
const MAX_PENDING = 180;     // 未確認の入力をこれ以上は抱えない（3秒）
const SMOOTH_RATE = 14;      // 答え合わせのずれを寄せる速さ（1/秒）
// 相手の駒は少しゆっくり寄せる。相手の踏み込みや方向転換は通信の往復ぶん遅れて分かり、
// そのたびに大きくずれる。速く寄せると瞬間移動に見える。
// 実測（往復約200ms・ボット同士）：相手の見え方のずれ 最大 128 → 95、99%点 82 → 69。
const SMOOTH_RATE_OPP = 8;
const BALL_SMOOTH_RATE = 30; // ボールは速く、ぶつかる相手も多いので、ずれを長く引きずらない
// ボールが駒にこの距離（接触距離からの余り）より近づいたら、ボールのずれを
// その駒のずれに揃えていく。描いた位置をばらばらにずらしたまま接触すると
// 「触れていないのに弾かれる／重なっているのに当たらない」に見える。
// 接している瞬間は、駒とボールの位置関係が当たり判定のとおりに描かれる。
const CONTACT_FADE = 3 * CONFIG.unit.radius;
const TELEPORT = 150 * CONFIG.world.scale;   // これ以上ずれたら寄せずに飛ばす（キックオフの配置換えなど）

const PING_MS = 1000;        // 往復時間を測る間隔

const SERVER_ONLY = new Set(['goal', 'kickoff', 'matchend']);

// 直結を試す時間。同じWi-Fiならたいてい1秒もかからない
const LINK_MS = 3500;
// サーバーが「直結で始める」と言ってきたのに、こちらの直結がまだ開いていないとき待つ時間
const OPEN_WAIT_MS = 2500;
// 直結の相手からこれだけ何も届かなければ、切れたものとする
// （Wi-Fiから外れても、直結が閉じたと分かるまでには時間がかかる）
const PEER_SILENCE_MS = 5000;
// サーバーが「相手が抜けた」と言ってきたあと、直結からも何も届かなければ抜けたと決める時間
// （相手がネットだけ切れてWi-Fiはつながっているなら、直結から届き続けるので試合は続く）
const GONE_CONFIRM_MS = 1000;
// STUN/TURN は使わない。端末自身のアドレスどうしでしかつながらないので、
// 実質「同じネットワークにいるときだけ」直結になる
const RTC_CONFIG = { iceServers: [] };
// 送信待ちがこれを超えている経路には送らない（詰まった経路に遅れを積まない。もう一方が届ける）。
// 状態は毎回丸ごとなので小さく（古い状態を溜めない）、入力とイベントつきの状態は大きめに
const WS_BUFFERED = 32 * 1024;
const STATE_BUFFERED = 4 * 1024;

const canDirect = () => typeof RTCPeerConnection === 'function';

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
  let rttWs = -1;                     // サーバーとの往復時間（ms）。未計測は -1
  let rttDc = -1;                     // 直結の相手との往復時間（ms）
  let pingTimer = null;
  // 直結の試合で、どちらの経路が先に届けたか（直近ほど重い）。表示に使う
  const routeScore = { wifi: 0, server: 0 };
  let lastInN = 0;                    // ホスト：受け取った相手の入力の通し番号のうち最新
  const evSeen = new Set();           // イベントを出し終えた状態の通し番号（二重に鳴らさない）

  // 試合の正解をどこからもらうか： server（サーバー経由） | host（自分が進める） | guest（直結の相手から）
  let mode = 'server';
  let pc = null;                      // RTCPeerConnection
  let dc = null;                      // RTCDataChannel（入力・イベント・往復時間。確実に順に届く）
  let sc = null;                      // 状態だけを送る RTCDataChannel（届かなくても再送しない）
  let lastN = 0;                      // 受け取った状態の通し番号のうち最新
  let remoteCands = null;             // 相手の接続情報が来る前に届いた候補（来たら入れる）
  let linkTimer = null;
  let match = null;                   // ホストのときだけ。試合そのもの
  let peerAt = 0;                     // 直結の相手から最後に何か届いた時刻
  let serverSaysGone = false;         // サーバーが「相手が抜けた」と言ってきた（直結の試合中）
  let me = { name: 'ゲスト', rating: 1500 };   // 名乗る名前とレート
  let opp = null;                     // 相手の名前とレート { name, rating }
  let watchers = 0;                   // この試合を観戦している人数
  let sentScore = '';                 // 直結のホストが最後にサーバーへ知らせた得点

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
    rttDc = -1;
    peerAt = performance.now();
    lastN = 0;
    lastInN = 0;
    serverSaysGone = false;
    evSeen.clear();
    routeScore.wifi = routeScore.server = 0;
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

  /** 試合の正解を持つ側へ送る。 */
  function toAuthority(obj) {
    if (mode === 'host') { match.receive(myTeam, obj); return; }
    if (mode === 'guest') {
      // 直結とサーバー経由の両方で送る。ホストは先に届いたほうを使い、遅いほうは捨てる
      const text = JSON.stringify(obj);
      if (dc && dc.readyState === 'open') { try { dc.send(text); } catch (_) {} }
      if (ws && ws.readyState === 1 && ws.bufferedAmount < WS_BUFFERED) { try { ws.send(text); } catch (_) {} }
      return;
    }
    wsSend(obj);
  }

  /** どちらの経路が先に届けたかを数える（直近ほど重く） */
  function countRoute(via) {
    routeScore.wifi *= 0.97;
    routeScore.server *= 0.97;
    routeScore[via] += 1;
  }

  /** ホスト：相手の入力などが届いた（直結・サーバー経由のどちらからでも） */
  function fromGuest(m, via) {
    peerAt = performance.now();
    if (m.t === 'i') {
      const n = Number(m.n);
      if (Number.isInteger(n) && n > lastInN) { lastInN = n; countRoute(via); }
    }
    match.receive(1 - myTeam, m);
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  function dcSend(obj) {
    if (dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  /**
   * 正解を持つ側から届いた状態。via は届いた経路（'server' | 'wifi' | 'local'）。
   * 直結の試合では同じ状態が2つの経路から届くので、通し番号で先に届いたほうだけ使う。
   */
  function fromAuthority(m, via = 'server') {
    if (m.t !== 's' || !m.s || !Array.isArray(m.s.u)) return;
    const n = Number(m.n) || 0;
    // イベントは状態が古くても拾う（イベントつきの状態は確実に届く経路で来るので、
    // 後から来た新しい状態に追い越されることがある）。ただし同じ状態のイベントは一度だけ
    if (m.ev && !(n && evSeen.has(n))) {
      if (n) {
        evSeen.add(n);
        if (evSeen.size > 256) evSeen.delete(evSeen.values().next().value);
      }
      for (const ev of m.ev) if (fromServer(ev)) serverEvents.push(ev);
    }
    if (n && n <= lastN) return;   // 追い越された古い状態・もう一方の経路から先に届いた状態
    lastN = n;
    latest = m;   // 状態は丸ごと入っているので、最新の1つだけあればよい
    if (mode === 'guest') { peerAt = performance.now(); countRoute(via); }
  }

  function rttFrom(m, prev) {
    const r = performance.now() - Number(m.c);
    if (!(r >= 0 && r < 10000)) return prev;
    return prev < 0 ? r : prev * 0.7 + r * 0.3;
  }

  function ping() {
    const msg = { t: 'p', c: performance.now() };
    wsSend(msg);                        // サーバーとの往復
    if (mode !== 'server') dcSend(msg); // 直結中は相手との往復も測る
  }

  // ---------------------------------------------------------- 直結（WebRTC）

  /** マッチングできた。サーバーに仲立ちしてもらいながら直結を試す。 */
  function startLink(team) {
    closeLink();
    myTeam = team;
    remoteCands = [];
    try {
      pc = new RTCPeerConnection(RTC_CONFIG);
    } catch (_) {
      pc = null;
      if (team === 0) wsSend({ t: 'mode', p2p: false });
      return;
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ t: 'rtc', d: { c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } });
    };
    if (team === 0) {
      // ホスト。状態は毎回丸ごと送るが、入力（踏み込み）は落とせないので確実に届く設定にする
      bindChannel(pc.createDataChannel('g', { ordered: true }));
      // 状態は毎回丸ごとなので、落ちたら再送を待つより次を使うほうが早い。
      // 確実に届く経路だと、Wi-Fiで1つ落ちただけで後ろの状態がすべて待たされる
      bindStates(pc.createDataChannel('s', { ordered: false, maxRetransmits: 0 }));
      pc.createOffer()
        .then((o) => pc && pc.setLocalDescription(o))
        .then(() => pc && wsSend({ t: 'rtc', d: { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription } }))
        .catch(() => giveUpLink());
      linkTimer = setTimeout(giveUpLink, LINK_MS);
    } else {
      pc.ondatachannel = (e) => {
        if (e.channel.label === 's') bindStates(e.channel);
        else bindChannel(e.channel);
      };
    }
  }

  function giveUpLink() {
    if (myTeam !== 0 || !pc) return;
    if (dc && dc.readyState === 'open') return;
    closeLink();
    wsSend({ t: 'mode', p2p: false });
  }

  function bindChannel(ch) {
    dc = ch;
    dc.onopen = () => {
      peerAt = performance.now();
      if (myTeam === 0 && mode === 'server' && status === 'waiting') {
        clearTimeout(linkTimer);
        wsSend({ t: 'mode', p2p: true });
      }
    };
    dc.onclose = dcLost;
    dc.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      peerAt = performance.now();
      switch (m.t) {
        case 'p': dcSend({ t: 'P', c: Number(m.c) || 0 }); break;
        case 'P': rttDc = rttFrom(m, rttDc); break;
        case 'bye': peerGone(); break;
        case 'i':
        case 'restart':
          if (mode === 'host') fromGuest(m, 'wifi');
          break;
        default:
          if (mode === 'guest') fromAuthority(m, 'wifi');
      }
    };
  }

  function bindStates(ch) {
    sc = ch;
    sc.onmessage = (e) => {
      if (mode !== 'guest') return;
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      fromAuthority(m, 'wifi');
    };
  }

  function onSignal(d) {
    if (!pc || !d || typeof d !== 'object') return;
    if (d.sdp) {
      pc.setRemoteDescription(d.sdp)
        .then(() => {
          for (const c of remoteCands) pc.addIceCandidate(c).catch(() => {});
          remoteCands = null;
          if (d.sdp.type !== 'offer') return;
          return pc.createAnswer()
            .then((a) => pc.setLocalDescription(a))
            .then(() => wsSend({ t: 'rtc', d: { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription } }));
        })
        .catch(() => {});
    } else if (d.c) {
      if (remoteCands) remoteCands.push(d.c);
      else pc.addIceCandidate(d.c).catch(() => {});
    }
  }

  /** 直結で試合を始める。ホストなら自分の端末で試合を進める。 */
  function beginDirect() {
    mode = myTeam === 0 ? 'host' : 'guest';
    reset();
    if (mode === 'host') {
      const outs = [null, null];
      // 自分の分はその場で受け取る（通信なし）
      outs[myTeam] = { open: true, buffered: 0, send: (text) => fromAuthority(JSON.parse(text), 'local') };
      // 相手へは直結とサーバー経由の両方で送る（サーバーは観戦者にも渡す）
      const dcOpen = () => !!dc && dc.readyState === 'open';
      const wsOpen = () => !!ws && ws.readyState === 1;
      outs[1 - myTeam] = {
        get open() { return dcOpen() || wsOpen(); },
        // 両方の経路が詰まっているときだけ飛ばす（片方が空いていればそちらで届く）
        get buffered() {
          return Math.min(dcOpen() ? dc.bufferedAmount : Infinity, wsOpen() ? ws.bufferedAmount : Infinity);
        },
        send: (text, mustArrive) => {
          const limit = mustArrive ? WS_BUFFERED : STATE_BUFFERED;
          if (dcOpen() && dc.bufferedAmount < limit) {
            try {
              if (!mustArrive && sc && sc.readyState === 'open') sc.send(text);
              else dc.send(text);
            } catch (_) {}
          }
          if (wsOpen() && ws.bufferedAmount < limit) { try { ws.send(text); } catch (_) {} }
        },
      };
      // 試合はタイマーではなく、自分のステップ（tick）に合わせて1つずつ進める。
      // 自分の入力は必ずそのステップに間に合うので、自分の駒の予測が外れない
      match = createMatch(outs);
      sentScore = '';
    }
    setStatus('playing', { team: myTeam, direct: true });
  }

  /** 直結の相手がいなくなった。 */
  function peerGone() {
    if (mode === 'server' || status !== 'playing') return;
    closeLink();
    setStatus('gone');
  }

  /** 直結が切れた。サーバー経由がまだ生きていれば、そちらだけで試合を続ける */
  function dcLost() {
    if (mode === 'server' || status !== 'playing') return;
    // サーバーも「相手が抜けた」と言っていれば、待たずに終える
    if (ws && ws.readyState === 1 && !serverSaysGone) {
      if (dc) dc.onopen = dc.onclose = dc.onmessage = null;
      if (sc) sc.onmessage = null;
      dc = sc = null;
      return;
    }
    peerGone();
  }

  function closeLink() {
    clearTimeout(linkTimer);
    match = null;
    if (dc) {
      dc.onopen = dc.onclose = dc.onmessage = null;
      try { dc.close(); } catch (_) {}
    }
    if (sc) {
      sc.onmessage = null;
      try { sc.close(); } catch (_) {}
    }
    sc = null;
    if (pc) {
      pc.onicecandidate = pc.ondatachannel = null;
      try { pc.close(); } catch (_) {}
    }
    dc = pc = null;
    remoteCands = null;
    mode = 'server';
  }

  const clone = (it) => ({
    move: { x: it.move.x, y: it.move.y },
    flick: it.flick ? { x: it.flick.x, y: it.flick.y } : null,
  });

  return {
    get status() { return status; },
    get myTeam() { return myTeam; },
    get pending() { return pending.length; },
    /**
     * 通信の往復時間（ms）。まだ測れていなければ -1。
     * 直結の試合では、いま速いほうの経路のもの（サーバー経由はサーバーまでの往復）
     */
    get rtt() { return this.route === 'wifi' ? rttDc : rttWs; },
    /** サーバーとの往復時間・直結の相手との往復時間（ms） */
    get rttServer() { return rttWs; },
    get rttWifi() { return rttDc; },
    /** 直結の試合で、いま主に使われている経路 'wifi' | 'server'（直結でなければ 'server'） */
    get route() {
      if (mode === 'server') return 'server';
      return routeScore.server > routeScore.wifi ? 'server' : 'wifi';
    },
    /** 同じWi-Fiで直結しているか */
    get direct() { return mode !== 'server'; },
    /** 相手の名前とレート（分からなければ null） */
    get opponent() { return opp; },
    /** この試合を観戦している人数 */
    get watchers() { return watchers; },
    on(kind, fn) { listeners[kind].push(fn); },

    /** @param {{name?: string, rating?: number}} [who] 名乗る名前とレート */
    connect(who) {
      if (ws && (status === 'connecting' || status === 'waiting' || status === 'playing')) return;
      // 前の対戦の残り（直結で遊んだあとはサーバーとの接続が開いたまま）を片付ける
      closeLink();
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      if (who) me = { name: who.name || 'ゲスト', rating: who.rating };
      opp = null;
      watchers = 0;
      rttWs = -1;
      reset();
      setStatus('connecting');
      try {
        ws = new WebSocket(url());
      } catch (_) {
        setStatus('error');
        return;
      }
      ws.onopen = () => {
        wsSend({ t: 'join', rtc: canDirect(), name: me.name, rating: me.rating });
        ping();
        clearInterval(pingTimer);
        pingTimer = setInterval(ping, PING_MS);
      };
      ws.onerror = () => { if (status !== 'playing') setStatus('error'); };
      ws.onclose = () => {
        // 直結で遊んでいる最中は、サーバーとの接続が切れても直結で試合を続ける
        if (mode !== 'server' && status === 'playing') {
          if (!(dc && dc.readyState === 'open')) peerGone();
          return;
        }
        clearInterval(pingTimer);
        closeLink();
        if (status === 'playing' || status === 'waiting') setStatus('gone');
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        switch (m.t) {
          case 'wait': setStatus('waiting'); break;
          case 'pair':
            if (m.opp) opp = m.opp;
            if (canDirect()) startLink(m.team | 0);
            setStatus('waiting', { linking: true });
            break;
          case 'rtc': onSignal(m.d); break;
          case 'watchers': watchers = m.n | 0; break;
          case 'start':
            myTeam = m.team | 0;
            if (m.opp) opp = m.opp;
            if (m.p2p) {
              if (dc && dc.readyState === 'open') { beginDirect(); break; }
              // 相手側では開いたが、こちらはまだ。少しだけ待つ
              const t0 = performance.now();
              const wait = setInterval(() => {
                if (status !== 'waiting') { clearInterval(wait); return; }
                if (dc && dc.readyState === 'open') { clearInterval(wait); beginDirect(); return; }
                if (performance.now() - t0 > OPEN_WAIT_MS) { clearInterval(wait); closeLink(); setStatus('gone'); }
              }, 50);
              break;
            }
            closeLink();
            reset();
            setStatus('playing', { team: myTeam });
            break;
          case 'gone':
            // 直結中の退出は直結のほうで分かる（直結がもう無ければここで終える）
            if (mode !== 'server' && status === 'playing' && dc && dc.readyState === 'open') {
              serverSaysGone = true;
              break;
            }
            closeLink();
            setStatus('gone');
            break;
          case 'P':
            rttWs = rttFrom(m, rttWs);
            break;
          case 's':
            // サーバーで進む試合の状態、または直結の試合でホストからサーバー経由で届いた状態
            if (mode !== 'host') fromAuthority(m, 'server');
            break;
          case 'i':
          case 'restart':
            // 直結の試合で、相手の入力がサーバー経由で届いた
            if (mode === 'host') fromGuest(m, 'server');
            break;
        }
      };
    },

    disconnect() {
      clearInterval(pingTimer);
      dcSend({ t: 'bye' });
      closeLink();
      if (ws) {
        try { ws.send(JSON.stringify({ t: 'leave' })); } catch (_) {}
        try { ws.close(); } catch (_) {}
      }
      ws = null;
      reset();
      setStatus('idle');
    },

    restart() {
      if (status === 'playing') toAuthority({ t: 'restart' });
    },

    /**
     * 固定ステップ1回ぶん。自分の2駒の意図を送り、同じものを手元でも進める。
     * a = 駒番号の小さい側、b = 大きい側（世界座標の向き）。
     */
    tick(a, b) {
      if (status !== 'playing') return;
      if (mode === 'server' && (!ws || ws.readyState !== 1)) return;
      const pa = clone(a), pb = clone(b);
      seq++;
      const pack = (it) => [
        it.move.x, it.move.y,
        it.flick ? it.flick.x : null,
        it.flick ? it.flick.y : null,
      ];
      toAuthority({ t: 'i', n: seq, a: pack(pa), b: pack(pb) });
      if (mode === 'host') {
        match.step();
        // 直結の試合は得点をサーバーが知らないので、変わったら知らせる（観戦の一覧に出す）
        const sc = match.state.score.join(',');
        if (sc !== sentScore) { sentScore = sc; wsSend({ t: 'score', s: match.state.score }); }
      }
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
      // 直結の相手から何も届かなくなった。サーバーも「抜けた」と言っていれば短く待つだけでよい
      const silence = serverSaysGone ? GONE_CONFIRM_MS : PEER_SILENCE_MS;
      if (mode !== 'server' && status === 'playing' && performance.now() - peerAt > silence) {
        peerGone();
        return false;
      }
      if (latest) reconcile();
      if (serverEvents.length) {
        const evs = serverEvents;
        serverEvents = [];
        emit('events', evs);
      }

      const k = Math.exp(-SMOOTH_RATE * dt);
      const kOpp = Math.exp(-SMOOTH_RATE_OPP * dt);
      const kb = Math.exp(-BALL_SMOOTH_RATE * dt);
      offsets.units.forEach((o, i) => {
        const f = mine(i) ? k : kOpp;
        o.x *= f; o.y *= f;
      });
      const ob = offsets.ball;
      ob.x *= kb; ob.y *= kb;

      // いちばん近い駒の近さ（0 = 接している … 1 = 十分離れている）
      const rr = CONFIG.unit.radius + CONFIG.ball.radius;
      let near = -1, room = 1;
      sim.units.forEach((u, i) => {
        const r = clamp((Math.hypot(sim.ball.x - u.x, sim.ball.y - u.y) - rr) / CONTACT_FADE, 0, 1);
        if (r < room) { room = r; near = i; }
      });
      if (near >= 0) {
        const ou = offsets.units[near];
        ob.x = ou.x + (ob.x - ou.x) * room;
        ob.y = ou.y + (ob.y - ou.y) * room;
      }

      copyState(state, sim);
      state.units.forEach((u, i) => {
        const o = offsets.units[i];
        if (!o) return;
        u.x += o.x; u.y += o.y;
      });
      state.ball.x += ob.x;
      state.ball.y += ob.y;
      return true;
    },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
