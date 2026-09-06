/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { mount, enableAutoUnmount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AppCard from './AppCard.vue';
import ToastContainer from './ToastContainer.vue';
import { useUIStore } from '../../stores/ui-store';
enableAutoUnmount(afterEach);
it('clickable cards expose selection and keyboard activation', async () => {
  const click = vi.fn();
  const wrapper = mount(AppCard, {
    props: { clickable: true, selected: true, onClick: click },
    slots: { default: 'Difficulty' },
  });
  expect(wrapper.attributes('role')).toBe('button');
  expect(wrapper.attributes('aria-pressed')).toBe('true');
  await wrapper.trigger('keydown', { key: 'Enter' });
  await wrapper.trigger('keydown', { key: ' ' });
  expect(click).toHaveBeenCalledTimes(2);
});
it('announces notifications and supports keyboard dismissal', async () => {
  const pinia = createPinia();
  const ui = useUIStore(pinia);
  ui.toast('Saved', 'success');
  const wrapper = mount(ToastContainer, {
    global: { plugins: [pinia], stubs: { teleport: true } },
  });
  expect(wrapper.find('[role="status"]').attributes('aria-live')).toBe('polite');
  await wrapper.find('[role="button"]').trigger('keydown', { key: 'Enter' });
  expect(ui.toasts).toHaveLength(0);
});
