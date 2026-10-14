import { describe, expect, it } from 'vitest';

import {
  applyRewardStats,
  awardExp,
  EXP_ON_HIT,
  EXP_ON_KILL,
  EXP_ON_MISS,
  EXP_PER_LEVEL,
  expFromStrike,
  gainsText,
  hpAfterCombat,
  MAX_LEVEL,
  rollGrowths,
  statsOf,
} from '../src/core';
import { makeUnit } from './fixtures';
import type { Unit } from '../src/core';

/** 什么都不涨：用来把"经验累加"和"属性成长"两件事分开测 */
const NO_GROWTH = { maxHp: 0, atk: 0, def: 0, spd: 0, skill: 0 };
/** 必定全涨：用来断言成长的每一支路 */
const ALL_GROWTH = { maxHp: 100, atk: 100, def: 100, spd: 100, skill: 100 };

/**
 * 默认站 (0,0)、默认不成长的单位。
 * `pos` 必须放在最后 —— makeUnit 要求它，而调用方通常不关心站位。
 */
function hero(patch: Partial<Unit> = {}): Unit {
  const pos = patch.pos ?? { x: 0, y: 0 };
  return makeUnit({ growths: NO_GROWTH, ...patch, pos });
}

describe('经验公式', () => {
  it('命中、击杀、落空各自的基础经验', () => {
    expect(expFromStrike(1, 1, true, false)).toBe(EXP_ON_HIT);
    expect(expFromStrike(1, 1, true, true)).toBe(EXP_ON_HIT + EXP_ON_KILL);
    /* 落空也给 1 点 —— 让"这一下打不动"的回合不至于完全白跑 */
    expect(expFromStrike(1, 1, false, false)).toBe(EXP_ON_MISS);
  });

  it('等级差**只往上**加成：打比自己弱的敌人不倒扣', () => {
    const even = expFromStrike(3, 3, true, false);
    /* 敌人高 2 级 → 每次结算多给 */
    expect(expFromStrike(3, 5, true, false)).toBeGreaterThan(even);
    /* 敌人低 5 级 → 和同级完全一样，不能倒扣 */
    expect(expFromStrike(6, 1, true, false)).toBe(even);
  });
});

describe('成长掷骰', () => {
  it('成长率 100 时五项必涨，且消耗五个游标', () => {
    const result = rollGrowths(ALL_GROWTH, 12345, 0);
    expect(result.gains).toEqual({ maxHp: 1, atk: 1, def: 1, spd: 1, skill: 1 });
    expect(result.cursor).toBe(5);
  });

  it('成长率 0 的项**不掷** —— 不消耗游标', () => {
    const result = rollGrowths(NO_GROWTH, 12345, 7);
    expect(result.gains).toEqual({});
    expect(result.cursor).toBe(7);

    /* 只有一项非零时也只推进一个游标 */
    const partial = rollGrowths({ ...NO_GROWTH, atk: 100 }, 12345, 7);
    expect(partial.gains).toEqual({ atk: 1 });
    expect(partial.cursor).toBe(8);
  });

  it('同种子必然同结果 —— 否则模拟器和回放全部失效', () => {
    const a = rollGrowths(ALL_GROWTH, 999, 3);
    const b = rollGrowths(ALL_GROWTH, 999, 3);
    expect(a).toEqual(b);

    /* 换个种子就应该不一样（在全 100% 上测不出来，用 50% 的） */
    const half = { maxHp: 50, atk: 50, def: 50, spd: 50, skill: 50 };
    const seeds = Array.from({ length: 40 }, (_, i) => rollGrowths(half, i, 0));
    const signatures = new Set(seeds.map((r) => JSON.stringify(r.gains)));
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('概率大致符合声明（成长率 50% 跑 2000 次应在 45%~55%）', () => {
    const half = { maxHp: 50, atk: 50, def: 50, spd: 50, skill: 50 };
    let hits = 0;
    for (let seed = 0; seed < 2000; seed += 1) {
      if (rollGrowths(half, seed, 0).gains.atk === 1) hits += 1;
    }
    const rate = hits / 2000;
    expect(rate).toBeGreaterThan(0.45);
    expect(rate).toBeLessThan(0.55);
  });
});

describe('经验结算与升级', () => {
  it('经验不满就不升级', () => {
    const award = awardExp(hero({ exp: 10 }), 40, 1, 0);
    expect(award.reward.level).toBe(1);
    expect(award.reward.exp).toBe(50);
    expect(award.reward.levelUps).toEqual([]);
    expect(award.cursor).toBe(0);
  });

  it('攒满就升级，多出来的经验留到下一级', () => {
    const award = awardExp(hero({ exp: 90 }), 20, 1, 0);
    expect(award.reward.level).toBe(2);
    expect(award.reward.exp).toBe(10);
    expect(award.reward.levelUps).toHaveLength(1);
    expect(award.reward.levelUps[0]?.level).toBe(2);
  });

  it('一次战斗可以连升几级', () => {
    /* 90 + 250 = 340 → 升到 4 级，余 40 */
    const award = awardExp(hero({ exp: 90 }), 250, 1, 0);
    expect(award.reward.level).toBe(4);
    expect(award.reward.exp).toBe(40);
    expect(award.reward.levelUps.map((r) => r.level)).toEqual([2, 3, 4]);
  });

  it('升级会把成长累加进属性', () => {
    const unit = hero({ growths: ALL_GROWTH });
    const award = awardExp(unit, EXP_PER_LEVEL, 1, 0);

    expect(award.reward.stats).toEqual({
      maxHp: unit.maxHp + 1,
      atk: unit.atk + 1,
      def: unit.def + 1,
      spd: unit.spd + 1,
      skill: unit.skill + 1,
    });
    /* 每级五次成长掷骰 */
    expect(award.cursor).toBe(5);
  });

  it('满级之后经验不再累积', () => {
    const award = awardExp(hero({ level: MAX_LEVEL, exp: 0 }), 500, 1, 0);
    expect(award.reward.level).toBe(MAX_LEVEL);
    expect(award.reward.exp).toBe(0);
    expect(award.reward.levelUps).toEqual([]);
  });

  it('不改原对象（纯函数）', () => {
    const unit = hero({ exp: 90 });
    const snapshot = JSON.stringify(unit);
    awardExp(unit, 50, 1, 0);
    expect(JSON.stringify(unit)).toBe(snapshot);
  });
});

describe('战后 HP', () => {
  it('没有奖励时就取打击结果，并被上限夹住', () => {
    const unit = hero({ hp: 20, maxHp: 20 });
    expect(hpAfterCombat(unit, undefined, 12)).toBe(12);
    expect(hpAfterCombat(unit, undefined, 999)).toBe(20);
  });

  it('升级涨了生命上限时，当前 HP 同步补上多出来的那一份', () => {
    const unit = hero({ hp: 20, maxHp: 20, growths: ALL_GROWTH });
    const award = awardExp(unit, EXP_PER_LEVEL, 1, 0);

    /* 上限 +1 → 当前血也 +1，否则"涨了上限但血没动"会让玩家觉得白涨 */
    expect(hpAfterCombat(unit, award.reward, 12)).toBe(13);
    /* 补完之后仍然不能超过新上限 */
    expect(hpAfterCombat(unit, award.reward, 20)).toBe(21);
  });

  it('applyRewardStats 不碰 HP —— 战后 HP 只有一个来源', () => {
    const unit = hero({ hp: 7, maxHp: 20, growths: ALL_GROWTH });
    const award = awardExp(unit, EXP_PER_LEVEL, 1, 0);
    const next = applyRewardStats(unit, award.reward);

    expect(next.hp).toBe(7);
    expect(next.level).toBe(2);
    expect(next.maxHp).toBe(21);
    expect(statsOf(next).maxHp).toBe(21);
  });
});

describe('升级文案', () => {
  it('列出涨了的项；一项没涨时说清楚', () => {
    expect(gainsText({ maxHp: 1, atk: 1 })).toBe('HP+1 攻+1');
    expect(gainsText({})).toBe('……什么都没涨');
  });
});
