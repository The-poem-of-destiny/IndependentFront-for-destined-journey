/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import WorldBookEditor from '../../../../src/ui/components/settings/WorldBookEditor.vue';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';

const wrappers: VueWrapper[] = [];
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));
function book(patch: Partial<WorldBook> = {}): WorldBook {
  const entry: WorldBookEntry = {
    uid: 1,
    name: '约定',
    content: '原始正文',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 1,
    position: 0,
    extra: { lore: { audiences: ['char_gen'], key: 'user#1' } },
  };
  return {
    id: 'user',
    name: '自建书',
    partition: 'world_setting',
    builtIn: false,
    lore: { category: '设定' },
    entries: [entry],
    ...patch,
  };
}
function editor(source = book(), readonly = false) {
  const wrapper = mount(WorldBookEditor, { props: { book: source, readonly } });
  wrappers.push(wrapper);
  return wrapper;
}

describe('WorldBookEditor 读取范围权限（长期回归）', () => {
  it('修改读取范围写入每个条目，保留其他元数据与正文，不修改传入对象', async () => {
    const source = book();
    const before = structuredClone(source);
    const wrapper = editor(source);
    await wrapper.get('input[aria-label="允许资料选择读取本书"]').setValue(true);
    const out = wrapper.emitted('update')![0][0] as WorldBook;
    expect(out.lore).toEqual({ category: '设定' });
    expect(out.entries[0].extra?.lore?.audiences).toEqual(['char_gen', 'lore_select']);
    expect(out.entries[0].extra?.lore?.key).toBe('user#1');
    expect(out.entries[0].content).toBe('原始正文');
    expect(source).toEqual(before);
  });

  it.each(['builtin', 'workshop', 'readonly'] as const)(
    '%s 不显示权限编辑控件，不发修改事件',
    (kind) => {
      const wrapper = editor(
        book(
          kind === 'builtin'
            ? { builtIn: true }
            : kind === 'workshop'
              ? { partition: 'creative_workshop' }
              : {},
        ),
        kind === 'readonly',
      );
      expect(wrapper.findAll('.audience-panel input')).toHaveLength(0);
      expect(wrapper.get('.audience-panel').text()).toContain('由内容声明');
      expect(wrapper.emitted('update')).toBeUndefined();
    },
  );

  it('取消最后一个授权写出显式空数组，不能恢复为未声明默认范围', async () => {
    const wrapper = editor(
      book({
        entries: [
          {
            uid: 1,
            name: '约定',
            content: 'x',
            enabled: true,
            key: [],
            keysecondary: [],
            selectiveLogic: 0,
            order: 1,
            position: 0,
            extra: { lore: { audiences: ['story'] } },
          },
        ],
      }),
    );
    await wrapper.get('input[aria-label="允许正文生成读取本书"]').setValue(false);
    const out = wrapper.emitted('update')![0][0] as WorldBook;
    expect(out.entries[0].extra?.lore?.audiences).toEqual([]);
  });

  it('同书权限回流立即更新勾选且保留本地条目编辑', async () => {
    const source = book();
    const wrapper = editor(source);
    await wrapper.get('input[aria-label="启用 约定"]').setValue(false);
    const updated = wrapper.emitted('update')![0][0] as WorldBook;
    await wrapper.setProps({
      book: {
        ...updated,
        entries: updated.entries.map((entry) => ({
          ...entry,
          extra: {
            ...(entry.extra ?? {}),
            lore: { ...(entry.extra?.lore ?? {}), audiences: ['lore_select'] },
          },
        })),
      },
    });
    expect(
      (wrapper.get('input[aria-label="允许资料选择读取本书"]').element as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (wrapper.get('input[aria-label="允许正文生成读取本书"]').element as HTMLInputElement).checked,
    ).toBe(false);
    expect((wrapper.get('input[aria-label="启用 约定"]').element as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('条目编辑弹窗可单独调整该条目的声明范围，不影响其他条目', async () => {
    const entryOf = (uid: number, name: string, audiences: string[]): WorldBookEntry => ({
      uid,
      name,
      content: `正文${uid}`,
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: uid,
      position: 0,
      extra: { lore: { audiences } },
    });
    const wrapper = editor(
      book({ entries: [entryOf(1, 'A', ['story']), entryOf(2, 'B', ['char_gen'])] }),
    );

    await wrapper.get('button[aria-label="编辑 A"]').trigger('click');
    await wrapper.get('input[aria-label="允许资料选择读取本条"]').setValue(true);
    await wrapper.get('button.btn-primary').trigger('click');

    const out = wrapper.emitted('update')![0][0] as WorldBook;
    expect(out.entries[0].extra?.lore?.audiences).toEqual(['story', 'lore_select']);
    expect(out.entries[1].extra?.lore?.audiences).toEqual(['char_gen']);
  });
});
