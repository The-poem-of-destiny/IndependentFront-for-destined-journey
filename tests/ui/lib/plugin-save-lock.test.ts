/**
 * plugin-save-lock.test.ts — 按存档命名的跨标签页锁（设计 §6.5）
 *
 * 用一个最小的假 LockManager 模拟两个标签页争同一把锁：独占、`ifAvailable`、排队、
 * `signal` 撤销。不碰真实 navigator.locks。
 */

import { describe, it, expect } from 'vitest';
import {
  acquirePluginSaveLock,
  pluginSaveLockName,
  type PluginLockManager,
  type PluginSaveLockState,
} from '../../../src/ui/lib/plugin-save-lock';

interface Waiter {
  callback: (lock: unknown) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** 独占锁的假实现：一个名字同时只有一个持有者，其余按 FIFO 排队 */
function createFakeLocks(): PluginLockManager & {
  held: Set<string>;
  queued: (name: string) => number;
} {
  const held = new Set<string>();
  const queues = new Map<string, Waiter[]>();

  const grant = (name: string, w: Waiter): void => {
    held.add(name);
    const lock = { name };
    Promise.resolve()
      .then(() => w.callback(lock))
      .then(
        (v) => {
          held.delete(name);
          w.resolve(v);
          next(name);
        },
        (e: unknown) => {
          held.delete(name);
          w.reject(e);
          next(name);
        },
      );
  };
  const next = (name: string): void => {
    const q = queues.get(name);
    const w = q?.shift();
    if (w) grant(name, w);
  };

  return {
    held,
    queued: (name) => queues.get(name)?.length ?? 0,
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const w: Waiter = { callback, resolve, reject };
        if (!held.has(name)) {
          grant(name, w);
          return;
        }
        if (options.ifAvailable) {
          Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
          return;
        }
        const q = queues.get(name) ?? [];
        q.push(w);
        queues.set(name, q);
        options.signal?.addEventListener('abort', () => {
          const list = queues.get(name) ?? [];
          const i = list.indexOf(w);
          if (i >= 0) {
            list.splice(i, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
        });
      });
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('plugin-save-lock', () => {
  it('锁名由存档 id 派生，不同存档互不相干', () => {
    expect(pluginSaveLockName('a')).not.toBe(pluginSaveLockName('b'));
    expect(pluginSaveLockName('a')).toContain('a');
  });

  it('无人持有时直接拿到锁，release 后释放', async () => {
    const locks = createFakeLocks();
    const handle = await acquirePluginSaveLock('s1', { locks });
    expect(handle.state).toBe('held');
    expect(locks.held.has(pluginSaveLockName('s1'))).toBe(true);
    handle.release();
    await flush();
    expect(handle.state).toBe('released');
    expect(locks.held.has(pluginSaveLockName('s1'))).toBe(false);
  });

  it('另一个标签页持有时进入 waiting 并排队，持有方释放后自动拿到', async () => {
    const locks = createFakeLocks();
    const first = await acquirePluginSaveLock('s1', { locks });
    const changes: PluginSaveLockState[] = [];
    const second = await acquirePluginSaveLock('s1', {
      locks,
      onChange: (s) => changes.push(s),
    });
    expect(second.state).toBe('waiting');
    expect(locks.queued(pluginSaveLockName('s1'))).toBe(1);

    first.release();
    await flush();
    expect(second.state).toBe('held');
    expect(changes).toEqual(['held']);
    second.release();
  });

  it('不同存档的锁互不阻塞', async () => {
    const locks = createFakeLocks();
    const a = await acquirePluginSaveLock('s1', { locks });
    const b = await acquirePluginSaveLock('s2', { locks });
    expect(a.state).toBe('held');
    expect(b.state).toBe('held');
  });

  it('retry 在持有方仍在时保持 waiting，且不会重复排队', async () => {
    const locks = createFakeLocks();
    await acquirePluginSaveLock('s1', { locks });
    const second = await acquirePluginSaveLock('s1', { locks });
    expect(await second.retry()).toBe('waiting');
    expect(locks.queued(pluginSaveLockName('s1'))).toBe(1);
  });

  it('retry 在锁空出时立即拿到，并撤掉排队申请', async () => {
    const locks = createFakeLocks();
    const name = pluginSaveLockName('s1');
    // 假持有方：直接占住，再强行清掉（模拟持有方已离开但排队申请尚未被调度）
    const first = await acquirePluginSaveLock('s1', { locks });
    const second = await acquirePluginSaveLock('s1', { locks });
    expect(second.state).toBe('waiting');
    // 手动把排队者挪走再释放持有方，让锁空出来但排队申请不被授予
    const queuedBefore = locks.queued(name);
    expect(queuedBefore).toBe(1);
    locks.held.delete(name);
    expect(await second.retry()).toBe('held');
    await flush();
    expect(locks.queued(name)).toBe(0);
    first.release();
    second.release();
  });

  it('排队中 release 会撤掉排队申请，之后持有方释放也不再拿锁', async () => {
    const locks = createFakeLocks();
    const first = await acquirePluginSaveLock('s1', { locks });
    const second = await acquirePluginSaveLock('s1', { locks });
    second.release();
    await flush();
    expect(locks.queued(pluginSaveLockName('s1'))).toBe(0);
    first.release();
    await flush();
    expect(second.state).toBe('released');
    expect(locks.held.size).toBe(0);
  });

  it('没有 LockManager 时为 unsupported，retry 也不改变', async () => {
    const handle = await acquirePluginSaveLock('s1', { locks: null });
    expect(handle.state).toBe('unsupported');
    expect(await handle.retry()).toBe('unsupported');
    handle.release();
    expect(handle.state).toBe('released');
  });

  it('LockManager 请求直接失败时视为 unsupported，不抛', async () => {
    const locks: PluginLockManager = {
      request: () => Promise.reject(new Error('SecurityError')),
    };
    const handle = await acquirePluginSaveLock('s1', { locks });
    expect(handle.state).toBe('unsupported');
  });
});
