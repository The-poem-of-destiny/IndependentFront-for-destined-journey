/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';

const { confirmDialogMock, countMock, clearMock, exportMock } = vi.hoisted(() => ({
  confirmDialogMock: vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true),
  countMock: vi.fn(async () => 42),
  clearMock: vi.fn(async () => {}),
  exportMock: vi.fn(),
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (o: ConfirmDialogOptions) => confirmDialogMock(o),
}));
vi.mock('@engine/persistence/engine-log-store', () => ({
  countEngineLogs: () => countMock(),
  clearEngineLogs: () => clearMock(),
}));
vi.mock('../../../../src/ui/lib/engine-log-export', () => ({
  exportEngineLogs: (...args: unknown[]) => exportMock(...args),
}));

import DeveloperSection from '../../../../src/ui/components/settings/DeveloperSection.vue';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';

enableAutoUnmount(afterEach);

describe('DeveloperSection — 完整运行日志', () => {
  let settings: ReturnType<typeof useSettingsStore>;

  beforeEach(() => {
    localStorage.clear();
    confirmDialogMock.mockReset();
    confirmDialogMock.mockResolvedValue(true);
    countMock.mockReset();
    countMock.mockResolvedValue(42);
    clearMock.mockClear();
    exportMock.mockReset();
    setActivePinia(createPinia());
    settings = useSettingsStore();
  });

  afterEach(() => {
    settings.$dispose();
  });

  it('默认关闭；拨开关写回设置，且不连带开发者模式', async () => {
    const wrapper = mount(DeveloperSection);
    const toggle = wrapper.get<HTMLInputElement>('input[aria-label="完整运行日志"]');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.element.checked).toBe(false);

    await toggle.setValue(true);
    expect(settings.settings.engineLogEnabled).toBe(true);
    expect(settings.settings.developerMode).toBe(false);
    expect(wrapper.get('.engine-log-card').classes()).toContain('is-enabled');
  });

  it('说明写明体积、保留回合数与明文落盘；粒度下拉只有三档并写回设置', async () => {
    const wrapper = mount(DeveloperSection);
    const text = wrapper.get('.engine-log-card').text();
    for (const phrase of ['非常大', '几十到几百 MB', '最近 100 回合', '明文存到本机']) {
      expect(text).toContain(phrase);
    }

    const select = wrapper.get<HTMLSelectElement>('select[aria-label="记录粒度"]');
    expect(select.findAll('option').map((o) => o.element.value)).toEqual([
      'trace',
      'debug',
      'info',
    ]);
    expect(select.element.value).toBe('trace');
    await select.setValue('info');
    expect(settings.settings.engineLogLevel).toBe('info');
  });

  it('进入分区时读取当前条数', async () => {
    const wrapper = mount(DeveloperSection);
    await flushPromises();
    expect(countMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="engine-log-count"]').text()).toContain('42');
  });

  it('清空先走危险确认；取消时不清空', async () => {
    confirmDialogMock.mockResolvedValueOnce(false);
    const wrapper = mount(DeveloperSection);
    await flushPromises();

    await wrapper.get('[data-testid="engine-log-clear"]').trigger('click');
    await flushPromises();
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(confirmDialogMock.mock.calls[0][0].danger).toBe(true);
    expect(clearMock).not.toHaveBeenCalled();

    countMock.mockResolvedValue(0);
    await wrapper.get('[data-testid="engine-log-clear"]').trigger('click');
    await flushPromises();
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="engine-log-count"]').text()).toContain('0');
  });

  it('导出调用导出模块，期间按钮禁用并显示进度，结束后刷新条数', async () => {
    let finish!: (value: unknown) => void;
    exportMock.mockImplementation(
      (options: { level: string; onProgress?: (n: number) => void }) =>
        new Promise((resolve) => {
          options.onProgress?.(200);
          finish = resolve;
        }),
    );
    settings.settings.engineLogLevel = 'debug';
    const wrapper = mount(DeveloperSection);
    await flushPromises();

    await wrapper.get('[data-testid="engine-log-export"]').trigger('click');
    await flushPromises();
    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(exportMock.mock.calls[0][0]).toMatchObject({ level: 'debug' });
    const button = wrapper.get<HTMLButtonElement>('[data-testid="engine-log-export"]');
    expect(button.element.disabled).toBe(true);
    expect(button.text()).toContain('已导出 200 条');
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="engine-log-clear"]').element.disabled,
    ).toBe(true);

    finish({ status: 'done', method: 'download', fileName: 'x.jsonl', lines: 200 });
    await flushPromises();
    expect(button.element.disabled).toBe(false);
    expect(countMock).toHaveBeenCalledTimes(2);
  });
});
