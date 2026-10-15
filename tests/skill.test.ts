import { describe, expect, it } from 'vitest';

import {
  applyAction,
  createBlueprint,
  endTurn,
  forecast,
  planStrikes,
  START_TP,
  strikeProfile,
  TP_ON_HIT,
  TP_PER_TURN,
} from '../src/core';
import { flatMap, makeRangedUnit, makeState, makeUnit, testSkill, testWeapon } from './fixtures';

/**
 * 战技（见 docs/rules.md 5.9）。
 *
 * 它本质上是**一次带修正的攻击**，走的是同一个 `attack` 动作 + `skillId`。
 * 设计核心是「**用战技就不能追击**」—— 没有这一条，战技只是"花资源换伤害"，
 * 永远该用；有了它才构成"打一次狠的还是打两次轻的"这种取舍。
 */

const at = (x: number, y: number) => ({ x, y });

describe('开局 TP', () => {
  it('**不能是 0** —— 否则短关卡里战技根本露不了面', () => {
    const blueprint = createBlueprint(
      {
        id: 'dummy',
        name: '测试兵',
        unitClass: 'infantry',
        level: 1,
        maxHp: 20,
        atk: 5,
        def: 2,
        spd: 5,
        skill: 5,
        mov: 4,
        weaponIds: ['w'],
        skillIds: [],
        growths: { maxHp: 0, atk: 0, def: 0, spd: 0, skill: 0 },
      },
      { weapons: [testWeapon()], skills: [] },
      'player',
      1,
    );

    expect(blueprint.tp).toBe(START_TP);
    /* 从 0 开始的话，最便宜的瞄准（15）要到第 4 回合才买得起，
       而第一关平均只打 6.7 回合 —— 玩家按 Q 会"什么都没发生"。 */
    expect(START_TP).toBeGreaterThanOrEqual(20);
  });
});

describe('战技的修正', () => {
  it('威力 / 命中 / 暴击都按战技改', () => {
    const map = flatMap(5, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), atk: 10, skill: 5, weapon: testWeapon({ crit: 5 }) });
    const foe = makeUnit({ id: 'foe', pos: at(1, 0), team: 'enemy', def: 4, spd: 5 });

    const plain = strikeProfile(map, hero, foe);
    const art = strikeProfile(map, hero, foe, testSkill({ might: 6, hit: -10, crit: 40 }));

    expect(art.damage - plain.damage).toBe(6);
    expect(art.hit - plain.hit).toBe(-10);
    expect(art.crit - plain.crit).toBe(40);
  });

  it('不传战技时和以前完全一样', () => {
    const map = flatMap(5, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0) });
    const foe = makeUnit({ id: 'foe', pos: at(1, 0), team: 'enemy' });

    expect(strikeProfile(map, hero, foe, undefined)).toEqual(strikeProfile(map, hero, foe));
  });
});

describe('用战技就不能追击', () => {
  /** 攻方速度远高于守方，普通攻击本来会打两下 */
  function speedy() {
    const map = flatMap(5, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), spd: 20, atk: 10 });
    const foe = makeUnit({ id: 'foe', pos: at(1, 0), team: 'enemy', spd: 1, def: 0, hp: 99, maxHp: 99 });
    return { map, hero, foe };
  }

  it('普通攻击打两下', () => {
    const { map, hero, foe } = speedy();
    const mine = planStrikes(map, hero, foe).filter((s) => s.attackerId === 'hero');
    expect(mine).toHaveLength(2);
  });

  it('开战技只打一下 —— 这就是它的代价', () => {
    const { map, hero, foe } = speedy();
    const mine = planStrikes(map, hero, foe, testSkill()).filter((s) => s.attackerId === 'hero');
    expect(mine).toHaveLength(1);
  });

  it('预测和实际结算必须一致（预测里也不能显示追击）', () => {
    const { map, hero, foe } = speedy();
    expect(forecast(map, hero, foe).attacker.doubles).toBe(true);
    expect(forecast(map, hero, foe, testSkill()).attacker.doubles).toBe(false);
  });

  it('**守方的追击不受影响** —— 用战技一样可能吃满反击', () => {
    const map = flatMap(5, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), spd: 1 });
    const foe = makeUnit({ id: 'foe', pos: at(1, 0), team: 'enemy', spd: 20 });
    expect(forecast(map, hero, foe, testSkill()).counter?.doubles).toBe(true);
  });
});

describe('TP 的收支', () => {
  /** 远程打近战：距离 2 上守方够不着，所以不会反击，命中次数恒为 1 */
  function duel(tp: number) {
    const map = flatMap(6, 3);
    const hero = makeRangedUnit({
      id: 'hero',
      pos: at(0, 1),
      atk: 10,
      skill: 99, // 命中封顶，钉死随机性
      tp,
      skills: [testSkill({ cost: 20 })],
    });
    const foe = makeUnit({ id: 'foe', pos: at(2, 1), team: 'enemy', hp: 99, maxHp: 99 });
    return makeState(map, [hero, foe]);
  }

  it('开战技扣掉消耗，命中再回一点', () => {
    const state = duel(50);
    const next = applyAction(state, {
      type: 'attack',
      unitId: 'hero',
      targetId: 'foe',
      skillId: 'test-art',
    });
    /* 50 − 20（消耗）+ 8（命中一次） */
    expect(next.units.find((u) => u.id === 'hero')?.tp).toBe(50 - 20 + TP_ON_HIT);
  });

  it('普通攻击只进不出', () => {
    const state = duel(50);
    const next = applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'foe' });
    expect(next.units.find((u) => u.id === 'hero')?.tp).toBe(50 + TP_ON_HIT);
  });

  it('TP 不会超过上限', () => {
    const state = duel(100);
    const next = applyAction(state, { type: 'attack', unitId: 'hero', targetId: 'foe' });
    expect(next.units.find((u) => u.id === 'hero')?.tp).toBe(100);
  });

  it('**结算顺序不能颠倒**：先扣消耗再加回复，不能被上限夹掉', () => {
    /* tp=95、上限 100、消耗 20：正确结果是 95−20+8 = 83。
       如果先加回复（夹到 100）再扣消耗，会得到 80 —— 凭空少 3 点。 */
    const map = flatMap(6, 3);
    const hero = makeRangedUnit({
      id: 'hero',
      pos: at(0, 1),
      atk: 10,
      skill: 99,
      tp: 95,
      maxTp: 100,
      skills: [testSkill({ cost: 20 })],
    });
    const foe = makeUnit({ id: 'foe', pos: at(2, 1), team: 'enemy', hp: 99, maxHp: 99 });

    const next = applyAction(makeState(map, [hero, foe]), {
      type: 'attack',
      unitId: 'hero',
      targetId: 'foe',
      skillId: 'test-art',
    });
    expect(next.units.find((u) => u.id === 'hero')?.tp).toBe(83);
  });

  it('守方命中也会回 TP（奖励的是"打中"，不是"出手"）', () => {
    const map = flatMap(4, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), atk: 1, skill: 0, hp: 99, maxHp: 99, tp: 0 });
    const foe = makeUnit({ id: 'foe', pos: at(1, 0), team: 'enemy', skill: 99, tp: 0 });
    const next = applyAction(makeState(map, [hero, foe]), {
      type: 'attack',
      unitId: 'hero',
      targetId: 'foe',
    });
    expect(next.units.find((u) => u.id === 'foe')?.tp).toBe(TP_ON_HIT);
  });

  it('回合开始时给即将行动的一方回 TP', () => {
    const map = flatMap(4, 3);
    const hero = makeUnit({ id: 'hero', pos: at(0, 0), tp: 0 });
    const foe = makeUnit({ id: 'foe', pos: at(3, 2), team: 'enemy', tp: 0 });
    const state = makeState(map, [hero, foe], { activeTeam: 'player' });

    const next = endTurn(state);
    expect(next.activeTeam).toBe('enemy');
    /* 只有即将行动的一方回 */
    expect(next.units.find((u) => u.id === 'foe')?.tp).toBe(TP_PER_TURN);
    expect(next.units.find((u) => u.id === 'hero')?.tp).toBe(0);
  });
});

describe('拒绝非法战技', () => {
  function armed() {
    const map = flatMap(6, 3);
    const hero = makeRangedUnit({
      id: 'hero',
      pos: at(0, 1),
      skill: 99,
      tp: 100,
      skills: [testSkill({ cost: 20 })],
    });
    const foe = makeUnit({ id: 'foe', pos: at(2, 1), team: 'enemy', hp: 99, maxHp: 99 });
    return makeState(map, [hero, foe]);
  }

  it('没带的战技 → 报错', () => {
    expect(() =>
      applyAction(armed(), { type: 'attack', unitId: 'hero', targetId: 'foe', skillId: '没带' }),
    ).toThrow(/没有战技/);
  });

  it('TP 不够 → 报错（而且不会把战斗打出去）', () => {
    const state = armed();
    const poor = {
      ...state,
      units: state.units.map((u) => (u.id === 'hero' ? { ...u, tp: 5 } : u)),
    };
    expect(() =>
      applyAction(poor, { type: 'attack', unitId: 'hero', targetId: 'foe', skillId: 'test-art' }),
    ).toThrow(/TP 不足/);
    /* 报错必须发生在动手之前：守方一点血都不该掉 */
    expect(poor.units.find((u) => u.id === 'foe')?.hp).toBe(99);
  });
});

describe('战技会写进日志', () => {
  it('发动的那一行在最前面，玩家才知道伤害为什么变高了', () => {
    const map = flatMap(6, 3);
    const hero = makeRangedUnit({
      id: 'hero',
      pos: at(0, 1),
      skill: 99,
      tp: 100,
      skills: [testSkill({ name: '测试战技' })],
    });
    const foe = makeUnit({ id: 'foe', pos: at(2, 1), team: 'enemy', hp: 99, maxHp: 99 });

    const next = applyAction(makeState(map, [hero, foe]), {
      type: 'attack',
      unitId: 'hero',
      targetId: 'foe',
      skillId: 'test-art',
    });
    expect(next.log.some((line) => line.includes('发动【测试战技】'))).toBe(true);
  });
});
