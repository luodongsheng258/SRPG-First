import { describe, expect, it } from 'vitest';

import { arriveReinforcements, endTurn, runTurn } from '../src/core';
import type { BattleState } from '../src/core';
import { flatMap, makePending, makeState, makeUnit, mapWith } from './fixtures';

/**
 * 增援到场。
 *
 * 这一块的架构约束值得记住：`endTurn` 是纯函数，签名是 `(state) => state`，
 * 拿不到 `defs` / `weapons`。所以增援单位**在开局就造好了**（`UnitBlueprint`），
 * 到场时只是补上 `id` / `slot` / `pos` 放进 `units`。
 */

const at = (x: number, y: number) => ({ x, y });

describe('增援到场', () => {
  it('没到期就不动 —— 而且保持引用相等', () => {
    const map = flatMap(6, 4);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
    const pending = [makePending(4, at(5, 3), { id: 'late', pos: at(5, 3), team: 'enemy' })];
    const state = makeState(map, [hero], { pendingReinforcements: pending });

    expect(arriveReinforcements(state, 3)).toBe(state);
    expect(arriveReinforcements(state, 3).units).toHaveLength(1);
  });

  it('到期就进入战场，并从待命列表里移除', () => {
    const map = flatMap(6, 4);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
    const state = makeState(map, [hero], {
      pendingReinforcements: [makePending(4, at(5, 3), { id: 'x', pos: at(5, 3), team: 'enemy' })],
    });

    const next = arriveReinforcements(state, 4);

    expect(next.units).toHaveLength(2);
    expect(next.pendingReinforcements).toHaveLength(0);
    const arrived = next.units.find((u) => u.team === 'enemy');
    expect(arrived?.pos).toEqual(at(5, 3));
    expect(arrived?.hp).toBe(arrived?.maxHp);
  });

  it('漏结算的波次会补到场（用 turn <= 而不是 turn ===）', () => {
    const map = flatMap(6, 4);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
    const state = makeState(map, [hero], {
      pendingReinforcements: [
        makePending(2, at(5, 3), { id: 'a', pos: at(5, 3), team: 'enemy' }),
        makePending(9, at(5, 0), { id: 'b', pos: at(5, 0), team: 'enemy' }),
      ],
    });

    /* 直接从第 1 回合跳到第 5 回合：第 2 回合那波必须补上 */
    const next = arriveReinforcements(state, 5);
    expect(next.units).toHaveLength(2);
    expect(next.pendingReinforcements).toHaveLength(1);
    expect(next.pendingReinforcements[0]?.turn).toBe(9);
  });

  it('到场格被占时挪到最近的空格 —— 而不是延期', () => {
    const map = flatMap(6, 4);
    /* 玩家正好站在原定到场格上。延期的话他只要一直站着就能关掉增援 */
    const hero = makeUnit({ id: 'hero', pos: at(5, 3) });
    const state = makeState(map, [hero], {
      pendingReinforcements: [makePending(1, at(5, 3), { id: 'x', pos: at(5, 3), team: 'enemy' })],
    });

    const next = arriveReinforcements(state, 1);
    const arrived = next.units.find((u) => u.team === 'enemy');

    expect(arrived).toBeDefined();
    expect(arrived?.pos).not.toEqual(at(5, 3));
    /* 最近的空格就是紧邻的那一格 */
    expect(Math.abs((arrived?.pos.x ?? 0) - 5) + Math.abs((arrived?.pos.y ?? 0) - 3)).toBe(1);
    expect(next.log.some((line) => line.includes('被占'))).toBe(true);
  });

  it('不可通行的地形不能用来落脚（会被跳过）', () => {
    /* 5x3，中间一列全是水 */
    const map = mapWith(
      [
        { x: 2, y: 0, t: 'water' },
        { x: 2, y: 1, t: 'water' },
        { x: 2, y: 2, t: 'water' },
      ],
      5,
      3,
    );
    const hero = makeUnit({ id: 'hero', pos: at(4, 1) });
    const state = makeState(map, [hero], {
      pendingReinforcements: [makePending(1, at(2, 1), { id: 'x', pos: at(2, 1), team: 'enemy' })],
    });

    const arrived = arriveReinforcements(state, 1).units.find((u) => u.team === 'enemy');
    expect(arrived).toBeDefined();
    expect(map.terrain[arrived?.pos.y ?? 0][arrived?.pos.x ?? 0]).not.toBe('water');
  });

  it('阵亡的单位不占位（和移动判定保持一致）', () => {
    const map = flatMap(4, 3);
    const corpse = makeUnit({ id: 'corpse', pos: at(3, 1), hp: 0 });
    const state = makeState(map, [corpse], {
      pendingReinforcements: [makePending(1, at(3, 1), { id: 'x', pos: at(3, 1), team: 'enemy' })],
    });

    const arrived = arriveReinforcements(state, 1).units.find((u) => u.team === 'enemy');
    expect(arrived?.pos).toEqual(at(3, 1));
  });

  it('一波多个增援不会互相抢格子', () => {
    const map = flatMap(4, 3);
    const state = makeState(map, [], {
      pendingReinforcements: [
        makePending(1, at(1, 1), { id: 'a', pos: at(1, 1), team: 'enemy' }),
        makePending(1, at(1, 1), { id: 'b', pos: at(1, 1), team: 'enemy' }),
      ],
    });

    const next = arriveReinforcements(state, 1);
    const spots = next.units.map((u) => `${u.pos.x},${u.pos.y}`);
    expect(new Set(spots).size).toBe(2);
  });

  it('到场单位的 id 和 slot 都不和已有的撞', () => {
    const map = flatMap(4, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), slot: 'test-unit#0' });
    const state = makeState(map, [hero], {
      pendingReinforcements: [makePending(1, at(3, 2), { id: 'x', pos: at(3, 2), team: 'enemy' })],
    });

    const next = arriveReinforcements(state, 1);
    const ids = next.units.map((u) => u.id);
    const slots = next.units.map((u) => u.slot);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('整张图都站满了就跳过，并记一条日志（不崩、也不静默）', () => {
    /* 1x1 的地图，唯一的格子被站着 */
    const map = flatMap(1, 1);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
    const state = makeState(map, [hero], {
      pendingReinforcements: [makePending(1, at(0, 0), { id: 'x', pos: at(0, 0), team: 'enemy' })],
    });

    const next = arriveReinforcements(state, 1);
    expect(next.units).toHaveLength(1);
    expect(next.pendingReinforcements).toHaveLength(0);
    expect(next.log.some((line) => line.includes('无空位'))).toBe(true);
  });
});

describe('增援接进 endTurn', () => {
  function battle(): BattleState {
    const map = flatMap(8, 4);
    /* mov 0：双方都够不着对方，所以战斗不会在数回合前就分出胜负 ——
       我们要观察的是"第 4 回合"这个时间点，不能让它中途结束 */
    const hero = makeUnit({ id: 'hero', pos: at(0, 1), mov: 0 });
    const foe = makeUnit({ id: 'foe', pos: at(7, 1), team: 'enemy', mov: 0 });
    return makeState(map, [hero, foe], {
      pendingReinforcements: [makePending(4, at(7, 3), { id: 'x', pos: at(7, 3), team: 'enemy' })],
    });
  }

  it('第 4 回合开始时到场，而不是第 3 回合', () => {
    let state = battle();
    /* 一次 endTurn 走一个阶段：我方→敌方，敌方→我方（回合 +1） */
    for (let i = 0; i < 5; i += 1) state = runTurn(state);
    expect(state.turn).toBe(3);
    expect(state.units.filter((u) => u.team === 'enemy')).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) state = runTurn(state);
    expect(state.turn).toBe(4);
    expect(state.units.filter((u) => u.team === 'enemy')).toHaveLength(2);
  });

  it('日志顺序是「回合标题 → 增援到场」', () => {
    const next = endTurn({ ...battle(), activeTeam: 'enemy', turn: 3 });

    const title = next.log.findIndex((l) => l.includes('第 4 回合'));
    const arrival = next.log.findIndex((l) => l.includes('增援到场'));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(arrival).toBeGreaterThan(title);
  });

  it('到场的单位是待命状态，不在自己的阶段里就轮不到它行动', () => {
    /* 第 4 回合是切换到"我方"时到达的，所以那时它不该已经行动过 */
    const next = endTurn({ ...battle(), activeTeam: 'enemy', turn: 3 });
    const arrived = next.units.find((u) => u.team === 'enemy' && u.id.includes('-r'));
    expect(arrived).toMatchObject({ done: false, moved: false });
  });
});
