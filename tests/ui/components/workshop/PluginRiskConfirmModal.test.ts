/**
 * PluginRiskConfirmModal —— 插件风险确认弹窗（设计 §3.4）
 *
 * 钉住：勾选框一个都不预勾、全部勾上前「确认」不可点；默认焦点在「取消」；
 * 确认 / 取消 / Esc 的事件；新增域名高亮且按文本渲染。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import PluginRiskConfirmModal from '../../../../src/ui/components/workshop/PluginRiskConfirmModal.vue';
import type { PluginRiskManifest } from '../../../../src/ui/lib/plugin-risk-messages';

const wrappers: VueWrapper[] = [];

function manifest(network: string[] = []): PluginRiskManifest {
  return {
    name: '测试插件',
    version: '1.0.0',
    author: '作者甲',
    network,
    capabilities: { read: ['player'], commands: [], events: [], ai: [], storage: [] },
  };
}

async function mountModal(props: {
  variant: 'install' | 'save';
  manifest: PluginRiskManifest;
  networkAdded?: string[];
  source?: 'local' | 'workshop';
  fileCount?: number;
  totalBytes?: number;
}) {
  const w = mount(PluginRiskConfirmModal, { props, attachTo: document.body });
  wrappers.push(w);
  await flushPromises();
  await nextTick();
  return w;
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function boxes(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.pr-check input[type="checkbox"]')];
}

async function tick(box: HTMLInputElement) {
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  await nextTick();
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('PluginRiskConfirmModal', () => {
  it('联网插件的完整版有两个勾选框，都未预勾；全部勾上前「确认」不可点', async () => {
    const w = await mountModal({ variant: 'install', manifest: manifest(['api.example.com']) });
    const confirm = q<HTMLButtonElement>('[data-risk-action="confirm"]')!;
    const list = boxes();
    expect(list).toHaveLength(2);
    expect(list.every((b) => !b.checked)).toBe(true);
    expect(confirm.disabled).toBe(true);

    await tick(list[0]!);
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(w.emitted('confirm')).toBeUndefined();

    await tick(list[1]!);
    expect(confirm.disabled).toBe(false);
    confirm.click();
    expect(w.emitted('confirm')).toHaveLength(1);
  });

  it('打开后默认焦点在「取消」', async () => {
    await mountModal({ variant: 'install', manifest: manifest() });
    expect(document.activeElement).toBe(q('[data-risk-action="cancel"]'));
  });

  it('点「取消」与按 Esc 都发出 cancel，且不发 confirm', async () => {
    const w = await mountModal({ variant: 'save', manifest: manifest() });
    q('[data-risk-action="cancel"]')!.click();
    expect(w.emitted('cancel')).toHaveLength(1);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(w.emitted('cancel')).toHaveLength(2);
    expect(w.emitted('confirm')).toBeUndefined();
  });

  it('未声明域名时显示「未声明联网域名」，短版只列三条风险、一个勾选框', async () => {
    await mountModal({ variant: 'save', manifest: manifest() });
    expect(q('.pr-network-empty')?.textContent?.trim()).toBe('未声明联网域名');
    expect(document.body.textContent).not.toContain('不联网');
    expect(document.querySelectorAll('.pr-warning')).toHaveLength(3);
    expect(boxes()).toHaveLength(1);
  });

  it('更新新增的域名被高亮并带「新增」字样，域名按纯文本渲染', async () => {
    await mountModal({
      variant: 'install',
      manifest: manifest(['api.example.com', 'new.example.org']),
      networkAdded: ['new.example.org'],
    });
    const added = document.querySelectorAll('.pr-domain.is-added');
    expect(added).toHaveLength(1);
    expect(added[0]!.querySelector('.pr-domain-host')?.textContent).toBe('new.example.org');
    expect(added[0]!.querySelector('.pr-domain-badge')?.textContent).toBe('新增');
    expect(document.querySelector('.pr-domains a')).toBeNull();
    expect(document.querySelectorAll('.pr-warning')).toHaveLength(8);
  });

  it('安装确认显示来源、文件数与体积（§3.4）', async () => {
    await mountModal({
      variant: 'install',
      manifest: manifest(),
      source: 'local',
      fileCount: 4,
      totalBytes: 3 * 1024,
    });
    const text = q('.pr-identity')?.textContent ?? '';
    expect(text).toContain('本地文件夹');
    expect(text).toContain('4 个');
    expect(text).toContain('3.0 KB');
  });
});
