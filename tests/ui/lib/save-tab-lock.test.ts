/**
 * save-tab-lock —— 存档单标签页锁（Web Locks，ifAvailable）
 */
import { describe, it, expect, vi } from 'vitest';
import { acquireSaveTabLock } from '../../../src/ui/lib/save-tab-lock';

/** 假 LockManager：一个名字同一时刻只给一个持有者；`external` 模拟别的标签页占着的锁 */
function createFakeLocks(external: string[] = []) {
  const held = new Set<string>(external);
  const request = vi.fn(
    async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ): Promise<unknown> => {
      if (held.has(name)) return await callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: 'exclusive' } as Lock);
      } finally {
        held.delete(name);
      }
    },
  );
  return { locks: { request } as unknown as LockManager, held, request };
}

describe('acquireSaveTabLock', () => {
  it('空闲时取得锁，并以 ifAvailable 申请 poem-save:<saveId>', async () => {
    const fake = createFakeLocks();
    const handle = await acquireSaveTabLock('s1', fake.locks);
    expect(handle).not.toBeNull();
    expect(fake.request).toHaveBeenCalledWith(
      'poem-save:s1',
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(fake.held.has('poem-save:s1')).toBe(true);
    handle!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.held.has('poem-save:s1')).toBe(false);
  });

  it('另一个标签页占着同一存档时返回 null', async () => {
    const fake = createFakeLocks(['poem-save:s2']);
    expect(await acquireSaveTabLock('s2', fake.locks)).toBeNull();
    // 不同存档互不影响
    const other = await acquireSaveTabLock('s3', fake.locks);
    expect(other).not.toBeNull();
    other!.release();
  });

  it('同一标签页重复申请同一存档共用一把锁，最后一个释放才真正放锁', async () => {
    const fake = createFakeLocks();
    const a = await acquireSaveTabLock('s4', fake.locks);
    const b = await acquireSaveTabLock('s4', fake.locks);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(fake.request).toHaveBeenCalledTimes(1);
    a!.release();
    a!.release(); // 幂等：重复释放不多扣引用
    await Promise.resolve();
    expect(fake.held.has('poem-save:s4')).toBe(true);
    b!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.held.has('poem-save:s4')).toBe(false);
  });

  it('放锁后可再次取得', async () => {
    const fake = createFakeLocks();
    const first = await acquireSaveTabLock('s5', fake.locks);
    first!.release();
    await Promise.resolve();
    await Promise.resolve();
    const second = await acquireSaveTabLock('s5', fake.locks);
    expect(second).not.toBeNull();
    expect(fake.request).toHaveBeenCalledTimes(2);
    second!.release();
  });

  it('环境不支持 navigator.locks 时放行', async () => {
    const handle = await acquireSaveTabLock('s6', undefined);
    expect(handle).not.toBeNull();
    expect(() => handle!.release()).not.toThrow();
  });

  it('申请本身出错时放行，不把玩家关在门外', async () => {
    const locks = {
      request: vi.fn(async () => {
        throw new Error('SecurityError');
      }),
    } as unknown as LockManager;
    const handle = await acquireSaveTabLock('s7', locks);
    expect(handle).not.toBeNull();
    handle!.release();
  });
});
