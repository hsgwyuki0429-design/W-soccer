// snapshot.js — 試合状態を丸ごと配る／受け取るための詰め替え。
// 純粋モジュール（サーバーとクライアントの両方で使う）。
//
// 対人戦のクライアントは、届いた状態から自分の入力を再生して「今」を予測する。
// 再生に使う step() は状態のすべてを読むので、描画に要る値だけでなく
// 内部の値（クールダウン、スタン、膠着カウンタなど）も欠かさず運ぶ。

const PHASES = ['kickoff', 'play', 'goal', 'over'];

const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, d = -1) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function encodeState(s) {
  return {
    u: s.units.map((u) => [
      r3(u.x), r3(u.y), r3(u.vx), r3(u.vy),
      r3(u.cooldown), r3(u.dashT), r3(u.dashX), r3(u.dashY), r3(u.stunT),
      (u.dashHit ? 1 : 0) | (u.contact ? 2 : 0),
      r3(u.faceX), r3(u.faceY),
    ]),
    b: [r3(s.ball.x), r3(s.ball.y), r3(s.ball.vx), r3(s.ball.vy)],
    g: [
      PHASES.indexOf(s.phase), r3(s.phaseT), r3(s.time), r3(s.heatT),
      s.kicker, s.lastTouch, s.chain, s.chainTeam, s.kickoffTeam,
      r3(s.stuckT), r3(s.pinX), r3(s.pinY), r3(s.squeezeT), r3(s.wallCool || 0),
      num(s.possess), num(s.concededBy), s.winner, s.score[0], s.score[1],
    ],
  };
}

/** encodeState の逆。駒の数は s 側に合わせてある前提（対人戦は常に4駒）。 */
export function decodeState(s, snap) {
  for (let i = 0; i < s.units.length; i++) {
    const u = s.units[i], a = snap.u[i];
    if (!a) continue;
    u.x = a[0]; u.y = a[1]; u.vx = a[2]; u.vy = a[3];
    u.cooldown = a[4]; u.dashT = a[5]; u.dashX = a[6]; u.dashY = a[7]; u.stunT = a[8];
    u.dashHit = (a[9] & 1) !== 0;
    u.contact = (a[9] & 2) !== 0;
    u.faceX = a[10]; u.faceY = a[11];
  }
  const b = snap.b;
  s.ball.x = b[0]; s.ball.y = b[1]; s.ball.vx = b[2]; s.ball.vy = b[3];
  const g = snap.g;
  s.phase = PHASES[g[0]] || PHASES[0];
  s.phaseT = g[1]; s.time = g[2]; s.heatT = g[3];
  s.kicker = g[4]; s.lastTouch = g[5]; s.chain = g[6]; s.chainTeam = g[7];
  s.kickoffTeam = g[8];
  s.stuckT = g[9]; s.pinX = g[10]; s.pinY = g[11]; s.squeezeT = g[12]; s.wallCool = g[13];
  s.possess = g[14]; s.concededBy = g[15]; s.winner = g[16];
  s.score[0] = g[17]; s.score[1] = g[18];
}

/** src の中身を dst へ写す（dst の配列・オブジェクトは作り直さない）。 */
export function copyState(dst, src) {
  for (const k in src) {
    const v = src[k];
    if (k === 'units' || k === 'ball' || k === 'score' || k === 'events') continue;
    if (typeof v !== 'object' || v === null) dst[k] = v;
  }
  dst.score[0] = src.score[0];
  dst.score[1] = src.score[1];
  Object.assign(dst.ball, src.ball);
  for (let i = 0; i < dst.units.length && i < src.units.length; i++) {
    Object.assign(dst.units[i], src.units[i]);
  }
}
