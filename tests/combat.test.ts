import { describe, expect, it } from 'vitest';

import {
  CRIT_MULTIPLIER,
  DOUBLE_THRESHOLD,
  EXP_ON_HIT,
  EXP_ON_KILL,
  forecast,
  planStrikes,
  resolveCombat,
  strikeProfile,
  triangleBetween,
  type WeaponKind,
} from '../src/core';
import { flatMap, makeRangedUnit, makeState, makeUnit, mapWith, testWeapon } from './fixtures';

const ALL_KINDS: readonly WeaponKind[] = ['sword', 'axe', 'lance', 'bow', 'tome'];

describe('武器相克（武器三角）', () => {
  it('剑 > 斧 > 枪 > 剑，是个闭环', () => {
    expect(triangleBetween('sword', 'axe')).toBe('advantage');
    expect(triangleBetween('axe', 'lance')).toBe('advantage');
    expect(triangleBetween('lance', 'sword')).toBe('advantage');
  });

  it('反过来的方向就是不利', () => {
    expect(triangleBetween('axe', 'sword')).toBe('disadvantage');
    expect(triangleBetween('lance', 'axe')).toBe('disadvantage');
    expect(triangleBetween('sword', 'lance')).toBe('disadvantage');
  });

  it('弓和魔法不入环：既不占优也不吃亏', () => {
    for (const kind of ALL_KINDS) {
      expect(triangleBetween('bow', kind)).toBe('neutral');
      expect(triangleBetween('tome', kind)).toBe('neutral');
      expect(triangleBetween(kind, 'bow')).toBe('neutral');
      expect(triangleBetween(kind, 'tome')).toBe('neutral');
    }
  });

  it('同种武器之间不相克', () => {
    for (const kind of ALL_KINDS) {
      expect(triangleBetween(kind, kind)).toBe('neutral');
    }
  });

  it('相克占优：攻击力 +1、命中 +10', () => {
    const map = flatMap(5, 5);
    const sword = makeUnit({
      id: 's',
      pos: { x: 0, y: 0 },
      atk: 10,
      skill: 6,
      weapon: testWeapon({ kind: 'sword' }),
    });
    const axe = makeUnit({
      id: 'a',
      pos: { x: 1, y: 0 },
      def: 3,
      spd: 5,
      weapon: testWeapon({ kind: 'axe' }),
    });

    const profile = strikeProfile(map, sword, axe);
    /* 伤害 = 10 + 1(相克) − 3 = 8 */
    expect(profile.damage).toBe(8);
    /* 命中 = 60 + (6−5)×5 + 10(测试武器) + 10(相克) = 85 */
    expect(profile.hit).toBe(85);
  });

  it('相克不利：攻击力 −1、命中 −10', () => {
    const map = flatMap(5, 5);
    /* 和上一条对称：这次让斧当攻方、剑当守方，守方属性保持一致 */
    const sword = makeUnit({
      id: 's',
      pos: { x: 0, y: 0 },
      atk: 10,
      def: 3,
      spd: 5,
      weapon: testWeapon({ kind: 'sword' }),
    });
    const axe = makeUnit({
      id: 'a',
      pos: { x: 1, y: 0 },
      skill: 5,
      weapon: testWeapon({ kind: 'axe' }),
    });

    const profile = strikeProfile(map, axe, sword);
    /* 伤害 = 10 − 1(相克) − 3 = 6 */
    expect(profile.damage).toBe(6);
    /* 命中 = 60 + (5−5)×5 + 10(测试武器) − 10(相克) = 60 */
    expect(profile.hit).toBe(60);
  });
});

describe('单次打击公式', () => {
  it('伤害 = 攻 + 武器威力 − 防；命中 = 60 + 技巧差 × 5 + 武器命中', () => {
    const map = flatMap(5, 5);
    const atk = makeUnit({ id: 'atk', pos: { x: 0, y: 0 }, atk: 9, skill: 6 });
    const def = makeUnit({ id: 'def', pos: { x: 1, y: 0 }, def: 3, spd: 5 });

    expect(strikeProfile(map, atk, def)).toEqual({ damage: 6, hit: 75, crit: 0 });
  });

  it('武器威力直接加到伤害上', () => {
    const map = flatMap(5, 5);
    const bare = makeUnit({ id: 'bare', pos: { x: 0, y: 0 }, atk: 6, weapon: testWeapon() });
    const armed = makeUnit({
      id: 'armed',
      pos: { x: 0, y: 0 },
      atk: 6,
      weapon: testWeapon({ might: 4 }),
    });
    const target = makeUnit({ id: 't', pos: { x: 1, y: 0 }, def: 2 });

    expect(strikeProfile(map, bare, target).damage).toBe(4);
    expect(strikeProfile(map, armed, target).damage).toBe(8);
  });

  it('地形加成取自承受方所在格（森林：防 +1、闪避 +20）', () => {
    const map = mapWith([{ x: 1, y: 0, t: 'forest' }]);
    const atk = makeUnit({ id: 'atk', pos: { x: 0, y: 0 }, atk: 9, skill: 6 });
    const def = makeUnit({ id: 'def', pos: { x: 1, y: 0 }, def: 3, spd: 5 });

    expect(strikeProfile(map, atk, def)).toEqual({ damage: 5, hit: 55, crit: 0 });
  });

  it('伤害有下限 1、命中被夹在 [5, 100]', () => {
    const map = flatMap(5, 5);
    /* 攻 1 打 防 99：原式是 0，但 0 伤害会让双方"互相打不动"从而永远分不出胜负
       （实测死局见 combat.ts 的 MIN_DAMAGE 说明），所以下限是 1。 */
    const weak = makeUnit({ id: 'weak', pos: { x: 0, y: 0 }, atk: 1, skill: 0 });
    const tank = makeUnit({ id: 'tank', pos: { x: 1, y: 0 }, def: 99, spd: 99 });
    expect(strikeProfile(map, weak, tank)).toEqual({ damage: 1, hit: 5, crit: 0 });

    const sniper = makeUnit({ id: 'sniper', pos: { x: 0, y: 0 }, atk: 50, skill: 99 });
    const sloth = makeUnit({ id: 'sloth', pos: { x: 1, y: 0 }, def: 0, spd: 0 });
    expect(strikeProfile(map, sniper, sloth).hit).toBe(100);
  });
});

describe('暴击', () => {
  it('暴击率只看武器，不看技巧', () => {
    const map = flatMap(5, 5);
    const target = makeUnit({ id: 't', pos: { x: 1, y: 0 } });
    const bare = makeUnit({
      id: 'bare',
      pos: { x: 0, y: 0 },
      skill: 99,
      weapon: testWeapon({ crit: 0 }),
    });
    const deadly = makeUnit({
      id: 'deadly',
      pos: { x: 0, y: 0 },
      skill: 0,
      weapon: testWeapon({ crit: 25 }),
    });

    expect(strikeProfile(map, bare, target).crit).toBe(0);
    expect(strikeProfile(map, deadly, target).crit).toBe(25);
  });

  it('crit=0 的武器不掷暴击骰：随机游标只推进一次', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({
      id: 'a',
      pos: { x: 0, y: 0 },
      atk: 5,
      def: 0,
      skill: 99,
      weapon: testWeapon({ crit: 0 }),
    });
    const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 20, maxHp: 20, def: 0 });

    const next = resolveCombat(makeState(map, [a, b], { seed: 42 }), 'a', 'b');
    expect(next.rngCursor).toBe(1);
    expect(next.units.find((u) => u.id === 'b')?.hp).toBe(15);
  });

  it('crit>0 时命中之后再掷一次暴击骰，游标推进两次', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({
      id: 'a',
      pos: { x: 0, y: 0 },
      atk: 5,
      def: 0,
      skill: 99,
      weapon: testWeapon({ crit: 30 }),
    });
    const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 40, maxHp: 40, def: 0 });

    const next = resolveCombat(makeState(map, [a, b], { seed: 7 }), 'a', 'b');
    expect(next.rngCursor).toBe(2);
  });

  it(`必然暴击时造成 ${CRIT_MULTIPLIER} 倍伤害`, () => {
    const map = flatMap(5, 5);
    const a = makeUnit({
      id: 'a',
      pos: { x: 0, y: 0 },
      atk: 6,
      def: 0,
      skill: 99,
      weapon: testWeapon({ crit: 100 }),
    });
    const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 40, maxHp: 40, def: 0 });

    const next = resolveCombat(makeState(map, [a, b], { seed: 1 }), 'a', 'b');
    expect(next.units.find((u) => u.id === 'b')?.hp).toBe(40 - 6 * CRIT_MULTIPLIER);
    expect(next.log.some((line) => line.includes('会心'))).toBe(true);
  });

  it('落空时不掷暴击骰：没打中谈不上会心', () => {
    const map = flatMap(5, 5);
    const results = Array.from({ length: 200 }, (_, seed) => {
      const a = makeUnit({
        id: 'a',
        pos: { x: 0, y: 0 },
        atk: 6,
        skill: 0,
        weapon: testWeapon({ crit: 50 }),
      });
      const b = makeRangedUnit({
        id: 'b',
        pos: { x: 1, y: 0 },
        team: 'enemy',
        hp: 40,
        maxHp: 40,
        def: 0,
        spd: 99,
      });
      return resolveCombat(makeState(map, [a, b], { seed }), 'a', 'b');
    });

    const missed = results.find((r) => r.units.find((u) => u.id === 'b')?.hp === 40);
    expect(missed).toBeDefined();
    /* 落空 -> 只掷了命中骰；如果也掷了暴击骰这里会是 2 */
    expect(missed?.rngCursor).toBe(1);
  });

  it('预测里的暴击率与伤害都是"不暴击"口径，不参与伤害预期', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 6, weapon: testWeapon({ crit: 50 }) });
    const b = makeUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', def: 0, hp: 20, maxHp: 20 });

    const f = forecast(map, a, b);
    expect(f.attacker.crit).toBe(50);
    expect(f.defenderHpAfter).toBe(14);
  });
});

describe('反击判定', () => {
  it('近战对砍：双方都会出手', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 9, def: 4, spd: 6, skill: 6, hp: 24, maxHp: 24 });
    const b = makeUnit({ id: 'b', pos: { x: 1, y: 0 }, atk: 8, def: 3, spd: 5, skill: 4, hp: 22, maxHp: 22 });

    const f = forecast(map, a, b);
    expect(f.distance).toBe(1);
    expect(f.attacker).toEqual({ damage: 6, hit: 75, crit: 0, doubles: false });
    expect(f.counter).toEqual({ damage: 4, hit: 60, crit: 0, doubles: false });
    expect(f.defenderHpAfter).toBe(16);
    expect(f.attackerHpAfter).toBe(20);
  });

  it('射程不重叠时不发生反击：弓在距离 1 打不到人', () => {
    const map = flatMap(5, 5);
    const sword = makeUnit({ id: 'sword', pos: { x: 0, y: 0 } });
    const archer = makeRangedUnit({ id: 'archer', pos: { x: 1, y: 0 } });

    expect(forecast(map, sword, archer).counter).toBeNull();
  });

  it('弓手从距离 2 打近战，近战摸不到 → 无反击', () => {
    const map = flatMap(5, 5);
    const archer = makeRangedUnit({ id: 'archer', pos: { x: 0, y: 0 } });
    const sword = makeUnit({ id: 'sword', pos: { x: 2, y: 0 } });

    const f = forecast(map, archer, sword);
    expect(f.distance).toBe(2);
    expect(f.counter).toBeNull();
    expect(f.attackerHpAfter).toBe(archer.hp);
  });

  it('射程是武器的属性：同一把剑给谁都是 1 格', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 } });
    const b = makeUnit({ id: 'b', pos: { x: 2, y: 0 }, team: 'enemy' });

    /* 距离 2，剑够不着 -> 连攻击都不合法 */
    expect(forecast(map, a, b).distance).toBe(2);
    expect(() => resolveCombat(makeState(map, [a, b]), 'a', 'b')).toThrow(/无法攻击距离/);
  });
});

describe('追击（速度差 ≥ 4）', () => {
  it(`攻方速度领先 ${DOUBLE_THRESHOLD} 点时打两下`, () => {
    const map = flatMap(5, 5);
    const fast = makeUnit({ id: 'fast', pos: { x: 0, y: 0 }, atk: 6, def: 2, spd: 10, skill: 8, hp: 30, maxHp: 30 });
    const slow = makeUnit({ id: 'slow', pos: { x: 1, y: 0 }, atk: 6, def: 2, spd: 5, skill: 8, hp: 30, maxHp: 30 });

    expect(planStrikes(map, fast, slow)).toHaveLength(3);

    const f = forecast(map, fast, slow);
    expect(f.attacker.doubles).toBe(true);
    expect(f.defenderHpAfter).toBe(30 - 4 * 2);
    expect(f.attackerHpAfter).toBe(30 - 4);
  });

  it('守方速度领先时也能追击', () => {
    const map = flatMap(5, 5);
    const slowAtk = makeUnit({ id: 'slowAtk', pos: { x: 0, y: 0 }, atk: 6, def: 2, spd: 3, skill: 8, hp: 30, maxHp: 30 });
    const fastDef = makeUnit({ id: 'fastDef', pos: { x: 1, y: 0 }, atk: 6, def: 2, spd: 10, skill: 8, hp: 30, maxHp: 30 });

    expect(planStrikes(map, slowAtk, fastDef)).toHaveLength(3);

    const f = forecast(map, slowAtk, fastDef);
    expect(f.attacker.doubles).toBe(false);
    expect(f.counter?.doubles).toBe(true);
    expect(f.defenderHpAfter).toBe(30 - 4);
    expect(f.attackerHpAfter).toBe(30 - 4 * 2);
  });

  it(`速度差恰好 ${DOUBLE_THRESHOLD - 1} 时不追击`, () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, spd: 9 });
    const b = makeUnit({ id: 'b', pos: { x: 1, y: 0 }, spd: 6 });
    expect(planStrikes(map, a, b)).toHaveLength(2);
  });
});

describe('实际结算', () => {
  it('命中率 100 时必然命中，并推进随机游标', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 5, def: 0, skill: 99 });
    const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 20, maxHp: 20, def: 0 });

    const next = resolveCombat(makeState(map, [a, b], { seed: 42 }), 'a', 'b');
    expect(next.units.find((u) => u.id === 'b')?.hp).toBe(15);
    expect(next.rngCursor).toBe(1);
  });

  it('击杀后立刻中断，不再吃反击、也不再追击', () => {
    const map = flatMap(5, 5);
    const killer = makeUnit({ id: 'killer', pos: { x: 0, y: 0 }, atk: 100, def: 2, spd: 10, skill: 99, hp: 30, maxHp: 30 });
    const victim = makeRangedUnit({ id: 'victim', pos: { x: 1, y: 0 }, team: 'enemy', atk: 10, def: 0, spd: 1, skill: 99, hp: 10, maxHp: 20 });

    const next = resolveCombat(makeState(map, [killer, victim], { seed: 7 }), 'killer', 'victim');
    expect(next.units.find((u) => u.id === 'victim')?.hp).toBe(0);
    expect(next.units.find((u) => u.id === 'killer')?.hp).toBe(30);
    expect(next.rngCursor).toBe(1);
    expect(next.log.some((line) => line.includes('阵亡'))).toBe(true);
  });

  it('未命中时伤害为 0，日志里有记录', () => {
    const map = flatMap(5, 5);
    const results = Array.from({ length: 200 }, (_, seed) => {
      const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 5, skill: 0 });
      const b = makeRangedUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', hp: 20, maxHp: 20, def: 0, spd: 99 });
      return resolveCombat(makeState(map, [a, b], { seed }), 'a', 'b');
    });

    const missed = results.find((r) => r.units.find((u) => u.id === 'b')?.hp === 20);
    expect(missed).toBeDefined();
    expect(missed?.log.some((line) => line.includes('未命中'))).toBe(true);
  });

  it('纯函数：不修改传入的 state，且同种子同局面完全一致', () => {
    const build = () => {
      const map = flatMap(5, 5);
      const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 9, def: 4, spd: 6, skill: 6, hp: 24, maxHp: 24 });
      const b = makeUnit({ id: 'b', pos: { x: 1, y: 0 }, team: 'enemy', atk: 8, def: 3, spd: 5, skill: 4, hp: 22, maxHp: 22 });
      return makeState(map, [a, b], { seed: 2026 });
    };

    const before = build();
    const snapshot = JSON.stringify(before);
    const once = resolveCombat(before, 'a', 'b');

    expect(JSON.stringify(before)).toBe(snapshot);
    expect(JSON.stringify(once)).toBe(JSON.stringify(resolveCombat(build(), 'a', 'b')));
  });

  it('拒绝非法战斗：友军、超射程、不存在的单位', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 } });
    const ally = makeUnit({ id: 'ally', pos: { x: 1, y: 0 } });
    const far = makeUnit({ id: 'far', pos: { x: 4, y: 4 }, team: 'enemy' });
    const state = makeState(map, [a, ally, far]);

    expect(() => resolveCombat(state, 'a', 'ally')).toThrow(/友军/);
    expect(() => resolveCombat(state, 'a', 'far')).toThrow(/无法攻击距离/);
    expect(() => resolveCombat(state, 'a', 'ghost')).toThrow(/不存在/);
  });
});

describe('经验与升级接进战斗', () => {
  const ALL_GROWTH = { maxHp: 100, atk: 100, def: 0, spd: 0, skill: 0 };

  it('击杀会带来经验，攒满就升级并涨属性', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({
      id: 'a',
      pos: { x: 0, y: 0 },
      atk: 100,
      skill: 99,
      /* 只差 10 点就升级，这一下击杀（15+35=50）必然升级 */
      exp: 90,
      growths: ALL_GROWTH,
    });
    const b = makeRangedUnit({
      id: 'b',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      hp: 10,
      maxHp: 10,
      def: 0,
    });

    const next = resolveCombat(makeState(map, [a, b], { seed: 1 }), 'a', 'b');
    const after = next.units.find((u) => u.id === 'a');
    if (!after) throw new Error('找不到攻击方');

    expect(after.level).toBe(2);
    expect(after.exp).toBe(40);
    expect(after.maxHp).toBe(21);
    expect(after.atk).toBe(101);
    /* 升级补的那 1 点生命上限同时补进当前 HP */
    expect(after.hp).toBe(21);
    expect(next.log.some((line) => line.includes('升到 2 级'))).toBe(true);

    /* 游标 = 1 次命中骰 + 2 次成长掷骰（maxHp 和 atk，其余成长率为 0 不掷） */
    expect(next.rngCursor).toBe(3);
  });

  it('没升级时不消耗额外游标 —— 经验只加数字', () => {
    const map = flatMap(5, 5);
    const a = makeUnit({ id: 'a', pos: { x: 0, y: 0 }, atk: 5, skill: 99, exp: 0 });
    const b = makeRangedUnit({
      id: 'b',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      def: 0,
    });

    const next = resolveCombat(makeState(map, [a, b], { seed: 42 }), 'a', 'b');
    expect(next.rngCursor).toBe(1);
    expect(next.units.find((u) => u.id === 'a')?.exp).toBe(EXP_ON_HIT);
  });

  it('阵亡的一方拿不到经验', () => {
    const map = flatMap(5, 5);
    const killer = makeUnit({
      id: 'killer',
      pos: { x: 0, y: 0 },
      atk: 100,
      def: 0,
      spd: 10,
      skill: 99,
      hp: 30,
      maxHp: 30,
    });
    const victim = makeUnit({
      id: 'victim',
      pos: { x: 1, y: 0 },
      team: 'enemy',
      atk: 1,
      def: 0,
      spd: 20,
      skill: 99,
      hp: 10,
      maxHp: 10,
    });

    const next = resolveCombat(makeState(map, [killer, victim], { seed: 3 }), 'killer', 'victim');
    /* 守方本来会反击并且速度领先（能追击），但第一段就被打死了 */
    expect(next.units.find((u) => u.id === 'victim')?.exp).toBe(0);
    expect(next.units.find((u) => u.id === 'killer')?.exp).toBe(EXP_ON_HIT + EXP_ON_KILL);
  });

  it('守方一次都没反击就完全没有经验', () => {
    const map = flatMap(5, 5);
    const sword = makeUnit({ id: 'sword', pos: { x: 0, y: 0 }, atk: 5, skill: 99 });
    /* 弓手在距离 1 打不到人 → 不会反击 → 没有经验 */
    const archer = makeRangedUnit({ id: 'archer', pos: { x: 1, y: 0 }, team: 'enemy' });

    const next = resolveCombat(makeState(map, [sword, archer], { seed: 5 }), 'sword', 'archer');
    expect(next.units.find((u) => u.id === 'archer')?.exp).toBe(0);
    expect(next.units.find((u) => u.id === 'sword')?.exp).toBe(EXP_ON_HIT);
  });

  it('经验结算可复现：同种子同局面结果逐字节相同', () => {
    const build = () => {
      const map = flatMap(5, 5);
      const growths = { maxHp: 50, atk: 50, def: 50, spd: 50, skill: 50 };
      const a = makeUnit({
        id: 'a',
        pos: { x: 0, y: 0 },
        atk: 6,
        def: 3,
        spd: 6,
        skill: 6,
        hp: 24,
        maxHp: 24,
        exp: 60,
        growths,
      });
      const b = makeUnit({
        id: 'b',
        pos: { x: 1, y: 0 },
        team: 'enemy',
        atk: 5,
        def: 2,
        spd: 5,
        skill: 5,
        hp: 22,
        maxHp: 22,
        exp: 60,
        growths,
      });
      return makeState(map, [a, b], { seed: 2027 });
    };

    const once = resolveCombat(build(), 'a', 'b');
    expect(JSON.stringify(once)).toBe(JSON.stringify(resolveCombat(build(), 'a', 'b')));
  });
});
