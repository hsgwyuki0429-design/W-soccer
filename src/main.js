// main.js — ループ、状態遷移、各モジュールの結線。
// game.js を汚さないための境界はここ：イベント → 音・演出・UI の変換を一手に引き受ける。

import { CONFIG, TEAM_PLAYER } from './config.js';
import { createState, restart, step, PHASE, heatRatio, isMatchPoint } from './game.js';
import { createBot, updateBot } from './bot.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import * as FX from './effects.js';
import { createNet } from './net.js';

const S = CONFIG.world.scale;
const V = S * CONFIG.world.pace;
const STEP = 1 / 60;
const MAX_STEPS = 5;

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const audio = createAudio();
const fx = FX.createEffects();
const ui = createUI(
  onPrimary,
  () => { leaveVersus(); ui.showTitle(); },   // 相手待ちをやめる
);

const myTeam = () => (versus ? net.myTeam : TEAM_PLAYER);
const colorOf = (team) => renderer.teamColor(team);

const net = createNet();
const state = createState();
const bot = createBot();
const intents = [null, null, null, null];

const input = createInput(canvas, {
  onFeedback: (kind) => { if (kind === 'stick') audio.click(); },
});

let snapCamera = true;   // キックオフ・リセット時はカメラを補間せずに飛ばす
let versus = false;      // 対人戦なら true（試合はサーバーが進める）
const netIntents = [null, null];

let running = false;
let acc = 0;
let last = performance.now();

// ---------------------------------------------------------------- haptics

function buzz(pattern) {
  if (fx.reduced) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (_) {}
  }
}

// ---------------------------------------------------------------- lifecycle

function onPrimary() {
  audio.unlock();

  if (ui.opponent === 'human') {
    if (net.status === 'playing') {
      // 試合中に開いた結果画面から。決着していれば再戦を頼む
      if (state.phase === PHASE.OVER) net.restart();
      ui.hideOverlay();
      input.reset();
      running = true;
      return;
    }
    // 相手が見つかるまでは始めない
    net.connect();
    ui.showWaiting();
    return;
  }

  // ボット戦
  if (versus) leaveVersus();
  if (state.phase === PHASE.OVER) {
    restart(state);
    FX.clearEffects(fx);
  }
  ui.hideOverlay();
  input.reset();
  snapCamera = true;
  running = true;
  showKickoffBanner();
}

function leaveVersus() {
  versus = false;
  net.disconnect();
  renderer.setViewpoint(0);
  restart(state);
  FX.clearEffects(fx);
}

net.on('status', (st) => {
  if (st === 'waiting') { ui.showWaiting(); return; }
  if (st === 'error') {
    // 一度も繋がっていない失敗。よくある原因はホスティング側が
    // WebSocket を持っていないこと（例：GitHub Pages は静的配信のみ）。
    ui.showNetError('このページは対人戦に対応していないか、サーバーに接続できません。', false);
    running = false;
    return;
  }
  if (st === 'gone') {
    versus = false;
    running = false;
    ui.showNetError('相手が切断しました');
    return;
  }
  if (st === 'playing') {
    versus = true;
    renderer.setViewpoint(net.myTeam);
    restart(state);
    FX.clearEffects(fx);
    input.reset();
    ui.hideOverlay();
    snapCamera = true;
    running = true;
    showKickoffBanner();
  }
});

net.on('events', (evs) => handleEvents(evs));

// キックオフはタイマーではなく「蹴る側がボールに触れたら開始」なので、
// バナーは自動で消さず、開始イベントで消す。
function showKickoffBanner() {
  const mine = state.kickoffTeam === myTeam();
  ui.banner('KICK OFF', mine ? 'ボールに触れて開始' : '相手ボール', 0);
}

function resize() {
  const v = renderer.resize();
  ui.setUnit(v.uiScale, v.netTop);
  snapCamera = true;   // 画面の向きが変わるのは不連続。補間せず合わせ直す
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
document.addEventListener('visibilitychange', () => { last = performance.now(); });

resize();
ui.showTitle();
ui.setScore(0, 0);

// ---------------------------------------------------------------- events

function handleEvents(events) {
  for (const e of events) {
    switch (e.type) {
      case 'kick': {
        const color = colorOf(e.team);
        FX.burst(fx, e.x, e.y, e.dx, e.dy, color, 14, 260);   // speed は effects 側でスケール
        FX.ripple(fx, e.x, e.y, color, 20);
        FX.shake(fx, 0.09);
        audio.kick(e.power);
        if (e.team === myTeam()) buzz(8);
        break;
      }
      case 'dash':
        audio.dash();
        FX.ripple(fx, e.x, e.y, colorOf(e.team), 24);
        break;

      case 'pass': {
        // このゲームで最も気持ちいい瞬間。糸と音のピッチを完全に同期させる。
        FX.thread(fx, e.fx, e.fy, e.tx, e.ty, e.chain, colorOf(e.team));
        FX.burst(fx, e.tx, e.ty, 0, -1, '#ffffff', 6 + Math.min(e.chain, 8), 150);
        audio.pass(e.chain);
        // ハプティクスはキック側で既に1回鳴っている。ここでは重ねない。
        if (e.team === myTeam()) FX.shake(fx, 0.05 + Math.min(e.chain, 8) * 0.012);
        break;
      }

      case 'touch':
        if (e.strength > 0.06) audio.touch(e.strength);
        if (e.strength > 0.35) {
          FX.burst(fx, e.x, e.y, 0, 0, 'rgba(255,255,255,0.8)', 3, 90);
        }
        break;

      case 'wall':
        audio.wall(e.strength);
        break;

      case 'post':
        audio.wall(0.9);
        FX.burst(fx, e.x, e.y, 0, 0, '#ffffff', 8, 200);
        FX.shake(fx, 0.16);
        break;

      case 'bump':
        audio.touch(e.strength * 0.6);
        FX.ripple(fx, e.x, e.y, 'rgba(255,255,255,0.9)', 18);
        break;

      case 'nudge':
        FX.ripple(fx, e.x, e.y, 'rgba(255,255,255,0.7)', 30);
        break;

      case 'kickoff':
        ui.hideBanner();
        audio.kickoff();
        break;

      case 'goal': {
        const color = colorOf(e.team);
        FX.flash(fx, color, 0.7);
        FX.shake(fx, 1);
        FX.hitstop(fx, 0.09);
        FX.sparkle(fx, e.x, Math.max(30 * S, Math.min(e.y, CONFIG.field.h - 30 * S)), color, 30, 90);
        audio.goal();
        buzz([26, 40, 70]);
        ui.banner('GOAL', e.ownGoal ? 'OWN GOAL' : '', CONFIG.match.goalPause * 1000 - 200);
        break;
      }

      case 'matchend': {
        const win = e.winner === myTeam();
        ui.hideBanner();
        ui.showResult(win, state.score[myTeam()], state.score[1 - myTeam()]);
        audio.result(win);
        buzz(win ? [30, 50, 30, 50, 90] : [60]);
        running = false;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- loop

function frame(now) {
  requestAnimationFrame(frame);

  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;      // タブ復帰などの巨大デルタを捨てる

  input.update(dt);

  if (versus) {
    // 試合はサーバーが進めている。ここは意図を送って、届いた状態を描くだけ。
    if (running) tick(dt);
    net.apply(state, now);
  } else if (running) {
    if (fx.hitstop > 0) {
      // ヒットストップ中は物理を止める。演出だけ進む。
      acc = 0;
    } else {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < MAX_STEPS) {
        acc -= STEP;
        steps++;
        tick(STEP);
      }
      if (steps === MAX_STEPS) acc = 0;
    }
  }

  watchPhase();
  FX.updateEffects(fx, dt);
  renderer.updateCamera(state, dt, snapCamera);
  snapCamera = false;
  audio.setHeat(heatRatio(state));
  ui.setScore(state.score[myTeam()], state.score[1 - myTeam()]);
  ui.setMatchPoint(isMatchPoint(state) && state.phase !== PHASE.OVER);

  renderer.draw(state, fx, input);
}

function tick(dt) {
  const order = renderer.myUnitsInScreenOrder(state);
  input.fill(netIntents, order);

  if (versus) {
    // 反転してプレイしている側は、画面の向きと世界の向きが逆になる
    if (renderer.flip) {
      for (const it of netIntents) {
        it.move.x = -it.move.x; it.move.y = -it.move.y;
        if (it.flick) { it.flick.x = -it.flick.x; it.flick.y = -it.flick.y; }
      }
    }
    // サーバーは駒番号の順（team*2, team*2+1）で受け取る。
    // こちらは画面の左右順で持っているので、番号順へ並べ直してから送る。
    // 反転側では左右が入れ替わるため、これを怠ると2駒の担当が逆になる。
    const base = myTeam() * 2;
    const slot = [null, null];
    slot[order[0].index - base] = netIntents[0];
    slot[order[1].index - base] = netIntents[1];
    net.sendIntents(slot[0], slot[1]);
  } else {
    intents[0] = intents[1] = null;
    intents[order[0].index] = netIntents[0];
    intents[order[1].index] = netIntents[1];
    updateBot(bot, state, intents, dt);
    handleEvents(step(state, intents, dt));
  }

  // 見た目のフィードバック（純粋ロジックの外側）
  if (state.phase === PHASE.PLAY || state.phase === PHASE.KICKOFF) {
    const b = state.ball;
    if (Math.hypot(b.vx, b.vy) > 60 * V) FX.trailPoint(fx, b.x, b.y, heatRatio(state));
    for (const u of state.units) {
      if (u.dashT > 0) FX.ghost(fx, u.x, u.y, CONFIG.unit.radius, colorOf(u.team));
    }
  }

}

// フェーズの変わり目を1か所で見る。対人戦では tick のあとにサーバーの状態へ
// 入れ替わるので、tick の中で見ると1フレーム前の値を見てしまう。
let lastPhase = PHASE.KICKOFF;
function watchPhase() {
  if (state.phase === lastPhase) return;
  const prev = lastPhase;
  lastPhase = state.phase;
  if (state.phase === PHASE.KICKOFF) {
    showKickoffBanner();
    snapCamera = true;                 // 配置が飛ぶのでカメラも飛ばす
  }
  if (versus && state.phase === PHASE.OVER && prev !== PHASE.OVER) {
    // 対人戦の決着はサーバーの matchend イベントで拾うが、
    // 取りこぼした場合の保険として結果画面を出す
    if (!ui.overlayVisible) ui.showResult(state.winner === myTeam(), state.score[myTeam()], state.score[1 - myTeam()]);
    running = false;
  }
}

// ホーム画面に追加したときにオフラインでも起動できるようにする。
// 失敗しても遊べなくはならないので、握りつぶしてよい。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

requestAnimationFrame(frame);

// デバッグ用（コンソールから触れるように）
window.PAIRKICK = { state, fx, CONFIG, audio, input, ui, net, renderer, netIntents, cam: renderer.cam, view: renderer.view };
