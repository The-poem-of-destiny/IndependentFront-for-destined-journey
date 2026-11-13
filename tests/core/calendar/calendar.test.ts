import { describe, expect, it } from 'vitest';
import {
  deriveBirthdayItems,
  deriveFestivalItems,
  userEntryItems,
} from '../../../src/core/calendar/calendar-sources';
import {
  buildCalendarItems,
  buildMonthView,
  listUndatedItems,
  listUpcoming,
} from '../../../src/core/calendar/calendar-view';
import { defaultSaveCalendar } from '../../../src/core/calendar/calendar-store';
import type { CollectedLoreKeyDate } from '../../../src/core/content/lore-key-dates';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { LoreKeyDate } from '../../../src/core/types/types';
import type { CalendarItem, SaveCalendar } from '../../../src/core/types/types-calendar';
import { GAME_EPOCH_YEAR } from '../../../src/core/time/time-system';

const Y = GAME_EPOCH_YEAR;
const md = (month: number, day: number) => ({ month, day });
const collected = (id: string, date: Omit<LoreKeyDate, 'id'>): CollectedLoreKeyDate => ({
  key: `fated:faction/x#${id}`,
  bookId: 'faction',
  entryUid: 'fated:faction/x',
  date: { id, ...date },
});

const festivals = deriveFestivalItems([
  collected('opening', {
    name: '开年会',
    when: { precision: 'day', start: md(1, 1) },
    major: true,
  }),
  collected('kites', {
    name: '风筝会',
    when: { precision: 'day', start: md(8, 3), end: md(8, 6) },
    regions: ['东岸'],
    summary: '示例简介',
  }),
  collected('west', {
    name: '西岸节',
    when: { precision: 'day', start: md(7, 16) },
    regions: ['西岸'],
  }),
  collected('monthonly', { name: '某月节', when: { precision: 'month', month: 7 } }),
  collected('undated', { name: '不定期', when: { precision: 'none' } }),
  collected('secret', {
    name: '不公开的日子',
    when: { precision: 'day', start: md(3, 3) },
    public: false,
  }),
]);

function character(name: string, extra: Parameters<typeof createDefaultCharacterState>[0]) {
  return createDefaultCharacterState({ id: `id-${name}`, name, ...extra });
}
const characters = [
  character('向导', {
    ageAnchor: { startAge: 30, month: 3, day: 15 },
    customFields: { birthday: '3月15日' },
  }),
  // 没给生日：锚点里是兜底的 1 月 1 日，不进日历
  character('路人', { ageAnchor: { startAge: 18, month: 1, day: 1 } }),
  character('史莱姆', {
    type: 'monster',
    ageAnchor: { startAge: 2, month: 6, day: 6 },
    customFields: { birthday: '6月6日' },
  }),
  // 开局时 −3 岁、生日 2 月 2 日 = 纪元年 +2 那年的 2 月 2 日出生
  character('幼童', {
    ageAnchor: { startAge: -3, month: 2, day: 2 },
    customFields: { birthday: '2-2' },
  }),
];
const birthdays = deriveBirthdayItems(characters);

const calendar = (patch: Partial<SaveCalendar> = {}): SaveCalendar => ({
  ...defaultSaveCalendar('save'),
  ...patch,
});
const titles = (items: readonly CalendarItem[]) => items.map((i) => i.title);

describe('日历来源', () => {
  it('节庆项沿用关键日期字段，不公开的不自动载入', () => {
    expect(titles(festivals)).toEqual(['开年会', '风筝会', '西岸节', '某月节', '不定期']);
    expect(festivals[1]).toMatchObject({
      key: 'fated:faction/x#kites',
      kind: 'festival',
      note: '示例简介',
      regions: ['东岸'],
    });
  });

  it('生日只收已给定生日的主角与 NPC', () => {
    expect(birthdays.map((b) => [b.key, b.title])).toEqual([
      ['birthday:id-向导', '向导'],
      ['birthday:id-幼童', '幼童'],
    ]);
  });

  it('玩家条目：给了年份的只在那一年', () => {
    const [yearly, once] = userEntryItems([
      { id: 'a', title: '约定', start: md(4, 4), createdAt: 1 },
      { id: 'b', title: '出发日', start: md(4, 5), end: md(4, 7), year: Y + 1, createdAt: 1 },
    ]);
    expect(yearly).toMatchObject({ key: 'user:a', kind: 'user' });
    expect(yearly.repeat).toBeUndefined();
    expect(once.repeat).toEqual({ unit: 'once', year: Y + 1 });
  });
});

describe('模式与显示选择', () => {
  const entries = [{ id: 'a', title: '约定', start: md(4, 4), createdAt: 1 }];

  it('沉浸模式只有玩家条目，自动来源完全不参与', () => {
    expect(
      titles(
        buildCalendarItems({
          calendar: calendar({ mode: 'immersive', entries }),
          festivals,
          birthdays,
        }),
      ),
    ).toEqual(['约定']);
  });

  it('普通模式合并三类来源', () => {
    expect(
      titles(buildCalendarItems({ calendar: calendar({ entries }), festivals, birthdays })),
    ).toEqual(['约定', '开年会', '风筝会', '西岸节', '某月节', '不定期', '向导', '幼童']);
  });

  it('三层隐藏：类别 / 地区 / 逐项；玩家条目不受影响', () => {
    const hide = (patch: Partial<SaveCalendar>) =>
      titles(
        buildCalendarItems({ calendar: calendar({ entries, ...patch }), festivals, birthdays }),
      );
    expect(hide({ hiddenKinds: ['birthday'] })).not.toContain('向导');
    expect(hide({ hiddenKinds: ['festival'] })).toEqual(['约定', '向导', '幼童']);
    expect(hide({ hiddenRegions: ['西岸'] })).not.toContain('西岸节');
    expect(hide({ hiddenRegions: ['西岸'] })).toContain('开年会');
    expect(hide({ hiddenKeys: ['fated:faction/x#opening', 'birthday:id-向导', 'user:a'] })).toEqual(
      ['约定', '风筝会', '西岸节', '某月节', '不定期', '幼童'],
    );
  });

  it('只看所在地区：按位置路径匹配，无地区的全大陆节庆始终显示', () => {
    const local = (locationPath: string[]) =>
      titles(
        buildCalendarItems({
          calendar: calendar({ localRegionOnly: true }),
          festivals,
          birthdays: [],
          locationPath,
        }),
      );
    expect(local(['大陆', '东岸', '某镇'])).toEqual(['开年会', '风筝会', '某月节', '不定期']);
    expect(local([])).toEqual(['开年会', '某月节', '不定期']);
  });
});

describe('月视图与近期列表', () => {
  const items = buildCalendarItems({ calendar: calendar(), festivals, birthdays });

  it('每月 30 格，星期连续，纪元年 1 月 1 日是周日', () => {
    const jan = buildMonthView(Y, 1, items, { year: Y, month: 1, day: 1 });
    expect(jan.days).toHaveLength(30);
    expect(jan.days[0]).toMatchObject({ day: 1, weekday: 1, isToday: true });
    expect(jan.days.map((d) => d.weekday).slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 1, 2]);
    // 30 天 = 4 周 + 2 天，所以 2 月 1 日比 1 月 1 日晚两个星期位
    expect(buildMonthView(Y, 2, items).days[0].weekday).toBe(3);
    expect(titles(jan.days[0].items.map((i) => i.item))).toEqual(['开年会']);
    expect(jan.days.filter((d) => d.isToday)).toHaveLength(1);
  });

  it('多日节庆连成一段；只到月的项不占日期格', () => {
    const august = buildMonthView(Y, 8, items);
    expect(august.days.filter((d) => d.items.length > 0).map((d) => d.day)).toEqual([3, 4, 5, 6]);
    const july = buildMonthView(Y, 7, items);
    expect(titles(july.undated)).toEqual(['某月节']);
    expect(july.days[15].items.map((i) => i.item.title)).toEqual(['西岸节']);
    expect(titles(listUndatedItems(items, Y))).toEqual(['不定期']);
  });

  it('没有具体日期的项同样遵守重复规则：不办的年份不列出', () => {
    const undated = deriveFestivalItems([
      collected('once', {
        name: '只办一次',
        when: { precision: 'none' },
        repeat: { unit: 'once', year: Y + 2 },
      }),
      collected('fifth', {
        name: '五年一度',
        when: { precision: 'season', season: 'autumn' },
        repeat: { unit: 'year', interval: 5, anchorYear: Y },
      }),
    ]);
    expect(titles(listUndatedItems(undated, Y))).toEqual(['五年一度']);
    expect(titles(listUndatedItems(undated, Y + 1))).toEqual([]);
    expect(titles(listUndatedItems(undated, Y + 2))).toEqual(['只办一次']);
    expect(titles(listUndatedItems(undated, Y + 5))).toEqual(['五年一度']);
  });

  it('生日显示当年满几岁；尚未出生的年份不显示', () => {
    const ageOn = (year: number, month: number, day: number, title: string) =>
      buildMonthView(year, month, items).days[day - 1].items.find((i) => i.item.title === title)
        ?.age;
    expect(ageOn(Y, 3, 15, '向导')).toBe(31);
    expect(ageOn(Y + 10, 3, 15, '向导')).toBe(41);
    expect(ageOn(Y + 1, 2, 2, '幼童')).toBeUndefined(); // 还没出生
    expect(ageOn(Y + 2, 2, 2, '幼童')).toBeUndefined(); // 出生当天，0 岁不算生日
    expect(ageOn(Y + 3, 2, 2, '幼童')).toBe(1);
  });

  it('近期列表按日期排列，每项只列一次，进行中的多日节庆算今天，可跨年', () => {
    const upcoming = listUpcoming(items, { year: Y, month: 8, day: 4 }, 30);
    expect(upcoming.map((u) => [u.item.title, u.daysAway])).toEqual([['风筝会', 0]]);
    const yearEnd = listUpcoming(items, { year: Y, month: 12, day: 25 }, 30);
    expect(yearEnd.map((u) => [u.item.title, u.date, u.daysAway])).toEqual([
      ['开年会', { year: Y + 1, month: 1, day: 1 }, 6],
    ]);
    expect(listUpcoming(items, { year: Y, month: 3, day: 14 }, 2)[0]).toMatchObject({
      age: 31,
      daysAway: 1,
    });
  });
});
