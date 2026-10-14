import { computeMoveRange, findPath, simulateCombat } from '../core';
import type { Action, BattleState, Stats, Team, Unit, Vec2 } from '../core';

/**
 * 表现事件推导层 —— M2 的核心，而且**是纯函数**。
 *
 * 设计原则：`src/core/` 一行都不动。
 * 表现层只拿「动作前的状态」和「动作后的状态」做对比，反推出该演什么。
 * 因为不依赖 Phaser，这一层可以在 Node 里跑单元测试
 * —— 只有真正的绘制部分测不了。
 *
 * 为什么不直接看 HP 差值？
 *   差值只能告诉你「总共掉了多少血」，无法区分
 *   「第一下命中 + 第二下落空」和「第一下落空 + 第二下命中」。
 *   飘字和抖动的顺序会错。
 *
 * 所以战斗部分用 core 已经导出的 `planStrikes` + `rollPercent` 把这次交战
 * **逐次打击重放一遍**。重放完会拿结果和真实的 after 状态对账，
 * 对不上就返回 null 让调用方退化成只用 HP 差值
 * —— 这样表现层永远不会显示错误的数字。
 */

export type FxEvent =
  /** 沿 path 逐格行走（path[0] 是起点） */
  | { kind: 'move'; unitId: string; path: Vec2[] }
  | { kind: 'damage'; unitId: string; pos: Vec2; amount: number; lethal: boolean }
  /** 会心一击：表现上要比普通伤害更重 */
  | { kind: 'crit'; unitId: string; pos: Vec2; amount: number; lethal: boolean }
  | { kind: 'miss'; unitId: string; pos: Vec2 }
  | { kind: 'phase'; team: Team; turn: number }
  | { kind: 'outcome'; phase: 'won' | 'lost' }
  /** 获得经验：在单位头上飘一个 +N */
  | { kind: 'exp'; unitId: string; pos: Vec2; amount: number }
  /** 升级：金色大字 + 涨了哪些属性 */
  | {
      kind: 'levelup';
      unitId: string;
      pos: Vec2;
      amount: number;
      level: number;
      gains: Partial<Stats>;
    };

export type StrikeFx = Extract<FxEvent, { kind: 'damage' | 'crit' | 'miss' }>;

export interface ReplayResult {
  /** 逐次打击：命中 / 落空 / 会心 */
  strikes: StrikeFx[];
  /** 经验与升级。只含真正涨了经验的单位 */
  rewards: FxEvent[];
}

export interface Feedback {
  events: FxEvent[];
  /** 发生战斗时给出双方单位 id，供镜头聚焦与突进方向使用 */
  combat: { attackerId: string; targetId: string } | null;
}

export function isStrikeFx(event: FxEvent): event is StrikeFx {
  return event.kind === 'damage' || event.kind === 'crit' || event.kind === 'miss';
}

/* ------------------------------------------------------------------ 工具 */

function unitById(state: BattleState, id: string): Unit | undefined {
  return state.units.find((u) => u.id === id);
}

/** 用 core 的 Dijkstra 把这次移动的实际路线取出来，供逐格行走动画使用 */
function movePath(before: BattleState, unit: Unit, to: Vec2): Vec2[] {
  const range = computeMoveRange(before.map, before.units, unit);
  const path = findPath(range, to);
  if (path && path.length > 1) return path;
  return [unit.pos, to];
}

/**
 * 兜底路径：只根据 HP 差值生成伤害事件。
 * 数字一定正确，但丢失了「哪一下落空」的顺序信息。
 */
function deltaEvents(before: BattleState, after: BattleState): StrikeFx[] {
  const out: StrikeFx[] = [];
  for (const unit of after.units) {
    const prev = unitById(before, unit.id);
    if (!prev || unit.hp >= prev.hp) continue;
    out.push({
      kind: 'damage',
      unitId: unit.id,
      pos: prev.pos,
      amount: prev.hp - unit.hp,
      lethal: unit.hp <= 0,
    });
  }
  return out;
}

/**
 * 重放一次交战，逐次打击地还原「谁打中了、谁落空了、有没有会心」。
 *
 * 关键：**和 `resolveCombat` 调的是同一个 `simulateCombat`**。
 * 早先这里是照着 `resolveCombat` 的循环重写一遍，靠一个"对账"检查兜底；
 * 加入暴击骰之后那种写法必然出事（多一次掷骰、游标推进方式就变了），
 * 所以直接把结算抽成共用的纯函数 —— 两边不可能对不上。
 *
 * 对账检查保留着：它现在验证的是"传进来的 after 确实是这次战斗的结果"，
 * 而不是"我的重写有没有跟上 core"。
 *
 * @returns 对账失败时返回 null
 */
export function replayCombat(
  before: BattleState,
  after: BattleState,
  attacker: Unit,
  target: Unit,
): ReplayResult | null {
  const log = simulateCombat(before.map, attacker, target, before.rngSeed, before.rngCursor);

  const actualAttacker = unitById(after, attacker.id);
  const actualTarget = unitById(after, target.id);
  if (!actualAttacker || !actualTarget) return null;
  if (log.hpAfter.attacker !== actualAttacker.hp) return null;
  if (log.hpAfter.defender !== actualTarget.hp) return null;
  if (log.cursor !== after.rngCursor) return null;

  const strikes = log.events.map((event): StrikeFx => {
    const pos = event.toId === attacker.id ? attacker.pos : target.pos;
    if (!event.hit) return { kind: 'miss', unitId: event.toId, pos };
    return {
      kind: event.crit ? 'crit' : 'damage',
      unitId: event.toId,
      pos,
      amount: event.damage,
      lethal: event.lethal,
    };
  });

  /* 经验与升级事件。位置取自**战前**的坐标 —— 交战不改变站位。
     只报真正涨了经验的，0 经验的（比如守方一次没反击）不产生飘字。 */
  const rewards = log.rewards.map((reward): FxEvent => {
    const self = reward.unitId === attacker.id ? attacker : target;
    return {
      kind: reward.levelUps.length > 0 ? 'levelup' : 'exp',
      unitId: reward.unitId,
      pos: self.pos,
      amount: reward.expGained,
      level: reward.level,
      gains: reward.levelUps.at(-1)?.gains ?? {},
    };
  });

  return { strikes, rewards };
}

/* ------------------------------------------------------------------ 入口 */

export function buildFeedback(
  before: BattleState,
  after: BattleState,
  action: Action,
): Feedback {
  const events: FxEvent[] = [];

  /* 1. 移动：沿真实路径逐格走，不再是从起点直线补间到终点 */
  for (const unit of after.units) {
    if (unit.hp <= 0) continue;
    const prev = unitById(before, unit.id);
    if (!prev) continue;
    if (prev.pos.x === unit.pos.x && prev.pos.y === unit.pos.y) continue;
    events.push({ kind: 'move', unitId: unit.id, path: movePath(before, prev, unit.pos) });
  }

  /* 2. 战斗：优先用重放结果（带命中/落空顺序），失败则退化成 HP 差值 */
  let combat: Feedback['combat'] = null;
  let combatCovered = false;

  if (action.type === 'attack') {
    const attacker = unitById(before, action.unitId);
    const target = unitById(before, action.targetId);
    if (attacker && target) {
      combat = { attackerId: attacker.id, targetId: target.id };
      const replayed = replayCombat(before, after, attacker, target);
      if (replayed) {
        /* 先打完，再飘经验、最后升级 —— 演出的顺序就是结算的顺序 */
        events.push(...replayed.strikes, ...replayed.rewards);
        combatCovered = true;
      } else {
        /* 重放和真实结算对不上：说明 core 的结算逻辑改了而这里没跟上。
           这时候宁可不显示落空顺序，也绝不显示错误数字。 */
        console.warn('[feedback] 战斗重放对账失败，退化为 HP 差值表现');
      }
    }
  }

  if (!combatCovered) {
    events.push(...deltaEvents(before, after));
  } else if (combat) {
    /* 战斗双方的伤害已经由重放覆盖，其余单位（理论上不该有）补上 */
    const { attackerId, targetId } = combat;
    events.push(
      ...deltaEvents(before, after).filter(
        (e) => e.unitId !== attackerId && e.unitId !== targetId,
      ),
    );
  }

  /* 3. 阶段切换与胜负 */
  if (after.activeTeam !== before.activeTeam) {
    events.push({ kind: 'phase', team: after.activeTeam, turn: after.turn });
  }
  if (after.phase !== before.phase && after.phase !== 'playing') {
    events.push({ kind: 'outcome', phase: after.phase });
  }

  return { events, combat };
}
