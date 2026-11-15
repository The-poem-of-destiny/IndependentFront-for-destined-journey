/**
 * ToastContainer —— 关闭按钮、悬停暂停、复制反馈（审查 G-06）
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ToastContainer from '../../../../src/ui/components/shared/ToastContainer.vue';
import { useUIStore } from '../../../../src/ui/stores/ui-store';

enableAutoUnmount(afterEach);

let pinia: Pinia;
function mountToasts() {
  return mount(ToastContainer, { global: { plugins: [pinia], stubs: { teleport: true } } });
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ToastContainer', () => {
  it('每条提示都有可键盘聚焦的 × 关闭按钮，点击即关闭', async () => {
    const ui = useUIStore();
    ui.toast('出错了', 'error', 0);
    ui.toast('已保存', 'success');
    const wrapper = mountToasts();
    const closes = wrapper.findAll('button[aria-label="关闭提示"]');
    expect(closes).toHaveLength(2);
    await closes[0]!.trigger('click');
    expect(ui.toasts.map((t) => t.message)).toEqual(['已保存']);
  });

  it('悬停暂停计时，移开后继续', async () => {
    vi.useFakeTimers();
    const ui = useUIStore();
    ui.toast('提示', 'info');
    const wrapper = mountToasts();
    const item = wrapper.find('.toast-item');
    await item.trigger('mouseenter');
    vi.advanceTimersByTime(10_000);
    expect(ui.toasts).toHaveLength(1);
    await item.trigger('mouseleave');
    vi.advanceTimersByTime(3000);
    expect(ui.toasts).toHaveLength(0);
  });

  it('点击错误提示复制全文并显示「已复制」，提示保留', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const ui = useUIStore();
    ui.toast('详细错误信息', 'error');
    const wrapper = mountToasts();
    await wrapper.find('.toast-body').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('详细错误信息');
    expect(wrapper.find('.toast-copied').text()).toBe('已复制');
    expect(ui.toasts).toHaveLength(1);
  });

  it('剪贴板不可用时显示「复制失败」', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const ui = useUIStore();
    ui.toast('警告', 'warning');
    const wrapper = mountToasts();
    await wrapper.find('.toast-body').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.toast-copied').text()).toBe('复制失败');
  });

  it('点击普通提示正文仍直接关闭', async () => {
    const ui = useUIStore();
    ui.toast('已保存', 'success');
    const wrapper = mountToasts();
    await wrapper.find('.toast-body').trigger('click');
    expect(ui.toasts).toHaveLength(0);
  });
});
