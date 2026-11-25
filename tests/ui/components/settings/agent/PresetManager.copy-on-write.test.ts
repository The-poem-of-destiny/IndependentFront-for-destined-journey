/**
 * PresetManager.vue —— 只读预设的写时复制（2026-11-14）
 *
 * 内容包 / 出厂 / 引擎内置的预设是只读的。对它们的**内容编辑**（改文本、增删、排序、预填充）都必须：
 *   1. 先复制成「<原名>（我的修改）」并切换到副本；
 *   2. 把改动落在副本上；
 *   3. 原预设一个字节都不动（此前受保护包的编辑「只进内存、刷新就丢」）。
 *
 * 📌 2026-11-21 语义反转：**拨开关不再复制**，写进玩家覆写层 `settings.presetEntryToggles`；
 *    之后若因改文本复制，副本带着当前开关。
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
import { registerFactoryPresetIds } from '../../../../../src/ui/lib/preset-catalog';
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
  it('🔴 拨内容包预设里一条条目的开关：不复制，写进覆写层，原行不动', async () => {
    const toast = vi.spyOn(useUIStore(), 'toast');
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    expect(w.text()).toContain('内容默认');

    await w.find('.subprompt-toggle').trigger('click');
    await vi.waitFor(() =>
      expect(mockSettings.presetEntryToggles).toEqual({ [PACK.id]: { main: false } }),
    );
    await flushPromises();

    const rows = await getDatabase().presets.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(PACK);
    // 选择键不动、没有「已复制」提示
    expect(mockSettings.activePresetId).toBe('');
    expect(toast).not.toHaveBeenCalledWith('已复制为我的预设并切换；原预设保持不变', 'info');
    // 列表读的是套过覆写的视图
    expect(w.find('.subprompt-toggle input').element).toHaveProperty('checked', false);

    // 「已调整 1 项 · 恢复出厂开关」清掉覆写层
    const reset = w.find('[data-testid="preset-reset-toggles"]');
    expect(reset.text()).toContain('已调整 1 项');
    expect(reset.attributes('aria-label')).toContain('恢复出厂开关');
    await reset.trigger('click');
    expect(mockSettings.presetEntryToggles ?? {}).toEqual({});
    await flushPromises();
    expect(w.find('[data-testid="preset-reset-toggles"]').exists()).toBe(false);
  });

  it('🔴 改文本仍写时复制：原行不动，副本被选中，且带着当前开关', async () => {
    const toast = vi.spyOn(useUIStore(), 'toast');
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    // 先拨开关（只进覆写层），再做一次内容编辑（复制条目）
    await w.find('.subprompt-toggle').trigger('click');
    await vi.waitFor(() => expect(mockSettings.presetEntryToggles?.[PACK.id]).toBeTruthy());
    await w.find('[data-testid="entry-duplicate"]').trigger('click');
    await vi.waitFor(() => expect(mockSettings.activePresetId).not.toBe(''));
    await flushPromises();

    const rows = await getDatabase().presets.toArray();
    expect(rows.find((r) => r.id === PACK.id)!).toEqual(PACK);
    const copy = rows.find((r) => r.id !== PACK.id)!;
    expect(copy.name).toBe('内容默认（我的修改）');
    expect(copy.scope).toBe('story');
    const prompts = copy.settings.prompts as any[];
    // 复制出的那条在 main 正下方，两条都带着「main 已关」这个当前开关
    const plain = prompts.filter((p) => !String(p.identifier).startsWith('story_zone_'));
    expect(plain).toHaveLength(2);
    expect(prompts.find((p) => p.identifier === 'main').enabled).toBe(false);
    expect(mockSettings.activePresetId).toBe(copy.id);
    expect(toast).toHaveBeenCalledWith('已复制为我的预设并切换；原预设保持不变', 'info');
  });

  it('📌 2026-11-17：出厂行带播种指纹时，副本不带（否则启动播种会把副本当成出厂行）', async () => {
    const { stampFactoryPreset } = await import('@engine/prompts/factory-preset-sync');
    const stamped = stampFactoryPreset(JSON.parse(JSON.stringify(PACK)));
    await getDatabase().presets.put(stamped);
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    await w.find('[data-testid="entry-duplicate"]').trigger('click');
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
    await w.find('[data-testid="entry-duplicate"]').trigger('click');
    await vi.waitFor(() => expect(mockSettings.directCachedPresetId).toBeTruthy());
    await flushPromises();
    const copy = await getDatabase().presets.get(mockSettings.directCachedPresetId);
    expect(copy?.name).toBe('内容默认（我的修改）');
    expect(copy?.scope).toBe('direct_cached');
  });

  it('副本是玩家自己的：再拨开关直接改副本那一行，不再复制、不进覆写层', async () => {
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    await w.find('[data-testid="entry-duplicate"]').trigger('click');
    await vi.waitFor(() => expect(mockSettings.activePresetId).not.toBe(''));
    const copyId = mockSettings.activePresetId;
    await flushPromises();
    await w.find('.subprompt-toggle').trigger('click');
    const mainEnabled = async () =>
      ((await getDatabase().presets.get(copyId))!.settings.prompts as any[]).find(
        (p) => p.identifier === 'main',
      ).enabled;
    await vi.waitFor(async () => expect(await mainEnabled()).toBe(false));
    expect(await getDatabase().presets.count()).toBe(2);
    expect(mockSettings.activePresetId).toBe(copyId);
    expect(mockSettings.presetEntryToggles?.[copyId]).toBeUndefined();
  });

  it('🔴 非只读、带播种指纹的行：改内容整行写入后清掉它的覆写键，不留双来源', async () => {
    const seeded: ChatPreset = {
      id: 'seeded-user',
      name: '带指纹的行',
      factorySeedHash: 'stale-hash',
      settings: {
        prompts: [
          { identifier: 'main', name: '主提示', content: '正文', role: 'system', enabled: true },
        ],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    await savePreset(JSON.parse(JSON.stringify(seeded)));
    mockSettings.activePresetId = seeded.id;
    // 这种行走覆写层：玩家先前拨过的开关在这里
    mockSettings.presetEntryToggles = { [seeded.id]: { main: false } };
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    expect(w.find('.subprompt-toggle input').element).toHaveProperty('checked', false);

    await w.find('[data-testid="entry-duplicate"]').trigger('click');
    await vi.waitFor(() => expect(mockSettings.presetEntryToggles?.[seeded.id]).toBeUndefined());
    await flushPromises();

    // 原地写（不是只读，不复制），当前开关随整行落进去
    expect(mockSettings.activePresetId).toBe(seeded.id);
    expect(await getDatabase().presets.count()).toBe(2);
    const row = (await getDatabase().presets.get(seeded.id))!;
    const plain = (row.settings.prompts as any[]).filter(
      (p) => !String(p.identifier).startsWith('story_zone_'),
    );
    expect(plain).toHaveLength(2);
    expect(plain.every((p) => p.enabled === false)).toBe(true);
    // 覆写清掉后界面仍是「关」：来源只剩行本身
    expect(w.find('.subprompt-toggle input').element).toHaveProperty('checked', false);
  });

  it('写入失败时覆写键保留（行没写进去，开关只在覆写层里）', async () => {
    const seeded: ChatPreset = {
      id: 'seeded-user',
      name: '带指纹的行',
      factorySeedHash: 'stale-hash',
      settings: {
        prompts: [
          { identifier: 'main', name: '主提示', content: '正文', role: 'system', enabled: true },
        ],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    await savePreset(JSON.parse(JSON.stringify(seeded)));
    mockSettings.activePresetId = seeded.id;
    mockSettings.presetEntryToggles = { [seeded.id]: { main: false } };
    const w = mount(PresetManager, { props: { agentId: 'story' } });
    await flushPromises();
    const put = vi
      .spyOn(getDatabase().presets, 'put')
      .mockRejectedValueOnce(new Error('quota exceeded'));
    await w.find('[data-testid="entry-duplicate"]').trigger('click');
    await flushPromises();
    expect(put).toHaveBeenCalled();
    expect(mockSettings.presetEntryToggles).toEqual({ [seeded.id]: { main: false } });
    put.mockRestore();
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
