/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';

const confirmDialogMock = vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (o: ConfirmDialogOptions) => confirmDialogMock(o),
}));
import DeveloperSection from '../../../../src/ui/components/settings/DeveloperSection.vue';
import settingsPageSource from '../../../../src/ui/components/settings/SettingsPage.vue?raw';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';
import { useGameStore } from '../../../../src/ui/stores/game-store';
import { useUIStore } from '../../../../src/ui/stores/ui-store';

enableAutoUnmount(afterEach);

describe('DeveloperSection', () => {
  let settings: ReturnType<typeof useSettingsStore>;

  beforeEach(() => {
    localStorage.clear();
    confirmDialogMock.mockReset();
    confirmDialogMock.mockResolvedValue(true);
    setActivePinia(createPinia());
    settings = useSettingsStore();
  });

  afterEach(() => {
    settings.$dispose();
  });

  it('以关闭状态呈现，并通过无障碍 switch 写回设置', async () => {
    const wrapper = mount(DeveloperSection);
    const toggle = wrapper.get<HTMLInputElement>('input[aria-label="开发者模式"]');

    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.element.checked).toBe(false);
    expect(wrapper.text()).toContain('已关闭');

    await toggle.setValue(true);

    expect(settings.settings.developerMode).toBe(true);
    expect(wrapper.text()).toContain('已开启');
    expect(wrapper.get('.developer-mode-card').classes()).toContain('is-enabled');
  });

  it('关闭新模式时退出当前打开的测试档，并从返回历史里拿掉游戏页', async () => {
    const game = useGameStore();
    const ui = useUIStore();
    settings.settings.storyContextV2Enabled = true;
    game.saves = [
      {
        id: 'v2-save',
        name: '测试档',
        metadata: { storyContextV2: { schema: 1, markedAt: 1 } },
      } as never,
    ];
    game.activeSaveId = 'v2-save';
    ui.activeSaveId = 'v2-save';
    ui.viewHistory = ['home', 'game'];

    const wrapper = mount(DeveloperSection);
    await wrapper
      .get<HTMLInputElement>('input[aria-label="Story 上下文与记忆新模式"]')
      .setValue(false);
    await flushPromises();

    // 确认文案按当前情形说明：当前测试档会被退出、关闭期间测试档进不去
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    const opts = confirmDialogMock.mock.calls[0][0];
    expect(opts.danger).toBe(true);
    expect(opts.message).toContain('当前存档《测试档》是测试存档，关闭后会立即退出');
    expect(opts.message).toContain('关闭期间所有测试存档无法进入');

    expect(settings.settings.storyContextV2Enabled).toBe(false);
    expect(game.activeSaveId).toBeNull();
    expect(ui.activeSaveId).toBeNull();
    expect(ui.viewHistory).toEqual(['home']);
    expect(wrapper.text()).toContain('已退出存档「测试档」');
  });

  it('开启新模式前确认：当前普通档会被退出、新档永久标记为测试方案', async () => {
    const game = useGameStore();
    game.saves = [{ id: 'plain', name: '普通档', metadata: {} } as never];
    game.activeSaveId = 'plain';

    const wrapper = mount(DeveloperSection);
    expect(wrapper.get('[data-testid="story-mode-openable"]').text()).toContain(
      '当前可进入：普通存档',
    );
    await wrapper
      .get<HTMLInputElement>('input[aria-label="Story 上下文与记忆新模式"]')
      .setValue(true);
    await flushPromises();

    const opts = confirmDialogMock.mock.calls[0][0];
    expect(opts.message).toContain('当前存档《普通档》是普通存档，开启后会立即退出');
    expect(opts.message).toContain('开启期间所有普通存档无法进入');
    expect(opts.message).toContain('永久标记为「测试方案」');
    expect(settings.settings.storyContextV2Enabled).toBe(true);
    expect(game.activeSaveId).toBeNull();
    expect(wrapper.get('[data-testid="story-mode-openable"]').text()).toContain(
      '当前可进入：测试存档',
    );
  });

  it('取消确认 → 开关与设置都不变，当前存档不退出', async () => {
    confirmDialogMock.mockResolvedValue(false);
    const game = useGameStore();
    game.saves = [{ id: 'plain', name: '普通档', metadata: {} } as never];
    game.activeSaveId = 'plain';

    const wrapper = mount(DeveloperSection);
    const toggle = wrapper.get<HTMLInputElement>('input[aria-label="Story 上下文与记忆新模式"]');
    await toggle.setValue(true);
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(settings.settings.storyContextV2Enabled).toBe(false);
    expect(toggle.element.checked).toBe(false);
    expect(game.activeSaveId).toBe('plain');
  });

  it('普通存档在关闭新模式时不受影响', async () => {
    const game = useGameStore();
    settings.settings.storyContextV2Enabled = true;
    game.saves = [{ id: 'plain', name: '普通档', metadata: {} } as never];
    game.activeSaveId = 'plain';

    const wrapper = mount(DeveloperSection);
    await wrapper
      .get<HTMLInputElement>('input[aria-label="Story 上下文与记忆新模式"]')
      .setValue(false);
    await flushPromises();
    expect(settings.settings.storyContextV2Enabled).toBe(false);
    expect(game.activeSaveId).toBe('plain');
  });

  it('设置页导航把开发者模式接到独立分区', () => {
    expect(settingsPageSource).toContain("{ key: 'developer', label: '开发者模式'");
    expect(settingsPageSource).toContain(
      '<DeveloperSection v-if="activeSection === \'developer\'" />',
    );
  });
});
