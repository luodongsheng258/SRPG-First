import { describe, expect, it } from 'vitest';

import { inBounds, key, manhattan, neighbors, parseKey, terrainAt, tilesInRange } from '../src/core';
import { flatMap } from './fixtures';

describe('网格基础', () => {
  it('曼哈顿距离', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
    expect(manhattan({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });

  it('key 与 parseKey 互为逆运算', () => {
    expect(parseKey(key({ x: 3, y: 7 }))).toEqual({ x: 3, y: 7 });
  });

  it('inBounds 正确处理四个边界', () => {
    const map = flatMap(4, 3);
    expect(inBounds(map, { x: 0, y: 0 })).toBe(true);
    expect(inBounds(map, { x: 3, y: 2 })).toBe(true);
    expect(inBounds(map, { x: 4, y: 2 })).toBe(false);
    expect(inBounds(map, { x: 3, y: 3 })).toBe(false);
    expect(inBounds(map, { x: -1, y: 0 })).toBe(false);
  });

  it('四方向邻居：角落 2 个，内部 4 个', () => {
    const map = flatMap(5, 5);
    expect(neighbors(map, { x: 0, y: 0 })).toHaveLength(2);
    expect(neighbors(map, { x: 2, y: 2 })).toHaveLength(4);
  });

  it('terrainAt 越界抛出可读错误', () => {
    const map = flatMap(2, 2);
    expect(() => terrainAt(map, { x: 2, y: 0 })).toThrow(/越界/);
  });
});

describe('攻击范围', () => {
  it('射程 [1,1] = 正交四邻格', () => {
    const map = flatMap(6, 6);
    const tiles = tilesInRange(map, { x: 3, y: 3 }, [1, 1]);
    expect(tiles.map(key).sort()).toEqual(['2,3', '3,2', '3,4', '4,3']);
  });

  it('射程 [2,2] = 曼哈顿距离恰好 2 的 8 格（含斜角）', () => {
    const map = flatMap(9, 9);
    const keys = tilesInRange(map, { x: 4, y: 4 }, [2, 2]).map(key);
    expect(keys).toHaveLength(8);
    expect(keys).toContain('5,5'); /* 斜角 */
    expect(keys).not.toContain('4,5'); /* 距离 1，不在区间内 */
    expect(keys).not.toContain('4,4'); /* 距离 0，不在区间内 */
  });

  it('射程 [1,2] 是环 1 加环 2，共 12 格', () => {
    const map = flatMap(9, 9);
    const keys = tilesInRange(map, { x: 4, y: 4 }, [1, 2]).map(key);
    expect(keys).toHaveLength(12);
  });

  it('贴边时范围自动裁剪，不会越界', () => {
    const map = flatMap(5, 5);
    const keys = tilesInRange(map, { x: 0, y: 0 }, [1, 2]).map(key);
    expect(keys.sort()).toEqual(['0,1', '0,2', '1,0', '1,1', '2,0']);
  });
});
