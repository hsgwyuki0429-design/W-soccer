// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のポインタ状態だけ。
//
// 操作はひとつ。置いた地点を支点にした相対操作（スティック）。
// 進行方向は「支点 → 今の指」。指が外周より外へ出ると、支点が指に引きずられて付いてくる
// （ブロスタ式の追従）。切り返しは常に外周の直径ぶん動かせば済むので、小回りが効く。
//
// アクションは「離す直前に指が動いていれば」出る。速さは問わない。
// 出ないのは、指を止めてから離したときだけ。
//
// 向きは「払った向き」ではなく「そのときのスティックの向き」。
// 払う動きは合図であって、狙いではない。狙いは駒をどこへ置いたかで決まる
// （キックは駒の中心 → ボールの向きへ飛ぶ。game.js を参照）。
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
  // スティックの大きさ（設定で変えられる。CSS px）
  let maxR = S.maxRadius;
  let knobR = S.knobRadius;
  // 発火の感度（設定）。しきい値に掛ける倍率。1 が既定（感度5）
  let restMs = S.restMs;
  let minDist = S.minDist;
  let onRelease = false;           // 感度が最大：離しただけで、矢印の向きへ出る

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
      baseX: p.x, baseY: p.y,     // 支点（画面）。最初は指を置いた地点。指が外周を越えると付いてくる
      curX: p.x, curY: p.y,       // 今の指の位置（画面）
      knobX: p.x, knobY: p.y,     // 表示用にクランプしたノブ（画面）
      alpha: 1,
      dying: 0,
      lastDir: null,              // 直近の「ちゃんと倒れていた」向き（画面座標）
      // フリックの起点を探すのに使う。t は「動いた時刻」、rest は「そこで止まっている時間」。
      history: [{ x: p.x, y: p.y, t: now, rest: 0 }],
    };
  }

  function track(pt, x, y, now) {
    pt.curX = x; pt.curY = y;
    // 追従：外周より外へ出た指に、支点を引きずって付いていかせる（向きは変えずに距離だけ詰める）
    const fx = x - pt.baseX, fy = y - pt.baseY;
    const fd = Math.hypot(fx, fy);
    const reach = maxR * S.followAt;
    if (fd > reach) {
      const k = 1 - reach / fd;
      pt.baseX += fx * k;
      pt.baseY += fy * k;
    }
    const sd = stickDir(pt);
    if (sd) pt.lastDir = sd;

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
   * 今スティックが倒れている向き（画面座標）。
   * 倒し量が僅かなときは向きが暴れるので null を返す。
   */
  function stickDir(pt) {
    const dx = pt.curX - pt.baseX;
    const dy = pt.curY - pt.baseY;
    const d = Math.hypot(dx, dy);
    if (d < maxR * A.minInput) return null;
    return { x: dx / d, y: dy / d };
  }

  /**
   * 倒し量 → 移動の強さ（0〜1）。遊びの内側は 0、fullAt で 1。間はまっすぐ伸ばす。
   */
  function shape(dx, dy) {
    const d = Math.hypot(dx, dy);
    const r = d / maxR;
    if (r <= S.deadZone) return { x: 0, y: 0 };
    const m = Math.min(1, (r - S.deadZone) / (S.fullAt - S.deadZone));
    return { x: (dx / d) * m, y: (dy / d) * m };
  }

  /**
   * 離す直前に指が動いていたか。ここだけが「撃つ / 撃たない」を分ける。
   * 速さは見ない。止めてから離したときだけ撃たない。
   */
  function wasSwiping(pt, rest) {
    const h = pt.history;
    if (h.length < 2) return false;
    const last = h[h.length - 1];
    if (rest > restMs) return false;

    let dx = 0, dy = 0;
    for (let i = h.length - 2; i >= 0; i--) {
      const a = h[i];
      if (last.t - a.t > S.dirWindowMs) break;
      dx = last.x - a.x;
      dy = last.y - a.y;
      if (Math.hypot(dx, dy) >= S.dirDist) break;
    }
    return Math.hypot(dx, dy) >= minDist;   // 窓の中でまったく動いていない
  }

  /**
   * 離した瞬間のアクション。払っていなければ null（何も起きない）。
   * 撃つかどうかは指が動いていたかで、向きはスティックの倒れている向きで決まる。
   * 払い戻して中央へ帰ってきた場合に備え、直近の倒し向きを控えとして持つ。
   */
  function resolveRelease(pt) {
    // 感度が最大のときは、指の動きを見ない。矢印が出ている（スティックが倒れている）なら、
    // 離しただけでその向きへ出る。倒していなければ向きが無いので何も起きない
    if (onRelease) return stickDir(pt);
    const last = pt.history[pt.history.length - 1];
    if (!wasSwiping(pt, last ? (last.rest || 0) : 0)) return null;
    return stickDir(pt) || pt.lastDir || { x: 0, y: 0 };
  }

  function onDown(e) {
    const p = local(e);
    const side = sideOf(p.x, p.w);
    // 同じ半画面の2本目は無視
    if (pointers[side] && pointers[side].dying === 0) return;
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
          dirs[i] = stickDir(pt);
        }
        const dx = pt.curX - pt.baseX;
        const dy = pt.curY - pt.baseY;
        const d = Math.hypot(dx, dy);
        const k = d > maxR ? maxR / d : 1;
        pt.knobX = pt.baseX + dx * k;
        pt.knobY = pt.baseY + dy * k;
      }
    },

    /**
     * プレイヤー2駒ぶんの意図を intents[0], intents[1] に書き込む。
     */
    fill(intents) {
      for (let side = 0; side < 2; side++) {
        let move = { x: 0, y: 0 };
        let flick = null;
        const pt = pointers[side];

        if (pt && !pt.dying) {
          // 置いた地点を支点にした倒し量。向きは「置いた地点 → 今の指」
          const dx = pt.knobX - pt.baseX;
          const dy = pt.knobY - pt.baseY;
          move = shape(dx, dy);
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

    /** スティックの外周・ノブの半径（CSS px） */
    get stickRadius() { return maxR; },
    get knobRadius() { return knobR; },
    /** @param {number} k 大きさの倍率（minScale〜1） */
    setStickScale(k) {
      const c = Math.min(1, Math.max(S.minScale, Number(k) || 1));
      maxR = S.maxRadius * c;
      // ノブは小さくしすぎると指に隠れて見えないので、外周ほどは縮めない
      knobR = Math.max(9, S.knobRadius * c);
    },
    /**
     * 発火の感度（1〜9。5 が既定）。大きいほど、小さな動きでも・止めかけでも出る。最大（9）は離しただけで出る。
     * @param {number} level
     */
    setFlickLevel(level) {
      const F = S.flickLevels;
      const l = Math.min(F.max, Math.max(F.min, Math.round(Number(level)) || F.mid));
      const k = Math.pow(F.step, l - F.mid);
      minDist = S.minDist / k;
      restMs = S.restMs * k;
      onRelease = l >= F.max;
    },

    reset() {
      pointers[0] = pointers[1] = null;
      released[0] = released[1] = null;
      dirs[0] = dirs[1] = null;
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
