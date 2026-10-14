/**
 * 战役模拟：从第一关打到最后一关，**一路带着队伍成长**。
 *
 *   pnpm campaign         # 200 次完整战役
 *   pnpm campaign 1000
 *
 * 为什么 `pnpm sim` 不够：它每关都用全新的队伍，完全看不到升级。
 * 而升级是个**正反馈** —— 前两关打得好就等级高，等级高又让第三关更轻松。
 * 只有把名册一路带下去，才知道整条曲线是"越来越顺手"还是"第三关卡死"。
 *
 * 一局输了就停在那里（真实玩家会重打，那是另一个问题），
 * 所以除了每关胜率，还会报"有多少局走到了这一关"和"通关率"。
 */

import { applyAction, aliveCount, exportRoster, planTurn } from '../src/core';
import type { BattleState, Roster } from '../src/core';
import { LEVELS } from '../src/game/levels';

const MAX_TURNS = 50;

const runs = Number(process.argv[2] ?? 200);
if (!Number.isInteger(runs) || runs <= 0) {
  throw new Error('参数是模拟的战役数，必须是正整数');
}

/** 跑完整局并保留终局状态 */
function runToEnd(initial: BattleState): BattleState {
  let cur = initial;
  while (cur.phase === 'playing' && cur.turn <= MAX_TURNS) {
    for (const action of planTurn(cur, cur.activeTeam)) {
      cur = applyAction(cur, action);
      if (cur.phase !== 'playing') break;
    }
  }
  return cur;
}

const levels = LEVELS.list();

interface ChapterStat {
  /** 有多少局真的走到了这一关 */
  reached: number;
  won: number;
  lost: number;
  stale: number;
  sumTurns: number;
  sumSurvivors: number;
  /** 进入这一关时的平均等级 */
  sumEnterLevel: number;
  /** 打完这一关之后的平均等级 */
  sumExitLevel: number;
}

const stats: ChapterStat[] = levels.map(() => ({
  reached: 0,
  won: 0,
  lost: 0,
  stale: 0,
  sumTurns: 0,
  sumSurvivors: 0,
  sumEnterLevel: 0,
  sumExitLevel: 0,
}));

let clearedAll = 0;
const startedAt = Date.now();

for (let run = 1; run <= runs; run += 1) {
  let roster: Roster = {};
  let survived = true;

  for (const [index, level] of levels.entries()) {
    if (!survived) break;

    const stat = stats[index];
    const initial = LEVELS.create(level.entry.id, run * 1000 + level.number, roster);
    const players = initial.units.filter((u) => u.team === 'player');
    stat.reached += 1;
    stat.sumEnterLevel += players.reduce((sum, u) => sum + u.level, 0) / players.length;

    const end = runToEnd(initial);
    stat.sumTurns += end.turn;
    stat.sumSurvivors += aliveCount(end, 'player');

    const after = end.units.filter((u) => u.team === 'player');
    stat.sumExitLevel += after.reduce((sum, u) => sum + u.level, 0) / after.length;

    if (end.phase === 'won') {
      stat.won += 1;
      /* 成长要**带下去** —— 这正是这个脚本存在的理由 */
      roster = exportRoster(end, roster);
    } else {
      if (end.phase === 'lost') stat.lost += 1;
      else stat.stale += 1;
      survived = false;
    }
  }

  if (survived) clearedAll += 1;
}

/* ------------------------------------------------------------------ 输出 */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(7);
const num = (v: number, digits = 1) => v.toFixed(digits).padStart(6);

console.log('');
console.log(`战役模拟 · ${runs} 次完整战役 · 回合上限 ${MAX_TURNS}`);
console.log('─'.repeat(84));
console.log(
  `${'关卡'.padEnd(20)}${'到达'.padStart(7)}${'通过率'.padStart(10)}` +
    `${'平均回合'.padStart(10)}${'残存(我)'.padStart(10)}` +
    `${'进关等级'.padStart(10)}${'出关等级'.padStart(10)}`,
);
console.log('─'.repeat(84));

for (const [index, level] of levels.entries()) {
  const stat = stats[index];
  if (stat.reached === 0) {
    console.log(`${`${level.number}. ${level.entry.name}`.padEnd(20)}${'—'.padStart(7)}   （没人走到这里）`);
    continue;
  }

  console.log(
    `${`${level.number}. ${level.entry.name}`.padEnd(20)}` +
      `${String(stat.reached).padStart(7)}` +
      `${pct(stat.won / stat.reached)}   ` +
      `${num(stat.sumTurns / stat.reached)}   ` +
      `${num(stat.sumSurvivors / stat.reached)}   ` +
      `${num(stat.sumEnterLevel / stat.reached)}   ` +
      `${num(stat.sumExitLevel / stat.reached)}`,
  );
}

console.log('─'.repeat(84));
console.log(`通关率（三关全过）： ${clearedAll} / ${runs}  =  ${((clearedAll / runs) * 100).toFixed(1)}%`);
console.log('');
console.log('看两件事：① 进关等级是不是随关卡上升（升级有没有真的带下去）');
console.log('          ② 通过率是不是平缓下降（不该出现某一关断崖）');
console.log('');
console.log(`耗时 ${Date.now() - startedAt} ms`);
console.log('');
