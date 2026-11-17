/**
 * DevContentSourceCard.vue —— 开发期内容源开关（本地内容目录 / 内容包）
 *
 * 开关反映当前偏好；切换先走应用内确认，确认后才写偏好并重载页面，取消则什么都不写；
 * 提示文案一律出自 describeDevContentNotices；被压制的包显示 id + 版本。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';
import {
  DEV_CONTENT_SOURCE_KEY,
  describeDevContentNotices,
  type DevContentSourceResolution,
} from '../../../../src/ui/lib/dev-content-source';

const confirmDialogMock = vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (o: ConfirmDialogOptions) => confirmDialogMock(o),
}));
vi.mock('../../../../src/ui/stores/content-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive({
    devContentSource: null as DevContentSourceResolution | null,
  });
  return { useContentStore: () => store };
});

import DevContentSourceCard from '../../../../src/ui/components/settings/DevContentSourceCard.vue';
import { useContentStore } from '../../../../src/ui/stores/content-store';

const reload = vi.fn();

beforeEach(() => {
  confirmDialogMock.mockReset();
  confirmDialogMock.mockResolvedValue(true);
  reload.mockReset();
  vi.stubGlobal('location', { ...window.location, reload });
  localStorage.clear();
  useContentStore().devContentSource = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function radio(w: ReturnType<typeof mount>, key: 'local' | 'pack') {
  return w.get(`[role="radio"][data-source="${key}"]`);
}

describe('DevContentSourceCard 状态呈现', () => {
  it('偏好为本地目录且压制了包：选中「本地内容目录」，显示包 id 与版本，标明仅开发构建', () => {
    useContentStore().devContentSource = {
      preference: 'local',
      suppressPack: true,
      suppressedPack: { packId: 'fated-poem', packVersion: '2.7.0' },
      notices: [],
    };
    const w = mount(DevContentSourceCard);

    expect(radio(w, 'local').attributes('aria-checked')).toBe('true');
    expect(radio(w, 'pack').attributes('aria-checked')).toBe('false');
    expect(w.text()).toContain('仅开发构建');
    expect(w.text()).toContain('fated-poem');
    expect(w.text()).toContain('v2.7.0');
    expect(w.text()).toContain('测试存档');
  });

  it('未压制包时不显示被压制包那一行', () => {
    useContentStore().devContentSource = {
      preference: 'pack',
      suppressPack: false,
      suppressedPack: null,
      notices: [],
    };
    const w = mount(DevContentSourceCard);
    expect(radio(w, 'pack').attributes('aria-checked')).toBe('true');
    expect(w.find('.dev-source-suppressed').exists()).toBe(false);
    expect(w.find('.dev-source-notices').exists()).toBe(false);
  });

  it('提示文案逐条取自 describeDevContentNotices', () => {
    const notices = ['local-dir-missing', 'local-file-pack-materialized'] as const;
    useContentStore().devContentSource = {
      preference: 'local',
      suppressPack: true,
      suppressedPack: { packId: 'p', packVersion: '1.0.0' },
      notices: [...notices],
    };
    const w = mount(DevContentSourceCard);
    const items = w.findAll('.dev-source-notices li').map((li) => li.text());
    expect(items).toEqual(describeDevContentNotices(notices));
  });

  it('store 尚未解析时回落到本地存储里的偏好', () => {
    localStorage.setItem(DEV_CONTENT_SOURCE_KEY, 'local');
    const w = mount(DevContentSourceCard);
    expect(radio(w, 'local').attributes('aria-checked')).toBe('true');
  });
});

describe('DevContentSourceCard 切换', () => {
  beforeEach(() => {
    useContentStore().devContentSource = {
      preference: 'pack',
      suppressPack: false,
      suppressedPack: null,
      notices: [],
    };
  });

  it('确认后才写偏好并重载页面', async () => {
    const w = mount(DevContentSourceCard);
    await radio(w, 'local').trigger('click');
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect((confirmDialogMock.mock.calls[0][0].details ?? []).join('\n')).toContain('uid');
    expect(localStorage.getItem(DEV_CONTENT_SOURCE_KEY)).toBe('local');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('取消确认：不写偏好、不重载', async () => {
    confirmDialogMock.mockResolvedValue(false);
    const w = mount(DevContentSourceCard);
    await radio(w, 'local').trigger('click');
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DEV_CONTENT_SOURCE_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('点当前已选中的项不弹确认', async () => {
    const w = mount(DevContentSourceCard);
    await radio(w, 'pack').trigger('click');
    await flushPromises();

    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
