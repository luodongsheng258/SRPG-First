import { describe, expect, it } from 'vitest';

import { decideUnitAction, manhattan, planTurn, runTurn } from '../src/core';
import { flatMap, makeRangedUnit, makeState, makeUnit } from './fixtures';

describe('贪心 AI 决策', () => {
  it('打得到就会打，并且真的造成伤害', () => {
    const map = flatMap(5, 5);
    const hero = makeRangedUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 30, maxHp: 30, def: 0, spd: 1 });
    const foe = makeUnit({
      id: 'foe',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      atk: 6,
      def: 2,
      spd: 8,
      skill: 99,
      hp: 20,
      maxHp: 20,
    });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');

    /* foe 速度领先 7 ≥ 4 → 打两下，每下 6 - 0 = 6 */
    expect(next.units.find((u) => u.id === 'hero')?.hp).toBe(30 - 12);
  });

  it('打不到就朝最近的敌人推进', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', mov: 4 });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const action = decideUnitAction(state, state.units.find((u) => u.id === 'foe')!);

    expect(action.type).toBe('move');
    if (action.type === 'move') {
      expect(manhattan(action.to, hero.pos)).toBeLessThan(manhattan(foe.pos, hero.pos));
    }
  });

  it('隔着水的敌人会绕着走过去，而不是"觉得自己已经最近了"就永久待机', () => {
    const map = flatMap(7, 5);
    /* 第 2 行整条水墙，只留最右一格缺口 */
    for (let x = 0; x < 7; x += 1) map.terrain[2][x] = 'water';
    map.terrain[2][6] = 'plain';

    const hero = makeUnit({ id: 'hero', pos: { x: 3, y: 1 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 3 }, team: 'enemy', mov: 3, done: false });

    const action = decideUnitAction(makeState(map, [hero, foe], { activeTeam: 'enemy' }), foe);

    /* 直线距离 2 是所有可达落点里最小的 —— 只按曼哈顿距离判，AI 会永远待机。
       按地形距离算才会发现"得先往右走到缺口那边"。 */
    expect(manhattan(foe.pos, hero.pos)).toBe(2);
    expect(action.type).toBe('move');
    if (action.type === 'move') {
      expect(action.to.x).toBeGreaterThan(foe.pos.x);
    }
  });

  it('必死又打不死对方的交换会被放弃，改为原地待机', () => {
    const map = flatMap(5, 5);
    /* 残血杂兵 vs 满血重甲：打过去必被反杀，且打不死对方 */
    const weak = makeUnit({ id: 'weak', pos: { x: 0, y: 0 }, team: 'enemy', hp: 5, maxHp: 20, atk: 1, def: 0, spd: 1, mov: 4 });
    const tank = makeUnit({ id: 'tank', pos: { x: 1, y: 0 }, hp: 50, maxHp: 50, def: 0, atk: 20, spd: 20 });

    const state = makeState(map, [weak, tank], { activeTeam: 'enemy' });
    expect(decideUnitAction(state, weak).type).toBe('wait');
  });

  it('已经移动过的单位只在原地二选一，不会再次移动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', moved: true });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const action = decideUnitAction(state, state.units.find((u) => u.id === 'foe')!);
    expect(action.type).toBe('wait');
  });

  it('相同局面下的决策完全一致（无隐藏随机）', () => {
    const map = flatMap(5, 5);
    const build = () => {
      const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
      const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 3 }, team: 'enemy' });
      return makeState(map, [hero, foe], { activeTeam: 'enemy', seed: 5 });
    };
    const a = build();
    const b = build();
    expect(decideUnitAction(a, a.units[1])).toEqual(decideUnitAction(b, b.units[1]));
  });
});

describe('整轮规划', () => {
  it('planTurn 一定以 endTurn 收尾', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const plan = planTurn(state, 'enemy');
    expect(plan.at(-1)).toEqual({ type: 'endTurn' });
  });

  it('战斗提前结束时不再追加 endTurn', () => {
    const map = flatMap(5, 5);
    const hero = makeRangedUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 5, maxHp: 20, def: 0, spd: 1 });
    const foe = makeUnit({
      id: 'foe',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      atk: 99,
      def: 0,
      spd: 20,
      skill: 99,
      hp: 20,
      maxHp: 20,
    });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const plan = planTurn(state, 'enemy');
    expect(plan.some((action) => action.type === 'endTurn')).toBe(false);
  });

  it('runTurn 跑完一整轮后把控制权交还给对方，并推进回合数', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');

    expect(next.activeTeam).toBe('player');
    expect(next.turn).toBe(2);
    expect(next.units.find((u) => u.id === 'foe')?.done).toBe(true);
    expect(next.units.find((u) => u.id === 'hero')).toMatchObject({ done: false, moved: false });
  });

  it('敌方回合里我方单位原地不动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');
    expect(next.units.find((u) => u.id === 'hero')?.pos).toEqual({ x: 0, y: 0 });
  });
});
