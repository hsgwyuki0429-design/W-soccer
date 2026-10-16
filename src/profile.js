// profile.js — ユーザーネームと、対人戦の成績・レート。
//
// どれも端末（localStorage）に保存する。サーバーは保存しない（無料のホスティングでは
// 再起動のたびに消えるため）。そのぶん、端末を替えると引き継がれないし、手で書き換える
// こともできる。気軽に遊ぶための目安として持つ。
//
// レートはイロレーティング（初期 1500、K=32）。相手のレートは、相手が名乗った値を使う。
//
// 数えるのは決着まで行った試合と、途中で抜けた試合：
//   - 相手が途中で抜けた → 勝ち
//   - 自分が途中でやめた → 負け
//   - 試合中にアプリを閉じた → 次に開いたときに負けとして数える
//     （始まった時点で「途中の試合」を記録しておき、決着したら消す）

const KEY = 'pairkick.profile';
export const START_RATING = 1500;
const K = 32;
const NAME_MAX = 12;

/** 名前を整える（サーバーと同じ決まり）。空なら「ゲスト」 */
export function cleanName(v) {
  const t = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim();
  return Array.from(t).slice(0, NAME_MAX).join('') || 'ゲスト';
}

/** 勝ち（score=1）・負け（score=0）でのレートの増減 */
export function eloDelta(me, opp, score) {
  const expected = 1 / (1 + Math.pow(10, (opp - me) / 400));
  return Math.round(K * (score - expected));
}

/**
 * @param {Storage|null} [storage] 保存先（テストでは差し替える）
 */
export function createProfile(storage = safeStorage()) {
  const p = {
    name: '',
    rating: START_RATING,
    wins: 0,
    losses: 0,
    pending: null,   // 途中の試合 { opp: 相手のレート }
  };
  try {
    const raw = storage && storage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v.name === 'string') p.name = v.name.trim() ? cleanName(v.name) : '';
      if (Number.isFinite(v.rating)) p.rating = Math.round(v.rating);
      if (Number.isInteger(v.wins) && v.wins >= 0) p.wins = v.wins;
      if (Number.isInteger(v.losses) && v.losses >= 0) p.losses = v.losses;
      if (v.pending && Number.isFinite(v.pending.opp)) p.pending = { opp: v.pending.opp };
    }
  } catch (_) {}

  function save() {
    try { storage && storage.setItem(KEY, JSON.stringify(p)); } catch (_) {}
  }

  function settle(win, opp) {
    const delta = eloDelta(p.rating, opp, win ? 1 : 0);
    p.rating += delta;
    if (win) p.wins++; else p.losses++;
    p.pending = null;
    save();
    return { delta, rating: p.rating };
  }

  // 前回、試合の途中でアプリを閉じていたら負けとして数える
  let abandoned = null;
  if (p.pending) abandoned = settle(false, p.pending.opp);

  return {
    /** 入力されたままの名前（未入力なら空文字） */
    get name() { return p.name; },
    /** 相手に見せる名前（未入力なら「ゲスト」） */
    get displayName() { return cleanName(p.name); },
    get rating() { return p.rating; },
    get wins() { return p.wins; },
    get losses() { return p.losses; },
    get inMatch() { return !!p.pending; },
    /** 前回途中で閉じた試合を負けとして数えたなら、その結果（なければ null） */
    get abandoned() { return abandoned; },

    setName(v) {
      p.name = String(v ?? '').trim() ? cleanName(v) : '';
      save();
    },

    /** 対人戦が始まった（再戦も含む）。opp は相手のレート */
    begin(opp) {
      p.pending = { opp: Number.isFinite(opp) ? opp : START_RATING };
      save();
    },

    /** 決着した・途中で終わった。始まっていなければ何もしない（null） */
    finish(win) {
      if (!p.pending) return null;
      return settle(win, p.pending.opp);
    },
  };
}

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}
