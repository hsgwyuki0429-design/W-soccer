// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のポインタ状態だけ。
//
// 操作はひとつ。置いた地点を支点にした相対操作（スティック）。
// 進行方向は「置いた地点 → 今の指」。
//
// アクションは「離す直前に指が動いていれば」出る。速さは問わない。
// 出ないのは、指を止めてから離したときだけ。
// 向きは離す直前の移動から取る。
//
// 座標はすべて画面座標(CSS px)。カメラが動いても指の下から動かない。
// 担当（左半分＝左の駒）も画面基準。コート上の左右ではない。

import { CONFIG } from './config.js';

const S = CONFIG.stick;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {(name:string) => void} [opts.onFeedback]
 */
export function createInput(canvas, { onFeedback = () => {} } = {}) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const pointers = [null, null];
  const released = [null, null];   // 離した瞬間に確定したアクション（fill が回収する）
  // 「今この瞬間に離したら、どっちへ飛ぶか」。矢印の描画用。
  const aims = [null, null];
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
      // フリックの起点を探すのに使う。t は「動いた時刻」、rest は「そこで止まっている時間」。
      history: [{ x: p.x, y: p.y, t: now, rest: 0 }],
    };
  }

  function track(pt, x, y, now) {
    pt.curX = x; pt.curY = y;

    const h = pt.history;
    const last = h[h.length - 1];
    // 動いていないなら点を増やさず、その場に留まっている時間だけを積む。
    // 停止時間を区間の所要時間に混ぜてはいけない。pointerup は直前の move と
    // 同座標で、しかも数十ms遅れて届くことがあり、それを速さの計算に含めると
    // 「速く払ったのに発火しない」が起きる（実測で3377px/sでも落ちた）。
    if (last && Math.hypot(x - last.x, y - last.y) < 1) {
      last.rest = now - last.t;
    } else {
      h.push({ x, y, t: now, rest: 0 });
    }
    // 遡るのは dirWindowMs までなので、その倍も持てば十分
    const cutoff = now - S.dirWindowMs * 2;
    while (h.length > 2 && h[0].t < cutoff) h.shift();
  }

  /**
   * 離す直前の移動から向きを取る。速さは見ない。
   * 指を止めてから離した場合だけ null（＝発火しない）。
   *
   * 向きは終端から遡って dirDist ぶんの移動が貯まった所まで見る。
   * 1区間だけだと数pxのぶれで向きが暴れるので、少し遡って均す。
   *
   * @param {number} rest 終端でその場に留まっている時間(ms)
   */
  function flickDir(pt, rest) {
    const h = pt.history;
    if (h.length < 2) return null;
    const last = h[h.length - 1];

    // 離す直前に止まっていたなら発火しない。ここだけが「撃たない」条件。
    if (rest > S.restMs) return null;

    let dx = 0, dy = 0;
    for (let i = h.length - 2; i >= 0; i--) {
      const a = h[i];
      if (last.t - a.t > S.dirWindowMs) break;
      dx = last.x - a.x;
      dy = last.y - a.y;
      if (Math.hypot(dx, dy) >= S.dirDist) break;
    }
    const d = Math.hypot(dx, dy);
    if (d < S.minDist) return null;        // 窓の中でまったく動いていない
    return { x: dx / d, y: dy / d };
  }

  /**
   * 離した瞬間のアクション。払っていなければ null（何も起きない）。
   * 判定も向きも「最後に指を走らせた区間」だけで決まる。
   */
  function resolveRelease(pt) {
    const last = pt.history[pt.history.length - 1];
    return flickDir(pt, last ? (last.rest || 0) : 0);
  }

  /**
   * 押さえたままの指について「今この瞬間に離したら」の向き。
   * 停止時間は履歴ではなく現在時刻から測る。指を止めているあいだ move は
   * 届かないので、履歴の rest は止めた瞬間の値のまま古びるため。
   */
  function liveFlick(pt, now) {
    const last = pt.history[pt.history.length - 1];
    if (!last) return null;
    return flickDir(pt, Math.max(last.rest || 0, now - last.t));
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
      track(pt, p.x, p.y, performance.now());
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
      track(pt, p.x, p.y, performance.now());
      released[i] = fire ? resolveRelease(pt) : null;
      aims[i] = null;
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
    /** 画面座標での「今離したら飛ぶ向き」。撃てないときは null。 */
    aims,

    // 見た目のフェード処理と、矢印の向きの更新（物理とは独立）
    update(dt) {
      const now = performance.now();
      for (let i = 0; i < 2; i++) {
        const pt = pointers[i];
        if (!pt) { aims[i] = null; continue; }
        if (pt.dying) {
          aims[i] = null;
          pt.alpha -= dt / 0.18;
          if (pt.alpha <= 0) { pointers[i] = null; continue; }
        } else {
          aims[i] = liveFlick(pt, now);
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
          // 置いた地点を支点にした倒し量。向きは「置いた地点 → 今の指」
          const dx = pt.knobX - pt.baseX;
          const dy = pt.knobY - pt.baseY;
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
      pointers[0] = pointers[1] = null;
      released[0] = released[1] = null;
      aims[0] = aims[1] = null;
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
