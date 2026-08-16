import { describe, it, expect, vi } from 'vitest';
import { withSaveWriteLock, withGlobalWriteLock } from './state-write-queue';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('withSaveWriteLock', () => {
  it('同一 saveId 的任务按 FIFO 串行执行（不交错）', async () => {
    const order: string[] = [];
    const start = vi.fn(async (tag: string) => {
      order.push(`${tag}:in`);
      await tick();
      order.push(`${tag}:out`);
    });

    await Promise.all([
      withSaveWriteLock('save_a', () => start('a1')),
      withSaveWriteLock('save_a', () => start('a2')),
      withSaveWriteLock('save_a', () => start('a3')),
    ]);

    // 不交错 = a1 的 out 必须先于 a2 的 in
    expect(order).toEqual(['a1:in', 'a1:out', 'a2:in', 'a2:out', 'a3:in', 'a3:out']);
  });

  it('不同 saveId 互不阻塞（并行执行）', async () => {
    const order: string[] = [];
    const task = (tag: string) => async () => {
      order.push(`${tag}:in`);
      await tick();
      order.push(`${tag}:out`);
    };

    await Promise.all([
      withSaveWriteLock('save_a', task('a')),
      withSaveWriteLock('save_b', task('b')),
    ]);

    expect(order).toEqual(['a:in', 'b:in', 'a:out', 'b:out']);
  });

  it('前一个任务抛错时：错误传播给调用方，后续任务照常执行', async () => {
    const order: string[] = [];

    const p1 = withSaveWriteLock('save_x', async () => {
      order.push('first:start');
      throw new Error('boom');
    });
    const p2 = withSaveWriteLock('save_x', async () => {
      order.push('second');
    });

    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(order).toEqual(['first:start', 'second']);
  });

  it('队列完成后 Map 内部状态清理（连续多轮不积累）', async () => {
    for (let i = 0; i < 5; i++) {
      await withSaveWriteLock('save_y', async () => {
        await tick();
      });
    }
    // 行为验证：再来一批依然 FIFO 正常
    const order: string[] = [];
    await Promise.all([
      withSaveWriteLock('save_y', () => order.push('1')),
      withSaveWriteLock('save_y', () => order.push('2')),
    ]);
    expect(order).toEqual(['1', '2']);
  });
});

describe('withGlobalWriteLock', () => {
  it('全局任务 FIFO 串行', async () => {
    const order: string[] = [];
    const start = vi.fn(async (tag: string) => {
      order.push(`${tag}:in`);
      await tick();
      order.push(`${tag}:out`);
    });

    await Promise.all([
      withGlobalWriteLock(() => start('g1')),
      withGlobalWriteLock(() => start('g2')),
    ]);

    expect(order).toEqual(['g1:in', 'g1:out', 'g2:in', 'g2:out']);
  });

  it('全局锁与 per-saveId 锁互不干扰', async () => {
    const order: string[] = [];
    await Promise.all([
      withSaveWriteLock('save_z', async () => {
        order.push('save');
        await tick();
        order.push('save:out');
      }),
      withGlobalWriteLock(async () => {
        order.push('global');
        await tick();
        order.push('global:out');
      }),
    ]);
    // 两者各自成对出现即可（谁先谁后无关，但各自内部不交错）
    expect(order).toContain('save:out');
    expect(order).toContain('global:out');
    expect(order.indexOf('save') < order.indexOf('save:out')).toBe(true);
    expect(order.indexOf('global') < order.indexOf('global:out')).toBe(true);
  });

  it('错误传播且不卡死全局队列', async () => {
    const p1 = withGlobalWriteLock(async () => {
      throw new Error('gboom');
    });
    const p2 = withGlobalWriteLock(async () => 'ok');
    await expect(p1).rejects.toThrow('gboom');
    await expect(p2).resolves.toBe('ok');
  });
});
