// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のポインタ状態だけ。
//
// 操作方法は2つ。どちらも「指を離した瞬間にアクションが出る」点は同じ。
//
//   stick : 置いた地点を支点にした相対操作。進行方向は「置いた地点 → 今の指」。
//           アクションの向きは、最後に指を走らせた向き（加速した地点 → 離した地点）。
//           払っていなければ「置いた地点 → 離した地点」に落ちる。
//   point : 進んでほしい場所に指を置く絶対操作。駒はそこへ向かい、
//           離すと「駒 → 指の場所」の角度へ撃つ。
//
// 座標の扱いが2つの操作で違う：
//   stick のジョイスティックは画面座標(CSS px)。カメラが動いても指の下から動かない。
//   point の目的地はワールド座標。カメラが動いてもコート上の同じ場所を指し続ける。
// 担当（左半分＝左の駒）はどちらも画面基準。コート上の左右ではない。

import { CONFIG } from './config.js';

const S = CONFIG.stick;
const C = CONFIG.control;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {(x:number, y:number) => {x:number,y:number}} opts.toWorld  canvas内CSS px → ワールド
 * @param {(name:string) => void} [opts.onFeedback]
 */
export function createInput(canvas, { toWorld, onFeedback = () => {} }) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const pointers = [null, null];
  const released = [null, null];   // 離した瞬間に確定したアクション（fill が回収する）
  const keys = new Set();
  const keyAction = [null, null];
  let mode = C.defaultMode;
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
    const w = toWorld(p.x, p.y);
    return {
      id,
      baseX: p.x, baseY: p.y,     // 指を置いた地点（画面）。以後動かさない
      curX: p.x, curY: p.y,       // 今の指の位置（画面）
      knobX: p.x, knobY: p.y,     // 表示用にクランプしたノブ（画面）
      wx: w.x, wy: w.y,           // 今の指の位置（ワールド）= point の目的地
      born: now,
      alpha: 1,
      dying: 0,
      history: [{ x: p.x, y: p.y, t: now }],   // フリックの起点を探すのに使う
    };
  }

  function track(pt, x, y, now) {
    pt.curX = x; pt.curY = y;
    const w = toWorld(x, y);
    pt.wx = w.x; pt.wy = w.y;

    const h = pt.history;
    const last = h[h.length - 1];
    // 動いていないなら点を増やさず、時刻だけ進める。
    // pointerup は直前の move と同座標で来ることが多く、そのまま積むと
    // 「長さ0の最終区間」ができてフリック判定が即座に打ち切られる。
    // 時刻だけ進めておけば、指を止めてから離した場合はその区間の速さが
    // 落ちるので、意図どおり「払っていない」と判定される。
    if (last && Math.hypot(x - last.x, y - last.y) < 1) {
      last.t = now;
    } else {
      h.push({ x, y, t: now });
    }
    // 遡るのは flickMaxMs までなので、その倍も持てば十分
    const cutoff = now - S.flickMaxMs * 2;
    while (h.length > 2 && h[0].t < cutoff) h.shift();
  }

  /**
   * 「最後に指を走らせた区間」の起点を探す。
   * 終端から遡って、指の速さが flickSpeed を下回った所で止める。
   * ゆっくり操舵してから最後にパッと払うと、その払った区間だけが残る。
   */
  function findFlick(pt) {
    const h = pt.history;
    if (h.length < 2) return null;
    const last = h[h.length - 1];
    let i = h.length - 1;
    while (i > 0) {
      const a = h[i - 1], b = h[i];
      if (last.t - a.t > S.flickMaxMs) break;
      const dt = b.t - a.t;
      if (dt <= 0) { i--; continue; }
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
      if (speed < S.flickSpeed) break;
      i--;
    }
    const origin = h[i];
    const dx = last.x - origin.x, dy = last.y - origin.y;
    const d = Math.hypot(dx, dy);
    if (d < S.flickDist) return null;      // 払っていない
    return { x: dx / d, y: dy / d };
  }

  /**
   * 離した瞬間のアクション。
   * stick は、最後に指を走らせた向きがあればそれを使う。
   * 払っていなければ「置いた地点 → 離した地点」（倒し量がしきい値未満なら撃たない）。
   * point は駒の位置が要るので、向きの確定は fill() まで遅らせる。
   */
  function resolveRelease(pt) {
    if (mode === 'point') return { point: true, wx: pt.wx, wy: pt.wy };

    const flicked = findFlick(pt);
    if (flicked) return flicked;

    const dx = pt.curX - pt.baseX;
    const dy = pt.curY - pt.baseY;
    const d = Math.hypot(dx, dy);
    if (d < S.maxRadius * S.releaseTilt) return null;
    return { x: dx / d, y: dy / d };
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
    get mode() { return mode; },
    setMode(m) {
      if (m !== 'stick' && m !== 'point') return;
      mode = m;
      this.reset();
    },

    // 見た目のフェード処理だけ（物理とは独立）
    update(dt) {
      for (let i = 0; i < 2; i++) {
        const pt = pointers[i];
        if (!pt) continue;
        if (pt.dying) {
          pt.alpha -= dt / 0.18;
          if (pt.alpha <= 0) { pointers[i] = null; continue; }
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
     * @param {Array} units 自分の2駒（位置しか読まない。point の向きに要る）
     */
    fill(intents, units) {
      for (let side = 0; side < 2; side++) {
        let move = { x: 0, y: 0 };
        let flick = null;
        const pt = pointers[side];
        const u = units && units[side];

        if (mode === 'point') {
          // 指を置いた場所へ向かう。近づいたら減速する（行き過ぎて震えないように）
          if (pt && !pt.dying && u) {
            const dx = pt.wx - u.x, dy = pt.wy - u.y;
            const d = Math.hypot(dx, dy);
            if (d > 1e-3) {
              const g = clamp(d / C.pointDamp, 0, 1);
              move = { x: dx / d * g, y: dy / d * g };
            }
          }
        } else if (pt && !pt.dying) {
          // 置いた地点を支点にした倒し量。向きは「置いた地点 → 今の指」
          const dx = pt.knobX - pt.baseX;
          const dy = pt.knobY - pt.baseY;
          move = { x: dx / S.maxRadius, y: dy / S.maxRadius };
        }

        // 離した瞬間に確定したアクションを1回だけ渡す
        const rel = released[side];
        if (rel) {
          released[side] = null;
          if (rel.point) {
            // point は駒からの向き。駒がもう着いているなら撃たない
            if (u) {
              const dx = rel.wx - u.x, dy = rel.wy - u.y;
              const d = Math.hypot(dx, dy);
              if (d >= C.pointFire) flick = { x: dx / d, y: dy / d };
            }
          } else {
            flick = rel;
          }
        }

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
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
