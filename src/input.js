// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のポインタ状態だけ。
//
// 操作は2つだけ。
//   ドラッグ … 置いた地点を支点にした相対操作（スティック）で移動。
//              進行方向は「置いた地点 → 今の指」。離しても何も起きない（止まるだけ）。
//   タップ   … 踏み込み（キック / ダッシュ / 体当たり）。向きは駒が向いている方向
//              （最後に動かした向き）。ボールもその向きへ飛ぶ（game.js を参照）。
//
// 「離し方」で撃つ／撃たないを分ける方式はやめた。止まろうとして離しただけで
// 暴発したり、離す直前に指が止まっていて出なかったりして、狙いどおりに撃てないため。
//
// 座標はすべて画面座標(CSS px)。カメラが動いても指の下から動かない。
// 担当（左半分＝左の駒）も画面基準。コート上の左右ではない。

import { CONFIG } from './config.js';

const S = CONFIG.stick;
const A = CONFIG.moveArrow;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {(name:string) => void} [opts.onFeedback]
 */
export function createInput(canvas, { onFeedback = () => {} } = {}) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const pointers = [null, null];
  const released = [null, null];   // 離した瞬間に確定したアクション（fill が回収する）
  // 今スティックが倒れている向き（画面座標）。進行方向の矢印を描くのに使う。
  const dirs = [null, null];
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

  function makePointer(id, p, now) {
    return {
      id,
      baseX: p.x, baseY: p.y,     // 指を置いた地点（画面）。以後動かさない
      curX: p.x, curY: p.y,       // 今の指の位置（画面）
      knobX: p.x, knobY: p.y,     // 表示用にクランプしたノブ（画面）
      born: now,
      alpha: 1,
      dying: 0,
      travel: 0,                  // 置いた地点から最も離れた距離（タップかどうかの判定）
      dragging: false,            // タップではなくドラッグ（移動）だと確定したか
    };
  }

  function track(pt, x, y) {
    pt.curX = x; pt.curY = y;
    pt.travel = Math.max(pt.travel, Math.hypot(x - pt.baseX, y - pt.baseY));
  }

  /**
   * 今スティックが倒れている向き（画面座標）。
   * 倒し量が僅かなときは向きが暴れるので null を返す。
   */
  function stickDir(pt) {
    const dx = pt.curX - pt.baseX;
    const dy = pt.curY - pt.baseY;
    const d = Math.hypot(dx, dy);
    if (d < S.maxRadius * A.minInput) return null;
    return { x: dx / d, y: dy / d };
  }

  /** 長く触れているか大きく動かしたら、タップではなくドラッグ（移動）と確定する。 */
  function isDragging(pt) {
    if (!pt.dragging && (pt.travel > S.tapDist || performance.now() - pt.born > S.tapMs)) {
      pt.dragging = true;
    }
    return pt.dragging;
  }

  /** 短く、ほとんど動かさずに離した＝タップ。 */
  function isTap(pt) {
    return !isDragging(pt);
  }

  function onDown(e) {
    const p = local(e);
    const side = sideOf(p.x, p.w);
    if (pointers[side] && pointers[side].dying === 0) return; // 同じ半画面の2本目は無視
    pointers[side] = makePointer(e.pointerId, p, performance.now());
    anyPointer = true;
    onFeedback('stick');
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
  }

  function onMove(e) {
    for (const pt of pointers) {
      if (!pt || pt.id !== e.pointerId || pt.dying) continue;
      const p = local(e);
      track(pt, p.x, p.y);
    }
    e.preventDefault();
  }

  /** @param {boolean} fire pointercancel（OSに取り上げられた指）では撃たない */
  function onUp(e, fire = true) {
    for (let i = 0; i < 2; i++) {
      const pt = pointers[i];
      if (!pt || pt.id !== e.pointerId || pt.dying) continue;
      // 離した位置も反映してから判定する（up の座標が move と違う環境がある）
      const p = local(e);
      track(pt, p.x, p.y);
      // 向きは渡さない（0,0）。game.js が駒の向いている方向へ踏み込む。
      released[i] = fire && isTap(pt) ? { x: 0, y: 0 } : null;
      dirs[i] = null;
      pt.dying = 1;
    }
    anyPointer = pointers.some((s) => s && !s.dying);
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
    pointers,
    /** 画面座標での進行方向。入力が無い / 倒し量が僅かなら null。 */
    dirs,

    // 見た目のフェード処理と、進行方向の更新（物理とは独立）
    update(dt) {
      for (let i = 0; i < 2; i++) {
        const pt = pointers[i];
        if (!pt) { dirs[i] = keyboardMove(i); continue; }
        if (pt.dying) {
          dirs[i] = null;
          pt.alpha -= dt / 0.18;
          if (pt.alpha <= 0) { pointers[i] = null; continue; }
        } else {
          dirs[i] = isDragging(pt) ? stickDir(pt) : null;
        }
        const dx = pt.curX - pt.baseX;
        const dy = pt.curY - pt.baseY;
        const d = Math.hypot(dx, dy);
        const k = d > S.maxRadius ? S.maxRadius / d : 1;
        pt.knobX = pt.baseX + dx * k;
        pt.knobY = pt.baseY + dy * k;
      }
    },

    /**
     * プレイヤー2駒ぶんの意図を intents[0], intents[1] に書き込む。
     * @param {Array} units 自分の2駒（今は読まないが、呼び出し側の並び順の証跡として残す）
     */
    fill(intents, units) {
      for (let side = 0; side < 2; side++) {
        let move = { x: 0, y: 0 };
        let flick = null;
        const pt = pointers[side];

        if (pt && !pt.dying) {
          // タップかドラッグか決まるまでは動かさない。タップ中の指のわずかなブレで
          // 駒の向きが変わると、踏み込む向き（＝ボールが飛ぶ向き）が狂うため。
          if (isDragging(pt)) {
            // 置いた地点を支点にした倒し量。向きは「置いた地点 → 今の指」
            const dx = pt.knobX - pt.baseX;
            const dy = pt.knobY - pt.baseY;
            move = { x: dx / S.maxRadius, y: dy / S.maxRadius };
          }
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
            : { x: 0, y: 0 };    // 入力が無ければ駒の向いている方向へ（タップと同じ）
        }

        intents[side] = { move, flick };
      }
    },

    get active() { return anyPointer; },

    reset() {
      pointers[0] = pointers[1] = null;
      released[0] = released[1] = null;
      dirs[0] = dirs[1] = null;
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
