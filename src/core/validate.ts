/**
 * 外部数据校验的小工具。
 *
 * 为什么值得单独一个文件：`loader.ts` 和 `campaign.ts` 都在做同一件事
 * —— 把不可信的 JSON 变成可用的类型，并在出错时给出**指得出位置的报错**。
 * 这套判断逻辑写两遍必然会在某个时候不一致。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

export function int(value: unknown, field: string): number {
  const parsed = num(value, field);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${field} 必须是整数，收到 ${parsed}`);
  }
  return parsed;
}

export function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}
