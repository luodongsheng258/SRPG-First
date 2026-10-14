import { canReach, DOUBLE_THRESHOLD, forecast } from './combat';
import { key, manhattan, samePos } from './grid';
import { attackPower, triangleEdge, triangleMight } from './weapons';
import { computeMoveRange, reachableTiles, terrainDistanceField } from './pathfind';
import { applyAction } from './reducer';
import type { Action } from './reducer';
import { livingUnitsOf } from './state';
import type { BattleMap, BattleState, Team, Unit, Vec2, WeaponDef } from './types';
import { opponent } from './util';

/**
 * 敌方 AI —— 贪心 + 权重打分。
 *
 * ⚠️ 不要一上来就写极小化极大 / 博弈树。
 * 战棋的搜索空间是"每个单位 × 每个落点 × 每个目标"，棋盘子节点数量爆炸，
 * 而且玩家根本感觉不到区别。贪心 + 调权重能做出 90% 的体验。
 *
 * 算法的本质：把"一个单位的行动"枚举成一个候选集，逐个打分取最高。
 * 将来要升级，只需要替换 scoreAttack 这一个函数。
 *
 * 权重全部集中在下面这一段，调数值不要改结构。
 */

/** 造成伤害的权重 */
const W_DAMAGE = 10;
/** 击杀奖励 */
const W_KILL = 1000;
/** 被反击伤害的权重 */
const W_TAKEN = 8;
/** 自己阵亡的惩罚 */
const W_DEATH = 2000;
/** 补刀残血的奖励（每点已损失 HP） */
const W_WOUND = 2;
/** 贴脸的轻微偏好，避免双方互相僵持 */
const W_APPROACH = 1;

/**
 * 打"全队集火目标"的额外加分。
 *
 * 量级是刻意选的：60 ≈ 6 点伤害，也就是**愿意多挨 6 点左右的反击/多跑一点路**
 * 去和大家打同一个目标，但绝不会为此去送死（`W_DEATH` 是 −2000，
 * 且选完还有 `isPointless` 兜底）。
 */
const W_FOCUS = 60;
/** 集火目标评选：能被打死的优先 —— 一次确定的击杀比分散蹭血值钱得多 */
const W_FOCUS_KILL = 500;
/** 集火目标评选：已经受伤的优先（补刀比开新战线划算） */
const W_FOCUS_WOUND = 3;
/** 集火目标评选：打得疼的优先（先解决威胁大的） */
const W_FOCUS_THREAT = 4;

interface AttackChoice {
  dest: Vec2;
  target: Unit;
  /** 用哪把武器打。和当前装备不同时，`decideUnitAction` 会先派一个 equip */
  weapon: WeaponDef;
  score: number;
}

/**
 * 粗略估计"这个单位这回合大概能对那个敌人造成多少伤害"。
 *
 * ⚠️ 刻意**不跑移动范围** —— 那是一次 Dijkstra，而这里要在
 * 「我方单位 × 敌人」的组合上反复调用（而且每个单位行动前都要重算一遍）。
 * 用 `mov + 射程` 的曼哈顿距离近似可达性、伤害不算地形和命中：
 * **选集火目标不需要精确，只需要排出相对顺序。**
 */
function roughDamage(unit: Unit, foe: Unit): number {
  if (unit.hp <= 0) return 0;
  if (manhattan(unit.pos, foe.pos) > unit.mov + unit.weapon.range[1]) return 0;

  const edge = triangleEdge(unit, foe);
  const perHit = Math.max(1, attackPower(unit) + triangleMight(edge) - foe.def);
  const hits = unit.spd - foe.spd >= DOUBLE_THRESHOLD ? 2 : 1;
  return perHit * hits;
}

/**
 * 选出全队本回合的**集火目标**。
 *
 * 为什么需要它：原本每个单位独立打分，于是五个敌人各打各的 ——
 * 每人蹭掉你 6 点血，一轮下来谁都没死。玩家感受到的是"敌人不痛不痒"。
 * 有了共同目标之后，它们会把伤害叠在同一个人身上，**逼你认真保护后排**。
 *
 * 判据（按优先级）：
 *   1. 全队这回合能合起来打死的 → 优先（一次确定的击杀是最大的收益）
 *   2. 已经受伤的 → 优先（补刀比开新战线划算）
 *   3. 攻击力高的 → 优先（先解决威胁大的）
 *
 * 够不着的敌人直接排除（全队对它总伤害为 0）——
 * 否则"远处那个头目攻击力最高"会把全队往错误的方向引。
 */
export function pickFocusTarget(state: BattleState, team: Team): Unit | null {
  const mine = livingUnitsOf(state, team).filter((unit) => !unit.done);
  if (mine.length === 0) return null;

  let best: Unit | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  /* 顺序取自 units 数组 → 完全确定，平局时永远选同一个 */
  for (const foe of livingUnitsOf(state, opponent(team))) {
    let total = 0;
    for (const unit of mine) total += roughDamage(unit, foe);
    if (total <= 0) continue;

    const score =
      (total >= foe.hp ? W_FOCUS_KILL : 0) +
      (foe.maxHp - foe.hp) * W_FOCUS_WOUND +
      attackPower(foe) * W_FOCUS_THREAT;

    if (score > bestScore) {
      bestScore = score;
      best = foe;
    }
  }

  return best;
}

function scoreAttack(
  map: BattleMap,
  attackerAtDest: Unit,
  foe: Unit,
  focusId: string | null,
): number {
  const f = forecast(map, attackerAtDest, foe);

  let score = f.attacker.damage * W_DAMAGE;
  if (f.defenderWillDie) score += W_KILL;
  if (f.counter !== null) score -= f.counter.damage * W_TAKEN;
  if (f.attackerWillDie) score -= W_DEATH;
  score += (foe.maxHp - foe.hp) * W_WOUND;
  score -= manhattan(attackerAtDest.pos, foe.pos) * W_APPROACH;
  /* 集火：全队咬住同一个目标，才咬得死 */
  if (focusId !== null && foe.id === focusId) score += W_FOCUS;

  return score;
}

/** 打不动还会被反杀 —— 这种交换毫无意义，不如先去推进 */
function isPointless(state: BattleState, unit: Unit, choice: AttackChoice): boolean {
  const sim: Unit = { ...unit, pos: { x: choice.dest.x, y: choice.dest.y }, weapon: choice.weapon };
  const f = forecast(state.map, sim, choice.target);
  return f.attackerWillDie && !f.defenderWillDie;
}

/**
 * 在给定的候选落点里，找到最优的"站在哪、用哪把武器、打谁"。
 *
 * 武器也进搜索空间 —— 这样 AI 自动会用上射程（用手斧在 2 格外白嫖）
 * 和相克（换一把克制的武器再打），不需要为它们各写一段专门的逻辑。
 */
function bestAttack(
  state: BattleState,
  unit: Unit,
  candidates: readonly Vec2[],
  focusId: string | null,
): AttackChoice | null {
  const foes = livingUnitsOf(state, opponent(unit.team));

  /* 当前装备排在第一 —— 分数相同时它会赢，免得为了一模一样的效果白换一次武器 */
  const loadout = [
    unit.weapon,
    ...unit.weapons.filter((w) => w.id !== unit.weapon.id),
  ];

  let best: AttackChoice | null = null;

  for (const dest of candidates) {
    for (const weapon of loadout) {
      const sim: Unit = { ...unit, pos: { x: dest.x, y: dest.y }, weapon };
      for (const foe of foes) {
        if (!canReach(sim, foe)) continue;
        const score = scoreAttack(state.map, sim, foe, focusId);
        if (best === null || score > best.score) best = { dest, target: foe, weapon, score };
      }
    }
  }

  return best;
}

/**
 * 打不到人时：朝最近的敌人推进。已经在最近位置就待机。
 *
 * ⚠️ "最近"必须按**地形距离**算，不能按曼哈顿距离。
 * 隔着一条湖时直线距离是 2、实际绕行要 7 步，用直线距离的话
 * AI 会认为当前格已经是最优解，于是原地待机到天荒地老。
 */
function planAdvance(state: BattleState, unit: Unit): Action {
  const foes = livingUnitsOf(state, opponent(unit.team));
  if (foes.length === 0) return { type: 'wait', unitId: unit.id };

  const range = computeMoveRange(state.map, state.units, unit);
  const field = terrainDistanceField(
    state.map,
    foes.map((foe) => foe.pos),
  );

  /* 用当前格作为初始最优 —— 于是"没有更近的落点"就自然表现为原地待机 */
  let bestTile: Vec2 = unit.pos;
  let bestDist = field.get(key(unit.pos)) ?? Number.POSITIVE_INFINITY;

  /* reachableTiles 已经排过序，配合严格小于 → 平局时的选择是确定的 */
  for (const tile of reachableTiles(range)) {
    const d = field.get(key(tile)) ?? Number.POSITIVE_INFINITY;
    if (d < bestDist) {
      bestDist = d;
      bestTile = tile;
    }
  }

  if (samePos(bestTile, unit.pos)) return { type: 'wait', unitId: unit.id };
  return { type: 'move', unitId: unit.id, to: bestTile };
}

/**
 * 决定单个单位本回合的下一步动作。
 * 返回 move 时表示"路已经走到位，但还没结束行动"，调用方需要再问一次。
 *
 * `focusId` 是全队的集火目标（见 `pickFocusTarget`）。传 null 就退化成
 * 纯个体贪心 —— 单测里用这个来对照"有集火"和"没集火"的区别。
 */
export function decideUnitAction(
  state: BattleState,
  unit: Unit,
  focusId: string | null = null,
): Action {
  if (unit.done) return { type: 'wait', unitId: unit.id };

  const foes = livingUnitsOf(state, opponent(unit.team));
  if (foes.length === 0) return { type: 'wait', unitId: unit.id };

  /* 已经移动过 → 只能在原地二选一；否则枚举整个移动范围 */
  const candidates: Vec2[] = unit.moved
    ? [unit.pos]
    : reachableTiles(computeMoveRange(state.map, state.units, unit));

  const choice = bestAttack(state, unit, candidates, focusId);

  if (choice !== null && !isPointless(state, unit, choice)) {
    /* 顺序固定：先换武器 → 再走位 → 最后出手。
       换武器是自由动作（不消耗行动），所以可以插在最前面。 */
    if (choice.weapon.id !== unit.weapon.id) {
      return { type: 'equip', unitId: unit.id, weaponId: choice.weapon.id };
    }
    if (!samePos(choice.dest, unit.pos)) {
      return { type: 'move', unitId: unit.id, to: choice.dest };
    }
    return { type: 'attack', unitId: unit.id, targetId: choice.target.id };
  }

  if (unit.moved) return { type: 'wait', unitId: unit.id };
  return planAdvance(state, unit);
}

/**
 * 规划一整轮（一个阶段）的行动序列，末尾一定带 endTurn。
 * 战斗提前结束时直接返回，不追加 endTurn。
 */
export function planTurn(state: BattleState, team: Team = state.activeTeam): Action[] {
  const actions: Action[] = [];
  let cur = state;
  /* 一个单位最多花 5 步（equip / move / attack / wait / 意外），加 8 的冗余足够 */
  const guard = state.units.length * 5 + 8;

  for (let i = 0; i < guard; i += 1) {
    if (cur.phase !== 'playing' || cur.activeTeam !== team) return actions;

    const pending = livingUnitsOf(cur, team).filter((u) => !u.done);
    if (pending.length === 0) break;

    const unit = pending[0];
    /* 每个单位行动前**重算一次**集火目标：敌人掉血、阵亡都会改变最优解，
       而选目标本身很便宜（粗略估算，不算移动范围）。 */
    const focus = pickFocusTarget(cur, team);
    const action = decideUnitAction(cur, unit, focus?.id ?? null);
    actions.push(action);
    cur = applyAction(cur, action);
  }

  actions.push({ type: 'endTurn' });
  return actions;
}

/** 执行一整轮 AI，返回新状态 */
export function runTurn(state: BattleState, team: Team = state.activeTeam): BattleState {
  let cur = state;
  for (const action of planTurn(state, team)) cur = applyAction(cur, action);
  return cur;
}
