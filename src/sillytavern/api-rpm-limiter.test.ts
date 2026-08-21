import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRpmLimiter, credentialIdFor } from './api-rpm-limiter';
import type { ApiCredentialRef, ApiRpmWaitSnapshot } from './types';

const credential = (overrides: Partial<ApiCredentialRef> = {}): ApiCredentialRef => ({
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-one',
  label: '主 API',
  ...overrides,
});

async function configured(limit: number, ref = credential()) {
  const limiter = new ApiRpmLimiter();
  limiter.replacePolicies([
    { credentialId: await credentialIdFor(ref), rpmLimit: limit, updatedAt: Date.now() },
  ]);
  return limiter;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ApiRpmLimiter', () => {
  it('没有策略时默认无限制并立即发送', async () => {
    const limiter = new ApiRpmLimiter();
    const dispatch = vi.fn(async () => 'ok');

    await Promise.all(
      Array.from({ length: 100 }, () => limiter.schedule(credential(), undefined, dispatch)),
    );

    expect(dispatch).toHaveBeenCalledTimes(100);
    expect(limiter.getSnapshot()).toEqual({ waits: [] });
  });

  it('第 N+1 个请求等待完整 60 秒后自动继续', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const limiter = await configured(2);
    const dispatch = vi.fn(async () => 'ok');
    const snapshots: ApiRpmWaitSnapshot[] = [];
    let queueObserved!: () => void;
    const queueReady = new Promise<void>((resolve) => {
      queueObserved = resolve;
    });
    limiter.subscribe((snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.waits.length > 0) queueObserved();
    });

    await limiter.schedule(credential(), undefined, dispatch);
    await limiter.schedule(credential(), undefined, dispatch);
    const queued = limiter.schedule(credential(), undefined, dispatch);
    await queueReady;

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(snapshots[snapshots.length - 1]?.waits[0]).toMatchObject({
      label: '主 API',
      rpmLimit: 2,
      queuedCount: 1,
      resumeAt: 61_000,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toBe('ok');
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(snapshots[snapshots.length - 1]).toEqual({ waits: [] });
  });

  it('同地址和 Key 跨名称与末尾斜杠共享同一个桶', async () => {
    vi.useFakeTimers();
    const limiter = await configured(1);
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');

    await limiter.schedule(credential(), undefined, first);
    const queued = limiter.schedule(
      credential({ baseUrl: 'https://api.example.com/v1', label: '另一条目' }),
      undefined,
      second,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(queued).resolves.toBe('second');
  });

  it('相同地址的不同 Key 使用独立桶', async () => {
    const firstRef = credential();
    const secondRef = credential({ apiKey: 'sk-two', label: '备用 API' });
    const limiter = new ApiRpmLimiter();
    limiter.replacePolicies([
      { credentialId: await credentialIdFor(firstRef), rpmLimit: 1, updatedAt: 1 },
      { credentialId: await credentialIdFor(secondRef), rpmLimit: 1, updatedAt: 1 },
    ]);
    const dispatch = vi.fn(async () => 'ok');

    await limiter.schedule(firstRef, undefined, dispatch);
    await limiter.schedule(secondRef, undefined, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('排队期间取消会移除等待项且不发送', async () => {
    vi.useFakeTimers();
    const limiter = await configured(1);
    await limiter.schedule(credential(), undefined, async () => 'first');
    const controller = new AbortController();
    const dispatch = vi.fn(async () => 'second');
    const queued = limiter.schedule(credential(), controller.signal, dispatch);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(limiter.getSnapshot()).toEqual({ waits: [] });
  });

  it('改为无限制会立即按 FIFO 放行全部等待请求', async () => {
    vi.useFakeTimers();
    const limiter = await configured(1);
    const order: number[] = [];
    await limiter.schedule(credential(), undefined, async () => 0);
    const second = limiter.schedule(credential(), undefined, async () => {
      order.push(2);
      return 2;
    });
    const third = limiter.schedule(credential(), undefined, async () => {
      order.push(3);
      return 3;
    });
    await vi.advanceTimersByTimeAsync(0);

    limiter.replacePolicies([]);
    await expect(Promise.all([second, third])).resolves.toEqual([2, 3]);
    expect(order).toEqual([2, 3]);
    expect(limiter.getSnapshot()).toEqual({ waits: [] });
  });
});
