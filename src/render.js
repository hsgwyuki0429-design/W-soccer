// render.js — Canvas 2D 描画。
// プレイエリアはフラット。質感はUI（DOM側）に集中させる。
// 合格ライン：3メートル離れても状況が読めるか。

import { CONFIG, COLORS, VIEW, TEAM_PLAYER } from './config.js';
import { PHASE, goalMouth, heatRatio, isMatchPoint } from './game.js';

const F = CONFIG.field;

// ---------------------------------------------------------------- color utils

function hexToRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const RGB = {
  white: [255, 255, 255],
  mid: hexToRgb(COLORS.heatMid),
  hot: hexToRgb(COLORS.heatHot),
  gold: hexToRgb(COLORS.gold),
};

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/** ヒートに応じたボール色：白 → #ffd166 → #ff8c42 */
export function heatColor(ratio) {
  return ratio < 0.5
    ? mix(RGB.white, RGB.mid, ratio / 0.5)
    : mix(RGB.mid, RGB.hot, (ratio - 0.5) / 0.5);
}

// ---------------------------------------------------------------- main

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { scale: 1, offX: 0, offY: 0, cssW: 0, cssH: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const scale = Math.min(w / VIEW.w, h / VIEW.h);
    view.scale = scale * dpr;
    view.offX = (w - VIEW.w * scale) * 0.5 * dpr + VIEW.padX * view.scale;
    view.offY = (h - VIEW.h * scale) * 0.5 * dpr + VIEW.padTop * view.scale;
    view.cssW = w;
    view.cssH = h;
    view.cssScale = scale;
    // フィールド上端（CSS px）と、その上のゴールネット上端。HUD帯の高さに使う。
    view.fieldTop = (h - VIEW.h * scale) * 0.5 + VIEW.padTop * scale;
    view.netTop = view.fieldTop - CONFIG.field.goalDepth * scale;
    return view;
  }

  /** クライアント座標 → 論理フィールド座標 */
  function toLogical(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const s = view.cssScale || 1;
    const ox = (r.width - VIEW.w * s) * 0.5 + VIEW.padX * s;
    const oy = (r.height - VIEW.h * s) * 0.5 + VIEW.padTop * s;
    return {
      x: (clientX - r.left - ox) / s,
      y: (clientY - r.top - oy) / s,
    };
  }

  function draw(s, fx, input) {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1712';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(view.offX + fx.shakeX * view.scale, view.offY + fx.shakeY * view.scale);
    ctx.scale(view.scale, view.scale);

    drawTurf(ctx);
    drawGoals(ctx, s);
    drawLines(ctx);
    drawRipples(ctx, fx);
    drawGhosts(ctx, fx);
    drawTrail(ctx, fx);
    drawThreads(ctx, fx);
    drawUnits(ctx, s, fx, input);
    drawBall(ctx, s, fx);
    drawParticles(ctx, fx);

    ctx.restore();

    if (input) drawSticks(ctx, view, input);

    if (fx.flash.a > 0.001) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(1, fx.flash.a) * 0.85;
      ctx.fillStyle = fx.flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  return { ctx, view, resize, toLogical, draw };
}

// ---------------------------------------------------------------- field

function drawTurf(ctx) {
  const stripes = 10;
  const sh = F.h / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? COLORS.turfA : COLORS.turfB;
    ctx.fillRect(0, i * sh, F.w, sh + 0.5);
  }
}

function drawLines(ctx) {
  ctx.save();
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;

  // 外枠
  ctx.strokeRect(6, 6, F.w - 12, F.h - 12);

  // センターライン + サークル
  ctx.beginPath();
  ctx.moveTo(6, F.h / 2);
  ctx.lineTo(F.w - 6, F.h / 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(F.w / 2, F.h / 2, 62, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = COLORS.line;
  ctx.beginPath();
  ctx.arc(F.w / 2, F.h / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // ペナルティエリア / ゴールエリア
  const pw = 250, pd = 104, gw = 158, gd = 42;
  for (const top of [true, false]) {
    const y0 = top ? 6 : F.h - 6 - pd;
    ctx.strokeRect((F.w - pw) / 2, y0, pw, pd);
    const gy = top ? 6 : F.h - 6 - gd;
    ctx.strokeRect((F.w - gw) / 2, gy, gw, gd);
  }
  ctx.restore();
}

function drawGoals(ctx, s) {
  const { left, right } = goalMouth();
  const d = F.goalDepth;
  for (const top of [true, false]) {
    const y0 = top ? -d : F.h;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(left, y0, F.goalWidth, d);

    // ネットの縦糸
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = left + 10; x < right; x += 10) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + d);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, top ? 0 : F.h);
    ctx.lineTo(left, y0 + (top ? 0 : d));
    ctx.moveTo(right, top ? 0 : F.h);
    ctx.lineTo(right, y0 + (top ? 0 : d));
    ctx.moveTo(left, top ? -d : F.h + d);
    ctx.lineTo(right, top ? -d : F.h + d);
    ctx.stroke();
    ctx.restore();
  }

  // ポスト
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (const x of [left, right]) {
    for (const y of [0, F.h]) {
      ctx.beginPath();
      ctx.arc(x, y, CONFIG.field.postRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- entities

function drawUnits(ctx, s, fx, input) {
  const r = CONFIG.unit.radius;

  for (const u of s.units) {
    const color = COLORS.team[u.team];

    // 盤面から数ミリ浮かせるだけのソフトシャドウ
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 内側のわずかな締め
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(u.x, u.y, r - 1.5, 0, Math.PI * 2);
    ctx.stroke();

    // 担当ピップ（左=1点 / 右=2点）。どちらの親指の駒かを一瞬で。
    if (u.team === TEAM_PLAYER) {
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      const n = u.side + 1;
      for (let i = 0; i < n; i++) {
        const ox = (i - (n - 1) / 2) * 8;
        ctx.beginPath();
        ctx.arc(u.x + ox, u.y, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // クールダウンアーク
    if (u.cooldown > 0) {
      const t = u.cooldown / CONFIG.unit.cooldown;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(u.x, u.y, r + 5.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 操作中のリング
    if (u.team === TEAM_PLAYER && input) {
      const st = input.sticks[u.side];
      if (st) {
        ctx.strokeStyle = `rgba(255,255,255,${0.28 * st.alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 11, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

function drawBall(ctx, s, fx) {
  const b = s.ball;
  const ratio = heatRatio(s);
  const mp = isMatchPoint(s) && s.phase !== PHASE.OVER;
  const pulse = 0.5 + 0.5 * Math.sin(fx.t * 6.5);
  const c = mp ? mix(heatColor(ratio), RGB.gold, 0.55 + 0.45 * pulse) : heatColor(ratio);
  const r = CONFIG.ball.radius;

  // 発光
  const glowR = r * (3.1 + ratio * 1.4 + (mp ? pulse * 0.9 : 0));
  const g = ctx.createRadialGradient(b.x, b.y, r * 0.4, b.x, b.y, glowR);
  g.addColorStop(0, rgba(c, 0.42 * (0.35 + ratio * 0.65 + (mp ? 0.35 : 0))));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = rgba(c, 1);
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTrail(ctx, fx) {
  for (const p of fx.trail) {
    const t = p.life / p.max;
    const c = heatColor(p.heat);
    ctx.fillStyle = rgba(c, 0.16 * t);
    ctx.beginPath();
    ctx.arc(p.x, p.y, CONFIG.ball.radius * (0.35 + 0.55 * t), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** パスの糸：コンボが進むほど明るく、太く。音のピッチ上昇と同期。 */
function drawThreads(ctx, fx) {
  for (const th of fx.threads) {
    const t = th.life / th.max;
    const ease = t * t;                       // すっと消える
    const step = Math.min(th.chain, 8) / 8;
    const width = 3.4 + step * 5.6;
    const alpha = (0.78 + step * 0.22) * ease;

    const g = ctx.createLinearGradient(th.ax, th.ay, th.bx, th.by);
    g.addColorStop(0, `rgba(255,255,255,${alpha * 0.25})`);
    g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, `rgba(255,255,255,${alpha * 0.25})`);

    ctx.save();
    ctx.shadowColor = th.color;
    ctx.shadowBlur = 16 + step * 28;
    ctx.strokeStyle = g;
    ctx.lineWidth = width * (0.6 + 0.4 * ease);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(th.ax, th.ay);
    ctx.lineTo(th.bx, th.by);
    ctx.stroke();

    // 糸を走る光点
    const k = 1 - t;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.arc(th.ax + (th.bx - th.ax) * k, th.ay + (th.by - th.ay) * k, width * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawParticles(ctx, fx) {
  for (const p of fx.particles) {
    const t = Math.max(0, p.life / p.max);
    ctx.globalAlpha = t;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (0.4 + 0.6 * t), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawGhosts(ctx, fx) {
  for (const g of fx.ghosts) {
    const t = g.life / g.max;
    ctx.globalAlpha = 0.22 * t;
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r * (0.75 + 0.25 * t), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRipples(ctx, fx) {
  for (const rp of fx.ripples) {
    const t = rp.life / rp.max;
    ctx.strokeStyle = rp.color;
    ctx.globalAlpha = 0.35 * t;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, rp.r * (1.6 - t), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- joystick

export function drawSticks(ctx, view, input) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(view.offX, view.offY);
  ctx.scale(view.scale, view.scale);

  for (const st of input.sticks) {
    if (!st) continue;
    const a = Math.max(0, st.alpha);
    const grow = Math.min(1, (performance.now() - st.born) / 130);
    const scale = (st.dying ? 0.94 + 0.06 * a : 0.96 + 0.04 * grow);

    ctx.save();
    ctx.translate(st.baseX, st.baseY);
    ctx.scale(scale, scale);

    // ベース
    ctx.fillStyle = `rgba(255,255,255,${0.05 * a})`;
    ctx.beginPath();
    ctx.arc(0, 0, CONFIG.stick.maxRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.24 * a})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // ノブ
    const kx = st.knobX - st.baseX, ky = st.knobY - st.baseY;
    ctx.fillStyle = `rgba(255,255,255,${0.16 * a})`;
    ctx.beginPath();
    ctx.arc(kx, ky, 25, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * a})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }
  ctx.restore();
}
