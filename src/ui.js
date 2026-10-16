// ui.js — DOM オーバーレイ（HUD / バナー / タイトル / リザルト）。
// Apple 的な質感（半透明 + blur + ヘアライン + スプリング）はここに集中させる。

import { normalizeCpuLevel, cpuTeamSize } from './cpu.js';
import { CONFIG } from './config.js';

const CPU_KEY = 'pairkick.cpuLevel';
const OPP_KEY = 'pairkick.opponent';
const CTRL_KEY = 'pairkick.controlMode';
const AIM_KEY = 'pairkick.tackleAim';
const STICK_KEY = 'pairkick.stickScale';
const RANGE_KEY = 'pairkick.aimRange';
const ANGLE_KEY = 'pairkick.aimAngle';

export function createUI(onPrimary, onCancel = () => {}) {
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
  const ovOpps = el('ov-opponents');
  const ovCpu = el('ov-cpu');
  const cpuInput = el('cpu-level');
  const cpuTag = el('cpu-tag');
  const cpuSummary = el('cpu-summary');
  let cpuLevel = normalizeCpuLevel();
  try { cpuLevel = normalizeCpuLevel(localStorage.getItem(CPU_KEY)); } catch (_) {}
  cpuInput.value = cpuLevel;
  function paintCpuSummary() {
    const level = normalizeCpuLevel(cpuInput.value);
    cpuSummary.textContent = level === 100 ? 'Lv.100 神級 · 自分2人 対 CPU3人'
      : `自分2人 対 CPU${cpuTeamSize(level)}人${level >= 80 ? ' · 超高難度' : ''}`;
  }
  paintCpuSummary();
  function saveCpuLevel() {
    cpuLevel = normalizeCpuLevel(cpuInput.value);
    cpuInput.value = cpuLevel;
    paintCpuSummary();
    try { localStorage.setItem(CPU_KEY, String(cpuLevel)); } catch (_) {}
    return cpuLevel;
  }
  // 入力欄を触っても「カード全体タップで開始」へ伝わらないようにする。
  ovCpu.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovCpu.addEventListener('click', (e) => e.stopPropagation());
  cpuInput.addEventListener('change', saveCpuLevel);
  cpuInput.addEventListener('input', paintCpuSummary);

  let opponent = 'bot';
  try { opponent = localStorage.getItem(OPP_KEY) || 'bot'; } catch (_) {}
  if (opponent !== 'bot' && opponent !== 'human') opponent = 'bot';

  function paintOpp() {
    ovCpu.hidden = opponent !== 'bot';
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

  // 操作方法：'stick'（離してタックル）/ 'tap'（画面タップでタックル）
  const ovCtrl = el('ov-control');
  const hintAct = el('hint-act');
  let controlMode = 'stick';
  try { controlMode = localStorage.getItem(CTRL_KEY) === 'tap' ? 'tap' : 'stick'; } catch (_) {}
  let onControlMode = () => {};
  function paintCtrl() {
    for (const b of ovCtrl.querySelectorAll('.seg')) {
      b.classList.toggle('on', b.dataset.ctrl === controlMode);
    }
    hintAct.innerHTML = controlMode === 'tap'
      ? '<b>タップ</b><span>タックル（駒→指の向き）</span>'
      : '<b>離す</b><span>キック / ダッシュ</span>';
  }
  ovCtrl.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovCtrl.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    controlMode = b.dataset.ctrl === 'tap' ? 'tap' : 'stick';
    try { localStorage.setItem(CTRL_KEY, controlMode); } catch (_) {}
    paintCtrl();
    onControlMode(controlMode);
  });
  paintCtrl();

  // タックルの向き：'stick'（操作どおり）/ 'ball'（近くのボール・相手へ補正。src/aim.js）
  const ovAim = el('ov-aim');
  // 補正する距離（ボール何個ぶんの隙間までを補正するか）。1個ぶんがいちばん短い
  const ovRange = el('ov-range');
  const rangeInput = el('aim-range');
  const rangeVal = el('aim-range-val');
  const ballD = CONFIG.ball.radius * 2;
  const maxBalls = CONFIG.aimBall.maxGap / ballD;
  const minBalls = CONFIG.aimBall.gap / ballD;
  let aimBalls = minBalls;
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    if (Number.isFinite(v) && v > 0) aimBalls = v;
  } catch (_) {}
  aimBalls = Math.round(Math.min(maxBalls, Math.max(minBalls, aimBalls)) * 2) / 2;
  rangeInput.min = String(minBalls);
  rangeInput.max = String(maxBalls);
  rangeInput.value = String(aimBalls);
  const paintRange = () => { rangeVal.textContent = `ボール${aimBalls}個`; };
  paintRange();
  ovRange.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovRange.addEventListener('click', (e) => e.stopPropagation());
  rangeInput.addEventListener('input', () => {
    aimBalls = Number(rangeInput.value) || minBalls;
    paintRange();
  });
  rangeInput.addEventListener('change', () => {
    try { localStorage.setItem(RANGE_KEY, String(aimBalls)); } catch (_) {}
  });

  // 補正する角度（度）。指を払った向きからこれ以上外れた相手・ボールへは補正しない。180° は向きを問わない
  const ovAngle = el('ov-angle');
  const angleInput = el('aim-angle');
  const angleVal = el('aim-angle-val');
  const minAngle = CONFIG.aimBall.minAngle;
  let aimAngle = 180;
  try {
    const v = Number(localStorage.getItem(ANGLE_KEY));
    if (Number.isFinite(v) && v > 0) aimAngle = v;
  } catch (_) {}
  aimAngle = Math.round(Math.min(180, Math.max(minAngle, aimAngle)) / 15) * 15;
  angleInput.min = String(minAngle);
  angleInput.value = String(aimAngle);
  const paintAngle = () => { angleVal.textContent = aimAngle >= 180 ? '全方向' : `±${aimAngle}°`; };
  paintAngle();
  ovAngle.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovAngle.addEventListener('click', (e) => e.stopPropagation());
  angleInput.addEventListener('input', () => {
    aimAngle = Number(angleInput.value) || 180;
    paintAngle();
  });
  angleInput.addEventListener('change', () => {
    try { localStorage.setItem(ANGLE_KEY, String(aimAngle)); } catch (_) {}
  });
  let tackleAim = 'stick';
  try { tackleAim = localStorage.getItem(AIM_KEY) === 'ball' ? 'ball' : 'stick'; } catch (_) {}
  function paintAim() {
    for (const b of ovAim.querySelectorAll('.seg')) {
      b.classList.toggle('on', b.dataset.aim === tackleAim);
    }
    ovRange.classList.toggle('off', tackleAim !== 'ball');
    ovAngle.classList.toggle('off', tackleAim !== 'ball');
  }
  ovAim.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovAim.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    tackleAim = b.dataset.aim === 'ball' ? 'ball' : 'stick';
    try { localStorage.setItem(AIM_KEY, tackleAim); } catch (_) {}
    paintAim();
  });
  paintAim();

  // スティックの大きさ（%）。動かしているあいだは実寸の見本を出す
  const ovStick = el('ov-stick');
  const stickInput = el('stick-size');
  const stickVal = el('stick-size-val');
  const stickPreview = el('stick-preview');
  let stickPct = 100;
  try {
    const v = Number(localStorage.getItem(STICK_KEY));
    if (Number.isFinite(v) && v > 0) stickPct = v;
  } catch (_) {}
  stickPct = Math.round(Math.min(100, Math.max(CONFIG.stick.minScale * 100, stickPct)) / 5) * 5;
  stickInput.min = String(CONFIG.stick.minScale * 100);
  stickInput.value = String(stickPct);
  let onStickScale = () => {};
  let previewTimer = 0;
  function paintStick(preview) {
    stickVal.textContent = `${stickPct}%`;
    const r = CONFIG.stick.maxRadius * stickPct / 100;
    stickPreview.style.setProperty('--r', `${r}px`);
    stickPreview.style.setProperty('--k', `${Math.max(9, CONFIG.stick.knobRadius * stickPct / 100)}px`);
    if (preview) {
      stickPreview.classList.add('show');
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => stickPreview.classList.remove('show'), 900);
    }
  }
  ovStick.addEventListener('pointerdown', (e) => e.stopPropagation());
  ovStick.addEventListener('click', (e) => e.stopPropagation());
  stickInput.addEventListener('input', () => {
    stickPct = Number(stickInput.value) || 100;
    paintStick(true);
    onStickScale(stickPct / 100);
  });
  stickInput.addEventListener('change', () => {
    try { localStorage.setItem(STICK_KEY, String(stickPct)); } catch (_) {}
  });
  paintStick(false);

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

  paintOpp();

  return {
    get opponent() { return opponent; },
    get controlMode() { return controlMode; },
    set onControlMode(fn) { onControlMode = fn; },
    get tackleAim() { return tackleAim; },
    /** 補正する距離（表面どうしの隙間、世界座標） */
    get aimGap() { return aimBalls * ballD; },
    /** 補正する角度（度）。180 は向きを問わない */
    get aimAngle() { return aimAngle; },
    get stickScale() { return stickPct / 100; },
    set onStickScale(fn) { onStickScale = fn; },
    get cpuLevel() { return saveCpuLevel(); },

    setCpuMatch(level) {
      cpuTag.hidden = level == null;
      cpuTag.textContent = level == null ? '' : `CPU Lv.${normalizeCpuLevel(level)} · 2対${cpuTeamSize(level)}${normalizeCpuLevel(level) === 100 ? ' · 神級' : ''}`;
    },

    /** 対人戦の通信状態。null で消す */
    setNetInfo(text) {
      cpuTag.hidden = text == null;
      cpuTag.textContent = text == null ? '' : text;
    },

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
      paintOpp();
      cpuTag.hidden = true;
      ovKicker.textContent = '2対2 / 2対3サッカー';
      ovTitle.textContent = 'PAIR KICK';
      ovTitle.className = '';
      ovBody.innerHTML = '2つの駒、2本の親指。<br>左半分で左の駒、右半分で右の駒。';
      ovHints.style.display = '';
      ovOpps.style.display = '';
      ovBtn.textContent = 'はじめる';
      ovBtn.disabled = false;
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    /** 相手は見つかった。同じWi-Fiなら直結しようとしているところ。 */
    showLinking() {
      this.showWaiting();
      ovTitle.textContent = '相手が見つかりました';
      ovBody.innerHTML = '接続を準備しています…<br>同じWi-Fiなら直接つないで通信を速くします。';
    },

    /** 対人戦の相手待ち */
    showWaiting() {
      ovKicker.textContent = '対人戦';
      ovCpu.hidden = true;
      cpuTag.hidden = true;
      ovTitle.textContent = '相手を待っています';
      ovTitle.className = 'waiting';
      ovBody.innerHTML = 'この画面のURLを相手に渡してください。<br>2人そろうと自動で始まります。';
      ovHints.style.display = 'none';
      ovOpps.style.display = 'none';
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
      paintOpp();
      ovKicker.textContent = '対人戦';
      ovTitle.textContent = everConnected ? '接続が切れました' : '接続できませんでした';
      ovTitle.className = 'lose';
      ovBody.textContent = text;
      ovHints.style.display = 'none';
      ovOpps.style.display = '';
      ovBtn.textContent = 'タイトルへ';
      ovBtn.disabled = false;
      overlay.classList.remove('hidden');
      lockUntil = performance.now() + 450;
    },

    showResult(win, a, b) {
      paintOpp();
      waitingCancel = false;
      ovOpps.style.display = '';
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
