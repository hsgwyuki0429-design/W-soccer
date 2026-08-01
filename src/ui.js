// ui.js — DOM オーバーレイ（HUD / バナー / タイトル / リザルト）。
// Apple 的な質感（半透明 + blur + ヘアライン + スプリング）はここに集中させる。

export function createUI(onPrimary) {
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

  let bannerTimer = 0;
  let shown = [-1, -1];
  let lockUntil = 0;              // 直前の指残りで即再戦してしまうのを防ぐ

  function primary() {
    if (performance.now() < lockUntil) return;
    lockUntil = performance.now() + 400;
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

  return {
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
      ovBtn.textContent = 'はじめる';
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    showResult(win, a, b) {
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
      overlay.classList.add('hidden');
    },

    get overlayVisible() {
      return !overlay.classList.contains('hidden');
    },
  };
}
