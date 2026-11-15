/**
 * ConfirmDialogHost —— 确认弹窗宿主
 *
 * 钉住：按钮/Esc/遮罩/× 的兑现值、危险操作默认聚焦「取消」、明细逐行渲染、
 * 从已打开的 AppModal 里发起时排在其上层（DOM 顺序靠后 + 层级类名可被认领）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ConfirmDialogHost from '../../../../src/ui/components/shared/ConfirmDialogHost.vue';
import AppModal from '../../../../src/ui/components/shared/AppModal.vue';
import { __resetConfirmDialogForTests, confirmDialog } from '../../../../src/ui/lib/confirm-dialog';

const wrappers: VueWrapper[] = [];
function mountHost() {
  const w = mount(ConfirmDialogHost, { attachTo: document.body });
  wrappers.push(w);
  return w;
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

async function settle() {
  await flushPromises();
  await nextTick();
}

beforeEach(() => {
  __resetConfirmDialogForTests();
});
afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('ConfirmDialogHost', () => {
  it('渲染标题、正文、明细与默认按钮文案，点「确定」兑现 true', async () => {
    mountHost();
    const p = confirmDialog({ title: '删除存档', message: '此操作无法撤销', details: ['存档甲'] });
    await settle();
    expect(q('.modal-title')?.textContent).toBe('删除存档');
    expect(q('.confirm-message')?.textContent).toBe('此操作无法撤销');
    expect(q('.confirm-details li')?.textContent).toBe('存档甲');
    expect(q('[data-confirm-action="cancel"]')?.textContent?.trim()).toBe('取消');
    expect(q('[data-confirm-action="confirm"]')?.textContent?.trim()).toBe('确定');
    q('[data-confirm-action="confirm"]')!.click();
    await expect(p).resolves.toBe(true);
    await settle();
    expect(q('.confirm-dialog-body')).toBeNull();
  });

  it('自定义文案；点「取消」兑现 false', async () => {
    mountHost();
    const p = confirmDialog({
      title: '标题',
      message: '正文',
      confirmLabel: '删除',
      cancelLabel: '再想想',
    });
    await settle();
    expect(q('[data-confirm-action="confirm"]')?.textContent?.trim()).toBe('删除');
    q('[data-confirm-action="cancel"]')!.click();
    await expect(p).resolves.toBe(false);
  });

  it('Esc 兑现 false', async () => {
    mountHost();
    const p = confirmDialog({ title: '标题', message: '正文' });
    await settle();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  it('点遮罩兑现 false', async () => {
    mountHost();
    const p = confirmDialog({ title: '标题', message: '正文' });
    await settle();
    q('.modal-overlay')!.click();
    await expect(p).resolves.toBe(false);
  });

  it('点 × 兑现 false', async () => {
    mountHost();
    const p = confirmDialog({ title: '标题', message: '正文' });
    await settle();
    q('.modal-close')!.click();
    await expect(p).resolves.toBe(false);
  });

  it('危险操作：确认按钮用危险样式，初始焦点落在「取消」', async () => {
    mountHost();
    void confirmDialog({ title: '清除全部', message: '正文', danger: true });
    await settle();
    const confirmBtn = q('[data-confirm-action="confirm"]')!;
    const cancelBtn = q('[data-confirm-action="cancel"]')!;
    expect(confirmBtn.classList.contains('btn-danger')).toBe(true);
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('普通确认：初始焦点落在「确定」', async () => {
    mountHost();
    void confirmDialog({ title: '标题', message: '正文' });
    await settle();
    expect(document.activeElement).toBe(q('[data-confirm-action="confirm"]'));
  });

  it('排队的请求在前一个结束后依次出现', async () => {
    mountHost();
    const first = confirmDialog({ title: '一', message: 'a' });
    const second = confirmDialog({ title: '二', message: 'b' });
    await settle();
    expect(q('.modal-title')?.textContent).toBe('一');
    q('[data-confirm-action="confirm"]')!.click();
    await settle();
    expect(q('.modal-title')?.textContent).toBe('二');
    q('[data-confirm-action="cancel"]')!.click();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('从已打开的 AppModal 里发起：确认层排在其后并拥有 Esc，关闭后外层弹窗仍在', async () => {
    mountHost();
    const outer = mount(AppModal, {
      props: { open: true, title: '外层' },
      slots: { default: '<button class="outer-probe">外层按钮</button>' },
      attachTo: document.body,
    });
    wrappers.push(outer);
    await settle();
    const p = confirmDialog({ title: '内层确认', message: '正文', danger: true });
    await settle();
    const overlays = [...document.querySelectorAll('.modal-overlay')];
    expect(overlays).toHaveLength(2);
    // DOM 顺序：确认层在外层之后（同层级下后者在上），且可被 :has() 层级规则认领
    expect(overlays[1]!.querySelector('.confirm-dialog-body')).not.toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(false);
    await settle();
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
    expect(outer.emitted('close')).toBeUndefined();
  });
});
