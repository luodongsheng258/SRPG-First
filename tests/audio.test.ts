import { describe, expect, it } from 'vitest';

import { SFX, SFX_NAMES, type SfxRecipe } from '../src/game/audio';

/**
 * 音效的测试。
 *
 * 没法断言"好不好听" —— 那是耳朵的事。
 * 但配方表是纯数据，可以断言它**合法**以及**相对轻重符合设计意图**：
 * 击杀要比普通命中重、落空要比命中轻、战斗音不能被交互音盖过。
 * 这些正是改配方时最容易不小心弄反的东西。
 */

interface Voice {
  dur: number;
  gain: number;
  freq: number;
  to?: number;
  delay?: number;
}

function eachVoice(recipe: SfxRecipe, visit: (voice: Voice) => void): void {
  for (const tone of recipe.tones ?? []) visit(tone);
  for (const noise of recipe.noise ?? []) visit(noise);
}

function voiceCount(recipe: SfxRecipe): number {
  return (recipe.tones?.length ?? 0) + (recipe.noise?.length ?? 0);
}

/** 配方的"能量"：所有发声的 音量 × 时长 之和 */
function energy(recipe: SfxRecipe): number {
  let sum = 0;
  eachVoice(recipe, (v) => {
    sum += v.gain * v.dur;
  });
  return sum;
}

describe('配方表结构', () => {
  it('音名不重复', () => {
    expect(new Set(SFX_NAMES).size).toBe(SFX_NAMES.length);
  });

  it('每个音名都至少有一个发声', () => {
    for (const name of SFX_NAMES) {
      expect(voiceCount(SFX[name]), `${name} 是哑的`).toBeGreaterThan(0);
    }
  });
});

describe('配方表合法性', () => {
  it('音量落在 (0, 0.5]，不会把玩家震聋', () => {
    for (const name of SFX_NAMES) {
      eachVoice(SFX[name], (v) => {
        expect(v.gain, `${name} 音量 ${v.gain} 越界`).toBeGreaterThan(0);
        expect(v.gain, `${name} 音量 ${v.gain} 越界`).toBeLessThanOrEqual(0.5);
      });
    }
  });

  it('单个发声时长落在 (0, 1.5] 秒', () => {
    for (const name of SFX_NAMES) {
      eachVoice(SFX[name], (v) => {
        expect(v.dur, `${name} 时长 ${v.dur} 越界`).toBeGreaterThan(0);
        expect(v.dur, `${name} 时长 ${v.dur} 越界`).toBeLessThanOrEqual(1.5);
      });
    }
  });

  it('频率恒为正 —— 指数滑音碰到 0 或负数会直接抛异常', () => {
    for (const name of SFX_NAMES) {
      eachVoice(SFX[name], (v) => {
        expect(v.freq, `${name} 起始频率非法`).toBeGreaterThan(0);
        if (v.to !== undefined) {
          expect(v.to, `${name} 结束频率非法`).toBeGreaterThan(0);
        }
      });
    }
  });

  it('延迟非负，且整体不会拖过 1.5 秒', () => {
    for (const name of SFX_NAMES) {
      eachVoice(SFX[name], (v) => {
        const delay = v.delay ?? 0;
        expect(delay, `${name} 延迟为负`).toBeGreaterThanOrEqual(0);
        expect(delay + v.dur, `${name} 拖得太长`).toBeLessThanOrEqual(1.5);
      });
    }
  });
});

describe('轻重的设计意图', () => {
  it('击杀明显比普通命中更重', () => {
    expect(energy(SFX.lethal)).toBeGreaterThan(energy(SFX.hit) * 1.5);
  });

  it('会心音介于普通命中和击杀之间', () => {
    expect(energy(SFX.crit)).toBeGreaterThan(energy(SFX.hit));
    expect(energy(SFX.crit)).toBeLessThan(energy(SFX.lethal));
  });

  it('落空比命中轻得多 —— 打空了不该听着像打中了', () => {
    expect(energy(SFX.miss)).toBeLessThan(energy(SFX.hit) * 0.5);
  });

  it('战斗音比交互音更突出，不会被"嘀"一声盖过', () => {
    expect(energy(SFX.hit)).toBeGreaterThan(energy(SFX.select));
    expect(energy(SFX.hit)).toBeGreaterThan(energy(SFX.confirm));
  });

  it('胜利比普通换阶段更隆重', () => {
    expect(energy(SFX.win)).toBeGreaterThan(energy(SFX.phase));
  });

  it('拒绝音不响过命中音', () => {
    expect(energy(SFX.deny)).toBeLessThan(energy(SFX.hit));
  });
});
