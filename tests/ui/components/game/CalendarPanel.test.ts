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
    failedSaveId: null,
    setHidden: vi.fn().mockResolvedValue(undefined),
    setLocalRegionOnly: vi.fn().mockResolvedValue(undefined),
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
    player: { location: '大陆/东岸' },
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
                  id: 'opening',
                  name: '开年会',
                  when: { precision: 'day', start: { month: 1, day: 1 } },
                  summary: '示例简介',
                  major: true,
                },
                {
                  id: 'west',
                  name: '西岸节',
                  when: { precision: 'day', start: { month: 1, day: 5 } },
                  regions: ['西岸'],
                },
                { id: 'undated', name: '不定期', when: { precision: 'none' } },
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
    expect(today.text()).toContain('开年会');
    expect(wrapper.get('[data-day="5"]').text()).toContain('西岸节');
    expect(wrapper.get('[data-day="3"]').text()).toContain('向导');
    // 兜底生日的角色不出现；条目正文不展示
    expect(wrapper.text()).not.toContain('路人');
    expect(wrapper.text()).not.toContain('只给模型读的正文');
    // 当日详情默认是今天；日期未定的项单独列出
    expect(wrapper.get('[data-section="day"]').text()).toContain('示例简介');
    expect(wrapper.get('[data-section="undated"]').text()).toContain('不定期');
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
    expect(wrapper.text()).not.toContain('开年会');
    expect(wrapper.text()).not.toContain('向导');
    expect(wrapper.text()).not.toContain('不定期');
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

    const festival = wrapper.get('[data-key="fated:world_setting/overview#opening"]');
    expect(festival.find('[data-action="edit"]').exists()).toBe(false);
    await festival.get('[data-action="hide"]').trigger('click');
    expect(calendarStore.value.setHidden).toHaveBeenCalledWith(
      'save-1',
      { key: 'fated:world_setting/overview#opening' },
      true,
    );
  });

  it('显示选择：被隐藏的项仍列在抽屉里，可以勾回来；类别与地区各有总开关', async () => {
    const wrapper = setup({ hiddenKeys: ['birthday:npc-1'], hiddenRegions: ['西岸'] });
    expect(wrapper.get('[data-day="3"]').text()).not.toContain('向导');
    expect(wrapper.get('[data-day="5"]').text()).not.toContain('西岸节');
    await wrapper.get('[data-action="filters"]').trigger('click');
    const drawer = wrapper.get('[data-section="filters"]');
    expect(drawer.text()).toContain('西岸节');
    expect(drawer.text()).toContain('通行各地');

    const birthday = drawer.get('[data-key="birthday:npc-1"]');
    expect((birthday.element as HTMLInputElement).checked).toBe(false);
    await birthday.trigger('change');
    expect(calendarStore.value.setHidden).toHaveBeenLastCalledWith(
      'save-1',
      { key: 'birthday:npc-1' },
      false,
    );

    await drawer.get('[data-kind="festival"]').trigger('change');
    expect(calendarStore.value.setHidden).toHaveBeenLastCalledWith(
      'save-1',
      { kind: 'festival' },
      true,
    );
  });

  it('只看所在地区：不在该地区的节庆不显示', async () => {
    const wrapper = setup({ localRegionOnly: true });
    expect(wrapper.get('[data-day="1"]').text()).toContain('开年会');
    expect(wrapper.get('[data-day="5"]').text()).not.toContain('西岸节');
  });

  it('日历行读到之前不显示任何自动来源，也不能写（沉浸模式存档不会在加载中露底）', async () => {
    const wrapper = setup();
    calendarStore.value.calendar = null;
    await flushPromises();
    expect(wrapper.get('[data-section="loading"]').text()).toContain('正在读取日历');
    expect(wrapper.find('.cal-cell').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('开年会');
    expect(wrapper.text()).not.toContain('向导');
    expect(wrapper.find('[data-action="filters"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="add"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-mode="immersive"]').trigger('click');
    expect(calendarStore.value.setMode).not.toHaveBeenCalled();
  });

  it('读取失败时停在失败态并可重试，不退回普通模式', async () => {
    const wrapper = setup();
    calendarStore.value.calendar = null;
    calendarStore.value.failedSaveId = 'save-1';
    await flushPromises();
    expect(wrapper.get('[data-section="loading"]').text()).toContain('日历读取失败');
    expect(wrapper.text()).not.toContain('开年会');
    (calendarStore.value.load as ReturnType<typeof vi.fn>).mockClear();
    await wrapper.get('[data-action="retry"]').trigger('click');
    expect(calendarStore.value.load).toHaveBeenCalledWith('save-1');
  });

  it('数字框里的非法日期不能保存；保存失败时保留草稿', async () => {
    const wrapper = setup();
    await wrapper.get('[data-action="add"]').trigger('click');
    const editor = wrapper.get('[data-section="editor"]');
    await editor.get('input.cal-input').setValue('出发');
    const save = wrapper.get('[data-action="save"]');
    const startDay = editor.get('[aria-label="开始日"]');
    for (const bad of ['31', '0', '1.5', '']) {
      await startDay.setValue(bad);
      expect(save.attributes('disabled'), `日 = ${JSON.stringify(bad)}`).toBeDefined();
    }
    await startDay.setValue('12');
    expect(save.attributes('disabled')).toBeUndefined();

    (calendarStore.value.saveEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk full'),
    );
    await save.trigger('click');
    await flushPromises();
    expect(ui.toast).toHaveBeenCalledWith('保存失败', 'error');
    const stillOpen = wrapper.get('[data-section="editor"]');
    expect((stillOpen.get('input.cal-input').element as HTMLInputElement).value).toBe('出发');
  });

  it('指定年份时年份必须是整数：清空后不能保存，而不是悄悄变成每年重复', async () => {
    const wrapper = setup();
    await wrapper.get('[data-action="add"]').trigger('click');
    const editor = wrapper.get('[data-section="editor"]');
    await editor.get('input.cal-input').setValue('出发');
    const yearly = editor
      .findAll('input[type="checkbox"]')
      .find((box) => box.element.parentElement?.textContent?.includes('每年重复'))!;
    await yearly.setValue(false);
    const save = wrapper.get('[data-action="save"]');
    expect(save.attributes('disabled')).toBeUndefined();
    await editor.get('[aria-label="年份"]').setValue('');
    expect(save.attributes('disabled')).toBeDefined();
  });

  it('多地区节庆：只隐藏其中一个地区时仍显示，抽屉里也仍可单独隐藏', async () => {
    (
      books.value[0] as { entries: Array<{ extra: { lore: { keyDates: unknown[] } } }> }
    ).entries[0].extra.lore.keyDates.push({
      id: 'both',
      name: '两岸节',
      when: { precision: 'day', start: { month: 1, day: 8 } },
      regions: ['西岸', '东岸'],
    });
    const wrapper = setup({ hiddenRegions: ['西岸'] });
    expect(wrapper.get('[data-day="8"]').text()).toContain('两岸节');
    await wrapper.get('[data-action="filters"]').trigger('click');
    const box = wrapper.get('[data-key="fated:world_setting/overview#both"]');
    expect((box.element as HTMLInputElement).disabled).toBe(false);
    // 只属于被隐藏地区的那一项则是禁用的
    expect(
      (wrapper.get('[data-key="fated:world_setting/overview#west"]').element as HTMLInputElement)
        .disabled,
    ).toBe(true);
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
