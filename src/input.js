// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のスティック状態だけ。
//
// ドラッグ中は「進行方向が変わる」だけで、どれだけ速く動かしても何も起きない。
// アクション（キック / 体当たり / ダッシュ）は、指を離した瞬間に出る。
// スワイプする必要はなく、スティックが倒れていればそのまま倒れている向きへ撃つ。
// 撃たずに離したいときは、ノブを中央へ戻してから離す。

import { CONFIG } from './config.js';

const S = CONFIG.stick;

/**
 * 座標はすべて canvas 基準の CSS px で扱う。ワールド座標は一切見ない。
 * （カメラが動くゲームでジョイスティックをワールドに置くと、指を止めていても
 *   スティックが画面上を流れていってしまう。半画面の割り当ても同じ理由で画面基準。）
 * move / flick は正規化ベクトルなので、カメラが回転しない限りワールドでもそのまま使える。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {(name:string) => void} onFeedback  スティック出現などの通知
 */
export function createInput(canvas, onFeedback = () => {}) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const sticks = [null, null];
  const released = [null, null];   // 離した瞬間に確定したアクション（fill が回収する）
  const keys = new Set();
  const keyAction = [null, null];
  let anyPointer = false;

  /** クライアント座標 → canvas 基準の CSS px */
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  }

  // 担当は「画面の左半分 / 右半分」で決まる。コート上の左右ではない。
  function sideOf(localX, width) {
    return localX < width / 2 ? 0 : 1;
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
    };
  }

  /**
   * 離した瞬間のアクション。指の動きではなく、スティックの倒れ具合と向きで決める。
   * 倒したまま離せば撃つ。中央へ戻してから離せば撃たない。
   */
  function resolveRelease(st) {
    const dx = st.curX - st.baseX;
    const dy = st.curY - st.baseY;
    const d = Math.hypot(dx, dy);
    if (d < S.maxRadius * S.releaseTilt) return null;
    return { x: dx / d, y: dy / d };
  }

  function onDown(e) {
    const p = local(e);
    const side = sideOf(p.x, p.w);
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
    for (const st of sticks) {
      if (!st || st.id !== e.pointerId || st.dying) continue;
      const p = local(e);
      st.curX = p.x; st.curY = p.y;
    }
    e.preventDefault();
  }

  /** @param {boolean} fire pointercancel（OSに取り上げられた指）では撃たない */
  function onUp(e, fire = true) {
    for (let i = 0; i < 2; i++) {
      const st = sticks[i];
      if (!st || st.id !== e.pointerId || st.dying) continue;
      // 離した位置も反映してから判定する（up の座標が move と違う環境がある）
      const p = local(e);
      st.curX = p.x; st.curY = p.y;
      released[i] = fire ? resolveRelease(st) : null;
      st.dying = 1;
    }
    anyPointer = sticks.some((s) => s && !s.dying);
  }

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', (e) => onUp(e, true));
  window.addEventListener('pointercancel', (e) => onUp(e, false));
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
