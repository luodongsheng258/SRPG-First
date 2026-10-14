import { rollPercent } from './rng';
import type { Growths, StatKey, Stats, Unit, UnitDef } from './types';

/**
 * 经验值与升级成长。
 *
 * 为什么升级掷骰放在 core：它消耗**随机游标**，而游标是战斗结算的一部分。
 * 如果成长写在渲染层，同一个种子的两局就会走出不同的结果，
 * 模拟器、存档、回放全部失效。
 */

/** 升一级需要的经验 */
export const EXP_PER_LEVEL = 100;
/**
 * 等级上限。
 *
 * **刻意压得很低。** 本作的武器威力是固定的（铁器档 3~6），
 * 而 HP 成长有 60~80%、防御成长 25~50% —— 等级越高，伤害相对越跟不上，
 * 战斗就会被拖成消耗战。实测放到 20 级时，两个高等级单位站在要塞上
 * 互相只能造成 0~2 点伤害、命中 20%，直接打出 50 回合的僵局。
 *
 * 上限 10 让整条数值曲线保持在线性区间里。
 * 以后加了武器档位（铁/钢/银）再考虑放宽。
 */
export const MAX_LEVEL = 10;

/** 命中并造成伤害的基础经验 */
export const EXP_ON_HIT = 15;
/** 击杀的额外经验 */
export const EXP_ON_KILL = 35;
/**
 * 落空也给 1 点。
 * 火纹的传统 —— 让"这一下打不动"的局面也不至于完全白跑一趟。
 */
export const EXP_ON_MISS = 1;
/** 敌人每高一级，每次结算额外给的经验 */
export const EXP_PER_LEVEL_GAP = 5;
/**
 * 等级差带来经验的**上限**。
 *
 * 不封顶的话，等级差会变成一台失控的发电机：一场拖长的战斗里
 * 双方互相攻击几十次，每次都以"敌人比我高 19 级"结算，
 * 于是双方一路顶到满级 —— 而那又反过来让战斗更打不完。
 * 封顶到 5 级差之后，单次结算的经验上限是 15+25 = 40（击杀 75）。
 */
export const MAX_EXP_LEVEL_GAP = 5;

export const STAT_KEYS: readonly StatKey[] = ['maxHp', 'atk', 'def', 'spd', 'skill'];

export function statsOf(unit: Unit): Stats {
  return {
    maxHp: unit.maxHp,
    atk: unit.atk,
    def: unit.def,
    spd: unit.spd,
    skill: unit.skill,
  };
}

/**
 * 一次打击结算给多少经验。
 *
 * 等级差**只往上加成**：打比自己弱的敌人不会倒扣。
 * 倒扣的话玩家会不敢收残兵，而那恰恰是战棋里最正常不过的操作。
 */
export function expFromStrike(
  attackerLevel: number,
  defenderLevel: number,
  hit: boolean,
  killed: boolean,
): number {
  /* 等级差封顶 —— 见 MAX_EXP_LEVEL_GAP 的说明 */
  const gap = Math.min(
    MAX_EXP_LEVEL_GAP,
    Math.max(0, defenderLevel - attackerLevel),
  );
  const base = (hit ? EXP_ON_HIT : EXP_ON_MISS) + (killed ? EXP_ON_KILL : 0);
  return base + gap * EXP_PER_LEVEL_GAP;
}

/**
 * 等级 `level` 时的**白板**属性：模板属性 + 成长率的期望值。
 *
 * ⚠️ 这个函数是必须的，不是锦上添花。战棋里敌人的等级必须**真的更强**，
 * 否则"等级"只是个给玩家送经验的数字 —— 而且会变成**正反馈**：
 * 敌人等级越高 → 玩家吃到的等级差经验越多 → 玩家滚雪球。
 * 实测第三关的敌人挂着 3~4 级却没有任何属性加成时，
 * 胜率从 63.6% 飙到 87.3%，通关率 85% —— 整个战役失去难度。
 *
 * 用**期望值向下取整**而不是掷骰：敌人不需要"运气成长"，
 * 而且确定性的数值才好在模拟器里复现、也才好读。
 * 我方角色的成长走掷骰（有惊喜），并且由名册保存实际结果。
 */
export function statsAtLevel(def: UnitDef, level: number): Stats {
  const steps = Math.max(0, level - 1);
  const scaled = (value: number, growth: number) => value + Math.floor((growth * steps) / 100);

  return {
    maxHp: scaled(def.maxHp, def.growths.maxHp),
    atk: scaled(def.atk, def.growths.atk),
    def: scaled(def.def, def.growths.def),
    spd: scaled(def.spd, def.growths.spd),
    skill: scaled(def.skill, def.growths.skill),
  };
}

export interface LevelUpRecord {
  /** 升到几级 */
  level: number;
  /** 这一级涨了哪些属性。没涨的项不会出现在这里 */
  gains: Partial<Stats>;
}

export interface CombatReward {
  unitId: string;
  expGained: number;
  /** 连升的情况是存在的，所以是数组 */
  levelUps: LevelUpRecord[];
  level: number;
  exp: number;
  stats: Stats;
}

export interface GrowthRoll {
  gains: Partial<Stats>;
  cursor: number;
}

/**
 * 掷一次升级成长：五项各掷一次，掷中就 +1。
 *
 * 成长率为 0 的项**不掷** —— 和"暴击率为 0 时不掷暴击骰"保持同一个原则：
 * 不掷必然失败的骰子，免得白白消耗游标、也让回放对账更难读。
 */
export function rollGrowths(growths: Growths, seed: number, cursor: number): GrowthRoll {
  const gains: Partial<Stats> = {};
  let current = cursor;

  for (const key of STAT_KEYS) {
    const chance = growths[key];
    if (chance <= 0) continue;
    const result = rollPercent(seed, current, chance);
    current = result.cursor;
    if (result.success) gains[key] = 1;
  }

  return { gains, cursor: current };
}

export interface ExpAward {
  reward: CombatReward;
  cursor: number;
}

/**
 * 结算一次经验获得：累加、可能连升几级、每级各掷一次成长。
 *
 * 连升是可能的：等级差大的时候一次击杀能拿 60+ 经验，
 * 加上之前攒的余量，一次战斗连升两级并不罕见。
 */
export function awardExp(unit: Unit, gained: number, seed: number, cursor: number): ExpAward {
  const stats = statsOf(unit);
  const levelUps: LevelUpRecord[] = [];
  let level = unit.level;
  let exp = unit.exp + gained;
  let current = cursor;

  while (exp >= EXP_PER_LEVEL && level < MAX_LEVEL) {
    exp -= EXP_PER_LEVEL;
    level += 1;

    const roll = rollGrowths(unit.growths, seed, current);
    current = roll.cursor;

    for (const key of STAT_KEYS) {
      const inc = roll.gains[key];
      if (inc !== undefined) stats[key] += inc;
    }
    levelUps.push({ level, gains: roll.gains });
  }

  /* 满级之后经验不再累积，免得数字无限往上涨 */
  if (level >= MAX_LEVEL) exp = 0;

  return {
    reward: { unitId: unit.id, expGained: gained, levelUps, level, exp, stats },
    cursor: current,
  };
}

/**
 * 只落**等级、经验、属性**，不动 HP。
 *
 * HP 单独走 `hpAfterCombat` —— 因为它是"打击结果"和"升级补血"两件事的合成，
 * 而那个合成必须只写一次：结算和演出重放都要拿到**逐字节相同**的数值，
 * 否则 `replayCombat` 的对账检查会失败，飘字顺序就全乱了。
 */
export function applyRewardStats(unit: Unit, reward: CombatReward): Unit {
  return {
    ...unit,
    level: reward.level,
    exp: reward.exp,
    ...reward.stats,
  };
}

/**
 * 交战结束后的 HP。**这是唯一计算战后 HP 的地方。**
 *
 * `hpFromStrikes` 是打击结算之后的 HP。升级如果涨了生命上限，
 * 多出来的那一份**同时补进当前 HP**（火纹的传统做法）——
 * 否则"升级涨了 3 点上限但当前血没动"会让玩家觉得白涨。
 */
export function hpAfterCombat(
  unit: Unit,
  reward: CombatReward | undefined,
  hpFromStrikes: number,
): number {
  if (reward === undefined) return Math.min(unit.maxHp, hpFromStrikes);
  const hpGain = reward.stats.maxHp - unit.maxHp;
  return Math.min(reward.stats.maxHp, hpFromStrikes + hpGain);
}

/** 把"涨了什么"写成一行短文案。空的话说明五项全没涨（运气差到极点） */
export function gainsText(gains: Partial<Stats>): string {
  const parts = STAT_KEYS.filter((key) => gains[key] !== undefined).map(
    (key) => `${STAT_LABEL[key]}+1`,
  );
  return parts.length > 0 ? parts.join(' ') : '……什么都没涨';
}

/** 日志和界面共用同一份文案，免得两边显示不一样 */
export function levelUpText(record: LevelUpRecord): string {
  return gainsText(record.gains);
}

const STAT_LABEL: Record<StatKey, string> = {
  maxHp: 'HP',
  atk: '攻',
  def: '防',
  spd: '速',
  skill: '技',
};
