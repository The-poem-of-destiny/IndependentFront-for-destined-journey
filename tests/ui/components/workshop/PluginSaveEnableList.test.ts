/**
 * PluginSaveEnableList —— 某存档的插件启用面（插件设计 §3.4 / §6.4）
 *
 * 钉住：启用只在短版风险确认后才调 enableForSave；停用直接 disableForSave；
 * 「已启用但未安装」「需要重新确认」可见；清除本存档插件数据要先确认；存档不在列表里时先 loadSaves。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import PluginSaveEnableList from '../../../../src/ui/components/workshop/PluginSaveEnableList.vue';

const h = vi.hoisted(() => ({
  plugin: null as unknown as Record<string, unknown>,
  game: null as unknown as Record<string, unknown>,
  ui: { toast: vi.fn() },
  confirmDialog: vi.fn(async () => true),
  clearPluginSaveData: vi.fn(async () => {}),
}));

vi.mock('../../../../src/ui/stores/plugin-store', () => ({ usePluginStore: () => h.plugin }));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => h.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => h.ui }));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: h.confirmDialog }));
vi.mock('@engine/state/save-profile', () => ({ clearPluginSaveData: h.clearPluginSaveData }));

const RiskModalStub = {
  props: ['variant', 'manifest'],
  emits: ['confirm', 'cancel'],
  template: `<div data-testid="risk-modal" :data-variant="variant">
    <button data-testid="risk-confirm" @click="$emit('confirm')">确认</button>
    <button data-testid="risk-cancel" @click="$emit('cancel')">取消</button>
  </div>`,
};

function record(id: string, name: string) {
  return {
    id,
    manifest: { id, name, version: '1.0.0', network: [], capabilities: {} },
    saveConsents: {},
  };
}

const SAVE_ID = 'save-1';
const wrappers: VueWrapper[] = [];

async function mountList() {
  const w = mount(PluginSaveEnableList, {
    props: { saveId: SAVE_ID },
    global: { stubs: { PluginRiskConfirmModal: RiskModalStub } },
    attachTo: document.body,
  });
  wrappers.push(w);
  await flushPromises();
  return w;
}

function row(w: VueWrapper, id: string) {
  return w.get(`[data-plugin-id="${id}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmDialog.mockImplementation(async () => true);
  h.game = reactive({
    saves: [{ id: SAVE_ID, metadata: { enabledPluginIds: ['on'] } }],
    loadSaves: vi.fn(async () => {}),
    refreshFromDb: vi.fn(async () => {}),
  });
  h.plugin = reactive({
    records: [record('on', '已开插件'), record('off', '未开插件')],
    needsReconfirm: vi.fn(() => []),
    enabledButNotInstalled: vi.fn(() => []),
    isEffectivelyEnabled: vi.fn(() => true),
    enableForSave: vi.fn(async () => ({ ok: true })),
    disableForSave: vi.fn(async () => ({ ok: true })),
  });
});

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('PluginSaveEnableList', () => {
  it('开关反映本存档的启用状态', async () => {
    const w = await mountList();
    const on = row(w, 'on').get('[data-testid="plugin-save-toggle"]');
    const off = row(w, 'off').get('[data-testid="plugin-save-toggle"]');
    expect(on.attributes('aria-checked')).toBe('true');
    expect(off.attributes('aria-checked')).toBe('false');
    expect(row(w, 'on').text()).toContain('已启用');
  });

  it('启用先弹短版风险确认，只有确认后才调 enableForSave', async () => {
    const w = await mountList();
    await row(w, 'off').get('[data-testid="plugin-save-toggle"]').trigger('click');
    expect(w.get('[data-testid="risk-modal"]').attributes('data-variant')).toBe('save');
    expect(h.plugin.enableForSave).not.toHaveBeenCalled();

    await w.get('[data-testid="risk-cancel"]').trigger('click');
    expect(h.plugin.enableForSave).not.toHaveBeenCalled();

    await row(w, 'off').get('[data-testid="plugin-save-toggle"]').trigger('click');
    await w.get('[data-testid="risk-confirm"]').trigger('click');
    await flushPromises();
    expect(h.plugin.enableForSave).toHaveBeenCalledWith(SAVE_ID, 'off', { confirmed: true });
  });

  it('停用不弹确认，直接 disableForSave', async () => {
    const w = await mountList();
    await row(w, 'on').get('[data-testid="plugin-save-toggle"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="risk-modal"]').exists()).toBe(false);
    expect(h.plugin.disableForSave).toHaveBeenCalledWith(SAVE_ID, 'on');
  });

  it('提示「已启用但未安装」的插件，数据原样保留', async () => {
    (h.plugin.enabledButNotInstalled as ReturnType<typeof vi.fn>).mockReturnValue(['ghost']);
    const w = await mountList();
    const notice = w.get('[data-testid="plugin-missing"]');
    expect(notice.text()).toContain('ghost');
    expect(notice.text()).toContain('没有安装');
    expect(h.plugin.enabledButNotInstalled).toHaveBeenCalledWith(SAVE_ID);
  });

  it('「需要重新确认」的插件可重新过短版确认', async () => {
    const pending = (h.plugin.records as ReturnType<typeof record>[])[0]!;
    (h.plugin.needsReconfirm as ReturnType<typeof vi.fn>).mockReturnValue([pending]);
    const w = await mountList();
    expect(w.get('[data-testid="plugin-reconfirm"]').text()).toContain('已开插件');
    expect(row(w, 'on').text()).toContain('需要重新确认');

    await w.get('[data-reconfirm-id="on"]').trigger('click');
    expect(h.plugin.disableForSave).not.toHaveBeenCalled();
    await w.get('[data-testid="risk-confirm"]').trigger('click');
    await flushPromises();
    expect(h.plugin.enableForSave).toHaveBeenCalledWith(SAVE_ID, 'on', { confirmed: true });
  });

  it('清除本存档插件数据要先确认，确认后清除并回读当前存档', async () => {
    const w = await mountList();
    h.confirmDialog.mockImplementationOnce(async () => false);
    await row(w, 'off').get('[data-clear-id="off"]').trigger('click');
    await flushPromises();
    expect(h.clearPluginSaveData).not.toHaveBeenCalled();

    await row(w, 'off').get('[data-clear-id="off"]').trigger('click');
    await flushPromises();
    expect(h.confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true }));
    expect(h.clearPluginSaveData).toHaveBeenCalledWith(SAVE_ID, 'off');
    expect(h.game.refreshFromDb).toHaveBeenCalledWith(SAVE_ID);
  });

  it('存档不在 game.saves 里时先 loadSaves', async () => {
    h.game.saves = [];
    await mountList();
    expect(h.game.loadSaves).toHaveBeenCalledTimes(1);
  });
});
