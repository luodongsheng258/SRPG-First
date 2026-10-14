/**
 * 确定性随机数。
 *
 * 关键设计：**没有任何内部可变状态**。
 * 随机数只由 (seed, cursor) 两个数字决定，而 cursor 存在 BattleState 里。
 * 好处：
 *   1. state 依然可以 JSON 序列化 → 存档/回放/联机都免费
 *   2. 同一个 seed + 同一串操作 = 完全一样的结果 → 单元测试可以断言"必中/必失"
 *   3. headless 批量模拟可以复现任何一局
 *
 * 如果哪天要换算法，只改这一个文件，注意会改变已有存档的回放结果。
 */

/** splitmix32 的 finalizer，把整数彻底打散 */
function mix32(input: number): number {
  let t = input | 0;
  t = (t + 0x9e3779b9) | 0;
  t ^= t >>> 16;
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

export interface RollResult {
  /** [0, 1) */
  value: number;
  /** 推进后的游标，必须写回 state.rngCursor */
  cursor: number;
}

/** 掷一个 [0, 1) 的随机数，并把游标推进 1 */
export function roll(seed: number, cursor: number): RollResult {
  const value = mix32(seed + Math.imul(cursor, 0x85ebca6b)) / 0x100000000;
  return { value, cursor: cursor + 1 };
}

export interface PercentRollResult {
  success: boolean;
  rollValue: number;
  cursor: number;
}

/**
 * 百分比命中判定。
 * @param chance 命中率，0~100 的整数（含端点）
 */
export function rollPercent(seed: number, cursor: number, chance: number): PercentRollResult {
  const r = roll(seed, cursor);
  /* 用 < 而不是 <=：chance=100 时必然命中，chance=0 时必然落空 */
  return {
    success: r.value * 100 < chance,
    rollValue: r.value,
    cursor: r.cursor,
  };
}
