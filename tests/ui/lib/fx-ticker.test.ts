/**
 * fx-ticker.ts — 合帧调度与偶发调度
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createFrameTicker,
  scheduleOccasional,
  type FrameCallback,
  type OccasionalTimers,
} from '../../../src/ui/lib/fx-ticker';

/** 手动帧源：flush() 才执行排着的那一帧 */
function manualFrames() {
  let next = 1;
  const pending = new Map<number, FrameCallback>();
  return {
    raf: vi.fn((cb: FrameCallback) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    }),
    caf: vi.fn((id: number) => {
      pending.delete(id);
    }),
    size: () => pending.size,
    flush(time = 0) {
      const batch = Array.from(pending.values());
      pending.clear();
      for (const cb of batch) cb(time);
    },
  };
}

/** 手动定时器：advance() 触发到期回调 */
function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; cb: () => void }>();
  const timers: OccasionalTimers = {
    setTimeout: (cb, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (h) => {
      pending.delete(h as number);
    },
  };
  return {
    timers,
    size: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of Array.from(pending.entries())) {
        if (t.at <= now) {
          pending.delete(id);
          t.cb();
        }
      }
    },
  };
}

describe('createFrameTicker', () => {
  it('多个订阅者合并为每帧一次 rAF', () => {
    const frames = manualFrames();
    const ticker = createFrameTicker({ frames, isHidden: () => false });
    const a = vi.fn();
    const b = vi.fn();
    ticker.requestFrame(a);
    ticker.requestFrame(b);
    expect(frames.raf).toHaveBeenCalledTimes(1);
    frames.flush(16);
    expect(a).toHaveBeenCalledWith(16);
    expect(b).toHaveBeenCalledWith(16);
    expect(ticker.pendingCount()).toBe(0);
  });

  it('回调里再请求的进下一帧，不在本帧递归', () => {
    const frames = manualFrames();
    const ticker = createFrameTicker({ frames, isHidden: () => false });
    let calls = 0;
    const loop = () => {
      calls += 1;
      if (calls < 3) ticker.requestFrame(loop);
    };
    ticker.requestFrame(loop);
    frames.flush();
    expect(calls).toBe(1);
    frames.flush();
    frames.flush();
    expect(calls).toBe(3);
    expect(frames.size()).toBe(0);
  });

  it('取消最后一个回调时撤掉已排的帧', () => {
    const frames = manualFrames();
    const ticker = createFrameTicker({ frames, isHidden: () => false });
    const cancel = ticker.requestFrame(vi.fn());
    cancel();
    expect(frames.caf).toHaveBeenCalledTimes(1);
    expect(frames.size()).toBe(0);
  });

  it('页面隐藏时不排帧，可见后续上', () => {
    const frames = manualFrames();
    let hidden = true;
    const ticker = createFrameTicker({ frames, isHidden: () => hidden });
    const cb = vi.fn();
    ticker.requestFrame(cb);
    expect(frames.raf).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.raf).toHaveBeenCalledTimes(1);
    frames.flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('一个回调抛错不影响同帧其它回调', () => {
    const frames = manualFrames();
    const ticker = createFrameTicker({ frames, isHidden: () => false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = vi.fn();
    ticker.requestFrame(() => {
      throw new Error('坏');
    });
    ticker.requestFrame(ok);
    frames.flush();
    expect(ok).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('scheduleOccasional', () => {
  it('在区间内随机延时触发，跑完重排', () => {
    const t = manualTimers();
    const run = vi.fn();
    scheduleOccasional({
      minMs: 1000,
      maxMs: 3000,
      run,
      rng: () => 0.5,
      timers: t.timers,
      isHidden: () => false,
      isEnabled: () => true,
    });
    t.advance(1999);
    expect(run).not.toHaveBeenCalled();
    t.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(t.size()).toBe(1);
    t.advance(2000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('页面隐藏或闸门关闭时跳过本次但照常重排', () => {
    const t = manualTimers();
    const run = vi.fn();
    let hidden = true;
    let enabled = true;
    scheduleOccasional({
      minMs: 100,
      maxMs: 100,
      run,
      timers: t.timers,
      isHidden: () => hidden,
      isEnabled: () => enabled,
    });
    t.advance(100);
    expect(run).not.toHaveBeenCalled();
    hidden = false;
    enabled = false;
    t.advance(100);
    expect(run).not.toHaveBeenCalled();
    enabled = true;
    t.advance(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('取消后不再触发，也不留定时器', () => {
    const t = manualTimers();
    const run = vi.fn();
    const cancel = scheduleOccasional({
      minMs: 100,
      maxMs: 200,
      run,
      rng: () => 0,
      timers: t.timers,
      isHidden: () => false,
      isEnabled: () => true,
    });
    cancel();
    cancel();
    expect(t.size()).toBe(0);
    t.advance(1000);
    expect(run).not.toHaveBeenCalled();
  });

  it('缺省闸门读 DOM：未开闸时不跑', () => {
    const t = manualTimers();
    const run = vi.fn();
    const cancel = scheduleOccasional({
      minMs: 10,
      maxMs: 10,
      run,
      timers: t.timers,
      isHidden: () => false,
    });
    t.advance(10);
    expect(run).not.toHaveBeenCalled();
    cancel();
  });
});
