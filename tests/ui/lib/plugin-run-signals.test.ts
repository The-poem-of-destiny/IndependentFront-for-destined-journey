/**
 * plugin-run-signals.test.ts — 回合管线与插件系统之间的模块级接缝
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  emitPluginTurnSignal,
  getPluginPromptInputs,
  onPluginTurnSignal,
  resetPluginRunSignalsForTest,
  setPluginPromptInputProvider,
  trackPluginWrite,
  whenPluginWritesSettled,
} from '../../../src/ui/lib/plugin-run-signals';
import type { PluginPromptInputs } from '../../../src/core/types/types-plugin';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => resetPluginRunSignalsForTest());

describe('在途写入', () => {
  it('没有在途写入时立即结束', async () => {
    await expect(whenPluginWritesSettled()).resolves.toBeUndefined();
  });

  it('等全部在途写入结束，失败的写入也算结束', async () => {
    const a = deferred();
    const b = deferred();
    void trackPluginWrite(a.promise);
    const tracked = trackPluginWrite(b.promise);
    tracked.catch(() => {});
    let done = false;
    const waiting = whenPluginWritesSettled().then(() => {
      done = true;
    });
    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    b.reject(new Error('写入失败'));
    await waiting;
    expect(done).toBe(true);
  });

  it('等待期间新登记的写入也一并等完', async () => {
    const a = deferred();
    const late = deferred();
    void trackPluginWrite(a.promise);
    let done = false;
    const waiting = whenPluginWritesSettled().then(() => {
      done = true;
    });
    void trackPluginWrite(late.promise);
    a.resolve();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(done).toBe(false);
    late.resolve();
    await waiting;
    expect(done).toBe(true);
  });

  it('trackPluginWrite 原样返回传入的 Promise', () => {
    const p = Promise.resolve(42);
    expect(trackPluginWrite(p)).toBe(p);
  });
});

describe('回合信号', () => {
  it('派发给全部订阅方，取消订阅后不再收到', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onPluginTurnSignal(a);
    onPluginTurnSignal(b);
    emitPluginTurnSignal({ type: 'turn.start', saveId: 's1' });
    offA();
    emitPluginTurnSignal({ type: 'turn.end', saveId: 's1' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ type: 'turn.start', saveId: 's1' });
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('某个订阅方抛错不影响其他订阅方，也不冒泡给管线', () => {
    const after = vi.fn();
    onPluginTurnSignal(() => {
      throw new Error('插件坏了');
    });
    onPluginTurnSignal(after);
    expect(() => emitPluginTurnSignal({ type: 'turn.failed', saveId: 's1' })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('提示词输入', () => {
  it('没有 provider 时返回空列表', () => {
    expect(getPluginPromptInputs()).toEqual({ notes: [], contexts: [] });
  });

  it('返回 provider 的结果（浅拷贝）', () => {
    const inputs: PluginPromptInputs = {
      notes: [{ pluginName: '商店', text: '玩家刚买了一把剑' }],
      contexts: [{ pluginName: '商店', text: '营业中' }],
    };
    setPluginPromptInputProvider(() => inputs);
    const got = getPluginPromptInputs();
    expect(got).toEqual(inputs);
    got.notes.push({ pluginName: 'x', text: 'y' });
    expect(inputs.notes).toHaveLength(1);
  });

  it('provider 抛错或返回形状不对时给空列表', () => {
    setPluginPromptInputProvider(() => {
      throw new Error('boom');
    });
    expect(getPluginPromptInputs()).toEqual({ notes: [], contexts: [] });
    setPluginPromptInputProvider(() => ({ notes: 'bad' }) as unknown as PluginPromptInputs);
    expect(getPluginPromptInputs()).toEqual({ notes: [], contexts: [] });
  });

  it('传 null 清除 provider', () => {
    setPluginPromptInputProvider(() => ({
      notes: [{ pluginName: 'a', text: 'b' }],
      contexts: [],
    }));
    setPluginPromptInputProvider(null);
    expect(getPluginPromptInputs()).toEqual({ notes: [], contexts: [] });
  });
});
