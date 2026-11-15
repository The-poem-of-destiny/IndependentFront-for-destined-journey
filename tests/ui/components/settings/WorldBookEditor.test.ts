/**
 * WorldBookEditor —— 条目表与编辑弹窗的防丢数据回归（审查 S-23 / S-24 / S-26）
 *
 * - 手输排序号在 change（失焦 / 回车）时落库，输入过程中行不重排；
 * - 编辑弹窗有改动时，遮罩 / Esc / 取消先确认；未改动直接关；
 * - 点条目名字打开编辑器；删除条目先确认并点名。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';

import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';

const confirmDialog = vi.hoisted(() =>
  vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true),
);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));

import WorldBookEditor from '../../../../src/ui/components/settings/WorldBookEditor.vue';

function entry(uid: string, name: string, order: number): WorldBookEntry {
  return {
    uid,
    name,
    content: `${name}正文`,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order,
    position: 0,
    extra: { lore: { audiences: ['story'] } },
  };
}
function book(): WorldBook {
  return {
    id: 'user',
    name: '自建书',
    partition: 'world_setting',
    builtIn: false,
    entries: [entry('u:a', '甲', 10), entry('u:b', '乙', 20), entry('u:c', '丙', 30)],
  };
}

const wrappers: VueWrapper[] = [];
function editor(readonly = false) {
  const wrapper = mount(WorldBookEditor, {
    props: { book: book(), readonly },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}
const names = (w: VueWrapper) =>
  w.findAll('.entry-row:not(.entry-header) .col-name').map((n) => n.text());
const lastSaved = (w: VueWrapper) => {
  const updates = w.emitted('update')!;
  return updates[updates.length - 1][0] as WorldBook;
};

beforeEach(() => {
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
});
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));

describe('WorldBookEditor 排序号（S-23）', () => {
  it('输入过程中不重排，change 时提交并落库', async () => {
    const wrapper = editor();
    const input = wrapper.get('input[aria-label="甲 排序"]');
    (input.element as HTMLInputElement).value = '25';
    await input.trigger('input');
    expect(names(wrapper)).toEqual(['甲', '乙', '丙']);
    expect(wrapper.emitted('update')).toBeUndefined();

    await input.trigger('change');
    expect(names(wrapper)).toEqual(['乙', '甲', '丙']);
    const saved = lastSaved(wrapper);
    expect(saved.entries.find((e) => e.uid === 'u:a')!.order).toBe(25);
  });

  it('非法输入回显原值、不落库', async () => {
    const wrapper = editor();
    const input = wrapper.get('input[aria-label="乙 排序"]');
    (input.element as HTMLInputElement).value = '';
    await input.trigger('change');
    expect((input.element as HTMLInputElement).value).toBe('20');
    expect(wrapper.emitted('update')).toBeUndefined();
  });
});

describe('WorldBookEditor 编辑弹窗脏检查（S-24）', () => {
  it('未改动：点遮罩直接关，不弹确认', async () => {
    const wrapper = editor();
    await wrapper.get('button[aria-label="编辑 甲"]').trigger('click');
    await wrapper.get('.modal-overlay').trigger('click');
    await flushPromises();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(wrapper.find('.modal-overlay').exists()).toBe(false);
  });

  it('有改动：Esc 先问，选「继续编辑」保留弹窗与草稿', async () => {
    confirmDialog.mockResolvedValue(false);
    const wrapper = editor();
    await wrapper.get('button[aria-label="编辑 甲"]').trigger('click');
    await wrapper.get('#edit-content').setValue('写了很长的新内容');
    await wrapper.get('.modal-overlay').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect((confirmDialog.mock.calls[0][0] as { title: string }).title).toBe('放弃未保存的修改？');
    expect(wrapper.find('.modal-overlay').exists()).toBe(true);
    expect((wrapper.get('#edit-content').element as HTMLTextAreaElement).value).toBe(
      '写了很长的新内容',
    );
  });

  it('有改动：遮罩 / 取消 确认放弃后关闭，且不保存', async () => {
    const wrapper = editor();
    await wrapper.get('button[aria-label="编辑 甲"]').trigger('click');
    await wrapper.get('#edit-name').setValue('改名');
    await wrapper.get('.modal-actions .btn-secondary').trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.modal-overlay').exists()).toBe(false);
    expect(wrapper.emitted('update')).toBeUndefined();
  });

  it('只读模式关闭不问', async () => {
    const wrapper = editor(true);
    await wrapper.get('button[aria-label="编辑 甲"]').trigger('click');
    await wrapper.get('.modal-overlay').trigger('click');
    await flushPromises();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(wrapper.find('.modal-overlay').exists()).toBe(false);
  });
});

describe('WorldBookEditor 条目名与删除（S-26）', () => {
  it('点条目名字打开编辑器', async () => {
    const wrapper = editor();
    await wrapper.findAll('.entry-row:not(.entry-header) .col-name')[1].trigger('click');
    expect(wrapper.find('.modal-overlay').exists()).toBe(true);
    expect((wrapper.get('#edit-name').element as HTMLInputElement).value).toBe('乙');
  });

  it('删除条目先确认并点名，取消则不删', async () => {
    confirmDialog.mockResolvedValue(false);
    const wrapper = editor();
    await wrapper.get('button[aria-label="删除 丙"]').trigger('click');
    await flushPromises();
    expect((confirmDialog.mock.calls[0][0] as { message: string }).message).toContain('丙');
    expect(wrapper.emitted('update')).toBeUndefined();

    confirmDialog.mockResolvedValue(true);
    await wrapper.get('button[aria-label="删除 丙"]').trigger('click');
    await flushPromises();
    expect(lastSaved(wrapper).entries.map((e) => e.name)).toEqual(['甲', '乙']);
  });
});
