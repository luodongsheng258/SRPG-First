import { describe, expect, it } from 'vitest';

import { applyAction, key, type Action, type BattleState } from '../src/core';
import { buildFeedback, isStrikeFx, replayCombat, type FxEvent } from '../src/game/feedback';
import { flatMap, makeRangedUnit, makeState, makeUnit, mapWith } from './fixtures';

/**
 * 表现层的测试。
 *
 * 这就是「把该演什么和怎么画分开」的回报：
 * 演出逻辑是纯函数，能在 Node 里断言；
 * 只有真正的绘制（补间、飘字、运镜）才需要人眼。
 */

function totalDamage(events: FxEvent[], unitId: string): number {
  let sum = 0;
  for (const event of events) {
    if (event.kind === 'damage' && event.unitId === unitId) sum += event.amount;
  }
  return sum;
}

/** 一组标准的近战对砍双人组，方便反复构造 */
function duel(seed: number, map = flatMap(5, 5)): {
  before: BattleState;
  action: Action;
  a: ReturnType<typeof makeUnit>;
  b: ReturnType<typeof makeUnit>;
} {
  const a = makeUnit({
    id: 'a',
    pos: { x: 0, y: 0 },
    atk: 9,
    def: 4,
    spd: 8,
    skill: 6,
    hp: 24,
    maxHp: 24,
  });
  const b = makeUnit({
    id: 'b',
    pos: { x: 1, y: 0 },
    team: 'enemy',
    atk: 8,
    def: 3,
    spd: 5,
    skill: 7,
    hp: 22,
    maxHp: 22,
  });
  return {
    before: makeState(map, [a, b], { seed }),
    action: { type: 'attack', unitId: 'a', targetId: 'b' },
    a,
    b,
  };
}

describe('战斗重放', () => {
  it('重放结果与真实结算逐字节一致（60 个种子）', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const { before, action, a, b } = duel(seed);
      const after = applyAction(before, action);
      expect(replayCombat(before, after, a, b), `seed=${seed} 对账失败`).not.toBeNull();
    }
  });

  it('所有伤害事件的总和恰好等于实际掉血', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const { before, action } = duel(seed);
      const after = applyAction(before, action);
      const feedback = buildFeedback(before, after, action);

      for (const id of ['a', 'b']) {
        const hpBefore = before.units.find((u) => u.id === id)?.hp ?? 0;
        const hpAfter = after.units.find((u) => u.id === id)?.hp ?? 0;
        expect(totalDamage(feedback.events, id), `seed=${seed} ${id}`).toBe(hpBefore - hpAfter);
      }
    }
  });

  it('打击事件数量恰好等于随机游标推进量（也就是实际掷骰次数）', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const { before, action } = duel(seed);
      const after = applyAction(before, action);
      const feedback = buildFeedback(before, after, action);

      const strikes = feedback.events.filter(isStrikeFx).length;
      expect(strikes, `seed=${seed}`).toBe(after.rngCursor - before.rngCursor);
    }
  });

  it('对账失败时返回 null，绝不编造数字', () => {
    const { before, a, b } = duel(5);
    /* 伪造一个随机游标对不上的"结果"，模拟 core 结算逻辑被改动的情况 */
    const lie: BattleState = { ...before, rngCursor: before.rngCursor + 99 };
    expect(replayCombat(before, lie, a, b)).toBeNull();
  });

  it('命中率不足 100 时，落空会被记录成 miss 事件', () => {
    const map = flatMap(5, 5);
    let sawMiss = false;

    for (let seed = 0; seed < 120 && !sawMiss; seed += 1) {
      const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 6, skill: 5 });
      const b = makeRangedUnit({
        id: 'b',
        pos: { x: 1, y: 0 },
        team: 'enemy',
        hp: 40,
        maxHp: 40,
        def: 0,
        spd: 6,
      });
      const before = makeState(map, [a, b], { seed });
      const action: Action = { type: 'attack', unitId: 'a', targetId: 'b' };
      const feedback = buildFeedback(before, applyAction(before, action), action);
      if (feedback.events.some((e) => e.kind === 'miss')) sawMiss = true;
    }

    expect(sawMiss).toBe(true);
  });
});

describe('伤害与击杀', () => {
  it('击杀的那一击被标记为 lethal', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 100, skill: 99, spd: 10 });
    const b = makeRangedUnit({
      id: 'b',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      hp: 10,
      maxHp: 20,
      def: 0,
    });
    const before = makeState(map, [a, b], { seed: 7 });
    const action: Action = { type: 'attack', unitId: 'a', targetId: 'b' };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    const damage = feedback.events.filter((e) => e.kind === 'damage');
    expect(damage).toHaveLength(1);
    expect(damage[0]).toMatchObject({ kind: 'damage', unitId: 'b', amount: 100, lethal: true });
  });

  it('未击杀时 lethal 为 false', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 5, skill: 99 });
    const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 20, maxHp: 20, def: 0 });
    const before = makeState(map, [a, b], { seed: 1 });
    const action: Action = { type: 'attack', unitId: 'a', targetId: 'b' };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    expect(feedback.events.find((e) => e.kind === 'damage')).toMatchObject({ lethal: false });
  });

  it('只有攻击动作会带出 combat 信息（镜头才知道该聚焦谁）', () => {
    const { before, action } = duel(11);
    const feedback = buildFeedback(before, applyAction(before, action), action);
    expect(feedback.combat).toEqual({ attackerId: 'a', targetId: 'b' });

    const waitAction: Action = { type: 'wait', unitId: 'a' };
    const waited = buildFeedback(before, applyAction(before, waitAction), waitAction);
    expect(waited.combat).toBeNull();
  });
});

describe('移动演出', () => {
  it('给出的是真实路径，会绕开不可通行地形', () => {
    /* (1,0) 是水，直线过不去，必须绕行 */
    const map = mapWith([{ x: 1, y: 0, t: 'water' }]);
    const scout = makeUnit({ id: 'scout', pos: { x: 0, y: 0 }, mov: 4 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const before = makeState(map, [scout, foe]);
    const action: Action = { type: 'move', unitId: 'scout', to: { x: 2, y: 0 } };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    const move = feedback.events.find((e) => e.kind === 'move');
    expect(move).toBeDefined();
    if (move?.kind !== 'move') throw new Error('期望拿到一个 move 事件');

    const keys = move.path.map(key);
    expect(keys[0]).toBe('0,0');
    expect(keys[keys.length - 1]).toBe('2,0');
    expect(keys).not.toContain('1,0');
    expect(keys.length).toBeGreaterThan(2);
  });

  it('原地不动的动作不会产生 move 事件', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const before = makeState(map, [hero, foe]);
    const action: Action = { type: 'wait', unitId: 'hero' };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    expect(feedback.events).toEqual([]);
  });
});

describe('阶段与胜负', () => {
  it('结束回合产生 phase 事件', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const before = makeState(map, [hero, foe]);
    const action: Action = { type: 'endTurn' };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    expect(feedback.events).toContainEqual({ kind: 'phase', team: 'enemy', turn: 1 });
  });

  it('打光最后一个敌人会产生 outcome 事件', () => {
    const map = flatMap(5, 5);
    const killer = makeUnit({ id: 'killer', pos: { x: 0, y: 0 }, atk: 99, skill: 99, spd: 10 });
    const victim = makeRangedUnit({
      id: 'victim',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      hp: 5,
      maxHp: 5,
      def: 0,
    });
    const before = makeState(map, [killer, victim], { seed: 3 });
    const action: Action = { type: 'attack', unitId: 'killer', targetId: 'victim' };
    const feedback = buildFeedback(before, applyAction(before, action), action);

    expect(feedback.events).toContainEqual({ kind: 'outcome', phase: 'won' });
  });
});
