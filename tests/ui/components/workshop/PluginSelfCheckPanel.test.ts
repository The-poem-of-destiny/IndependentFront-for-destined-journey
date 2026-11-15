/**
 * PluginSelfCheckPanel —— 插件启动自检面板（插件设计 §4.8）
 *
 * 钉住：检查中 / 通过 / 未通过三态；失败项排最前并写明说明；「重新检查」走 rerunSelfCheck；
 * 人工矩阵探针只在开发者模式出现，并挂进生产的插件帧（未声明联网域名）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import PluginSelfCheckPanel from '../../../../src/ui/components/workshop/PluginSelfCheckPanel.vue';

const h = vi.hoisted(() => ({
  plugin: null as unknown as Record<string, unknown>,
  settings: null as unknown as { settings: Record<string, unknown> },
  dispose: vi.fn(),
  mountPluginFrame: vi.fn(),
}));

vi.mock('../../../../src/ui/stores/plugin-store', () => ({ usePluginStore: () => h.plugin }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => h.settings,
}));
vi.mock('../../../../src/ui/lib/plugin-frame', () => ({ mountPluginFrame: h.mountPluginFrame }));
vi.mock('../../../../src/ui/lib/plugin-selfcheck', () => ({
  buildManualMatrixProbe: () => '<!doctype html><title>探针</title>',
}));

const wrappers: VueWrapper[] = [];

async function mountPanel() {
  const w = mount(PluginSelfCheckPanel, { attachTo: document.body });
  wrappers.push(w);
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mountPluginFrame.mockImplementation(() => ({ port: {}, dispose: h.dispose }));
  h.plugin = reactive({ selfCheck: null, rerunSelfCheck: vi.fn(async () => ({})) });
  h.settings = reactive({ settings: { developerMode: false } });
});

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('PluginSelfCheckPanel', () => {
  it('检查中时显示「检查中」', async () => {
    h.plugin.selfCheck = 'running';
    const w = await mountPanel();
    expect(w.get('[data-testid="selfcheck-state"]').text()).toBe('检查中…');
  });

  it('通过时显示内层装载方式与逐项结果', async () => {
    h.plugin.selfCheck = {
      ok: true,
      innerMode: 'blob',
      ranAt: 1,
      items: [{ id: 'S5', status: 'skipped', detail: '没有第二个本机主机名' }],
    };
    const w = await mountPanel();
    expect(w.get('[data-testid="selfcheck-state"]').text()).toBe('已通过');
    expect(w.text()).toContain('内层装载方式：blob');
    expect(w.get('[data-item-id="S5"]').text()).toContain('未自检');
  });

  it('未通过时失败项排最前，并写明是哪一项', async () => {
    h.plugin.selfCheck = {
      ok: false,
      innerMode: null,
      ranAt: 1,
      items: [
        { id: 'CAGE', status: 'pass', detail: '牢笼帧正常' },
        { id: 'S6', status: 'fail', detail: '模型帧的 <img> 命中了金丝雀' },
      ],
    };
    const w = await mountPanel();
    const rows = w.findAll('.selfcheck-item');
    expect(rows[0]!.attributes('data-item-id')).toBe('S6');
    expect(rows[0]!.text()).toContain('模型帧的 <img> 命中了金丝雀');
    expect(w.get('[role="alert"]').text()).toContain('S6 插件存档的美化帧');
    expect(w.text()).toContain('内层装载方式：无');
  });

  it('「重新检查」调用 rerunSelfCheck', async () => {
    const w = await mountPanel();
    await w.get('[data-testid="selfcheck-rerun"]').trigger('click');
    expect(h.plugin.rerunSelfCheck).toHaveBeenCalledTimes(1);
  });

  it('非开发者模式不出现人工矩阵探针入口', async () => {
    const w = await mountPanel();
    expect(w.find('[data-testid="selfcheck-dev"]').exists()).toBe(false);
    expect(w.find('[data-testid="probe-open"]').exists()).toBe(false);
  });

  it('开发者模式下探针挂进生产插件帧，关闭即拆', async () => {
    h.settings.settings.developerMode = true;
    h.plugin.selfCheck = { ok: true, innerMode: 'srcdoc', ranAt: 1, items: [] };
    const w = await mountPanel();
    await w.get('[data-testid="probe-open"]').trigger('click');
    await flushPromises();

    expect(h.mountPluginFrame).toHaveBeenCalledTimes(1);
    const [host, options] = h.mountPluginFrame.mock.calls[0]!;
    expect(host).toBe(w.get('[data-testid="probe-host"]').element);
    expect(options.network).toEqual([]);
    expect(options.entry).toBe('index.html');
    expect(options.innerMode).toBe('srcdoc');
    expect(new TextDecoder().decode(options.files[0].bytes)).toContain('探针');
    expect(w.text()).toContain('抓包');

    await w.get('[data-testid="probe-close"]').trigger('click');
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="probe-host"]').exists()).toBe(false);
  });
});
