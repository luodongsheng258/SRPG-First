import { key, terrainAt } from './grid';
import { computeZoc } from './pathfind';
import { arriveReinforcements } from './reinforce';
import { livingUnitsOf } from './state';
import type { BattlePhase, BattleState, Objective, Team, Unit } from './types';
import { opponent, teamLabel } from './util';

/**
 * 回合系统。
 *
 * 回合结构（火纹式两段制）：
 *   第 N 回合 = 我方阶段 → 敌方阶段 → 第 N+1 回合
 * `state.turn` 只在"敌方阶段结束、切回我方"时 +1。
 */

/**
 * 判定胜负（见 docs/rules.md 7）。
 *
 * **"全灭敌人"是所有关卡的兜底胜利条件** —— 打得比目标更彻底，没理由不算赢。
 * 于是 `objective` 实际上描述的是"除了全灭之外，还能怎么赢"。
 *
 * 判定优先级：先看我方是否全灭，再看胜利条件。
 * （两边同时归零时算赢 —— 这是原本的行为，保持不变。）
 */
export function checkVictory(state: BattleState): BattlePhase {
  if (livingUnitsOf(state, 'enemy').length === 0) return 'won';
  if (livingUnitsOf(state, 'player').length === 0) return 'lost';

  const objective = state.objective;

  if (objective.kind === 'survive' && state.turn > objective.turns) return 'won';

  if (objective.kind === 'defeat') {
    /* 语义是"场上不再有这个兵种" —— 而不是"打死了某一个" */
    const alive = livingUnitsOf(state, 'enemy').some((u) => u.defId === objective.defId);
    if (!alive) return 'won';
  }

  return 'playing';
}

/** 结算面板上的胜利文案。按本关的目标来写，玩家才知道自己是怎么赢的 */
export function victoryText(objective: Objective): string {
  switch (objective.kind) {
    case 'defeat':
      return '★ 我方胜利——敌将已被击破';
    case 'survive':
      return '★ 我方胜利——守住了阵地';
    case 'rout':
      return '★ 我方胜利——敌方全灭';
  }
}

/** 关卡目标的短描述，给侧边栏和关卡选择用 */
export function objectiveText(objective: Objective): string {
  switch (objective.kind) {
    case 'defeat':
      return '击破敌将';
    case 'survive':
      return `守住 ${objective.turns} 回合`;
    case 'rout':
      return '全灭敌人';
  }
}

/** 该单位此刻是否还能接受指令 */
export function canAct(state: BattleState, unit: Unit): boolean {
  return (
    state.phase === 'playing' &&
    unit.hp > 0 &&
    unit.team === state.activeTeam &&
    !unit.done
  );
}

/** 当前阶段还没行动的单位 */
export function pendingUnits(state: BattleState, team: Team = state.activeTeam): Unit[] {
  return livingUnitsOf(state, team).filter((u) => !u.done);
}

/**
 * 结束当前阶段，切换到对方：重置其行动标记，并结算地形回复。
 * 注意只处理**即将行动的一方**：当前方的 done 标记留到下一轮它自己开始时再清。
 */
export function endTurn(state: BattleState): BattleState {
  if (state.phase !== 'playing') return state;

  const next = opponent(state.activeTeam);
  const turn = state.activeTeam === 'enemy' ? state.turn + 1 : state.turn;

  const header = `—— 第 ${turn} 回合 · ${teamLabel(next)}阶段 ——`;

  /**
   * 先让增援落地，再走回复。
   *
   * 顺序有讲究：`arriveReinforcements` 只负责把单位放进 `units`，
   * 而下面那段回复顺带统一重置 `done` / `moved` —— 增援单位正好一起被处理，
   * 不会出现"新来的兵 done 是脏值"这种问题。
   *
   * 增援的日志行要单独取出来（`arrived.log` 比 `state.log` 多出来的部分），
   * 因为最终日志的拼接基准是 `state.log` —— 直接拼接会把它们丢掉。
   */
  const arrived = arriveReinforcements(state, turn);
  const arrivalNotes = arrived.log.slice(state.log.length);

  /**
   * **被敌人贴住的单位不能回复。**
   *
   * 这条规则不是调味料，是防僵局的必需品：要塞同时给了 防 +3、闪避 +30、回血，
   * 三者叠加会让防守方在数学上不可杀死 ——
   * 实测重骑（枪，被斧克）打站在要塞上的山贼：伤害 5、命中仅 30%，
   * 期望每回合约 1.5 点，而对方回血 2 点。**回血比伤害还快**，
   * 于是第三关出现 1.3% 永远打不完的对局。
   *
   * 判据直接复用"是否处于敌方控制区" —— 「被贴住」和「在敌人相邻格」定义完全一致，
   * 没必要再造一个概念。
   */
  const engagedZoc = computeZoc(arrived.map, arrived.units, opponent(next));

  const healLines: string[] = [];

  const units = arrived.units.map((unit) => {
    if (unit.team !== next) return unit;

    const terrain = terrainAt(arrived.map, unit.pos);
    if (terrain.heal <= 0) {
      return { ...unit, done: false, moved: false };
    }

    if (engagedZoc.has(key(unit.pos))) {
      healLines.push(`${unit.name} 正与敌人交战，无法在${terrain.name}回复`);
      return { ...unit, done: false, moved: false };
    }

    const amount = Math.min(terrain.heal, unit.maxHp - unit.hp);
    if (amount > 0) {
      healLines.push(
        `${unit.name} 在${terrain.name}回复 ${amount} HP（${unit.hp + amount}/${unit.maxHp}）`,
      );
    }

    return { ...unit, done: false, moved: false, hp: unit.hp + amount };
  });

  return {
    ...arrived,
    units,
    activeTeam: next,
    turn,
    /* 顺序：回合标题 → 增援到场 → 地形回复。标题在最前面，读者才知道这是新回合 */
    log: [...state.log, header, ...arrivalNotes, ...healLines],
  };
}
