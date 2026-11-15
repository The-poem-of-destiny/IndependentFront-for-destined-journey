/**
 * S-16：删除正文预设要确认；删掉当前预设后改选剩下的一条并告知；删除失败要报错。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { DIRECT_PRESET_ID } from '@engine/prompts/direct-prompt';

const state = vi.hoisted(() => ({
  settings: null as unknown as Record<string, any>,
  defaults: null as unknown as { agents: Record<string, any> },
  toast: vi.fn(),
}));
const confirmDialog = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));
const presets = ref<any[]>([]);
const removePreset = vi.fn(async (id: string) => {
  presets.value = presets.value.filter((p) => p.id !== id);
});

vi.mock('@ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('@ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: state.settings,
    projectAgentDefaults: state.defaults,
  }),
}));
vi.mock('@ui/stores/ui-store', () => ({ useUIStore: () => ({ toast: state.toast }) }));
vi.mock('@ui/composables/usePresets', () => ({
  usePresets: () => ({
    presets,
    loadPresets: vi.fn(async () => undefined),
    upsertPreset: vi.fn(async () => undefined),
    removePreset,
  }),
}));

import PresetManager from '@ui/components/settings/agent/PresetManager.vue';

function preset(id: string, name: string) {
  return { id, name, settings: { prompts: [] }, createdAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  state.toast.mockReset();
  removePreset.mockClear();
  state.settings = reactive({ activePresetId: 'imported', agents: {} });
  state.defaults = { agents: { story: { presetId: 'factory' } } };
  presets.value = [
    preset(DIRECT_PRESET_ID, '直出'),
    preset('imported', '导入的酒馆预设'),
    preset('factory', '出厂预设'),
  ];
});

async function clickDelete() {
  const wrapper = mount(PresetManager, { props: { agentId: 'story' } });
  await flushPromises();
  const button = wrapper.findAll('.preset-viewer-actions button').find((b) => b.text() === '删除')!;
  await button.trigger('click');
  await flushPromises();
  return wrapper;
}

describe('PresetManager 删除预设', () => {
  it('先确认（点名预设）；取消则什么都不动', async () => {
    confirmDialog.mockResolvedValue(false);
    await clickDelete();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, message: expect.stringContaining('导入的酒馆预设') }),
    );
    expect(removePreset).not.toHaveBeenCalled();
    expect(state.settings.activePresetId).toBe('imported');
  });

  it('删掉当前预设 → 改选项目默认那条，并告诉用户换成了哪条', async () => {
    await clickDelete();
    expect(removePreset).toHaveBeenCalledWith('imported');
    expect(state.settings.activePresetId).toBe('factory');
    expect(state.toast).toHaveBeenCalledWith(expect.stringContaining('已改用「出厂预设」'), 'info');
  });

  it('没有项目默认时改选第一条非直出预设', async () => {
    state.defaults = { agents: {} };
    presets.value = [
      preset(DIRECT_PRESET_ID, '直出'),
      preset('imported', '导入的酒馆预设'),
      preset('other', '另一条'),
    ];
    await clickDelete();
    expect(state.settings.activePresetId).toBe('other');
  });

  it('数据库写失败 → 报错，不吞掉，选择不变', async () => {
    removePreset.mockRejectedValueOnce(new Error('IndexedDB 不可用'));
    await clickDelete();
    expect(state.toast).toHaveBeenCalledWith(expect.stringContaining('IndexedDB 不可用'), 'error');
    expect(state.settings.activePresetId).toBe('imported');
  });
});
