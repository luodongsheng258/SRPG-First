import { describe, expect, it } from 'vitest';

import { applyAction, attackableTargets, encodeState, decodeState } from '../src/core';
import { flatMap, makeRangedUnit, makeState, makeUnit, testWeapon } from './fixtures';

describe('move', () => {
  it('更新位置、标记已移动、但还不算结束行动，而且是纯函数', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 3 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [scout, foe]);

    const next = applyAction(state, { type: 'move', unitId: 'scout', to: { x: 2, y: 0 } });

    expect(next.units[0].pos).toEqual({ x: 2, y: 0 });
    expect(next.units[0]).toMatchObject({ moved: true, done: false });
    /* 原状态一字未改 */
    expect(state.units[0].pos).toEqual({ x: 0, y: 0 });
    expect(state.units[0].moved).toBe(false);
  });

  it('超出移动力 / 地形不可通行 / 被占据，全部拒绝', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 1 });
    const ally = makeUnit({ id: 'ally', pos: { x: 0, y: 1 } });
    const state = makeState(map, [scout, ally]);

    expect(() => applyAction(state, { type: 'move', unitId: 'scout', to: { x: 3, y: 0 } })).toThrow(/无法移动/);
    expect(() => applyAction(state, { type: 'move', unitId: 'scout', to: { x: 0, y: 1 } })).toThrow(/无法移动/);
  });

  it('一回合只能移动一次，但移动后仍可攻击或待机', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 3 });
    /* 必须放一个敌人：否则第一次移动后 checkVictory 立刻判定「敌方全灭」，
       下一句拿到的报错会变成"当前不能行动"，把真正要验证的规则掩盖掉。 */
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [scout, foe]);

    const moved = applyAction(state, { type: 'move', unitId: 'scout', to: { x: 0, y: 2 } });
    expect(() => applyAction(moved, { type: 'move', unitId: 'scout', to: { x: 2, y: 2 } })).toThrow(/已经移动过/);

    const waited = applyAction(moved, { type: 'wait', unitId: 'scout' });
    expect(waited.units[0]).toMatchObject({ done: true, moved: true });
  });

  it('原地确认（to 等于当前位置）是合法操作', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 2, y: 2 }, mov: 3 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [scout, foe]);
    const next = applyAction(state, { type: 'move', unitId: 'scout', to: { x: 2, y: 2 } });
    expect(next.units[0]).toMatchObject({ moved: true, done: false });
  });
});

describe('attack', () => {
  it('击杀最后一个敌人 → phase 变 won，攻击方结束行动', () => {
    const map = flatMap(5, 5);
    const killer = makeUnit({ id: 'killer', pos: { x: 0, y: 0 }, atk: 50, skill: 99, spd: 10 });
    const victim = makeRangedUnit({ id: 'victim', pos: { x: 1, y: 0 }, team: 'enemy', hp: 10, maxHp: 10, def: 0 });
    const state = makeState(map, [killer, victim], { seed: 99 });

    const next = applyAction(state, { type: 'attack', unitId: 'killer', targetId: 'victim' });

    expect(next.units.find((u) => u.id === 'victim')?.hp).toBe(0);
    expect(next.units.find((u) => u.id === 'killer')).toMatchObject({ done: true, moved: true });
    expect(next.phase).toBe('won');
    expect(next.log.at(-1)).toContain('胜利');
  });

  it('不能打射程外的目标、不能打友军', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const far = makeUnit({ id: 'far', pos: { x: 4, y: 0 }, team: 'enemy' });
    const ally = makeUnit({ id: 'ally', pos: { x: 1, y: 0 } });
    const state = makeState(map, [hero, far, ally]);

    expect(() => applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'far' })).toThrow(/不在攻击范围/);
    expect(() => applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'ally' })).toThrow(/友军/);
  });

  it('已经行动过的单位不能再次行动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe], { seed: 1 });

    const acted = applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'foe' });
    expect(() => applyAction(acted, { type: 'wait', unitId: 'hero' })).toThrow(/不能行动/);
    expect(() => applyAction(acted, { type: 'attack', unitId: 'hero', targetId: 'foe' })).toThrow(/不能行动/);
  });

  it('不能攻击已阵亡的目标', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const corpse = makeUnit({ id: 'corpse', pos: { x: 1, y: 0 }, team: 'enemy', hp: 0 });
    const state = makeState(map, [hero, corpse]);
    expect(() => applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'corpse' })).toThrow(/阵亡/);
  });
});

describe('wait / endTurn', () => {
  it('wait 让单位结束行动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);
    const next = applyAction(state, { type: 'wait', unitId: 'hero' });
    expect(next.units[0]).toMatchObject({ done: true, moved: true });
  });

  it('endTurn 切换阶段', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);
    expect(applyAction(state, { type: 'endTurn' }).activeTeam).toBe('enemy');
  });

  it('敌方阶段玩家单位不能操作，敌方单位可以', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });

    expect(() => applyAction(state, { type: 'wait', unitId: 'hero' })).toThrow(/不能行动/);
    expect(applyAction(state, { type: 'wait', unitId: 'foe' }).units.find((u) => u.id === 'foe')?.done).toBe(true);
  });
});

describe('查询与存档', () => {
  it('attackableTargets 只返回射程内存活的敌人', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({
      id: 'hero',
      pos: { x: 2, y: 2 },
      weapon: testWeapon({ range: [1, 2] }),
    });
    const near = makeUnit({ id: 'near', pos: { x: 2, y: 3 }, team: 'enemy' });
    const far = makeUnit({ id: 'far', pos: { x: 0, y: 0 }, team: 'enemy' });
    const dead = makeUnit({ id: 'dead', pos: { x: 3, y: 2 }, team: 'enemy', hp: 0 });
    const ally = makeUnit({ id: 'ally', pos: { x: 1, y: 2 } });
    const state = makeState(map, [hero, near, far, dead, ally]);

    expect(attackableTargets(state, hero).map((u) => u.id)).toEqual(['near']);
  });

  it('state 可以 JSON 往返，一字不差', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 2, y: 2 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 2 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(decodeState(encodeState(state))).toEqual(state);
  });
});

describe('换武器', () => {
  const sword = testWeapon({ id: 'test-sword', kind: 'sword', range: [1, 1] });
  const bow = testWeapon({ id: 'test-bow', kind: 'bow', name: '测试弓', range: [2, 2] });

  /** 我方在 (0,1) 带着剑和弓、默认拿剑；敌人在 2 格外 —— 剑够不着，弓够得着 */
  function armed() {
    const map = flatMap(6, 3);
    const hero = makeUnit({
      id: 'hero',
      pos: { x: 0, y: 1 },
      weapons: [sword, bow],
      weapon: sword,
    });
    const foe = makeUnit({ id: 'foe', pos: { x: 2, y: 1 }, team: 'enemy' });
    return makeState(map, [hero, foe]);
  }

  const equipBow = { type: 'equip', unitId: 'hero', weaponId: 'test-bow' } as const;

  it('把装备换成携带列表里的另一把', () => {
    const next = applyAction(armed(), equipBow);
    expect(next.units.find((u) => u.id === 'hero')?.weapon.id).toBe('test-bow');
  });

  it('不消耗行动：done / moved 都不变', () => {
    const next = applyAction(armed(), equipBow);
    expect(next.units.find((u) => u.id === 'hero')).toMatchObject({ done: false, moved: false });
  });

  it('换成长射程武器之后，够得着的目标立刻变了', () => {
    const state = armed();
    const hero = state.units.find((u) => u.id === 'hero');
    if (!hero) throw new Error('找不到 hero');
    /* 剑只有 1 格射程，而敌人在 2 格外 */
    expect(attackableTargets(state, hero)).toHaveLength(0);

    const next = applyAction(state, equipBow);
    const rearmed = next.units.find((u) => u.id === 'hero');
    if (!rearmed) throw new Error('找不到 hero');
    expect(attackableTargets(next, rearmed).map((u) => u.id)).toEqual(['foe']);
  });

  it('**打完还能换** —— 这正是"用哪把武器迎接敌方回合"的决策', () => {
    const state = armed();
    const waited = applyAction(state, { type: 'wait', unitId: 'hero' });
    expect(waited.units.find((u) => u.id === 'hero')?.done).toBe(true);

    const swapped = applyAction(waited, equipBow);
    expect(swapped.units.find((u) => u.id === 'hero')?.weapon.id).toBe('test-bow');
    /* 换武器不该把 done 清掉 */
    expect(swapped.units.find((u) => u.id === 'hero')?.done).toBe(true);
  });

  it('拒绝：没带的武器、已经装备的那把、敌方回合', () => {
    const state = armed();
    expect(() => applyAction(state, { type: 'equip', unitId: 'hero', weaponId: '没带' })).toThrow(
      /没有携带/,
    );
    expect(() =>
      applyAction(state, { type: 'equip', unitId: 'hero', weaponId: 'test-sword' }),
    ).toThrow(/已经装备/);
    expect(() => applyAction({ ...state, activeTeam: 'enemy' }, equipBow)).toThrow(/自己的回合/);
  });

  it('换武器会写进日志', () => {
    const next = applyAction(armed(), equipBow);
    expect(next.log.some((line) => line.includes('换上'))).toBe(true);
  });
});
