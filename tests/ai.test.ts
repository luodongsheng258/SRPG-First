import { describe, expect, it } from 'vitest';

import { applyAction, decideUnitAction, manhattan, pickFocusTarget, planTurn, runTurn } from '../src/core';
import type { Action, BattleState, Unit } from '../src/core';
import { flatMap, makeRangedUnit, makeState, makeUnit } from './fixtures';

describe('贪心 AI 决策', () => {
  it('打得到就会打，并且真的造成伤害', () => {
    const map = flatMap(5, 5);
    const hero = makeRangedUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 30, maxHp: 30, def: 0, spd: 1 });
    const foe = makeUnit({
      id: 'foe',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      atk: 6,
      def: 2,
      spd: 8,
      skill: 99,
      hp: 20,
      maxHp: 20,
    });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');

    /* foe 速度领先 7 ≥ 4 → 打两下，每下 6 - 0 = 6 */
    expect(next.units.find((u) => u.id === 'hero')?.hp).toBe(30 - 12);
  });

  it('打不到就朝最近的敌人推进', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', mov: 4 });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const action = decideUnitAction(state, state.units.find((u) => u.id === 'foe')!);

    expect(action.type).toBe('move');
    if (action.type === 'move') {
      expect(manhattan(action.to, hero.pos)).toBeLessThan(manhattan(foe.pos, hero.pos));
    }
  });

  it('隔着水的敌人会绕着走过去，而不是"觉得自己已经最近了"就永久待机', () => {
    const map = flatMap(7, 5);
    /* 第 2 行整条水墙，只留最右一格缺口 */
    for (let x = 0; x < 7; x += 1) map.terrain[2][x] = 'water';
    map.terrain[2][6] = 'plain';

    const hero = makeUnit({ id: 'hero', pos: { x: 3, y: 1 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 3 }, team: 'enemy', mov: 3, done: false });

    const action = decideUnitAction(makeState(map, [hero, foe], { activeTeam: 'enemy' }), foe);

    /* 直线距离 2 是所有可达落点里最小的 —— 只按曼哈顿距离判，AI 会永远待机。
       按地形距离算才会发现"得先往右走到缺口那边"。 */
    expect(manhattan(foe.pos, hero.pos)).toBe(2);
    expect(action.type).toBe('move');
    if (action.type === 'move') {
      expect(action.to.x).toBeGreaterThan(foe.pos.x);
    }
  });

  it('必死又打不死对方的交换会被放弃，改为原地待机', () => {
    const map = flatMap(5, 5);
    /* 残血杂兵 vs 满血重甲：打过去必被反杀，且打不死对方 */
    const weak = makeUnit({ id: 'weak', pos: { x: 0, y: 0 }, team: 'enemy', hp: 5, maxHp: 20, atk: 1, def: 0, spd: 1, mov: 4 });
    const tank = makeUnit({ id: 'tank', pos: { x: 1, y: 0 }, hp: 50, maxHp: 50, def: 0, atk: 20, spd: 20 });

    const state = makeState(map, [weak, tank], { activeTeam: 'enemy' });
    expect(decideUnitAction(state, weak).type).toBe('wait');
  });

  it('已经移动过的单位只在原地二选一，不会再次移动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy', moved: true });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const action = decideUnitAction(state, state.units.find((u) => u.id === 'foe')!);
    expect(action.type).toBe('wait');
  });

  it('相同局面下的决策完全一致（无隐藏随机）', () => {
    const map = flatMap(5, 5);
    const build = () => {
      const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
      const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 3 }, team: 'enemy' });
      return makeState(map, [hero, foe], { activeTeam: 'enemy', seed: 5 });
    };
    const a = build();
    const b = build();
    expect(decideUnitAction(a, a.units[1])).toEqual(decideUnitAction(b, b.units[1]));
  });
});

describe('整轮规划', () => {
  it('planTurn 一定以 endTurn 收尾', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const plan = planTurn(state, 'enemy');
    expect(plan.at(-1)).toEqual({ type: 'endTurn' });
  });

  it('战斗提前结束时不再追加 endTurn', () => {
    const map = flatMap(5, 5);
    const hero = makeRangedUnit({ id: 'hero', pos: { x: 0, y: 0 }, hp: 5, maxHp: 20, def: 0, spd: 1 });
    const foe = makeUnit({
      id: 'foe',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      atk: 99,
      def: 0,
      spd: 20,
      skill: 99,
      hp: 20,
      maxHp: 20,
    });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const plan = planTurn(state, 'enemy');
    expect(plan.some((action) => action.type === 'endTurn')).toBe(false);
  });

  it('runTurn 跑完一整轮后把控制权交还给对方，并推进回合数', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');

    expect(next.activeTeam).toBe('player');
    expect(next.turn).toBe(2);
    expect(next.units.find((u) => u.id === 'foe')?.done).toBe(true);
    expect(next.units.find((u) => u.id === 'hero')).toMatchObject({ done: false, moved: false });
  });

  it('敌方回合里我方单位原地不动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });
    const next = runTurn(state, 'enemy');
    expect(next.units.find((u) => u.id === 'hero')?.pos).toEqual({ x: 0, y: 0 });
  });
});

/* ---------------------------------------------------------------- 集火 */

/** 我方一个单位站在 (0,1)，敌人在右下方，用来考察"全队该集火谁" */
function focusScene(enemies: Array<Partial<Unit> & { id: string; pos: { x: number; y: number } }>) {
  const map = flatMap(9, 5);
  const mine = [makeUnit({ id: 'me', pos: { x: 0, y: 1 }, mov: 4, atk: 6 })];
  const foes = enemies.map((e) => makeUnit({ team: 'enemy', ...e }));
  return makeState(map, [...mine, ...foes], { activeTeam: 'player' });
}

describe('集火目标的评选', () => {
  it('优先选全队能合起来打死的那个 —— 确定的击杀胜过分散蹭血', () => {
    /* 残血那个这回合打得死（6 点伤害 ≥ 4 血），另一个满血打不死 */
    const state = focusScene([
      { id: 'doomed', pos: { x: 1, y: 1 }, hp: 4, maxHp: 20, def: 0, atk: 10, spd: 5 },
      { id: 'healthy', pos: { x: 0, y: 2 }, hp: 20, maxHp: 20, def: 0, atk: 10, spd: 5 },
    ]);

    expect(pickFocusTarget(state, 'player')?.id).toBe('doomed');
  });

  it('没人能打死时，选已经受伤的 —— 补刀比开新战线划算', () => {
    const state = focusScene([
      { id: 'fresh', pos: { x: 1, y: 1 }, hp: 20, maxHp: 20, def: 0, atk: 10, spd: 5 },
      { id: 'hurt', pos: { x: 0, y: 2 }, hp: 10, maxHp: 20, def: 0, atk: 10, spd: 5 },
    ]);

    expect(pickFocusTarget(state, 'player')?.id).toBe('hurt');
  });

  it('都满血、都打不死时，选攻击力最高的（威胁最大的）', () => {
    const state = focusScene([
      { id: 'weak', pos: { x: 1, y: 1 }, hp: 20, maxHp: 20, def: 0, atk: 3, spd: 5 },
      { id: 'scary', pos: { x: 0, y: 2 }, hp: 20, maxHp: 20, def: 0, atk: 12, spd: 5 },
    ]);

    expect(pickFocusTarget(state, 'player')?.id).toBe('scary');
  });

  it('全队都够不着的敌人不会被选中 —— 否则会被"远处那个头目"带偏', () => {
    const state = focusScene([
      /* 又强又残血，但离得太远：mov 4 + 射程 1 = 5，它距离 8 */
      { id: 'far-boss', pos: { x: 8, y: 4 }, hp: 2, maxHp: 40, def: 0, atk: 99, spd: 5 },
      { id: 'nearby', pos: { x: 1, y: 1 }, hp: 20, maxHp: 20, def: 0, atk: 5, spd: 5 },
    ]);

    expect(pickFocusTarget(state, 'player')?.id).toBe('nearby');
  });

  it('没有可行动的单位时返回 null', () => {
    const map = flatMap(5, 5);
    const mine = makeUnit({ id: 'me', pos: { x: 0, y: 0 }, done: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });

    expect(pickFocusTarget(makeState(map, [mine, foe]), 'player')).toBeNull();
  });

  it('够不着任何敌人时返回 null', () => {
    const map = flatMap(12, 12);
    const mine = makeUnit({ id: 'me', pos: { x: 0, y: 0 }, mov: 2 });
    const foe = makeUnit({ id: 'foe', pos: { x: 11, y: 11 }, team: 'enemy' });

    expect(pickFocusTarget(makeState(map, [mine, foe]), 'player')).toBeNull();
  });
});

/**
 * 走完"先移动、再攻击"的两步流程，返回**最终那一步**。
 *
 * AI 的动作是分两步给的：先 `move` 到落点，下一步才 `attack`。
 * 只问一次 `decideUnitAction` 会看到 move 就以为"它不打算打人"。
 */
function resolvePlanned(state: BattleState, unitId: string, focusId: string | null): Action {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) throw new Error(`找不到单位 ${unitId}`);

  const first = decideUnitAction(state, unit, focusId);
  if (first.type !== 'move') return first;

  const moved = applyAction(state, first);
  const after = moved.units.find((u) => u.id === unitId);
  if (!after) throw new Error('移动后单位不见了');
  return decideUnitAction(moved, after, focusId);
}

describe('集火：会为了打同一个目标而放弃个体最优', () => {
  /**
   * ⚠️ 写 AI 测试的陷阱：**ZOC 会让"一个单位够得着两个敌人"变得很罕见。**
   *
   * 第一版我把两个敌人放在近战单位的左右两侧，结果那个单位只剩 5 个落点 ——
   * 敌人的控制区把整条通路封死了（x=1 整列都进不去），它根本走不到第二个敌人旁边。
   * 于是"集火加分"永远没机会生效，测试看起来像加分失效，其实是场景不合法。
   *
   * 所以这里改用**远程单位**（射程 2 就不必贴脸），并把两个敌人拉开到
   * 控制区互不重叠。
   */
  function twoFoes() {
    const map = flatMap(9, 5);
    const me = makeRangedUnit({
      id: 'me',
      pos: { x: 2, y: 0 },
      mov: 7,
      atk: 6,
      def: 0,
      hp: 30,
      maxHp: 30,
      spd: 5,
    });
    /* 近的这个防低；远的这个防高一点，所以个体分数明显更低 */
    const soft = makeUnit({
      id: 'soft',
      pos: { x: 2, y: 2 },
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      def: 0,
      atk: 0,
      spd: 5,
    });
    const tough = makeUnit({
      id: 'tough',
      pos: { x: 6, y: 2 },
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      def: 1,
      atk: 6,
      spd: 5,
    });
    return { state: makeState(map, [me, soft, tough]), me, soft, tough };
  }

  it('不给集火目标时，按个体贪心走（挑分数更高的那个）', () => {
    const { state, soft } = twoFoes();
    const action = resolvePlanned(state, 'me', null);

    expect(action.type).toBe('attack');
    if (action.type === 'attack') expect(action.targetId).toBe(soft.id);
  });

  it('给了集火目标就转而去打它，哪怕个体分数更低', () => {
    const { state, tough } = twoFoes();
    const action = resolvePlanned(state, 'me', tough.id);

    expect(action.type).toBe('attack');
    if (action.type === 'attack') expect(action.targetId).toBe(tough.id);
  });

  it('集火加分不会让人去送死 —— 该放弃还是要放弃', () => {
    const map = flatMap(9, 5);
    const me = makeRangedUnit({
      id: 'me',
      pos: { x: 2, y: 0 },
      mov: 7,
      atk: 6,
      def: 0,
      hp: 6,
      maxHp: 30,
      spd: 5,
    });
    const soft = makeRangedUnit({
      id: 'soft',
      pos: { x: 2, y: 2 },
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      def: 0,
      atk: 0,
    });
    /* 远程对远程：距离 2 上它够得着，而它的反击足以秒杀我 */
    const deadly = makeRangedUnit({
      id: 'deadly',
      pos: { x: 6, y: 2 },
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      def: 0,
      atk: 99,
      spd: 20,
    });

    const action = resolvePlanned(makeState(map, [me, soft, deadly]), 'me', 'deadly');

    expect(action.type).toBe('attack');
    if (action.type === 'attack') expect(action.targetId).not.toBe('deadly');
  });

  it('整轮规划里两个单位会叠在同一个目标上，而不是各打各的', () => {
    const map = flatMap(11, 5);
    /* skill 99 → 命中率封顶 100%，保证两个人都打得中。
       不这么做的话任何一下落空都会让"合力击杀"变成"合力打残"，
       测试就变成了在赌 RNG。 */
    const a1 = makeRangedUnit({ id: 'a1', pos: { x: 2, y: 0 }, mov: 7, atk: 10, skill: 99, def: 0, spd: 5 });
    const a2 = makeRangedUnit({ id: 'a2', pos: { x: 4, y: 0 }, mov: 7, atk: 10, skill: 99, def: 0, spd: 5 });
    /* 一个残血（两人合力刚好打死），一个满血（一轮打不死） */
    const hurt = makeUnit({ id: 'hurt', pos: { x: 5, y: 2 }, team: 'enemy', hp: 12, maxHp: 20, def: 0, atk: 6, spd: 5 });
    const fresh = makeUnit({ id: 'fresh', pos: { x: 1, y: 2 }, team: 'enemy', hp: 20, maxHp: 20, def: 0, atk: 6, spd: 5 });

    const next = runTurn(makeState(map, [a1, a2, hurt, fresh]), 'player');
    const after = (id: string) => next.units.find((u) => u.id === id);

    /* 两个人一起把残血那个打死，满血那个一点没碰。
       没有集火的话他们会各挑一个目标，两个都打不死。 */
    expect(after('hurt')?.hp).toBe(0);
    expect(after('fresh')?.hp).toBe(20);
  });
});
