/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { BeautifierStorageMutation } from '../../../../src/ui/lib/beautifier-frame';
import BeautifierFrame from '../../../../src/ui/components/game/BeautifierFrame.vue';

const storage = vi.hoisted(() => ({
  entries: [] as [string, string][],
  listener: null as ((mutations: readonly BeautifierStorageMutation[]) => void) | null,
  open: vi.fn(),
  commit: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../../src/ui/lib/beautifier-storage', () => ({
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

  describe('加固档（relay 牢笼）', () => {
    async function mountHardened() {
      const wrapper = mount(BeautifierFrame, {
        attachTo: document.body,
        props: {
          markup: '<div>card</div>',
          ruleName: 'Hardened rule',
          hardened: true,
        },
      });
      await flushPromises();
      const iframe = wrapper.get('iframe');
      const element = iframe.element as HTMLIFrameElement;
      const srcdoc = iframe.attributes('srcdoc')!;
      const config = JSON.parse(srcdoc.match(/const config = (\{.*\});\n/)![1]) as {
        channel: string;
        link: string;
      };
      return { wrapper, element, srcdoc, id: config.channel, link: config.link };
    }

    function fromFrame(element: HTMLIFrameElement, data: Record<string, unknown>): void {
      // relay 模式下宿主看到的来源是牢笼窗口 —— 正是这个 iframe 元素的 contentWindow。
      window.dispatchEvent(new MessageEvent('message', { source: element.contentWindow, data }));
    }

    it('srcdoc 是 relay 牢笼文档，内层的桥 id 与宿主一致', async () => {
      const { wrapper, srcdoc, id, link } = await mountHardened();

      expect(link).toBe('relay');
      expect(srcdoc).not.toContain('<div>card</div>');
      expect(srcdoc).toContain(JSON.stringify(id));
      expect(wrapper.get('iframe').attributes('sandbox')).toBe('allow-scripts');

      wrapper.unmount();
    });

    it('relay 的 ready 到达前不发宿主消息，就绪后补发主题与存储快照', async () => {
      const { wrapper, element, id } = await mountHardened();
      const postMessage = vi.spyOn(element.contentWindow!, 'postMessage');

      // 牢笼加载、主题变化、同伴存储写入 —— 内层还没就绪，发出去也会被牢笼丢掉。
      await wrapper.get('iframe').trigger('load');
      storage.listener?.([{ kind: 'set', key: 'early', value: '1' }]);
      await flushPromises();
      expect(postMessage).not.toHaveBeenCalled();

      fromFrame(element, { source: 'fated-poem-beautifier', bridgeId: id, type: 'ready' });
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeId: id, type: 'theme' }),
        '*',
      );
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeId: id, type: 'storage-reset' }),
        '*',
      );

      // 就绪之后同伴写入照常经牢笼转发。
      postMessage.mockClear();
      const mutations = [{ kind: 'remove', key: 'theme' }] as const;
      storage.listener?.(mutations);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'storage-sync', mutations }),
        '*',
      );

      wrapper.unmount();
    });

    it('牢笼的 inner-ready 也算就绪信号，且不会重复补发', async () => {
      const { wrapper, element, id } = await mountHardened();
      const postMessage = vi.spyOn(element.contentWindow!, 'postMessage');
      const innerReady = { source: 'fated-poem-cage', channel: id, type: 'inner-ready' };

      fromFrame(element, { ...innerReady, channel: 'other-frame' });
      expect(postMessage).not.toHaveBeenCalled();

      fromFrame(element, innerReady);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeId: id, type: 'theme' }),
        '*',
      );
      const calls = postMessage.mock.calls.length;
      fromFrame(element, innerReady);
      expect(postMessage.mock.calls.length).toBe(calls);

      wrapper.unmount();
    });

    it('高度与存储写入经牢笼转发后照常生效，别的窗口发来的一律不认', async () => {
      const { wrapper, element, id } = await mountHardened();

      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: { source: 'fated-poem-beautifier', bridgeId: id, type: 'height', height: 500 },
        }),
      );
      expect(wrapper.emitted('resize')).toBeUndefined();

      fromFrame(element, {
        source: 'fated-poem-beautifier',
        bridgeId: id,
        type: 'height',
        height: 420,
      });
      await flushPromises();
      expect(wrapper.emitted('resize')).toEqual([[420]]);
      expect(wrapper.get('iframe').attributes('style')).toContain('height: 420px');

      const mutations = [{ kind: 'set', key: 'font', value: 'large' }] as const;
      fromFrame(element, {
        source: 'fated-poem-beautifier',
        bridgeId: id,
        type: 'storage-mutate',
        sequence: 1,
        mutations,
      });
      await flushPromises();
      expect(storage.commit).toHaveBeenCalledWith(mutations);

      wrapper.unmount();
    });

    it('切换加固档会重建文档并重新等待就绪', async () => {
      const { wrapper, element, id } = await mountHardened();
      fromFrame(element, { source: 'fated-poem-beautifier', bridgeId: id, type: 'ready' });

      await wrapper.setProps({ markup: '<div>next</div>' });
      const postMessage = vi.spyOn(element.contentWindow!, 'postMessage');
      storage.listener?.([{ kind: 'set', key: 'late', value: '1' }]);
      await flushPromises();
      expect(postMessage).not.toHaveBeenCalled();

      await wrapper.setProps({ hardened: false });
      const plainSrcdoc = wrapper.get('iframe').attributes('srcdoc')!;
      expect(plainSrcdoc).toContain('<div>next</div>');
      expect(plainSrcdoc).not.toContain('fated-poem-cage');

      wrapper.unmount();
    });
  });
});
