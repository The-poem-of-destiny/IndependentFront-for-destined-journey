/**
 * OpeningPromptEditor — 建档最后一步的开局提示词预览与编辑
 *
 * 覆盖:
 * - 文本框显示 store 的 openingPromptText，输入经 setOpeningPromptText 写回
 * - 提示「原样作为第一条消息发出」
 * - 「恢复默认」没改过时禁用；改过时先确认，确认才恢复、取消不动
 * - 过期提示只在 openingPromptStale 时出现
 * - 建档提交中整块禁用
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import OpeningPromptEditor from '../../../../src/ui/components/create/OpeningPromptEditor.vue';

let mockStore: any;
const confirmDialogMock = vi.fn();

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockStore,
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockStore = reactive({
    openingPromptText: '默认开场提示词',
    openingPromptEdited: false,
    openingPromptStale: false,
    isCreating: false,
    setOpeningPromptText: vi.fn(),
    restoreDefaultOpeningPrompt: vi.fn(),
  });
});

function restoreButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll('button').find((b) => b.text() === '恢复默认');
  if (!btn) throw new Error('找不到「恢复默认」按钮');
  return btn;
}

describe('OpeningPromptEditor', () => {
  it('标题与原样发送提示', () => {
    const wrapper = mount(OpeningPromptEditor);
    expect(wrapper.find('h3').text()).toBe('开局提示词');
    expect(wrapper.find('.op-hint').text()).toContain('原样作为第一条消息发出');
  });

  it('文本框显示 store 当前文本，输入经 setOpeningPromptText 写回', async () => {
    const wrapper = mount(OpeningPromptEditor);
    const textarea = wrapper.find('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('默认开场提示词');

    await textarea.setValue('玩家改写的开场');
    expect(mockStore.setOpeningPromptText).toHaveBeenCalledWith('玩家改写的开场');
  });

  it('store 文本变化时文本框跟着更新', async () => {
    const wrapper = mount(OpeningPromptEditor);
    mockStore.openingPromptText = '建档选择变了之后的新默认';
    await flushPromises();
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(
      '建档选择变了之后的新默认',
    );
  });

  it('没改过时「恢复默认」禁用', () => {
    const wrapper = mount(OpeningPromptEditor);
    expect(restoreButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('改过时点「恢复默认」先确认，确认后才恢复', async () => {
    mockStore.openingPromptEdited = true;
    confirmDialogMock.mockResolvedValue(true);
    const wrapper = mount(OpeningPromptEditor);

    const btn = restoreButton(wrapper);
    expect(btn.attributes('disabled')).toBeUndefined();
    await btn.trigger('click');
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(mockStore.restoreDefaultOpeningPrompt).toHaveBeenCalledTimes(1);
  });

  it('取消确认时不恢复', async () => {
    mockStore.openingPromptEdited = true;
    confirmDialogMock.mockResolvedValue(false);
    const wrapper = mount(OpeningPromptEditor);

    await restoreButton(wrapper).trigger('click');
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(mockStore.restoreDefaultOpeningPrompt).not.toHaveBeenCalled();
  });

  it('过期提示只在 openingPromptStale 时出现', async () => {
    const wrapper = mount(OpeningPromptEditor);
    expect(wrapper.find('.op-stale').exists()).toBe(false);

    mockStore.openingPromptEdited = true;
    mockStore.openingPromptStale = true;
    await flushPromises();
    const stale = wrapper.find('.op-stale');
    expect(stale.exists()).toBe(true);
    expect(stale.text()).toContain('默认提示词已经随之变化');
    expect(stale.text()).toContain('恢复默认');
  });

  it('建档提交中文本框与「恢复默认」都禁用', () => {
    mockStore.openingPromptEdited = true;
    mockStore.isCreating = true;
    const wrapper = mount(OpeningPromptEditor);
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
    expect(restoreButton(wrapper).attributes('disabled')).toBeDefined();
  });
});
