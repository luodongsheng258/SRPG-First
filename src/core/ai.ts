import { canReach, forecast } from './combat';
import { key, manhattan, samePos } from './grid';
import { computeMoveRange, reachableTiles, terrainDistanceField } from './pathfind';
import { applyAction } from './reducer';
import type { Action } from './reducer';
import { livingUnitsOf } from './state';
import type { BattleMap, BattleState, Team, Unit, Vec2 } from './types';
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

interface AttackChoice {
  dest: Vec2;
  target: Unit;
  score: number;
}

function scoreAttack(map: BattleMap, attackerAtDest: Unit, foe: Unit): number {
  const f = forecast(map, attackerAtDest, foe);

  let score = f.attacker.damage * W_DAMAGE;
  if (f.defenderWillDie) score += W_KILL;
  if (f.counter !== null) score -= f.counter.damage * W_TAKEN;
  if (f.attackerWillDie) score -= W_DEATH;
  score += (foe.maxHp - foe.hp) * W_WOUND;
  score -= manhattan(attackerAtDest.pos, foe.pos) * W_APPROACH;

  return score;
}

/** 打不动还会被反杀 —— 这种交换毫无意义，不如先去推进 */
function isPointless(state: BattleState, unit: Unit, choice: AttackChoice): boolean {
  const sim: Unit = { ...unit, pos: { x: choice.dest.x, y: choice.dest.y } };
  const f = forecast(state.map, sim, choice.target);
  return f.attackerWillDie && !f.defenderWillDie;
}

/** 在给定的候选落点里，找到最优的"站在哪打谁" */
function bestAttack(state: BattleState, unit: Unit, candidates: readonly Vec2[]): AttackChoice | null {
  const foes = livingUnitsOf(state, opponent(unit.team));
  let best: AttackChoice | null = null;

  for (const dest of candidates) {
    const sim: Unit = { ...unit, pos: { x: dest.x, y: dest.y } };
    for (const foe of foes) {
      if (!canReach(sim, foe)) continue;
      const score = scoreAttack(state.map, sim, foe);
      if (best === null || score > best.score) best = { dest, target: foe, score };
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
 */
export function decideUnitAction(state: BattleState, unit: Unit): Action {
  if (unit.done) return { type: 'wait', unitId: unit.id };

  const foes = livingUnitsOf(state, opponent(unit.team));
  if (foes.length === 0) return { type: 'wait', unitId: unit.id };

  /* 已经移动过 → 只能在原地二选一；否则枚举整个移动范围 */
  const candidates: Vec2[] = unit.moved
    ? [unit.pos]
    : reachableTiles(computeMoveRange(state.map, state.units, unit));

  const choice = bestAttack(state, unit, candidates);

  if (choice !== null && !isPointless(state, unit, choice)) {
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
  /* 一个单位最多花 4 步（move / attack / wait / 意外），加 8 的冗余足够 */
  const guard = state.units.length * 4 + 8;

  for (let i = 0; i < guard; i += 1) {
    if (cur.phase !== 'playing' || cur.activeTeam !== team) return actions;

    const pending = livingUnitsOf(cur, team).filter((u) => !u.done);
    if (pending.length === 0) break;

    const action = decideUnitAction(cur, pending[0]);
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
