/**
 * 标签词库卡（图像 v1.4）
 *
 * 三件事值得钉住：
 *
 * 1. **导入报告如实分类**。几千条语料里一定有读不懂的写法，只报成功数会让用户
 *    以为整本都进来了 —— 跳过 / 存疑 / 修过 / 重名 四类都要露面。
 *
 * 2. **目录成本摆在明面上**。目录每张图发一遍，用户得有依据决定停用哪本。
 *
 * 3. 🔴 **检索预览用的是 `searchTagEntries` 本尊**，与 `search_image_tags` 工具同一个
 *    函数。另写一份模糊匹配的话，预览看着好好的、真出图时 AI 查不到 ——
 *    而这不会有任何报错。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { TagBank } from '@engine/types-image';

// ---- Dexie 层：jsdom 下不可用，整层替成内存表 ----
const table = new Map<string, TagBank>();

vi.mock('@engine/database', () => ({
  getTagBanks: vi.fn(async () => [...table.values()]),
  saveTagBank: vi.fn(async (row: TagBank) => {
    table.set(row.id, row);
  }),
  deleteTagBank: vi.fn(async (id: string) => {
    table.delete(id);
  }),
}));

const toasts: Array<{ text: string; kind: string }> = [];
vi.mock('../../../stores/ui-store', () => ({
  useUIStore: () => ({
    toast: (text: string, kind = 'info') => toasts.push({ text, kind }),
    activeSaveId: null,
  }),
}));

import ImageTagBankCard from './ImageTagBankCard.vue';
import { useImageTagBankStore } from '../../../stores/image-tag-bank-store';

/** 一份带「一条读不懂」的语料，用来验报告分类 */
const LOREBOOK = {
  entries: {
    '0': { uid: 0, key: ['温泉'], comment: '[场景]：温泉', content: '- 温泉：onsen, hot spring' },
    '1': {
      uid: 1,
      key: ['兽耳', '猫耳'],
      comment: '[特征]：兽耳',
      content: '- 兽耳：animal ears/cat ears',
    },
    // 没有标签 → 跳过并留痕
    '2': { uid: 2, comment: '[场景]：空的', content: '' },
  },
};

async function mountCard() {
  setActivePinia(createPinia());
  const wrapper = mount(ImageTagBankCard);
  await flushPromises();
  return wrapper;
}

describe('ImageTagBankCard', () => {
  beforeEach(() => {
    table.clear();
    toasts.length = 0;
  });

  it('还没有词库时说明「没有也能出图」，不吓唬人', async () => {
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('没有也能出图');
  });

  it('导入后列出词库、条数与目录成本', async () => {
    const wrapper = await mountCard();
    const store = useImageTagBankStore();

    const r = await store.importFromJson(LOREBOOK, '我的词库', 'tags.json');
    expect(r.ok).toBe(true);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('我的词库');
    expect(text).toContain('2 条');
    // 目录成本必须露面 —— 它每张图都要发一遍
    expect(text).toContain('每次出图都会发一遍');
  });

  it('🔴 停用整本后目录成本归零（界面与实际生效范围一致）', async () => {
    const wrapper = await mountCard();
    const store = useImageTagBankStore();
    const r = await store.importFromJson(LOREBOOK, '词库');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await flushPromises();
    expect(wrapper.text()).toContain('每次出图都会发一遍');

    await store.setEnabled(r.value.bank.id, false);
    await flushPromises();
    expect(wrapper.text()).not.toContain('每次出图都会发一遍');
  });

  it('检索预览走 searchTagEntries 本尊：查「猫耳」能出名为「兽耳」的那条', async () => {
    const wrapper = await mountCard();
    const store = useImageTagBankStore();
    await store.importFromJson(LOREBOOK, '词库');
    await flushPromises();

    const input = wrapper.find('#tag-bank-probe');
    expect(input.exists()).toBe(true);
    await input.setValue('猫耳');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('兽耳');
    // 预览要显示真标签（AI 拿到的就是这些字节）
    expect(text).toContain('animal ears | cat ears');
  });

  it('查不到时明说 AI 会自己写，而不是留一片空白', async () => {
    const wrapper = await mountCard();
    const store = useImageTagBankStore();
    await store.importFromJson(LOREBOOK, '词库');
    await flushPromises();

    await wrapper.find('#tag-bank-probe').setValue('外太空歌剧院');
    await flushPromises();
    expect(wrapper.text()).toContain('AI 会自己写');
  });

  it('删除要经确认，取消则不删', async () => {
    const wrapper = await mountCard();
    const store = useImageTagBankStore();
    await store.importFromJson(LOREBOOK, '词库');
    await flushPromises();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const delButton = wrapper.findAll('button').find((b) => b.text() === '删除');
    expect(delButton).toBeDefined();
    await delButton!.trigger('click');
    await flushPromises();

    expect(store.banks).toHaveLength(1);
    confirmSpy.mockRestore();
  });
});
