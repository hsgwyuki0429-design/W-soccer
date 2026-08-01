// effects.js — パーティクル / 残像 / 画面シェイク / ヒットストップ / パスの糸。
// 状態を持つだけ。描画は render.js が読み取って行う。
// 距離・速度はワールド空間なので、コートのスケールに追従させる。

import { CONFIG } from './config.js';

const S = CONFIG.world.scale;              // 大きさ
const V = S * CONFIG.world.pace;           // 速度

const reduced = typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createEffects() {
  return {
    reduced,
    particles: [],
    ghosts: [],
    threads: [],
    trail: [],
    ripples: [],
    trauma: 0,
    shakeX: 0,
    shakeY: 0,
    hitstop: 0,
    flash: { a: 0, color: '#ffffff' },
    t: 0,
  };
}

const MAX_PARTICLES = reduced ? 60 : 220;

function push(fx, p) {
  if (fx.particles.length >= MAX_PARTICLES) fx.particles.shift();
  fx.particles.push(p);
}

export function burst(fx, x, y, dx, dy, color, count = 12, speed = 220) {
  if (reduced) count = Math.ceil(count * 0.4);
  speed *= V;
  const base = Math.atan2(dy, dx);
  for (let i = 0; i < count; i++) {
    const a = base + (Math.random() - 0.5) * 1.9;
    const sp = speed * (0.35 + Math.random() * 0.9);
    push(fx, {
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.3 + Math.random() * 0.28,
      max: 0.58,
      r: (1.4 + Math.random() * 2.4) * S,
      color,
      drag: 0.06,
    });
  }
}

export function sparkle(fx, x, y, color, count = 18, spread = 70) {
  if (reduced) count = Math.ceil(count * 0.4);
  spread *= S;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (60 + Math.random() * 320) * V;
    push(fx, {
      x: x + Math.cos(a) * Math.random() * spread,
      y: y + Math.sin(a) * Math.random() * spread,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60 * V,
      life: 0.5 + Math.random() * 0.6,
      max: 1.1,
      r: (1.2 + Math.random() * 2.6) * S,
      color,
      drag: 0.12,
    });
  }
}

export function ghost(fx, x, y, r, color) {
  if (reduced) return;
  fx.ghosts.push({ x, y, r, color, life: 0.24, max: 0.24 });
  if (fx.ghosts.length > 40) fx.ghosts.shift();
}

export function ripple(fx, x, y, color, r = 26) {
  r *= S;
  fx.ripples.push({ x, y, r, color, life: 0.34, max: 0.34 });
  if (fx.ripples.length > 24) fx.ripples.shift();
}

/** 自駒A→自駒Bのパス成立。このゲームで最も気持ちいい瞬間。 */
export function thread(fx, ax, ay, bx, by, chain, color) {
  fx.threads.push({
    ax, ay, bx, by,
    chain,
    life: 0.3,
    max: 0.3,
    color,
  });
  if (fx.threads.length > 8) fx.threads.shift();
}

export function shake(fx, amount) {
  fx.trauma = Math.min(1, fx.trauma + (reduced ? amount * 0.25 : amount));
}

export function hitstop(fx, seconds) {
  fx.hitstop = Math.max(fx.hitstop, reduced ? seconds * 0.4 : seconds);
}

export function flash(fx, color, amount = 0.75) {
  fx.flash.color = color;
  fx.flash.a = Math.max(fx.flash.a, reduced ? amount * 0.5 : amount);
}

export function trailPoint(fx, x, y, heat) {
  const last = fx.trail[fx.trail.length - 1];
  if (last && Math.hypot(last.x - x, last.y - y) < 3 * S) return;
  fx.trail.push({ x, y, life: 0.32, max: 0.32, heat });
  if (fx.trail.length > 34) fx.trail.shift();
}

export function updateEffects(fx, dt) {
  fx.t += dt;

  for (let i = fx.particles.length - 1; i >= 0; i--) {
    const p = fx.particles[i];
    p.life -= dt;
    if (p.life <= 0) { fx.particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const d = Math.pow(p.drag, dt);
    p.vx *= d; p.vy *= d;
  }

  decay(fx.ghosts, dt);
  decay(fx.threads, dt);
  decay(fx.trail, dt);
  decay(fx.ripples, dt);

  // シェイク（trauma^2 で立ち上がりを鋭く）
  fx.trauma = Math.max(0, fx.trauma - dt * 1.9);
  const mag = fx.trauma * fx.trauma * 16;   // 設計単位。画面空間への変換は render 側
  fx.shakeX = (Math.random() * 2 - 1) * mag;
  fx.shakeY = (Math.random() * 2 - 1) * mag;

  fx.flash.a = Math.max(0, fx.flash.a - dt * 2.2);
  if (fx.hitstop > 0) fx.hitstop = Math.max(0, fx.hitstop - dt);
}

function decay(arr, dt) {
  for (let i = arr.length - 1; i >= 0; i--) {
    arr[i].life -= dt;
    if (arr[i].life <= 0) arr.splice(i, 1);
  }
}

export function clearEffects(fx) {
  fx.particles.length = 0;
  fx.ghosts.length = 0;
  fx.threads.length = 0;
  fx.trail.length = 0;
  fx.ripples.length = 0;
  fx.trauma = 0;
  fx.flash.a = 0;
  fx.hitstop = 0;
}
