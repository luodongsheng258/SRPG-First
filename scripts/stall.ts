/**
 * 僵局诊断：找出打满回合上限的对局，把最后的局面画出来。
 *
 *   pnpm stall                 # 所有关卡，各 2000 局
 *   pnpm stall fort-01 3000    # 指定关卡与局数
 *
 * 为什么值得单独做一个工具：僵局是最难靠眼睛发现的一类 bug。
 * 它只在"偶尔"出现，看起来就像一局正常的持久战 —— 但它的后果很严重：
 * **真实游戏没有回合上限，玩家会永远卡在那里。**
 * 只统计"未分胜负 xx%"是不够的，必须看到局面才知道是什么卡住了谁。
 */

import { applyAction, aliveCount, planTurn } from '../src/core';
import type { BattleState, TerrainKind } from '../src/core';
import { LEVELS } from '../src/game/levels';

const MAX_TURNS = 50;

/* 两个参数顺序随你：`pnpm stall fort-01 2000` 和 `pnpm stall 2000 fort-01` 都认。
   写脚本时把参数顺序搞反一次就会浪费一整轮，不如让工具自己分辨。 */
const argv = process.argv.slice(2);
const levelArg = argv.find((a) => !/^\d+$/.test(a));
const roundArg = argv.find((a) => /^\d+$/.test(a));
const rounds = Number(roundArg ?? 2000);

if (!Number.isInteger(rounds) || rounds <= 0) {
  throw new Error('局数必须是正整数');
}
if (levelArg !== undefined && !LEVELS.has(levelArg)) {
  const available = LEVELS.list()
    .map((level) => level.entry.id)
    .join(', ');
  throw new Error(`未知关卡「${levelArg}」。可用：${available}`);
}

/** 跑完整局并**保留终局状态** —— autoBattle 只返回统计量，这里需要画面 */
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

const GLYPH: Record<TerrainKind, string> = {
  plain: ' . ',
  road: ' = ',
  forest: ' f ',
  hill: ' n ',
  mountain: ' ^ ',
  water: ' ~ ',
  fort: ' # ',
};

function board(state: BattleState): string {
  const lines: string[] = [];
  for (let y = 0; y < state.map.height; y += 1) {
    let row = '';
    for (let x = 0; x < state.map.width; x += 1) {
      const unit = state.units.find((u) => u.hp > 0 && u.pos.x === x && u.pos.y === y);
      if (unit) row += unit.team === 'player' ? ' P ' : ' E ';
      else row += GLYPH[state.map.terrain[y][x]];
    }
    lines.push(row);
  }
  return lines.join('\n');
}

function roster(state: BattleState): string {
  return state.units
    .filter((u) => u.hp > 0)
    .map(
      (u) =>
        `    ${u.team === 'player' ? 'P' : 'E'} ${u.name.padEnd(6)}` +
        ` (${u.pos.x},${u.pos.y})  hp ${u.hp}/${u.maxHp}  Lv${u.level}` +
        `\n        攻 ${u.atk}+${u.weapon.might}=${u.atk + u.weapon.might}` +
        `  防 ${u.def}  速 ${u.spd}  技 ${u.skill}` +
        `  ${u.weapon.name} 射程 ${u.weapon.range[0]}~${u.weapon.range[1]}` +
        `  地形 ${state.map.terrain[u.pos.y][u.pos.x]}`,
    )
    .join('\n');
}

const targets = levelArg === undefined ? LEVELS.list() : [LEVELS.require(levelArg)];
let totalStalls = 0;

for (const level of targets) {
  const seeds: number[] = [];
  for (let seed = 1; seed <= rounds; seed += 1) {
    const end = runToEnd(LEVELS.create(level.entry.id, seed));
    if (end.phase === 'playing') seeds.push(seed);
  }

  const rate = (seeds.length / rounds) * 100;
  console.log('');
  console.log(
    `关卡 ${level.number}. ${level.entry.name}（${level.entry.id}）· ${rounds} 局` +
      ` · 僵局 ${seeds.length} 局（${rate.toFixed(2)}%）`,
  );
  totalStalls += seeds.length;

  /* 只画前两个，够看清是什么局面了 */
  for (const seed of seeds.slice(0, 2)) {
    const end = runToEnd(LEVELS.create(level.entry.id, seed));
    console.log('');
    console.log(`  ── seed=${seed}  第 ${end.turn} 回合被上限截断 ──`);
    console.log(
      `     我方存活 ${aliveCount(end, 'player')} / 敌方存活 ${aliveCount(end, 'enemy')}`,
    );
    console.log(board(end));
    console.log(roster(end));
  }
  if (seeds.length > 2) console.log(`\n  （其余 ${seeds.length - 2} 局省略）`);
}

console.log('');
console.log(totalStalls === 0 ? '没有僵局。' : `合计 ${totalStalls} 局僵局。`);
console.log('');
