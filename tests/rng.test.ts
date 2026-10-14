import { describe, expect, it } from 'vitest';

import { roll, rollPercent } from '../src/core';

describe('确定性随机数', () => {
  it('同一 (seed, cursor) 永远得到同一个值', () => {
    expect(roll(123, 5)).toEqual(roll(123, 5));
    expect(roll(0, 0)).toEqual(roll(0, 0));
  });

  it('不同 cursor 得到不同值，且游标递增', () => {
    const values = Array.from({ length: 64 }, (_, i) => roll(7, i).value);
    expect(new Set(values).size).toBe(64);
    expect(roll(7, 3).cursor).toBe(4);
  });

  it('不同 seed 得到不同序列', () => {
    const seq = (seed: number) => Array.from({ length: 16 }, (_, i) => roll(seed, i).value);
    expect(seq(1)).not.toEqual(seq(2));
    expect(seq(0)).not.toEqual(seq(1));
    expect(seq(12345)).not.toEqual(seq(54321));
  });

  it('值域严格落在 [0, 1)', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = roll(2026, i).value;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('分布大致均匀：10 个桶各占 10% ± 40%', () => {
    const buckets = Array.from({ length: 10 }, () => 0);
    const total = 30000;
    for (let i = 0; i < total; i += 1) {
      buckets[Math.floor(roll(99, i).value * 10)] += 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(total * 0.06);
      expect(count).toBeLessThan(total * 0.14);
    }
  });
});

describe('百分比判定', () => {
  it('chance=100 必中，chance=0 必不中', () => {
    for (let i = 0; i < 300; i += 1) {
      expect(rollPercent(5, i, 100).success).toBe(true);
      expect(rollPercent(5, i, 0).success).toBe(false);
    }
  });

  it('命中率越高，实际命中比例越高（用 4000 次采样）', () => {
    const rate = (chance: number) => {
      let hits = 0;
      for (let i = 0; i < 4000; i += 1) {
        if (rollPercent(11, i, chance).success) hits += 1;
      }
      return hits / 4000;
    };
    expect(rate(20)).toBeLessThan(rate(50));
    expect(rate(50)).toBeLessThan(rate(80));
    expect(rate(50)).toBeGreaterThan(0.4);
    expect(rate(50)).toBeLessThan(0.6);
  });

  it('只推进游标，不碰种子', () => {
    const result = rollPercent(3, 0, 100);
    expect(result.cursor).toBe(1);
    expect(result.success).toBe(true);
    expect(result.rollValue).toBe(roll(3, 0).value);
  });
});
