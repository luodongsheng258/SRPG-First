import { STAT_KEYS } from './progression';
import { createBattle } from './state';
import { isTerrainKind } from './terrain';
import { isRecord, num, str } from './validate';
import type {
  BattleMap,
  BattleState,
  Growths,
  Scenario,
  Team,
  TerrainKind,
  UnitClass,
  UnitDef,
  UnitSpawn,
  WeaponDef,
  WeaponKind,
} from './types';

/**
 * 配置加载与校验。
 *
 * 为什么要在运行时做这套校验，而不是直接 `as UnitDef`？
 *   1. JSON 是**外部输入**。手改错一个字段（比如把 range 写成 [1]）会让
 *      引擎在几十步之后以一条莫名其妙的报错崩掉，而校验能立刻指出行号。
 *   2. 将来开放关卡编辑器 / 创意工坊，玩家做的地图一定会出错。
 *   3. 让 AI 生成内容时，报错信息就是它的修正信号。
 */

const UNIT_CLASSES: readonly UnitClass[] = ['infantry', 'archer', 'cavalier', 'mage'];

function parseGrowths(raw: unknown, at: string): Growths {
  if (!isRecord(raw)) throw new Error(`${at}.growths 必须是对象`);
  const growths = { maxHp: 0, atk: 0, def: 0, spd: 0, skill: 0 };
  for (const key of STAT_KEYS) {
    const value = num(raw[key], `${at}.growths.${key}`);
    /* 成长率是百分比，超过 100 意味着必定涨 —— 允许，但不能是负数 */
    if (value < 0) throw new Error(`${at}.growths.${key} 不能为负：${value}`);
    growths[key] = value;
  }
  return growths;
}

export function parseUnitDefs(raw: unknown): UnitDef[] {
  if (!Array.isArray(raw)) throw new Error('单位表顶层必须是数组');

  const defs = raw.map((entry, i) => {
    const at = `units[${i}]`;
    if (!isRecord(entry)) throw new Error(`${at} 必须是对象`);

    const unitClass = str(entry.unitClass, `${at}.unitClass`);
    if (!UNIT_CLASSES.includes(unitClass as UnitClass)) {
      throw new Error(`${at}.unitClass 非法：${unitClass}（可选 ${UNIT_CLASSES.join(' / ')}）`);
    }

    const def: UnitDef = {
      id: str(entry.id, `${at}.id`),
      name: str(entry.name, `${at}.name`),
      unitClass: unitClass as UnitClass,
      level: num(entry.level, `${at}.level`),
      maxHp: num(entry.maxHp, `${at}.maxHp`),
      atk: num(entry.atk, `${at}.atk`),
      def: num(entry.def, `${at}.def`),
      spd: num(entry.spd, `${at}.spd`),
      skill: num(entry.skill, `${at}.skill`),
      mov: num(entry.mov, `${at}.mov`),
      weaponId: str(entry.weaponId, `${at}.weaponId`),
      growths: parseGrowths(entry.growths, at),
    };

    if (def.maxHp <= 0) throw new Error(`${at}.maxHp 必须为正数`);
    if (def.mov < 0) throw new Error(`${at}.mov 不能为负`);
    if (def.level < 1) throw new Error(`${at}.level 必须从 1 开始`);
    return def;
  });

  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.id)) throw new Error(`单位 id 重复：${def.id}`);
    seen.add(def.id);
  }
  return defs;
}

const WEAPON_KINDS: readonly WeaponKind[] = ['sword', 'axe', 'lance', 'bow', 'tome'];

export function parseWeaponDefs(raw: unknown): WeaponDef[] {
  if (!Array.isArray(raw)) throw new Error('武器表顶层必须是数组');

  const defs = raw.map((entry, i) => {
    const at = `weapons[${i}]`;
    if (!isRecord(entry)) throw new Error(`${at} 必须是对象`);

    const kind = str(entry.kind, `${at}.kind`);
    if (!WEAPON_KINDS.includes(kind as WeaponKind)) {
      throw new Error(`${at}.kind 非法：${kind}（可选 ${WEAPON_KINDS.join(' / ')}）`);
    }

    const rangeRaw = entry.range;
    if (!Array.isArray(rangeRaw) || rangeRaw.length !== 2) {
      throw new Error(`${at}.range 必须是 [min, max] 形式的二元数组`);
    }
    const rangeMin = num(rangeRaw[0], `${at}.range[0]`);
    const rangeMax = num(rangeRaw[1], `${at}.range[1]`);
    if (rangeMin < 1 || rangeMax < rangeMin) {
      throw new Error(`${at}.range 区间非法：[${rangeMin}, ${rangeMax}]（最小射程至少为 1）`);
    }

    const range: [number, number] = [rangeMin, rangeMax];
    const def: WeaponDef = {
      id: str(entry.id, `${at}.id`),
      name: str(entry.name, `${at}.name`),
      kind: kind as WeaponKind,
      might: num(entry.might, `${at}.might`),
      hit: num(entry.hit, `${at}.hit`),
      crit: num(entry.crit, `${at}.crit`),
      range,
    };
    if (def.crit < 0) throw new Error(`${at}.crit 不能为负`);
    return def;
  });

  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.id)) throw new Error(`武器 id 重复：${def.id}`);
    seen.add(def.id);
  }
  return defs;
}

export function parseScenario(raw: unknown): Scenario {
  if (!isRecord(raw)) throw new Error('地图文件顶层必须是对象');

  const width = num(raw.width, 'width');
  const height = num(raw.height, 'height');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`地图尺寸必须是正整数，收到 ${width}x${height}`);
  }

  if (!Array.isArray(raw.terrain) || raw.terrain.length !== height) {
    throw new Error(`terrain 必须有 ${height} 行，收到 ${Array.isArray(raw.terrain) ? raw.terrain.length : '非数组'}`);
  }

  const terrain: TerrainKind[][] = raw.terrain.map((row, y) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(`terrain 第 ${y} 行必须有 ${width} 列，收到 ${Array.isArray(row) ? row.length : '非数组'}`);
    }
    return row.map((cell, x) => {
      if (!isTerrainKind(cell)) {
        throw new Error(`terrain[${y}][${x}] 不是合法地形：${JSON.stringify(cell)}`);
      }
      return cell;
    });
  });

  const map: BattleMap = {
    id: str(raw.id, 'id'),
    name: str(raw.name, 'name'),
    width,
    height,
    terrain,
  };

  if (!Array.isArray(raw.spawns)) throw new Error('spawns 必须是数组');
  const spawns: UnitSpawn[] = raw.spawns.map((entry, i) => {
    const at = `spawns[${i}]`;
    if (!isRecord(entry)) throw new Error(`${at} 必须是对象`);
    const team = str(entry.team, `${at}.team`);
    if (team !== 'player' && team !== 'enemy') {
      throw new Error(`${at}.team 必须是 "player" 或 "enemy"，收到 ${team}`);
    }
    const spawn: UnitSpawn = {
      defId: str(entry.defId, `${at}.defId`),
      team: team as Team,
      x: num(entry.x, `${at}.x`),
      y: num(entry.y, `${at}.y`),
    };
    /* 可选的等级覆盖：有了它，"第二章的敌人更强"只要写一个数字 */
    if (entry.level !== undefined) {
      const level = num(entry.level, `${at}.level`);
      if (level < 1) throw new Error(`${at}.level 必须从 1 开始`);
      spawn.level = level;
    }
    return spawn;
  });

  const seed = raw.seed === undefined ? 1 : num(raw.seed, 'seed');
  if (!Number.isInteger(seed)) throw new Error('seed 必须是整数');

  return { map, spawns, seed };
}

/** 一步到位：从三个 JSON 造出可玩的战场状态 */
export function loadBattle(
  mapRaw: unknown,
  unitsRaw: unknown,
  weaponsRaw: unknown,
  seedOverride?: number,
): BattleState {
  const defs = parseUnitDefs(unitsRaw);
  const weapons = parseWeaponDefs(weaponsRaw);
  const scenario = parseScenario(mapRaw);
  if (seedOverride !== undefined) scenario.seed = seedOverride;
  return createBattle(scenario, defs, weapons);
}
