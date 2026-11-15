/**
 * 启动期内容链（App.vue）：世界书 → 工坊 → 远程素材同步。
 * 钉住两件事：顺序是契约；工坊读库失败不能让远程素材同步被跳过。
 */
import { describe, expect, it, vi } from 'vitest';
import { runContentStartupChain } from '../../../src/ui/lib/content-startup-chain';

function deps(overrides: { workshopFails?: boolean; worldbooksFails?: boolean } = {}) {
  const order: string[] = [];
  return {
    order,
    worldbooks: {
      init: vi.fn(async () => {
        order.push('worldbooks');
        if (overrides.worldbooksFails) throw new Error('wb');
      }),
    },
    workshop: {
      init: vi.fn(async () => {
        order.push('workshop');
        if (overrides.workshopFails) throw new Error('读库失败');
      }),
    },
    assets: {
      syncRemoteAssets: vi.fn(async () => {
        order.push('sync');
      }),
    },
  };
}

describe('runContentStartupChain', () => {
  it('按 世界书 → 工坊 → 远程素材同步 的顺序执行', async () => {
    const d = deps();
    await runContentStartupChain(d);
    expect(d.order).toEqual(['worldbooks', 'workshop', 'sync']);
  });

  it('工坊初始化失败 → 仍然踢远程素材同步，且整条链不 reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ workshopFails: true });
    await expect(runContentStartupChain(d)).resolves.toBeUndefined();
    expect(d.order).toEqual(['worldbooks', 'workshop', 'sync']);
    warn.mockRestore();
  });

  it('世界书初始化失败 → 吞掉，不 reject（同步的前置等待在 action 内部）', async () => {
    const d = deps({ worldbooksFails: true });
    await expect(runContentStartupChain(d)).resolves.toBeUndefined();
    expect(d.assets.syncRemoteAssets).not.toHaveBeenCalled();
  });
});
