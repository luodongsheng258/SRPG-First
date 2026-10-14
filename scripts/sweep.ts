/**
 * 平衡扫描 —— 一次跑多组参数，直接看响应曲线。
 *
 *   pnpm sweep
 *
 * 调平衡最忌讳"改一个数 → 跑一局 → 再猜"。旋钮和结果之间不是线性的，
 * 靠猜要试十几次。这里把参数网格一次性跑完，看着表挑那个点就行。
 *
 * 想扫别的维度就改下面的 GRID 和 buildSpawns —— 这就是个临时脚手架，
 * 不需要写得多么通用。
 */

import mapRaw from '../data/maps/plain-01.json';
import unitsRaw from '../data/units.json';
import weaponsRaw from '../data/weapons.json';

import {
  autoBattle,
  createBattle,
  parseScenario,
  parseUnitDefs,
  parseWeaponDefs,
  type Scenario,
  type UnitDef,
  type UnitSpawn,
  type Vec2,
} from '../src/core';

const rounds = Number(process.argv[2] ?? 300);
const maxTurns = Number(process.argv[3] ?? 50);

const baseDefs = parseUnitDefs(unitsRaw);
const baseWeapons = parseWeaponDefs(weaponsRaw);
const baseScenario = parseScenario(mapRaw);
const playerSpawns = baseScenario.spawns.filter((s) => s.team === 'player');

/**
 * 敌方右侧的空地，按"从外到内"的顺序排。
 * 全部是平原 —— 出生点落在水上会在 createBattle 里直接抛错，那也算一道保险。
 */
const BANDIT_SPOTS: readonly Vec2[] = [
  { x: 11, y: 2 },
  { x: 11, y: 6 },
  { x: 9, y: 3 },
  { x: 10, y: 5 },
  { x: 9, y: 5 },
  { x: 10, y: 3 },
  { x: 11, y: 3 },
  { x: 11, y: 5 },
];

/**
 * 近战敌人：斧兵和枪兵**交替**出。
 *
 * 这不是随便配的 —— 剑士用剑，克斧、被枪克。如果这里清一色放斧兵，
 * 玩家的两把剑每一下都吃满相克红利，扫出来的胜率会系统性偏高
 * （实测：同样 6 个敌人，全斧兵 96.3%，斧枪交替才是真实关卡的水平）。
 * 扫描工具必须和真实关卡用同一套阵容，否则它给的方向就是错的。
 */
function buildSpawns(meleeCount: number): UnitSpawn[] {
  const spawns: UnitSpawn[] = [...playerSpawns];
  for (let i = 0; i < meleeCount; i += 1) {
    const spot = BANDIT_SPOTS[i];
    if (!spot) throw new Error(`没有第 ${i + 1} 个近战出生点了，请扩充 BANDIT_SPOTS`);
    spawns.push({
      defId: i % 2 === 0 ? 'bandit' : 'bandit-spear',
      team: 'enemy',
      x: spot.x,
      y: spot.y,
    });
  }
  /* 贼弓手固定在最后方 */
  spawns.push({ defId: 'brigand-archer', team: 'enemy', x: 11, y: 4 });
  return spawns;
}

/**
 * 同时改两种近战兵的基础攻击力，**保持斧枪的相对关系不变**。
 * 枪兵的基础攻比斧兵高 1（5 vs 6），它们的武器威力反过来（斧 6 / 枪 4），
 * 所以两者的总攻击力是 11 和 10 —— 这个差值不能被扫描抹平，
 * 否则扫出来的绝对胜率会和 `pnpm sim` 对不上。
 */
function patchMeleeAtk(defs: readonly UnitDef[], baseAtk: number): UnitDef[] {
  return defs.map((def) => {
    if (def.id === 'bandit') return { ...def, atk: baseAtk };
    if (def.id === 'bandit-spear') return { ...def, atk: baseAtk + 1 };
    return def;
  });
}

/* ------------------------------------------------------------------ 网格 */

interface Variant {
  /** 近战敌人数量（斧枪交替），另加 1 个贼弓手 */
  melee: number;
  /** 近战敌人的**基础**攻击力；斧兵总攻 = 它 + 6，枪兵总攻 = 它 + 4 */
  baseAtk: number;
}

/* 基础攻 5 → 斧兵总攻 11、枪兵总攻 9，这是当前平衡点的基础 */
const GRID: readonly Variant[] = [
  { melee: 4, baseAtk: 5 },
  { melee: 5, baseAtk: 5 },
  { melee: 6, baseAtk: 5 },
  { melee: 5, baseAtk: 4 },
  { melee: 5, baseAtk: 6 },
  { melee: 6, baseAtk: 6 },
  { melee: 7, baseAtk: 5 },
  { melee: 8, baseAtk: 5 },
];

/* ------------------------------------------------------------------ 执行 */

interface Result {
  label: string;
  winRate: number;
  lossRate: number;
  staleRate: number;
  playerAlive: number;
  enemyAlive: number;
  turns: number;
  enemyTotal: number;
}

const rows: Result[] = [];
const startedAt = Date.now();

for (const variant of GRID) {
  const defs = patchMeleeAtk(baseDefs, variant.baseAtk);
  const spawns = buildSpawns(variant.melee);
  /* sweep 是纯粹调数值用的，不需要增援 */
  const scenario: Scenario = { map: baseScenario.map, spawns, reinforcements: [], seed: 1 };
  const enemyTotal = spawns.filter((s) => s.team === 'enemy').length;

  let won = 0;
  let lost = 0;
  let stale = 0;
  let sumPlayer = 0;
  let sumEnemy = 0;
  let sumTurns = 0;

  for (let seed = 1; seed <= rounds; seed += 1) {
    const outcome = autoBattle(
      createBattle({ ...scenario, seed }, defs, baseWeapons),
      maxTurns,
    );
    if (outcome.phase === 'won') won += 1;
    else if (outcome.phase === 'lost') lost += 1;
    else stale += 1;
    sumPlayer += outcome.playerAlive;
    sumEnemy += outcome.enemyAlive;
    sumTurns += outcome.turn;
  }

  rows.push({
    label: `${variant.melee + 1} 敌 / 基础攻 ${variant.baseAtk}`,
    winRate: won / rounds,
    lossRate: lost / rounds,
    staleRate: stale / rounds,
    playerAlive: sumPlayer / rounds,
    enemyAlive: sumEnemy / rounds,
    turns: sumTurns / rounds,
    enemyTotal,
  });
}

/* ------------------------------------------------------------------ 输出 */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(7);
const num = (v: number, digits = 2) => v.toFixed(digits).padStart(6);

console.log('');
console.log(`平衡扫描 · ${rounds} 局/组 · 回合上限 ${maxTurns} · 玩家恒为 4 人`);
console.log('─'.repeat(78));
console.log('近战敌人斧枪交替，另加 1 个贼弓手；"基础攻"不含武器威力');
console.log('看趋势，别抠绝对值 —— 这里布阵固定，和 pnpm sim 的真实关卡不完全一致');
console.log('─'.repeat(78));
console.log(
  `${'参数'.padEnd(20)}${'我方胜'.padStart(9)}${'我方负'.padStart(9)}` +
    `${'残存(我)'.padStart(11)}${'残存(敌)'.padStart(11)}${'回合'.padStart(8)}`,
);
console.log('─'.repeat(78));

for (const row of rows) {
  console.log(
    row.label.padEnd(20) +
      pct(row.winRate) +
      '  ' +
      pct(row.lossRate) +
      '  ' +
      num(row.playerAlive) +
      ' / 4' +
      '  ' +
      num(row.enemyAlive) +
      ` / ${row.enemyTotal}` +
      '  ' +
      num(row.turns, 1),
  );
}

console.log('─'.repeat(78));
console.log(`耗时 ${Date.now() - startedAt} ms`);
console.log('');
console.log('挑选原则：目标胜率 45%~60%；「零阵亡」比例过高说明敌人没有威胁。');
console.log('');
