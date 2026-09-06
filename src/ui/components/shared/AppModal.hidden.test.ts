// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AppModal from '@ui/components/shared/AppModal.vue';
it('Shift+Tab skips controls inside the hidden v-show map tab', async () => {
  const wrapper = mount(AppModal, {
    props: { open: true, title: 'Map' },
    slots: {
      default:
        '<button id="visible">Visible map action</button><div style="display:none"><button id="hidden">Retained political tab action</button></div>',
    },
    attachTo: document.body,
  });
  try {
    await wrapper.vm.$nextTick();
    const close = document.querySelector('.modal-close') as HTMLElement;
    close.focus();
    close.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(document.getElementById('visible'));
  } finally {
    wrapper.unmount();
    document.body.innerHTML = '';
  }
});
