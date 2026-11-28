/**
 * save-tab-lock —— 存档单标签页锁（Web Locks，ifAvailable）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  acquireSaveTabLock,
  findSavesLockedElsewhere,
  isSaveLockedElsewhere,
  PACK_ROLLBACK_SAVES_RESTORED_NOTICE,
  PACK_SAVES_IN_USE_MESSAGE,
} from '../../../src/ui/lib/save-tab-lock';

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
  const query = vi.fn(async (): Promise<LockManagerSnapshot> => ({
    held: [...held].map((name) => ({ name, mode: 'exclusive' as const, clientId: 'x' })),
    pending: [],
  }));
  return { locks: { request, query } as unknown as LockManager, held, request, query };
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

describe('findSavesLockedElsewhere / isSaveLockedElsewhere（删档与整库导入的试探，R8）', () => {
  it('别的标签页占着的存档被列出，只读快照不申请锁', async () => {
    const fake = createFakeLocks(['poem-save:t1', 'poem-discord-auth-request']);
    expect(await findSavesLockedElsewhere(fake.locks)).toEqual(['t1']);
    expect(await isSaveLockedElsewhere('t1', fake.locks)).toBe(true);
    expect(await isSaveLockedElsewhere('t2', fake.locks)).toBe(false);
    // 试探不得持锁：没有发起任何 request，占用集合原样
    expect(fake.request).not.toHaveBeenCalled();
    expect([...fake.held]).toEqual(['poem-save:t1', 'poem-discord-auth-request']);
  });

  it('本标签页自己持有的锁（含引用计数中的）不算被占', async () => {
    const fake = createFakeLocks(['poem-save:t4']);
    const own = await acquireSaveTabLock('t3', fake.locks);
    const ownAgain = await acquireSaveTabLock('t3', fake.locks);
    expect(await isSaveLockedElsewhere('t3', fake.locks)).toBe(false);
    expect(await findSavesLockedElsewhere(fake.locks)).toEqual(['t4']);
    own!.release();
    ownAgain!.release();
  });

  it('环境不支持 navigator.locks 或没有 query 时放行', async () => {
    expect(await findSavesLockedElsewhere(undefined)).toEqual([]);
    expect(await isSaveLockedElsewhere('t5', undefined)).toBe(false);
    const noQuery = { request: vi.fn() } as unknown as LockManager;
    expect(await isSaveLockedElsewhere('t5', noQuery)).toBe(false);
  });

  it('查询本身出错时放行', async () => {
    const locks = {
      query: vi.fn(async () => {
        throw new Error('SecurityError');
      }),
    } as unknown as LockManager;
    expect(await findSavesLockedElsewhere(locks)).toEqual([]);
  });
});

describe('内容包装卸的存档锁提示（L2）', () => {
  it('拒绝提示点明另一个标签页与装 / 升 / 卸，回滚提醒要求刷新', () => {
    expect(PACK_SAVES_IN_USE_MESSAGE).toContain('另一个标签页');
    expect(PACK_SAVES_IN_USE_MESSAGE).toMatch(/安装、升级或卸载内容包/);
    expect(PACK_ROLLBACK_SAVES_RESTORED_NOTICE).toBe('另一标签页的存档已被还原，请刷新它');
  });
});
