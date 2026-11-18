/**
 * PresetManager.vue —— 只读预设的写时复制（2026-11-14）
 *
 * 内容包 / 出厂 / 引擎内置的预设是只读的。对它们的任何编辑都必须：
 *   1. 先复制成「<原名>（我的修改）」并切换到副本；
 *   2. 把改动落在副本上；
 *   3. 原预设一个字节都不动（此前受保护包的编辑「只进内存、刷新就丢」）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatPreset } from '@engine/types/types';

enableAutoUnmount(afterEach);

const mockSettings = reactive<Record<string, any>>({});
const mockStore = reactive({
  settings: mockSettings,
  projectAgentDefaults: null as { agents: Record<string, any> } | null,
});
vi.mock('../../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => mockStore,
}));

import PresetManager from '../../../../../src/ui/components/settings/agent/PresetManager.vue';
import { registerFactoryPresetIds } from '../../../../../src/ui/composables/usePresets';
import { useUIStore } from '../../../../../src/ui/stores/ui-store';
import { getDatabase, savePreset } from '../../../../../src/core/persistence/database';

const PACK: ChatPreset = {
  id: 'pack-a',
  name: '内容默认',
  settings: {
    prompts: [
      { identifier: 'main', name: '主提示', content: '正文', role: 'system', enabled: true },
    ],
  },
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(async () => {
  setActivePinia(createPinia());
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, { agents: {}, activePresetId: '' });
  mockStore.projectAgentDefaults = { agents: { story: { presetId: PACK.id, preset: PACK } } };
  registerFactoryPresetIds([PACK.id]);
  await getDatabase().presets.clear();
  await savePreset(JSON.parse(JSON.stringify(PACK)));
});

describe('PresetManager —— 只读预设写时复制', () => {
  it('🔴 切换内容包预设里一条条目的启用：原行不动，副本被选中且带着改动', async () => {
    const toast = vi.spyOn(useUIStore(), 'toast');
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    expect(w.text()).toContain('内容默认');

    await w.find('.subprompt-toggle').trigger('click');
    // fake-indexeddb 走宏任务：等到选择真的切到副本
    await vi.waitFor(() => expect(mockSettings.activePresetId).not.toBe(''));
    await flushPromises();

    const rows = await getDatabase().presets.toArray();
    const original = rows.find((r) => r.id === PACK.id)!;
    expect(original).toEqual(PACK);

    const copy = rows.find((r) => r.id !== PACK.id)!;
    expect(copy.name).toBe('内容默认（我的修改）');
    expect(copy.scope).toBe('story');
    const main = (copy.settings.prompts as any[]).find((p) => p.identifier === 'main');
    expect(main.enabled).toBe(false);
    expect(mockSettings.activePresetId).toBe(copy.id);

    // 只有一条 toast，而且说清楚原预设没动
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已复制为我的预设并切换；原预设保持不变', 'info');
  });

  it('📌 2026-11-17：出厂行带播种指纹时，副本不带（否则启动播种会把副本当成出厂行）', async () => {
    const { stampFactoryPreset } = await import('@engine/prompts/factory-preset-sync');
    const stamped = stampFactoryPreset(JSON.parse(JSON.stringify(PACK)));
    await getDatabase().presets.put(stamped);
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    await w.find('.subprompt-toggle').trigger('click');
    await vi.waitFor(() => expect(mockSettings.activePresetId).not.toBe(''));
    await flushPromises();

    const rows = await getDatabase().presets.toArray();
    expect(rows.find((r) => r.id === PACK.id)!.factorySeedHash).toBe(stamped.factorySeedHash);
    const copy = rows.find((r) => r.id !== PACK.id)!;
    expect('factorySeedHash' in copy).toBe(false);
  });

  it('来源钉死在 direct_cached 的只读预设：写时复制的副本保持 direct_cached', async () => {
    const pinned: ChatPreset = { ...PACK, id: 'pack-cached', scope: 'direct_cached' };
    mockStore.projectAgentDefaults = {
      agents: { direct_cached: { presetId: pinned.id, preset: pinned } },
    };
    registerFactoryPresetIds([pinned.id]);
    await savePreset(JSON.parse(JSON.stringify(pinned)));
    const w = mount(PresetManager, { props: { agentId: 'direct_cached' } });
    await flushPromises();
    await w.find('.subprompt-toggle').trigger('click');
    await vi.waitFor(() => expect(mockSettings.directCachedPresetId).toBeTruthy());
    await flushPromises();
    const copy = await getDatabase().presets.get(mockSettings.directCachedPresetId);
    expect(copy?.name).toBe('内容默认（我的修改）');
    expect(copy?.scope).toBe('direct_cached');
  });

  it('副本是玩家自己的：再改一次直接写副本，不再复制', async () => {
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    await w.find('.subprompt-toggle').trigger('click');
    await vi.waitFor(() => expect(mockSettings.activePresetId).not.toBe(''));
    const copyId = mockSettings.activePresetId;
    await flushPromises();
    await w.find('.subprompt-toggle').trigger('click');
    const mainEnabled = async () =>
      ((await getDatabase().presets.get(copyId))!.settings.prompts as any[]).find(
        (p) => p.identifier === 'main',
      ).enabled;
    await vi.waitFor(async () => expect(await mainEnabled()).toBe(true));
    expect(await getDatabase().presets.count()).toBe(2);
    expect(mockSettings.activePresetId).toBe(copyId);
  });

  it('预设级编辑入口已搬走：没有「+ 新建」，也没有采样参数 / Main Prompt 编辑框', async () => {
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    expect(w.text()).not.toContain('新建');
    const source = (await import('@ui/components/settings/agent/PresetManager.vue?raw')).default;
    for (const field of ['temp_openai', 'top_p_openai', 'freq_pen_openai', 'pres_pen_openai']) {
      expect(source).not.toContain(field);
    }
    expect(source).not.toContain('mainPrompt');
  });
});
