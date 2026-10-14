import { STAT_KEYS, statsOf } from './progression';
import type { BattleState, Stats } from './types';
import { isRecord, str } from './validate';

/**
 * 战役与通关进度。
 *
 * 这一层同样是**纯数据 + 纯函数**，理由和战斗规则一样：
 *   - 进度要存进 localStorage，所以必须能 JSON 序列化
 *   - "哪一关解锁了"这种判断最容易写错，必须能单测
 *   - 存档是**外部输入**（用户能改、版本会变），解析必须逐字段校验
 */

/* ------------------------------------------------------------------ 战役 */

export interface LevelEntry {
  /** 同时是地图文件名：对应 data/maps/<id>.json */
  id: string;
  name: string;
  /** 关卡选择界面上的简介 */
  brief: string;
}

export interface Campaign {
  id: string;
  name: string;
  levels: LevelEntry[];
}

/* ------------------------------------------------------------------ 进度 */

export interface LevelResult {
  turns: number;
  survivors: number;
}

/**
 * 一个角色跨关卡保留的成长。
 *
 * 用**绝对值**而不是"相对模板的加成"：存档里写的是什么，单位就是什么，
 * 一眼看得懂，也不需要在读取时回头去查单位模板。
 * 代价是以后大改 `data/units.json` 的数值时，老存档不会跟着变 ——
 * 那时候把 `storage.ts` 里的 VERSION 加一让旧档作废就行（机制已经有了）。
 */
export interface RosterEntry {
  level: number;
  exp: number;
  stats: Stats;
}

/** 名册：key 是 `Unit.slot`（形如 `soldier#0`），不是战场实例 id */
export type Roster = Record<string, RosterEntry>;

export interface Progress {
  /** 已通关的关卡 id */
  cleared: string[];
  /** 每关的最佳战绩 */
  best: Record<string, LevelResult>;
  /** 队伍成长。跨关卡延续，这是"升级"在战役里唯一的意义所在 */
  roster: Roster;
}

export function emptyProgress(): Progress {
  return { cleared: [], best: {}, roster: {} };
}

export function isCleared(progress: Progress, levelId: string): boolean {
  return progress.cleared.includes(levelId);
}

/** 第一关永远开放；之后的每一关要求**前一关**已通关 */
export function isUnlocked(progress: Progress, campaign: Campaign, levelId: string): boolean {
  const index = campaign.levels.findIndex((level) => level.id === levelId);
  if (index < 0) return false;
  if (index === 0) return true;
  return isCleared(progress, campaign.levels[index - 1].id);
}

export function nextLevel(campaign: Campaign, levelId: string): LevelEntry | null {
  const index = campaign.levels.findIndex((level) => level.id === levelId);
  if (index < 0) return null;
  return campaign.levels[index + 1] ?? null;
}

/** 战绩比对：先看残存人数（多者优），再看见用回合（少者优） */
function isBetter(next: LevelResult, prev: LevelResult | undefined): boolean {
  if (prev === undefined) return true;
  if (next.survivors !== prev.survivors) return next.survivors > prev.survivors;
  return next.turns < prev.turns;
}

/**
 * 记录一次通关。纯函数：返回新的进度，不改原对象。
 *
 * 重打旧关卡时只保留**更好**的战绩 —— 否则玩家重打一次失误反而会把记录刷差。
 */
export function recordClear(progress: Progress, levelId: string, result: LevelResult): Progress {
  const cleared = progress.cleared.includes(levelId)
    ? progress.cleared
    : [...progress.cleared, levelId];

  const prev = progress.best[levelId];
  const best = isBetter(result, prev)
    ? { ...progress.best, [levelId]: result }
    : progress.best;

  if (cleared === progress.cleared && best === progress.best) return progress;
  return { ...progress, cleared, best };
}

/* ------------------------------------------------------------------ 名册 */

/** 从战场里把玩家的成长抽出来，合并进名册。纯函数。 */
export function exportRoster(state: BattleState, previous: Roster): Roster {
  const roster: Roster = { ...previous };
  for (const unit of state.units) {
    if (unit.team !== 'player') continue;
    roster[unit.slot] = { level: unit.level, exp: unit.exp, stats: statsOf(unit) };
  }
  return roster;
}

/**
 * 把名册套到刚造出来的战场上。
 *
 * 只影响**我方**：敌人的等级由地图里的 `level` 指定（见 UnitSpawn）。
 * 开场时 HP 补满 —— 每关从头开始，不然上一关的残血会一路滚下去。
 */
export function applyRoster(state: BattleState, roster: Roster): BattleState {
  const units = state.units.map((unit) => {
    if (unit.team !== 'player') return unit;
    const entry = roster[unit.slot];
    if (entry === undefined) return unit;

    return {
      ...unit,
      level: entry.level,
      exp: entry.exp,
      ...entry.stats,
      hp: entry.stats.maxHp,
    };
  });
  return { ...state, units };
}

/* ------------------------------------------------------------------ 解析 */

function parseLevelResult(raw: unknown): LevelResult | null {
  if (!isRecord(raw)) return null;
  const turns = raw.turns;
  const survivors = raw.survivors;
  if (typeof turns !== 'number' || !Number.isFinite(turns)) return null;
  if (typeof survivors !== 'number' || !Number.isFinite(survivors)) return null;
  return { turns, survivors };
}

function parseRosterEntry(raw: unknown): RosterEntry | null {
  if (!isRecord(raw)) return null;

  const level = raw.level;
  const exp = raw.exp;
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return null;

  /* 五项属性必须**全部**合法，缺一项就整条丢掉 ——
     半个单位的属性会让战斗公式算出 NaN，那比丢掉成长记录糟糕得多。 */
  if (!isRecord(raw.stats)) return null;
  const stats = { maxHp: 0, atk: 0, def: 0, spd: 0, skill: 0 };
  for (const key of STAT_KEYS) {
    const value = raw.stats[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    stats[key] = value;
  }

  return { level: Math.floor(level), exp: Math.floor(exp), stats };
}

/**
 * 解析存档里的进度。
 *
 * 这里刻意**宽容**而不是抛错：存档损坏时用户什么也做不了，
 * 与其崩掉不如丢掉坏的那部分继续玩。所以坏字段被静默忽略，
 * 而不是像加载地图那样严厉报错。
 */
export function parseProgress(raw: unknown): Progress {
  if (!isRecord(raw)) return emptyProgress();

  const cleared = Array.isArray(raw.cleared)
    ? raw.cleared.filter((id): id is string => typeof id === 'string')
    : [];

  const best: Record<string, LevelResult> = {};
  if (isRecord(raw.best)) {
    for (const [id, value] of Object.entries(raw.best)) {
      const result = parseLevelResult(value);
      if (result !== null) best[id] = result;
    }
  }

  const roster: Roster = {};
  if (isRecord(raw.roster)) {
    for (const [slot, value] of Object.entries(raw.roster)) {
      const entry = parseRosterEntry(value);
      if (entry !== null) roster[slot] = entry;
    }
  }

  return { cleared, best, roster };
}

/** 解析战役定义。这个是自己打包进去的内容，所以**严格**报错，方便一眼看出笔误。 */
export function parseCampaign(raw: unknown): Campaign {
  if (!isRecord(raw)) throw new Error('campaign.json 顶层必须是对象');

  const rawLevels = raw.levels;
  if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
    throw new Error('campaign.json 的 levels 必须是非空数组');
  }

  const levels = rawLevels.map((entry, i) => {
    const at = `levels[${i}]`;
    if (!isRecord(entry)) throw new Error(`${at} 必须是对象`);
    return {
      id: str(entry.id, `${at}.id`),
      name: str(entry.name, `${at}.name`),
      brief: str(entry.brief, `${at}.brief`),
    };
  });

  const seen = new Set<string>();
  for (const level of levels) {
    if (seen.has(level.id)) throw new Error(`关卡 id 重复：${level.id}`);
    seen.add(level.id);
  }

  return {
    id: str(raw.id, 'id'),
    name: str(raw.name, 'name'),
    levels,
  };
}

/** 关卡序号（从 1 开始），用于界面显示。找不到返回 0。 */
export function levelNumber(campaign: Campaign, levelId: string): number {
  return campaign.levels.findIndex((level) => level.id === levelId) + 1;
}
