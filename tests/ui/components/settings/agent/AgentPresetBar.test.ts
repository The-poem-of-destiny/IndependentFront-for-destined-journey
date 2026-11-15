/**
 * AgentPresetBar.vue —— 「预设」状态条（2026-11-14）
 *
 * 守的是「不懂内部机制也看得懂」的几条承诺：
 *   · 分组下拉：默认组恰好一项「默认 · <名称>」，选它存空串（跟随默认）；
 *   · 原先选的预设已不存在时给出一行提示，而不是静默换掉；
 *   · 非预设 Agent 只显示状态行，「恢复默认」交给宿主（只清两项提示词覆写）；
 *   · 删除玩家预设必须先确认。
 *
 * 用真实的 usePresets（fake-indexeddb），只替换 settings-store / content-store。
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

const mockContent = reactive({ contentStatus: 'placeholder', activePackId: null as string | null });
vi.mock('../../../../../src/ui/stores/content-store', () => ({
  useContentStore: () => mockContent,
}));

import AgentPresetBar from '../../../../../src/ui/components/settings/agent/AgentPresetBar.vue';
import { contentSourceLabel } from '../../../../../src/ui/components/settings/agent/preset-bar-labels';
import {
  loadPresets,
  registerFactoryPresetIds,
} from '../../../../../src/ui/composables/usePresets';
import { getDatabase, savePreset } from '../../../../../src/core/persistence/database';
import { DIRECT_PRESET_ID } from '../../../../../src/core/prompts/direct-prompt';

function preset(id: string, name: string, extra: Partial<ChatPreset> = {}): ChatPreset {
  return { id, name, settings: { prompts: [] }, createdAt: 1, updatedAt: 1, ...extra };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, { agents: {}, activePresetId: '' });
  mockStore.projectAgentDefaults = {
    agents: { story: { presetId: 'pack-a', preset: preset('pack-a', '内容默认') } },
  };
  mockContent.contentStatus = 'placeholder';
  mockContent.activePackId = null;
  registerFactoryPresetIds(['pack-b']);
  await getDatabase().presets.clear();
  await savePreset(preset('pack-b', '内容备选'));
  await savePreset(preset('mine', '我的风格'));
  await loadPresets();
});

function mountBar(agentId: string) {
  return mount(AgentPresetBar, { props: { agentId }, attachTo: document.body });
}

describe('AgentPresetBar —— 预设型 Agent 的分组下拉', () => {
  it('分组：默认（恰好一项「默认 · 名称」）/ 内容包 / 我的预设；story 没有引擎内置', () => {
    const w = mountBar('story');
    const groups = w.findAll('optgroup').map((g) => g.attributes('label'));
    expect(groups).toEqual(['默认', '内容包', '我的预设']);
    const defaults = w.findAll('optgroup')[0].findAll('option');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].text()).toBe('默认 · 内容默认');
    expect(defaults[0].attributes('value')).toBe('');
    // 出厂文件的预设算内容包，不算「我的预设」
    expect(w.findAll('optgroup')[1].text()).toContain('内容备选');
    expect(w.findAll('optgroup')[2].text()).toContain('我的风格');
    // 没装内容包时来源角标不说「内容包」（测试环境是公开仓占位态）
    expect(w.find('[data-testid="preset-origin"]').text()).toBe('占位内容');
  });

  it('装了内容包时来源角标是「内容包」', () => {
    mockContent.contentStatus = 'pack';
    mockContent.activePackId = 'fixture';
    const w = mountBar('story');
    expect(w.find('[data-testid="preset-origin"]').text()).toBe('内容包');
  });

  it('选「默认」那一项存空串（跟随默认），选别的存 id', async () => {
    const w = mountBar('story');
    const select = w.find('[data-testid="preset-select"]');
    await select.setValue('mine');
    expect(mockSettings.activePresetId).toBe('mine');
    expect(w.find('[data-testid="preset-origin"]').text()).toBe('我的');
    await select.setValue('');
    expect(mockSettings.activePresetId).toBe('');
  });

  it('直出：内容包自带默认时引擎内置单列一组，仍可选', async () => {
    mockStore.projectAgentDefaults = {
      agents: {
        direct_main: {
          presetId: 'pack-direct',
          preset: preset('pack-direct', '内容直出', { scope: 'direct' }),
        },
      },
    };
    const w = mountBar('direct_main');
    const labels = w.findAll('optgroup').map((g) => g.attributes('label'));
    expect(labels).toContain('引擎内置');
    await w.find('[data-testid="preset-select"]').setValue(DIRECT_PRESET_ID);
    expect(mockSettings.directPresetId).toBe(DIRECT_PRESET_ID);
    expect(w.find('[data-testid="preset-origin"]').text()).toBe('引擎内置');
  });

  it('原先选的预设已不存在：给出一行提示，「恢复默认」可点并清掉选择', async () => {
    mockSettings.activePresetId = 'gone';
    const w = mountBar('story');
    expect(w.find('[data-testid="preset-stale"]').text()).toBe(
      '原先选择的预设已不存在，现使用默认预设',
    );
    const restore = w.find('[data-testid="preset-restore"]');
    expect(restore.attributes('disabled')).toBeUndefined();
    await restore.trigger('click');
    expect(mockSettings.activePresetId).toBe('');
    expect(w.find('[data-testid="preset-stale"]').exists()).toBe(false);
  });

  it('已经跟随默认时「恢复默认」不可点；只读预设没有重命名 / 删除', () => {
    const w = mountBar('story');
    expect(w.find('[data-testid="preset-restore"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-testid="preset-rename"]').exists()).toBe(false);
    expect(w.find('[data-testid="preset-delete"]').exists()).toBe(false);
  });

  it('🔴 删除玩家预设必须先确认：点「删除」只开弹窗，确认后才删并回到默认', async () => {
    mockSettings.activePresetId = 'mine';
    const w = mountBar('story');
    await w.find('[data-testid="preset-delete"]').trigger('click');
    await flushPromises();
    expect(await getDatabase().presets.get('mine')).toBeDefined();
    const confirm = document.body.querySelector(
      '[data-testid="delete-confirm"]',
    ) as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();
    confirm!.click();
    // fake-indexeddb 走宏任务：等删除与选择回写都落地
    await vi.waitFor(() => expect(mockSettings.activePresetId).toBe(''));
    expect(await getDatabase().presets.get('mine')).toBeUndefined();
  });

  it('S-16：删掉正在用的预设后，提示里说出改用了哪条默认预设', async () => {
    const { useUIStore } = await import('../../../../../src/ui/stores/ui-store');
    const toast = vi.spyOn(useUIStore(), 'toast');
    mockSettings.activePresetId = 'mine';
    const w = mountBar('story');
    await w.find('[data-testid="preset-delete"]').trigger('click');
    await flushPromises();
    (document.body.querySelector('[data-testid="delete-confirm"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('预设已删除，已改用默认预设「内容默认」', 'info'),
    );
  });
});

describe('contentSourceLabel —— 默认内容从哪来', () => {
  it('内容包 / 开发叠加目录没装包 = 本地内容 / 公开仓 = 占位内容', () => {
    expect(contentSourceLabel({ packActive: true, localContentDir: true })).toBe('内容包');
    expect(contentSourceLabel({ packActive: true, localContentDir: false })).toBe('内容包');
    expect(contentSourceLabel({ packActive: false, localContentDir: true })).toBe('本地内容');
    expect(contentSourceLabel({ packActive: false, localContentDir: false })).toBe('占位内容');
  });
});

describe('AgentPresetBar —— 非预设 Agent 的状态行', () => {
  it('没有提示词覆写：默认（占位内容）/ 装了内容包时为默认（内容包）', async () => {
    const w = mountBar('entity_gen');
    expect(w.find('select').exists()).toBe(false);
    expect(w.find('[data-testid="prompt-state"]').text()).toBe('默认（占位内容）');
    mockContent.contentStatus = 'pack';
    mockContent.activePackId = 'fixture';
    await flushPromises();
    expect(w.find('[data-testid="prompt-state"]').text()).toBe('默认（内容包）');
    expect(w.find('[data-testid="preset-restore"]').attributes('disabled')).toBeDefined();
  });

  it('只数 systemPrompt / 上下文模板两项；模型等其他覆写不算', () => {
    mockSettings.agents.entity_gen = { model: 'pool-1', temperature: 0.2, systemPrompt: 'x' };
    const w = mountBar('entity_gen');
    expect(w.find('[data-testid="prompt-state"]').text()).toBe('我的自定义（已改 1 处）');
  });

  it('「恢复默认」交给宿主执行（emit reset-prompt），本组件不碰设置', async () => {
    mockSettings.agents.entity_gen = { systemPrompt: 'x', template: 'y' };
    const w = mountBar('entity_gen');
    expect(w.find('[data-testid="prompt-state"]').text()).toBe('我的自定义（已改 2 处）');
    await w.find('[data-testid="preset-restore"]').trigger('click');
    expect(w.emitted('reset-prompt')).toHaveLength(1);
    expect(mockSettings.agents.entity_gen).toEqual({ systemPrompt: 'x', template: 'y' });
  });
});
