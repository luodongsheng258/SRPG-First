import { describe, expect, it } from 'vitest';

import { canAct, checkVictory, endTurn, pendingUnits, TERRAIN } from '../src/core';
import { flatMap, makeState, makeUnit, mapWith } from './fixtures';

function twoSides(map = flatMap(5, 5)) {
  const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, team: 'player' });
  const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
  return { hero, foe, map };
}

describe('回合切换', () => {
  it('一个回合 = 我方阶段 + 敌方阶段，只在切回我方时 +1', () => {
    const { hero, foe, map } = twoSides();
    let state = makeState(map, [hero, foe]);

    expect([state.turn, state.activeTeam]).toEqual([1, 'player']);

    state = endTurn(state);
    expect([state.turn, state.activeTeam]).toEqual([1, 'enemy']);

    state = endTurn(state);
    expect([state.turn, state.activeTeam]).toEqual([2, 'player']);
  });

  it('只重置即将行动一方的行动标记，当前方保留到下一轮', () => {
    const { map } = twoSides();
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, team: 'player', done: true, moved: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', done: true, moved: true });

    let state = makeState(map, [hero, foe]);
    state = endTurn(state); /* → 敌方阶段 */

    expect(state.units.find((u) => u.id === 'foe')).toMatchObject({ done: false, moved: false });
    expect(state.units.find((u) => u.id === 'hero')).toMatchObject({ done: true, moved: true });

    state = endTurn(state); /* → 第 2 回合我方阶段 */
    expect(state.units.find((u) => u.id === 'hero')).toMatchObject({ done: false, moved: false });
    expect(state.turn).toBe(2);
  });

  it('战斗已结束时 endTurn 是空操作', () => {
    const { hero, map } = twoSides();
    const state = { ...makeState(map, [hero]), phase: 'won' as const };
    expect(endTurn(state)).toBe(state);
  });

  it('每次切换阶段都会往日志里写一行', () => {
    const { hero, foe, map } = twoSides();
    const state = endTurn(makeState(map, [hero, foe]));
    expect(state.log.at(-1)).toContain('敌方阶段');
  });
});

describe('地形回复', () => {
  /** endTurn 只结算**即将行动的一方**，所以要切两次才轮到我方 */
  function twoPhases(state: ReturnType<typeof makeState>) {
    return endTurn(endTurn(state));
  }

  it('回合开始时，站在要塞上的单位回复 HP', () => {
    const map = mapWith([{ x: 0, y: 0, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 10, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = twoPhases(makeState(map, [hero, foe]));
    /* 引用地形表而不是写死数字 —— 回血量是可调数据，测试不该把它钉死 */
    expect(state.units.find((u) => u.id === 'hero')?.hp).toBe(10 + TERRAIN.fort.heal);
    expect(state.turn).toBe(2);
  });

  it('回复量必须明显低于实际打在要塞上的伤害，否则会制造僵局', () => {
    /* 这是设计约束，不是实现细节。要塞自带防 +3，士兵 9 点攻击力打上去只剩 4~5，
       回血一旦接近它，站在要塞上的单位每回合净掉血趋近 0，1v1 永远打不完。
       实测回血 5 时第三关僵局 1.7%，回血 3 配 ZOC 时反而涨到 2.3%。
       所以门槛比"纸面最低伤害"更严：要按**扣掉地形防御之后**的伤害来定。 */
    expect(TERRAIN.fort.heal).toBeLessThanOrEqual(2);
  });

  it('回复不会超过生命上限', () => {
    const map = mapWith([{ x: 0, y: 0, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 23, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = twoPhases(makeState(map, [hero, foe]));
    expect(state.units.find((u) => u.id === 'hero')?.hp).toBe(24);
  });

  it('平原不回血，阵亡单位也不回血', () => {
    const map = flatMap(5, 5);
    const lucky = makeUnit({ id: 'lucky', pos: { x: 0, y: 0 }, hp: 10, maxHp: 24 });
    const corpse = makeUnit({ id: 'corpse', pos: { x: 1, y: 0 }, hp: 0, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = twoPhases(makeState(map, [lucky, corpse, foe]));
    expect(state.units.find((u) => u.id === 'lucky')?.hp).toBe(10);
    expect(state.units.find((u) => u.id === 'corpse')?.hp).toBe(0);
  });

  it('只结算即将行动的一方：站在要塞上的敌人要等它自己的回合', () => {
    const map = mapWith([{ x: 4, y: 4, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', hp: 10, maxHp: 24 });

    /* 第一次切换 → 敌方阶段，此时它才回血 */
    const afterFirst = endTurn(makeState(map, [hero, foe]));
    expect(afterFirst.units.find((u) => u.id === 'foe')?.hp).toBe(10 + TERRAIN.fort.heal);

    const afterSecond = endTurn(afterFirst);
    expect(afterSecond.units.find((u) => u.id === 'foe')?.hp).toBe(10 + TERRAIN.fort.heal);
  });

  it('回血会写进日志', () => {
    const map = mapWith([{ x: 0, y: 0, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 10, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = twoPhases(makeState(map, [hero, foe]));
    expect(state.log.some((line) => line.includes('要塞') && line.includes('回复'))).toBe(true);
  });

  it('被敌人贴住时不能回血 —— 否则要塞会变成数学上不可杀死的据点', () => {
    const map = mapWith([{ x: 0, y: 0, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 10, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });

    const state = twoPhases(makeState(map, [hero, foe]));

    /* 要塞同时给了 防 +3、闪避 +30、回血。三者叠加时，
       攻击方的期望伤害会低于回血量 —— 实测重骑打要塞上的山贼：
       伤害 5、命中 30%（期望 1.5），而对方每回合回 2。永远打不完。 */
    expect(state.units.find((u) => u.id === 'hero')?.hp).toBe(10);
    expect(
      state.log.some((line) => line.includes('交战') && line.includes('无法')),
      '不回复的原因要写进日志，否则玩家会以为是 bug',
    ).toBe(true);
  });

  it('敌人走开之后又能回血了', () => {
    const map = mapWith([{ x: 0, y: 0, t: 'fort' }]);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 10, maxHp: 24 });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });

    /* 先在贴住的状态下切两次：不回血 */
    const engaged = twoPhases(makeState(map, [hero, foe]));
    expect(engaged.units.find((u) => u.id === 'hero')?.hp).toBe(10);

    /* 把敌人挪开（模拟它走掉了）再切两次 */
    const moved = {
      ...engaged,
      units: engaged.units.map((u) => (u.id === 'foe' ? { ...u, pos: { x: 4, y: 4 } } : u)),
    };
    const healed = twoPhases(moved);
    expect(healed.units.find((u) => u.id === 'hero')?.hp).toBe(10 + TERRAIN.fort.heal);
  });
});

describe('行动资格', () => {
  it('canAct 只对「当前阶段 + 存活 + 未行动」为真', () => {
    const { hero, foe, map } = twoSides();
    const state = makeState(map, [hero, foe]); /* activeTeam = player */

    expect(canAct(state, hero)).toBe(true);
    expect(canAct(state, foe)).toBe(false); /* 不是它的阶段 */
    expect(canAct(state, { ...hero, done: true })).toBe(false);
    expect(canAct(state, { ...hero, hp: 0 })).toBe(false);
  });

  it('pendingUnits 只列出还没行动的单位', () => {
    const { map } = twoSides();
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, team: 'player' });
    const b = makeUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'player', done: true });
    const c = makeUnit({ id: 'c', pos: { x: 2, y: 0 }, team: 'player', hp: 0 });
    const state = makeState(map, [a, b, c]);

    expect(pendingUnits(state).map((u) => u.id)).toEqual(['a']);
  });
});

describe('胜负判定', () => {
  it('敌方全灭 = 胜', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const corpse = makeUnit({ id: 'corpse', pos: { x: 4, y: 4 }, team: 'enemy', hp: 0 });
    expect(checkVictory(makeState(map, [hero, corpse]))).toBe('won');
  });

  it('我方全灭 = 负', () => {
    const map = flatMap(5, 5);
    const corpse = makeUnit({ id: 'corpse', pos: { x: 0, y: 0 }, hp: 0 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    expect(checkVictory(makeState(map, [corpse, foe]))).toBe('lost');
  });

  it('双方都还有人 = 继续', () => {
    const { hero, foe, map } = twoSides();
    expect(checkVictory(makeState(map, [hero, foe]))).toBe('playing');
  });
});
