import { describe, expect, it } from 'vitest';

import { computeMoveRange, findPath, key, manhattan, terrainDistanceField } from '../src/core';
import { flatMap, makeUnit, mapWith } from './fixtures';

describe('移动范围（Dijkstra）', () => {
  it('全平原 mov=3：可达格是曼哈顿距离 ≤ 3 的菱形（1+2+3+4=10 格）', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ pos: { x: 0, y: 0 }, mov: 3 });
    const range = computeMoveRange(map, [scout], scout);
    expect(range.destinations).toHaveLength(10);
  });

  it('森林消耗 2 点移动力，不是"距离"', () => {
    const map = mapWith([{ x: 1, y: 0, t: 'forest' }]);
    const scout = makeUnit({ pos: { x: 0, y: 0 }, mov: 3 });
    const range = computeMoveRange(map, [scout], scout);

    expect(range.costs.get('1,0')).toBe(2);
    expect(range.costs.get('2,0')).toBe(3);
    /* 2 + 1 = 4 > mov，所以再往前一步就到不了 */
    expect(range.costs.has('3,0')).toBe(false);
    /* Dijkstra 会自动找更便宜的路：0,1 → 1,1 只要 2 点 */
    expect(range.costs.get('1,1')).toBe(2);
  });

  it('水域完全不可通行', () => {
    const map = mapWith([{ x: 1, y: 0, t: 'water' }]);
    const scout = makeUnit({ pos: { x: 0, y: 0 }, mov: 4 });
    const range = computeMoveRange(map, [scout], scout);

    expect(range.costs.has('1,0')).toBe(false);
    expect(range.destinations).not.toContain('1,0');
  });

  it('敌方单位完全阻挡通行，形成天然防线', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 3 });
    const blocker = makeUnit({ id: 'blocker', pos: { x: 1, y: 0 }, team: 'enemy' });
    const range = computeMoveRange(map, [scout, blocker], scout);

    expect(range.costs.has('1,0')).toBe(false);
    /* 绕路需要 4 步，超出移动力 */
    expect(range.costs.has('2,0')).toBe(false);
  });

  it('友军可以穿过，但不能停留', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 3 });
    const ally = makeUnit({ id: 'ally', pos: { x: 1, y: 0 } });
    const range = computeMoveRange(map, [scout, ally], scout);

    expect(range.costs.get('1,0')).toBe(1); /* 可以经过 */
    expect(range.costs.get('2,0')).toBe(2); /* 并且穿得过去 */
    expect(range.destinations).not.toContain('1,0'); /* 不能停 */
    expect(range.destinations).toContain('2,0');
  });

  it('阵亡单位不再占据格子', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 2 });
    const corpse = makeUnit({ id: 'corpse', pos: { x: 1, y: 0 }, team: 'player', hp: 0 });
    const range = computeMoveRange(map, [scout, corpse], scout);

    expect(range.destinations).toContain('1,0');
  });

  it('原地不动始终是一个合法落点（mov=0 时只有它自己）', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ pos: { x: 2, y: 2 }, mov: 0 });
    const range = computeMoveRange(map, [scout], scout);
    expect(range.destinations).toEqual(['2,2']);
  });

  it('destinations 有稳定排序，保证 AI 决策可复现', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ pos: { x: 2, y: 2 }, mov: 2 });
    const a = computeMoveRange(map, [scout], scout).destinations;
    const b = computeMoveRange(map, [scout], scout).destinations;
    expect(a).toEqual(b);
    expect([...a]).toEqual([...a].sort());
  });

  it('移动力越大，可达格单调不减', () => {
    const map = flatMap(7, 7);
    const counts = [0, 1, 2, 3, 4].map((mov) => {
      const unit = makeUnit({ pos: { x: 3, y: 3 }, mov });
      return computeMoveRange(map, [unit], unit).destinations.length;
    });
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });
});

describe('路径回溯', () => {
  it('findPath 返回含起点与终点的完整路径', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ pos: { x: 0, y: 0 }, mov: 3 });
    const range = computeMoveRange(map, [scout], scout);

    expect(findPath(range, { x: 3, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('路径会整体绕开森林，而不是傻走直线', () => {
    /* 中间一行铺 3 格森林：直穿代价 6 + 3 = 9，
       从上一行绕行代价 6 + 2 = 8，所以最短路一定不含森林。 */
    const map = mapWith(
      [
        { x: 2, y: 1, t: 'forest' },
        { x: 3, y: 1, t: 'forest' },
        { x: 4, y: 1, t: 'forest' },
      ],
      7,
      3,
    );
    const scout = makeUnit({ pos: { x: 0, y: 1 }, mov: 8 });
    const range = computeMoveRange(map, [scout], scout);

    const path = findPath(range, { x: 6, y: 1 });
    expect(path).not.toBeNull();

    const keys = (path ?? []).map(key);
    expect(keys[0]).toBe('0,1');
    expect(keys[keys.length - 1]).toBe('6,1');
    for (const forest of ['2,1', '3,1', '4,1']) {
      expect(keys).not.toContain(forest);
    }
  });

  it('不可达返回 null', () => {
    const map = flatMap(5, 5);
    const scout = makeUnit({ pos: { x: 0, y: 0 }, mov: 1 });
    const range = computeMoveRange(map, [scout], scout);
    expect(findPath(range, { x: 4, y: 4 })).toBeNull();
  });
});

describe('控制区（ZOC）', () => {
  it('踏入敌人相邻格就停：那一格能站，但走不过去', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 10 });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 1 }, team: 'enemy' });

    const range = computeMoveRange(map, [hero, foe], hero);

    /* 敌人正对的相邻格能站 */
    expect(range.costs.has('2,1')).toBe(true);
    /* 但它是"停下来的地方" */
    expect(range.stops).toContain('2,1');
    /* 而敌人的**另一侧**到不了 —— 这才是 ZOC 存在的理由。
       没有它的话，(0,1) 可以绕到 (4,1) 背后，防线形同虚设。 */
    expect(range.costs.has('4,1')).toBe(false);
    expect(range.costs.has('5,1')).toBe(false);
  });

  it('起点豁免：已经在敌人身边的单位能走开', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 2, y: 1 }, mov: 3 });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 1 }, team: 'enemy' });

    const range = computeMoveRange(map, [hero, foe], hero);

    /* 起点 (2,1) 本身就在控制区里，但起点不检查 —— 否则被贴住一次就永远动不了 */
    expect(range.stops).toContain('2,1');
    expect(range.costs.has('1,1'), '往左一步').toBe(true);
    expect(range.costs.has('0,1'), '继续往左，畅通无阻').toBe(true);
  });

  it('只有敌人产生控制区：自己的队友不挡自己', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 4 });
    const ally = makeUnit({ id: 'ally', pos: { x: 2, y: 1 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 6, y: 1 }, team: 'enemy' });

    const range = computeMoveRange(map, [hero, ally, foe], hero);

    expect(range.stops).toEqual([]);
    /* 友军那格可以穿过 */
    expect(range.costs.has('3,1')).toBe(true);
    expect(range.costs.has('4,1')).toBe(true);
  });

  it('阵亡的敌人既不挡路也不产生控制区', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 4 });
    const corpse = makeUnit({ id: 'corpse', pos: { x: 3, y: 1 }, team: 'enemy', hp: 0 });

    const range = computeMoveRange(map, [hero, corpse], hero);

    expect(range.stops).toEqual([]);
    /* 尸体脚下现在只是一格普通平原 */
    expect(range.costs.has('3,1')).toBe(true);
    expect(range.costs.has('4,1')).toBe(true);
  });

  it('三个并排的单位能封住整条 5 格宽的通路 —— 这才是它的战术意义', () => {
    const map = flatMap(7, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 2 }, mov: 12 });
    const wall = [1, 2, 3].map((y) =>
      makeUnit({ id: `w${y}`, pos: { x: 3, y }, team: 'enemy' }),
    );

    const range = computeMoveRange(map, [hero, ...wall], hero);

    /* 只挡住 x=3 那三格的话，从上下绕过去就完事了。ZOC 把 x=2 和 x=4 也罩住，
       整条通路才真的封死。 */
    expect(range.costs.has('4,2'), '正后方').toBe(false);
    expect(range.costs.has('4,0'), '上方绕行也过不去').toBe(false);
    expect(range.costs.has('5,0')).toBe(false);
    expect(range.costs.has('3,0'), '最上面那格是控制区，能站但停下').toBe(true);
    expect(range.stops).toContain('3,0');
  });

  it('控制区不改变"可以站"的判定：控制区格子仍然是合法落点', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 10 });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 1 }, team: 'enemy' });

    const range = computeMoveRange(map, [hero, foe], hero);

    /* stops 必须是 destinations 的子集 —— 否则 UI 会画出走不到的"停靠点" */
    for (const k of range.stops) {
      expect(range.destinations).toContain(k);
    }
  });

  it('没有敌人时控制区恒为空', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 6 });
    const range = computeMoveRange(map, [hero], hero);
    expect(range.stops).toEqual([]);
  });
});

describe('地形距离场（AI 用来判断"往哪走才是在靠近"）', () => {
  it('绕过不可通行地形，而不是走直线', () => {
    const map = flatMap(7, 3);
    for (let x = 0; x < 7; x += 1) map.terrain[1][x] = 'water';
    map.terrain[1][6] = 'plain'; // 唯一的缺口在最右边

    const field = terrainDistanceField(map, [{ x: 3, y: 0 }]);

    /* 正下方的格子直线距离只有 1，但隔着水 —— 距离场里根本没有它 */
    expect(field.has('3,1')).toBe(false);
    /* 要到 (3,2) 只能绕到最右边：3 右 + 2 下 + 3 左 = 8。
       直线距离只有 2 —— 这就是不能用曼哈顿距离的原因。 */
    expect(field.get('3,2')).toBe(8);
    expect(manhattan({ x: 3, y: 0 }, { x: 3, y: 2 })).toBe(2);
  });

  it('森林按移动力消耗算，不是按格数', () => {
    const map = mapWith([{ x: 1, y: 0, t: 'forest' }]);
    const field = terrainDistanceField(map, [{ x: 0, y: 0 }]);
    expect(field.get('1,0')).toBe(2);
    expect(field.get('2,0')).toBe(3);
  });

  it('不可通行的格子在距离场里没有条目（而不是 0 或 Infinity）', () => {
    const map = flatMap(3, 3);
    map.terrain[1][1] = 'water';
    const field = terrainDistanceField(map, [{ x: 0, y: 0 }]);
    expect(field.has('1,1')).toBe(false);
  });

  it('多起点：每个格子取最近的那个起点', () => {
    const map = flatMap(9, 1);
    const field = terrainDistanceField(map, [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
    ]);
    expect(field.get('5,0')).toBe(3);
    expect(field.get('0,0')).toBe(0);
    expect(field.get('8,0')).toBe(0);
  });

  it('起点落在不可通行地形上时被忽略，不会污染距离场', () => {
    const map = flatMap(3, 3);
    map.terrain[1][1] = 'water';
    const field = terrainDistanceField(map, [{ x: 1, y: 1 }]);
    expect(field.size).toBe(0);
  });
});
