/**
 * confirm-dialog —— Promise 风格确认弹窗的状态机
 *
 * 宿主组件的渲染另有测试；这里只钉模块契约：确认/取消的兑现值、先进先出排队、
 * 未挂宿主时回退到 window.confirm、宿主卸载时未决请求一律按取消处理。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConfirmDialogForTests,
  activeConfirm,
  confirmDialog,
  registerConfirmHost,
  settleConfirm,
} from '@ui/lib/confirm-dialog';

describe('confirmDialog', () => {
  beforeEach(() => {
    __resetConfirmDialogForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('有宿主时：确认兑现 true', async () => {
    registerConfirmHost();
    const p = confirmDialog({ title: '删除存档', message: '确定删除？' });
    expect(activeConfirm.value?.options.title).toBe('删除存档');
    settleConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(activeConfirm.value).toBeNull();
  });

  it('有宿主时：取消兑现 false', async () => {
    registerConfirmHost();
    const p = confirmDialog({ title: '标题', message: '正文' });
    settleConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it('打开期间的新调用按先进先出排队，逐个展示', async () => {
    registerConfirmHost();
    const first = confirmDialog({ title: '一', message: 'a' });
    const second = confirmDialog({ title: '二', message: 'b' });
    const third = confirmDialog({ title: '三', message: 'c' });
    expect(activeConfirm.value?.options.title).toBe('一');
    settleConfirm(true);
    expect(activeConfirm.value?.options.title).toBe('二');
    settleConfirm(false);
    expect(activeConfirm.value?.options.title).toBe('三');
    settleConfirm(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(true);
    expect(activeConfirm.value).toBeNull();
  });

  it('宿主卸载时，当前与排队中的请求全部按取消兑现', async () => {
    const unregister = registerConfirmHost();
    const first = confirmDialog({ title: '一', message: 'a' });
    const second = confirmDialog({ title: '二', message: 'b' });
    unregister();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(activeConfirm.value).toBeNull();
  });

  it('未挂宿主时回退到 window.confirm，并拼上标题、正文与明细', async () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal('confirm', spy);
    const result = await confirmDialog({
      title: '删除世界书',
      message: '将删除以下条目',
      details: ['条目甲', '条目乙'],
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith('删除世界书\n将删除以下条目\n条目甲\n条目乙');
    expect(activeConfirm.value).toBeNull();
  });

  it('未挂宿主且 window.confirm 不存在时兑现 false', async () => {
    vi.stubGlobal('confirm', undefined);
    await expect(confirmDialog({ title: '标题', message: '正文' })).resolves.toBe(false);
  });
});
