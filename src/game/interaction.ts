import {
  attackableTargets,
  canAct,
  carriedRange,
  computeMoveRange,
  key,
  livingUnitsOf,
  reachableTiles,
  samePos,
  tilesInRange,
  unitAt,
} from '../core';
import type { BattleState, MoveRange, Team, Unit, Vec2 } from '../core';

/**
 * 点击意图判定 —— 纯函数，可在 Node 里测。
 *
 * 为什么值得单独抽出来：
 *   点一下格子到底意味着"移动 / 攻击 / 换选 / 取消"，是一堆容易写漏的分支。
 *   放在场景类里就只能靠人手点，漏掉一条分支根本发现不了。
 *
 *   这个文件就是被一个真实 bug 逼出来的：
 *   `selecting` 分支当时只认「点蓝格移动」和「点友军换选」，
 *   唯独没有「点敌人攻击」—— 于是不移动就永远打不了人，
 *   哪怕敌人就贴在脸上。core 和 AI 都是对的，纯粹是交互漏了一条路。
 *   抽出来之后，那条路径就有回归测试锁着了。
 */

export type UiMode = 'idle' | 'selecting' | 'moved';

/**
 * 一个单位被选中时，画面上该亮哪些格子。
 *
 * 场景类拿它来绘制；`resolveClick` 拿 `attackNowKeys` 来判断"这一点算不算攻击"。
 * 两边共用同一份计算，就不会出现"格子画成红的、点下去却不打"这种不一致。
 */
export interface Highlights {
  /** 可以停留的格子（只有还没移动过时才有内容） */
  moveKeys: Set<string>;
  /** 以**当前位置**就能打到的格子 */
  attackNowKeys: Set<string>;
  /** 移动之后"有可能"打到的格子（仅用于红色提示，点击时不算数） */
  attackPotentialKeys: Set<string>;
  /**
   * 移动范围里**踏进去就会停下**的格子（敌人控制区，ZOC）。
   *
   * 没有这个提示的话，"我为什么走不到那边"就是无解的 —— 玩家只会觉得卡。
   * 有了它，移动范围会视觉上分成"能自由走动"和"走到这为止"两段，
   * 规则不用解释也看得懂。
   */
  zocStopKeys: Set<string>;
  /** 移动范围本体，供路径预览使用 */
  moveRange: MoveRange | null;
}

export function computeHighlights(state: BattleState, unit: Unit | null): Highlights {
  const moveKeys = new Set<string>();
  const attackNowKeys = new Set<string>();
  const attackPotentialKeys = new Set<string>();
  const zocStopKeys = new Set<string>();
  let moveRange: MoveRange | null = null;

  if (!unit || unit.hp <= 0 || unit.done) {
    return { moveKeys, attackNowKeys, attackPotentialKeys, zocStopKeys, moveRange };
  }

  /* 1. 原地就能打到的敌人 */
  for (const target of attackableTargets(state, unit)) {
    attackNowKeys.add(key(target.pos));
  }

  if (unit.moved) {
    return { moveKeys, attackNowKeys, attackPotentialKeys, zocStopKeys, moveRange };
  }

  /* 2. 移动范围（Dijkstra，含 ZOC 截断） */
  moveRange = computeMoveRange(state.map, state.units, unit);
  for (const k of moveRange.destinations) moveKeys.add(k);
  for (const k of moveRange.stops) zocStopKeys.add(k);

  /* 3. 移动后可能打到的格子：所有落点的射程并集，去掉自己已经能站的格子。
        这就是火纹里那圈红色提示，直接告诉玩家"我能威胁到哪"。
        射程取自**武器**，所以换了武器这套计算自动跟着变。 */
  for (const from of reachableTiles(moveRange)) {
    for (const tile of tilesInRange(state.map, from, unit.weapon.range)) {
      const k = key(tile);
      if (!moveKeys.has(k)) attackPotentialKeys.add(k);
    }
  }

  return { moveKeys, attackNowKeys, attackPotentialKeys, zocStopKeys, moveRange };
}

/**
 * 一方的「威胁范围」：所有存活单位在**下一轮**能打到的每一格。
 *
 * 这才是战棋里那个经典的红区，和"以当前位置能打到的格子"完全不是一回事 ——
 * 敌人可以先移动再攻击，所以必须把每个单位的移动范围整个展开，
 * 再从每个落点算一遍射程，最后求并集。
 *
 * 玩家靠它回答一个问题：**"我把人放这儿，下回合会不会挨打？"**
 * 没有它就只能一格一格数敌人够不够得着。
 *
 * ⚠️ 不要按 `done` 过滤。玩家阶段里敌人的 `done` 全是 true
 * （那是它们上一轮打完留下的），过滤掉就什么都不剩了。
 */
export function computeThreatZone(state: BattleState, team: Team): Set<string> {
  const zone = new Set<string>();

  for (const unit of livingUnitsOf(state, team)) {
    const range = computeMoveRange(state.map, state.units, unit);
    /* 按**携带武器里最大的射程**算，不是当前装备 ——
       敌人可以在出手前换武器，按当前装备算会低估危险。 */
    const reach = carriedRange(unit);
    for (const from of reachableTiles(range)) {
      for (const tile of tilesInRange(state.map, from, reach)) {
        zone.add(key(tile));
      }
    }
  }

  return zone;
}

export type ClickIntent =
  /** 什么都不做（敌方回合、战斗已结束、或点了没有意义的地方） */
  | { kind: 'none' }
  /** 取消当前选择 */
  | { kind: 'cancel' }
  /** 选中 / 换选一个我方单位 */
  | { kind: 'select'; unitId: string }
  /** 移动到某格 */
  | { kind: 'move'; unitId: string; to: Vec2 }
  /** 攻击某个敌人 */
  | { kind: 'attack'; unitId: string; targetId: string }
  /** 待机，结束该单位本次行动 */
  | { kind: 'wait'; unitId: string };

export interface ClickContext {
  state: BattleState;
  mode: UiMode;
  selectedId: string | null;
  tile: Vec2;
  /** 当前选中单位可以停留的格子（由场景算好并传进来） */
  moveKeys: ReadonlySet<string>;
  /** 以**当前位置**就能打到的格子 —— 判断"原地能不能打"就靠它 */
  attackNowKeys: ReadonlySet<string>;
}

export function resolveClick(ctx: ClickContext): ClickIntent {
  const { state, mode, tile } = ctx;

  /* 敌方回合、或胜负已分：任何点击都不该产生指令 */
  if (state.phase !== 'playing' || state.activeTeam !== 'player') return { kind: 'none' };

  const clicked = unitAt(state.units, tile);

  if (mode === 'idle') {
    if (clicked && clicked.team === 'player') {
      /* 还能动的单位照旧可以选。
         另外**带两把以上武器、已经行动完的单位也要能选中** ——
         换武器是自由动作，而"用哪把武器迎接敌方回合"正是这个机制的核心决策
         （见 docs/rules.md 3.5）。不放开这条的话，玩家打完就再也换不了武器了。 */
      if (canAct(state, clicked) || clicked.weapons.length > 1) {
        return { kind: 'select', unitId: clicked.id };
      }
    }
    /* 点敌人 / 点空地 / 点只带一把武器又已行动完的友军：什么都不做 */
    return { kind: 'none' };
  }

  const selected =
    ctx.selectedId === null
      ? null
      : (state.units.find((u) => u.id === ctx.selectedId) ?? null);
  if (!selected || selected.hp <= 0 || selected.done) return { kind: 'cancel' };

  const at = key(tile);

  if (mode === 'selecting') {
    /* 点自己 = 放弃这次选择（想换个单位，或者重新想） */
    if (samePos(tile, selected.pos)) return { kind: 'cancel' };

    /* ⚠️ 这一条就是那个 bug 的修复点：
       原地不动、敌人已在射程内 → 直接开打。
       少了它，玩家必须先"随便走一格"才能进 moved 模式，这不合理。 */
    if (clicked && clicked.team !== selected.team && ctx.attackNowKeys.has(at)) {
      return { kind: 'attack', unitId: selected.id, targetId: clicked.id };
    }

    /* 点另一个还能动的我方单位 = 换选 */
    if (clicked && clicked.team === selected.team && canAct(state, clicked)) {
      return { kind: 'select', unitId: clicked.id };
    }

    if (ctx.moveKeys.has(at)) return { kind: 'move', unitId: selected.id, to: tile };

    return { kind: 'cancel' };
  }

  /* mode === 'moved'：位置已经定了，只剩「打谁」或「待机」 */
  if (clicked && clicked.team !== selected.team && ctx.attackNowKeys.has(at)) {
    return { kind: 'attack', unitId: selected.id, targetId: clicked.id };
  }
  return { kind: 'wait', unitId: selected.id };
}
