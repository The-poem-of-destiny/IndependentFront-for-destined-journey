/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import QuestsPanel from '../../../../src/ui/components/game/QuestsPanel.vue';

enableAutoUnmount(afterEach);

const engine = vi.hoisted(() => ({
  persistFocusQuest: vi.fn(),
  persistQuestStatus: vi.fn(),
  persistRemoveQuest: vi.fn(),
}));
const confirmDialog = vi.hoisted(() => vi.fn());
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
const game = vi.hoisted(() => ({ saveProfile: null as unknown }));

vi.mock('@engine/state/save-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/state/save-profile')>();
  return { ...actual, ...engine };
});
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ui }));

function quest(status: string) {
  return { status, priority: '中', progress: '', detail: '', objective: '', reward: '' };
}

function setQuests(quests: Record<string, ReturnType<typeof quest>>) {
  game.saveProfile = reactive({ saveId: 'save-1', focusQuest: '', quests });
}

function profile() {
  return game.saveProfile as { focusQuest: string; quests: Record<string, { status: string }> };
}

function filterButton(wrapper: ReturnType<typeof mount>, label: string) {
  const btn = wrapper.findAll('.filter-bar button').find((b) => b.text().startsWith(label));
  if (!btn) throw new Error(`找不到筛选按钮 ${label}`);
  return btn;
}

describe('QuestsPanel 筛选复位与任务操作', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine.persistFocusQuest.mockResolvedValue(undefined);
    engine.persistQuestStatus.mockResolvedValue(undefined);
    engine.persistRemoveQuest.mockResolvedValue(undefined);
    confirmDialog.mockResolvedValue(true);
  });

  it('筛选「进行中」后最后一个进行中任务被完成：筛选退回「全部」，列表不变空', async () => {
    setQuests({ 甲: quest('进行中'), 乙: quest('已完成'), 丙: quest('失败') });
    const wrapper = mount(QuestsPanel);
    await filterButton(wrapper, '进行中').trigger('click');
    expect(wrapper.findAll('.quest-card')).toHaveLength(1);

    await wrapper.get('.quest-card .qc-action-btn').trigger('click');
    await flushPromises();

    expect(wrapper.find('.empty').exists()).toBe(false);
    expect(wrapper.findAll('.quest-card')).toHaveLength(3);
    // 只剩「已完成 / 失败」两种状态，筛选条仍显示（三个按钮），且「全部」为选中态
    expect(filterButton(wrapper, '全部').classes()).toContain('active');
  });

  it('只剩一种状态但停在非「全部」筛选上时，筛选条保持可见', async () => {
    setQuests({ 乙: quest('已完成'), 丙: quest('失败') });
    const wrapper = mount(QuestsPanel);
    await filterButton(wrapper, '失败').trigger('click');
    // 「乙」被移走后只剩「失败」一种状态；筛选值仍有效，筛选条必须留着当复位入口
    delete profile().quests['乙'];
    await flushPromises();
    expect(wrapper.find('.filter-bar').exists()).toBe(true);
    expect(filterButton(wrapper, '失败').classes()).toContain('active');
  });

  it('失败任务不提供「标记完成」，改为提供「删除」', async () => {
    setQuests({ 丙: quest('失败') });
    const wrapper = mount(QuestsPanel);
    const btn = wrapper.get('.quest-card .qc-action-btn');
    expect(btn.text()).toBe('删除');
    expect(btn.classes()).toContain('qc-action-danger');
  });

  it('删除前弹危险确认并点名任务；取消则不删除', async () => {
    setQuests({ 乙: quest('已完成') });
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = mount(QuestsPanel);
    await wrapper.get('.quest-card .qc-action-btn').trigger('click');
    await flushPromises();

    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, message: expect.stringContaining('乙') }),
    );
    expect(engine.persistRemoveQuest).not.toHaveBeenCalled();
    expect(profile().quests['乙']).toBeDefined();
  });

  it('删除落库失败：任务放回列表并弹错误提示', async () => {
    setQuests({ 乙: quest('已完成') });
    engine.persistRemoveQuest.mockRejectedValueOnce(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(QuestsPanel);
    await wrapper.get('.quest-card .qc-action-btn').trigger('click');
    await flushPromises();

    expect(engine.persistRemoveQuest).toHaveBeenCalledWith('save-1', '乙');
    expect(profile().quests['乙']).toBeDefined();
    expect(ui.toast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(wrapper.findAll('.quest-card')).toHaveLength(1);
  });

  it('标记完成落库失败：状态回滚并弹错误提示', async () => {
    setQuests({ 甲: quest('进行中') });
    engine.persistQuestStatus.mockRejectedValueOnce(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(QuestsPanel);
    await wrapper.get('.quest-card .qc-action-btn').trigger('click');
    await flushPromises();

    expect(profile().quests['甲'].status).toBe('进行中');
    expect(ui.toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('焦点任务落库失败：选择回滚并弹错误提示', async () => {
    setQuests({ 甲: quest('进行中') });
    engine.persistFocusQuest.mockRejectedValueOnce(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(QuestsPanel);
    await wrapper.get('.focus-select').setValue('甲');
    await flushPromises();

    expect(profile().focusQuest).toBe('');
    expect((wrapper.get('.focus-select').element as HTMLSelectElement).value).toBe('');
    expect(ui.toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
