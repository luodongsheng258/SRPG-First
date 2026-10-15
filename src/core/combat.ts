import { manhattan, terrainAt } from './grid';
import {
  applyRewardStats,
  awardExp,
  expFromStrike,
  hpAfterCombat,
  levelUpText,
  TP_ON_HIT,
  type CombatReward,
} from './progression';
import { rollPercent } from './rng';
import { findUnit } from './state';
import type { BattleMap, BattleState, SkillDef, Unit } from './types';
import { clamp } from './util';
import {
  attackPower,
  triangleEdge,
  triangleHit,
  triangleMight,
  type TriangleEdge,
} from './weapons';

/**
 * 战斗结算。全部公式集中在这里，对照 docs/rules.md「战斗」一节。
 *
 * 打击顺序（火纹式，共最多 4 段）：
 *   1. 攻方攻击
 *   2. 守方反击（守方存活 且 攻方在其武器射程内）
 *   3. 攻方追击（攻方速度 − 守方速度 ≥ 4，且双方都存活）
 *   4. 守方追击（守方反击成立 且 守方速度 − 攻方速度 ≥ 4，且双方都存活）
 *
 * 任意一段杀死对手后，后续段落全部取消。
 */

/** 速度差达到该值触发一次追击 */
export const DOUBLE_THRESHOLD = 4;

/** 暴击伤害倍率 */
export const CRIT_MULTIPLIER = 3;

/** 命中率基数。配合武器自带的命中（平均 +10）正好抵消原来的 70。 */
const HIT_BASE = 60;
/** 每点技巧差带来的命中修正 */
const HIT_PER_SKILL = 5;
const HIT_MIN = 5;
const HIT_MAX = 100;
const CRIT_MAX = 60;

export interface StrikeProfile {
  damage: number;
  hit: number;
  crit: number;
}

/**
 * "没有用战技"时的零修正。
 *
 * 用一个常量而不是到处判 `skill === undefined`：公式里那三行加法不用分叉，
 * 少一处分支就少一处和 `forecast` 对不上的可能。
 */
const NO_SKILL: SkillDef = { id: '', name: '', desc: '', cost: 0, might: 0, hit: 0, crit: 0 };

/**
 * **每次命中至少造成 1 点伤害。**
 *
 * 这不是调味料，是"保证战斗一定收得了场"的必需品。
 *
 * 原来的公式是 `max(0, 攻 − (防 + 地形))`，允许双方伤害**同时**为 0 ——
 * 而那是无法取胜的状态。实测到的死局（seed 245，跑了 1000 回合没结束）：
 *
 *     重骑 攻 13 → 贼首 防 10 + 要塞 3 = 13  → 伤害 0
 *     贼首 攻 15 → 重骑 防 13 + 要塞 3 = 16  → 伤害 0
 *
 * 两边都站在要塞上、都恰好被完全抵消，于是永远互相挥空。
 * 它非常罕见（2000 局里 1 局），但一旦出现就是死循环，而且**只在刀刃上**——
 * 攻防差 1 点就完全正常，所以极难靠调数值避开。
 *
 * 有了"至少 1 点"，再配合"被贴住的单位不能回血"（见 turn.ts），
 * 就**从数学上保证了任何对局最终都能分出胜负**：
 * 挨打的一方至少要掉 1 点血，而且只要还在交战就回不了血。
 *
 * 代价是所有"打不动"的局面消失了 —— 高防单位不再是不可战胜的。
 * 这是刻意的：本作没有破甲、没有背刺，如果还存在伤害为 0 的对局，
 * 玩家就只能干看着。
 */
const MIN_DAMAGE = 1;

/**
 * 单次打击的伤害、命中与暴击。
 * 地形加成取自**承受方所在格**——站在森林里防御更高、更难被打中。
 *
 * `skill` 是这一击用的战技（见 docs/rules.md 5.9）。不传就是普通攻击。
 */
export function strikeProfile(
  map: BattleMap,
  attacker: Unit,
  defender: Unit,
  skill?: SkillDef,
): StrikeProfile {
  const terrain = terrainAt(map, defender.pos);
  const edge = triangleEdge(attacker, defender);
  const bonus = skill ?? NO_SKILL;

  return {
    damage: Math.max(
      MIN_DAMAGE,
      attackPower(attacker) +
        bonus.might +
        triangleMight(edge) -
        (defender.def + terrain.defBonus),
    ),
    hit: clamp(
      HIT_BASE +
        (attacker.skill - defender.spd) * HIT_PER_SKILL +
        attacker.weapon.hit +
        bonus.hit +
        triangleHit(edge) -
        terrain.avoidBonus,
      HIT_MIN,
      HIT_MAX,
    ),
    /* 暴击**只看武器**，不掺技巧。掺技巧的话每次交战都要多掷一次骰，
       命中率的分布和随机游标的推进全乱，而且每加一次随机都会让
       「同一局面必然得出同一结果」这件事更难验证。
       战技的暴击修正是加在武器之上的 —— 它是一次性的，不改变这条性质。 */
    crit: clamp(attacker.weapon.crit + bonus.crit, 0, CRIT_MAX),
  };
}

/**
 * 攻方能否打到目标：曼哈顿距离是否落在**所持武器**的射程区间内。
 *
 * 射程随武器走而不是随职业走，所以「弓手只能打 2 格」这件事
 * 是从 `short-bow` 的 `range: [2, 2]` 推出来的，不是特判出来的。
 */
export function canReach(attacker: Unit, defender: Unit): boolean {
  const distance = manhattan(attacker.pos, defender.pos);
  const [min, max] = attacker.weapon.range;
  return distance >= min && distance <= max;
}

/**
 * 守方能否反击：射程够得着就行。
 *
 * 不需要额外的 `canCounter` 标记 —— 弓手在距离 1 打不到，
 * 于是自然就反击不了。少一个字段就少一处数据不一致。
 */
export function canCounter(attacker: Unit, defender: Unit): boolean {
  return canReach(defender, attacker);
}

export interface PlannedStrike {
  attackerId: string;
  defenderId: string;
  damage: number;
  hit: number;
  crit: number;
}

/** 构建本次战斗的完整打击序列（不考虑死亡中断，中断在结算时处理） */
export function planStrikes(
  map: BattleMap,
  attacker: Unit,
  defender: Unit,
  skill?: SkillDef,
): PlannedStrike[] {
  const make = (from: Unit, to: Unit, art?: SkillDef): PlannedStrike => {
    const profile = strikeProfile(map, from, to, art);
    return {
      attackerId: from.id,
      defenderId: to.id,
      damage: profile.damage,
      hit: profile.hit,
      crit: profile.crit,
    };
  };

  const counterOk = canCounter(attacker, defender);
  /**
   * **用战技就不能追击。**
   *
   * 这一条是设计核心而不是平衡旋钮：没有它，战技只是"花资源换伤害"，
   * 永远该用；有了它，"重击 +6 威力打一下"和"普通攻击打两下"
   * 才构成真正的取舍 —— 打高防目标前者好，打软目标后者好。
   *
   * 注意只影响**攻方**：守方的追击照旧，所以用战技也可能吃满反击。
   */
  const attackerDoubles =
    skill === undefined && attacker.spd - defender.spd >= DOUBLE_THRESHOLD;
  const defenderDoubles = defender.spd - attacker.spd >= DOUBLE_THRESHOLD;

  const out: PlannedStrike[] = [make(attacker, defender, skill)];
  if (counterOk) out.push(make(defender, attacker));
  if (attackerDoubles) out.push(make(attacker, defender));
  if (counterOk && defenderDoubles) out.push(make(defender, attacker));
  return out;
}

export interface CombatEvent {
  fromId: string;
  toId: string;
  /** 已计入暴击倍率的最终伤害；未命中时为 0 */
  damage: number;
  hit: boolean;
  crit: boolean;
  /** 承受方在这次打击之后的 HP */
  hpAfter: number;
  /** 这次打击是否直接击杀 */
  lethal: boolean;
}

export interface CombatLog {
  events: CombatEvent[];
  /** 交战结束后双方的 HP。**已含升级补的那部分**，可以直接落进 state */
  hpAfter: { attacker: number; defender: number };
  /** 推进后的随机游标 */
  cursor: number;
  attackerDoubles: boolean;
  defenderDoubles: boolean;
  /**
   * 经验与升级结算，按"攻方在前、守方在后"的固定顺序。
   *
   * 放在这里而不是另开一个函数，是因为它**消耗随机游标**：
   * 升级要掷成长骰，掷几次取决于成长表和等级。
   * 只要它和打击结算分开写，`replayCombat` 的对账就必然对不上。
   */
  rewards: CombatReward[];
}

/**
 * 纯粹的掷骰与结算：只依赖入参，不改状态、不写日志。
 *
 * ⚠️ 这个函数是**故意抽出来**的：`resolveCombat` 和表现层的战斗重放共用它。
 * 不抽的话，加一次暴击骰就会让"演出重放的打击"和"真实结算的打击"错位，
 * 而那种 bug 表现为飘字数字莫名其妙 —— 极难查。
 * 现在两边调的是同一个函数，不可能对不上。
 */
export function simulateCombat(
  map: BattleMap,
  attacker: Unit,
  defender: Unit,
  seed: number,
  cursor: number,
  skill?: SkillDef,
): CombatLog {
  const strikes = planStrikes(map, attacker, defender, skill);
  const hp = new Map<string, number>([
    [attacker.id, attacker.hp],
    [defender.id, defender.hp],
  ]);
  const events: CombatEvent[] = [];
  let current = cursor;

  for (const strike of strikes) {
    /* 任一方阵亡 → 战斗立即结束，后续段落全部取消 */
    if ((hp.get(strike.attackerId) ?? 0) <= 0) break;
    if ((hp.get(strike.defenderId) ?? 0) <= 0) break;

    const hitRoll = rollPercent(seed, current, strike.hit);
    current = hitRoll.cursor;

    const before = hp.get(strike.defenderId) ?? 0;

    if (!hitRoll.success) {
      events.push({
        fromId: strike.attackerId,
        toId: strike.defenderId,
        damage: 0,
        hit: false,
        crit: false,
        hpAfter: before,
        lethal: false,
      });
      continue;
    }

    /* 暴击骰只在"有可能暴击"时才掷。crit=0 的武器不消耗游标，
       否则每次命中都会多一次必然失败的骰子，游标推进和回放对账全被搅乱。 */
    let crit = false;
    if (strike.crit > 0) {
      const critRoll = rollPercent(seed, current, strike.crit);
      current = critRoll.cursor;
      crit = critRoll.success;
    }

    const damage = crit ? strike.damage * CRIT_MULTIPLIER : strike.damage;
    const after = Math.max(0, before - damage);
    hp.set(strike.defenderId, after);

    events.push({
      fromId: strike.attackerId,
      toId: strike.defenderId,
      damage,
      hit: true,
      crit,
      hpAfter: after,
      lethal: before > 0 && after === 0,
    });
  }

  /* ---------------- 经验与升级 ----------------
     只给**活下来**的参战方：阵亡了还给经验没有意义（升级也白升）。

     攻方先结算、守方后结算，顺序固定 —— 因为它消耗随机游标，
     顺序一变，同一个种子的后续掷骰就全变了，回放和存档都会失效。 */
  const rewards: CombatReward[] = [];
  const finalHp = new Map<string, number>([
    [attacker.id, hp.get(attacker.id) ?? attacker.hp],
    [defender.id, hp.get(defender.id) ?? defender.hp],
  ]);

  for (const [self, foe] of [
    [attacker, defender],
    [defender, attacker],
  ] as const) {
    const hpNow = finalHp.get(self.id) ?? self.hp;
    if (hpNow <= 0) continue;

    const mine = events.filter((event) => event.fromId === self.id);
    /* 守方一次都没反击过 → 没有经验。这是"弓手贴脸挨打不还手"的直接后果 */
    if (mine.length === 0) continue;

    let gained = 0;
    for (const event of mine) {
      gained += expFromStrike(self.level, foe.level, event.hit, event.lethal);
    }
    if (gained <= 0) continue;

    const award = awardExp(self, gained, seed, current);
    current = award.cursor;
    rewards.push(award.reward);

    /* 升级涨了生命上限 → 当前 HP 同步补上。
       必须在这里算完再报告 hpAfter，否则演出重放的对账会失败。 */
    finalHp.set(self.id, hpAfterCombat(self, award.reward, hpNow));
  }

  return {
    events,
    hpAfter: {
      attacker: finalHp.get(attacker.id) ?? attacker.hp,
      defender: finalHp.get(defender.id) ?? defender.hp,
    },
    cursor: current,
    attackerDoubles: attacker.spd - defender.spd >= DOUBLE_THRESHOLD,
    defenderDoubles: defender.spd - attacker.spd >= DOUBLE_THRESHOLD,
    rewards,
  };
}

export interface CombatForecast {
  distance: number;
  attacker: { damage: number; hit: number; crit: number; doubles: boolean };
  /** null 表示守方完全无法反击 */
  counter: { damage: number; hit: number; crit: number; doubles: boolean } | null;
  /** 假设双方全部命中、且**都不暴击**时的剩余 HP */
  attackerHpAfter: number;
  defenderHpAfter: number;
  attackerWillDie: boolean;
  defenderWillDie: boolean;
  /** 武器相克关系，供 UI 提示 */
  triangle: TriangleEdge;
}

/**
 * 战斗预测：用于 UI 显示和 AI 评分。
 * 语义是"如果双方全部命中、且都不出暴击会怎样"，所以是确定性的、不消耗随机数。
 * 暴击只作为概率显示，不计入伤害预期 —— 否则玩家会以为那是必然结果。
 */
export function forecast(
  map: BattleMap,
  attacker: Unit,
  defender: Unit,
  skill?: SkillDef,
): CombatForecast {
  const distance = manhattan(attacker.pos, defender.pos);
  const edge = triangleEdge(attacker, defender);
  const a = strikeProfile(map, attacker, defender, skill);
  const counterOk = canCounter(attacker, defender);
  const c = counterOk ? strikeProfile(map, defender, attacker) : null;
  /* 用战技就不能追击 —— 必须和 planStrikes 保持一致，否则预测和实际结算会不符 */
  const attackerDoubles =
    skill === undefined && attacker.spd - defender.spd >= DOUBLE_THRESHOLD;
  const defenderDoubles = defender.spd - attacker.spd >= DOUBLE_THRESHOLD;

  let dHp = defender.hp;
  let aHp = attacker.hp;

  dHp = Math.max(0, dHp - a.damage);
  if (c !== null && dHp > 0) aHp = Math.max(0, aHp - c.damage);
  if (attackerDoubles && dHp > 0 && aHp > 0) dHp = Math.max(0, dHp - a.damage);
  if (c !== null && defenderDoubles && dHp > 0 && aHp > 0) aHp = Math.max(0, aHp - c.damage);

  return {
    distance,
    attacker: { damage: a.damage, hit: a.hit, crit: a.crit, doubles: attackerDoubles },
    counter:
      c === null ? null : { damage: c.damage, hit: c.hit, crit: c.crit, doubles: defenderDoubles },
    attackerHpAfter: aHp,
    defenderHpAfter: dHp,
    attackerWillDie: aHp <= 0,
    defenderWillDie: dHp <= 0,
    triangle: edge,
  };
}

/**
 * 真正执行战斗，返回**新的 state**（纯函数，不改原对象）。
 * 会推进 rngCursor 并追加日志。
 *
 * `skill` 是这一击用的战技。**"能不能用"由 reducer 校验，TP 结账在这里做** ——
 * 因为"扣消耗"和"命中回复"必须基于**同一份战果**来算。
 * 分两处做的话，回复先被 maxTp 夹住再扣消耗，会凭空少掉几点 TP。
 */
export function resolveCombat(
  state: BattleState,
  attackerId: string,
  defenderId: string,
  skill?: SkillDef,
): BattleState {
  const attacker = findUnit(state, attackerId);
  const defender = findUnit(state, defenderId);
  if (!attacker) throw new Error(`攻击方不存在：${attackerId}`);
  if (!defender) throw new Error(`防守方不存在：${defenderId}`);
  if (attacker.team === defender.team) throw new Error('不能攻击友军');
  if (!canReach(attacker, defender)) {
    throw new Error(
      `${attacker.name} 无法攻击距离 ${manhattan(attacker.pos, defender.pos)} 的目标`,
    );
  }

  const log = simulateCombat(
    state.map,
    attacker,
    defender,
    state.rngSeed,
    state.rngCursor,
    skill,
  );

  /* 每个单位这一战命中了几次 —— 攻守双方都算，奖励的是"打中"而不是"出手" */
  const hits = new Map<string, number>();
  for (const event of log.events) {
    if (!event.hit) continue;
    hits.set(event.fromId, (hits.get(event.fromId) ?? 0) + 1);
  }

  const units = state.units.map((unit) => {
    if (unit.id !== attacker.id && unit.id !== defender.id) return unit;

    const nextHp = unit.id === attacker.id ? log.hpAfter.attacker : log.hpAfter.defender;
    const reward = log.rewards.find((entry) => entry.unitId === unit.id);

    /* applyRewardStats 不碰 HP，HP 一律取 log 里那个**已含升级补血**的值。
       这样"战后 HP"只有一个来源，演出重放才能逐字节对上。 */
    const withStats = reward === undefined ? unit : applyRewardStats(unit, reward);

    /* 只有攻方付战技的消耗 */
    const cost = unit.id === attacker.id ? (skill?.cost ?? 0) : 0;
    const nextTp = clamp(unit.tp - cost + (hits.get(unit.id) ?? 0) * TP_ON_HIT, 0, unit.maxTp);

    const patched = nextHp === withStats.hp ? withStats : { ...withStats, hp: nextHp };
    return nextTp === patched.tp ? patched : { ...patched, tp: nextTp };
  });

  const names = new Map(state.units.map((unit) => [unit.id, unit.name]));
  const lines = log.events.map((event) => {
    const fromName = names.get(event.fromId) ?? event.fromId;
    const toName = names.get(event.toId) ?? event.toId;

    if (!event.hit) return `${fromName} 攻击 ${toName} —— 未命中`;
    const suffix = event.lethal ? `，${toName} 阵亡` : `（剩余 ${event.hpAfter}）`;
    if (event.crit) return `${fromName} → ${toName} 【会心一击】${event.damage} 点伤害${suffix}`;
    return `${fromName} → ${toName} 造成 ${event.damage} 伤害${suffix}`;
  });

  /* 战技写一行在最前面 —— 不写的话玩家只看到"伤害变高了"，不知道是战技生效 */
  if (skill !== undefined) {
    lines.unshift(`${attacker.name} 发动【${skill.name}】`);
  }

  /* 升级单独写一行。经验值本身不写 —— 每次交战都刷两条会淹没战斗日志 */
  for (const reward of log.rewards) {
    for (const record of reward.levelUps) {
      lines.push(
        `${names.get(reward.unitId) ?? reward.unitId} 升到 ${record.level} 级！${levelUpText(record)}`,
      );
    }
  }

  return { ...state, units, rngCursor: log.cursor, log: [...state.log, ...lines] };
}
