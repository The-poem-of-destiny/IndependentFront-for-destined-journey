/**
 * PresetManager.vue —— 生效总览、逐条 token 与互斥组（2026-11-21）
 *
 * 守这几条：
 *   1. 列表顶部显示「已启用 X/Y · 约 N tokens」，与引擎 `summarizePresetEntries` 同一份数；
 *   2. 每条显示 `≈N tokens`，未启用的显示「启用后」的估算并弱化；定义变量的条目挂「定义 {{名}}」；
 *   3. 互斥组成员从平铺列表收走，放进顶部组块，用 PresetKnobGroup 单选；
 *   4. 只读预设上选组内一项只写覆写层，不复制；
 *   5. 组内条目仍可展开、编辑文本（编辑走写时复制）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentPreset, ChatPreset } from '@engine/types/types';
import { summarizePresetEntries } from '@engine/prompts/preset-insight';

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
import PresetKnobGroup from '../../../../../src/ui/components/shared/PresetKnobGroup.vue';
import { registerFactoryPresetIds } from '../../../../../src/ui/composables/usePresets';
import { getDatabase, savePreset } from '../../../../../src/core/persistence/database';

const PACK: ChatPreset = {
  id: 'pack-groups',
  name: '人称预设',
  settings: {
    prompts: [
      {
        identifier: 'main',
        name: '主提示',
        content: '用{{getvar::人称}}叙述这一段故事。',
        role: 'system',
        enabled: true,
        injection_order: 10,
      },
      {
        identifier: 'p1',
        name: '第一人称',
        content: '{{setvar::人称::第一人称}}',
        role: 'system',
        enabled: true,
        injection_order: 20,
      },
      {
        identifier: 'p2',
        name: '第二人称',
        content: '{{setvar::人称::第二人称}}',
        role: 'system',
        enabled: false,
        injection_order: 30,
      },
      {
        identifier: 'p3',
        name: '第三人称',
        content: '{{setvar::人称::第三人称}}',
        role: 'system',
        enabled: false,
        injection_order: 40,
      },
      {
        identifier: 'extra',
        name: '附加说明',
        content: '这一条默认关闭，启用后会多出一些说明文字。',
        role: 'system',
        enabled: false,
        injection_order: 50,
      },
    ],
    extensions: {
      poem: {
        groups: [
          {
            id: 'person',
            label: '叙事人称',
            options: [
              { identifier: 'p1', label: '第一人称' },
              { identifier: 'p2', label: '第二人称' },
              { identifier: 'p3', label: '第三人称' },
            ],
          },
        ],
      },
    },
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

async function mountManager() {
  const w = mount(PresetManager, { props: { agentId: 'story' } });
  await flushPromises();
  return w;
}

function flatIdentifiers(w: Awaited<ReturnType<typeof mountManager>>): string[] {
  return (
    w
      .findAll('.preset-flat-list .subprompt-item')
      .map((row) => row.attributes('data-identifier') ?? '')
      // 五区占位条目由 UI 读取视图补齐，与本测试无关
      .filter((id) => !id.startsWith('story_zone_'))
  );
}

describe('PresetManager —— 生效总览与逐条 token', () => {
  it('顶部总览与引擎 summarizePresetEntries 同一份数', async () => {
    const expected = summarizePresetEntries(PACK as unknown as AgentPreset);
    const w = await mountManager();
    expect(w.find('[data-testid="preset-summary"]').text()).toBe(
      `已启用 ${expected.activeCount}/${expected.totalCount} · 约 ${expected.totalTokens} tokens`,
    );
  });

  it('未启用条目显示启用后的估算并弱化；已启用的按当前计入', async () => {
    const insight = summarizePresetEntries(PACK as unknown as AgentPreset).entries;
    const extra = insight.find((e) => e.identifier === 'extra')!;
    const main = insight.find((e) => e.identifier === 'main')!;
    expect(extra.active).toBe(false);
    expect(extra.tokensIfEnabled).toBeGreaterThan(0);

    const w = await mountManager();
    const extraTokens = w.find('[data-identifier="extra"] [data-testid="entry-tokens"]');
    expect(extraTokens.text()).toBe(`≈${extra.tokensIfEnabled} tokens`);
    expect(extraTokens.classes()).toContain('is-inactive');

    const mainTokens = w.find('[data-identifier="main"] [data-testid="entry-tokens"]');
    expect(mainTokens.text()).toBe(`≈${main.tokens} tokens`);
    expect(mainTokens.classes()).not.toContain('is-inactive');
  });

  it('定义变量的条目挂「定义 {{人称}}」标签', async () => {
    const w = await mountManager();
    const p1 = w.find('[data-identifier="p1"]');
    expect(p1.find('[data-testid="entry-defines"]').text()).toBe('定义 {{人称}}');
    expect(w.find('[data-identifier="main"] [data-testid="entry-defines"]').exists()).toBe(false);
  });
});

describe('PresetManager —— 定义标签不撑破标题行', () => {
  it('定义很多变量时只显示 2 个标签 + 「+N」，title 与展开后列出全部', async () => {
    const names = Array.from({ length: 58 }, (_, i) => `变量${i + 1}`);
    const macro: ChatPreset = JSON.parse(JSON.stringify(PACK));
    (macro.settings.prompts as any[])[0].content = names
      .map((n) => `{{setvar::${n}::值}}`)
      .join('');
    await getDatabase().presets.clear();
    await savePreset(macro);
    mockStore.projectAgentDefaults = { agents: { story: { presetId: macro.id, preset: macro } } };

    const w = await mountManager();
    const row = w.find('[data-identifier="main"]');
    const chips = row.findAll('[data-testid="entry-defines"]');
    expect(chips.map((c) => c.text())).toEqual(['定义 {{变量1}}', '定义 {{变量2}}']);
    const more = row.find('[data-testid="entry-defines-more"]');
    expect(more.text()).toBe('+56');
    expect(more.attributes('title')).toContain('共定义 58 个变量');
    expect(more.attributes('title')).toContain('{{变量58}}');
    // 右侧 token 与操作按钮仍在
    expect(row.find('[data-testid="entry-tokens"]').exists()).toBe(true);

    expect(row.find('[data-testid="entry-defines-all"]').exists()).toBe(false);
    await row.find('[data-testid="entry-expand"]').trigger('click');
    const all = w.find('[data-identifier="main"] [data-testid="entry-defines-all"]');
    expect(all.text()).toContain('定义 58 个变量');
    expect(all.text()).toContain('{{变量58}}');
  });

  it('只定义 1 个变量时不出「+N」', async () => {
    const w = await mountManager();
    expect(w.find('[data-identifier="p1"] [data-testid="entry-defines-more"]').exists()).toBe(
      false,
    );
  });

  it('🔴 展开区恒列变量全量与说明小字（窄宽下标题行会把它们隐藏）', async () => {
    const w = await mountManager();
    const row = w.find('[data-identifier="p1"]');
    await row.find('[data-testid="entry-expand"]').trigger('click');
    const all = w.find('[data-identifier="p1"] [data-testid="entry-defines-all"]');
    expect(all.text()).toContain('定义 1 个变量');
    expect(all.text()).toContain('{{人称}}');
    // 标题行的小字在展开区有全文版
    const notesInHeader = w.findAll('[data-identifier="p1"] .subprompt-note').map((n) => n.text());
    const notesAll = w.find('[data-identifier="p1"] [data-testid="entry-notes-all"]');
    expect(notesAll.exists()).toBe(notesInHeader.length > 0);
  });

  it('标题行左区裁剪、右侧 meta 不收缩（样式源码断言）', async () => {
    const source = (await import('@ui/components/settings/agent/PresetManager.vue?raw'))
      .default as string;
    expect(source).toMatch(/\.subprompt-info \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
    expect(source).toMatch(/\.subprompt-meta \{[^}]*flex-shrink: 0;/);
  });
});

describe('PresetManager —— 互斥组', () => {
  it('组成员从平铺列表收走，放进顶部组块，用 PresetKnobGroup 展示', async () => {
    const w = await mountManager();
    expect(flatIdentifiers(w)).toEqual(['main', 'extra']);

    const block = w.find('[data-testid="preset-group-person"]');
    expect(block.exists()).toBe(true);
    // 组块排在平铺列表之前
    const blocks = w.findAll('.preset-group-block, .preset-flat-list');
    expect(blocks[0].attributes('data-testid')).toBe('preset-group-person');

    const knob = w.findComponent(PresetKnobGroup);
    expect(knob.props('label')).toBe('叙事人称');
    expect(knob.props('status')).toBe('ok');
    expect(knob.props('selected')).toBe('p1');
    expect(knob.props('options').map((o: { id: string }) => o.id)).toEqual(['p1', 'p2', 'p3']);

    // 组内成员没有自己的开关
    expect(block.findAll('.subprompt-item').length).toBe(3);
    expect(block.find('.subprompt-toggle').exists()).toBe(false);
  });

  it('🔴 只读预设：选组内另一项只写覆写层，不复制', async () => {
    const w = await mountManager();
    const radios = w.findAll('[data-testid="preset-group-person"] input[type="radio"]');
    await radios[1].setValue(true);
    // 组选择整组钉住：p3 与原始行相同也留在覆写层；「已调整」仍只数实际差异
    await vi.waitFor(() =>
      expect(mockSettings.presetEntryToggles?.[PACK.id]).toEqual({
        p1: false,
        p2: true,
        p3: false,
      }),
    );
    await flushPromises();

    expect(await getDatabase().presets.count()).toBe(1);
    expect((await getDatabase().presets.get(PACK.id))!).toEqual(PACK);
    expect(mockSettings.activePresetId).toBe('');

    expect(w.findComponent(PresetKnobGroup).props('selected')).toBe('p2');
    expect(w.find('[data-testid="preset-reset-toggles"]').text()).toContain('已调整 2 项');
  });

  describe('写入失败', () => {
    // 玩家预设：组选择直接改行，走 Dexie
    beforeEach(async () => {
      await savePreset({ ...JSON.parse(JSON.stringify(PACK)), id: 'mine', name: '我的人称' });
      mockSettings.activePresetId = 'mine';
    });

    it('🔴 玩家预设上选组内另一项、Dexie 写入失败：报错，单选回到真实选中项，焦点交给新单选', async () => {
      const { useUIStore } = await import('../../../../../src/ui/stores/ui-store');
      const toast = vi.spyOn(useUIStore(), 'toast');
      const put = vi
        .spyOn(getDatabase().presets, 'put')
        .mockRejectedValue(new Error('Dexie 写入失败'));
      try {
        const w = mount(PresetManager, { props: { agentId: 'story' }, attachTo: document.body });
        await flushPromises();
        const radios = () =>
          w.findAll<HTMLInputElement>('[data-testid="preset-group-person"] input[type="radio"]');
        const old = radios()[1].element;
        old.focus();
        old.click();
        expect(old.checked).toBe(true);
        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith('开关保存失败，请稍后重试', 'error'),
        );
        await flushPromises();
        expect(radios()[0].element.checked).toBe(true);
        expect(radios()[1].element.checked).toBe(false);
        // 重挂换了新元素，焦点跟过去，没有掉到 body
        expect(radios()[1].element).not.toBe(old);
        expect(document.activeElement).toBe(radios()[1].element);
        expect((await getDatabase().presets.get('mine'))!.settings).toEqual(PACK.settings);
      } finally {
        put.mockRestore();
      }
    });

    it('条目行开关写入失败：勾选不翻（点击被取消），仍报错', async () => {
      const { useUIStore } = await import('../../../../../src/ui/stores/ui-store');
      const toast = vi.spyOn(useUIStore(), 'toast');
      const put = vi
        .spyOn(getDatabase().presets, 'put')
        .mockRejectedValue(new Error('Dexie 写入失败'));
      try {
        const w = mount(PresetManager, { props: { agentId: 'story' }, attachTo: document.body });
        await flushPromises();
        const input = () =>
          w.find<HTMLInputElement>('[data-identifier="extra"] .subprompt-toggle input').element;
        expect(input().checked).toBe(false);
        input().click();
        expect(input().checked).toBe(false);
        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith('开关保存失败，请稍后重试', 'error'),
        );
        await flushPromises();
        expect(input().checked).toBe(false);
      } finally {
        put.mockRestore();
      }
    });
  });

  it('组内条目仍可展开查看、编辑文本（编辑走写时复制）', async () => {
    const w = await mountManager();
    const row = w.find('[data-identifier="p2"]');
    const expand = row.find('[data-testid="entry-expand"]');
    expect(expand.attributes('aria-expanded')).toBe('false');
    await expand.trigger('click');
    expect(w.find('[data-identifier="p2"] .subprompt-content').text()).toContain('第二人称');
    expect(
      w.find('[data-identifier="p2"] [data-testid="entry-expand"]').attributes('aria-expanded'),
    ).toBe('true');

    await w.find('[data-identifier="p2"] [data-testid="entry-edit"]').trigger('click');
    await flushPromises();
    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea.prompt-editor');
    expect(textarea?.value).toBe('{{setvar::人称::第二人称}}');
  });

  it('新写的按钮都有 aria-label', async () => {
    const w = await mountManager();
    for (const btn of w.findAll('.subprompt-item button')) {
      expect(btn.attributes('aria-label')).toBeTruthy();
    }
    for (const input of w.findAll('.subprompt-toggle input')) {
      expect(input.attributes('aria-label')).toMatch(/^启用「/);
    }
  });
});
