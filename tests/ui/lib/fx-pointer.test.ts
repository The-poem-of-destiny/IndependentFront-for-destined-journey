/**
 * fx-pointer.ts — 指针源与视差
 *
 * 守的是：至多一个监听、惰性挂载、无订阅即摘；无悬停设备零监听；
 * 视差收敛后停帧、只写元素自己的 transform、注销时清掉。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { createPointerHub } from '../../../src/ui/lib/fx-pointer';
import type { FrameCallback } from '../../../src/ui/lib/fx-ticker';

function fakeTarget() {
  const listeners = new Set<EventListener>();
  return {
    innerWidth: 200,
    innerHeight: 100,
    addEventListener: vi.fn((_t: string, l: EventListener, _o?: unknown) => {
      listeners.add(l);
    }),
    removeEventListener: vi.fn((_t: string, l: EventListener) => {
      listeners.delete(l);
    }),
    count: () => listeners.size,
    move(clientX: number, clientY: number) {
      const ev = Object.assign(new Event('pointermove'), { clientX, clientY });
      for (const l of Array.from(listeners)) l(ev);
    },
  };
}

function manualFrames() {
  const queue = new Set<FrameCallback>();
  return {
    requestFrame: vi.fn((cb: FrameCallback) => {
      queue.add(cb);
      return () => {
        queue.delete(cb);
      };
    }),
    size: () => queue.size,
    flush() {
      const batch = Array.from(queue);
      queue.clear();
      for (const cb of batch) cb(0);
    },
  };
}

describe('subscribePointer', () => {
  it('首个订阅才挂监听（passive），最后一个退订即摘', () => {
    const target = fakeTarget();
    const hub = createPointerHub({ target: target as never, canHover: () => true });
    expect(target.addEventListener).not.toHaveBeenCalled();
    const offA = hub.subscribePointer(vi.fn());
    const offB = hub.subscribePointer(vi.fn());
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener.mock.calls[0][2]).toEqual({ passive: true });
    offA();
    expect(hub.isListening()).toBe(true);
    offB();
    expect(hub.isListening()).toBe(false);
    expect(target.count()).toBe(0);
  });

  it('给出视口坐标与相对中心归一化值', () => {
    const target = fakeTarget();
    const hub = createPointerHub({ target: target as never, canHover: () => true });
    const cb = vi.fn();
    hub.subscribePointer(cb);
    target.move(200, 0);
    expect(cb).toHaveBeenCalledWith({ x: 200, y: 0, nx: 1, ny: -1 });
  });

  it('无悬停设备不挂任何监听', () => {
    const target = fakeTarget();
    const hub = createPointerHub({ target: target as never, canHover: () => false });
    const off = hub.subscribePointer(vi.fn());
    expect(target.addEventListener).not.toHaveBeenCalled();
    off();
  });
});

describe('registerParallax', () => {
  it('平滑逼近目标、收敛后停帧，注销清掉 transform 与监听', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const hub = createPointerHub({
      target: target as never,
      canHover: () => true,
      requestFrame: frames.requestFrame,
    });
    const el = document.createElement('div');
    const off = hub.registerParallax(el, 10);

    // 指针不动 = 零帧
    expect(frames.size()).toBe(0);

    target.move(200, 50); // nx=1, ny=0 → 目标 (-10, 0)
    expect(frames.size()).toBe(1);
    frames.flush();
    expect(el.style.transform).toContain('translate3d(-1.20px');

    let guard = 0;
    while (frames.size() > 0 && guard++ < 500) frames.flush();
    expect(guard).toBeLessThan(500);
    expect(el.style.transform).toBe('translate3d(-10.00px, 0.00px, 0)');
    // 收敛后不再排帧
    expect(frames.size()).toBe(0);

    off();
    expect(el.style.transform).toBe('');
    expect(hub.isListening()).toBe(false);
  });

  it('同一帧内多次移动只排一帧', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const hub = createPointerHub({
      target: target as never,
      canHover: () => true,
      requestFrame: frames.requestFrame,
    });
    hub.registerParallax(document.createElement('div'), 8);
    target.move(10, 10);
    target.move(20, 20);
    target.move(30, 30);
    expect(frames.requestFrame).toHaveBeenCalledTimes(1);
  });
});
