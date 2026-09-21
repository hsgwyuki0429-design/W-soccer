import { CONFIG } from './config.js';

export function normalizeCpuLevel(value) {
  const C = CONFIG.cpu;
  if (typeof value !== 'number' && typeof value !== 'string') return C.defaultLevel;
  if (typeof value === 'string' && !value.trim()) return C.defaultLevel;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(C.min, Math.min(C.max, Math.round(n))) : C.defaultLevel;
}

export function cpuTeamSize(value) {
  return normalizeCpuLevel(value) >= 80 ? 3 : 2;
}

// レベルは判断にだけ渡す。game.js の物理設定は一切書き換えない。
export function cpuProfile(value) {
  const level = normalizeCpuLevel(value);
  const base = CONFIG.bot;
  const tactics = Math.max(0, (level - 3) / 97);
  const k = level < 3 ? (3 - level) / 2 : tactics;
  const target = level < 3 ? CONFIG.cpu.easy : CONFIG.cpu.elite;
  const expert = Math.max(0, (level - 39) / 61);
  const profile = { ...base, level, tactics, prediction: level < 3 ? 1 - k * 0.65 : 1,
    expert, teamSize: cpuTeamSize(level) };
  for (const key of Object.keys(target)) profile[key] = base[key] + (target[key] - base[key]) * k;
  if (expert > 0) {
    profile.rethinkMs *= 1 - expert * (1 - (1000 / 60) / CONFIG.cpu.elite.rethinkMs);
    profile.noise *= 1 - expert;
  }
  // 思考の頻度が増えるだけでタックル回数が何倍にもならないよう、時間あたりで補正。
  profile.tackleProbability = 1 - Math.pow(1 - profile.tackleChance, profile.rethinkMs / base.rethinkMs);
  return Object.freeze(profile);
}
