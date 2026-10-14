import { describe, expect, it } from 'vitest';

import { emptyProgress, recordClear } from '../src/core';
import { createSaveStore, type StorageLike } from '../src/game/storage';
import { flatMap, makeState, makeUnit } from './fixtures';

/**
 * 存档的测试。
 *
 * `createSaveStore` 只依赖 `getItem` / `setItem` 两个方法，
 * 所以这里塞个假对象就够了 —— 不需要 jsdom、不需要真的 localStorage。
 * 这也是把它写成 `StorageLike` 而不是直接用 `Storage` 类型的原因。
 */

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError（假的）');
    this.data.set(key, value);
  }
}

const KEY = 'srpg.campaign.save';

function sampleState() {
  const map = flatMap(4, 4);
  const hero = makeUnit({ id: 'hero', pos: { x: 0, y: 0 } });
  return makeState(map, [hero], { seed: 123 });
}

describe('基本读写', () => {
  it('全新环境读出的是空存档', () => {
    const store = createSaveStore(new FakeStorage());
    const file = store.read();
    expect(file.progress).toEqual(emptyProgress());
    expect(file.inProgress).toBeNull();
    expect(store.persistent).toBe(true);
  });

  it('写进去能读回来', () => {
    const backend = new FakeStorage();
    const store = createSaveStore(backend);
    const state = sampleState();

    store.update((file) => ({
      ...file,
      progress: recordClear(file.progress, 'plain-01', { turns: 7, survivors: 2 }),
      inProgress: { levelId: 'forest-01', state },
    }));

    /* 换一个 store 实例读同一份后端，确认真的落盘了而不是只存在内存里 */
    const reopened = createSaveStore(backend);
    const file = reopened.read();
    expect(file.progress.cleared).toEqual(['plain-01']);
    expect(file.progress.best['plain-01']).toEqual({ turns: 7, survivors: 2 });
    expect(file.inProgress?.levelId).toBe('forest-01');
    expect(file.inProgress?.state.units).toHaveLength(1);
    expect(file.inProgress?.state.rngSeed).toBe(123);
  });

  it('reset 清空一切', () => {
    const backend = new FakeStorage();
    const store = createSaveStore(backend);
    store.update((file) => ({
      ...file,
      progress: recordClear(file.progress, 'plain-01', { turns: 7, survivors: 2 }),
    }));
    store.reset();
    expect(createSaveStore(backend).read().progress).toEqual(emptyProgress());
  });

  it('update 返回写入后的结果', () => {
    const store = createSaveStore(new FakeStorage());
    const next = store.update((file) => ({
      ...file,
      progress: recordClear(file.progress, 'a', { turns: 3, survivors: 4 }),
    }));
    expect(next.progress.cleared).toEqual(['a']);
  });
});

describe('健壮性：坏存档绝不能把游戏搞崩', () => {
  it('JSON 损坏 → 退化成空存档', () => {
    const backend = new FakeStorage();
    backend.data.set(KEY, '{这不是合法 JSON');
    expect(createSaveStore(backend).read().progress).toEqual(emptyProgress());
  });

  it('版本号不匹配 → 丢弃旧存档重新开始', () => {
    const backend = new FakeStorage();
    backend.data.set(
      KEY,
      JSON.stringify({ version: 0, progress: { cleared: ['a'], best: {} }, inProgress: null }),
    );
    expect(createSaveStore(backend).read().progress).toEqual(emptyProgress());
  });

  it('inProgress 结构不对 → 只丢掉它，进度保留', () => {
    const backend = new FakeStorage();
    backend.data.set(
      KEY,
      JSON.stringify({
        version: 1,
        progress: { cleared: ['a'], best: { a: { turns: 5, survivors: 3 } } },
        inProgress: { levelId: 'a', state: { 完全: '不是战场' } },
      }),
    );
    const file = createSaveStore(backend).read();
    expect(file.inProgress).toBeNull();
    expect(file.progress.cleared).toEqual(['a']);
  });

  it('没有可用后端时仍然能读写，只是不落盘', () => {
    const store = createSaveStore(null);
    expect(store.persistent).toBe(false);
    store.update((file) => ({ ...file, progress: recordClear(file.progress, 'a', { turns: 1, survivors: 1 }) }));
    expect(store.read().progress.cleared).toEqual(['a']);
  });

  it('写入失败（配额满之类）不抛异常，游戏继续能玩', () => {
    const backend = new FakeStorage();
    backend.failWrites = true;
    const store = createSaveStore(backend);

    expect(() =>
      store.update((file) => ({
        ...file,
        progress: recordClear(file.progress, 'a', { turns: 1, survivors: 1 }),
      })),
    ).not.toThrow();

    /* 内存里还是有的，这一局照常能玩下去 */
    expect(store.read().progress.cleared).toEqual(['a']);
  });

  it('读取抛异常时也不崩', () => {
    const hostile: StorageLike = {
      getItem() {
        throw new Error('SecurityError（假的）');
      },
      setItem() {},
    };
    expect(createSaveStore(hostile).read().progress).toEqual(emptyProgress());
  });
});
