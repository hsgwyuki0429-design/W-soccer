// input.js — タッチ / マウス / キーボード を「意図」へ変換する。
// game.js には触れない。出すのは intents 配列と、描画用のポインタ状態だけ。
//
// 操作は2つだけ。どちらも指を離さずにできる。
//   ドラッグ … 置いた地点を支点にした相対操作（スティック）で移動。
//              進行方向は「置いた地点 → 今の指」。離しても何も起きない（止まるだけ）。
//   はじく   … 指を素早く動かすと、その向きへ突進（キック / ダッシュ / 体当たり）。
//              ボールに当たればはじいた向きへ飛ぶ（game.js を参照）。
//              指は離さないので、突進のあとも移動がそのまま続く。
//
// 指がスティックの外へ出たら、支点が指についてくる。はじいたあと指が遠くへ
// 行っても、そのまま同じ向きへ走り続け、戻すときも大きく戻さなくてよい。
//
// 以前の「動かしながら離すと撃つ」はやめた。撃つたびに指を離すので
// 移動が途切れ、止まろうとして離しただけで暴発することもあったため。
//
// 座標はすべて画面座標(CSS px)。カメラが動いても指の下から動かない。
// 担当（左半分＝左の駒）も画面基準。コート上の左右ではない。

import { CONFIG } from './config.js';

const S = CONFIG.stick;
const A = CONFIG.moveArrow;

/**
 * 「はじき」の検出。指の位置を時刻つきで与えると、素早く動いた瞬間にその向きを返す。
 * DOM に触れないので単体で試せる。
 *
 * 見るのは直近 flickWindowMs の移動量と速さ。ふつうの舵取りより速く、
 * ある程度の距離を動いたときだけ撃つ。1回撃ったら、指がいったん遅くなる
 * （または止まる）まで次は撃たない。はじき1回で連発しないように。
 */
export function createFlickDetector(cfg = S) {
  let samples = [];
  let armed = true;

  return {
    get armed() { return armed; },

    reset(x, y, t) {
      samples = [{ x, y, t }];
      armed = true;
    },

    /** @returns {{x:number,y:number}|null} はじいた向き（画面座標・長さ1） */
    feed(x, y, t) {
      samples.push({ x, y, t });
      while (samples.length > 2 && t - samples[0].t > cfg.flickWindowMs * 3) samples.shift();

      // 窓の中の各点から今までを見て、速く・十分に動いた区間があれば撃つ。
      // 窓全体の平均だけを見ると、窓より短い鋭いはじきが薄まって取りこぼす。
      // 向きは、条件を満たす区間のうち最も長いもので取る（短い区間は向きが暴れる）。
      // move の間隔が窓より長いときは、ひとつ前の点だけを見る。
      let best = null, fastest = 0;
      for (let i = samples.length - 2; i >= 0; i--) {
        const a = samples[i];
        const age = t - a.t;
        if (age > cfg.flickWindowMs && !(i === samples.length - 2 && age <= cfg.flickWindowMs * 2)) break;
        const dx = x - a.x, dy = y - a.y;
        const dist = Math.hypot(dx, dy);
        const speed = dist / Math.max(age, 8) * 1000;   // px/s
        fastest = Math.max(fastest, speed);
        if (dist >= cfg.flickDist && speed >= cfg.flickSpeed) best = { dx, dy, dist };
      }

      if (!armed) {
        if (fastest < cfg.rearmSpeed) armed = true;
        return null;
      }
      if (best) {
        armed = false;
        return { x: best.dx / best.dist, y: best.dy / best.dist };
      }
      return null;
    },

    /** move が来ない（指が止まっている）あいだに呼ぶ。しばらく止まっていたら再び撃てる。 */
    idle(t) {
      const last = samples[samples.length - 1];
      if (!armed && last && t - last.t > cfg.rearmIdleMs) armed = true;
    },
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {(name:string) => void} [opts.onFeedback]
 */
export function createInput(canvas, { onFeedback = () => {} } = {}) {
  // side 0 = 左半画面 → 駒0 / side 1 = 右半画面 → 駒1（担当は固定）
  const pointers = [null, null];
  const flicks = [null, null];     // はじいた瞬間に確定したアクション（fill が回収する）
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
      baseX: p.x, baseY: p.y,     // 支点（画面）。指がスティックの外へ出たらついてくる
      curX: p.x, curY: p.y,       // 今の指の位置（画面）
      knobX: p.x, knobY: p.y,     // 表示用にクランプしたノブ（画面）
      born: now,
      alpha: 1,
      dying: 0,
      flick: (() => { const f = createFlickDetector(); f.reset(p.x, p.y, now); return f; })(),
    };
  }

  function track(pt, x, y) {
    pt.curX = x; pt.curY = y;
    // 支点が指についてくる（スティックの半径より外へは離れない）
    const dx = x - pt.baseX, dy = y - pt.baseY;
    const d = Math.hypot(dx, dy);
    if (d > S.maxRadius) {
      const k = (d - S.maxRadius) / d;
      pt.baseX += dx * k;
      pt.baseY += dy * k;
    }
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
    for (let i = 0; i < 2; i++) {
      const pt = pointers[i];
      if (!pt || pt.id !== e.pointerId || pt.dying) continue;
      const p = local(e);
      track(pt, p.x, p.y);
      const f = pt.flick.feed(p.x, p.y, performance.now());
      if (f) { flicks[i] = f; onFeedback('flick'); }
    }
    e.preventDefault();
  }

  // 離しても何も起きない（止まるだけ）
  function onUp(e) {
    for (let i = 0; i < 2; i++) {
      const pt = pointers[i];
      if (!pt || pt.id !== e.pointerId || pt.dying) continue;
      dirs[i] = null;
      pt.dying = 1;
    }
    anyPointer = pointers.some((s) => s && !s.dying);
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
          pt.flick.idle(performance.now());
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
          // 支点を中心にした倒し量。向きは「支点 → 今の指」
          const dx = pt.knobX - pt.baseX;
          const dy = pt.knobY - pt.baseY;
          move = { x: dx / S.maxRadius, y: dy / S.maxRadius };
        }

        // はじいた瞬間に確定したアクションを1回だけ渡す
        if (flicks[side]) { flick = flicks[side]; flicks[side] = null; }

        const km = keyboardMove(side);
        if (km) move = km;
        if (keyAction[side]) {
          keyAction[side] = null;
          const l = Math.hypot(move.x, move.y);
          flick = l > 0.1
            ? { x: move.x / l, y: move.y / l }
            : { x: 0, y: 0 };    // 入力が無ければ駒の向いている方向へ
        }

        intents[side] = { move, flick };
      }
    },

    get active() { return anyPointer; },

    reset() {
      pointers[0] = pointers[1] = null;
      flicks[0] = flicks[1] = null;
      dirs[0] = dirs[1] = null;
      keys.clear();
      keyAction[0] = keyAction[1] = null;
    },
  };
}
