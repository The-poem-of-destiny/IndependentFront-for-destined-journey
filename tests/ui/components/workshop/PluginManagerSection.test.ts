/**
 * PluginManagerSection —— 扩展管理页的插件管理一节（插件设计 §3.3 / §3.4 / §4.8）
 *
 * 钉住：自检失败时写明是哪一项；安装 / 更新只在风险弹窗确认后才调 install；
 * networkAdded 只在更新时传；文件夹状态与 BFF 关闭原因可见；开发者区开关只在开发者模式出现。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import PluginManagerSection from '../../../../src/ui/components/workshop/PluginManagerSection.vue';
import type { PluginEntryView } from '../../../../src/ui/stores/plugin-store';
import type { PluginManifest } from '../../../../src/core/types/types-plugin';

const h = vi.hoisted(() => ({
  plugin: null as unknown as Record<string, unknown>,
  settings: null as unknown as { settings: Record<string, unknown> },
  game: {
    saves: [] as unknown[],
    activeSaveId: null as string | null,
    loadSaves: vi.fn(async () => {}),
  },
  ui: { toast: vi.fn() },
  confirmDialog: vi.fn(async () => true),
}));

vi.mock('../../../../src/ui/stores/plugin-store', () => ({ usePluginStore: () => h.plugin }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => h.settings,
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => h.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => h.ui }));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: h.confirmDialog }));
vi.mock('../../../../src/ui/lib/plugin-frame', () => ({ mountPluginFrame: vi.fn() }));

const RiskModalStub = {
  props: ['variant', 'manifest', 'networkAdded', 'source', 'fileCount', 'totalBytes'],
  emits: ['confirm', 'cancel'],
  template: `<div data-testid="risk-modal" :data-variant="variant">
    <button data-testid="risk-confirm" @click="$emit('confirm')">确认</button>
    <button data-testid="risk-cancel" @click="$emit('cancel')">取消</button>
  </div>`,
};

const global = {
  stubs: {
    PluginRiskConfirmModal: RiskModalStub,
    PluginSaveEnableList: {
      props: ['saveId'],
      template: '<div data-testid="save-list" :data-save-id="saveId" />',
    },
  },
};

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'shop',
    name: '杂货铺',
    version: '1.0.0',
    author: '作者甲',
    pluginApi: '^1.0.0',
    contributions: [],
    network: [],
    capabilities: { read: ['player'], commands: [], events: [], ai: [], storage: [] },
    ...over,
  } as PluginManifest;
}

function entry(over: Partial<PluginEntryView> = {}): PluginEntryView {
  const m = manifest();
  return {
    id: 'shop',
    status: 'not-installed',
    local: { id: 'shop', manifestText: '{}', files: [], totalBytes: 2048 },
    record: null,
    plan: {
      status: 'ok',
      action: 'install',
      manifest: m,
      source: 'local',
      contentHash: 'h1',
      networkHash: 'n1',
      networkAdded: [],
      requiresReconsent: true,
      invalidatesSaveConsents: false,
      fileCount: 3,
      totalBytes: 2048,
      errors: [],
      droppedNotes: [],
    },
    errors: [],
    ...over,
  };
}

const wrappers: VueWrapper[] = [];

async function mountSection() {
  const w = mount(PluginManagerSection, { global, attachTo: document.body });
  wrappers.push(w);
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmDialog.mockImplementation(async () => true);
  h.plugin = reactive({
    listing: { enabled: true, dir: 'E:/poem-plugins', dirExists: true, plugins: [] },
    listingError: null,
    selfCheck: null,
    entries: [] as PluginEntryView[],
    records: [],
    refresh: vi.fn(async () => {}),
    ensureSelfCheck: vi.fn(async () => ({})),
    rerunSelfCheck: vi.fn(async () => ({})),
    install: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    isBusy: vi.fn(() => false),
    iconFor: vi.fn(() => null),
  });
  h.settings = reactive({ settings: { developerMode: false, pluginDevAutoReload: false } });
  h.game.saves = [];
  h.game.activeSaveId = null;
});

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('PluginManagerSection', () => {
  it('打开即重新扫描并踢一脚自检（决策 9）', async () => {
    await mountSection();
    expect(h.plugin.refresh).toHaveBeenCalledTimes(1);
    expect(h.plugin.refresh).toHaveBeenCalledWith({ devAutoReload: false });
    expect(h.plugin.ensureSelfCheck).toHaveBeenCalledTimes(1);
    expect(h.game.loadSaves).toHaveBeenCalled();
  });

  it('自检未通过时写明是哪一项失败，并说明插件已停用', async () => {
    h.plugin.selfCheck = {
      ok: false,
      innerMode: 'srcdoc',
      ranAt: 1,
      items: [
        { id: 'S0', status: 'pass', detail: '对照组全部命中' },
        { id: 'S1', status: 'fail', detail: 'fetch 命中了金丝雀' },
      ],
    };
    const w = await mountSection();
    expect(w.get('[data-testid="selfcheck-state"]').text()).toBe('未通过');
    const failed = w.get('[data-item-id="S1"]');
    expect(failed.attributes('data-status')).toBe('fail');
    expect(failed.text()).toContain('资源请求被拦截');
    expect(failed.text()).toContain('fetch 命中了金丝雀');
    expect(w.text()).toContain('未通过的项目：S1 资源请求被拦截');
    expect(w.find('[data-testid="plugin-disabled-notice"]').exists()).toBe(true);
  });

  it('安装先弹风险确认，只有点了确认才调 install', async () => {
    h.plugin.entries = [entry()];
    const w = await mountSection();
    expect(w.find('[data-testid="risk-modal"]').exists()).toBe(false);

    await w.get('[data-testid="plugin-install"]').trigger('click');
    const modal = w.getComponent(RiskModalStub);
    expect(modal.props('variant')).toBe('install');
    expect(modal.props('networkAdded')).toBeUndefined();
    expect(modal.props('source')).toBe('local');
    expect(modal.props('fileCount')).toBe(3);
    expect(modal.props('totalBytes')).toBe(2048);
    expect(h.plugin.install).not.toHaveBeenCalled();

    await w.get('[data-testid="risk-cancel"]').trigger('click');
    expect(w.find('[data-testid="risk-modal"]').exists()).toBe(false);
    expect(h.plugin.install).not.toHaveBeenCalled();

    await w.get('[data-testid="plugin-install"]').trigger('click');
    await w.get('[data-testid="risk-confirm"]').trigger('click');
    await flushPromises();
    expect(h.plugin.install).toHaveBeenCalledWith('shop', { confirmed: true });
    expect(h.ui.toast).toHaveBeenCalledWith('已安装插件「杂货铺」', 'success');
  });

  it('更新时把新增域名传给弹窗', async () => {
    const base = entry();
    h.plugin.entries = [
      entry({
        status: 'update-available',
        record: { manifest: manifest({ version: '0.9.0' }) } as PluginEntryView['record'],
        plan: { ...base.plan!, action: 'update', networkAdded: ['api.example.com'] },
      }),
    ];
    const w = await mountSection();
    const btn = w.get('[data-testid="plugin-install"]');
    expect(btn.text()).toBe('更新');
    await btn.trigger('click');
    expect(w.getComponent(RiskModalStub).props('networkAdded')).toEqual(['api.example.com']);
    expect(w.text()).toContain('已装 v0.9.0');
  });

  it('无效插件不给安装按钮，并列出原因', async () => {
    h.plugin.entries = [entry({ status: 'invalid', plan: null, errors: ['manifest.json 缺失'] })];
    const w = await mountSection();
    expect(w.find('[data-testid="plugin-install"]').exists()).toBe(false);
    expect(w.get('[data-testid="plugin-status"]').text()).toBe('无效');
    expect(w.text()).toContain('manifest.json 缺失');
  });

  it('卸载先确认，取消则不卸载', async () => {
    h.plugin.entries = [
      entry({
        status: 'up-to-date',
        record: { manifest: manifest() } as PluginEntryView['record'],
      }),
    ];
    const w = await mountSection();
    h.confirmDialog.mockImplementationOnce(async () => false);
    await w.get('[data-testid="plugin-uninstall"]').trigger('click');
    await flushPromises();
    expect(h.plugin.uninstall).not.toHaveBeenCalled();

    await w.get('[data-testid="plugin-uninstall"]').trigger('click');
    await flushPromises();
    expect(h.plugin.uninstall).toHaveBeenCalledWith('shop');
  });

  it('显示本地文件夹路径与「文件夹尚不存在」提示', async () => {
    h.plugin.listing = { enabled: true, dir: 'E:/poem-plugins', dirExists: false, plugins: [] };
    const w = await mountSection();
    const folder = w.get('[data-testid="plugin-folder"]');
    expect(folder.text()).toContain('E:/poem-plugins');
    expect(folder.text()).toContain('文件夹尚不存在');
  });

  it('BFF 关掉插件目录时显示原因', async () => {
    h.plugin.listing = { enabled: false, reason: 'inside-root', message: '插件目录不能放在仓库里' };
    const w = await mountSection();
    const folder = w.get('[data-testid="plugin-folder"]');
    expect(folder.text()).toContain('插件目录不能放在仓库里');
    expect(folder.text()).toContain('inside-root');
  });

  it('处理中的插件显示忙碌态', async () => {
    h.plugin.entries = [entry()];
    (h.plugin.isBusy as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const w = await mountSection();
    expect(w.text()).toContain('处理中…');
    expect(w.get('[data-testid="plugin-install"]').attributes('disabled')).toBeDefined();
  });

  it('「跟随文件夹自动重载」开关只在开发者模式出现，并写进设置', async () => {
    let w = await mountSection();
    expect(w.find('[data-testid="plugin-dev-autoreload"]').exists()).toBe(false);
    w.unmount();
    wrappers.pop();

    h.settings.settings.developerMode = true;
    w = await mountSection();
    await w.get('[data-testid="plugin-dev-autoreload"]').setValue(true);
    expect(h.settings.settings.pluginDevAutoReload).toBe(true);
    await w.get('[data-testid="plugin-rescan"]').trigger('click');
    await flushPromises();
    expect(h.plugin.refresh).toHaveBeenLastCalledWith({ devAutoReload: true });
  });

  it('开发者模式关着时，即便设置里自动重载为真也不自动重载', async () => {
    h.settings.settings.developerMode = false;
    h.settings.settings.pluginDevAutoReload = true;
    const w = await mountSection();
    expect(h.plugin.refresh).toHaveBeenLastCalledWith({ devAutoReload: false });
    await w.get('[data-testid="plugin-rescan"]').trigger('click');
    await flushPromises();
    expect(h.plugin.refresh).toHaveBeenLastCalledWith({ devAutoReload: false });
  });

  it('有存档时显示按存档启用列表，默认选中当前存档', async () => {
    h.game.saves = [
      { id: 'a', name: '甲', updatedAt: 2, slot: 0, metadata: {} },
      { id: 'b', name: '乙', updatedAt: 1, slot: 1, metadata: {} },
    ];
    h.game.activeSaveId = 'b';
    const w = await mountSection();
    expect(w.get('[data-testid="save-list"]').attributes('data-save-id')).toBe('b');
  });
});
