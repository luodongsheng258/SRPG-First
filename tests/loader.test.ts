import { describe, expect, it } from 'vitest';

import mapRaw from '../data/maps/plain-01.json';
import unitsRaw from '../data/units.json';
import weaponsRaw from '../data/weapons.json';

import {
  createBattle,
  loadBattle,
  parseScenario,
  parseUnitDefs,
  parseWeaponDefs,
} from '../src/core';

const GOOD_WEAPON = {
  id: 'test-blade',
  name: '测试剑',
  kind: 'sword',
  might: 3,
  hit: 10,
  crit: 5,
  range: [1, 1],
};

const GOOD_UNIT = {
  id: 'dummy',
  name: '假人',
  unitClass: 'infantry',
  level: 1,
  maxHp: 20,
  atk: 5,
  def: 2,
  spd: 5,
  skill: 5,
  mov: 4,
  weaponIds: ['test-blade'],
  growths: { maxHp: 50, atk: 40, def: 30, spd: 40, skill: 45 },
};

const PLAIN_3X3 = [
  ['plain', 'plain', 'plain'],
  ['plain', 'plain', 'plain'],
  ['plain', 'plain', 'plain'],
];

const MAP_BASE = { id: 'm', name: '测试图', width: 3, height: 3, seed: 1, spawns: [] };

describe('武器表校验', () => {
  it('真实武器表能解析，id 唯一，射程区间合法', () => {
    const weapons = parseWeaponDefs(weaponsRaw);
    expect(weapons.length).toBeGreaterThan(0);
    expect(new Set(weapons.map((w) => w.id)).size).toBe(weapons.length);
    for (const weapon of weapons) {
      expect(weapon.range[1]).toBeGreaterThanOrEqual(weapon.range[0]);
      /* 最小射程至少是 1 —— 射程 0 意味着"能打自己脚下"，没有意义 */
      expect(weapon.range[0]).toBeGreaterThanOrEqual(1);
      expect(weapon.crit).toBeGreaterThanOrEqual(0);
    }
  });

  it('顶层不是数组 → 报错', () => {
    expect(() => parseWeaponDefs({})).toThrow(/数组/);
  });

  it('kind 非法 → 报错', () => {
    expect(() => parseWeaponDefs([{ ...GOOD_WEAPON, kind: 'laser' }])).toThrow(/kind/);
  });

  it('range 不是二元数组或区间非法 → 报错', () => {
    expect(() => parseWeaponDefs([{ ...GOOD_WEAPON, range: [1] }])).toThrow(/range/);
    expect(() => parseWeaponDefs([{ ...GOOD_WEAPON, range: [3, 1] }])).toThrow(/区间非法/);
    expect(() => parseWeaponDefs([{ ...GOOD_WEAPON, range: [0, 1] }])).toThrow(/区间非法/);
  });

  it('id 重复 → 报错', () => {
    expect(() => parseWeaponDefs([GOOD_WEAPON, { ...GOOD_WEAPON }])).toThrow(/重复/);
  });
});

describe('单位表校验', () => {
  it('真实单位表能解析，id 唯一', () => {
    const defs = parseUnitDefs(unitsRaw);
    expect(defs.length).toBeGreaterThan(0);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    for (const def of defs) {
      expect(def.maxHp).toBeGreaterThan(0);
      expect(def.weaponIds.length).toBeGreaterThan(0);
    }
  });

  it('真实单位表引用的武器都真实存在（交叉校验）', () => {
    const weaponIds = new Set(parseWeaponDefs(weaponsRaw).map((w) => w.id));
    for (const def of parseUnitDefs(unitsRaw)) {
      for (const id of def.weaponIds) {
        expect(weaponIds.has(id), `单位 ${def.id} 引用了 ${id}`).toBe(true);
      }
    }
  });

  it('顶层不是数组 → 报错', () => {
    expect(() => parseUnitDefs({})).toThrow(/数组/);
    expect(() => parseUnitDefs(null)).toThrow(/数组/);
  });

  it('unitClass 非法 → 报错', () => {
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, unitClass: 'ninja' }])).toThrow(/unitClass/);
  });

  it('数值字段缺失或非数字 → 报错', () => {
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, atk: '9' }])).toThrow(/atk/);
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, mov: Number.NaN }])).toThrow(/mov/);
  });

  it('weaponIds 缺失、为空或重复 → 报错', () => {
    const { weaponIds: _dropped, ...withoutWeapon } = GOOD_UNIT;
    expect(() => parseUnitDefs([withoutWeapon])).toThrow(/weaponIds/);
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, weaponIds: [] }])).toThrow(/非空数组/);
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, weaponIds: ['a', 'a'] }])).toThrow(/重复/);
  });

  it('缺 level 或成长率 → 报错', () => {
    const { level: _lv, ...withoutLevel } = GOOD_UNIT;
    expect(() => parseUnitDefs([withoutLevel])).toThrow(/level/);
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, growths: { maxHp: 50 } }])).toThrow(
      /growths\.atk/,
    );
    expect(() => parseUnitDefs([{ ...GOOD_UNIT, growths: { ...GOOD_UNIT.growths, spd: -1 } }])).toThrow(
      /spd 不能为负/,
    );
  });

  it('id 重复 → 报错', () => {
    expect(() => parseUnitDefs([GOOD_UNIT, { ...GOOD_UNIT }])).toThrow(/重复/);
  });
});

describe('地图校验', () => {
  it('真实地图能解析，行列数与声明尺寸一致', () => {
    const scenario = parseScenario(mapRaw);
    expect(scenario.map.terrain).toHaveLength(scenario.map.height);
    for (const row of scenario.map.terrain) {
      expect(row).toHaveLength(scenario.map.width);
    }
    expect(scenario.spawns.length).toBeGreaterThan(0);
  });

  it('地形行数不对 → 报错', () => {
    expect(() => parseScenario({ ...MAP_BASE, terrain: PLAIN_3X3.slice(0, 2) })).toThrow(/terrain/);
  });

  it('地形列数不对 → 报错', () => {
    expect(() =>
      parseScenario({ ...MAP_BASE, terrain: [['plain', 'plain'], ...PLAIN_3X3.slice(1)] }),
    ).toThrow(/列/);
  });

  it('未知地形 → 报错', () => {
    expect(() =>
      parseScenario({ ...MAP_BASE, terrain: [['plain', 'plain', 'lava'], ...PLAIN_3X3.slice(1)] }),
    ).toThrow(/不是合法地形/);
  });

  it('地图尺寸非正整数 → 报错', () => {
    expect(() => parseScenario({ ...MAP_BASE, width: 0, terrain: PLAIN_3X3 })).toThrow(/正整数/);
  });

  it('team 非法 → 报错', () => {
    expect(() =>
      parseScenario({
        ...MAP_BASE,
        terrain: PLAIN_3X3,
        spawns: [{ defId: 'soldier', team: 'neutral', x: 0, y: 0 }],
      }),
    ).toThrow(/team/);
  });
});

describe('建场校验', () => {
  const defs = parseUnitDefs(unitsRaw);
  const weapons = parseWeaponDefs(weaponsRaw);
  const terrain = [
    ['plain', 'plain', 'plain'],
    ['plain', 'water', 'plain'],
    ['plain', 'plain', 'plain'],
  ];
  const scenarioWith = (spawns: unknown) => parseScenario({ ...MAP_BASE, terrain, spawns });
  const spawn = (overrides: Record<string, unknown>) => [
    { defId: 'soldier', team: 'player', x: 0, y: 0, ...overrides },
  ];

  it('出生点重叠 → 报错', () => {
    expect(() =>
      createBattle(
        scenarioWith([
          { defId: 'soldier', team: 'player', x: 0, y: 0 },
          { defId: 'soldier', team: 'enemy', x: 0, y: 0 },
        ]),
        defs,
        weapons,
      ),
    ).toThrow(/重叠/);
  });

  it('出生点越界 → 报错', () => {
    expect(() =>
      createBattle(scenarioWith(spawn({ x: 9 })), defs, weapons),
    ).toThrow(/越界/);
  });

  it('出生点落在不可通行地形 → 报错', () => {
    expect(() =>
      createBattle(scenarioWith(spawn({ x: 1, y: 1 })), defs, weapons),
    ).toThrow(/不可通行/);
  });

  it('引用了不存在的单位模板 → 报错', () => {
    expect(() =>
      createBattle(scenarioWith(spawn({ defId: 'dragon' })), defs, weapons),
    ).toThrow(/未知单位模板/);
  });

  it('单位引用了不存在的武器 → 报错', () => {
    const broken = parseUnitDefs([{ ...GOOD_UNIT, weaponIds: ['根本没有这把剑'] }]);
    expect(() =>
      createBattle(scenarioWith(spawn({ defId: 'dummy' })), broken, weapons),
    ).toThrow(/不存在的武器/);
  });
});

describe('loadBattle 端到端', () => {
  it('真实关卡能直接开打，且种子可覆盖', () => {
    /* 期望值从场景的 spawn 推导，而不是写死数字 ——
       否则每次调整布阵都要来改这个测试。
       它真正想验证的不变式是「每个出生点都变成了正确阵营的单位」。 */
    const scenario = parseScenario(mapRaw);
    const state = loadBattle(mapRaw, unitsRaw, weaponsRaw, 7);

    expect(scenario.spawns.length).toBeGreaterThan(0);
    expect(state.units).toHaveLength(scenario.spawns.length);
    expect(state.units.filter((u) => u.team === 'player')).toHaveLength(
      scenario.spawns.filter((s) => s.team === 'player').length,
    );
    expect(state.units.filter((u) => u.team === 'enemy')).toHaveLength(
      scenario.spawns.filter((s) => s.team === 'enemy').length,
    );
    expect(state.activeTeam).toBe('player');
    expect(state.turn).toBe(1);
    expect(state.rngSeed).toBe(7);
    expect(state.phase).toBe('playing');
    expect(state.rngCursor).toBe(0);
  });

  it('每个单位实例 id 唯一，hp 从满血开始，而且都装上了武器', () => {
    const state = loadBattle(mapRaw, unitsRaw, weaponsRaw);
    expect(new Set(state.units.map((u) => u.id)).size).toBe(state.units.length);
    for (const unit of state.units) {
      expect(unit.hp).toBe(unit.maxHp);
      expect(unit.done).toBe(false);
      expect(unit.moved).toBe(false);
      /* 武器是内嵌的纯数据，不是 id —— 战斗公式不该再去查全局表 */
      expect(typeof unit.weapon).toBe('object');
      expect(unit.weapon.range).toHaveLength(2);
      expect(unit.weapon.might).toBeGreaterThanOrEqual(0);
    }
  });

  it('武器按值复制：改一个单位的武器不会影响别人', () => {
    const state = loadBattle(mapRaw, unitsRaw, weaponsRaw);
    const first = state.units[0];
    const second = state.units[1];
    expect(first.weapon).not.toBe(second.weapon);

    first.weapon.might = 999;
    first.weapon.range[0] = 99;
    expect(second.weapon.might).not.toBe(999);
    expect(second.weapon.range[0]).not.toBe(99);
  });

  it('两次加载得到内容相同的战场', () => {
    expect(loadBattle(mapRaw, unitsRaw, weaponsRaw, 3)).toEqual(
      loadBattle(mapRaw, unitsRaw, weaponsRaw, 3),
    );
  });
});
