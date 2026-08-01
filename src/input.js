// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のスティック状態だけ。
//
// ドラッグ中は「進行方向が変わる」だけで、どれだけ速く動かしても何も起きない。
// アクション（キック / 体当たり / ダッシュ）が出るのは、
// スワイプしながら指を離した瞬間だけ。止まった状態で離せば何も起きない。

import { CONFIG } from './config.js';

const S = CONFIG.stick;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {(clientX:number, clientY:number) => {x:number,y:number}} toLogical
 * @param {(name:string) => void} onFeedback  スティック出現などの通知
 */
export function createInput(canvas, toLogical, onFeedback = () => {}) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const sticks = [null, null];
  const released = [null, null];   // 離した瞬間に確定したアクション（fill が回収する）
  const keys = new Set();
  const keyAction = [null, null];
  let anyPointer = false;

  function sideOf(logicalX) {
    return logicalX < CONFIG.field.w / 2 ? 0 : 1;
  }

  function makeStick(id, p, now) {
    return {
      id,
      baseX: p.x, baseY: p.y,
      curX: p.x, curY: p.y,
      knobX: p.x, knobY: p.y,
      born: now,
      alpha: 1,
      dying: 0,
      history: [{ x: p.x, y: p.y, t: now }],
    };
  }

  function record(st, x, y, now) {
    st.curX = x; st.curY = y;
    st.history.push({ x, y, t: now });
    // 判定に使うのは直近の窓だけなので、それより古い点は捨てる
    const cutoff = now - S.releaseWindowMs * 2;
    while (st.history.length > 2 && st.history[0].t < cutoff) st.history.shift();
  }

  /** 離した瞬間の「直前 releaseWindowMs の移動」を見てアクションを決める */
  function resolveRelease(st, now) {
    const cutoff = now - S.releaseWindowMs;
    let ref = st.history[0];
    for (let i = st.history.length - 1; i >= 0; i--) {
      if (st.history[i].t <= cutoff) { ref = st.history[i]; break; }
    }
    const dx = st.curX - ref.x;
    const dy = st.curY - ref.y;
    const d = Math.hypot(dx, dy);
    if (d < S.releaseDist) return null;      // 止めてから離した = 何も起きない
    return { x: dx / d, y: dy / d };
  }

  function onDown(e) {
    const p = toLogical(e.clientX, e.clientY);
    const side = sideOf(p.x);
    if (sticks[side] && sticks[side].dying === 0) return; // 同じ半画面の2本目は無視
    sticks[side] = makeStick(e.pointerId, p, performance.now());
    anyPointer = true;
    onFeedback('stick');
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
  }

  function onMove(e) {
    const now = performance.now();
    for (const st of sticks) {
      if (!st || st.id !== e.pointerId || st.dying) continue;
      const p = toLogical(e.clientX, e.clientY);
      record(st, p.x, p.y, now);
    }
    e.preventDefault();
  }

  function onUp(e) {
    const now = performance.now();
    for (let i = 0; i < 2; i++) {
      const st = sticks[i];
      if (!st || st.id !== e.pointerId || st.dying) continue;
      // 離した位置も履歴に入れてから判定する（up の座標が move と違う環境がある）
      const p = toLogical(e.clientX, e.clientY);
      record(st, p.x, p.y, now);
      released[i] = resolveRelease(st, now);
      st.dying = 1;
    }
    anyPointer = sticks.some((s) => s && !s.dying);
  }

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- キーボード（デスクトップ検証用） ----
  const KEYMAP = {
    0: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', act: 'KeyE' },
    1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', act: 'ShiftRight' },
  };

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    for (let i = 0; i < 2; i++) {
      if (e.code === KEYMAP[i].act) keyAction[i] = true;
    }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  function keyboardMove(side) {
    const m = KEYMAP[side];
    let x = 0, y = 0;
    if (keys.has(m.left)) x -= 1;
    if (keys.has(m.right)) x += 1;
    if (keys.has(m.up)) y -= 1;
    if (keys.has(m.down)) y += 1;
    const l = Math.hypot(x, y);
    return l > 0 ? { x: x / l, y: y / l } : null;
  }

  return {
    sticks,

    // 見た目のフェード処理だけ（物理とは独立）
    update(dt) {
      for (let i = 0; i < 2; i++) {
        const st = sticks[i];
        if (!st) continue;
        if (st.dying) {
          st.alpha -= dt / 0.18;
          if (st.alpha <= 0) { sticks[i] = null; continue; }
        }
        const dx = st.curX - st.baseX;
        const dy = st.curY - st.baseY;
        const d = Math.hypot(dx, dy);
        const k = d > S.maxRadius ? S.maxRadius / d : 1;
        st.knobX = st.baseX + dx * k;
        st.knobY = st.baseY + dy * k;
      }
    },

    /** プレイヤー2駒ぶんの意図を intents[0], intents[1] に書き込む */
    fill(intents) {
      for (let side = 0; side < 2; side++) {
        let move = { x: 0, y: 0 };
        let flick = null;

        const st = sticks[side];
        if (st && !st.dying) {
          const dx = st.knobX - st.baseX;
          const dy = st.knobY - st.baseY;
          move = { x: dx / S.maxRadius, y: dy / S.maxRadius };
        }

        // 離した瞬間に確定したアクションを1回だけ渡す
        if (released[side]) { flick = released[side]; released[side] = null; }

        const km = keyboardMove(side);
        if (km) move = km;
        if (keyAction[side]) {
          keyAction[side] = null;
          const l = Math.hypot(move.x, move.y);
          flick = l > 0.1
            ? { x: move.x / l, y: move.y / l }
            : { x: 0, y: -1 };   // 入力が無ければ前方へ
        }

        intents[side] = { move, flick };
      }
    },

    get active() { return anyPointer; },

    reset() {
      sticks[0] = sticks[1] = null;
      released[0] = released[1] = null;
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
