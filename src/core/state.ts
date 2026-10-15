import { TERRAIN } from './terrain';
import { MAX_TP, statsAtLevel } from './progression';
import type {
  BattleMap,
  BattleState,
  Loadout,
  PendingReinforcement,
  Scenario,
  SkillDef,
  Team,
  Unit,
  UnitBlueprint,
  UnitDef,
  Vec2,
  WeaponDef,
} from './types';
import { teamLabel } from './util';

/**
 * 状态构造与查询。
 *
 * 这一层只做两件事：
 *   1. 从配置（units.json + 地图 json）造出初始 BattleState
 *   2. 提供只读查询
 * 所有"会改变状态"的操作都必须走 reducer.ts。
 */

/** 复制一把武器。`range` 是数组，状态里不许出现跨单位共享的可变引用 */
function copyWeapon(weapon: WeaponDef): WeaponDef {
  return { ...weapon, range: [weapon.range[0], weapon.range[1]] };
}

interface UnitRecipe {
  def: UnitDef;
  loadout: Loadout;
}

/**
 * `defId` → 模板 + 武器/战技定义。
 *
 * 开局布阵和增援都要用，所以独立出来 —— 两处各写一遍迟早会不一致，
 * 而"引用了不存在的武器/战技"这种错在加载期就该报出来。
 */
export function resolveRecipe(
  defs: ReadonlyMap<string, UnitDef>,
  weaponMap: ReadonlyMap<string, WeaponDef>,
  skillMap: ReadonlyMap<string, SkillDef>,
  defId: string,
): UnitRecipe {
  const def = defs.get(defId);
  if (!def) throw new Error(`未知单位模板：${defId}`);

  const weapons = def.weaponIds.map((id) => {
    const weapon = weaponMap.get(id);
    if (!weapon) throw new Error(`单位「${def.name}」携带了不存在的武器：${id}`);
    return weapon;
  });
  if (weapons.length === 0) throw new Error(`单位「${def.name}」至少要携带一把武器`);

  const skills = def.skillIds.map((id) => {
    const skill = skillMap.get(id);
    if (!skill) throw new Error(`单位「${def.name}」携带了不存在的战技：${id}`);
    return skill;
  });

  return { def, loadout: { weapons, skills } };
}

/**
 * 造一个**还没有身份**的单位（见 `UnitBlueprint`）。
 *
 * `createUnitInstance` 和增援都走这条路，保证"属性怎么算"只有一份实现。
 */
export function createBlueprint(
  def: UnitDef,
  loadout: Loadout,
  team: Team,
  level: number,
): UnitBlueprint {
  /* 等级带属性：不这么做的话"等级"只是个送经验的数字，
     而且会变成正反馈（见 statsAtLevel 的说明）。
     我方角色稍后会被名册覆盖成实际成长值，这里算的是"白板"。 */
  const stats = statsAtLevel(def, level);

  const carried = loadout.weapons.map(copyWeapon);
  const first = carried[0];
  if (first === undefined) throw new Error(`单位「${def.name}」没有携带任何武器`);

  return {
    /* 先铺模板，再覆盖实例字段。顺序不能颠倒。 */
    ...def,
    ...stats,
    /* 默认装备第一把。`weapon` 和 `weapons[0]` 指向同一个对象是刻意的 ——
       切武器就是把 `weapon` 换成 `weapons` 里的另一把。 */
    weapon: first,
    weapons: carried,
    skills: [...loadout.skills],
    /* TP 每关从 0 开始（不进名册，见 Unit.tp 的说明） */
    tp: 0,
    maxTp: MAX_TP,
    defId: def.id,
    team,
    hp: stats.maxHp,
    exp: 0,
    level,
    done: false,
    moved: false,
  };
}

export function createUnitInstance(
  def: UnitDef,
  loadout: Loadout,
  team: Team,
  pos: Vec2,
  index: number,
  slot: string,
  level: number = def.level,
): Unit {
  return {
    ...createBlueprint(def, loadout, team, level),
    id: `${team}-${def.id}-${index}`,
    slot,
    pos: { x: pos.x, y: pos.y },
  };
}

/** 校验出生点：越界、重叠、落在水里，全部在开局前就抛错 */
function assertSpawnable(map: BattleMap, spawn: UnitSpawnLike): void {
  const { x, y, defId } = spawn;
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
    throw new Error(`出生点越界：${defId} @ (${x}, ${y})`);
  }
  const terrain = TERRAIN[map.terrain[y][x]];
  if (terrain.moveCost === null) {
    throw new Error(`出生点位于不可通行地形（${terrain.name}）：${defId} @ (${x}, ${y})`);
  }
}

interface UnitSpawnLike {
  defId: string;
  x: number;
  y: number;
}

export function createBattle(
  scenario: Scenario,
  defs: readonly UnitDef[],
  weapons: readonly WeaponDef[],
  skills: readonly SkillDef[] = [],
): BattleState {
  const defMap = new Map(defs.map((d) => [d.id, d]));
  const weaponMap = new Map(weapons.map((w) => [w.id, w]));
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  const units: Unit[] = [];
  const occupied = new Set<string>();
  /* 同一个兵种出现的第几次。用来生成跨关卡稳定的槽位名 */
  const ordinal = new Map<string, number>();

  scenario.spawns.forEach((spawn, index) => {
    const { def, loadout } = resolveRecipe(defMap, weaponMap, skillMap, spawn.defId);

    assertSpawnable(scenario.map, spawn);

    const k = `${spawn.x},${spawn.y}`;
    if (occupied.has(k)) throw new Error(`出生点重叠：(${spawn.x}, ${spawn.y})`);
    occupied.add(k);

    /* 槽位名不能含出生点下标 —— 那样换一张地图就变了，等级带不到下一关 */
    const nth = ordinal.get(def.id) ?? 0;
    ordinal.set(def.id, nth + 1);

    units.push(
      createUnitInstance(
        def,
        loadout,
        spawn.team,
        { x: spawn.x, y: spawn.y },
        index,
        `${def.id}#${nth}`,
        spawn.level ?? def.level,
      ),
    );
  });

  /* 增援：单位在**开局就造好**，只是先不放进 units（见 UnitBlueprint 的说明）。
     这里不校验位置是否重叠 —— 到场那一刻才找空格，因为那时棋盘早就变了。 */
  const pendingReinforcements: PendingReinforcement[] = [];
  for (const wave of scenario.reinforcements) {
    for (const spawn of wave.spawns) {
      const { def, loadout } = resolveRecipe(defMap, weaponMap, skillMap, spawn.defId);
      assertSpawnable(scenario.map, spawn);
      pendingReinforcements.push({
        turn: wave.turn,
        pos: { x: spawn.x, y: spawn.y },
        blueprint: createBlueprint(def, loadout, spawn.team, spawn.level ?? def.level),
      });
    }
  }

  return {
    map: scenario.map,
    units,
    turn: 1,
    activeTeam: 'player',
    phase: 'playing',
    rngSeed: scenario.seed,
    rngCursor: 0,
    pendingReinforcements,
    objective: scenario.objective ?? { kind: 'rout' },
    log: [`—— 第 1 回合 · ${teamLabel('player')}阶段 ——`],
  };
}

export function findUnit(state: BattleState, id: string): Unit | undefined {
  return state.units.find((u) => u.id === id);
}

export function requireUnit(state: BattleState, id: string): Unit {
  const unit = findUnit(state, id);
  if (!unit) throw new Error(`单位不存在：${id}`);
  return unit;
}

export function livingUnitsOf(state: BattleState, team: Team): Unit[] {
  return state.units.filter((u) => u.hp > 0 && u.team === team);
}

export function aliveCount(state: BattleState, team: Team): number {
  return livingUnitsOf(state, team).length;
}

/**
 * 存档 = 直接把 state 转成 JSON。
 * 能这么简单，是因为 state 里没有任何 Map / Set / class / 函数引用。
 */
export function encodeState(state: BattleState): string {
  return JSON.stringify(state);
}

export function decodeState(json: string): BattleState {
  return JSON.parse(json) as BattleState;
}
