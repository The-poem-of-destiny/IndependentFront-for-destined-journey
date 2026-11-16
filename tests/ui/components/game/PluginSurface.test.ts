/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import PluginSurface from '../../../../src/ui/components/game/PluginSurface.vue';

type Mode = 'window' | 'overlay' | 'panel' | 'hidden';

function makeMountFrame() {
  const dispose = vi.fn();
  const mountFrame = vi.fn((container: HTMLElement) => {
    void container;
    return { dispose };
  });
  return { mountFrame, dispose };
}

const wrappers: VueWrapper[] = [];

function mountSurface(
  overrides: Partial<{
    pluginId: string;
    pluginName: string;
    networked: boolean;
    mode: Mode;
    title: string;
    width: number;
    height: number;
    x: number;
    y: number;
    requestedSize: { width: number; height: number } | null;
  }> = {},
  mountFrame = makeMountFrame().mountFrame,
) {
  const wrapper = mount(PluginSurface, {
    attachTo: document.body,
    props: {
      pluginId: 'shop',
      pluginName: '杂货铺',
      networked: false,
      mode: 'window' as Mode,
      title: '商店',
      mountFrame,
      ...overrides,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

function pointer(type: string, init: { clientX: number; clientY: number; button?: number }) {
  // jsdom 没有 PointerEvent 构造器时退回 MouseEvent，字段足够组件使用
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  return new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

function px(value: string): number {
  return Number.parseFloat(value);
}

describe('PluginSurface 插件界面外壳', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  });

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount();
  });

  it('挂载时以帧容器调用 mountFrame，卸载时 dispose', () => {
    const { mountFrame, dispose } = makeMountFrame();
    const wrapper = mountSurface({}, mountFrame);
    const container = wrapper.find('[data-testid="plugin-surface-frame"]').element;
    expect(mountFrame).toHaveBeenCalledTimes(1);
    expect(mountFrame).toHaveBeenCalledWith(container);
    expect(dispose).not.toHaveBeenCalled();
    wrapper.unmount();
    wrappers.pop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('pluginId 变化时先 dispose 旧帧再重新挂载', async () => {
    const { mountFrame, dispose } = makeMountFrame();
    const wrapper = mountSurface({}, mountFrame);
    await wrapper.setProps({ pluginId: 'other' });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mountFrame).toHaveBeenCalledTimes(2);
  });

  it('边框显示插件名，未联网时不显示「联网」标记', () => {
    const wrapper = mountSurface({ networked: false });
    const head = wrapper.find('[data-testid="plugin-surface-head"]');
    expect(head.text()).toContain('杂货铺');
    expect(head.text()).toContain('商店');
    expect(head.text()).not.toContain('联网');
  });

  it('联网插件的边框带「联网」标记', () => {
    const wrapper = mountSurface({ networked: true });
    expect(wrapper.find('.ps-badge').text()).toBe('联网');
  });

  it('插件名只做文本插值，不解析 HTML', () => {
    const wrapper = mountSurface({ pluginName: '<b>坏</b>' });
    expect(wrapper.find('.ps-name').text()).toBe('<b>坏</b>');
    expect(wrapper.find('.ps-name b').exists()).toBe(false);
  });

  it('点击关闭按钮 emit close', async () => {
    const wrapper = mountSurface();
    await wrapper.find('[data-testid="plugin-surface-close"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('按住标题栏拖动会移动窗口并 emit focus', async () => {
    const wrapper = mountSurface({ x: 100, y: 100, width: 400, height: 300 });
    const root = wrapper.element as HTMLElement;
    expect(px(root.style.left)).toBe(100);
    expect(px(root.style.top)).toBe(100);

    const head = wrapper.find('[data-testid="plugin-surface-head"]').element;
    head.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 160 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 200, clientY: 160 }));
    await wrapper.vm.$nextTick();

    expect(px(root.style.left)).toBe(150);
    expect(px(root.style.top)).toBe(150);
    expect(wrapper.emitted('focus')?.length).toBeGreaterThan(0);
  });

  it('拖动位置被夹在视口内', async () => {
    const wrapper = mountSurface({ x: 100, y: 100, width: 400, height: 300 });
    const root = wrapper.element as HTMLElement;
    const head = wrapper.find('[data-testid="plugin-surface-head"]').element;
    head.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 5000, clientY: -5000 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 5000, clientY: -5000 }));
    await wrapper.vm.$nextTick();

    const left = px(root.style.left);
    const width = px(root.style.width);
    expect(left + width).toBeLessThanOrEqual(1280);
    expect(px(root.style.top)).toBeGreaterThanOrEqual(0);
  });

  it('点关闭按钮不会开始拖动', async () => {
    const wrapper = mountSurface({ x: 100, y: 100 });
    const root = wrapper.element as HTMLElement;
    const close = wrapper.find('[data-testid="plugin-surface-close"]').element;
    close.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 300, clientY: 300 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 300, clientY: 300 }));
    await wrapper.vm.$nextTick();
    expect(px(root.style.left)).toBe(100);
  });

  it('拖动右下角手柄调大小，结果被夹在最小 / 视口最大之间并 emit resize', async () => {
    const wrapper = mountSurface({ x: 20, y: 20, width: 400, height: 300 });
    const handle = wrapper.find('[data-testid="plugin-surface-resize"]').element;
    const frame = wrapper.find('[data-testid="plugin-surface-frame"]').element as HTMLElement;

    // 缩到远小于最小值
    handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }));
    window.dispatchEvent(pointer('pointermove', { clientX: -2000, clientY: -2000 }));
    window.dispatchEvent(pointer('pointerup', { clientX: -2000, clientY: -2000 }));
    await wrapper.vm.$nextTick();
    const shrink = wrapper.emitted('resize')?.slice(-1)[0]?.[0] as {
      width: number;
      height: number;
    };
    expect(shrink).toEqual({ width: 240, height: 160 });
    expect(px(frame.style.height)).toBe(160);

    // 放到远超视口
    handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 9000, clientY: 9000 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 9000, clientY: 9000 }));
    await wrapper.vm.$nextTick();
    const grow = wrapper.emitted('resize')?.slice(-1)[0]?.[0] as { width: number; height: number };
    expect(grow.width).toBeLessThanOrEqual(1280);
    expect(grow.height).toBeLessThanOrEqual(800);
    expect(grow.width).toBeGreaterThan(400);
  });

  it('requestedSize（ui.resize）被夹取后应用并 emit resize', async () => {
    const wrapper = mountSurface({ width: 400, height: 300 });
    await wrapper.setProps({ requestedSize: { width: 10, height: 99999 } });
    const size = wrapper.emitted('resize')?.slice(-1)[0]?.[0] as { width: number; height: number };
    expect(size.width).toBe(240);
    expect(size.height).toBeLessThanOrEqual(800);
    const frame = wrapper.find('[data-testid="plugin-surface-frame"]').element as HTMLElement;
    expect(px(frame.style.height)).toBe(size.height);
    // 回归：帧容器的 `flex: 1` 曾让 height 失效（真机里窗口缩成 iframe 默认的 150px）
    expect(frame.style.flex).toBe('0 0 auto');
  });

  it('键盘方向键可调整窗口大小', async () => {
    const wrapper = mountSurface({ width: 400, height: 300 });
    await wrapper.find('[data-testid="plugin-surface-resize"]').trigger('keydown', {
      key: 'ArrowRight',
    });
    expect(wrapper.emitted('resize')?.slice(-1)[0]?.[0]).toEqual({ width: 416, height: 300 });
  });

  it('hidden 形态没有边框、没有关闭按钮，但仍挂载帧', () => {
    const { mountFrame } = makeMountFrame();
    const wrapper = mountSurface({ mode: 'hidden', networked: true }, mountFrame);
    expect(wrapper.find('[data-testid="plugin-surface-head"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plugin-surface-close"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plugin-surface-resize"]').exists()).toBe(false);
    expect(wrapper.classes()).toContain('ps-hidden');
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(mountFrame).toHaveBeenCalledTimes(1);
  });

  it('overlay 与 panel 形态带边框与关闭按钮，但没有调大小手柄', () => {
    for (const mode of ['overlay', 'panel'] as const) {
      const wrapper = mountSurface({ mode });
      expect(wrapper.find('[data-testid="plugin-surface-head"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="plugin-surface-close"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="plugin-surface-resize"]').exists()).toBe(false);
    }
  });
});
