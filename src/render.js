// render.js — Canvas 2D 描画。
// プレイエリアはフラット。質感はUI（DOM側）に集中させる。
// 合格ライン：3メートル離れても状況が読めるか。

import { CONFIG, COLORS, VIEW } from './config.js';
import { PHASE, goalMouth, heatRatio, isMatchPoint } from './game.js';

const F = CONFIG.field;
const S = CONFIG.world.scale;   // 450x800 設計の見た目値をコートに追従させる

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
  const view = { cssW: 0, cssH: 0, dpr: 1, uiScale: 1, netTop: 0, wholeField: true };

  // 追従カメラ。ワールドのどこを画面に写すかを持つ。
  // 縦画面ではコート全体が入る倍率で固定され、従来と同じ絵になる。
  // 横画面はコートが画面に収まらないので、注視点（ボールと自分の2駒）を
  // 追いかけながら、その広がりに応じてズームする。
  const cam = { x: CONFIG.field.w / 2, y: CONFIG.field.h / 2, scale: 1 };

  // 自分がどちらのチームか。対人戦で team 1 になったときは盤面を180度回して
  // 「自分の駒が手前・攻める方向が奥」を保つ。回さないと、上下も左右も逆の
  // 盤面を操作することになって、担当（左半画面＝左の駒）の意味が壊れる。
  let myTeam = 0;
  let flip = false;

  /** 画面の左→右の順に並べた自分の2駒。反転時は世界の左右が入れ替わる。 */
  /** 見る側から見た色。自分は常にコーラル、相手は常にシアン。 */
  function teamColor(team) {
    return COLORS.team[team === myTeam ? 0 : 1];
  }

  function myUnitsInScreenOrder(s) {
    const a = s.units[myTeam * 2], b = s.units[myTeam * 2 + 1];
    return flip ? [b, a] : [a, b];
  }

  const CAM = CONFIG.camera;

  function limits() {
    // 全体が入る倍率（下限）と、寄れる上限。
    // 上限は「コート縦の40%」「コート横の55%」を必ず画面に残す線。
    // これ以上寄るとパスの受け手が画面外になり、パスが武器でなくなる。
    const fitAll = Math.min(view.cssW / VIEW.w, view.cssH / VIEW.h);
    const maxIn = Math.min(
      view.cssH / (CONFIG.field.h * CAM.minVisibleH),
      view.cssW / (CONFIG.field.w * CAM.minVisibleW)
    );
    return { min: fitAll, max: Math.max(fitAll, maxIn) };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.cssW = w;
    view.cssH = h;
    view.dpr = dpr;

    const lim = limits();
    view.wholeField = lim.max <= lim.min + 1e-6;

    // DOM の UI はカメラの倍率に引きずられてはいけない（横持ちで潰れる）。
    // 画面の短辺だけで決めるので、向きが変わってもUIの物理サイズは一定。
    view.uiScale = Math.min(w, h) / (VIEW.w / S);

    if (view.wholeField) {
      // 従来どおり：コート上端の上にスコアの帯を確保する
      const fieldTop = (h - VIEW.h * lim.min) * 0.5 + VIEW.padTop * lim.min;
      view.netTop = fieldTop - CONFIG.field.goalDepth * lim.min;
    } else {
      view.netTop = view.uiScale * 56;   // 全体表示ではないので、上端に帯だけ確保する
    }
    return view;
  }

  /** 注視点：ボールと自分の2駒。相手は入れない（カメラを予測可能に保つ） */
  function focus(s) {
    const pts = [s.ball, s.units[myTeam * 2], s.units[myTeam * 2 + 1]];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const m = 90 * S;   // 周囲の余白。詰めすぎると常時ズームで酔う
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      w: (maxX - minX) + m * 2,
      h: (maxY - minY) + m * 2,
    };
  }

  /** 指定倍率のとき、視点中心が取りうる範囲へ丸める（純粋関数） */
  function clampedCenter(x, y, scale) {
    const hw = view.cssW / (2 * scale);
    const hh = view.cssH / (2 * scale);
    const gd = CONFIG.field.goalDepth;
    const em = CAM.edgeMargin;
    // 横は少しコート外まで見せる。そうしないと、駒がタッチラインに寄ったときに
    // 画面の端へ貼り付いて、その先が読めなくなる。
    const x0 = -VIEW.padX - em, x1 = CONFIG.field.w + VIEW.padX + em;
    const y0 = -gd - VIEW.padX, y1 = CONFIG.field.h + gd + VIEW.padX;
    return {
      x: (x1 - x0) <= hw * 2 ? (x0 + x1) / 2 : clamp(x, x0 + hw, x1 - hw),
      y: (y1 - y0) <= hh * 2 ? (y0 + y1) / 2 : clamp(y, y0 + hh, y1 - hh),
    };
  }

  function clampCenter(scale) {
    const c = clampedCenter(cam.x, cam.y, scale);
    cam.x = c.x; cam.y = c.y;
  }

  /**
   * @param {boolean} snap キックオフやリセットでは補間せず飛ばす
   */
  function updateCamera(s, dt, snap = false) {
    const f = focus(s);
    const lim = limits();
    const want = clamp(Math.min(view.cssW / f.w, view.cssH / f.h), lim.min, lim.max);
    const ty = f.y;

    if (snap) {
      cam.scale = want;
      cam.x = f.x;
      cam.y = ty;
    } else {
      // 指数補間。位置よりズームをゆっくりにして、寄り引きの揺れを抑える。
      // ただし「引く」方向だけは速くする。ゆっくり引くと、その間だけ
      // 画面外に出る駒が出てしまうため。
      const kp = 1 - Math.exp(-dt / 0.16);
      const kz = 1 - Math.exp(-dt / (want < cam.scale ? 0.10 : 0.34));
      cam.x += (f.x - cam.x) * kp;
      cam.y += (ty - cam.y) * kp;
      cam.scale += (want - cam.scale) * kz;
    }
    clampCenter(cam.scale);
  }

  function draw(s, fx, input) {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1712';
    ctx.fillRect(0, 0, W, H);

    const sc = cam.scale * view.dpr;
    // シェイクは画面空間。カメラ倍率で揺れ幅が変わらないようにする。
    const shX = fx.shakeX * view.uiScale * view.dpr;
    const shY = fx.shakeY * view.uiScale * view.dpr;

    ctx.save();
    ctx.translate(W / 2 + shX, H / 2 + shY);
    ctx.scale(sc, sc);
    if (flip) ctx.rotate(Math.PI);
    ctx.translate(-cam.x, -cam.y);

    drawTurf(ctx);
    drawGoals(ctx, s);
    drawLines(ctx);
    drawRipples(ctx, fx);
    drawGhosts(ctx, fx);
    drawTrail(ctx, fx);
    drawThreads(ctx, fx);
    if (input) drawAims(ctx, s, input, myUnitsInScreenOrder(s), flip, teamColor);
    drawUnits(ctx, s, fx, input, myTeam, myUnitsInScreenOrder(s), teamColor);
    drawBall(ctx, s, fx);
    drawParticles(ctx, fx);

    ctx.restore();

    // ジョイスティックは画面空間の要素。カメラと一緒に動いてはいけない。
    if (input) drawSticks(ctx, view, input);

    if (fx.flash.a > 0.001) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(1, fx.flash.a) * 0.85;
      ctx.fillStyle = fx.flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  return {
    ctx, view, cam, resize, updateCamera, draw,
    myUnitsInScreenOrder,
    teamColor,
    get flip() { return flip; },
    /** 対人戦で自分が team 1 になったときに呼ぶ */
    setViewpoint(team) {
      myTeam = team | 0;
      flip = myTeam === 1;
    },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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
  ctx.lineWidth = 2 * S;
  const m = 6 * S;

  // 外枠
  ctx.strokeRect(m, m, F.w - m * 2, F.h - m * 2);

  // センターライン + サークル
  ctx.beginPath();
  ctx.moveTo(m, F.h / 2);
  ctx.lineTo(F.w - m, F.h / 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(F.w / 2, F.h / 2, 62 * S, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = COLORS.line;
  ctx.beginPath();
  ctx.arc(F.w / 2, F.h / 2, 3.5 * S, 0, Math.PI * 2);
  ctx.fill();

  // ペナルティエリア / ゴールエリア
  const pw = 250 * S, pd = 104 * S, gw = 158 * S, gd = 42 * S;
  for (const top of [true, false]) {
    const y0 = top ? m : F.h - m - pd;
    ctx.strokeRect((F.w - pw) / 2, y0, pw, pd);
    const gy = top ? m : F.h - m - gd;
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
    ctx.lineWidth = 1 * S;
    ctx.beginPath();
    for (let x = left + 10 * S; x < right; x += 10 * S) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + d);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2 * S;
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

function drawUnits(ctx, s, fx, input, mine, screenOrder, colorOf) {
  const r = CONFIG.unit.radius;

  for (const u of s.units) {
    const color = colorOf(u.team);

    // 盤面から数ミリ浮かせるだけのソフトシャドウ
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = 12 * S;
    ctx.shadowOffsetY = 5 * S;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 内側のわずかな締め
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = r * 0.09;
    ctx.beginPath();
    ctx.arc(u.x, u.y, r * 0.94, 0, Math.PI * 2);
    ctx.stroke();

    // 担当ピップ（左=1点 / 右=2点）。どちらの親指の駒かを一瞬で。
    if (u.team === mine) {
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      const n = (screenOrder.indexOf(u) >= 0 ? screenOrder.indexOf(u) : u.side) + 1;
      for (let i = 0; i < n; i++) {
        const ox = (i - (n - 1) / 2) * r * 0.42;
        ctx.beginPath();
        ctx.arc(u.x + ox, u.y, r * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // クールダウンアーク
    if (u.cooldown > 0) {
      const t = u.cooldown / CONFIG.unit.cooldown;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2.6 * S;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(u.x, u.y, r + 5.5 * S, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 操作中のリング
    if (u.team === mine && input) {
      const st = input.pointers[screenOrder.indexOf(u)];
      if (st) {
        ctx.strokeStyle = `rgba(255,255,255,${0.28 * st.alpha})`;
        ctx.lineWidth = 1.5 * S;
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 11 * S, 0, Math.PI * 2);
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

  // 発光。コートを広げてボールが小さく見えるぶん、下限を厚めにしてある
  // （「3メートル離れても状況が読めるか」の合格ラインを守るため）。
  const glowR = r * (4.0 + ratio * 1.6 + (mp ? pulse * 1.0 : 0));
  const g = ctx.createRadialGradient(b.x, b.y, r * 0.4, b.x, b.y, glowR);
  g.addColorStop(0, rgba(c, 0.46 * (0.6 + ratio * 0.4 + (mp ? 0.35 : 0))));
  g.addColorStop(0.45, rgba(c, 0.16 * (0.6 + ratio * 0.4)));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 8 * S;
  ctx.shadowOffsetY = 3 * S;
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
    const width = (3.4 + step * 5.6) * S;
    const alpha = (0.78 + step * 0.22) * ease;

    const g = ctx.createLinearGradient(th.ax, th.ay, th.bx, th.by);
    g.addColorStop(0, `rgba(255,255,255,${alpha * 0.25})`);
    g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, `rgba(255,255,255,${alpha * 0.25})`);

    ctx.save();
    ctx.shadowColor = th.color;
    ctx.shadowBlur = (16 + step * 28) * S;
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
    ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, rp.r * (1.6 - t), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- 操作の表示

/**
 * 蹴る向きの予告矢印。
 * 「今この指のまま離したらボールはどっちへ飛ぶか」をボールから伸ばす。
 * 出す条件は実際に蹴れる条件とそろえてある（足元にある・クールダウンが明けている・
 * 指が動いている）。出ていなければ、離してもキックにはならない。
 *
 * aims は画面座標。盤面を180度回して見ている側では、ワールドの向きは逆になる。
 */
function drawAims(ctx, s, input, screenOrder, flip, colorOf) {
  const b = s.ball;
  const A = CONFIG.aim;
  const reach = CONFIG.unit.radius + CONFIG.ball.radius + CONFIG.kick.reachPad;

  for (let side = 0; side < 2; side++) {
    const a = input.aims && input.aims[side];
    const u = screenOrder[side];
    if (!a || !u || u.cooldown > 0) continue;
    if (Math.hypot(b.x - u.x, b.y - u.y) > reach) continue;

    const k = flip ? -1 : 1;
    const color = colorOf(u.team);
    const r0 = CONFIG.ball.radius * 2.2;
    const r1 = r0 + A.length;

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(Math.atan2(a.y * k, a.x * k));

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.2 * S;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r0, 0);
    ctx.lineTo(r1 - A.head * 0.7, 0);
    ctx.stroke();
    ctx.lineCap = 'butt';

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r1, 0);
    ctx.lineTo(r1 - A.head, A.head * 0.52);
    ctx.lineTo(r1 - A.head, -A.head * 0.52);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

export function drawSticks(ctx, view, input) {
  const d = view.dpr;
  ctx.save();
  ctx.setTransform(d, 0, 0, d, 0, 0);   // 以降は CSS px で描く

  for (const st of input.pointers) {
    if (!st) continue;
    const a = Math.max(0, st.alpha);
    const grow = Math.min(1, (performance.now() - st.born) / 130);
    const scale = st.dying ? 0.94 + 0.06 * a : 0.96 + 0.04 * grow;

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
    ctx.fillStyle = `rgba(255,255,255,${0.16 * a})`;
    ctx.beginPath();
    ctx.arc(st.knobX - st.baseX, st.knobY - st.baseY, CONFIG.stick.knobRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * a})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }
  ctx.restore();
}
