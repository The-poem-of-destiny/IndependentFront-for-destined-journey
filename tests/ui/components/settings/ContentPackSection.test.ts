/**
 * ContentPackSection.vue —— 内容包分区（S-01 从 DataSection 搬出）
 *
 * 更新状态那组用例随卡片一起从 DataSection.pack-update.test.ts 搬来；
 * 新增卸载确认（S-36）：永远先确认、说清回到占位内容与存档 / Agent 默认的去向，
 * 编辑过包内世界书时再确认一次「修改会丢」，取消则一步也不执行。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import ContentPackSection from '../../../../src/ui/components/settings/ContentPackSection.vue';
import PackInstallConfirmModal from '../../../../src/ui/components/settings/PackInstallConfirmModal.vue';
import { useContentStore } from '../../../../src/ui/stores/content-store';
import { useUIStore } from '../../../../src/ui/stores/ui-store';
import { checkPackUpdate, downloadLatestPack } from '../../../../src/ui/lib/content-pack-updater';
import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';
import { encryptPrivatePack, makePrivatePack } from '../../../helpers/pack-auth-fixture';

const confirmDialogMock = vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (o: ConfirmDialogOptions) => confirmDialogMock(o),
}));

const loadAgentProjectDefaults = vi.fn<() => Promise<void>>();
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ loadAgentProjectDefaults: () => loadAgentProjectDefaults() }),
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({}),
}));
vi.mock('../../../../src/ui/stores/content-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive({
    activePackId: 'fixture' as string | null,
    activePackVersion: '1.0.0' as string | null,
    protectedPack: false,
    hydratePackState: vi.fn().mockResolvedValue(undefined),
    installProtectedPack: vi.fn(),
    uninstallPack: vi.fn(),
  });
  return { useContentStore: () => store };
});
vi.mock('../../../../src/ui/lib/content-pack-updater', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/ui/lib/content-pack-updater')>()),
  checkPackUpdate: vi.fn(),
  downloadLatestPack: vi.fn(),
}));

const installed = {
  ok: true,
  status: 'installed' as const,
  packId: 'fixture',
  packVersion: '2.0.0',
};
const needsConfirmation = {
  ...installed,
  ok: false,
  status: 'needs_confirmation' as const,
  plan: {
    packId: 'fixture',
    packVersion: '2.0.0',
    sections: {},
    notes: [],
    validationErrors: [],
  },
};

let wrapper: ReturnType<typeof mount>;

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialogMock.mockResolvedValue(true);
  loadAgentProjectDefaults.mockResolvedValue(undefined);
  setActivePinia(createPinia());
  const content = useContentStore();
  content.activePackId = 'fixture';
  content.activePackVersion = '1.0.0';
  content.protectedPack = false;
  vi.mocked(content.hydratePackState).mockResolvedValue(undefined);
  vi.mocked(checkPackUpdate).mockResolvedValue({
    status: 'ok',
    info: { available: true, updateAvailable: true, packVersion: '2.0.0', tag: 'v2' },
  });
  vi.mocked(downloadLatestPack).mockResolvedValue({
    status: 'ok',
    packVersion: '2.0.0',
    download: encryptPrivatePack({ ...makePrivatePack(), packVersion: '2.0.0' }),
  });
  vi.mocked(content.installProtectedPack).mockImplementation(async () => {
    content.activePackVersion = '2.0.0';
    return installed;
  });
});

afterEach(() => {
  wrapper?.unmount();
});

function mountSection() {
  wrapper = mount(ContentPackSection, {
    global: {
      stubs: { teleport: true, DiscordPackAccess: true, PackInstallConfirmModal: true },
    },
  });
  return wrapper;
}

async function clickButton(text: string) {
  await wrapper
    .findAll('button')
    .find((button) => button.text() === text)!
    .trigger('click');
  await flushPromises();
}

async function checkUpdate() {
  mountSection();
  await flushPromises();
  await clickButton('检查更新');
  expect(wrapper.text()).toContain('更新到 2.0.0');
}

describe('ContentPackSection 分区外形', () => {
  it('单根 section.section.centered（父级 .centered 只能命中子组件根节点）', async () => {
    mountSection();
    await flushPromises();
    expect(wrapper.element.tagName).toBe('SECTION');
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['section', 'centered']));
    expect(wrapper.find('h3').text()).toBe('内容包');
    expect(wrapper.find('[data-settings-anchor="content-pack"]').exists()).toBe(true);
  });
});

describe('ContentPackSection 内容包更新状态', () => {
  it('更新成功后自动隐藏更新按钮并显示已是最新版本，不重复请求检查接口', async () => {
    await checkUpdate();
    await clickButton('更新到 2.0.0');

    expect(useContentStore().installProtectedPack).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('当前：2.0.0');
    expect(wrapper.text()).not.toContain('更新到 2.0.0');
    expect(wrapper.text()).toContain('已是最新版本（2.0.0）');
    expect(checkPackUpdate).toHaveBeenCalledTimes(1);
  });

  it('需要确认时保留更新按钮，确认安装成功后自动隐藏', async () => {
    vi.mocked(useContentStore().installProtectedPack).mockResolvedValueOnce(needsConfirmation);
    await checkUpdate();
    await clickButton('更新到 2.0.0');

    expect(wrapper.text()).toContain('更新到 2.0.0');
    const modal = wrapper.findComponent(PackInstallConfirmModal);
    expect(modal.props('open')).toBe(true);
    modal.vm.$emit('confirm');
    await flushPromises();

    expect(useContentStore().installProtectedPack).toHaveBeenLastCalledWith(expect.any(Object), {
      confirmConflicts: true,
    });
    expect(wrapper.text()).not.toContain('更新到 2.0.0');
    expect(wrapper.text()).toContain('已是最新版本（2.0.0）');
  });

  it('取消安装确认后保留更新按钮', async () => {
    vi.mocked(useContentStore().installProtectedPack).mockResolvedValueOnce(needsConfirmation);
    await checkUpdate();
    await clickButton('更新到 2.0.0');
    wrapper.findComponent(PackInstallConfirmModal).vm.$emit('cancel');
    await nextTick();

    expect(wrapper.findComponent(PackInstallConfirmModal).props('open')).toBe(false);
    expect(wrapper.text()).toContain('更新到 2.0.0');
    expect(useContentStore().installProtectedPack).toHaveBeenCalledTimes(1);
  });

  it('下载失败后保留更新按钮以便重试', async () => {
    vi.mocked(downloadLatestPack).mockResolvedValue({ status: 'error', message: '下载失败' });
    await checkUpdate();
    await clickButton('更新到 2.0.0');

    expect(wrapper.text()).toContain('更新到 2.0.0');
    expect(useContentStore().installProtectedPack).not.toHaveBeenCalled();
  });

  it('安装失败后保留更新按钮以便重试', async () => {
    vi.mocked(useContentStore().installProtectedPack).mockRejectedValue(new Error('安装失败'));
    await checkUpdate();
    await clickButton('更新到 2.0.0');

    expect(wrapper.text()).toContain('当前：1.0.0');
    expect(wrapper.text()).toContain('更新到 2.0.0');
  });

  it.each(['2.0.0', '3.0.0'])('其他入口安装 %s 后也会隐藏旧更新按钮', async (version) => {
    await checkUpdate();
    useContentStore().activePackVersion = version;
    await nextTick();

    expect(wrapper.text()).not.toContain('更新到 2.0.0');
    expect(checkPackUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('ContentPackSection 卸载确认（S-36）', () => {
  it('没有编辑过包内世界书也先确认：说清回到占位内容、存档与 Agent 默认的去向', async () => {
    const content = useContentStore();
    vi.mocked(content.uninstallPack).mockResolvedValue({ ok: true, status: 'uninstalled' });
    mountSection();
    await flushPromises();
    await clickButton('卸载内容包');

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    const opts = confirmDialogMock.mock.calls[0][0];
    expect(opts.danger).toBe(true);
    expect(opts.message).toContain('演示级占位内容');
    const details = (opts.details ?? []).join('\n');
    expect(details).toContain('已有存档不会被删除');
    expect(details).toContain('需要重新选择');
    expect(details).toContain('Agent 的默认设置回落到占位默认');
    expect(content.uninstallPack).toHaveBeenCalledTimes(1);
    expect(content.uninstallPack).toHaveBeenCalledWith(undefined);
    expect(loadAgentProjectDefaults).toHaveBeenCalledTimes(1);
  });

  it('取消第一道确认 → 一步也不执行', async () => {
    confirmDialogMock.mockResolvedValue(false);
    mountSection();
    await flushPromises();
    await clickButton('卸载内容包');

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(useContentStore().uninstallPack).not.toHaveBeenCalled();
  });

  it('编辑过包内世界书 → 再确认一次「修改会丢」，确认后以 confirmEdits 重入', async () => {
    const content = useContentStore();
    vi.mocked(content.uninstallPack)
      .mockResolvedValueOnce({
        ok: false,
        status: 'needs_confirmation',
        plan: {
          packId: 'fixture',
          ownedBookIds: ['world'],
          confirmations: [
            { bookId: 'world', bookName: '主世界观', currentHash: 'a', packBaselineHash: 'b' },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 'uninstalled' });
    mountSection();
    await flushPromises();
    await clickButton('卸载内容包');

    expect(confirmDialogMock).toHaveBeenCalledTimes(2);
    const second = confirmDialogMock.mock.calls[1][0];
    expect(second.message).toContain('1 本内容包世界书被你编辑过');
    expect(second.message).toContain('修改会丢失');
    expect(second.details).toEqual(['《主世界观》']);
    expect(content.uninstallPack).toHaveBeenLastCalledWith({ confirmEdits: true });
  });

  it('编辑过包内世界书时取消第二道确认 → 不丢弃修改', async () => {
    const content = useContentStore();
    confirmDialogMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(content.uninstallPack).mockResolvedValueOnce({
      ok: false,
      status: 'needs_confirmation',
      plan: { packId: 'fixture', ownedBookIds: [], confirmations: [] },
    });
    mountSection();
    await flushPromises();
    await clickButton('卸载内容包');

    expect(content.uninstallPack).toHaveBeenCalledTimes(1);
    expect(useUIStore().toasts.some((t) => t.message.includes('已卸载'))).toBe(false);
  });

  it('在线授权包的确认文案提示需要重新登录 Discord 下载', async () => {
    const content = useContentStore();
    content.protectedPack = true;
    confirmDialogMock.mockResolvedValue(false);
    mountSection();
    await flushPromises();
    await clickButton('卸载内容包');

    expect((confirmDialogMock.mock.calls[0][0].details ?? []).join('\n')).toContain(
      '重新登录 Discord',
    );
  });
});
