/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import WorldBookEditor from '../../../../src/ui/components/settings/WorldBookEditor.vue';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';

const wrappers: VueWrapper[] = [];
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));
function book(patch: Partial<WorldBook> = {}): WorldBook {
  const entry: WorldBookEntry = {
    uid: 'user:world_setting/agreement_abc',
    name: '约定',
    content: '原始正文',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 1,
    position: 0,
    extra: { lore: { audiences: ['char_gen'], summary: '保留的摘要' } },
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
  it('同次打开连续多选和取消时以当前条目为准，重新打开保留全部选择', async () => {
    const source = book();
    source.entries.push({
      ...structuredClone(source.entries[0]),
      uid: 'user:world_setting/second',
    });
    const before = structuredClone(source);
    const wrapper = editor(source);
    const audience = (name: string) => wrapper.get(`input[aria-label="允许${name}读取本书"]`);

    // 父组件保存后不回传新 props，模拟实际 WorldBookSection 的行为。
    await audience('资料选择').setValue(true);
    await audience('正文生成').setValue(true);
    await audience('大纲生成').setValue(true);
    await audience('资料选择').setValue(false);
    await audience('实体生成').setValue(true);

    const updates = wrapper.emitted('update')!;
    const saved = JSON.parse(JSON.stringify(updates[updates.length - 1][0])) as WorldBook;
    for (const entry of saved.entries) {
      expect(entry.extra?.lore?.audiences).toEqual([
        'char_gen',
        'story',
        'plot_outline',
        'entity_gen',
      ]);
      expect(entry.extra?.lore?.summary).toBe('保留的摘要');
      expect(entry.content).toBe('原始正文');
    }
    for (const name of ['正文生成', '大纲生成', '实体生成']) {
      expect((audience(name).element as HTMLInputElement).checked).toBe(true);
    }
    expect((audience('资料选择').element as HTMLInputElement).checked).toBe(false);
    expect(source).toEqual(before);

    const reopened = editor(saved);
    for (const name of ['正文生成', '大纲生成', '实体生成']) {
      expect(
        (reopened.get(`input[aria-label="允许${name}读取本书"]`).element as HTMLInputElement)
          .checked,
      ).toBe(true);
    }
    await audience('正文生成').setValue(false);
    expect(saved.entries[0].extra?.lore?.audiences).toContain('story');
  });

  it('修改读取范围写入每个条目，保留其他元数据与正文，不修改传入对象', async () => {
    const source = book();
    const before = structuredClone(source);
    const wrapper = editor(source);
    await wrapper.get('input[aria-label="允许资料选择读取本书"]').setValue(true);
    const out = wrapper.emitted('update')![0][0] as WorldBook;
    expect(out.lore).toEqual({ category: '设定' });
    expect(out.entries[0].extra?.lore?.audiences).toEqual(['char_gen', 'lore_select']);
    expect(out.entries[0].extra?.lore?.summary).toBe('保留的摘要');
    expect(out.entries[0].uid).toBe(source.entries[0].uid);
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
            uid: 'user:world_setting/agreement_abc',
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

  it('同书保存回流保留当前权限与条目编辑，切换书时重置', async () => {
    const source = book();
    const wrapper = editor(source);
    await wrapper.get('input[aria-label="启用 约定"]').setValue(false);
    await wrapper.get('input[aria-label="允许资料选择读取本书"]').setValue(true);
    const updates = wrapper.emitted('update')!;
    const updated = updates[updates.length - 1][0] as WorldBook;
    await wrapper.setProps({ book: JSON.parse(JSON.stringify(updated)) as WorldBook });
    expect(
      (wrapper.get('input[aria-label="允许资料选择读取本书"]').element as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (wrapper.get('input[aria-label="允许正文生成读取本书"]').element as HTMLInputElement).checked,
    ).toBe(false);
    expect((wrapper.get('input[aria-label="启用 约定"]').element as HTMLInputElement).checked).toBe(
      false,
    );
    await wrapper.setProps({ book: book({ id: 'other' }) });
    expect(
      (wrapper.get('input[aria-label="允许资料选择读取本书"]').element as HTMLInputElement).checked,
    ).toBe(false);
    expect((wrapper.get('input[aria-label="启用 约定"]').element as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('条目编辑弹窗可单独调整该条目的声明范围，不影响其他条目', async () => {
    const entryOf = (index: number, name: string, audiences: string[]): WorldBookEntry => ({
      uid: `user:world_setting/entry_${index}`,
      name,
      content: `正文${index}`,
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: index,
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
    expect(
      (wrapper.get('input[aria-label="允许资料选择读取本书"]').element as HTMLInputElement).checked,
    ).toBe(true);
    await wrapper.get('input[aria-label="允许大纲生成读取本书"]').setValue(true);
    const updates = wrapper.emitted('update')!;
    const latest = updates[updates.length - 1][0] as WorldBook;
    for (const entry of latest.entries) {
      expect(entry.extra?.lore?.audiences).toEqual([
        'story',
        'lore_select',
        'char_gen',
        'plot_outline',
      ]);
    }
  });
});
