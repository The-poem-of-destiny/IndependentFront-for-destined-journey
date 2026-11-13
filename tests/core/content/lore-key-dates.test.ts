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

const harvest: LoreKeyDate = {
  id: 'golden-harvest',
  name: '丰收祭',
  when: { precision: 'day', start: day(9, 8), end: day(9, 14) },
  regions: ['河谷公国'],
  summary: '河谷公国的丰收庆典。',
  highlights: [{ day: 1, title: '开幕礼' }],
};

describe('世界书关键日期：校验', () => {
  it('普查里出现过的各种形态都合法', () => {
    const samples: LoreKeyDate[] = [
      harvest,
      { id: 'creation-day', name: '新年', when: { precision: 'day', start: day(1, 1) } },
      { id: 'foam-masquerade', name: '假面祭', when: { precision: 'month', month: 5 } },
      { id: 'graduation', name: '毕业典礼', when: { precision: 'season', season: 'spring' } },
      { id: 'fishing', name: '钓鱼大赛', when: { precision: 'none' } },
      {
        id: 'star-ring-expo',
        name: '博览会',
        when: { precision: 'day', start: day(12, 19), end: day(12, 21) },
        repeat: { unit: 'year', interval: 4, anchorYear: 488 },
      },
      {
        id: 'holy-light-rite',
        name: '月度庆典',
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
        id: 'silverleaf-night',
        name: '初霜夜',
        when: { precision: 'day', start: day(10, 18) },
        approximate: true,
        public: true,
        major: false,
        aliases: ['霜夜'],
        tags: ['自然现象'],
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
        { id: 'a', name: '岁末日', when: { precision: 'day', start: day(12, 31) } },
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
          name: '选拔仪式',
          when: { precision: 'day', start: day(6, 24) },
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
        { id: '金浪', name: 'x', when: { precision: 'none' } },
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

  it('项内的未知字段不算错，原样保留', () => {
    const withExtra = [{ ...harvest, futureField: { any: 1 } }];
    expect(loreKeyDateErrors(withExtra)).toEqual([]);
    expect(parseLoreKeyDates(withExtra)[0]).toMatchObject({ futureField: { any: 1 } });
  });
});

describe('世界书关键日期：容错解析与汇总', () => {
  it('坏的一项整项跳过，不连累其他；重复 id 只留第一个；非数组当空', () => {
    const parsed = parseLoreKeyDates([
      harvest,
      { id: 'bad', name: '坏', when: { precision: 'day', start: day(2, 31) } },
      { ...harvest, name: '后来的同 id' },
      null,
    ]);
    expect(parsed.map((d) => d.name)).toEqual(['丰收祭']);
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
            { id: 'a', name: '建国节', when: { precision: 'day', start: day(5, 27) } },
            { id: 'b', name: '麦穗节', when: { precision: 'day', start: day(9, 26) } },
          ]),
          entry('fated:faction/off', false, [harvest]),
          { uid: 'fated:faction/plain', name: 'plain', content: 'x', enabled: true },
        ],
      },
    ] as unknown as WorldBook[];
    expect(collectLoreKeyDates(books).map((d) => [d.key, d.date.name])).toEqual([
      ['fated:faction/culture#a', '建国节'],
      ['fated:faction/culture#b', '麦穗节'],
    ]);
    expect(collectLoreKeyDates(books, () => true)).toHaveLength(3);
  });
});

describe('世界书关键日期：日期判定', () => {
  it('多年一度按起算年取模，起算年之前同样成立', () => {
    const expo = { repeat: { unit: 'year', interval: 4, anchorYear: 488 } } as const;
    expect([484, 487, 488, 489, 492].map((y) => keyDateOccursInYear(expo, y))).toEqual([
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
    expect(keyDateCoversDay(harvest, at(488, 9, 7))).toBe(false);
    expect(keyDateCoversDay(harvest, at(488, 9, 8))).toBe(true);
    expect(keyDateCoversDay(harvest, at(495, 9, 14))).toBe(true);
    expect(keyDateCoversDay(harvest, at(488, 9, 15))).toBe(false);
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
    const quadrennial = {
      ...yearly,
      repeat: { unit: 'year', interval: 4, anchorYear: 488 },
    } as const;
    expect(keyDateCoversDay(quadrennial, at(488, 12, 29))).toBe(true);
    expect(keyDateCoversDay(quadrennial, at(489, 1, 1))).toBe(true); // 488 年那一届的尾段
    expect(keyDateCoversDay(quadrennial, at(489, 12, 29))).toBe(false);
    expect(keyDateCoversDay(quadrennial, at(488, 1, 1))).toBe(false); // 487 年不办
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
    expect(validateLoreProtocol(books([harvest]))).toEqual([]);
    expect(
      validateLoreProtocol(
        books([{ id: 'x', name: '岁末日', when: { precision: 'day', start: day(12, 31) } }]),
      ),
    ).toEqual(['sample#fated:world_setting/a: keyDates[0]: invalid when.start']);
  });

  it('书级元数据上不允许 keyDates', () => {
    const bookScoped = books(undefined) as unknown as Array<{ lore: unknown }>;
    bookScoped[0].lore = { keyDates: [harvest] };
    expect(validateLoreProtocol(bookScoped)).toContain('sample: unknown lore field keyDates');
  });

  it('指纹用的元数据副本去掉 keyDates，其余字段与「没有元数据」的情形保持原样', () => {
    const lore = { section: 'region' as const, summary: 's', keyDates: [harvest] };
    expect(withoutLoreKeyDates(lore)).toEqual({ section: 'region', summary: 's' });
    expect(lore.keyDates).toHaveLength(1);
    const plain: { section: string; keyDates?: unknown } = { section: 'region' };
    expect(JSON.stringify({ lore: withoutLoreKeyDates(plain) })).toBe(
      JSON.stringify({ lore: { section: 'region' } }),
    );
    expect(JSON.stringify({ lore: withoutLoreKeyDates(undefined) })).toBe('{}');
  });
});
