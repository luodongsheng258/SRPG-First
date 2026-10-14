import { describe, expect, it } from 'vitest';

import { applyAction, type BattleState, type Vec2 } from '../src/core';
import {
  computeHighlights,
  computeThreatZone,
  resolveClick,
  type ClickContext,
  type UiMode,
} from '../src/game/interaction';
import { flatMap, makeRangedUnit, makeState, makeUnit } from './fixtures';

/**
 * 交互层的测试。
 *
 * 这一整个文件存在的理由：M1 里漏掉了「原地不动也能攻击」，
 * 而当时那条判断写在场景类里，只能靠人手点，谁也发现不了。
 * 抽成纯函数之后，每条路径都有断言锁着。
 */

/** 复刻场景类的做法：先算高亮，再判点击意图 */
function click(state: BattleState, mode: UiMode, selectedId: string | null, tile: Vec2) {
  const selected =
    selectedId === null ? null : (state.units.find((u) => u.id === selectedId) ?? null);
  const highlights = computeHighlights(state, selected);
  const ctx: ClickContext = {
    state,
    mode,
    selectedId,
    tile,
    moveKeys: highlights.moveKeys,
    attackNowKeys: highlights.attackNowKeys,
  };
  return resolveClick(ctx);
}

describe('⭐ 回归：原地不动也能攻击', () => {
  it('选中后直接点射程内的敌人 = 攻击（曾经必须"假装走一格"才行）', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'selecting', 'hero', { x: 1, y: 0 })).toEqual({
      kind: 'attack',
      unitId: 'hero',
      targetId: 'foe',
    });
  });

  it('弓手原地就能打到 2 格外的敌人', () => {
    const map = flatMap(5, 5);
    const archer = makeRangedUnit({ id: 'archer', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 2, y: 0 }, team: 'enemy' });
    const state = makeState(map, [archer, foe]);

    expect(click(state, 'selecting', 'archer', { x: 2, y: 0 })).toEqual({
      kind: 'attack',
      unitId: 'archer',
      targetId: 'foe',
    });
  });

  it('原地攻击的意图能真的落地：敌人掉血，自己位置不变', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({
      id: 'hero',
      pos: { x: 0, y: 0 },
      atk: 9,
      def: 4,
      /* 速度只领先 1 点：不触发追击，伤害才好算成固定值 */
      spd: 6,
      skill: 99,
      hp: 24,
      maxHp: 24,
    });
    /* 用远程单位当靶子：它够不到相邻格，自然不会反击，伤害才好算成固定值 */
    const foe = makeRangedUnit({
      id: 'foe',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      def: 3,
      hp: 22,
      maxHp: 22,
    });
    const before = makeState(map, [hero, foe], { seed: 42 });

    const intent = click(before, 'selecting', 'hero', { x: 1, y: 0 });
    if (intent.kind !== 'attack') throw new Error(`期望 attack，实际 ${intent.kind}`);

    /* 场景类就是把意图照这个形状翻成 core 的 Action 的 */
    const after = applyAction(before, {
      type: 'attack',
      unitId: intent.unitId,
      targetId: intent.targetId,
    });

    expect(after.units.find((u) => u.id === 'foe')?.hp).toBe(22 - 6);
    expect(after.units.find((u) => u.id === 'hero')?.pos).toEqual({ x: 0, y: 0 });
    expect(after.units.find((u) => u.id === 'hero')?.hp).toBe(24);
  });

  it('射程外的敌人不会误判成攻击', () => {
    const map = flatMap(6, 6);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, mov: 1 });
    const far = makeUnit({ id: 'far', pos: { x: 4, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, far]);

    expect(click(state, 'selecting', 'hero', { x: 4, y: 0 })).toEqual({ kind: 'cancel' });
  });
});

describe('idle：还没选中任何人', () => {
  it('点可行动的我方单位 = 选中', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'idle', null, { x: 0, y: 0 })).toEqual({
      kind: 'select',
      unitId: 'hero',
    });
  });

  it('点已经行动完的我方单位 = 什么都不做', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, done: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'idle', null, { x: 0, y: 0 })).toEqual({ kind: 'none' });
  });

  it('点敌人或空地 = 什么都不做', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'idle', null, { x: 4, y: 4 })).toEqual({ kind: 'none' });
    expect(click(state, 'idle', null, { x: 2, y: 2 })).toEqual({ kind: 'none' });
  });
});

describe('selecting：还在挑落点', () => {
  it('点自己 = 取消选择', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'selecting', 'hero', { x: 0, y: 0 })).toEqual({ kind: 'cancel' });
  });

  it('点另一个还能动的友军 = 换选', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const ally = makeUnit({ id: 'ally', pos: { x: 1, y: 1 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, ally, foe]);

    expect(click(state, 'selecting', 'hero', { x: 1, y: 1 })).toEqual({
      kind: 'select',
      unitId: 'ally',
    });
  });

  it('点蓝格 = 移动', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, mov: 4 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'selecting', 'hero', { x: 0, y: 2 })).toEqual({
      kind: 'move',
      unitId: 'hero',
      to: { x: 0, y: 2 },
    });
  });

  it('点够不到的地方 = 取消选择', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, mov: 1 });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'selecting', 'hero', { x: 4, y: 0 })).toEqual({ kind: 'cancel' });
  });
});

describe('moved：位置已定，只剩打谁或待机', () => {
  it('点射程内的敌人 = 攻击', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, moved: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'moved', 'hero', { x: 1, y: 0 })).toEqual({
      kind: 'attack',
      unitId: 'hero',
      targetId: 'foe',
    });
  });

  it('点其它任何地方 = 待机', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, moved: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    expect(click(state, 'moved', 'hero', { x: 0, y: 3 })).toEqual({ kind: 'wait', unitId: 'hero' });
    expect(click(state, 'moved', 'hero', { x: 0, y: 0 })).toEqual({ kind: 'wait', unitId: 'hero' });
  });

  it('射程外的敌人也算待机，不会误打', () => {
    const map = flatMap(6, 6);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, moved: true });
    const far = makeUnit({ id: 'far', pos: { x: 4, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, far]);

    expect(click(state, 'moved', 'hero', { x: 4, y: 0 })).toEqual({
      kind: 'wait',
      unitId: 'hero',
    });
  });
});

describe('不该有反应的时候', () => {
  it('敌方回合任何点击都不产生指令', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe], { activeTeam: 'enemy' });

    expect(click(state, 'idle', null, { x: 0, y: 0 })).toEqual({ kind: 'none' });
    expect(click(state, 'selecting', 'hero', { x: 1, y: 0 })).toEqual({ kind: 'none' });
    expect(click(state, 'moved', 'hero', { x: 1, y: 0 })).toEqual({ kind: 'none' });
  });

  it('胜负已分后任何点击都不产生指令', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state: BattleState = { ...makeState(map, [hero, foe]), phase: 'won' };

    expect(click(state, 'idle', null, { x: 0, y: 0 })).toEqual({ kind: 'none' });
    expect(click(state, 'selecting', 'hero', { x: 1, y: 0 })).toEqual({ kind: 'none' });
  });
});

describe('高亮范围', () => {
  it('相邻敌人的格子会进 attackNowKeys，且不会进 moveKeys（敌人挡路）', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, mov: 4 });
    const foe = makeUnit({ id: 'foe', pos: { x: 1, y: 0 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    const h = computeHighlights(state, hero);
    expect(h.attackNowKeys.has('1,0')).toBe(true);
    expect(h.moveKeys.has('1,0')).toBe(false);
    expect(h.moveKeys.has('0,0')).toBe(true);
  });

  it('已经移动过的单位不再给出移动范围', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, moved: true });
    const foe = makeUnit({ id: 'foe', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [hero, foe]);

    const h = computeHighlights(state, hero);
    expect(h.moveRange).toBeNull();
    expect(h.moveKeys.size).toBe(0);
  });

  it('没有选中单位时全是空集', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    const state = makeState(map, [hero]);

    const h = computeHighlights(state, null);
    expect(h.moveKeys.size).toBe(0);
    expect(h.attackNowKeys.size).toBe(0);
    expect(h.attackPotentialKeys.size).toBe(0);
    expect(h.moveRange).toBeNull();
  });
});

describe('敌方威胁范围（按 T 显示）', () => {
  it('包含「先移动、再攻击」才能打到的格子 —— 这正是它存在的理由', () => {
    const map = flatMap(8, 8);
    const foe = makeUnit({
      id: 'foe',
      pos: { x: 0, y: 0 },
      team: 'enemy',
      mov: 2,
    });
    const hero = makeUnit({ id: 'hero', pos: { x: 7, y: 7 } });
    const state = makeState(map, [hero, foe]);

    const zone = computeThreatZone(state, 'enemy');

    expect(zone.has('1,0'), '原地就能打到').toBe(true);
    expect(zone.has('2,0'), '必须移动之后才够得着').toBe(true);
    expect(zone.has('3,0'), '移动 2 格 + 射程 1 格 = 最远 3 格').toBe(true);
    expect(zone.has('4,0'), '超出 mov + range 的总和').toBe(false);
  });

  it('弓手 mov 4 / range[2,2]：最远够到 6 格，但贴脸那格反而打不到（要绕）', () => {
    const map = flatMap(12, 12);
    const archer = makeRangedUnit({
      id: 'archer',
      pos: { x: 0, y: 0 },
      team: 'enemy',
      mov: 4,
    });
    const hero = makeUnit({ id: 'hero', pos: { x: 11, y: 11 } });
    const zone = computeThreatZone(makeState(map, [hero, archer]), 'enemy');

    expect(zone.has('6,0'), '4 格移动 + 2 格射程').toBe(true);
    expect(zone.has('7,0'), '再远就打不到了').toBe(false);
    /* 距离 1 那格虽然出生点打不到，但走到 (0,1) 就能打到 */
    expect(zone.has('1,0'), '绕一下就能覆盖贴脸格').toBe(true);
  });

  it('被单位堵死时威胁范围会明显缩小', () => {
    const map = flatMap(8, 8);
    const spot = { x: 0, y: 0 };

    const freeFoe = makeUnit({ id: 'foe', pos: spot, team: 'enemy', mov: 4 });
    const freeZone = computeThreatZone(makeState(map, [freeFoe]), 'enemy');

    /* 用**玩家**单位来堵。用自己的友军来堵是不行的 ——
       那些友军本身也是敌人，会给敌方威胁范围添砖加瓦，
       断言就分不清"foe 绕过去了"还是"堵路的人自己能打到"。 */
    const stuckFoe = makeUnit({ id: 'foe', pos: spot, team: 'enemy', mov: 4 });
    const wallA = makeUnit({ id: 'wallA', pos: { x: 1, y: 0 } });
    const wallB = makeUnit({ id: 'wallB', pos: { x: 0, y: 1 } });
    const stuckZone = computeThreatZone(makeState(map, [stuckFoe, wallA, wallB]), 'enemy');

    /* 角落被堵死，一步也挪不动，只剩脚下那一圈 */
    expect([...stuckZone].sort()).toEqual(['0,1', '1,0']);
    expect(stuckZone.size).toBeLessThan(freeZone.size);
  });

  it('阵亡的敌人不再贡献威胁范围', () => {
    const map = flatMap(8, 8);
    const alive = makeUnit({
      id: 'alive',
      pos: { x: 0, y: 0 },
      team: 'enemy',
      mov: 1,
    });
    const corpse = makeUnit({
      id: 'corpse',
      pos: { x: 6, y: 6 },
      team: 'enemy',
      mov: 4,
      hp: 0,
    });
    const hero = makeUnit({ id: 'hero', pos: { x: 3, y: 3 } });
    const state = makeState(map, [hero, alive, corpse]);

    const zone = computeThreatZone(state, 'enemy');
    expect(zone.has('1,0')).toBe(true);
    expect(zone.has('5,6'), '尸体本来能威胁到这一带').toBe(false);
  });

  it('没有敌人时是空集', () => {
    const map = flatMap(5, 5);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
    expect(computeThreatZone(makeState(map, [hero]), 'enemy').size).toBe(0);
  });
  it('移动力越大，威胁范围单调不减', () => {
    const map = flatMap(11, 11);
    const sizes = [1, 2, 3, 4].map((mov) => {
      const foe = makeUnit({
        id: 'foe',
        pos: { x: 5, y: 5 },
        team: 'enemy',
        mov,
      });
      const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
      return computeThreatZone(makeState(map, [hero, foe]), 'enemy').size;
    });

    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });
});

describe('控制区（ZOC）在界面上的表现', () => {
  it('踏进去就停的格子被单独标出来，但它们仍然是合法落点', () => {
    const map = flatMap(7, 3);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 1 }, mov: 10 });
    const foe = makeUnit({ id: 'foe', pos: { x: 3, y: 1 }, team: 'enemy' });

    const highlights = computeHighlights(makeState(map, [hero, foe]), hero);

    expect(highlights.zocStopKeys.has('2,1')).toBe(true);
    expect(highlights.zocStopKeys.has('3,0')).toBe(true);
    /* 关键：移动范围**包含**这些格子。ZOC 限制的是"能不能继续走"，
       不是"能不能进" —— 画成走不到的话玩家会以为规则是禁入。 */
    expect(highlights.moveKeys.has('2,1')).toBe(true);
    expect(highlights.moveKeys.has('3,0')).toBe(true);
    /* 敌人的另一侧到不了 */
    expect(highlights.moveKeys.has('4,1')).toBe(false);
  });

  it('走着走着被控制区截断时，攻击范围也跟着缩 —— 两者用的是同一次移动范围计算', () => {
    const map = flatMap(9, 3);
    /* 弓手射程 2。没有 ZOC 时它绕到 (5,1) 就能打到 (7,1)；
       被截在 (3,0) 之后就只能够到 (5,0) 了。 */
    const archer = makeRangedUnit({ id: 'archer', pos: { x: 0, y: 1 }, mov: 8 });
    const blocker = makeUnit({ id: 'blocker', pos: { x: 3, y: 1 }, team: 'enemy' });

    const highlights = computeHighlights(makeState(map, [archer, blocker]), archer);

    expect(highlights.moveKeys.has('3,0'), '停在控制区里').toBe(true);
    expect(highlights.moveKeys.has('5,0'), '但走不过去').toBe(false);
    expect(highlights.attackPotentialKeys.has('5,0'), '从停靠点往后射 2 格').toBe(true);
    expect(highlights.attackPotentialKeys.has('7,1'), '再远就够不着了').toBe(false);
  });

  it('没被贴住时控制区提示为空，界面不会多出噪音', () => {
    const map = flatMap(9, 9);
    const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 }, mov: 3 });
    const far = makeUnit({ id: 'far', pos: { x: 8, y: 8 }, team: 'enemy' });

    const highlights = computeHighlights(makeState(map, [hero, far]), hero);
    expect(highlights.zocStopKeys.size).toBe(0);
  });
});
