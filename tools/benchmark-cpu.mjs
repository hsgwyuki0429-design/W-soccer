// 前回公開したLv.100との再現可能な比較。Git履歴にBASEが必要。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, step, PHASE } from '../src/game.js';
import { createBot, updateBot } from '../src/bot.js';

const BASE = '58144f1b685362af4e6372b398418dc98518d13f';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = (file) => execFileSync('git', ['show', `${BASE}:src/${file}`], { cwd: root, encoding: 'utf8' });
const moduleUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const config = moduleUrl(source('config.js'));
const cpu = moduleUrl(source('cpu.js').replace("'./config.js'", JSON.stringify(config)));
const legacy = await import(moduleUrl(source('bot.js')
  .replace("'./config.js'", JSON.stringify(config))
  .replace("'./cpu.js'", JSON.stringify(cpu))
  .replace("'./game.js'", JSON.stringify(new URL('../src/game.js', import.meta.url).href))));

const originalRandom = Math.random;
try {
  for (const cpuCount of [2, 3]) {
    const goals = { enhanced: 0, previous: 0 }, wins = { enhanced: 0, previous: 0 };
    let timeouts = 0;
    const start = performance.now();
    for (let match = 0; match < 12; match++) {
      let seed = 42 + match;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      // 2対2は左右を交替。2対3は実ゲーム同様にCPUがチーム1。
      const team = cpuCount === 3 ? 1 : match % 2;
      const s = createState(cpuCount), enhanced = createBot(team, 100), previous = legacy.createBot(1 - team, 100);
      for (let tick = 0; tick < 180 * 60; tick++) {
        const intents = [];
        legacy.updateBot(previous, s, intents, 1 / 60);
        updateBot(enhanced, s, intents, 1 / 60);
        step(s, intents, 1 / 60);
        if (s.phase === PHASE.OVER) break;
      }
      goals.enhanced += s.score[team]; goals.previous += s.score[1 - team];
      if (s.winner < 0) timeouts++;
      else wins[s.winner === team ? 'enhanced' : 'previous']++;
    }
    console.log(JSON.stringify({ mode: `2v${cpuCount}`, matches: 12, goals, wins, timeouts,
      elapsedMs: Math.round(performance.now() - start) }));
  }
} finally { Math.random = originalRandom; }
