import { emptyProgress, isRecord, parseProgress, type BattleState, type Progress } from '../core';

/**
 * 存档读写。
 *
 * 这一层只做两件事：把 SaveFile 和 localStorage 之间来回搬，以及
 * **在存储不可用时优雅退化**（隐私模式、file:// 协议、配额写满都要能继续玩）。
 *
 * 进度**逻辑**（哪关解锁、战绩怎么比）在 core/campaign.ts 里，那边有单测。
 * 这里只负责"存得住、读得回来、坏了不崩"。
 */

export interface InProgress {
  levelId: string;
  /** 完整战场状态，可以直接重建画面 */
  state: BattleState;
}

export interface SaveFile {
  version: number;
  progress: Progress;
  /** 未打完的一局，供"继续"入口使用 */
  inProgress: InProgress | null;
}

/** 只用得到这两个方法 —— 测试里塞个假对象就够了，不需要真的 localStorage */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SaveStore {
  read(): SaveFile;
  /** 传入纯函数做变更，返回写入后的结果 */
  update(mutate: (current: SaveFile) => SaveFile): SaveFile;
  reset(): void;
  /** 是否真的落盘。false 表示只存在内存里（隐私模式），关掉页面就没了 */
  readonly persistent: boolean;
}

const KEY = 'srpg.campaign.save';
/** 结构变了就 +1：旧存档会被直接丢弃，而不是拿着半截数据崩掉 */
const VERSION = 1;

function blank(): SaveFile {
  return { version: VERSION, progress: emptyProgress(), inProgress: null };
}

function parseInProgress(raw: unknown): InProgress | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.levelId !== 'string') return null;

  const state = raw.state;
  if (!isRecord(state)) return null;
  /* 只做粗校验：真正的战场结构由 core 的类型保证，这里只挡住"明显不是战场"的东西。
     读档出错时宁可丢掉存档，也不要带着一个半损坏的状态开局。 */
  if (!Array.isArray(state.units) || !isRecord(state.map)) return null;

  return { levelId: raw.levelId, state: state as unknown as BattleState };
}

function parseSave(raw: string | null): SaveFile {
  if (raw === null) return blank();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== VERSION) return blank();
    return {
      version: VERSION,
      progress: parseProgress(parsed.progress),
      inProgress: parseInProgress(parsed.inProgress),
    };
  } catch {
    /* 存档损坏。用户此刻什么都做不了，丢掉重来比崩掉好。 */
    return blank();
  }
}

/**
 * 挑一个能用的后端。
 *
 * 注意**必须真的写一次**才算数：有些环境（隐私模式、部分 file:// 场景）
 * 能拿到 localStorage 对象，但一碰就抛 SecurityError。
 */
export function pickStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__srpg_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function createSaveStore(explicit?: StorageLike | null): SaveStore {
  const backend = explicit === undefined ? pickStorage() : explicit;
  let cache: SaveFile | null = null;

  function write(file: SaveFile): void {
    cache = file;
    if (backend === null) return;
    try {
      backend.setItem(KEY, JSON.stringify(file));
    } catch {
      /* 配额写满之类：退化成内存存储，游戏继续能玩，只是关掉页面就没了 */
    }
  }

  function read(): SaveFile {
    if (cache !== null) return cache;
    let raw: string | null = null;
    try {
      raw = backend?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    cache = parseSave(raw);
    return cache;
  }

  return {
    read,
    update(mutate) {
      const next = mutate(read());
      write(next);
      return next;
    },
    reset() {
      write(blank());
    },
    get persistent(): boolean {
      return backend !== null;
    },
  };
}
