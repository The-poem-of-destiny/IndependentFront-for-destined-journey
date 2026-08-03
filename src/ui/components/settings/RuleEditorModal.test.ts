/**
 * Rule preview iframe-boundary regression tests.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { BeautifierRule } from '@engine/types';
import RuleEditorModal from './RuleEditorModal.vue';

vi.mock('../../lib/beautifier-storage', () => ({
  openBeautifierStorageSession: async () => ({
    snapshot: () => [],
    commit: async () => undefined,
    close: () => undefined,
  }),
}));

afterEach(() => {
  document.body.replaceChildren();
  document.body.style.overflow = '';
});

describe('RuleEditorModal', () => {
  it('previews authored HTML intact inside an opaque network-enabled iframe', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(RuleEditorModal, {
      attachTo: document.body,
      props: { rule: null },
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    const textareas = wrapper.findAll('textarea');
    const inputs = wrapper.findAll('input');

    await textareas[0].setValue('(.+)');
    await textareas[1].setValue(
      '<img src="https://example.invalid/missing.png" onerror="globalThis.__probe = 1">' +
        '<span style="position:fixed">$1</span><script>globalThis.__scriptProbe = 1</script>',
    );
    await inputs[2].setValue('preview text');
    await flushPromises();

    const preview = document.body.querySelector('.preview-box');
    const frame = preview?.querySelector('iframe');
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    expect(frame).not.toBeNull();
    expect(preview?.querySelector('img')).toBeNull();
    expect(preview?.querySelector('script')).toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(srcdoc).toContain('connect-src http: https: ws: wss: data: blob:');
    expect(srcdoc).not.toContain('window.fetch = blockedNetwork');
    expect(srcdoc).toContain('onerror="globalThis.__probe = 1"');
    expect(srcdoc).toContain('<script>globalThis.__scriptProbe = 1</script>');
    expect(srcdoc).toContain('preview text');

    wrapper.unmount();
  });

  it('preserves imported compatibility metadata when editing visible fields', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const rule: BeautifierRule = {
      id: 'workshop-rule',
      name: 'Workshop rule',
      scope: 'maintext',
      pattern: 'old',
      flags: 'g',
      replacement: '<b>old</b>',
      enabled: true,
      order: 5100,
      isBuiltin: false,
      minDepth: 2,
      maxDepth: 8,
      group: '创意工坊 · test',
      autoEnable: { worldBookIds: ['workshop:test'] },
    };
    const wrapper = mount(RuleEditorModal, {
      attachTo: document.body,
      props: { rule },
      global: { plugins: [pinia], stubs: { teleport: true } },
    });

    await wrapper.findAll('textarea')[0].setValue('new');
    const save = wrapper.findAll('button').find((button) => button.text() === '保存');
    expect(save).toBeDefined();
    await save!.trigger('click');

    expect(wrapper.emitted<BeautifierRule[]>('save')?.[0]?.[0]).toMatchObject({
      pattern: 'new',
      minDepth: 2,
      maxDepth: 8,
      group: '创意工坊 · test',
      autoEnable: { worldBookIds: ['workshop:test'] },
    });

    wrapper.unmount();
  });
});
