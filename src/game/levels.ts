import campaignRaw from '../../data/campaign.json';
import fort01 from '../../data/maps/fort-01.json';
import forest01 from '../../data/maps/forest-01.json';
import plain01 from '../../data/maps/plain-01.json';
import skillsRaw from '../../data/skills.json';
import unitsRaw from '../../data/units.json';
import weaponsRaw from '../../data/weapons.json';

import {
  applyRoster,
  createBattle,
  parseCampaign,
  parseScenario,
  parseSkillDefs,
  parseUnitDefs,
  parseWeaponDefs,
  type BattleState,
  type Campaign,
  type LevelEntry,
  type Roster,
  type Scenario,
  type SkillDef,
  type UnitDef,
  type WeaponDef,
} from '../core';

/**
 * 关卡注册表。
 *
 * 这里刻意用**显式静态 import**，而不是 Vite 的 `import.meta.glob`：
 * glob 是打包器专有的，`tsx` 跑 `scripts/` 时它根本不存在，
 * 而 `pnpm sim` 必须能加载关卡数据来跑数值模拟。
 *
 * 代价是加一张地图要多写一行 import，换来的是**任何工具链都能加载关卡**
 * —— 这个交换很划算。地图多到几十张时再换成按需加载。
 */
const RAW_MAPS: Record<string, unknown> = {
  'plain-01': plain01,
  'forest-01': forest01,
  'fort-01': fort01,
};

export interface LoadedLevel {
  entry: LevelEntry;
  scenario: Scenario;
  /** 关卡在战役里的序号，从 1 开始 */
  number: number;
}

/**
 * 为什么用类：构造函数里要**一次性把战役和地图全部解析并交叉校验**。
 * 放在模块顶层执行，任何笔误（登记了不存在的地图、地图行数列数不对）
 * 都会在启动时立刻炸出来，而不是等玩家点到那一关才发现。
 */
class LevelRegistry {
  readonly campaign: Campaign;
  readonly defs: UnitDef[];
  readonly weapons: WeaponDef[];
  readonly skills: SkillDef[];

  private readonly byId = new Map<string, LoadedLevel>();

  constructor() {
    this.campaign = parseCampaign(campaignRaw);
    this.defs = parseUnitDefs(unitsRaw);
    this.weapons = parseWeaponDefs(weaponsRaw);
    this.skills = parseSkillDefs(skillsRaw);

    this.campaign.levels.forEach((entry, index) => {
      const raw = RAW_MAPS[entry.id];
      if (raw === undefined) {
        const available = Object.keys(RAW_MAPS).sort().join(', ');
        throw new Error(
          `关卡「${entry.name}」（id=${entry.id}）需要 data/maps/${entry.id}.json，` +
            `但 src/game/levels.ts 的 RAW_MAPS 里没有登记。已登记：${available}`,
        );
      }
      this.byId.set(entry.id, {
        entry,
        scenario: parseScenario(raw),
        number: index + 1,
      });
    });

    /* 反向检查：登记了却不在战役里的地图，多半是漏了 campaign.json 一条 */
    for (const id of Object.keys(RAW_MAPS)) {
      if (!this.byId.has(id)) {
        console.warn(`[levels] 地图 ${id} 已登记但不在 campaign.json 的关卡列表里`);
      }
    }
  }

  list(): LoadedLevel[] {
    return this.campaign.levels.map((entry) => this.require(entry.id));
  }

  has(levelId: string): boolean {
    return this.byId.has(levelId);
  }

  find(levelId: string): LoadedLevel | null {
    return this.byId.get(levelId) ?? null;
  }

  require(levelId: string): LoadedLevel {
    const level = this.byId.get(levelId);
    if (level === undefined) throw new Error(`未知关卡：${levelId}`);
    return level;
  }

  /** 开一局新的战斗。不传种子就用地图里写死的那个（可复现，模拟器用得上）。 */
  create(levelId: string, seed?: number, roster?: Roster): BattleState {
    const { scenario } = this.require(levelId);
    const state = createBattle(
      seed === undefined ? scenario : { ...scenario, seed },
      this.defs,
      this.weapons,
      this.skills,
    );
    /* 名册只影响我方；敌人的等级由地图里的 spawn.level 指定 */
    return roster === undefined ? state : applyRoster(state, roster);
  }
}

export const LEVELS = new LevelRegistry();
