import type { Team } from './types';

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function opponent(team: Team): Team {
  return team === 'player' ? 'enemy' : 'player';
}

export function teamLabel(team: Team): string {
  return team === 'player' ? '我方' : '敌方';
}

/** 把数字收敛成可读的确定格式，避免浮点噪声进了日志或测试断言 */
export function fixed(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
