/**
 * WorldBookSection —— 世界书分区的防丢数据回归（审查 S-21 / S-22 / S-28）
 *
 * - 新建：行内输入行（不再用原生 prompt），同名拒绝，id 唯一，绝不覆盖已有书；
 * - 导入：没有 entries 的 JSON 拒绝；id 撞车先问「覆盖」再问「导入为副本」；
 * - 恢复全部默认：独立危险区，确认框点名将删除的书，失败如实报错。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import type { WorldBook } from '@engine/types/types';

import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';

const confirmDialog = vi.hoisted(() =>
  vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true),
);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));

const toast = vi.fn();
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

const saveNow = vi.fn();
const resetWorldBooksToDefaults = vi.fn();
const settings = reactive({ allowEditBuiltInBooks: false, activeWorldBookId: null });
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings, saveNow, resetWorldBooksToDefaults }),
}));

function makeBook(id: string, name: string, entries = 0, builtIn = false): WorldBook {
  return {
    id,
    name,
    partition: 'world_setting',
    builtIn,
    entries: Array.from({ length: entries }, (_, i) => ({
      uid: `${id}/e${i}`,
      name: `条目${i}`,
      content: '',
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0 as const,
      order: i,
      position: 0,
    })),
  };
}

const wbState = reactive({ books: [] as WorldBook[] });
const upsertBook = vi.fn(async (book: WorldBook) => {
  const idx = wbState.books.findIndex((b) => b.id === book.id);
  if (idx >= 0) wbState.books[idx] = book;
  else wbState.books.push(book);
});
const resetToDefaults = vi.fn(async () => 1);
const fakeWb = {
  get books() {
    return wbState.books;
  },
  getBook: (id: string) => wbState.books.find((b) => b.id === id),
  upsertBook,
  deleteBook: vi.fn(),
  resetToDefaults,
  uniqueBookId: (base: string) => {
    const slug = base.trim().toLowerCase().replace(/\s+/g, '_');
    const taken = new Set(wbState.books.map((b) => b.id));
    if (!taken.has(slug)) return slug;
    let n = 2;
    while (taken.has(`${slug}_${n}`)) n++;
    return `${slug}_${n}`;
  },
};
vi.mock('../../../../src/ui/stores/worldbook-store', () => ({ useWorldBookStore: () => fakeWb }));

import WorldBookSection from '../../../../src/ui/components/settings/WorldBookSection.vue';

const wrappers: VueWrapper[] = [];
function mountSection() {
  const wrapper = mount(WorldBookSection, {
    attachTo: document.body,
    global: { stubs: { WorldBookEditor: true } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 拦下「选文件」那一下，直接把文件交给 onchange */
async function importFile(wrapper: VueWrapper, name: string, content: string) {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  const btn = wrapper.findAll('button').find((b) => b.text().includes('导入ST世界书'))!;
  await btn.trigger('click');
  const picker = click.mock.contexts[0] as HTMLInputElement;
  click.mockRestore();
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(picker, 'files', { value: [file] });
  (picker.onchange as (e: Event) => void)({ target: picker } as unknown as Event);
  await flushPromises();
}

beforeEach(() => {
  wbState.books = [];
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  toast.mockReset();
  upsertBook.mockClear();
  resetToDefaults.mockReset();
  resetToDefaults.mockResolvedValue(1);
  saveNow.mockReset();
});
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));

describe('WorldBookSection 新建世界书（S-21）', () => {
  it('不调用原生 prompt，改为行内输入行', async () => {
    const promptSpy = vi.fn();
    vi.stubGlobal('prompt', promptSpy);
    const wrapper = mountSection();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('新建世界书'))!
      .trigger('click');
    expect(promptSpy).not.toHaveBeenCalled();
    expect(wrapper.find('#new-book-name').exists()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('同名（完全相同）拒绝并显示行内提示，不写库', async () => {
    wbState.books = [makeBook('test', 'Test', 200)];
    const wrapper = mountSection();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('新建世界书'))!
      .trigger('click');
    await wrapper.get('#new-book-name').setValue('Test');
    await wrapper.get('form.new-book-row').trigger('submit');
    await flushPromises();
    expect(upsertBook).not.toHaveBeenCalled();
    expect(wrapper.get('.new-book-error').text()).toContain('已有同名世界书《Test》');
  });

  it('名字不同但 slug 撞车时生成唯一 id，原书完好', async () => {
    wbState.books = [makeBook('test', 'Test', 200)];
    const wrapper = mountSection();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('新建世界书'))!
      .trigger('click');
    await wrapper.get('#new-book-name').setValue('test');
    await wrapper.get('form.new-book-row').trigger('submit');
    await flushPromises();
    expect(upsertBook).toHaveBeenCalledTimes(1);
    expect(upsertBook.mock.calls[0][0].id).toBe('test_2');
    expect(wbState.books.find((b) => b.id === 'test')!.entries).toHaveLength(200);
  });

  it('空名字提示输入', async () => {
    const wrapper = mountSection();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('新建世界书'))!
      .trigger('click');
    await wrapper.get('form.new-book-row').trigger('submit');
    await flushPromises();
    expect(upsertBook).not.toHaveBeenCalled();
    expect(wrapper.get('.new-book-error').text()).toContain('请输入世界书名称');
  });
});

describe('WorldBookSection 导入 ST 世界书（S-21 / S-28）', () => {
  const stFile = JSON.stringify({ name: '大陆', entries: { 0: { key: ['a'], content: 'x' } } });

  it('没有 entries 的 JSON 被拒绝并说明原因', async () => {
    const wrapper = mountSection();
    await importFile(wrapper, 'random.json', JSON.stringify({ foo: 1 }));
    expect(upsertBook).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('没有 entries'), 'error');
  });

  it('坏 JSON 报「不是有效的 JSON」', async () => {
    const wrapper = mountSection();
    await importFile(wrapper, 'bad.json', '{oops');
    expect(upsertBook).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('不是有效的 JSON'), 'error');
  });

  it('无冲突直接导入，不弹确认', async () => {
    const wrapper = mountSection();
    await importFile(wrapper, 'land.json', stFile);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(upsertBook.mock.calls[0][0].id).toBe('land');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已导入'), 'success');
  });

  it('id 撞车：确认「覆盖」才覆盖，确认框点名原书与条目数', async () => {
    wbState.books = [makeBook('land', '旧大陆', 7)];
    const wrapper = mountSection();
    await importFile(wrapper, 'land.json', stFile);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const opts = confirmDialog.mock.calls[0][0] as { message: string; danger?: boolean };
    expect(opts.message).toContain('覆盖已有的《旧大陆》（7 条目）');
    expect(opts.danger).toBe(true);
    expect(upsertBook.mock.calls[0][0].id).toBe('land');
  });

  it('id 撞车：不覆盖 → 选「导入为副本」得到唯一 id，原书不动', async () => {
    wbState.books = [makeBook('land', '旧大陆', 7)];
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const wrapper = mountSection();
    await importFile(wrapper, 'land.json', stFile);
    expect(upsertBook.mock.calls[0][0].id).toBe('land_2');
    expect(wbState.books.find((b) => b.id === 'land')!.entries).toHaveLength(7);
  });

  it('id 撞车：两次都取消 → 什么都不写', async () => {
    wbState.books = [makeBook('land', '旧大陆', 7)];
    confirmDialog.mockResolvedValue(false);
    const wrapper = mountSection();
    await importFile(wrapper, 'land.json', stFile);
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(upsertBook).not.toHaveBeenCalled();
  });
});

describe('WorldBookSection 恢复全部默认（S-22）', () => {
  it('按钮不在导入/新建工具栏里，而在底部危险区', () => {
    const wrapper = mountSection();
    expect(wrapper.get('.worldbook-actions').text()).not.toContain('恢复');
    expect(wrapper.get('.danger-zone').text()).toContain('恢复全部默认');
  });

  it('确认框点名将被删除的自建/导入书（不列内置书）', async () => {
    wbState.books = [
      makeBook('core', '核心', 3, true),
      makeBook('mine', '我的书', 4),
      makeBook('imp', '导入书', 5),
    ];
    const wrapper = mountSection();
    await wrapper.get('.danger-zone button').trigger('click');
    await flushPromises();
    const opts = confirmDialog.mock.calls[0][0] as {
      message: string;
      details: string[];
      danger: boolean;
    };
    expect(opts.danger).toBe(true);
    expect(opts.message).toContain('2 本');
    expect(opts.details).toEqual(['《我的书》（4 条目）', '《导入书》（5 条目）']);
    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(saveNow).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('世界书已恢复为默认', 'success');
  });

  it('超过 5 本时只列前 5 本并注明余数', async () => {
    wbState.books = Array.from({ length: 7 }, (_, i) => makeBook(`b${i}`, `书${i}`, 1));
    const wrapper = mountSection();
    await wrapper.get('.danger-zone button').trigger('click');
    await flushPromises();
    const details = (confirmDialog.mock.calls[0][0] as { details: string[] }).details;
    expect(details).toHaveLength(6);
    expect(details[5]).toContain('另有 2 本');
  });

  it('取消 → 不执行', async () => {
    confirmDialog.mockResolvedValue(false);
    const wrapper = mountSection();
    await wrapper.get('.danger-zone button').trigger('click');
    await flushPromises();
    expect(resetToDefaults).not.toHaveBeenCalled();
  });

  it('失败 → 报错误提示，不报成功；不走会吞错的 settings-store 包装', async () => {
    resetToDefaults.mockRejectedValue(new Error('未能载入任何默认世界书'));
    const wrapper = mountSection();
    await wrapper.get('.danger-zone button').trigger('click');
    await flushPromises();
    expect(resetWorldBooksToDefaults).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未能载入任何默认世界书'), 'error');
    expect(toast).not.toHaveBeenCalledWith('世界书已恢复为默认', 'success');
  });
});
