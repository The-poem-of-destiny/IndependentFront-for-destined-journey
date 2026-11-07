// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import DataSection from '../../../../src/ui/components/settings/DataSection.vue';
import PackInstallConfirmModal from '../../../../src/ui/components/settings/PackInstallConfirmModal.vue';
import { useContentStore } from '../../../../src/ui/stores/content-store';
import { checkPackUpdate, downloadLatestPack } from '../../../../src/ui/lib/content-pack-updater';
import { encryptPrivatePack, makePrivatePack } from '../../../helpers/pack-auth-fixture';

vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    getStorageUsage: async () => ({ used: 0, quota: 1024, pct: 0 }),
    loadAgentProjectDefaults: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({}),
}));
vi.mock('@engine/persistence/database', () => ({
  getSaveProfile: vi.fn(),
}));
vi.mock('../../../../src/ui/stores/content-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive({
    activePackId: 'fixture',
    activePackVersion: '1.0.0',
    hydratePackState: vi.fn().mockResolvedValue(undefined),
    installProtectedPack: vi.fn(),
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
  setActivePinia(createPinia());
  const content = useContentStore();
  content.activePackVersion = '1.0.0';
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

async function clickButton(text: string) {
  await wrapper
    .findAll('button')
    .find((button) => button.text() === text)!
    .trigger('click');
  await flushPromises();
}

async function checkUpdate() {
  wrapper = mount(DataSection, {
    global: {
      stubs: { teleport: true, DiscordPackAccess: true, PackInstallConfirmModal: true },
    },
  });
  await flushPromises();
  await clickButton('检查更新');
  expect(wrapper.text()).toContain('更新到 2.0.0');
}

describe('DataSection 内容包更新状态', () => {
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
