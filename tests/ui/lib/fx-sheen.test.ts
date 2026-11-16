/**
 * fx-sheen.ts — 指针光泽的判定与控制器
 *
 * 守的是：只认清单里的控件、叙事流 / 回合账本 / 禁用控件不加光泽；矩形只在进入时量；
 * 高光变量只写到 puck / ring 自己身上且合帧；指针不动零帧；触屏忽略；卸载摘净监听。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSheenController,
  findSheenTarget,
  localPoint,
  measureBox,
} from '../../../src/ui/lib/fx-sheen';
import type { FrameCallback } from '../../../src/ui/lib/fx-ticker';

function stubRect(el: Element, left: number, top: number, width: number, height: number) {
  const fn = vi.fn(() => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }));
  (el as unknown as { getBoundingClientRect: typeof fn }).getBoundingClientRect = fn;
  return fn;
}

function pointerEvent(
  type: 'pointerover' | 'pointerout',
  init: { clientX?: number; clientY?: number; pointerType?: string; relatedTarget?: unknown },
) {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperties(ev, {
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    pointerType: { value: init.pointerType ?? 'mouse' },
    relatedTarget: { value: init.relatedTarget ?? null },
  });
  return ev;
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

function manualPointer() {
  const subs = new Set<(p: { x: number; y: number }) => void>();
  return {
    subscribePointer: vi.fn((cb: (p: { x: number; y: number }) => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    }),
    count: () => subs.size,
    move(x: number, y: number) {
      for (const cb of Array.from(subs)) cb({ x, y });
    },
  };
}

function setup() {
  document.body.innerHTML = `
    <div class="top-bar"><button class="top-btn" id="menu"><span id="icon">i</span></button></div>
    <div class="side"><button class="tool-btn" id="loose">x</button></div>
    <div class="chat-flow"><button class="app-btn" id="in-chat">y</button></div>
    <section class="turn-activity"><button class="app-btn" id="in-ledger">z</button></section>
    <button class="app-btn" id="off" disabled>d</button>
    <span data-fx-sheen id="custom">c</span>
    <div id="overlay"><div id="ring"></div><div id="puck"></div></div>
  `;
  const puck = document.getElementById('puck') as HTMLElement;
  const ring = document.getElementById('ring') as HTMLElement;
  const frames = manualFrames();
  const pointer = manualPointer();
  const getStyle = vi.fn(() => ({ borderRadius: '6px' }));
  const ctl = createSheenController(puck, ring, {
    requestFrame: frames.requestFrame,
    subscribePointer: pointer.subscribePointer,
    getStyle,
  });
  live.push(ctl);
  return { puck, ring, frames, pointer, getStyle, ctl };
}

/** 每条用例建的控制器在收尾时统一 dispose，免得文档监听串到下一条 */
const live: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
});

describe('findSheenTarget', () => {
  it('从子节点向上找到控件与面板框', () => {
    setup();
    const t = findSheenTarget(document.getElementById('icon'));
    expect(t?.control.id).toBe('menu');
    expect(t?.frame?.classList.contains('top-bar')).toBe(true);
  });

  it('不在面板框里的控件只有 puck 没有 frame', () => {
    setup();
    const t = findSheenTarget(document.getElementById('loose'));
    expect(t?.control.id).toBe('loose');
    expect(t?.frame).toBeNull();
  });

  it('叙事流、回合账本里的控件与禁用控件一律不加', () => {
    setup();
    expect(findSheenTarget(document.getElementById('in-chat'))).toBeNull();
    expect(findSheenTarget(document.getElementById('in-ledger'))).toBeNull();
    expect(findSheenTarget(document.getElementById('off'))).toBeNull();
  });

  it('显式 data-fx-sheen 的元素也算控件；非元素目标返回 null', () => {
    setup();
    expect(findSheenTarget(document.getElementById('custom'))?.control.id).toBe('custom');
    expect(findSheenTarget(null)).toBeNull();
    expect(findSheenTarget(window)).toBeNull();
  });
});

describe('measureBox / localPoint', () => {
  it('读矩形与圆角，局部坐标相对左上角', () => {
    const el = document.createElement('div');
    stubRect(el, 10, 20, 100, 40);
    const box = measureBox(el, () => ({ borderRadius: '8px 4px' }));
    expect(box).toEqual({ x: 10, y: 20, w: 100, h: 40, radius: '8px 4px' });
    expect(localPoint(box, 35, 30)).toEqual({ x: 25, y: 10 });
  });

  it('取计算样式抛错时按直角处理', () => {
    const el = document.createElement('div');
    stubRect(el, 0, 0, 1, 1);
    const box = measureBox(el, () => {
      throw new Error('离树');
    });
    expect(box.radius).toBe('0px');
  });
});

describe('createSheenController', () => {
  it('悬停控件：puck 摆到控件上、ring 摆到面板框上，并只在此刻量一次', () => {
    const { puck, ring, pointer, ctl } = setup();
    const btnRect = stubRect(document.getElementById('menu')!, 100, 10, 40, 30);
    const frameRect = stubRect(document.querySelector('.top-bar')!, 0, 0, 800, 50);

    document
      .getElementById('icon')!
      .dispatchEvent(pointerEvent('pointerover', { clientX: 110, clientY: 20 }));

    expect(ctl.current()?.id).toBe('menu');
    expect(puck.classList.contains('is-active')).toBe(true);
    expect(puck.style.transform).toBe('translate3d(100.0px, 10.0px, 0)');
    expect(puck.style.width).toBe('40px');
    expect(puck.style.borderRadius).toBe('6px');
    expect(puck.style.getPropertyValue('--fx-sheen-x')).toBe('10.0px');
    expect(ring.classList.contains('is-active')).toBe(true);
    expect(ring.style.width).toBe('800px');
    expect(pointer.count()).toBe(1);

    // 在同一控件内移动子节点，不重量
    document
      .getElementById('menu')!
      .dispatchEvent(pointerEvent('pointerover', { clientX: 120, clientY: 20 }));
    expect(btnRect).toHaveBeenCalledTimes(1);
    expect(frameRect).toHaveBeenCalledTimes(1);
  });

  it('指针移动合帧写变量；指针不动则零帧', () => {
    const { puck, ring, frames, pointer } = setup();
    stubRect(document.getElementById('menu')!, 100, 10, 40, 30);
    stubRect(document.querySelector('.top-bar')!, 0, 0, 800, 50);
    document
      .getElementById('menu')!
      .dispatchEvent(pointerEvent('pointerover', { clientX: 110, clientY: 20 }));
    expect(frames.requestFrame).not.toHaveBeenCalled();

    pointer.move(115, 21);
    pointer.move(120, 22);
    pointer.move(125, 23);
    expect(frames.requestFrame).toHaveBeenCalledTimes(1);
    frames.flush();
    expect(puck.style.getPropertyValue('--fx-sheen-x')).toBe('25.0px');
    expect(puck.style.getPropertyValue('--fx-sheen-y')).toBe('13.0px');
    expect(ring.style.getPropertyValue('--fx-sheen-x')).toBe('125.0px');

    // 不再移动：没有新帧
    expect(frames.size()).toBe(0);
    expect(frames.requestFrame).toHaveBeenCalledTimes(1);
  });

  it('从不往 html / body 写样式', () => {
    const { frames, pointer } = setup();
    stubRect(document.getElementById('menu')!, 100, 10, 40, 30);
    document
      .getElementById('menu')!
      .dispatchEvent(pointerEvent('pointerover', { clientX: 110, clientY: 20 }));
    pointer.move(111, 21);
    frames.flush();
    expect(document.documentElement.getAttribute('style')).toBeNull();
    expect(document.body.getAttribute('style')).toBeNull();
  });

  it('移到非控件处即熄灭并退订指针；离开窗口同样熄灭', () => {
    const { puck, ring, pointer, ctl } = setup();
    document.getElementById('menu')!.dispatchEvent(pointerEvent('pointerover', {}));
    expect(pointer.count()).toBe(1);
    document.querySelector('.side')!.dispatchEvent(pointerEvent('pointerover', {}));
    expect(ctl.current()).toBeNull();
    expect(puck.classList.contains('is-active')).toBe(false);
    expect(ring.classList.contains('is-active')).toBe(false);
    expect(pointer.count()).toBe(0);

    document.getElementById('menu')!.dispatchEvent(pointerEvent('pointerover', {}));
    document
      .getElementById('menu')!
      .dispatchEvent(pointerEvent('pointerout', { relatedTarget: null }));
    expect(ctl.current()).toBeNull();
  });

  it('触屏指针被忽略', () => {
    const { ctl, pointer } = setup();
    document
      .getElementById('menu')!
      .dispatchEvent(pointerEvent('pointerover', { pointerType: 'touch' }));
    expect(ctl.current()).toBeNull();
    expect(pointer.count()).toBe(0);
  });

  it('滚动后缓存矩形作废，下一次移动重量一次', () => {
    const { frames, pointer } = setup();
    const btnRect = stubRect(document.getElementById('menu')!, 100, 10, 40, 30);
    document.getElementById('menu')!.dispatchEvent(pointerEvent('pointerover', {}));
    document.dispatchEvent(new Event('scroll'));
    pointer.move(1, 1);
    frames.flush();
    expect(btnRect).toHaveBeenCalledTimes(2);
    pointer.move(2, 2);
    frames.flush();
    expect(btnRect).toHaveBeenCalledTimes(2);
  });

  it('dispose 摘掉监听、取消排着的帧、退订指针', () => {
    const { frames, pointer, ctl, puck } = setup();
    document.getElementById('menu')!.dispatchEvent(pointerEvent('pointerover', {}));
    pointer.move(5, 5);
    expect(frames.size()).toBe(1);
    ctl.dispose();
    expect(frames.size()).toBe(0);
    expect(pointer.count()).toBe(0);
    expect(puck.classList.contains('is-active')).toBe(false);
    document.getElementById('menu')!.dispatchEvent(pointerEvent('pointerover', {}));
    expect(ctl.current()).toBeNull();
    ctl.dispose();
  });
});
