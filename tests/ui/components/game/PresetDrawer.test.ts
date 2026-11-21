/**
 * PresetDrawer —— 游戏内「预设」抽屉（2026-11-21）
 *
 * - 生成方式 → profile 映射（agent/direct/direct_cached）；
 * - 名称 + 来源角标、生效总览、互斥组、全部条目（默认折叠、五区占位锁定）、已调整 / 恢复；
 * - 提示文案（缓存直出另注重建缓存）；
 * - 页脚去设置：先过离开确认，再写 activeAgent、关抽屉、开 Agent 分区；
 * - a11y：role=dialog / aria-modal / aria-labelledby，Esc 与点遮罩都能关，焦点回到打开它的按钮。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, toValue, type MaybeRefOrGetter } from 'vue';
import type { PresetProfile } from '@engine/prompts/preset-resolution';

const state = vi.hoisted(() => ({
  profiles: [] as string[],
  generationMode: 'agent' as string,
  adjustedCount: 0,
  origin: 'content' as 'content' | 'builtin' | 'user',
  confirm: true,
  /** 追加到生效总览里的逐条估算（老式无 identifier 条目用） */
  extraInsights: [] as Record<string, unknown>[],
}));

const actions = vi.hoisted(() => ({
  toggleEntry: vi.fn(async () => {}),
  selectOption: vi.fn(async () => true),
  resetToggles: vi.fn(),
  closeModal: vi.fn(),
  openSettings: vi.fn(),
  toast: vi.fn(),
  confirmLeaveGame: vi.fn(async () => true),
  loadPresets: vi.fn(async () => []),
}));

const settingsBag = vi.hoisted(() => ({ activeAgent: null as string | null }));

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({
    get generationMode() {
      return state.generationMode;
    },
    closeModal: actions.closeModal,
  }),
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ openSettings: actions.openSettings, toast: actions.toast }),
}));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: settingsBag }),
}));
vi.mock('../../../../src/ui/stores/content-store', () => ({
  useContentStore: () => ({ contentStatus: 'pack', activePackId: 'p1' }),
}));
vi.mock('../../../../src/ui/lib/leave-game-guard', () => ({
  confirmLeaveGame: actions.confirmLeaveGame,
}));

const PRESET = {
  id: 'p-story',
  name: '叙事预设',
  settings: {
    prompts: [
      { identifier: 'a', name: '第一人称', content: 'x', enabled: true, injection_order: 10 },
      { identifier: 'b', name: '第三人称', content: 'y', enabled: false, injection_order: 20 },
      { identifier: 'story_zone_1', name: '一区', injection_order: 30 },
      { identifier: 'c', name: '附加说明', content: 'z', enabled: false, injection_order: 40 },
    ],
  },
};

vi.mock('../../../../src/ui/composables/usePresets', () => ({
  usePresets: () => ({
    catalog: computed(() => [{ preset: PRESET, origin: state.origin }]),
    loadPresets: actions.loadPresets,
  }),
}));

vi.mock('../../../../src/ui/composables/usePresetKnobs', () => ({
  usePresetKnobs: (profile: MaybeRefOrGetter<PresetProfile>) => {
    state.profiles.push(toValue(profile));
    return {
      presetId: computed(() => PRESET.id),
      preset: computed(() => PRESET),
      readonly: computed(() => true),
      groups: computed(() => [
        {
          group: {
            id: 'pov',
            label: '叙事人称',
            allowNone: false,
            options: [
              { identifier: 'a', label: '第一人称' },
              { identifier: 'b', label: '第三人称' },
            ],
          },
          state: { status: 'ok', selected: 'a' },
        },
      ]),
      summary: computed(() => ({
        entries: [
          {
            identifier: 'a',
            name: '第一人称',
            active: true,
            inactiveReason: null,
            tokens: 12,
            tokensIfEnabled: 12,
          },
          {
            identifier: 'b',
            name: '第三人称',
            active: false,
            inactiveReason: 'disabled',
            tokens: 0,
            tokensIfEnabled: 34,
          },
          {
            identifier: 'c',
            name: '附加说明',
            active: false,
            inactiveReason: 'disabled',
            tokens: 0,
            tokensIfEnabled: 56,
          },
          ...state.extraInsights,
        ],
        activeCount: 1,
        totalCount: 2,
        totalTokens: 12,
      })),
      adjustedCount: computed(() => state.adjustedCount),
      selectOption: actions.selectOption,
      toggleEntry: actions.toggleEntry,
      resetToggles: actions.resetToggles,
    };
  },
}));

import PresetDrawer from '../../../../src/ui/components/game/PresetDrawer.vue';

/** 宿主：一颗打开按钮 + 抽屉，模拟侧栏按钮 → activeModal 的回路 */
function mountHost(initialOpen = false) {
  const open = ref(initialOpen);
  const Host = defineComponent({
    setup() {
      return () =>
        h('div', [
          h('button', { id: 'opener', onClick: () => (open.value = true) }, '预设'),
          h(PresetDrawer, { open: open.value, onClose: () => (open.value = false) }),
        ]);
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, open };
}

// 断言中途失败时也要卸载：否则残留的抽屉留在 modal-focus 栈里，连累后面的焦点用例
enableAutoUnmount(afterEach);

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(() => {
  state.profiles = [];
  state.generationMode = 'agent';
  state.adjustedCount = 0;
  state.origin = 'content';
  state.extraInsights = [];
  settingsBag.activeAgent = null;
  Object.values(actions).forEach((fn) => fn.mockClear());
  actions.confirmLeaveGame.mockImplementation(async () => true);
  actions.toggleEntry.mockImplementation(async () => {});
  actions.selectOption.mockImplementation(async () => true);
});

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('PresetDrawer 生成方式映射', () => {
  it.each([
    ['agent', 'story'],
    ['direct', 'direct'],
    ['direct_cached', 'direct_cached'],
  ])('%s → profile %s', (mode, profile) => {
    state.generationMode = mode;
    const { wrapper } = mountHost();
    expect(state.profiles).toEqual([profile]);
    wrapper.unmount();
  });
});

describe('PresetDrawer 内容', () => {
  it('关着时不渲染，打开后显示名称、来源角标与生效总览，并重读预设', async () => {
    const { wrapper, open } = mountHost();
    expect(dialog()).toBeNull();
    open.value = true;
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[data-testid="preset-drawer-name"]')?.textContent).toBe(
      '叙事预设',
    );
    expect(document.querySelector('[data-testid="preset-drawer-origin"]')?.textContent).toBe(
      '内容包',
    );
    expect(
      document
        .querySelector('[data-testid="preset-drawer-summary"]')
        ?.textContent?.replace(/\s+/g, ' '),
    ).toContain('已启用 1/2 · 约 12 tokens');
    expect(actions.loadPresets).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('互斥组用 PresetKnobGroup 渲染，选项带 ≈tokensIfEnabled，选中即调 selectOption', async () => {
    const { wrapper } = mountHost(true);
    await flushPromises();
    const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);
    expect(document.body.textContent).toContain('≈34 tokens');
    radios[1].dispatchEvent(new Event('change'));
    await flushPromises();
    expect(actions.selectOption).toHaveBeenCalledWith('pov', 'b');
    wrapper.unmount();
  });

  it('全部条目默认折叠；展开后五区占位锁定，非组成员可拨', async () => {
    const { wrapper } = mountHost(true);
    await flushPromises();
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="preset-drawer-entries-toggle"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.pd-entry-list')).toBeNull();

    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = document.querySelectorAll('.pd-entry');
    expect([...rows].map((r) => r.getAttribute('data-entry'))).toEqual([
      'a',
      'b',
      'story_zone_1',
      'c',
    ]);

    const zoneSwitch = document.querySelector<HTMLInputElement>(
      '[data-entry="story_zone_1"] input',
    )!;
    expect(zoneSwitch.disabled).toBe(true);
    expect(zoneSwitch.checked).toBe(true);

    const cSwitch = document.querySelector<HTMLInputElement>('[data-entry="c"] input')!;
    expect(cSwitch.checked).toBe(false);
    expect(cSwitch.getAttribute('role')).toBe('switch');
    expect(document.querySelector('[data-entry="c"]')?.textContent).toContain('≈56');
    cSwitch.dispatchEvent(new Event('change'));
    await flushPromises();
    expect(actions.toggleEntry).toHaveBeenCalledWith('c');
    expect(actions.toggleEntry).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('🔴 互斥组成员在「全部条目」里没有独立开关，只标「由「组名」控制」', async () => {
    const { wrapper } = mountHost(true);
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-entries-toggle"]')!
      .click();
    await flushPromises();
    for (const id of ['a', 'b']) {
      const row = document.querySelector(`[data-entry="${id}"]`)!;
      expect(row.querySelector('input')).toBeNull();
      expect(row.querySelector('[data-testid="preset-drawer-entry-group"]')?.textContent).toBe(
        '由「叙事人称」控制',
      );
    }
    // token 仍照常显示
    expect(document.querySelector('[data-entry="b"]')?.textContent).toContain('≈34');
    expect(actions.toggleEntry).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('🔴 条目开关写入失败：报错提示，复选框回到真实状态', async () => {
    actions.toggleEntry.mockImplementation(async () => {
      throw new Error('Dexie 写入失败');
    });
    const { wrapper } = mountHost(true);
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-entries-toggle"]')!
      .click();
    await flushPromises();
    const cSwitch = () => document.querySelector<HTMLInputElement>('[data-entry="c"] input')!;
    cSwitch().click();
    expect(cSwitch().checked).toBe(true);
    await flushPromises();
    expect(actions.toggleEntry).toHaveBeenCalledWith('c');
    expect(actions.toast).toHaveBeenCalledWith('开关保存失败，请稍后重试', 'error');
    expect(cSwitch().checked).toBe(false);
    wrapper.unmount();
  });

  it('🔴 互斥组选择写入失败：报错提示，单选回到原来的选中项', async () => {
    actions.selectOption.mockImplementation(async () => {
      throw new Error('Dexie 写入失败');
    });
    const { wrapper } = mountHost(true);
    await flushPromises();
    const radios = () => document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    radios()[1].click();
    expect(radios()[1].checked).toBe(true);
    await flushPromises();
    expect(actions.selectOption).toHaveBeenCalledWith('pov', 'b');
    expect(actions.toast).toHaveBeenCalledWith('开关保存失败，请稍后重试', 'error');
    expect(radios()[0].checked).toBe(true);
    expect(radios()[1].checked).toBe(false);
    wrapper.unmount();
  });

  it('🔴 没有 identifier 的老式条目只读显示：不渲染开关，标注去设置中编辑', async () => {
    PRESET.settings.prompts.push({
      name: '旧式条目',
      content: 'w',
      enabled: true,
      injection_order: 50,
    } as (typeof PRESET.settings.prompts)[number]);
    state.extraInsights = [
      {
        identifier: '',
        name: '旧式条目',
        active: true,
        inactiveReason: null,
        tokens: 7,
        tokensIfEnabled: 7,
      },
    ];
    try {
      const { wrapper } = mountHost(true);
      await flushPromises();
      document
        .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-entries-toggle"]')!
        .click();
      await flushPromises();
      const row = [...document.querySelectorAll<HTMLElement>('.pd-entry')].find((r) =>
        r.textContent?.includes('旧式条目'),
      )!;
      expect(row).toBeDefined();
      expect(row.querySelector('input')).toBeNull();
      expect(
        row.querySelector('[data-testid="preset-drawer-entry-readonly"]')?.textContent,
      ).toContain('请在设置中编辑');
      row.click();
      await flushPromises();
      expect(actions.toggleEntry).not.toHaveBeenCalled();
      wrapper.unmount();
    } finally {
      PRESET.settings.prompts.pop();
    }
  });

  it('🔴 多条无 identifier 条目不共用一份估算：都不显示 token；assistant 条目不列', async () => {
    const extra = [
      { name: '旧式甲', content: 'w'.repeat(300), enabled: true, injection_order: 50 },
      { name: '旧式乙', content: 'v', enabled: false, injection_order: 60 },
      { name: '旧式助手', content: 'u', enabled: true, injection_order: 70, role: 'assistant' },
    ] as (typeof PRESET.settings.prompts)[number][];
    PRESET.settings.prompts.push(...extra);
    state.extraInsights = [
      {
        identifier: '',
        name: '旧式乙',
        active: false,
        inactiveReason: 'disabled',
        tokens: 0,
        tokensIfEnabled: 1,
      },
    ];
    try {
      const { wrapper } = mountHost(true);
      await flushPromises();
      document
        .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-entries-toggle"]')!
        .click();
      await flushPromises();
      const rows = [...document.querySelectorAll<HTMLElement>('.pd-entry')];
      const jia = rows.find((r) => r.textContent?.includes('旧式甲'))!;
      const yi = rows.find((r) => r.textContent?.includes('旧式乙'))!;
      expect(jia).toBeDefined();
      expect(yi).toBeDefined();
      expect(jia.querySelector('.pd-entry-tokens')).toBeNull();
      expect(yi.querySelector('.pd-entry-tokens')).toBeNull();
      expect(rows.some((r) => r.textContent?.includes('旧式助手'))).toBe(false);
      wrapper.unmount();
    } finally {
      PRESET.settings.prompts.splice(-extra.length, extra.length);
    }
  });

  it('🔴 条目开关写入失败重挂后，键盘焦点回到新的那颗开关', async () => {
    actions.toggleEntry.mockImplementation(async () => {
      throw new Error('Dexie 写入失败');
    });
    const { wrapper } = mountHost(true);
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-entries-toggle"]')!
      .click();
    await flushPromises();
    const old = document.querySelector<HTMLInputElement>('[data-entry="c"] input')!;
    old.focus();
    old.click();
    await flushPromises();
    const fresh = document.querySelector<HTMLInputElement>('[data-entry="c"] input')!;
    expect(fresh).not.toBe(old);
    expect(document.activeElement).toBe(fresh);
    wrapper.unmount();
  });

  it('🔴 互斥组写入失败重挂后，键盘焦点回到新组块里对应的单选', async () => {
    actions.selectOption.mockImplementation(async () => {
      throw new Error('Dexie 写入失败');
    });
    const { wrapper } = mountHost(true);
    await flushPromises();
    const old = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    old.focus();
    old.click();
    await flushPromises();
    const fresh = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    expect(fresh).not.toBe(old);
    expect(fresh.value).toBe('b');
    expect(document.activeElement).toBe(fresh);
    wrapper.unmount();
  });

  it('写入失败时焦点已移到抽屉里别处（未被重挂）：不抢焦点', async () => {
    actions.selectOption.mockImplementation(async () => {
      throw new Error('Dexie 写入失败');
    });
    const { wrapper } = mountHost(true);
    await flushPromises();
    const closeBtn = document.querySelector<HTMLButtonElement>('.pd-close')!;
    const radio = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    radio.dispatchEvent(new Event('change'));
    closeBtn.focus();
    await flushPromises();
    expect(actions.toast).toHaveBeenCalled();
    expect(document.activeElement).toBe(closeBtn);
    wrapper.unmount();
  });

  it('有调整时显示「已调整 N 项」，恢复调 resetToggles；没调整时不显示', async () => {
    const first = mountHost(true);
    await flushPromises();
    expect(document.querySelector('[data-testid="preset-drawer-adjusted"]')).toBeNull();
    first.wrapper.unmount();

    state.adjustedCount = 3;
    const { wrapper } = mountHost(true);
    await flushPromises();
    const adjusted = document.querySelector('[data-testid="preset-drawer-adjusted"]')!;
    expect(adjusted.textContent).toContain('已调整 3 项');
    adjusted.querySelector('button')!.click();
    expect(actions.resetToggles).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('提示文案：默认只说下一回合生效；缓存直出另注重建缓存', async () => {
    const first = mountHost(true);
    await flushPromises();
    const hint = () => document.querySelector('[data-testid="preset-drawer-hint"]')?.textContent;
    expect(hint()).toContain('改动下一回合生效');
    expect(hint()).not.toContain('重建一次缓存');
    first.wrapper.unmount();

    state.generationMode = 'direct_cached';
    const { wrapper } = mountHost(true);
    await flushPromises();
    expect(hint()).toContain('改动下一回合生效');
    expect(hint()).toContain('会重建一次缓存');
    wrapper.unmount();
  });
});

describe('PresetDrawer 去设置', () => {
  it.each([
    ['agent', 'story'],
    ['direct', 'direct_main'],
    ['direct_cached', 'direct_cached'],
  ])('%s：确认后写 activeAgent=%s、关抽屉、开 Agent 分区', async (mode, agentId) => {
    state.generationMode = mode;
    const { wrapper, open } = mountHost(true);
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-open-settings"]')!
      .click();
    await flushPromises();
    expect(actions.confirmLeaveGame).toHaveBeenCalledWith('设置');
    expect(settingsBag.activeAgent).toBe(agentId);
    expect(open.value).toBe(false);
    expect(actions.openSettings).toHaveBeenCalledWith('agent');
    wrapper.unmount();
  });

  it('离开确认被取消时什么都不改', async () => {
    actions.confirmLeaveGame.mockImplementation(async () => false);
    const { wrapper, open } = mountHost(true);
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="preset-drawer-open-settings"]')!
      .click();
    await flushPromises();
    expect(settingsBag.activeAgent).toBeNull();
    expect(open.value).toBe(true);
    expect(actions.openSettings).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('PresetDrawer a11y', () => {
  it('role=dialog + aria-modal + aria-labelledby 指向标题', async () => {
    const { wrapper } = mountHost(true);
    await flushPromises();
    const el = dialog()!;
    expect(el.getAttribute('aria-modal')).toBe('true');
    const labelledBy = el.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('预设');
    wrapper.unmount();
  });

  it('Esc 关掉，焦点回到打开它的按钮', async () => {
    const { wrapper, open } = mountHost();
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    opener.click();
    await flushPromises();
    expect(dialog()!.contains(document.activeElement)).toBe(true);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(open.value).toBe(false);
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
  });

  it('点遮罩关掉，点面板内部不关', async () => {
    const { wrapper, open } = mountHost(true);
    await flushPromises();
    dialog()!.click();
    expect(open.value).toBe(true);
    document.querySelector<HTMLElement>('[data-testid="preset-drawer-overlay"]')!.click();
    await flushPromises();
    expect(open.value).toBe(false);
    wrapper.unmount();
  });

  it('减动效下撤掉滑入动画（样式源码断言）', async () => {
    const source = (await import('../../../../src/ui/components/game/PresetDrawer.vue?raw'))
      .default as string;
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/);
    expect(source).toContain(":root[data-reduced-motion='true'] .preset-drawer-enter-active");
  });
});
