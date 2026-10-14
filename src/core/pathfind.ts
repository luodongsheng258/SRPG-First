import { key, livingUnits, moveCostAt, neighbors, parseKey, unitAt } from './grid';
import type { BattleMap, Team, Unit, Vec2 } from './types';

/**
 * 移动范围计算。
 *
 * ⚠️ 新手最容易写错的地方：移动范围**不是**"曼哈顿距离 ≤ mov"。
 * 正确做法是在**带权图**上跑 Dijkstra：每个格子的进入代价由地形决定（森林 2、山地 3…）。
 *
 * 阻挡规则（火纹式，见 docs/rules.md）：
 *   - 不可通行地形（moveCost === null）：完全不能进
 *   - 敌方单位所在格：完全不能进，也不能穿过
 *   - 友方单位所在格：**可以穿过，但不能停留**
 *   - 自己所在格：算作一个"原地不动"的合法落点
 *   - 敌方控制区（ZOC）：**可以进，但进去就停**，见 `computeZoc`
 */

/**
 * 控制区（ZOC / zone of control）。
 *
 * 定义：**与某一方任意存活单位相邻的格子**，就是那一方的控制区。
 * 不含单位自己脚下那格 —— 那格本来就不可通行，不需要额外说明。
 *
 * 作用：**踏入敌人控制区的瞬间移动结束**。那格可以站，但不能从它继续往外走。
 * 效果是每个单位实际封住的不再只有脚下 1 格，而是周围一圈：
 * 三个并排的单位能封住一条 5 格宽的通路，防线才真正成立。
 *
 * ⚠️ **起点不检查控制区**（调用方负责，见 `computeMoveRange`）。
 * 已经在敌人身边的单位必须能脱离，否则被贴住一次就永远动不了 ——
 * 那是"麻痹"，不是"控制区"。这条例外也正好让退兵变得自然：
 * 往外走一步就离开了控制区，之后畅通无阻。
 */
export function computeZoc(map: BattleMap, units: readonly Unit[], team: Team): Set<string> {
  const zone = new Set<string>();
  for (const unit of livingUnits(units)) {
    if (unit.team !== team) continue;
    for (const n of neighbors(map, unit.pos)) zone.add(key(n));
  }
  return zone;
}

/** 对手阵营。写在这里是为了避免 pathfind → turn 的循环依赖。 */
function opposing(team: Team): Team {
  return team === 'player' ? 'enemy' : 'player';
}

interface HeapNode {
  k: string;
  cost: number;
}

/** 二叉小顶堆。手写一个比引第三方库好：逻辑一页看得完，AI 也好改。 */
class MinHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= this.items[i].cost) break;
      const tmp = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = tmp;
      i = parent;
    }
  }

  pop(): HeapNode | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (last === undefined) return top;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l].cost < this.items[smallest].cost) smallest = l;
        if (r < this.items.length && this.items[r].cost < this.items[smallest].cost) smallest = r;
        if (smallest === i) break;
        const tmp = this.items[smallest];
        this.items[smallest] = this.items[i];
        this.items[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

export interface MoveRange {
  /** 所有"可以经过"的格子 → 从起点到那里的累计移动力消耗 */
  costs: Map<string, number>;
  /** Dijkstra 前驱，用于回溯路径。起点映射到 null */
  prev: Map<string, string | null>;
  /** 真正可以停留的格子（已排除被友军占据的格子），含起点 */
  destinations: string[];
  /**
   * 落点中位于**敌人控制区**的那些。
   *
   * 走到这里就会停下 —— 这是 ZOC 在玩家眼里的全部表现，
   * 所以单独列出来给 UI 上色。注意起点也可能在里面（意味着已经被贴住了）。
   */
  stops: string[];
}

export function computeMoveRange(
  map: BattleMap,
  units: readonly Unit[],
  unit: Unit,
): MoveRange {
  const start = key(unit.pos);
  const costs = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, string | null>([[start, null]]);
  const heap = new MinHeap();
  heap.push({ k: start, cost: 0 });

  /* 敌人的控制区。**起点不在检查范围内** —— 见 computeZoc 的说明。 */
  const zoc = computeZoc(map, units, opposing(unit.team));

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === undefined) break;
    /* 过期节点：堆里可能存着同一格子的旧高代价记录 */
    if (cur.cost > (costs.get(cur.k) ?? Number.POSITIVE_INFINITY)) continue;

    for (const n of neighbors(map, parseKey(cur.k))) {
      const stepCost = moveCostAt(map, n);
      if (stepCost === null) continue;

      const occupant = unitAt(units, n);
      /* 敌方单位完全阻挡；友方单位可以穿过（落点过滤在下面做） */
      if (occupant && occupant.team !== unit.team) continue;

      const total = cur.cost + stepCost;
      if (total > unit.mov) continue;

      const nk = key(n);
      if (total < (costs.get(nk) ?? Number.POSITIVE_INFINITY)) {
        costs.set(nk, total);
        prev.set(nk, cur.k);
        /* 控制区：这一格能站，但**不能从它继续往外走**。
           注意 cost / prev 已经写好了才 continue —— 否则这一格连落点都不是。 */
        if (zoc.has(nk)) continue;
        heap.push({ k: nk, cost: total });
      }
    }
  }

  const destinations: string[] = [];
  for (const k of costs.keys()) {
    if (k === start) {
      destinations.push(k);
      continue;
    }
    if (!unitAt(units, parseKey(k))) destinations.push(k);
  }
  /* 排序保证确定性：AI 在分数相同时的选择永远一致，回放才稳定 */
  destinations.sort();

  return { costs, prev, destinations, stops: destinations.filter((k) => zoc.has(k)) };
}

/**
 * 只考虑地形的**距离场**：从一组起点出发，到每个格子的最短移动力消耗。
 *
 * 忽略单位阻挡（单位是动态的，每次移动都要重算），但对水、山这类
 * **静态**障碍是精确的。
 *
 * 为什么不能拿曼哈顿距离凑合：直线距离会骗人。
 * 隔着一条湖的两个单位直线距离只有 2，实际绕过去要 7 步 ——
 * 用直线距离的话 AI 会认为"我已经站在最近的落点上了"，于是**永远待机**。
 * 实测这样会在第一关制造 0.1% 的永久僵局（`pnpm stall` 抓到的）。
 */
export function terrainDistanceField(
  map: BattleMap,
  sources: readonly Vec2[],
): Map<string, number> {
  const dist = new Map<string, number>();
  const heap = new MinHeap();

  for (const source of sources) {
    /* 起点自身必须可站立，否则它连"距离 0"都不该有 */
    if (moveCostAt(map, source) === null) continue;
    const k = key(source);
    if (dist.has(k)) continue;
    dist.set(k, 0);
    heap.push({ k, cost: 0 });
  }

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === undefined) break;
    if (cur.cost > (dist.get(cur.k) ?? Number.POSITIVE_INFINITY)) continue;

    for (const n of neighbors(map, parseKey(cur.k))) {
      const stepCost = moveCostAt(map, n);
      if (stepCost === null) continue;

      const total = cur.cost + stepCost;
      const nk = key(n);
      if (total < (dist.get(nk) ?? Number.POSITIVE_INFINITY)) {
        dist.set(nk, total);
        heap.push({ k: nk, cost: total });
      }
    }
  }

  return dist;
}

/** 回溯路径，含起点和终点。不可达返回 null。 */
export function findPath(range: MoveRange, to: Vec2): Vec2[] | null {
  const target = key(to);
  if (!range.costs.has(target)) return null;

  const path: Vec2[] = [];
  let cur: string | null = target;
  /* 防御性上限：prev 链绝不可能比可达格子数更长 */
  let guard = range.costs.size + 1;
  while (cur !== null && guard > 0) {
    path.push(parseKey(cur));
    cur = range.prev.get(cur) ?? null;
    guard -= 1;
  }
  return path.reverse();
}

/** 把 destinations 直接转成坐标数组，省得调用方到处 parseKey */
export function reachableTiles(range: MoveRange): Vec2[] {
  return range.destinations.map(parseKey);
}

/** 该单位是否能从当前位置走到 to（且能停下） */
export function canStandAt(range: MoveRange, to: Vec2): boolean {
  return range.destinations.includes(key(to));
}
