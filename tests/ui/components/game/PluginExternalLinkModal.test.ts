/**
 * PluginExternalLinkModal —— 插件外链弹窗（设计 §5.7、Q12）
 *
 * 钉住：完整地址按纯文本显示、全弹窗没有任何链接元素或 href；
 * 「复制链接」写剪贴板，剪贴板不可用时给出手动复制提示；关闭发 close。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import PluginExternalLinkModal from '../../../../src/ui/components/game/PluginExternalLinkModal.vue';

const URL_TEXT = 'https' + ':' + '//docs.example.com/guide?from=plugin&x=' + 'a'.repeat(80);

const wrappers: VueWrapper[] = [];

async function mountModal() {
  const w = mount(PluginExternalLinkModal, {
    props: { pluginName: '杂货铺', url: URL_TEXT },
    attachTo: document.body,
  });
  wrappers.push(w);
  await flushPromises();
  await nextTick();
  return w;
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('PluginExternalLinkModal', () => {
  it('完整地址按纯文本显示，并写出插件名', async () => {
    await mountModal();
    expect(q('[data-external-url]')?.textContent).toBe(URL_TEXT);
    expect(document.body.textContent).toContain('杂货铺');
    expect(document.body.textContent).toContain('本应用不会替插件打开链接');
  });

  it('弹窗里没有任何链接元素，也没有 href 属性', async () => {
    await mountModal();
    expect(document.querySelectorAll('a').length).toBe(0);
    expect(document.querySelectorAll('[href]').length).toBe(0);
  });

  it('点「复制链接」把完整地址写进剪贴板并提示已复制', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountModal();
    q('[data-link-action="copy"]')!.click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(URL_TEXT);
    expect(document.body.textContent).toContain('已复制到剪贴板');
  });

  it('剪贴板写入失败时提示手动复制', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountModal();
    q('[data-link-action="copy"]')!.click();
    await flushPromises();
    expect(document.body.textContent).toContain('请手动选中上面的地址复制');
  });

  it('点「关闭」发出 close，且从不调用 window.open', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const w = await mountModal();
    q('[data-link-action="close"]')!.click();
    await nextTick();
    expect(w.emitted('close')).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  });
});
