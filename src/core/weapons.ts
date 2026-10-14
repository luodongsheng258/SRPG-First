import type { Unit, WeaponKind } from './types';

/**
 * 武器相克（武器三角）。
 *
 * 规则：**剑克斧、斧克枪、枪克剑**。弓和魔法不在环里 ——
 * 它们既不被克也不克人，靠射程和命中立足。
 *
 * 为什么相克有效：它让「打谁」变成一个真实的选择，
 * 而不是「谁近打谁」。玩家会为了吃到 +1 伤害 / +15 命中而调整站位。
 */

const BEATS: Record<WeaponKind, WeaponKind | null> = {
  sword: 'axe', // 剑克斧
  axe: 'lance', // 斧克枪
  lance: 'sword', // 枪克剑
  bow: null,
  tome: null,
};

export type TriangleEdge = 'advantage' | 'disadvantage' | 'neutral';

export function triangleBetween(attacker: WeaponKind, defender: WeaponKind): TriangleEdge {
  if (BEATS[attacker] === defender) return 'advantage';
  if (BEATS[defender] === attacker) return 'disadvantage';
  return 'neutral';
}

export function triangleEdge(attacker: Unit, defender: Unit): TriangleEdge {
  return triangleBetween(attacker.weapon.kind, defender.weapon.kind);
}

/**
 * 相克修正的大小。
 *
 * 火纹用的是 +1 威力 / +15 命中。这里命中只给 **10**：
 * 本作的命中基数（60 + 武器命中）比火纹低，±15 会让优势方命中率直接冲到 90+
 * 而劣势方掉到 45 以下 —— 那不是"选择"，是碾压。
 * ±10 配上武器自带的命中差异，已经足够让人为了打对目标而调整站位。
 */
export const TRIANGLE_MIGHT = 1;
export const TRIANGLE_HIT = 10;

export function triangleMight(edge: TriangleEdge): number {
  if (edge === 'advantage') return TRIANGLE_MIGHT;
  if (edge === 'disadvantage') return -TRIANGLE_MIGHT;
  return 0;
}

export function triangleHit(edge: TriangleEdge): number {
  if (edge === 'advantage') return TRIANGLE_HIT;
  if (edge === 'disadvantage') return -TRIANGLE_HIT;
  return 0;
}

/** 面板显示用的标签 */
export function triangleLabel(edge: TriangleEdge): string {
  if (edge === 'advantage') return '相克占优';
  if (edge === 'disadvantage') return '相克不利';
  return '无相克';
}

/**
 * 单位的实际攻击力 = 基础 atk + 武器威力。
 *
 * 相克修正不在这里 —— 它取决于对手，所以由 `strikeProfile` 加。
 */
export function attackPower(unit: Unit): number {
  return unit.atk + unit.weapon.might;
}
