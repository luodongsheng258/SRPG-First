import { describe, expect, it } from 'vitest';

import {
  applyRoster,
  emptyProgress,
  exportRoster,
  isCleared,
  isUnlocked,
  levelNumber,
  nextLevel,
  parseCampaign,
  parseProgress,
  recordClear,
  type Campaign,
} from '../src/core';
import { flatMap, makeState, makeUnit } from './fixtures';

const CAMPAIGN: Campaign = {
  id: 'test-campaign',
  name: '测试战役',
  levels: [
    { id: 'a', name: '甲关', brief: '第一关' },
    { id: 'b', name: '乙关', brief: '第二关' },
    { id: 'c', name: '丙关', brief: '第三关' },
  ],
};

describe('解锁规则', () => {
  it('第一关永远开放', () => {
    expect(isUnlocked(emptyProgress(), CAMPAIGN, 'a')).toBe(true);
  });

  it('后面的关卡必须前一关已通关', () => {
    const fresh = emptyProgress();
    expect(isUnlocked(fresh, CAMPAIGN, 'b')).toBe(false);
    expect(isUnlocked(fresh, CAMPAIGN, 'c')).toBe(false);

    const afterA = recordClear(fresh, 'a', { turns: 6, survivors: 3 });
    expect(isUnlocked(afterA, CAMPAIGN, 'b')).toBe(true);
    expect(isUnlocked(afterA, CAMPAIGN, 'c')).toBe(false);
  });

  it('跳关没用：只通了第一关，第三关仍然锁着', () => {
    const skipped = recordClear(emptyProgress(), 'a', { turns: 6, survivors: 3 });
    expect(isUnlocked(skipped, CAMPAIGN, 'c')).toBe(false);
  });

  it('未知关卡一律视为不可用', () => {
    expect(isUnlocked(emptyProgress(), CAMPAIGN, '不存在')).toBe(false);
  });
});

describe('战绩记录', () => {
  it('第一次通关会被记下来', () => {
    const progress = recordClear(emptyProgress(), 'a', { turns: 7, survivors: 2 });
    expect(isCleared(progress, 'a')).toBe(true);
    expect(progress.best.a).toEqual({ turns: 7, survivors: 2 });
  });

  it('只保留更好的战绩：先看残存人数', () => {
    let progress = recordClear(emptyProgress(), 'a', { turns: 5, survivors: 2 });
    /* 回合更少但死人更多 —— 不算更好 */
    progress = recordClear(progress, 'a', { turns: 3, survivors: 1 });
    expect(progress.best.a).toEqual({ turns: 5, survivors: 2 });
  });

  it('残存人数相同时看回合数，少的更优', () => {
    let progress = recordClear(emptyProgress(), 'a', { turns: 9, survivors: 3 });
    progress = recordClear(progress, 'a', { turns: 7, survivors: 3 });
    expect(progress.best.a).toEqual({ turns: 7, survivors: 3 });
  });

  it('打得更差不会覆盖好成绩', () => {
    let progress = recordClear(emptyProgress(), 'a', { turns: 4, survivors: 4 });
    progress = recordClear(progress, 'a', { turns: 12, survivors: 1 });
    expect(progress.best.a).toEqual({ turns: 4, survivors: 4 });
  });

  it('重复通关不会把 id 记两遍', () => {
    let progress = recordClear(emptyProgress(), 'a', { turns: 5, survivors: 3 });
    progress = recordClear(progress, 'a', { turns: 4, survivors: 4 });
    expect(progress.cleared).toEqual(['a']);
  });

  it('是纯函数：原对象一字未改', () => {
    const before = emptyProgress();
    const snapshot = JSON.stringify(before);
    recordClear(before, 'a', { turns: 5, survivors: 3 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('进度可以 JSON 往返', () => {
    const progress = recordClear(emptyProgress(), 'b', { turns: 8, survivors: 2 });
    expect(JSON.parse(JSON.stringify(progress))).toEqual(progress);
  });
});

describe('进度解析（存档是外部输入，必须宽容）', () => {
  it('非对象退化成空进度', () => {
    expect(parseProgress(null)).toEqual(emptyProgress());
    expect(parseProgress('坏数据')).toEqual(emptyProgress());
    expect(parseProgress(42)).toEqual(emptyProgress());
  });

  it('字段类型不对的部分被丢掉，而不是整份崩掉', () => {
    const parsed = parseProgress({
      cleared: ['a', 99, null, 'b'],
      best: {
        a: { turns: 5, survivors: 3 },
        b: { turns: 'x', survivors: 1 },
        c: { turns: 2 },
      },
    });
    expect(parsed.cleared).toEqual(['a', 'b']);
    expect(parsed.best).toEqual({ a: { turns: 5, survivors: 3 } });
  });

  it('缺字段时给出空进度而不是崩掉', () => {
    expect(parseProgress({})).toEqual({ cleared: [], best: {}, roster: {} });
  });

  it('名册：属性缺一项就整条丢掉，而不是留半个单位', () => {
    const parsed = parseProgress({
      roster: {
        'soldier#0': {
          level: 3,
          exp: 40,
          stats: { maxHp: 26, atk: 7, def: 4, spd: 6, skill: 6 },
        },
        'archer#0': { level: 2, exp: 10, stats: { maxHp: 21, atk: 5 } },
        'mage#0': { level: 0, exp: 0, stats: { maxHp: 18, atk: 8, def: 1, spd: 5, skill: 8 } },
      },
    });

    expect(Object.keys(parsed.roster)).toEqual(['soldier#0']);
    expect(parsed.roster['soldier#0']?.level).toBe(3);
  });
});

describe('战役解析（自己打包的内容，必须严格）', () => {
  it('合法战役能解析', () => {
    expect(parseCampaign(CAMPAIGN).levels).toHaveLength(3);
  });

  it('关卡 id 重复直接报错', () => {
    expect(() =>
      parseCampaign({
        ...CAMPAIGN,
        levels: [
          { id: 'a', name: '甲', brief: 'x' },
          { id: 'a', name: '乙', brief: 'y' },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('缺字段 / 层数不对会报出具体位置', () => {
    expect(() => parseCampaign({ id: 'x', name: 'y', levels: [] })).toThrow(/非空数组/);
    expect(() => parseCampaign({ id: 'x', name: 'y', levels: [{ id: 'a' }] })).toThrow(
      /levels\[0\]\.name/,
    );
    expect(() => parseCampaign(null)).toThrow(/顶层/);
  });
});

describe('名册（跨关卡的队伍成长）', () => {
  const level1 = () =>
    makeUnit({
      id: 'soldier-0',
      slot: 'soldier#0',
      pos: { x: 0, y: 0 },
      level: 1,
      hp: 20,
      maxHp: 24,
      atk: 6,
    });

  it('导出时会记下等级、经验和五项属性', () => {
    const hero = { ...level1(), level: 3, exp: 40 };
    const roster = exportRoster(makeState(flatMap(3, 3), [hero]), {});

    expect(roster['soldier#0']).toEqual({
      level: 3,
      exp: 40,
      stats: { maxHp: 24, atk: 6, def: 2, spd: 5, skill: 5 },
    });
  });

  it('只记我方，敌人不进名册', () => {
    const hero = level1();
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy', slot: 'bandit#0' });
    const roster = exportRoster(makeState(flatMap(3, 3), [hero, foe]), {});

    expect(Object.keys(roster)).toEqual(['soldier#0']);
  });

  it('套用时只影响我方，开场 HP 补满', () => {
    const hero = { ...level1(), hp: 3 };
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy', slot: 'bandit#0' });
    const roster = {
      'soldier#0': {
        level: 4,
        exp: 20,
        stats: { maxHp: 30, atk: 9, def: 4, spd: 6, skill: 7 },
      },
      'bandit#0': { level: 9, exp: 0, stats: { maxHp: 99, atk: 99, def: 99, spd: 99, skill: 99 } },
    };

    const state = applyRoster(makeState(flatMap(3, 3), [hero, foe]), roster);
    const applied = state.units.find((u) => u.id === 'soldier-0');
    const enemy = state.units.find((u) => u.id === 'foe');

    expect(applied?.level).toBe(4);
    expect(applied?.exp).toBe(20);
    expect(applied?.atk).toBe(9);
    /* 上一关的残血不该滚到下一关 */
    expect(applied?.hp).toBe(30);
    /* 敌人不受名册影响 —— 它们的等级由地图的 spawn.level 决定 */
    expect(enemy?.level).toBe(1);
    expect(enemy?.atk).not.toBe(99);
  });

  it('名册里没有的角色保持模板数值（新加入的队友）', () => {
    const rookie = makeUnit({ id: 'knight-0', slot: 'knight#0', pos: { x: 0, y: 0 }, atk: 7 });
    const state = applyRoster(makeState(flatMap(3, 3), [rookie]), {
      'soldier#0': { level: 5, exp: 0, stats: { maxHp: 30, atk: 9, def: 4, spd: 6, skill: 7 } },
    });

    expect(state.units[0]?.level).toBe(1);
    expect(state.units[0]?.atk).toBe(7);
  });

  it('导出 → 套用 一个来回，属性和等级逐字节不变', () => {
    const hero = { ...level1(), level: 4, exp: 55, atk: 9, def: 4 };
    const roster = exportRoster(makeState(flatMap(3, 3), [hero]), {});

    const fresh = makeUnit({ id: 'soldier-0', slot: 'soldier#0', pos: { x: 0, y: 0 } });
    const applied = applyRoster(makeState(flatMap(3, 3), [fresh]), roster).units[0];

    expect({
      level: applied?.level,
      exp: applied?.exp,
      maxHp: applied?.maxHp,
      atk: applied?.atk,
      def: applied?.def,
      spd: applied?.spd,
      skill: applied?.skill,
    }).toEqual({ level: 4, exp: 55, maxHp: 24, atk: 9, def: 4, spd: 5, skill: 5 });
  });

  it('进度是纯函数，名册也跟着一起复制', () => {
    const before = emptyProgress();
    const after = recordClear(before, 'a', { turns: 5, survivors: 3 });
    expect(before.roster).toEqual({});
    expect(after.roster).toEqual({});
  });
});

describe('顺序查询', () => {
  it('levelNumber 从 1 开始，找不到返回 0', () => {
    expect(levelNumber(CAMPAIGN, 'a')).toBe(1);
    expect(levelNumber(CAMPAIGN, 'c')).toBe(3);
    expect(levelNumber(CAMPAIGN, '不存在')).toBe(0);
  });

  it('nextLevel 走到最后一关返回 null', () => {
    expect(nextLevel(CAMPAIGN, 'a')?.id).toBe('b');
    expect(nextLevel(CAMPAIGN, 'c')).toBeNull();
    expect(nextLevel(CAMPAIGN, '不存在')).toBeNull();
  });
});
