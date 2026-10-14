/**
 * 全局类型定义。
 *
 * 设计约束（非常重要）：
 * 本文件中的每一个类型都必须是 **纯数据**（plain data），可以直接 JSON 序列化。
 * 不允许出现 Map / Set / class 实例 / 函数引用。
 * 这样存档、回放、联机同步、headless 批量模拟才能免费拿到。
 */

export type Team = 'player' | 'enemy';

export interface Vec2 {
  x: number;
  y: number;
}

export type TerrainKind =
  | 'plain'
  | 'road'
  | 'forest'
  | 'hill'
  | 'mountain'
  | 'water'
  | 'fort';

export interface TerrainDef {
  kind: TerrainKind;
  name: string;
  /** 进入该格消耗的移动力；null 表示不可通行 */
  moveCost: number | null;
  /** 防御加成（直接加在 def 上） */
  defBonus: number;
  /** 闪避加成（直接扣在命中率上，单位是百分点） */
  avoidBonus: number;
  /** 回合开始时站在这里回复的 HP（0 表示不回复） */
  heal: number;
  /** 渲染用颜色 0xRRGGBB */
  color: number;
}

export type UnitClass = 'infantry' | 'archer' | 'cavalier' | 'mage';

/**
 * 武器类别。决定三件事：
 *   1. 相克关系（剑 > 斧 > 枪 > 剑；弓和魔法不入环）
 *   2. 攻击距离
 *   3. 命中与暴击的倾向
 */
export type WeaponKind = 'sword' | 'axe' | 'lance' | 'bow' | 'tome';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  /** 攻击力加成。实际伤害用的是 `unit.atk + weapon.might`。 */
  might: number;
  /** 命中加成（百分点） */
  hit: number;
  /** 暴击加成（百分点） */
  crit: number;
  /** 攻击距离闭区间，用曼哈顿距离衡量 */
  range: [number, number];
}

/** 会成长的那五项属性 */
export type StatKey = 'maxHp' | 'atk' | 'def' | 'spd' | 'skill';

export type Stats = Record<StatKey, number>;

/**
 * 成长率（百分比）。
 *
 * 每次升级对这五项各掷一次骰，掷中就 +1。
 * 用百分比而不是固定值，是为了让升级有惊喜 —— 但掷骰走的是**可播种随机**，
 * 所以同一个种子下成长完全相同，模拟器和回放才站得住。
 */
export type Growths = Stats;

/** 单位模板：定义在 data/units.json 里，与战场实例无关 */
export interface UnitDef {
  id: string;
  name: string;
  unitClass: UnitClass;
  /** 初始等级 */
  level: number;
  maxHp: number;
  /** **基础**攻击力。实际伤害用的是 `atk + weapon.might`（见 docs/rules.md）。 */
  atk: number;
  def: number;
  spd: number;
  skill: number;
  mov: number;
  /** 装备的武器 id，指向 data/weapons.json */
  weaponId: string;
  /** 升级时各项涨 1 点的概率（百分比） */
  growths: Growths;
}

/** 战场上的单位实例 */
export interface Unit extends Omit<UnitDef, 'id' | 'weaponId'> {
  /** 战场实例 id，例如 "player-soldier-0" */
  id: string;
  /** 指向 UnitDef.id */
  defId: string;
  /**
   * 跨关卡保存进度用的**稳定槽位名**，形如 `soldier#0`、`archer#0`。
   *
   * 用 defId + 同兵种序号，而不是战场实例 id —— 实例 id 里含出生点下标，
   * 换一张地图就变了，那样等级就带不到下一关。
   */
  slot: string;
  team: Team;
  pos: Vec2;
  hp: number;
  /** 当前经验，达到 `EXP_PER_LEVEL` 就升级并扣除 */
  exp: number;
  /** 本回合是否已结束行动（移动或攻击后置位） */
  done: boolean;
  /** 本回合是否已消耗过移动（防止一回合内多次移动） */
  moved: boolean;
  /**
   * 装备的武器，**直接内嵌成纯数据**而不是存一个 id。
   *
   * 这样 `state` 依然是自洽的：战斗公式不需要再去查一张全局武器表，
   * 存档也不需要连带保存武器定义。代价是每个单位多几个字段，
   * 对这点数据量完全无所谓。
   */
  weapon: WeaponDef;
}

export interface BattleMap {
  id: string;
  name: string;
  width: number;
  height: number;
  /** terrain[y][x] */
  terrain: TerrainKind[][];
}

export interface UnitSpawn {
  defId: string;
  team: Team;
  x: number;
  y: number;
  /**
   * 覆盖模板的初始等级。不写就用 `UnitDef.level`。
   *
   * 有了它，"第二章的敌人比第一章强"只要在地图里写 `level: 3`，
   * 不必为每一章复制一份单位定义（那会变成数据地狱）。
   */
  level?: number;
}

/** 一个"关卡" = 地图 + 初始布阵 + 随机种子 */
export interface Scenario {
  map: BattleMap;
  spawns: UnitSpawn[];
  seed: number;
}

export type BattlePhase = 'playing' | 'won' | 'lost';

/** 整个战场状态。这就是唯一真相源，渲染层只读它。 */
export interface BattleState {
  map: BattleMap;
  units: Unit[];
  /** 回合数，从 1 开始。一个回合 = 我方阶段 + 敌方阶段 */
  turn: number;
  activeTeam: Team;
  phase: BattlePhase;
  /** 确定性随机种子 */
  rngSeed: number;
  /** 随机游标：每次掷骰 +1。存进 state 里才能保证回放一致 */
  rngCursor: number;
  log: string[];
}
