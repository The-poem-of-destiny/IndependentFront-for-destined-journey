/**
 * BeautifierSection.test.ts — 设置页输出美化分区回归测试
 *
 * 🔴 2026-08-08 真机复现的坑：设置页 onMounted **自己** `loadPresetRules()`（占位 5 条）
 *    然后整份覆盖 `beautifier.presetRules` —— 而 beautifier-store 里 pack 规则优先
 *    （22 条）。进一次设置页 → 22 条被打回 5 条、退出来所有美化都没了。
 *    修复：设置页不再自己算规则，纯只读 store 投影，规则源由 store 决定。
 *
 * 断言：
 * 1. onMounted 后 presetRules = pack 规则（22 条），不回落占位
 * 2. `loadPresetRules`（占位文件）**不被调用** —— 覆盖过就全没了
 * 3. store.presetRules 与设置页展示同源（同数组引用）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive, nextTick } from 'vue';
import type { BeautifierRule } from '@engine/types';

// ── 引擎层 mock：getPackRules 给 22 条 pack 规则；loadPresetRules 用哨兵（不该被调）──

const packRules = vi.hoisted(() => {
  const rules: BeautifierRule[] = [];
  for (let i = 1; i <= 22; i++) {
    rules.push({
      id: `pack-rule-${i}`,
      name: `规则${i}`,
      scope: 'maintext',
      pattern: `«${i}»`,
      flags: 'gm',
      replacement: `<span>${i}</span>`,
      enabled: i <= 2,
      order: i,
      isBuiltin: true,
      group: '测试组',
    });
  }
  return rules;
});

vi.mock('@engine/beautifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/beautifier')>();
  return {
    ...actual,
    // 占位文件加载 —— 修复后设置页不该再碰它
    loadPresetRules: vi.fn(async () => [
      {
        id: 'placeholder-1',
        name: '占位规则',
        scope: 'maintext',
        pattern: 'x',
        flags: 'g',
        replacement: 'y',
        enabled: true,
        order: 0,
        isBuiltin: true,
      },
    ]),
  };
});

// content-source：注册 22 条 pack provider（生产里由 hydratePackState 挂）
vi.mock('@engine/content-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/content-source')>();
  return {
    ...actual,
    getPackRules: vi.fn(() => packRules),
  };
});

// database：迁移标志位置位 → runLegacyMigration 早退；hydrate 只需 toArray
vi.mock('@engine/database', () => ({
  getDatabase: () => ({
    beautifierRules: {
      toArray: async () => [],
      bulkPut: async () => {},
      bulkGet: async () => [],
      clear: async () => {},
    },
    transaction: async (_mode: string, _table: unknown, fn: () => Promise<void>) => {
      await fn();
    },
  }),
}));

// game-store：只给 activeSave + characters
const mockGame = reactive({
  activeSave: null,
  characters: [],
});
vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));

// settings-store：给需要的最小表面
const mockSettings = reactive<Record<string, unknown>>({
  beautifierEnabled: true,
  beautifierBuiltinDisabled: [],
  beautifierRulesMigratedAt: true,
});
const saveNow = vi.fn();
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings, saveNow }),
}));

import BeautifierSection from './BeautifierSection.vue';
import { useBeautifierStore } from '../../stores/beautifier-store';
import { loadPresetRules } from '@engine/beautifier';

describe('BeautifierSection 预设规则加载', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (loadPresetRules as ReturnType<typeof vi.fn>).mockClear();
  });

  it('onMounted 后展示 pack 规则（22 条），不回落占位文件', async () => {
    const wrapper = mount(BeautifierSection, { attachTo: document.body });
    await flushPromises();
    await nextTick();

    const store = useBeautifierStore();
    expect(store.presetRules).toHaveLength(22);
    expect(store.presetRules[0]!.id).toBe('pack-rule-1');

    // 🔴 占位文件加载必须没被调用过 —— 调用过一次就说明覆盖路径复活了
    expect(loadPresetRules).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('设置页展示与 store 同源（同数组引用，无第二份副本）', async () => {
    const wrapper = mount(BeautifierSection, { attachTo: document.body });
    await flushPromises();
    await nextTick();

    const store = useBeautifierStore();
    expect(store.presetRules).toHaveLength(22);

    // 展开「可用规则库」让全部规则行渲染出来，再数 rule-name
    const libraryHeader = wrapper.find('.library-header');
    if (libraryHeader.exists()) {
      await libraryHeader.trigger('click');
      await nextTick();
    }
    const rendered = wrapper.findAll('.rule-name');
    expect(rendered.length).toBe(22);
    wrapper.unmount();
  });
});
