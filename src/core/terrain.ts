import type { TerrainDef, TerrainKind } from './types';

/**
 * 地形属性表。
 *
 * 对照 docs/rules.md「地形」一节，改数值之前先改文档。
 * `heal` 是回合开始时站在这里回复的 HP。
 */
export const TERRAIN: Record<TerrainKind, TerrainDef> = {
  plain: {
    kind: 'plain',
    name: '平原',
    moveCost: 1,
    defBonus: 0,
    avoidBonus: 0,
    heal: 0,
    color: 0x6f9b52,
  },
  road: {
    kind: 'road',
    name: '道路',
    moveCost: 1,
    defBonus: 0,
    avoidBonus: 0,
    heal: 0,
    color: 0xb2a077,
  },
  forest: {
    kind: 'forest',
    name: '森林',
    moveCost: 2,
    defBonus: 1,
    avoidBonus: 20,
    heal: 0,
    color: 0x3d6b39,
  },
  hill: {
    kind: 'hill',
    name: '丘陵',
    moveCost: 2,
    defBonus: 2,
    avoidBonus: 10,
    heal: 0,
    color: 0x8a7c4c,
  },
  mountain: {
    kind: 'mountain',
    name: '山地',
    moveCost: 3,
    defBonus: 4,
    avoidBonus: 30,
    heal: 0,
    color: 0x796a5b,
  },
  water: {
    kind: 'water',
    name: '水域',
    /* null = 不可通行。注意：不是 0，也不是 999。 */
    moveCost: null,
    defBonus: 0,
    avoidBonus: 0,
    heal: 0,
    color: 0x2f5f8a,
  },
  fort: {
    kind: 'fort',
    name: '要塞',
    moveCost: 2,
    defBonus: 3,
    avoidBonus: 30,
    /**
     * 唯一能回血的地形。这让"守着要塞"变成一个真实的战术选择。
     *
     * 数值刻意压在 **2**。约束不是"低于纸面最低伤害"，而是
     * **低于实际打在要塞上的伤害**：要塞自带防 +3，
     * 士兵的总攻击力 9 打上去只剩 4~5 点，回血 3 就意味着每回合净掉 1~2 ——
     * 20 血的单位要磨十几回合，加上 +30 闪避的落空，很容易超过 50 回合上限。
     * （实测回血 5 时僵局 1.7%，回血 3 时 2.3% 反而更糟，因为 ZOC 让残局更难收尾。）
     */
    heal: 2,
    color: 0x9a8fb0,
  },
};

export const TERRAIN_KINDS = Object.keys(TERRAIN) as TerrainKind[];

export function isTerrainKind(value: unknown): value is TerrainKind {
  return typeof value === 'string' && value in TERRAIN;
}
