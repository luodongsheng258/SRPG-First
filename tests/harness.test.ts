import { describe, expect, it } from 'vitest';

import mapRaw from '../data/maps/plain-01.json';
import skillsRaw from '../data/skills.json';
import unitsRaw from '../data/units.json';
import weaponsRaw from '../data/weapons.json';

import { autoBattle, encodeState, loadBattle } from '../src/core';

/**
 * 集成测试：不开引擎、不开窗口，让 AI 自动把整局打完。
 * 这正是"逻辑与渲染分离"最大的回报 —— 一秒钟能跑几百局。
 */
describe('headless 自动对战', () => {
  const build = (seed = 424242) => loadBattle(mapRaw, unitsRaw, weaponsRaw, skillsRaw, seed);

  it('相同种子 → 逐字节相同的终局（可复现）', () => {
    expect(autoBattle(build(), 50)).toEqual(autoBattle(build(), 50));
  });

  it('autoBattle 是纯函数，不会改动传入的 state', () => {
    const state = build();
    const snapshot = encodeState(state);
    autoBattle(state, 50);
    expect(encodeState(state)).toBe(snapshot);
  });

  it('对局会产生实际动作，且不会超出 maxTurns', () => {
    const outcome = autoBattle(build(), 50);
    expect(outcome.actions).toBeGreaterThan(0);
    expect(outcome.turn).toBeLessThanOrEqual(51);
    expect(outcome.playerAlive).toBeGreaterThanOrEqual(0);
    expect(outcome.enemyAlive).toBeGreaterThanOrEqual(0);
  });

  it('50 回合内能分出胜负（双方 AI 不会无限僵持）', () => {
    /* ⚠️ 如果这条挂了，说明 AI 卡住了 —— 这是真实 bug，不是测试不稳定。
       排查顺序：
         1. core/ai.ts 的 isPointless（是不是所有交换都被判定为"必死"而放弃）
         2. core/ai.ts 的 planAdvance（是不是找不到更近的落点就原地不动）
         3. 地图是不是被水域切成了两块，双方根本走不到一起
       用 `pnpm sim` 可以看到胜率和平均回合数。 */
    const outcome = autoBattle(build(), 50);
    expect(outcome.phase).not.toBe('playing');
  });

  it('多个种子都能收敛，不存在特定种子下的死循环', () => {
    const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    for (const seed of seeds) {
      const outcome = autoBattle(build(seed), 50);
      expect(outcome.phase, `seed=${seed} 没有收敛（turn=${outcome.turn}）`).not.toBe('playing');
    }
  });

  it('关卡不是一边倒：胜负都会出现（平衡回归）', () => {
    /* 这条是「数值平衡」的回归测试。
       调平衡之前的初始布阵是我方 100% 胜、剑士 800 次一次没死 ——
       那种关卡里玩家的决策毫无意义。任何一边倒到 0% 或 100%，这条都会拦下来。

       精度要求不高，所以只跑 60 局；要看详细数据和响应曲线用
       `pnpm sim` / `pnpm sweep`。 */
    let won = 0;
    let lost = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const outcome = autoBattle(build(seed), 50);
      if (outcome.phase === 'won') won += 1;
      if (outcome.phase === 'lost') lost += 1;
    }
    expect(won, '我方一局都没赢 —— 关卡弱得离谱').toBeGreaterThan(0);
    expect(lost, '我方一局都没输 —— 敌人毫无威胁').toBeGreaterThan(0);
  });
});
