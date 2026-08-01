// main.js — ループ、状態遷移、各モジュールの結線。
// game.js を汚さないための境界はここ：イベント → 音・演出・UI の変換を一手に引き受ける。

import { CONFIG, COLORS, TEAM_PLAYER } from './config.js';
import { createState, restart, step, PHASE, heatRatio, isMatchPoint } from './game.js';
import { createBot, updateBot } from './bot.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import * as FX from './effects.js';

const S = CONFIG.world.scale;
const V = S * CONFIG.world.pace;
const STEP = 1 / 60;
const MAX_STEPS = 5;

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const audio = createAudio();
const fx = FX.createEffects();
const ui = createUI(onPrimary, (m) => input.setMode(m));

const state = createState();
const bot = createBot();
const intents = [null, null, null, null];

const input = createInput(canvas, {
  toWorld: renderer.toWorld,
  onFeedback: (kind) => { if (kind === 'stick') audio.click(); },
});

let snapCamera = true;   // キックオフ・リセット時はカメラを補間せずに飛ばす

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

// キックオフはタイマーではなく「蹴る側がボールに触れたら開始」なので、
// バナーは自動で消さず、開始イベントで消す。
function showKickoffBanner() {
  const mine = state.kickoffTeam === TEAM_PLAYER;
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
ui.applyMode();          // 保存されている操作方法を input へ反映
ui.showTitle();
ui.setScore(0, 0);

// ---------------------------------------------------------------- events

function handleEvents(events) {
  for (const e of events) {
    switch (e.type) {
      case 'kick': {
        const color = COLORS.team[e.team];
        FX.burst(fx, e.x, e.y, e.dx, e.dy, color, 14, 260);   // speed は effects 側でスケール
        FX.ripple(fx, e.x, e.y, color, 20);
        FX.shake(fx, 0.09);
        audio.kick(e.power);
        if (e.team === TEAM_PLAYER) buzz(8);
        break;
      }
      case 'dash':
        audio.dash();
        FX.ripple(fx, e.x, e.y, COLORS.team[e.team], 24);
        break;

      case 'pass': {
        // このゲームで最も気持ちいい瞬間。糸と音のピッチを完全に同期させる。
        FX.thread(fx, e.fx, e.fy, e.tx, e.ty, e.chain, COLORS.team[e.team]);
        FX.burst(fx, e.tx, e.ty, 0, -1, '#ffffff', 6 + Math.min(e.chain, 8), 150);
        audio.pass(e.chain);
        // ハプティクスはキック側で既に1回鳴っている。ここでは重ねない。
        if (e.team === TEAM_PLAYER) FX.shake(fx, 0.05 + Math.min(e.chain, 8) * 0.012);
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
        const color = COLORS.team[e.team];
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
        const win = e.winner === TEAM_PLAYER;
        ui.hideBanner();
        ui.showResult(win, state.score[0], state.score[1]);
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

  if (running) {
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

  FX.updateEffects(fx, dt);
  renderer.updateCamera(state, dt, snapCamera);
  snapCamera = false;
  audio.setHeat(heatRatio(state));
  ui.setScore(state.score[0], state.score[1]);
  ui.setMatchPoint(isMatchPoint(state) && state.phase !== PHASE.OVER);

  renderer.draw(state, fx, input);
}

function tick(dt) {
  const wasKickoff = state.phase === PHASE.KICKOFF;

  intents[0] = intents[1] = null;
  input.fill(intents, state.units);
  updateBot(bot, state, intents, dt);

  handleEvents(step(state, intents, dt));

  // 見た目のフィードバック（純粋ロジックの外側）
  if (state.phase === PHASE.PLAY || state.phase === PHASE.KICKOFF) {
    const b = state.ball;
    if (Math.hypot(b.vx, b.vy) > 60 * V) FX.trailPoint(fx, b.x, b.y, heatRatio(state));
    for (const u of state.units) {
      if (u.dashT > 0) FX.ghost(fx, u.x, u.y, CONFIG.unit.radius, COLORS.team[u.team]);
    }
  }

  if (!wasKickoff && state.phase === PHASE.KICKOFF) {
    showKickoffBanner();
    snapCamera = true;                 // 配置が飛ぶのでカメラも飛ばす
  }
}

requestAnimationFrame(frame);

// デバッグ用（コンソールから触れるように）
window.PAIRKICK = { state, fx, CONFIG, audio, input, ui, cam: renderer.cam, view: renderer.view };
