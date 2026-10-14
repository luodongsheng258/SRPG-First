import { planTurn } from './ai';
import { applyAction } from './reducer';
import { aliveCount } from './state';
import type { BattlePhase, BattleState } from './types';

/**
 * Headless 批量模拟。
 *
 * 这是"逻辑与渲染分离"最大的红利：不启动引擎、不开窗口，
 * 一秒钟能跑成百上千局，用来调数值平衡。
 *
 * 用法见 scripts/simulate.ts。
 */

export interface BattleOutcome {
  phase: BattlePhase;
  turn: number;
  actions: number;
  playerAlive: number;
  enemyAlive: number;
  /**
   * 终局仍存活的单位 id（沿用初始 units 的顺序）。
   *
   * 只报"谁赢了"信息量太小 —— 赢下来剩 4 个人和剩 1 个人是完全不同的平衡状态。
   * 调数值时真正要看的是「各兵种的存活率」和「残存兵力」。
   */
  survivors: string[];
}

/** 让 AI 同时接管双方，自动打完整局（或打到 maxTurns 判为僵局） */
export function autoBattle(state: BattleState, maxTurns = 60): BattleOutcome {
  let cur = state;
  let actions = 0;

  while (cur.phase === 'playing' && cur.turn <= maxTurns) {
    for (const action of planTurn(cur, cur.activeTeam)) {
      cur = applyAction(cur, action);
      actions += 1;
      if (cur.phase !== 'playing') break;
    }
  }

  return {
    phase: cur.phase,
    turn: cur.turn,
    actions,
    playerAlive: aliveCount(cur, 'player'),
    enemyAlive: aliveCount(cur, 'enemy'),
    survivors: cur.units.filter((u) => u.hp > 0).map((u) => u.id),
  };
}
