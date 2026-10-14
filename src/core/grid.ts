import { TERRAIN } from './terrain';
import type { BattleMap, TerrainDef, Unit, Vec2 } from './types';

/**
 * 四方向网格工具。
 *
 * 距离一律用 **曼哈顿距离**。这是方格战棋（火纹式）的标准做法：
 *   range [1,1] → 上下左右 4 格
 *   range [2,2] → 曼哈顿距离恰好为 2 的 8 格（含斜角）
 *
 * 将来要改六边形，只需要改这个文件里的 DIRS 和 manhattan，
 * 其余所有逻辑（寻路、攻击范围、AI）自动跟着变。
 */

export const DIRS4: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function key(p: Vec2): string {
  return `${p.x},${p.y}`;
}

export function parseKey(k: string): Vec2 {
  const [xs, ys] = k.split(',');
  return { x: Number(xs), y: Number(ys) };
}

export function samePos(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function inBounds(map: BattleMap, p: Vec2): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height;
}

export function terrainAt(map: BattleMap, p: Vec2): TerrainDef {
  if (!inBounds(map, p)) {
    throw new Error(`坐标越界：(${p.x}, ${p.y})，地图尺寸 ${map.width}x${map.height}`);
  }
  return TERRAIN[map.terrain[p.y][p.x]];
}

/** 进入该格的移动力消耗；null 表示不可通行 */
export function moveCostAt(map: BattleMap, p: Vec2): number | null {
  return terrainAt(map, p).moveCost;
}

export function neighbors(map: BattleMap, p: Vec2): Vec2[] {
  const out: Vec2[] = [];
  for (const d of DIRS4) {
    const n: Vec2 = { x: p.x + d.x, y: p.y + d.y };
    if (inBounds(map, n)) out.push(n);
  }
  return out;
}

/** 存活单位查找。阵亡单位（hp<=0）不再占据格子。 */
export function unitAt(units: readonly Unit[], p: Vec2): Unit | undefined {
  return units.find((u) => u.hp > 0 && samePos(u.pos, p));
}

export function isOccupied(units: readonly Unit[], p: Vec2): boolean {
  return unitAt(units, p) !== undefined;
}

export function livingUnits(units: readonly Unit[]): Unit[] {
  return units.filter((u) => u.hp > 0);
}

/** 从 from 出发、攻击距离为 range 时能打到的所有格子。
 * 注意这里**不考虑单位阻挡**：地形不挡箭，只挡脚。
 */
export function tilesInRange(map: BattleMap, from: Vec2, range: readonly [number, number]): Vec2[] {
  const [min, max] = range;
  const out: Vec2[] = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const target: Vec2 = { x, y };
      const d = manhattan(from, target);
      if (d >= min && d <= max) out.push(target);
    }
  }
  return out;
}
