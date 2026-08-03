/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { BeautifierStorageMutation } from '../../lib/beautifier-frame';
import BeautifierFrame from './BeautifierFrame.vue';

const storage = vi.hoisted(() => ({
  entries: [] as [string, string][],
  listener: null as ((mutations: readonly BeautifierStorageMutation[]) => void) | null,
  open: vi.fn(),
  commit: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../lib/beautifier-storage', () => ({
  openBeautifierStorageSession: storage.open,
}));

function apply(mutations: readonly BeautifierStorageMutation[]): void {
  const values = new Map(storage.entries);
  for (const mutation of mutations) {
    if (mutation.kind === 'clear') values.clear();
    else if (mutation.kind === 'remove') values.delete(mutation.key);
    else values.set(mutation.key, mutation.value);
  }
  storage.entries = [...values.entries()];
}

function bridgeId(srcdoc: string): string {
  const literal = srcdoc.match(/const bridgeId = ("[^"]+");/)?.[1];
  if (!literal) throw new Error('Missing bridge id');
  return JSON.parse(literal) as string;
}

async function mountFrame() {
  const wrapper = mount(BeautifierFrame, {
    attachTo: document.body,
    props: {
      markup: '<script>window.loadedTheme=localStorage.getItem("theme")</script>',
      ruleName: 'Storage rule',
    },
  });
  expect(wrapper.find('iframe').exists()).toBe(false);
  await flushPromises();
  return wrapper;
}

describe('BeautifierFrame persistent storage bridge', () => {
  beforeEach(() => {
    storage.entries = [['theme', 'night']];
    storage.listener = null;
    storage.open.mockReset();
    storage.commit.mockReset();
    storage.close.mockReset();
    storage.commit.mockImplementation(async (mutations: readonly BeautifierStorageMutation[]) => {
      apply(mutations);
    });
    storage.open.mockImplementation(
      async (listener: (mutations: readonly BeautifierStorageMutation[]) => void) => {
        storage.listener = listener;
        return {
          snapshot: () => storage.entries.map(([key, value]) => [key, value] as const),
          commit: storage.commit,
          close: storage.close,
        };
      },
    );
  });

  it('waits for hydration and embeds the shared snapshot before authored scripts', async () => {
    const wrapper = await mountFrame();
    const iframe = wrapper.get('iframe');
    const srcdoc = iframe.attributes('srcdoc')!;

    expect(srcdoc.indexOf('[[' + '"theme","night"' + ']]')).toBeLessThan(
      srcdoc.indexOf('window.loadedTheme'),
    );
    expect(iframe.attributes('sandbox')).toBe('allow-scripts');
    expect(iframe.attributes()).toHaveProperty('credentialless');

    wrapper.unmount();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it('persists a frame mutation without replacing or reloading the iframe document', async () => {
    const wrapper = await mountFrame();
    const iframe = wrapper.get('iframe');
    const element = iframe.element as HTMLIFrameElement;
    const initialSrcdoc = iframe.attributes('srcdoc')!;
    const postMessage = vi.spyOn(element.contentWindow!, 'postMessage');
    const id = bridgeId(initialSrcdoc);
    const mutations = [{ kind: 'set', key: 'font', value: 'large' }] as const;

    window.dispatchEvent(
      new MessageEvent('message', {
        source: element.contentWindow,
        data: {
          source: 'fated-poem-beautifier',
          bridgeId: id,
          type: 'storage-mutate',
          sequence: 1,
          mutations,
        },
      }),
    );
    await flushPromises();

    expect(storage.commit).toHaveBeenCalledWith(mutations);
    expect(wrapper.get('iframe').element).toBe(element);
    expect(wrapper.get('iframe').attributes('srcdoc')).toBe(initialSrcdoc);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: id, type: 'storage-sync', mutations }),
      '*',
    );

    wrapper.unmount();
  });

  it('fans peer commits into the live mirror without rebuilding srcdoc', async () => {
    const wrapper = await mountFrame();
    const iframe = wrapper.get('iframe');
    const element = iframe.element as HTMLIFrameElement;
    const initialSrcdoc = iframe.attributes('srcdoc')!;
    const postMessage = vi.spyOn(element.contentWindow!, 'postMessage');
    const mutations = [{ kind: 'remove', key: 'theme' }] as const;
    apply(mutations);

    storage.listener?.(mutations);
    await flushPromises();

    expect(wrapper.get('iframe').element).toBe(element);
    expect(wrapper.get('iframe').attributes('srcdoc')).toBe(initialSrcdoc);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'storage-sync', mutations }),
      '*',
    );

    wrapper.unmount();
  });
});
