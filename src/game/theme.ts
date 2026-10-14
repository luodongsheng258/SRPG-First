/**
 * 渲染层的常量集中在这里。
 * 想让网格变大变小，只改 TILE —— 所有坐标换算都以它为单位。
 */

export const TILE = 64;

export const COLORS = {
  bg: 0x14161c,

  /* 范围高亮 */
  moveFill: 0x3fa7ff,
  moveEdge: 0x9dd6ff,
  attackFill: 0xff5d5d,
  attackEdge: 0xffb0b0,
  path: 0xffe066,
  cursor: 0xffffff,

  /* 敌方威胁范围（按 T 显示）。刻意比 attackFill 更暗更淡：
     它是"区域"，不该盖过"我这一下能打谁"这种点状信息。 */
  threatFill: 0x8a2424,
  threatEdge: 0xe2574c,

  /* 控制区（ZOC）：踏进去就停的格子。
     画在蓝色移动范围**之上**，把"能自由走动"和"走到这为止"分成两段。
     用琥珀色而不是红色 —— 红色已经被"攻击范围"占用了，
     这里表达的是"移动受限"，不是"危险"。 */
  zocFill: 0xb07a1e,
  zocEdge: 0xffd166,

  /* 单位 */
  playerBody: 0x4d8ef7,
  playerEdge: 0xbcd9ff,
  enemyBody: 0xe2574c,
  enemyEdge: 0xffc2ba,

  /* 血条 */
  hpBack: 0x0b0d13,
  hpHigh: 0x46c46a,
  hpMid: 0xd8c14a,
  hpLow: 0xd8503f,
} as const;

export const FONT =
  'system-ui, "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

/** 网格坐标 → 该格中心的像素坐标 */
export function tileCenter(x: number, y: number): { x: number; y: number } {
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}
