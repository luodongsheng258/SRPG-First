import { key, manhattan } from './grid';
import { TERRAIN } from './terrain';
import { teamLabel } from './util';
import type { BattleState, Unit, Vec2 } from './types';

/**
 * 增援到场（见 docs/rules.md 6.5）。
 *
 * 由 `endTurn` 调用：把 `turn <= 当前回合` 的待命增援放进战场。
 *
 * ⚠️ 单位是**开局就造好的**（`UnitBlueprint`），这里只补 `id` / `slot` / `pos`。
 * 因为 `endTurn` 是纯函数，拿不到 `defs` / `weapons` 两张表。
 */

/** 这一格现在能不能站人：在图内、地形可通行、没被活着的单位占着 */
function standable(state: BattleState, occupied: ReadonlySet<string>, tile: Vec2): boolean {
  if (tile.x < 0 || tile.y < 0) return false;
  if (tile.x >= state.map.width || tile.y >= state.map.height) return false;
  if (TERRAIN[state.map.terrain[tile.y][tile.x]].moveCost === null) return false;
  return !occupied.has(key(tile));
}

/**
 * 找离 target 最近的空格。
 *
 * **为什么不"延期到场"**：那会被玩家用身体堵住刷兵点来利用 ——
 * 站上去敌人就永远不来，等于把增援关掉了。
 * 扫描顺序固定（逐行逐列）+ 严格小于，所以结果完全确定、可回放。
 */
function nearestFreeTile(
  state: BattleState,
  occupied: ReadonlySet<string>,
  target: Vec2,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let y = 0; y < state.map.height; y += 1) {
    for (let x = 0; x < state.map.width; x += 1) {
      const tile: Vec2 = { x, y };
      if (!standable(state, occupied, tile)) continue;
      const d = manhattan(tile, target);
      /* 严格小于 → 平局时保留先扫到的那个（靠上、靠左），保证确定 */
      if (d < bestDist) {
        bestDist = d;
        best = tile;
      }
    }
  }

  return best;
}

/**
 * 结算到期增援，返回新状态。没有到期的就原样返回（保持引用相等）。
 *
 * 用 `turn <= 当前回合` 而不是 `=== `：万一某回合因为别的原因没结算到，
 * 下一回合会补上，不会永久丢掉一波兵。
 */
export function arriveReinforcements(state: BattleState, turn: number): BattleState {
  const due = state.pendingReinforcements.filter((pending) => pending.turn <= turn);
  if (due.length === 0) return state;

  /* 活着的单位才算占位 —— 阵亡的不挡路，和移动判定保持一致 */
  const occupied = new Set(state.units.filter((u) => u.hp > 0).map((u) => key(u.pos)));

  const arrivals: Unit[] = [];
  const notes: string[] = [];
  let index = state.units.length;

  for (const pending of due) {
    const wanted = pending.pos;
    const tile = standable(state, occupied, wanted)
      ? wanted
      : nearestFreeTile(state, occupied, wanted);

    if (tile === null) {
      /* 整张图站满了。别静默吞掉 —— 说清楚，否则以后查账会以为是 bug */
      notes.push('（战场已无空位，一波增援无法到场）');
      continue;
    }

    occupied.add(key(tile));
    const moved = key(tile) !== key(wanted);
    const { blueprint } = pending;

    arrivals.push({
      ...blueprint,
      id: `${blueprint.team}-${blueprint.defId}-r${index}`,
      slot: `${blueprint.defId}#r${index}`,
      pos: { x: tile.x, y: tile.y },
    });
    notes.push(
      `增援到场：${blueprint.name}（${teamLabel(blueprint.team)}）` +
        ` @ (${tile.x}, ${tile.y})` +
        (moved ? ` ← 原定 (${wanted.x}, ${wanted.y}) 被占` : ''),
    );
    index += 1;
  }

  return {
    ...state,
    units: [...state.units, ...arrivals],
    pendingReinforcements: state.pendingReinforcements.filter((r) => r.turn > turn),
    log: [...state.log, ...notes],
  };
}
