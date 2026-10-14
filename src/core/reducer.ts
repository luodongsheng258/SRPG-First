import { canReach, resolveCombat } from './combat';
import { key, samePos } from './grid';
import { canStandAt, computeMoveRange } from './pathfind';
import { requireUnit } from './state';
import { canAct, checkVictory, endTurn } from './turn';
import type { BattleState, Unit, Vec2 } from './types';

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
  | { type: 'attack'; unitId: string; targetId: string }
  | { type: 'wait'; unitId: string }
  | { type: 'endTurn' };

export function applyAction(state: BattleState, action: Action): BattleState {
  switch (action.type) {
    case 'move':
      return applyMove(state, action);
    case 'attack':
      return applyAttack(state, action);
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
    phase === 'won' ? '★ 我方胜利——敌方全灭' : '✖ 我方全灭——战斗失败';
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

  const afterCombat = resolveCombat(state, attacker.id, target.id);
  const units = afterCombat.units.map((u) =>
    u.id === attacker.id ? { ...u, done: true, moved: true } : u,
  );

  return finalize({ ...afterCombat, units });
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
