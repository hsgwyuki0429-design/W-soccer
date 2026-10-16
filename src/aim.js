// aim.js — 設定「近いボールへ向ける」。
//
// 踏み込んだ瞬間にボールがすぐそばにあれば、操作の向きではなく
// 「駒の中心 → ボールの中心」の向きへ踏み込む。キックはもともと中心→ボールの
// 向きへ飛ぶので、体をボールへまっすぐ当てられ、ボールは駒から見た向きのまま飛ぶ。
// 離れているときは何もしない（操作どおり）。

import { CONFIG } from './config.js';

/**
 * @param {{x:number,y:number}|null} flick 操作で決まった踏み込みの向き（世界座標）
 * @param {{x:number,y:number}} unit 駒
 * @param {{x:number,y:number}} ball ボール
 * @returns {{x:number,y:number}|null} 使う向き。flick が無ければ null のまま
 */
export function aimAtNearBall(flick, unit, ball) {
  if (!flick || !unit || !ball) return flick;
  const dx = ball.x - unit.x, dy = ball.y - unit.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return flick;
  const gap = d - CONFIG.unit.radius - CONFIG.ball.radius;   // 表面どうしの隙間
  if (gap > CONFIG.aimBall.gap) return flick;
  return { x: dx / d, y: dy / d };
}
