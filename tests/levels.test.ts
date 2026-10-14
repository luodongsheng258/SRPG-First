import { describe, expect, it } from 'vitest';

import { LEVELS } from '../src/game/levels';

/**
 * 关卡数据的集成测试。
 *
 * `LevelRegistry` 在构造时就会把所有地图解析并交叉校验一遍，
 * 所以光是 `import` 这个模块，就已经验证了：
 *   - campaign.json 的每一条都指向一张存在的地图
 *   - 每张地图的行列数、地形名、出生点位置都合法
 *
 * 剩下要断言的是**内容层面**的不变式：不能有关卡只有一方单位、
 * 出生点不能重叠 —— 那些 loader 管不到，但会让关卡没法玩。
 */
describe('关卡注册表', () => {
  it('战役里至少有一关（导入即校验了地图文件的存在与合法性）', () => {
    const levels = LEVELS.list();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels).toHaveLength(LEVELS.campaign.levels.length);
  });

  it('每张地图的尺寸和声明一致，出生点落在图内', () => {
    for (const level of LEVELS.list()) {
      const { map, spawns } = level.scenario;
      expect(map.terrain, `关卡 ${level.entry.id} 的行数`).toHaveLength(map.height);
      for (const row of map.terrain) {
        expect(row, `关卡 ${level.entry.id} 的列数`).toHaveLength(map.width);
      }
      for (const spawn of spawns) {
        expect(spawn.x, `关卡 ${level.entry.id} 出生点 x`).toBeGreaterThanOrEqual(0);
        expect(spawn.x).toBeLessThan(map.width);
        expect(spawn.y, `关卡 ${level.entry.id} 出生点 y`).toBeGreaterThanOrEqual(0);
        expect(spawn.y).toBeLessThan(map.height);
      }
    }
  });

  it('每一关双方都有单位，而且能真的开出一局', () => {
    for (const level of LEVELS.list()) {
      const state = LEVELS.create(level.entry.id);
      const players = state.units.filter((u) => u.team === 'player');
      const enemies = state.units.filter((u) => u.team === 'enemy');

      expect(players.length, `关卡 ${level.entry.id} 没有我方单位`).toBeGreaterThan(0);
      expect(enemies.length, `关卡 ${level.entry.id} 没有敌方单位`).toBeGreaterThan(0);
      expect(state.phase).toBe('playing');
      expect(state.activeTeam).toBe('player');
      expect(state.turn).toBe(1);
    }
  });

  it('每一关的单位 id 都唯一', () => {
    for (const level of LEVELS.list()) {
      const state = LEVELS.create(level.entry.id);
      expect(new Set(state.units.map((u) => u.id)).size, `关卡 ${level.entry.id}`).toBe(
        state.units.length,
      );
    }
  });

  it('同一关用同一个种子开出来的局面完全一致（模拟器要靠这个复现）', () => {
    for (const level of LEVELS.list()) {
      const a = LEVELS.create(level.entry.id, 999);
      const b = LEVELS.create(level.entry.id, 999);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('关卡序号从 1 连续递增', () => {
    LEVELS.list().forEach((level, index) => {
      expect(level.number).toBe(index + 1);
    });
  });

  it('未知关卡会抛错而不是静默返回空', () => {
    expect(() => LEVELS.require('根本没有这一关')).toThrow(/未知关卡/);
    expect(LEVELS.find('根本没有这一关')).toBeNull();
    expect(LEVELS.has('根本没有这一关')).toBe(false);
  });
});
