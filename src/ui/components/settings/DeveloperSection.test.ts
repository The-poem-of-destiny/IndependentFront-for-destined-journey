/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DeveloperSection from './DeveloperSection.vue';
import settingsPageSource from './SettingsPage.vue?raw';
import { useSettingsStore } from '../../stores/settings-store';

enableAutoUnmount(afterEach);

describe('DeveloperSection', () => {
  let settings: ReturnType<typeof useSettingsStore>;

  beforeEach(() => {
    localStorage.clear();
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

  it('设置页导航把开发者模式接到独立分区', () => {
    expect(settingsPageSource).toContain("{ key: 'developer', label: '开发者模式'");
    expect(settingsPageSource).toContain(
      '<DeveloperSection v-if="activeSection === \'developer\'" />',
    );
  });
});
