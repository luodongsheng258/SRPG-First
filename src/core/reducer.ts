import { canReach, resolveCombat } from './combat';
import { key, samePos } from './grid';
import { canStandAt, computeMoveRange } from './pathfind';
import { requireUnit } from './state';
import { canAct, checkVictory, endTurn, victoryText } from './turn';
import type { BattleState, SkillDef, Unit, Vec2 } from './types';

/**
 * 唯一的写入口：applyAction(state, action) -> newState
 *
 * 三条铁律（AI 改这个文件之前先读一遍）：
 *   1. 纯函数。绝不修改传入的 state，一律返回新对象。
 *   2. 非法操作直接抛错，不要静默忽略。渲染层负责在派发前保证操作合法，
 *      抛错意味着有 bug，静默吞掉只会让 bug 更难查。
 *   3. 每次成功操作后都要跑 finalize() 判胜负。
 */

export type Action =
  | { type: 'move'; unitId: string; to: Vec2 }
  /**
   * 攻击。带上 `skillId` 就是**用战技**（见 docs/rules.md 5.9）——
   * 战技不是独立的动作类型，它就是"一次带修正的攻击"。
   */
  | { type: 'attack'; unitId: string; targetId: string; skillId?: string }
  /**
   * 换武器。**不消耗行动** —— 换完还能移动和攻击（见 docs/rules.md 3.5）。
   *
   * 那为什么换武器还是一个真实的决定？因为**装备会一直保持到敌方回合**，
   * 而它决定了你能不能在对方打你时反击。所以真正的选择是
   * "我要用哪把武器迎接下一轮"，而不是"这一下用哪把打"。
   */
  | { type: 'equip'; unitId: string; weaponId: string }
  | { type: 'wait'; unitId: string }
  | { type: 'endTurn' };

export function applyAction(state: BattleState, action: Action): BattleState {
  switch (action.type) {
    case 'move':
      return applyMove(state, action);
    case 'attack':
      return applyAttack(state, action);
    case 'equip':
      return applyEquip(state, action);
    case 'wait':
      return applyWait(state, action);
    case 'endTurn':
      return applyEndTurn(state);
    default: {
      const unreachable: never = action;
      throw new Error(`未知动作：${JSON.stringify(unreachable)}`);
    }
  }
}

/** 判胜负并写日志，phase 没变就原样返回（保持引用相等，省掉无谓重渲染） */
function finalize(state: BattleState): BattleState {
  const phase = checkVictory(state);
  if (phase === state.phase) return state;
  const text =
    phase === 'won' ? victoryText(state.objective) : '✖ 我方全灭——战斗失败';
  return { ...state, phase, log: [...state.log, text] };
}

function applyMove(state: BattleState, action: Extract<Action, { type: 'move' }>): BattleState {
  const unit = requireUnit(state, action.unitId);
  if (!canAct(state, unit)) throw new Error(`${unit.name} 当前不能行动`);
  if (unit.moved) throw new Error(`${unit.name} 本回合已经移动过了`);

  const to: Vec2 = { x: action.to.x, y: action.to.y };
  const range = computeMoveRange(state.map, state.units, unit);
  if (!canStandAt(range, to)) {
    throw new Error(
      `${unit.name} 无法移动到 (${to.x}, ${to.y})：超出移动力、地形不可通行或被单位占据`,
    );
  }

  const units = state.units.map((u) =>
    u.id === unit.id ? { ...u, pos: to, moved: true } : u,
  );

  const note = samePos(to, unit.pos)
    ? `${unit.name} 原地准备行动`
    : `${unit.name} 移动到 (${to.x}, ${to.y})，消耗 ${range.costs.get(key(to))} 移动力`;

  return finalize({ ...state, units, log: [...state.log, note] });
}

function applyAttack(
  state: BattleState,
  action: Extract<Action, { type: 'attack' }>,
): BattleState {
  const attacker = requireUnit(state, action.unitId);
  const target = requireUnit(state, action.targetId);

  if (!canAct(state, attacker)) throw new Error(`${attacker.name} 当前不能行动`);
  if (target.hp <= 0) throw new Error(`目标已阵亡：${target.name}`);
  if (target.team === attacker.team) throw new Error('不能攻击友军');
  if (!canReach(attacker, target)) {
    throw new Error(`${attacker.name} 的目标不在攻击范围内`);
  }

  /* "能不能用战技"归这里校验，TP 的实际结账归 resolveCombat
     （因为它要和命中回复一起算，见那边的说明）。 */
  let skill: SkillDef | undefined;
  if (action.skillId !== undefined) {
    skill = attacker.skills.find((s) => s.id === action.skillId);
    if (!skill) {
      const has = attacker.skills.map((s) => s.id).join(' / ') || '无';
      throw new Error(`${attacker.name} 没有战技「${action.skillId}」（持有：${has}）`);
    }
    if (attacker.tp < skill.cost) {
      throw new Error(
        `${attacker.name} 的 TP 不足，用不了【${skill.name}】（${attacker.tp} / ${skill.cost}）`,
      );
    }
  }

  const afterCombat = resolveCombat(state, attacker.id, target.id, skill);
  const units = afterCombat.units.map((u) =>
    u.id === attacker.id ? { ...u, done: true, moved: true } : u,
  );

  return finalize({ ...afterCombat, units });
}

/**
 * 换武器。**不置 done / moved** —— 它是自由动作，换完照样能移动和攻击。
 *
 * 但正因为不消耗行动，它才必须在**任何时刻**都能合法执行：
 * 包括已经移动过、甚至已经打过的单位（打完还能换，用来迎接敌方回合）。
 * 唯一的限制是不能在敌方回合或战斗结束后换。
 */
function applyEquip(
  state: BattleState,
  action: Extract<Action, { type: 'equip' }>,
): BattleState {
  const unit = requireUnit(state, action.unitId);
  if (state.phase !== 'playing') throw new Error('战斗已经结束');
  if (state.activeTeam !== unit.team) throw new Error(`${unit.name} 不在自己的回合里`);
  if (unit.hp <= 0) throw new Error(`${unit.name} 已阵亡`);

  const weapon = unit.weapons.find((w) => w.id === action.weaponId);
  if (!weapon) {
    const carried = unit.weapons.map((w) => w.id).join(' / ');
    throw new Error(`${unit.name} 没有携带武器「${action.weaponId}」（携带：${carried}）`);
  }
  if (weapon.id === unit.weapon.id) {
    throw new Error(`${unit.name} 已经装备着${weapon.name}了`);
  }

  const units = state.units.map((u) =>
    u.id === unit.id ? { ...u, weapon: u.weapons.find((w) => w.id === action.weaponId) ?? u.weapon } : u,
  );

  return { ...state, units, log: [...state.log, `${unit.name} 换上${weapon.name}`] };
}

function applyWait(state: BattleState, action: Extract<Action, { type: 'wait' }>): BattleState {
  const unit = requireUnit(state, action.unitId);
  if (!canAct(state, unit)) throw new Error(`${unit.name} 当前不能行动`);

  const units = state.units.map((u) =>
    u.id === unit.id ? { ...u, done: true, moved: true } : u,
  );

  return finalize({ ...state, units, log: [...state.log, `${unit.name} 待机`] });
}

function applyEndTurn(state: BattleState): BattleState {
  if (state.phase !== 'playing') return state;
  return finalize(endTurn(state));
}

/** 该单位此刻可以打到的敌人（UI 高亮和 AI 共用同一份判定逻辑） */
export function attackableTargets(state: BattleState, unit: Unit): Unit[] {
  return state.units.filter(
    (u) => u.hp > 0 && u.team !== unit.team && canReach(unit, u),
  );
}
