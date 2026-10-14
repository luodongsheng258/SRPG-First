import type {
  BattleMap,
  BattleState,
  Objective,
  PendingReinforcement,
  Team,
  TerrainKind,
  Unit,
  WeaponDef,
} from '../src/core';

/**
 * 测试夹具。
 *
 * 原则：**测试不许依赖 data/*.json 的具体数值**。
 * 数值会随着平衡调整天天变，测试跟着一起改就失去了意义。
 * 所以这里手搭最小局面，把要验证的那一条规则单独隔离出来。
 * 只有 loader / levels / harness 的测试才去读真实内容文件。
 */

/**
 * 默认测试武器：所有加成归零。
 *
 * 这样旧断言里的伤害数字一个都不用改 —— 伤害仍是 `atk + 0`。
 * `hit: 10` 是为了补 `HIT_BASE` 从 70 降到 60 的那 10 点，
 * 于是 `60 + 技巧差 × 5 + 10` 精确等于原来的 `70 + 技巧差 × 5`。
 */
export function testWeapon(patch: Partial<WeaponDef> = {}): WeaponDef {
  const range: [number, number] =
    patch.range === undefined ? [1, 1] : [patch.range[0], patch.range[1]];

  return {
    id: 'test-blade',
    name: '测试剑',
    kind: 'sword',
    might: 0,
    hit: 10,
    crit: 0,
    ...patch,
    /* range 必须复制成新数组，避免被多个单位共享同一个可变引用 */
    range,
  };
}

export function flatMap(width = 5, height = 5, fill: TerrainKind = 'plain'): BattleMap {
  return {
    id: 'test-map',
    name: '测试地图',
    width,
    height,
    terrain: Array.from({ length: height }, () =>
      Array.from({ length: width }, () => fill),
    ),
  };
}

export function mapWith(
  patches: ReadonlyArray<{ x: number; y: number; t: TerrainKind }>,
  width = 5,
  height = 5,
): BattleMap {
  const map = flatMap(width, height);
  for (const patch of patches) map.terrain[patch.y][patch.x] = patch.t;
  return map;
}

/** 默认 id 由队伍 + 坐标推出，保证可读且完全确定 */
export function makeUnit(overrides: Partial<Unit> & Pick<Unit, 'pos'>): Unit {
  const { pos } = overrides;
  const team: Team = overrides.team ?? 'player';

  /* 武器：默认一把"全零加成"的测试剑。
     要带多把就传 `weapons`（第一把自动成为当前装备），
     或者同时传 `weapon` 指定当前装备哪一把 —— 用来测换武器。 */
  const weapons = overrides.weapons ?? [overrides.weapon ?? testWeapon()];
  const weapon = overrides.weapon ?? weapons[0] ?? testWeapon();

  const base: Unit = {
    id: 'unset',
    defId: 'test-unit',
    name: '测试兵',
    unitClass: 'infantry',
    level: 1,
    team,
    pos: { x: pos.x, y: pos.y },
    hp: 20,
    maxHp: 20,
    atk: 10,
    def: 2,
    spd: 5,
    skill: 5,
    mov: 4,
    weapon,
    weapons,
    slot: 'test-unit#0',
    exp: 0,
    /* 成长率全 0：测试里不该有升级掷骰。
       掷骰会消耗随机游标，而游标推进的断言到处都是 ——
       需要测升级的用例自己传 growths。 */
    growths: { maxHp: 0, atk: 0, def: 0, spd: 0, skill: 0 },
    done: false,
    moved: false,
  };

  const merged: Unit = {
    ...base,
    ...overrides,
    pos: { x: pos.x, y: pos.y },
    weapon,
    weapons,
  };
  if (overrides.id === undefined) merged.id = `${merged.team}-${pos.x}-${pos.y}`;
  return merged;
}

/**
 * 造一个「打不到相邻格」的单位，用来隔离反击。
 *
 * 旧代码里这是 `canCounter: false`；现在反击能力完全由**武器射程**推导，
 * 所以表达方式变成「给它一把射程 2 的武器」——
 * 距离 1 够不着，自然就反击不了。这正是弓手在规则里的样子。
 */
export function makeRangedUnit(overrides: Partial<Unit> & Pick<Unit, 'pos'>): Unit {
  return makeUnit({
    ...overrides,
    weapon: overrides.weapon ?? testWeapon({ range: [2, 2], kind: 'bow', name: '测试弓' }),
  });
}

/**
 * 造一条"待命增援"。
 *
 * 蓝图就是去掉身份的 `Unit` —— 到场时才补 `id` / `slot` / `pos`，
 * 因为 `endTurn` 是纯函数，拿不到兵种和武器表（见 `UnitBlueprint`）。
 */
export function makePending(
  turn: number,
  pos: { x: number; y: number },
  overrides: Partial<Unit> & Pick<Unit, 'pos'>,
): PendingReinforcement {
  const { id: _id, pos: _pos, slot: _slot, ...blueprint } = makeUnit({ ...overrides, pos });
  return { turn, pos: { x: pos.x, y: pos.y }, blueprint };
}

export function makeState(
  map: BattleMap,
  units: Unit[],
  options: {
    seed?: number;
    activeTeam?: Team;
    /** 待命增援。要测增援到场的用例自己传（见 reinforce.test.ts） */
    pendingReinforcements?: PendingReinforcement[];
    /** 胜利条件。默认"全灭对方" */
    objective?: Objective;
  } = {},
): BattleState {
  return {
    map,
    units,
    turn: 1,
    activeTeam: options.activeTeam ?? 'player',
    phase: 'playing',
    rngSeed: options.seed ?? 12345,
    rngCursor: 0,
    pendingReinforcements: options.pendingReinforcements ?? [],
    objective: options.objective ?? { kind: 'rout' },
    log: [],
  };
}
