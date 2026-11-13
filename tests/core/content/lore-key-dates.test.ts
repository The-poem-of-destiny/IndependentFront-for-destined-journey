import { describe, expect, it } from 'vitest';
import {
  collectLoreKeyDates,
  keyDateCoversDay,
  keyDateOccursInYear,
  loreKeyDateErrors,
  parseLoreKeyDates,
  withoutLoreKeyDates,
} from '../../../src/core/content/lore-key-dates';
import { validateLoreProtocol } from '../../../src/core/content/lore-protocol';
import type { LoreKeyDate, WorldBook } from '../../../src/core/types/types';

const day = (month: number, d: number) => ({ month, day: d });
const at = (year: number, month: number, d: number) => ({ year, month, day: d });

const kiteFair: LoreKeyDate = {
  id: 'kite-fair',
  name: '风筝会',
  when: { precision: 'day', start: day(8, 3), end: day(8, 6) },
  regions: ['东岸'],
  summary: '示例简介。',
  highlights: [{ day: 1, title: '开场' }],
};

describe('世界书关键日期：校验', () => {
  it('各种形态都合法', () => {
    const samples: LoreKeyDate[] = [
      kiteFair,
      { id: 'single-day', name: '单日节', when: { precision: 'day', start: day(2, 11) } },
      { id: 'month-only', name: '某月节', when: { precision: 'month', month: 7 } },
      { id: 'season-only', name: '某季节', when: { precision: 'season', season: 'spring' } },
      { id: 'undated', name: '不定期', when: { precision: 'none' } },
      {
        id: 'every-five-years',
        name: '五年会',
        when: { precision: 'day', start: day(11, 11), end: day(11, 13) },
        repeat: { unit: 'year', interval: 5, anchorYear: 488 },
      },
      {
        id: 'monthly-undated',
        name: '月会',
        when: { precision: 'none' },
        repeat: { unit: 'month' },
      },
      {
        id: 'market-day',
        name: '月中集市',
        when: { precision: 'day', start: { day: 15 } },
        repeat: { unit: 'month' },
      },
      {
        id: 'coronation',
        name: '加冕典礼',
        when: { precision: 'day', start: day(3, 3) },
        repeat: { unit: 'once', year: 490 },
      },
      {
        id: 'approximate-day',
        name: '大约节',
        when: { precision: 'day', start: day(4, 22) },
        approximate: true,
        public: true,
        major: false,
        aliases: ['约节'],
        tags: ['示例标签'],
        category: '节庆',
        timeNote: '一夜',
      },
    ];
    expect(loreKeyDateErrors(samples)).toEqual([]);
    expect(parseLoreKeyDates(samples)).toHaveLength(samples.length);
    expect(loreKeyDateErrors(undefined)).toEqual([]);
  });

  it('历法是每月 30 天：31 日与 13 月不合法', () => {
    expect(
      loreKeyDateErrors([
        { id: 'a', name: '坏日期', when: { precision: 'day', start: day(2, 31) } },
        { id: 'b', name: '错月', when: { precision: 'month', month: 13 } },
        { id: 'c', name: '错尾', when: { precision: 'day', start: day(1, 1), end: day(1, 0) } },
      ]),
    ).toEqual([
      'keyDates[0]: invalid when.start',
      'keyDates[1]: invalid when.month',
      'keyDates[2]: invalid when.end',
    ]);
  });

  it('多年一度必须给起算年；按月重复不能配月 / 季精度；非按月必须写月份', () => {
    expect(
      loreKeyDateErrors([
        {
          id: 'a',
          name: '三年会',
          when: { precision: 'day', start: day(4, 9) },
          repeat: { unit: 'year', interval: 3 },
        },
        {
          id: 'b',
          name: '每月某月',
          when: { precision: 'month', month: 3 },
          repeat: { unit: 'month' },
        },
        { id: 'c', name: '缺月份', when: { precision: 'day', start: { day: 5 } } },
        { id: 'd', name: '仅一次', when: { precision: 'none' }, repeat: { unit: 'once' } },
      ]),
    ).toEqual([
      'keyDates[0]: repeat.interval > 1 requires anchorYear',
      'keyDates[1]: monthly repeat allows only day or none precision',
      'keyDates[2]: invalid when.start',
      'keyDates[3]: invalid repeat.year',
    ]);
  });

  it('id 必须是 slug 且条目内唯一；字段类型逐项检查', () => {
    expect(
      loreKeyDateErrors([
        { id: '中文', name: 'x', when: { precision: 'none' } },
        { id: 'ok', name: '', when: { precision: 'none' } },
        { id: 'ok', name: '重复', when: { precision: 'none' }, regions: '帝国', major: 'yes' },
        'nope',
      ]),
    ).toEqual([
      'keyDates[0]: invalid id',
      'keyDates[1]: invalid name',
      'keyDates[2]: invalid regions',
      'keyDates[2]: invalid major',
      'keyDates[2]: duplicate id ok',
      'keyDates[3]: must be an object',
    ]);
    expect(loreKeyDateErrors({})).toEqual(['keyDates must be an array']);
  });

  it('日程的「第几天」不能超出节期长度', () => {
    const base = { name: 'x', when: { precision: 'day', start: day(8, 3), end: day(8, 6) } };
    const withDay = (id: string, d: number, extra: object = {}) => ({
      ...base,
      ...extra,
      id,
      highlights: [{ day: d, title: '节目' }],
    });
    expect(
      loreKeyDateErrors([
        withDay('a', 4),
        withDay('b', 5),
        // 跨年四天：12/29–1/2
        withDay('c', 4, { when: { precision: 'day', start: day(12, 29), end: day(1, 2) } }),
        withDay('d', 5, { when: { precision: 'day', start: day(12, 29), end: day(1, 2) } }),
        withDay('e', 2, { when: { precision: 'day', start: day(3, 3) } }),
        // 没有确定长度的项只按一年封顶
        withDay('f', 300, { when: { precision: 'month', month: 3 } }),
      ]),
    ).toEqual([
      'keyDates[1]: invalid highlights',
      'keyDates[3]: invalid highlights',
      'keyDates[4]: invalid highlights',
    ]);
  });

  it('项内的未知字段不算错，原样保留', () => {
    const withExtra = [{ ...kiteFair, futureField: { any: 1 } }];
    expect(loreKeyDateErrors(withExtra)).toEqual([]);
    expect(parseLoreKeyDates(withExtra)[0]).toMatchObject({ futureField: { any: 1 } });
  });
});

describe('世界书关键日期：容错解析与汇总', () => {
  it('坏的一项整项跳过，不连累其他；重复 id 只留第一个；非数组当空', () => {
    const parsed = parseLoreKeyDates([
      kiteFair,
      { id: 'bad', name: '坏', when: { precision: 'day', start: day(2, 31) } },
      { ...kiteFair, name: '后来的同 id' },
      null,
    ]);
    expect(parsed.map((d) => d.name)).toEqual(['风筝会']);
    expect(parseLoreKeyDates('nope')).toEqual([]);
    expect(parseLoreKeyDates(undefined)).toEqual([]);
  });

  it('一条条目可带多个日期；键为 <uid>#<id>；缺省跳过停用条目', () => {
    const entry = (uid: string, enabled: boolean, keyDates: unknown) => ({
      uid,
      name: uid,
      content: '正文只给模型读',
      enabled,
      extra: { lore: { keyDates } },
    });
    const books = [
      {
        id: 'faction',
        name: 'faction',
        partition: 'faction',
        entries: [
          entry('fated:faction/culture', true, [
            { id: 'a', name: '甲节', when: { precision: 'day', start: day(3, 9) } },
            { id: 'b', name: '乙节', when: { precision: 'day', start: day(8, 20) } },
          ]),
          entry('fated:faction/off', false, [kiteFair]),
          { uid: 'fated:faction/plain', name: 'plain', content: 'x', enabled: true },
        ],
      },
    ] as unknown as WorldBook[];
    expect(collectLoreKeyDates(books).map((d) => [d.key, d.date.name])).toEqual([
      ['fated:faction/culture#a', '甲节'],
      ['fated:faction/culture#b', '乙节'],
    ]);
    expect(collectLoreKeyDates(books, () => true)).toHaveLength(3);
  });
});

describe('世界书关键日期：日期判定', () => {
  it('多年一度按起算年取模，起算年之前同样成立', () => {
    const expo = { repeat: { unit: 'year', interval: 5, anchorYear: 488 } } as const;
    expect([483, 487, 488, 489, 493].map((y) => keyDateOccursInYear(expo, y))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(keyDateOccursInYear({}, 500)).toBe(true);
    expect(keyDateOccursInYear({ repeat: { unit: 'once', year: 490 } }, 490)).toBe(true);
    expect(keyDateOccursInYear({ repeat: { unit: 'once', year: 490 } }, 491)).toBe(false);
  });

  it('单日与多日范围', () => {
    expect(keyDateCoversDay(kiteFair, at(488, 8, 2))).toBe(false);
    expect(keyDateCoversDay(kiteFair, at(488, 8, 3))).toBe(true);
    expect(keyDateCoversDay(kiteFair, at(495, 8, 6))).toBe(true);
    expect(keyDateCoversDay(kiteFair, at(488, 8, 7))).toBe(false);
    const single = { when: { precision: 'day', start: day(1, 15) } } as const;
    expect(keyDateCoversDay(single, at(488, 1, 15))).toBe(true);
    expect(keyDateCoversDay(single, at(488, 1, 16))).toBe(false);
  });

  it('跨月范围按 30 天月份连续', () => {
    const span = { when: { precision: 'day', start: day(2, 29), end: day(3, 2) } } as const;
    expect(
      [at(488, 2, 28), at(488, 2, 30), at(488, 3, 1), at(488, 3, 3)].map((d) =>
        keyDateCoversDay(span, d),
      ),
    ).toEqual([false, true, true, false]);
  });

  it('跨年范围的 1 月尾段归属上一年那一届', () => {
    const yearly = { when: { precision: 'day', start: day(12, 29), end: day(1, 2) } } as const;
    expect(keyDateCoversDay(yearly, at(488, 12, 30))).toBe(true);
    expect(keyDateCoversDay(yearly, at(489, 1, 2))).toBe(true);
    expect(keyDateCoversDay(yearly, at(489, 1, 3))).toBe(false);
    const everyFive = {
      ...yearly,
      repeat: { unit: 'year', interval: 5, anchorYear: 488 },
    } as const;
    expect(keyDateCoversDay(everyFive, at(488, 12, 29))).toBe(true);
    expect(keyDateCoversDay(everyFive, at(489, 1, 1))).toBe(true); // 488 年那一届的尾段
    expect(keyDateCoversDay(everyFive, at(489, 12, 29))).toBe(false);
    expect(keyDateCoversDay(everyFive, at(488, 1, 1))).toBe(false); // 487 年不办
  });

  it('按月重复只看日；仅一次的只在那一年', () => {
    const monthly = {
      when: { precision: 'day', start: { day: 15 } },
      repeat: { unit: 'month' },
    } as const;
    expect(keyDateCoversDay(monthly, at(488, 1, 15))).toBe(true);
    expect(keyDateCoversDay(monthly, at(501, 11, 15))).toBe(true);
    expect(keyDateCoversDay(monthly, at(488, 1, 14))).toBe(false);
    const once = {
      when: { precision: 'day', start: day(3, 3) },
      repeat: { unit: 'once', year: 490 },
    } as const;
    expect(keyDateCoversDay(once, at(490, 3, 3))).toBe(true);
    expect(keyDateCoversDay(once, at(491, 3, 3))).toBe(false);
  });

  it('月 / 季 / 不定精度不占具体日期格', () => {
    expect(keyDateCoversDay({ when: { precision: 'month', month: 5 } }, at(488, 5, 1))).toBe(false);
    expect(keyDateCoversDay({ when: { precision: 'none' } }, at(488, 5, 1))).toBe(false);
  });
});

describe('世界书关键日期：与协议校验、提示词指纹的关系', () => {
  const books = (keyDates: unknown) => [
    {
      id: 'sample',
      name: 'sample',
      partition: 'world_setting',
      entries: [
        {
          uid: 'fated:world_setting/a',
          name: 'a',
          content: 'synthetic',
          enabled: true,
          extra: { lore: { section: 'turn', audiences: ['story'], keyDates } },
        },
      ],
    },
  ];

  it('内容包安装校验接受合法的 keyDates，拒绝非法的并指明位置', () => {
    expect(validateLoreProtocol(books([kiteFair]))).toEqual([]);
    expect(
      validateLoreProtocol(
        books([{ id: 'x', name: '坏日期', when: { precision: 'day', start: day(2, 31) } }]),
      ),
    ).toEqual(['sample#fated:world_setting/a: keyDates[0]: invalid when.start']);
  });

  it('书级元数据上不允许 keyDates', () => {
    const bookScoped = books(undefined) as unknown as Array<{ lore: unknown }>;
    bookScoped[0].lore = { keyDates: [kiteFair] };
    expect(validateLoreProtocol(bookScoped)).toContain('sample: unknown lore field keyDates');
  });

  it('指纹用的元数据副本去掉 keyDates，其余字段与「没有元数据」的情形保持原样', () => {
    const lore = { section: 'region' as const, summary: 's', keyDates: [kiteFair] };
    expect(withoutLoreKeyDates(lore)).toEqual({ section: 'region', summary: 's' });
    expect(lore.keyDates).toHaveLength(1);
    const plain: { section: string; keyDates?: unknown } = { section: 'region' };
    expect(JSON.stringify({ lore: withoutLoreKeyDates(plain) })).toBe(
      JSON.stringify({ lore: { section: 'region' } }),
    );
    expect(JSON.stringify({ lore: withoutLoreKeyDates(undefined) })).toBe('{}');
  });
});
