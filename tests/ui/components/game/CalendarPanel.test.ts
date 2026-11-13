/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import CalendarPanel from '../../../../src/ui/components/game/CalendarPanel.vue';
import { defaultSaveCalendar } from '../../../../src/core/calendar/calendar-store';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import { GAME_EPOCH_YEAR, createDefaultTime } from '../../../../src/core/time/time-system';
import type { SaveCalendar } from '../../../../src/core/types/types-calendar';

enableAutoUnmount(afterEach);

const Y = GAME_EPOCH_YEAR;
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
const game = vi.hoisted(() => ({ value: null as unknown as Record<string, unknown> }));
const books = vi.hoisted(() => ({ value: [] as unknown[] }));
const calendarStore = vi.hoisted(() => ({ value: null as unknown as Record<string, unknown> }));

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => game.value }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ui }));
vi.mock('../../../../src/ui/stores/worldbook-store', () => ({
  useWorldBookStore: () => ({ books: books.value }),
}));
vi.mock('../../../../src/ui/stores/calendar-store', () => ({
  useCalendarStore: () => calendarStore.value,
}));

function setup(calendar: Partial<SaveCalendar> = {}) {
  calendarStore.value = reactive({
    calendar: { ...defaultSaveCalendar('save-1'), ...calendar },
    load: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    saveEntry: vi.fn().mockResolvedValue(undefined),
    deleteEntry: vi.fn().mockResolvedValue(undefined),
    setVisibility: vi.fn().mockResolvedValue(undefined),
  });
  return mount(CalendarPanel);
}

beforeEach(() => {
  vi.clearAllMocks();
  game.value = reactive({
    activeSaveId: 'save-1',
    activeSave: { metadata: {} },
    // 纪元年 1 月 1 日 08:00
    gameTime: { ...createDefaultTime('示例纪元') },
    player: { location: '北境联盟/河谷公国' },
    characters: [
      createDefaultCharacterState({
        id: 'npc-1',
        name: '向导',
        ageAnchor: { startAge: 30, month: 1, day: 3 },
        customFields: { birthday: '1月3日' },
      }),
      // 没给生日：不进日历
      createDefaultCharacterState({
        id: 'npc-2',
        name: '路人',
        ageAnchor: { startAge: 18, month: 1, day: 1 },
      }),
    ],
  });
  books.value = [
    {
      id: 'world',
      name: 'world',
      partition: 'world_setting',
      entries: [
        {
          uid: 'fated:world_setting/overview',
          name: 'overview',
          content: '只给模型读的正文',
          enabled: true,
          extra: {
            lore: {
              keyDates: [
                {
                  id: 'creation',
                  name: '新年',
                  when: { precision: 'day', start: { month: 1, day: 1 } },
                  summary: '岁首，新年',
                  major: true,
                },
                {
                  id: 'griffin',
                  name: '建国节',
                  when: { precision: 'day', start: { month: 1, day: 5 } },
                  regions: ['中央帝国'],
                },
                { id: 'fishing', name: '钓鱼大赛', when: { precision: 'none' } },
              ],
            },
          },
        },
      ],
    },
  ];
});

describe('CalendarPanel', () => {
  it('普通模式：30 格月视图，今天高亮，节庆与给定生日自动出现', async () => {
    const wrapper = setup();
    await flushPromises();
    expect(calendarStore.value.load).toHaveBeenCalledWith('save-1');
    expect(wrapper.findAll('.cal-cell')).toHaveLength(30);
    expect(wrapper.find('.cal-title').text()).toContain(`示例纪元${Y}年 · 1月`);
    const today = wrapper.get('[data-day="1"]');
    expect(today.classes()).toContain('today');
    expect(today.attributes('aria-current')).toBe('date');
    expect(today.text()).toContain('新年');
    expect(wrapper.get('[data-day="5"]').text()).toContain('建国节');
    expect(wrapper.get('[data-day="3"]').text()).toContain('向导');
    // 兜底生日的角色不出现；条目正文不展示
    expect(wrapper.text()).not.toContain('路人');
    expect(wrapper.text()).not.toContain('只给模型读的正文');
    // 当日详情默认是今天；日期未定的项单独列出
    expect(wrapper.get('[data-section="day"]').text()).toContain('岁首，新年');
    expect(wrapper.get('[data-section="undated"]').text()).toContain('钓鱼大赛');
  });

  it('生日详情显示当年满几岁', async () => {
    const wrapper = setup();
    await wrapper.get('[data-day="3"]').trigger('click');
    expect(wrapper.get('[data-section="day"]').text()).toContain('向导的生日 · 满 31 岁');
  });

  it('沉浸模式：只有玩家条目，连「显示选择」入口都没有', async () => {
    const wrapper = setup({
      mode: 'immersive',
      entries: [{ id: 'a', title: '约定之日', start: { month: 1, day: 1 }, createdAt: 1 }],
    });
    await flushPromises();
    expect(wrapper.get('[data-day="1"]').text()).toContain('约定之日');
    expect(wrapper.text()).not.toContain('新年');
    expect(wrapper.text()).not.toContain('向导');
    expect(wrapper.text()).not.toContain('钓鱼大赛');
    expect(wrapper.find('[data-action="filters"]').exists()).toBe(false);
    expect(wrapper.get('[data-mode="immersive"]').attributes('aria-pressed')).toBe('true');
  });

  it('切换模式只调写入口，不动别的', async () => {
    const wrapper = setup();
    await wrapper.get('[data-mode="immersive"]').trigger('click');
    expect(calendarStore.value.setMode).toHaveBeenCalledWith('save-1', 'immersive');
    await wrapper.get('[data-mode="normal"]').trigger('click');
    expect(calendarStore.value.setMode).toHaveBeenCalledTimes(1); // 已经是普通模式，不重复写
  });

  it('记一个日子：标题为空不能保存，填好后按选中的日期落库', async () => {
    const wrapper = setup();
    await wrapper.get('[data-day="9"]').trigger('click');
    await wrapper.get('[data-action="add"]').trigger('click');
    const save = wrapper.get('[data-action="save"]');
    expect(save.attributes('disabled')).toBeDefined();
    await wrapper.get('[data-section="editor"] input.cal-input').setValue('  出发  ');
    expect(save.attributes('disabled')).toBeUndefined();
    await save.trigger('click');
    await flushPromises();
    expect(calendarStore.value.saveEntry).toHaveBeenCalledWith(
      'save-1',
      expect.objectContaining({ title: '出发', start: { month: 1, day: 9 } }),
    );
    const saved = (calendarStore.value.saveEntry as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(saved.year).toBeUndefined(); // 默认每年重复
    expect(saved.end).toBeUndefined();
    expect(wrapper.find('[data-section="editor"]').exists()).toBe(false);
  });

  it('玩家条目可修改与删除；自动项只能「不再显示」', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = setup({
      entries: [{ id: 'a', title: '约定之日', start: { month: 1, day: 1 }, createdAt: 1 }],
    });
    const mine = wrapper.get('[data-key="user:a"]');
    expect(mine.find('[data-action="hide"]').exists()).toBe(false);
    await mine.get('[data-action="delete"]').trigger('click');
    expect(calendarStore.value.deleteEntry).toHaveBeenCalledWith('save-1', 'a');

    const festival = wrapper.get('[data-key="fated:world_setting/overview#creation"]');
    expect(festival.find('[data-action="edit"]').exists()).toBe(false);
    await festival.get('[data-action="hide"]').trigger('click');
    expect(calendarStore.value.setVisibility).toHaveBeenCalledWith('save-1', {
      hiddenKeys: ['fated:world_setting/overview#creation'],
    });
  });

  it('显示选择：被隐藏的项仍列在抽屉里，可以勾回来；类别与地区各有总开关', async () => {
    const wrapper = setup({ hiddenKeys: ['birthday:npc-1'], hiddenRegions: ['中央帝国'] });
    expect(wrapper.get('[data-day="3"]').text()).not.toContain('向导');
    expect(wrapper.get('[data-day="5"]').text()).not.toContain('建国节');
    await wrapper.get('[data-action="filters"]').trigger('click');
    const drawer = wrapper.get('[data-section="filters"]');
    expect(drawer.text()).toContain('建国节');
    expect(drawer.text()).toContain('通行各地');

    const birthday = drawer.get('[data-key="birthday:npc-1"]');
    expect((birthday.element as HTMLInputElement).checked).toBe(false);
    await birthday.trigger('change');
    expect(calendarStore.value.setVisibility).toHaveBeenLastCalledWith('save-1', {
      hiddenKeys: [],
    });

    await drawer.get('[data-kind="festival"]').trigger('change');
    expect(calendarStore.value.setVisibility).toHaveBeenLastCalledWith('save-1', {
      hiddenKinds: ['festival'],
    });
  });

  it('只看所在地区：不在该地区的节庆不显示', async () => {
    const wrapper = setup({ localRegionOnly: true });
    expect(wrapper.get('[data-day="1"]').text()).toContain('新年');
    expect(wrapper.get('[data-day="5"]').text()).not.toContain('建国节');
  });

  it('翻月与回到今天', async () => {
    const wrapper = setup();
    await wrapper.get('[aria-label="上一月"]').trigger('click');
    expect(wrapper.find('.cal-title').text()).toContain(`${Y - 1}年 · 12月`);
    expect(wrapper.find('.cal-cell.today').exists()).toBe(false);
    await wrapper.get('[aria-label="下一月"]').trigger('click');
    await wrapper.get('[aria-label="下一月"]').trigger('click');
    expect(wrapper.find('.cal-title').text()).toContain(`${Y}年 · 2月`);
    // 2 月 1 日是周二：前面空两格
    expect(wrapper.findAll('.cal-blank')).toHaveLength(2);
  });
});
