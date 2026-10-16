// aim.js — 設定「近くへ補正」。
//
// 踏み込んだ瞬間に、補正する距離の内側にボールや相手の駒があれば、踏み込む向きを
// そちらへ合わせる。候補が複数あるときは、指を払った向きにいちばん近いものを選ぶ。
// 距離の内側に何もなければ操作どおり。
//
//   - 相手の駒：駒の中心 → 相手の中心の向き（潰れている相手は狙わない。上塗りできないので）
//   - 止まっているボール：駒の中心 → ボールの中心の向き
//   - 動いているボール：ボールの行き先を読み、「ちょうど当たる瞬間に、踏み込む向きが
//     ボールの面に直角（＝当たった点での中心どうしを結ぶ線）」になる向き。
//     キックは中心→ボールの向きへ飛ぶので、正面からまっすぐ当てられる。
//
// 距離は表面どうしの隙間で測る（中心どうしではない）。

import { CONFIG } from './config.js';

const STEP = 1 / 60;

/**
 * @param {{x:number,y:number}|null} flick 操作で決まった踏み込みの向き（世界座標）
 * @param {object} unit 踏み込む駒（x, y, team）
 * @param {object} s 試合の状態（ball と units を読む）
 * @param {number} [gap] 補正する距離（表面どうしの隙間、世界座標）
 * @returns {{x:number,y:number}|null} 使う向き。補正しないときは flick をそのまま返す
 */
export function aimTackle(flick, unit, s, gap = CONFIG.aimBall.gap) {
  if (!flick || !unit || !s) return flick;
  const cands = [];

  const b = s.ball;
  if (b && surfaceGap(unit, b, CONFIG.unit.radius + CONFIG.ball.radius) <= gap) {
    const d = aimAtBall(unit, b);
    if (d) cands.push(d);
  }
  if (Array.isArray(s.units)) {
    for (const o of s.units) {
      if (!o || o === unit || o.team === unit.team || o.stunT > 0) continue;
      if (surfaceGap(unit, o, CONFIG.unit.radius * 2) > gap) continue;
      const d = dir(o.x - unit.x, o.y - unit.y);
      if (d) cands.push(d);
    }
  }
  if (!cands.length) return flick;
  if (cands.length === 1) return cands[0];

  // 指を払った向きにいちばん近い候補。向きが立っていない踏み込みなら、
  // 最初の候補（ボールがあればボール）にする
  const f = dir(flick.x, flick.y);
  if (!f) return cands[0];
  let best = cands[0], bestDot = -Infinity;
  for (const c of cands) {
    const dot = c.x * f.x + c.y * f.y;
    if (dot > bestDot) { bestDot = dot; best = c; }
  }
  return best;
}

/**
 * ボールへ正面から当たる向き。ボールが動いていれば行き先を読む。
 * 踏み込みは向き d へ速さ一定で進むので、時刻 t に当たって、そのとき中心どうしを結ぶ線が d と
 * 平行になるには「ボールの位置 B(t) が、駒の出発点から d の向きに（進んだ距離 + 半径の和）
 * 離れている」ことが要る。|B(t) − U0| = 進んだ距離(t) + 半径の和 を満たす最初の t を探し、
 * d = B(t) − U0 の向きにする。
 */
function aimAtBall(u, b) {
  const rr = CONFIG.unit.radius + CONFIG.ball.radius;
  const speed = CONFIG.dash.speed;
  const steps = Math.round(CONFIG.dash.duration / STEP);
  const fr = Math.pow(CONFIG.ball.frictionPerSec, STEP);
  const still = dir(b.x - u.x, b.y - u.y);
  if (Math.hypot(b.vx || 0, b.vy || 0) < 1) return still;

  // game.js と同じ順で進める（踏み込みの向き・速さが決まる → 駒が動く → ボールが動く）
  let bx = b.x, by = b.y, vx = b.vx, vy = b.vy;
  let prevF = Math.hypot(bx - u.x, by - u.y) - rr;
  if (prevF <= 0) return still;   // もう触れている
  let prevBx = bx, prevBy = by;
  for (let k = 1; k <= steps; k++) {
    vx *= fr; vy *= fr;
    bx += vx * STEP; by += vy * STEP;
    const f = Math.hypot(bx - u.x, by - u.y) - speed * STEP * k - rr;
    if (f <= 0) {
      // ステップの間を線形に補って、当たる瞬間のボールの位置を出す
      const a = prevF / (prevF - f);
      return dir(prevBx + (bx - prevBx) * a - u.x, prevBy + (by - prevBy) * a - u.y) || still;
    }
    prevF = f; prevBx = bx; prevBy = by;
  }
  // 踏み込みの間には正面から捕まえられない（速すぎる・遠ざかる）。今の位置へ向ける
  return still;
}

function surfaceGap(a, b, rr) {
  return Math.hypot(b.x - a.x, b.y - a.y) - rr;
}

function dir(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : null;
}
