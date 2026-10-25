/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import DeveloperSection from '../../../../src/ui/components/settings/DeveloperSection.vue';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';

enableAutoUnmount(afterEach);

describe('DeveloperSection worldbook history setting', () => {
  let settings: ReturnType<typeof useSettingsStore>;
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    settings = useSettingsStore();
    settings.settings.storyContextV2Enabled = true;
  });
  afterEach(() => settings.$dispose());

  it('defaults to six messages, persists edits and restores them after reload', async () => {
    const wrapper = mount(DeveloperSection);
    const storyCard = wrapper.get('.developer-mode-card.is-enabled');
    expect(storyCard.find('select[aria-describedby="story-recall-raw-help"]').exists()).toBe(true);
    expect(storyCard.find('input[aria-label="世界书检索历史消息数"]').exists()).toBe(true);
    const input = wrapper.get<HTMLInputElement>('input[aria-label="世界书检索历史消息数"]');
    expect(input.element.value).toBe('6');
    await input.setValue('12');
    await nextTick();
    expect(settings.settings.loreHistoryMessages).toBe(12);
    expect(JSON.parse(localStorage.getItem('fated-poem-settings')!).loreHistoryMessages).toBe(12);
    settings.$dispose();
    setActivePinia(createPinia());
    settings = useSettingsStore();
    expect(settings.settings.loreHistoryMessages).toBe(12);
    settings.resetAll();
    expect(settings.settings.loreHistoryMessages).toBe(6);
  });

  it('accepts zero and rejects negative, fractional and empty values', async () => {
    const wrapper = mount(DeveloperSection);
    const input = wrapper.get<HTMLInputElement>('input[aria-label="世界书检索历史消息数"]');
    await input.setValue('0');
    expect(settings.settings.loreHistoryMessages).toBe(0);
    for (const invalid of ['-1', '1.5', '']) {
      await input.setValue(invalid);
      expect(settings.settings.loreHistoryMessages).toBe(0);
      expect(input.element.value).toBe('0');
    }
  });

  it('saves valid input before blur and allows an unfinished edit until change', async () => {
    const wrapper = mount(DeveloperSection);
    const input = wrapper.get<HTMLInputElement>('input[aria-label="世界书检索历史消息数"]');
    input.element.value = '12';
    await input.trigger('input');
    expect(settings.settings.loreHistoryMessages).toBe(12);
    expect(JSON.parse(localStorage.getItem('fated-poem-settings')!).loreHistoryMessages).toBe(12);
    input.element.value = '';
    await input.trigger('input');
    expect(input.element.value).toBe('');
    expect(settings.settings.loreHistoryMessages).toBe(12);
    await input.trigger('change');
    expect(input.element.value).toBe('12');
  });
});
