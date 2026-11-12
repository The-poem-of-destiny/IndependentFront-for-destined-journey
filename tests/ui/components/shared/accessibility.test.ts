/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { mount, enableAutoUnmount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { defineComponent } from 'vue';
import AppCard from '../../../../src/ui/components/shared/AppCard.vue';
import FormSelect from '../../../../src/ui/components/shared/form/FormSelect.vue';
import ToastContainer from '../../../../src/ui/components/shared/ToastContainer.vue';
import { useUIStore } from '../../../../src/ui/stores/ui-store';
enableAutoUnmount(afterEach);
it('associates each form selector with its own visible label, including label slots', () => {
  const wrapper = mount(
    defineComponent({
      components: { FormSelect },
      template: `
        <div>
          <FormSelect model-value="agent" label="生成模式（创建后不可更改）"
            :options="[{ value: 'agent', label: 'Agent 模式' }]" />
          <FormSelect model-value="prefix"
            :options="[{ value: 'prefix', label: '通用稳定前缀' }]">
            <template #label>渠道缓存支持</template>
          </FormSelect>
        </div>
      `,
    }),
    { attachTo: document.body },
  );
  const selectors = wrapper.findAll('select').map((select) => select.element);
  expect(selectors.map((select) => select.labels?.[0]?.textContent?.trim())).toEqual([
    '生成模式（创建后不可更改）',
    '渠道缓存支持',
  ]);
  expect(selectors[0].labels?.[0]).not.toBe(selectors[1].labels?.[0]);
});

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
