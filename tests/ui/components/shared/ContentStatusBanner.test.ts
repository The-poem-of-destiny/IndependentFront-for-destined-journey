/**
 * ContentStatusBanner.vue —— 横幅入口指向新的「内容包」分区（S-01），
 * 卸载与冲突提示走应用内确认框而不是原生 confirm（S-36）。
 * 开发构建下内容源被切到本地目录 / 有解析提示时多一行开发说明。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';
import {
  describeDevContentNotices,
  type DevContentSourceResolution,
} from '../../../../src/ui/lib/dev-content-source';

const confirmDialogMock = vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (o: ConfirmDialogOptions) => confirmDialogMock(o),
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({ clearActive: () => {}, saves: [] }),
}));
vi.mock('@engine/persistence/database', () => ({
  getDatabase: () => ({ worldBooks: { toArray: async () => [] } }),
}));
vi.mock('../../../../src/ui/stores/content-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive({
    contentStatus: 'placeholder' as string,
    activePackId: null as string | null,
    activePackVersion: null as string | null,
    protectedPack: false,
    leaseMessage: '',
    leaseExpiresAt: null as number | null,
    leaseState: 'LOCAL',
    lastFetchError: null as string | null,
    devContentSource: null as DevContentSourceResolution | null,
    installPack: vi.fn(),
    uninstallPack: vi.fn(),
  });
  return { useContentStore: () => store };
});

import ContentStatusBanner from '../../../../src/ui/components/shared/ContentStatusBanner.vue';
import { useContentStore } from '../../../../src/ui/stores/content-store';
import { useUIStore } from '../../../../src/ui/stores/ui-store';

beforeEach(() => {
  vi.clearAllMocks();
  confirmDialogMock.mockResolvedValue(true);
  setActivePinia(createPinia());
  const content = useContentStore();
  content.contentStatus = 'placeholder';
  content.activePackId = null;
  content.protectedPack = false;
  content.devContentSource = null;
});

describe('ContentStatusBanner', () => {
  it('导入遇冲突 → 应用内确认后跳到「内容包」分区（不再是数据与备份）', async () => {
    const content = useContentStore();
    vi.mocked(content.installPack).mockResolvedValue({
      ok: false,
      status: 'needs_confirmation',
      packId: 'p',
      packVersion: '1',
    });
    const confirmSpy = vi.spyOn(window, 'confirm');
    const ui = useUIStore();
    const open = vi.spyOn(ui, 'openSettings').mockImplementation(() => {});
    const file = new File(['{"packId":"p"}'], 'pack.json', { type: 'application/json' });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    try {
      const w = mount(ContentStatusBanner);
      await flushPromises();
      await w
        .findAll('button')
        .find((b) => b.text() === '导入内容包')!
        .trigger('click');
      await flushPromises();
    } finally {
      click.mockRestore();
    }

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(confirmDialogMock.mock.calls[0][0].message).toContain('设置 → 内容包');
    expect(open).toHaveBeenCalledWith('content-pack');
  });

  it('pack 态卸载 → 先走共用确认，取消则不卸载', async () => {
    const content = useContentStore();
    content.contentStatus = 'pack';
    content.activePackId = 'p';
    confirmDialogMock.mockResolvedValue(false);
    const w = mount(ContentStatusBanner);
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '卸载内容包')!
      .trigger('click');
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(confirmDialogMock.mock.calls[0][0].message).toContain('演示级占位内容');
    expect(content.uninstallPack).not.toHaveBeenCalled();
  });

  it('在线授权包的「管理 Discord 授权」跳到「内容包」分区', async () => {
    const content = useContentStore();
    content.protectedPack = true;
    const ui = useUIStore();
    const open = vi.spyOn(ui, 'openSettings').mockImplementation(() => {});
    const w = mount(ContentStatusBanner);
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '管理 Discord 授权')!
      .trigger('click');
    expect(open).toHaveBeenCalledWith('content-pack');
  });
});

describe('ContentStatusBanner 开发期内容源提示', () => {
  it('包被压制：显示「内容源=本地目录（已装包 X vY 未启用）」，正文不劝导入并隐藏导入入口', async () => {
    const content = useContentStore();
    content.devContentSource = {
      preference: 'local',
      suppressPack: true,
      suppressedPack: { packId: 'fated-poem', packVersion: '2.7.0' },
      notices: [],
    };
    const w = mount(ContentStatusBanner);
    await flushPromises();

    expect(w.get('[data-testid="content-banner-dev"]').text()).toBe(
      '开发：内容源=本地目录（已装包 fated-poem v2.7.0 未启用）',
    );
    // 包其实装着：正文说明被开关暂停，不再出现「未导入 / 导入内容包」之类的引导
    const text = w.get('.content-banner-text').text();
    expect(text).toContain('暂停启用');
    expect(text).not.toContain('导入');
    expect(w.findAll('button').some((b) => b.text() === '导入内容包')).toBe(false);
  });

  it('只有提示没有压制：开发行附上 describeDevContentNotices 的文案', async () => {
    const content = useContentStore();
    content.devContentSource = {
      preference: 'pack',
      suppressPack: false,
      suppressedPack: null,
      notices: ['pack-missing'],
    };
    const w = mount(ContentStatusBanner);
    await flushPromises();

    const line = w.get('[data-testid="content-banner-dev"]').text();
    expect(line).toContain('开发：内容源=内容包');
    expect(line).toContain(describeDevContentNotices(['pack-missing'])[0]);
  });

  it('无提示且未压制：不显示开发行', async () => {
    useContentStore().devContentSource = {
      preference: 'pack',
      suppressPack: false,
      suppressedPack: null,
      notices: [],
    };
    const w = mount(ContentStatusBanner);
    await flushPromises();
    expect(w.find('[data-testid="content-banner-dev"]').exists()).toBe(false);
  });
});
