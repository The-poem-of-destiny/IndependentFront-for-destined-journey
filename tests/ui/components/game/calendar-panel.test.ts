import { describe, expect, it } from 'vitest';
import {
  draftFromEntry,
  entryFromDraft,
  formatItemDate,
  formatItemRepeat,
  groupFestivalsByRegion,
  hiddenByRegions,
  itemTitle,
  newEntryDraft,
} from '../../../../src/ui/components/game/calendar-panel';
import type { CalendarItem } from '../../../../src/core/types/types-calendar';

const item = (patch: Partial<CalendarItem>): CalendarItem => ({
  key: 'k',
  kind: 'festival',
  title: '节',
  when: { precision: 'none' },
  ...patch,
});

describe('calendar-panel 展示层', () => {
  it('日期措辞覆盖各种精度与范围', () => {
    const day = (m: number, d: number) => ({ month: m, day: d });
    const text = (patch: Partial<CalendarItem>) => formatItemDate(item(patch));
    expect(text({ when: { precision: 'day', start: day(9, 8) } })).toBe('9月8日');
    expect(text({ when: { precision: 'day', start: day(9, 8), end: day(9, 14) } })).toBe(
      '9月8日–14日',
    );
    expect(text({ when: { precision: 'day', start: day(12, 29), end: day(1, 2) } })).toBe(
      '12月29日–1月2日',
    );
    expect(text({ when: { precision: 'day', start: day(9, 8), end: day(9, 8) } })).toBe('9月8日');
    expect(
      text({ when: { precision: 'day', start: { day: 15 } }, repeat: { unit: 'month' } }),
    ).toBe('每月15日');
    expect(text({ when: { precision: 'month', month: 5 } })).toBe('5月（日期未定）');
    expect(text({ when: { precision: 'season', season: 'spring' } })).toBe('春季（日期未定）');
    expect(text({ when: { precision: 'none' } })).toBe('日期未定');
    expect(text({ when: { precision: 'none' }, repeat: { unit: 'month' } })).toBe(
      '每月（日期未定）',
    );
  });

  it('重复说明只在不是每年一次时出现', () => {
    expect(formatItemRepeat(item({}))).toBe('');
    expect(formatItemRepeat(item({ repeat: { unit: 'year' } }))).toBe('');
    expect(formatItemRepeat(item({ repeat: { unit: 'year', interval: 4, anchorYear: 488 } }))).toBe(
      '每 4 年一次',
    );
    expect(formatItemRepeat(item({ repeat: { unit: 'once', year: 490 } }))).toBe('仅 490 年');
  });

  it('生日标题带岁数', () => {
    expect(itemTitle(item({ kind: 'birthday', title: '向导' }), 31)).toBe('向导的生日 · 满 31 岁');
    expect(itemTitle(item({ kind: 'birthday', title: '向导' }))).toBe('向导的生日');
    expect(itemTitle(item({ title: '新年' }), 3)).toBe('新年');
  });

  it('节庆按地区分组，通行各地的排最前', () => {
    const groups = groupFestivalsByRegion([
      item({ key: 'a', regions: ['东岸'] }),
      item({ key: 'b' }),
      item({ key: 'c', regions: ['西岸', '西岸南部'] }),
      item({ key: 'd', regions: ['东岸'] }),
    ]);
    expect(groups[0].region).toBe('');
    expect(groups.map((g) => [g.region, g.items.map((i) => i.key)])).toEqual(
      expect.arrayContaining([
        ['', ['b']],
        ['东岸', ['a', 'd']],
        ['西岸', ['c']],
      ]),
    );
  });

  it('草稿里的非法数字一律不产出条目', () => {
    const valid = { ...newEntryDraft({ year: 488, month: 4, day: 4 }), title: '出发' };
    const reject = (patch: object) => entryFromDraft({ ...valid, ...patch }, () => 'new');
    expect(reject({})).not.toBeNull();
    for (const patch of [
      { startDay: 31 },
      { startDay: 0 },
      { startDay: 1.5 },
      { startDay: '' },
      { startMonth: 13 },
      { multiDay: true, endDay: 31 },
      { multiDay: true, endMonth: 0 },
      { yearly: false, year: '' },
      { yearly: false, year: 490.5 },
    ])
      expect(reject(patch), JSON.stringify(patch)).toBeNull();
    // 不持续多天 / 每年重复时，对应的输入不参与校验
    expect(reject({ multiDay: false, endDay: 99 })).not.toBeNull();
    expect(reject({ yearly: true, year: '' })).not.toBeNull();
  });

  it('多地区的项：所列地区全部隐藏才算被地区层隐藏', () => {
    const hidden = new Set(['西岸']);
    expect(hiddenByRegions({ regions: ['西岸'] }, hidden)).toBe(true);
    expect(hiddenByRegions({ regions: ['西岸', '东岸'] }, hidden)).toBe(false);
    expect(hiddenByRegions({}, hidden)).toBe(false);
  });

  it('草稿与条目互转', () => {
    const draft = newEntryDraft({ year: 488, month: 4, day: 4 });
    expect(entryFromDraft(draft, () => 'new')).toBeNull(); // 标题为空
    draft.title = ' 出发 ';
    expect(entryFromDraft(draft, () => 'new')).toEqual({
      id: 'new',
      title: '出发',
      start: { month: 4, day: 4 },
    });
    Object.assign(draft, { multiDay: true, endDay: 7, yearly: false, year: 490, note: ' 带干粮 ' });
    const entry = entryFromDraft(draft, () => 'new')!;
    expect(entry).toEqual({
      id: 'new',
      title: '出发',
      start: { month: 4, day: 4 },
      end: { month: 4, day: 7 },
      year: 490,
      note: '带干粮',
    });
    const back = draftFromEntry({ ...entry, createdAt: 1 }, 488);
    expect(back).toMatchObject({ id: 'new', multiDay: true, endDay: 7, yearly: false, year: 490 });
    // 修改时保留原 id
    expect(entryFromDraft(back, () => 'other')!.id).toBe('new');
  });
});
