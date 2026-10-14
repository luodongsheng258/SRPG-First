import { describe, expect, it } from 'vitest';

import { checkVictory, objectiveText, victoryText } from '../src/core';
import type { Objective } from '../src/core';
import { flatMap, makeState, makeUnit } from './fixtures';

/**
 * 关卡目标（见 docs/rules.md 7）。
 *
 * 核心约定：**全灭敌人永远是兜底胜利条件**，任何关卡都算。
 * 所以 `objective` 描述的是"除了全灭之外，还能怎么赢"。
 */

const at = (x: number, y: number) => ({ x, y });

function scene(options: { objective?: Objective } = {}) {
  const map = flatMap(6, 3);
  const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
  const chief = makeUnit({ id: 'chief', pos: at(5, 0), team: 'enemy', defId: 'bandit-chief' });
  const grunt = makeUnit({ id: 'grunt', pos: at(5, 2), team: 'enemy', defId: 'bandit' });
  return makeState(map, [hero, chief, grunt], options);
}

describe('目标：全灭（默认）', () => {
  it('还有敌人活着就不算赢', () => {
    expect(checkVictory(scene({ objective: { kind: 'rout' } }))).toBe('playing');
  });

  it('敌人全灭就赢', () => {
    const state = scene({ objective: { kind: 'rout' } });
    const wiped = { ...state, units: state.units.map((u) => (u.team === 'enemy' ? { ...u, hp: 0 } : u)) };
    expect(checkVictory(wiped)).toBe('won');
  });
});

describe('目标：击破敌将', () => {
  const objective = { kind: 'defeat', defId: 'bandit-chief' } as const;

  it('敌将还活着就不算赢 —— 哪怕别的敌人都死光了', () => {
    const state = scene({ objective });
    const onlyChief = {
      ...state,
      units: state.units.map((u) => (u.defId === 'bandit' ? { ...u, hp: 0 } : u)),
    };
    expect(checkVictory(onlyChief)).toBe('playing');
  });

  it('敌将一死就赢 —— 剩下的杂兵不用管', () => {
    const state = scene({ objective });
    const chiefDown = {
      ...state,
      units: state.units.map((u) => (u.defId === 'bandit-chief' ? { ...u, hp: 0 } : u)),
    };
    expect(checkVictory(chiefDown)).toBe('won');
  });

  it('语义是"场上不再有这个兵种"：两个敌将必须都死', () => {
    const state = scene({ objective });
    const second = makeUnit({
      id: 'chief2',
      pos: at(4, 2),
      team: 'enemy',
      defId: 'bandit-chief',
    });
    const twoChiefs = { ...state, units: [...state.units, second] };
    const oneDown = {
      ...twoChiefs,
      units: twoChiefs.units.map((u) => (u.id === 'chief' ? { ...u, hp: 0 } : u)),
    };
    expect(checkVictory(oneDown)).toBe('playing');

    const bothDown = {
      ...twoChiefs,
      units: twoChiefs.units.map((u) =>
        u.defId === 'bandit-chief' ? { ...u, hp: 0 } : u,
      ),
    };
    expect(checkVictory(bothDown)).toBe('won');
  });
});

describe('目标：守住 N 回合', () => {
  const objective = { kind: 'survive', turns: 8 } as const;

  it('第 8 回合还没算赢', () => {
    const state = scene({ objective });
    expect(checkVictory({ ...state, turn: 8 })).toBe('playing');
  });

  it('第 9 回合（= 活过 8 回合）就赢', () => {
    const state = scene({ objective });
    expect(checkVictory({ ...state, turn: 9 })).toBe('won');
  });

  it('**不用打死任何人**', () => {
    const state = scene({ objective });
    const untouched = { ...state, turn: 9 };
    expect(untouched.units.filter((u) => u.team === 'enemy' && u.hp > 0)).toHaveLength(2);
    expect(checkVictory(untouched)).toBe('won');
  });
});

describe('兜底与失败条件', () => {
  it('任何目标下，敌人全灭都算赢', () => {
    for (const objective of [
      { kind: 'rout' },
      { kind: 'defeat', defId: 'bandit-chief' },
      { kind: 'survive', turns: 8 },
    ] as const) {
      const state = scene({ objective });
      const wiped = {
        ...state,
        units: state.units.map((u) => (u.team === 'enemy' ? { ...u, hp: 0 } : u)),
      };
      expect(checkVictory(wiped), JSON.stringify(objective)).toBe('won');
    }
  });

  it('我方全灭永远是失败，哪怕目标已经达成了一半', () => {
    const state = scene({ objective: { kind: 'survive', turns: 8 } });
    const dead = { ...state, turn: 9 };
    const wiped = {
      ...dead,
      units: dead.units.map((u) => (u.team === 'player' ? { ...u, hp: 0 } : u)),
    };
    expect(checkVictory(wiped)).toBe('lost');
  });

  it('还活着就继续打', () => {
    expect(checkVictory(scene({ objective: { kind: 'rout' } }))).toBe('playing');
  });
});

describe('目标的文案', () => {
  it('短描述', () => {
    expect(objectiveText({ kind: 'rout' })).toBe('全灭敌人');
    expect(objectiveText({ kind: 'defeat', defId: 'bandit-chief' })).toBe('击破敌将');
    expect(objectiveText({ kind: 'survive', turns: 8 })).toBe('守住 8 回合');
  });

  it('胜利文案按目标变，玩家才知道自己是怎么赢的', () => {
    expect(victoryText({ kind: 'rout' })).toContain('全灭');
    expect(victoryText({ kind: 'defeat', defId: 'x' })).toContain('敌将');
    expect(victoryText({ kind: 'survive', turns: 8 })).toContain('守住');
  });
});
