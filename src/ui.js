// ui.js — DOM オーバーレイ（HUD / バナー / タイトル / リザルト）。
// Apple 的な質感（半透明 + blur + ヘアライン + スプリング）はここに集中させる。

const MODE_KEY = 'pairkick.controlMode';
const OPP_KEY = 'pairkick.opponent';

export function createUI(onPrimary, onModeChange, onCancel = () => {}) {
  const el = (id) => document.getElementById(id);

  const hud = el('hud');
  const scoreA = el('score-a');
  const scoreB = el('score-b');
  const banner = el('banner');
  const bannerTitle = el('banner-title');
  const bannerSub = el('banner-sub');
  const overlay = el('overlay');
  const ovKicker = el('ov-kicker');
  const ovTitle = el('ov-title');
  const ovBody = el('ov-body');
  const ovHints = el('ov-hints');
  const ovBtn = el('ov-btn');
  const ovModes = el('ov-modes');
  const ovOpps = el('ov-opponents');
  const hintTitle = el('hint-a-t');
  const hintSub = el('hint-a-s');

  let mode = 'stick';
  try { mode = localStorage.getItem(MODE_KEY) || 'stick'; } catch (_) {}
  if (mode !== 'stick' && mode !== 'point') mode = 'stick';

  let opponent = 'bot';
  try { opponent = localStorage.getItem(OPP_KEY) || 'bot'; } catch (_) {}
  if (opponent !== 'bot' && opponent !== 'human') opponent = 'bot';

  function paintOpp() {
    for (const b of ovOpps.querySelectorAll('.seg')) {
      b.classList.toggle('on', b.dataset.opp === opponent);
    }
  }

  ovOpps.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovOpps.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    opponent = b.dataset.opp;
    try { localStorage.setItem(OPP_KEY, opponent); } catch (_) {}
    paintOpp();
  });

  function paintMode() {
    for (const b of ovModes.querySelectorAll('.seg')) {
      b.classList.toggle('on', b.dataset.mode === mode);
    }
    hintTitle.textContent = mode === 'point' ? '置く' : '倒す';
    hintSub.textContent = mode === 'point' ? 'そこへ進む' : '移動';
  }

  ovModes.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovModes.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    mode = b.dataset.mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
    paintMode();
    onModeChange(mode);
  });

  let bannerTimer = 0;
  let shown = [-1, -1];
  let lockUntil = 0;              // 直前の指残りで即再戦してしまうのを防ぐ
  let waitingCancel = false;      // 相手待ち中は、ボタンが「やめる」になる

  function primary() {
    if (performance.now() < lockUntil) return;
    lockUntil = performance.now() + 400;
    if (waitingCancel) { waitingCancel = false; onCancel(); return; }
    onPrimary();
  }

  ovBtn.addEventListener('click', (e) => {
    e.preventDefault();
    primary();
  });
  // カード全体タップでも進める（「タップで即再戦」）
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === ovBtn) return;
    primary();
  });

  paintMode();
  paintOpp();

  return {
    get mode() { return mode; },
    get opponent() { return opponent; },
    applyMode() { onModeChange(mode); },

    setUnit(u, hudBand) {
      const root = document.documentElement.style;
      root.setProperty('--u', u + 'px');
      root.setProperty('--hud-band', Math.max(0, hudBand) + 'px');
    },

    setScore(a, b) {
      const vals = [a, b];
      [scoreA, scoreB].forEach((node, i) => {
        if (shown[i] === vals[i]) return;
        shown[i] = vals[i];
        node.textContent = vals[i];
        node.classList.add('bump');
        setTimeout(() => node.classList.remove('bump'), 380);
      });
    },

    setMatchPoint(on) {
      hud.classList.toggle('matchpoint', !!on);
    },

    banner(title, sub = '', holdMs = 900) {
      clearTimeout(bannerTimer);
      bannerTitle.textContent = title;
      bannerSub.textContent = sub;
      banner.classList.remove('out');
      banner.classList.remove('show');
      void banner.offsetWidth;               // reflow で再生
      banner.classList.add('show');
      if (holdMs > 0) {
        bannerTimer = setTimeout(() => {
          banner.classList.remove('show');
          banner.classList.add('out');
        }, holdMs);
      }
    },

    hideBanner() {
      clearTimeout(bannerTimer);
      if (banner.classList.contains('show')) {
        banner.classList.remove('show');
        banner.classList.add('out');
      }
    },

    showTitle() {
      ovKicker.textContent = '2対2サッカー';
      ovTitle.textContent = 'PAIR KICK';
      ovTitle.className = '';
      ovBody.innerHTML = '2つの駒、2本の親指。<br>左半分で左の駒、右半分で右の駒。';
      ovHints.style.display = '';
      ovOpps.style.display = '';
      ovModes.style.display = '';
      ovBtn.textContent = 'はじめる';
      ovBtn.disabled = false;
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    /** 対人戦の相手待ち */
    showWaiting() {
      ovKicker.textContent = '対人戦';
      ovTitle.textContent = '相手を待っています';
      ovTitle.className = 'waiting';
      ovBody.innerHTML = 'この画面のURLを相手に渡してください。<br>2人そろうと自動で始まります。';
      ovHints.style.display = 'none';
      ovOpps.style.display = 'none';
      ovModes.style.display = 'none';
      ovBtn.textContent = 'やめる';
      ovBtn.disabled = false;
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
      waitingCancel = true;
    },

    /**
     * 接続エラー・相手の切断。
     * @param {string} text  本文
     * @param {boolean} everConnected  一度でも試合中/相手待ちに到達したか。
     *   false なら「繋がったことがない」ので、そもそも失敗した扱いにする。
     *   同じ見出しを使うと、一度も繋がっていないのに「切れました」と出て
     *   誤解を招く（実際に起きた不具合報告はこれだった）。
     */
    showNetError(text, everConnected = true) {
      ovKicker.textContent = '対人戦';
      ovTitle.textContent = everConnected ? '接続が切れました' : '接続できませんでした';
      ovTitle.className = 'lose';
      ovBody.textContent = text;
      ovHints.style.display = 'none';
      ovOpps.style.display = '';
      ovModes.style.display = '';
      ovBtn.textContent = 'タイトルへ';
      ovBtn.disabled = false;
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    showResult(win, a, b) {
      waitingCancel = false;
      ovOpps.style.display = '';
      ovModes.style.display = '';
      ovKicker.textContent = `${a} — ${b}`;
      ovTitle.textContent = win ? 'WIN' : 'LOSE';
      ovTitle.className = win ? 'win' : 'lose';
      ovBody.innerHTML = win
        ? 'パスが通ったとき、糸は光っていましたか。'
        : 'ドリブルはリスク。パスは武器。';
      ovHints.style.display = 'none';
      ovBtn.textContent = 'もう一度';
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    hideOverlay() {
      waitingCancel = false;
      overlay.classList.add('hidden');
    },

    get overlayVisible() {
      return !overlay.classList.contains('hidden');
    },
  };
}
