/**
 * Headless 数值模拟 —— 平衡调参的主要工具。
 *
 *   pnpm sim                  # 所有关卡，各 300 局，输出汇总表
 *   pnpm sim 1000             # 各 1000 局
 *   pnpm sim 1000 plain-01    # 只跑指定关卡，输出完整详情（含各兵种存活率）
 *
 * 这个脚本的存在本身就是架构的证明：调数值完全不需要启动引擎、不需要人操作。
 *
 * 只报"胜率"信息量不够 —— 赢下来剩 4 个人和剩 1 个人是完全不同的平衡状态。
 * 所以还报「残存兵力」和「各兵种存活率」，那才是判断强弱的直接证据。
 */

import { autoBattle, type BattlePhase } from '../src/core';
import { LEVELS, type LoadedLevel } from '../src/game/levels';

const MAX_TURNS = 50;

const rounds = Number(process.argv[2] ?? 300);
const only = process.argv[3];

if (!Number.isInteger(rounds) || rounds <= 0) {
  throw new Error('第一个参数是模拟局数，必须是正整数');
}

if (only !== undefined && !LEVELS.has(only)) {
  const available = LEVELS.list()
    .map((level) => level.entry.id)
    .join(', ');
  throw new Error(`未知关卡「${only}」。可用：${available}`);
}

interface Tally {
  survived: number;
  instances: number;
}

interface LevelStats {
  level: LoadedLevel;
  won: number;
  lost: number;
  stale: number;
  avgTurns: number;
  avgActions: number;
  avgPlayerAlive: number;
  avgEnemyAlive: number;
  playerTotal: number;
  enemyTotal: number;
  cleanSweeps: number;
  lastStand: number;
  byTemplate: Map<string, Tally>;
  labels: Map<string, string>;
  stalemate: { seed: number; turn: number } | null;
}

const teamLabel = (team: string) => (team === 'player' ? '我方' : '敌方');

function measure(level: LoadedLevel): LevelStats {
  const tally: Record<BattlePhase, number> = { won: 0, lost: 0, playing: 0 };
  const byTemplate = new Map<string, Tally>();
  const labels = new Map<string, string>();

  let sumTurns = 0;
  let sumActions = 0;
  let sumPlayerAlive = 0;
  let sumEnemyAlive = 0;
  let playerTotal = 0;
  let enemyTotal = 0;
  let cleanSweeps = 0;
  let lastStand = 0;
  let stalemate: { seed: number; turn: number } | null = null;

  for (let seed = 1; seed <= rounds; seed += 1) {
    const initial = LEVELS.create(level.entry.id, seed);
    if (seed === 1) {
      playerTotal = initial.units.filter((u) => u.team === 'player').length;
      enemyTotal = initial.units.filter((u) => u.team === 'enemy').length;
    }

    const outcome = autoBattle(initial, MAX_TURNS);
    const alive = new Set(outcome.survivors);

    for (const unit of initial.units) {
      const key = `${unit.team}:${unit.defId}`;
      if (!labels.has(key)) labels.set(key, `${teamLabel(unit.team)} ${unit.name}`);
      const entry = byTemplate.get(key) ?? { survived: 0, instances: 0 };
      entry.instances += 1;
      if (alive.has(unit.id)) entry.survived += 1;
      byTemplate.set(key, entry);
    }

    tally[outcome.phase] += 1;
    sumTurns += outcome.turn;
    sumActions += outcome.actions;
    sumPlayerAlive += outcome.playerAlive;
    sumEnemyAlive += outcome.enemyAlive;

    if (outcome.phase === 'won') {
      if (outcome.playerAlive === playerTotal) cleanSweeps += 1;
      if (outcome.playerAlive <= 1) lastStand += 1;
    }
    if (outcome.phase === 'playing' && (stalemate === null || outcome.turn > stalemate.turn)) {
      stalemate = { seed, turn: outcome.turn };
    }
  }

  return {
    level,
    won: tally.won,
    lost: tally.lost,
    stale: tally.playing,
    avgTurns: sumTurns / rounds,
    avgActions: sumActions / rounds,
    avgPlayerAlive: sumPlayerAlive / rounds,
    avgEnemyAlive: sumEnemyAlive / rounds,
    playerTotal,
    enemyTotal,
    cleanSweeps,
    lastStand,
    byTemplate,
    labels,
    stalemate,
  };
}

/* ------------------------------------------------------------------ 输出 */

const RULE = '─'.repeat(64);
const pctText = (n: number, total: number) => `${((n / total) * 100).toFixed(1)}%`;
const pad = (text: string, width: number) => {
  /* 中文字符宽度按 2 算，否则列会对不齐 */
  let visual = 0;
  for (const ch of text) visual += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return text + ' '.repeat(Math.max(1, width - visual));
};

const targets = only === undefined ? LEVELS.list() : [LEVELS.require(only)];

console.log('');
console.log(
  `战棋数值模拟 · ${targets.length} 关 · 各 ${rounds} 局 · 回合上限 ${MAX_TURNS}`,
);
console.log(RULE);

const startedAt = Date.now();

if (only === undefined) {
  /* 汇总模式：只报每关的总体表现 */
  console.log(
    pad('关卡', 22) +
      pad('我方胜', 10) +
      pad('我方负', 10) +
      pad('残存(我)', 12) +
      pad('残存(敌)', 12) +
      '回合',
  );
  console.log(RULE);

  for (const level of targets) {
    const s = measure(level);
    console.log(
      pad(`${s.level.number}. ${s.level.entry.name}`, 22) +
        pad(pctText(s.won, rounds), 10) +
        pad(pctText(s.lost, rounds), 10) +
        pad(`${s.avgPlayerAlive.toFixed(1)} / ${s.playerTotal}`, 12) +
        pad(`${s.avgEnemyAlive.toFixed(1)} / ${s.enemyTotal}`, 12) +
        s.avgTurns.toFixed(1),
    );
  }
  console.log(RULE);
  console.log('挑一个关卡看详情：  pnpm sim 1000 plain-01');
} else {
  /* 详情模式：完整的一组数据 */
  const s = measure(targets[0]);

  console.log(
    `关卡 ${s.level.number}. ${s.level.entry.name}（${s.level.entry.id}）` +
      `   我方 ${s.playerTotal} 人 vs 敌方 ${s.enemyTotal} 人`,
  );
  console.log(RULE);
  console.log(`我方胜      ${String(s.won).padStart(6)}   ${pctText(s.won, rounds)}`);
  console.log(`我方负      ${String(s.lost).padStart(6)}   ${pctText(s.lost, rounds)}`);
  console.log(`未分胜负    ${String(s.stale).padStart(6)}   ${pctText(s.stale, rounds)}`);
  console.log(RULE);
  console.log(`平均回合数      ${s.avgTurns.toFixed(1)}`);
  console.log(`平均动作数      ${s.avgActions.toFixed(0)}`);
  console.log(
    `平均残存  我方 ${s.avgPlayerAlive.toFixed(1)} / ${s.playerTotal}` +
      `      敌方 ${s.avgEnemyAlive.toFixed(1)} / ${s.enemyTotal}`,
  );
  if (s.won > 0) {
    console.log(
      `胜局中零阵亡 ${String(s.cleanSweeps).padStart(5)} / ${s.won}   ${pctText(s.cleanSweeps, s.won)}`,
    );
    console.log(
      `胜局中剩 1 人 ${String(s.lastStand).padStart(4)} / ${s.won}   ${pctText(s.lastStand, s.won)}`,
    );
  }
  console.log('');
  console.log('各兵种存活率');
  console.log(RULE);
  for (const [key, entry] of [...s.byTemplate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rate = entry.survived / entry.instances;
    const bar = '█'.repeat(Math.round(rate * 20)).padEnd(20, '·');
    console.log(
      `  ${pad(s.labels.get(key) ?? key, 14)} ${bar} ${(rate * 100).toFixed(0).padStart(3)}%` +
        `  (${entry.survived}/${entry.instances})`,
    );
  }

  if (s.stalemate !== null) {
    console.log('');
    console.log(`⚠ 有 ${s.stale} 局打满 ${MAX_TURNS} 回合仍未分胜负。`);
    console.log(`   最久的一局：seed=${s.stalemate.seed}（turn=${s.stalemate.turn}）`);
  }

  console.log('');
  console.log('挑选原则：目标胜率 45%~60%；「零阵亡」比例过高说明敌人没有威胁。');
}

console.log('');
console.log(`耗时 ${Date.now() - startedAt} ms`);
console.log('');
