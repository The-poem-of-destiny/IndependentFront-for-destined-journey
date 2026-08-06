/**
 * image-tag-bank.test.ts — 目录渲染 + 两个查询工具的实现
 *
 * 最要紧的一条在「目录逐字节稳定」那组：目录每张图都要发一遍，
 * 字节一漂 prompt cache 就作废，而这件事**不会有任何报错**，只会体现在账单上。
 */

import { describe, it, expect } from 'vitest';
import {
  CATALOGUE_DEFAULT_MAX_CHARS,
  collectEnabledEntries,
  formatTagBankCatalogue,
  formatTags,
  lookupTagEntries,
  searchTagEntries,
} from './image-tag-bank';
import type { TagBank, TagBankEntry } from './types-image';

function entry(over: Partial<TagBankEntry> = {}): TagBankEntry {
  return {
    key: over.key ?? `b:${over.name ?? 'x'}`,
    uid: over.uid ?? 0,
    category: '场景',
    name: '温泉',
    aliases: ['温泉'],
    tags: [['onsen'], ['hot spring']],
    alwaysOn: false,
    raw: '',
    order: 100,
    enabled: true,
    ...over,
  };
}

const ONSEN = entry({ key: 'b:1', uid: 1, name: '温泉', order: 2905 });
const PARK = entry({
  key: 'b:2',
  uid: 2,
  name: '公园/长椅',
  aliases: ['公园/长椅', '公园', '长椅'],
  tags: [['park'], ['park bench']],
  order: 2906,
});
const EARS = entry({
  key: 'b:3',
  uid: 3,
  category: '特征',
  name: '兽耳',
  aliases: ['兽耳', '猫耳朵', '狐狸耳'],
  tags: [['animal ears', 'cat ears', 'fox ears']],
  order: 2913,
});

const ALL = [ONSEN, PARK, EARS];

describe('collectEnabledEntries', () => {
  function bank(over: Partial<TagBank>): TagBank {
    return {
      id: 'b',
      name: 'b',
      entries: [],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      ...over,
    };
  }

  it('整本关掉 → 一条都不出（不必删就能试）', () => {
    expect(collectEnabledEntries([bank({ enabled: false, entries: ALL })])).toEqual([]);
  });

  it('条目级 enabled=false 被滤掉，其余照出', () => {
    const off = entry({ key: 'b:9', name: '关掉的', enabled: false });
    const got = collectEnabledEntries([bank({ entries: [ONSEN, off] })]);
    expect(got.map((e) => e.name)).toEqual(['温泉']);
  });

  it('多本合并', () => {
    const got = collectEnabledEntries([
      bank({ id: 'b1', entries: [ONSEN] }),
      bank({ id: 'b2', entries: [EARS] }),
    ]);
    expect(got).toHaveLength(2);
  });
});

describe('formatTags — 逗号与竖线的语义不同', () => {
  it('逗号 = 同时成立', () => {
    expect(formatTags([['onsen'], ['hot spring'], ['steam']])).toBe('onsen, hot spring, steam');
  });

  it('竖线 = 同类候选', () => {
    expect(formatTags([['animal ears', 'cat ears']])).toBe('animal ears | cat ears');
  });

  it('两者混排时各自保留', () => {
    expect(formatTags([['a', 'b'], ['c']])).toBe('a | b, c');
  });
});

describe('formatTagBankCatalogue', () => {
  it('只印名字，一个标签都不印（标签得靠工具去取）', () => {
    const text = formatTagBankCatalogue(ALL);
    expect(text).toContain('温泉');
    expect(text).toContain('兽耳');
    expect(text).not.toContain('onsen');
    expect(text).not.toContain('animal ears');
  });

  it('按分类分组，名字用 、 分隔（不能用 / —— 名字里就有斜杠）', () => {
    const text = formatTagBankCatalogue(ALL);
    expect(text).toContain('[场景] 温泉、公园/长椅');
    expect(text).toContain('[特征] 兽耳');
  });

  it('alwaysOn 的条目连标签一起印 —— 为它们跑一次工具往返是浪费', () => {
    const style = entry({
      key: 'b:9',
      category: '画风',
      name: '基调',
      tags: [['masterpiece'], ['very aesthetic']],
      alwaysOn: true,
      order: 1,
    });
    const text = formatTagBankCatalogue([...ALL, style]);
    expect(text).toContain('[画风] 基调：masterpiece, very aesthetic');
    // 常驻区在目录区之前
    expect(text.indexOf('常驻标签')).toBeLessThan(text.indexOf('词库目录'));
    // 常驻条目不在下面的名字目录里重复出现
    expect(text.split('词库目录')[1]).not.toContain('基调');
  });

  it('🔴 同一份词库渲染两次逐字节相同 —— 目录是缓存前缀，字节一漂就全价重算', () => {
    const a = formatTagBankCatalogue(ALL);
    const b = formatTagBankCatalogue([...ALL].reverse());
    expect(a).toBe(b);
  });

  it('空词库 → 空串（调用方据此完全不注入这一段）', () => {
    expect(formatTagBankCatalogue([])).toBe('');
  });

  it('超长目录截断时照实说漏了多少条，并指路 search_image_tags', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      entry({ key: `b:${i}`, uid: i, name: `地点${i}`, category: `类${i % 20}`, order: i }),
    );
    const text = formatTagBankCatalogue(many, { maxChars: 800 });
    expect(text.length).toBeLessThan(1200);
    expect(text).toMatch(/只列出 \d+\/500 条/);
    expect(text).toContain('search_image_tags');
  });

  it('默认上限足够装下几千条的名字目录', () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      entry({ key: `b:${i}`, uid: i, name: `地点${i}`, category: `类${i % 12}`, order: i }),
    );
    const text = formatTagBankCatalogue(many);
    expect(text).not.toContain('只列出');
    expect(text.length).toBeLessThan(CATALOGUE_DEFAULT_MAX_CHARS);
  });
});

describe('lookupTagEntries — 精确取', () => {
  it('按目录里的名字取到标签', () => {
    const r = lookupTagEntries(ALL, ['温泉', '兽耳']);
    expect(r.found).toEqual([
      { name: '温泉', category: '场景', tags: 'onsen, hot spring' },
      { name: '兽耳', category: '特征', tags: 'animal ears | cat ears | fox ears' },
    ]);
    expect(r.notFound).toEqual([]);
  });

  it('🔴 查不到就照实回报，不模糊猜一条给它', () => {
    const r = lookupTagEntries(ALL, ['温泉', '不存在的东西']);
    expect(r.found).toHaveLength(1);
    expect(r.notFound).toEqual(['不存在的东西']);
  });

  it('`分类:名字` 可消歧同名条目', () => {
    const dup = entry({ key: 'b:9', category: '特征', name: '温泉', tags: [['steam']] });
    const r = lookupTagEntries([...ALL, dup], ['特征:温泉']);
    expect(r.found).toEqual([{ name: '温泉', category: '特征', tags: 'steam' }]);
  });

  it('分类写错时退回只按名字找 —— 不该因为分类写错就丢标签', () => {
    const r = lookupTagEntries(ALL, ['不存在的分类：温泉']);
    expect(r.found).toHaveLength(1);
    expect(r.notFound).toEqual([]);
  });

  it('同名不同类且未消歧 → 全部返回（导入期就报过 duplicate）', () => {
    const dup = entry({ key: 'b:9', category: '特征', name: '温泉', tags: [['steam']] });
    const r = lookupTagEntries([...ALL, dup], ['温泉']);
    expect(r.found).toHaveLength(2);
  });

  it('重复查同一个名字不会重复返回', () => {
    const r = lookupTagEntries(ALL, ['温泉', '温泉 ', ' 温泉']);
    expect(r.found).toHaveLength(1);
  });

  it('空串与非字符串一律忽略，不算查不到', () => {
    const r = lookupTagEntries(ALL, ['', '   ', null as unknown as string]);
    expect(r.found).toEqual([]);
    expect(r.notFound).toEqual([]);
  });
});

describe('searchTagEntries — 模糊找', () => {
  it('按别名命中（查「猫耳」找到名字叫「兽耳」的那条）', () => {
    const r = searchTagEntries(ALL, '猫耳');
    expect(r.hits[0].name).toBe('兽耳');
    expect(r.hits[0].tags).toContain('cat ears');
  });

  it('查询词比别名长时也命中（「森林里的小屋」→ 别名「小屋」）', () => {
    const hut = entry({ key: 'b:8', name: '小屋', aliases: ['小屋'], tags: [['hut']] });
    const r = searchTagEntries([...ALL, hut], '森林里的小屋');
    expect(r.hits.map((h) => h.name)).toContain('小屋');
  });

  it('打分取最长命中别名 —— 更贴切的排前面', () => {
    const vague = entry({ key: 'b:7', name: '耳', aliases: ['耳'], order: 1 });
    const r = searchTagEntries([EARS, vague], '猫耳朵');
    expect(r.hits[0].name).toBe('兽耳');
  });

  it('命中超过 limit 时照实报总数', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry({ key: `b:${i}`, uid: i, name: `森林${i}`, aliases: [`森林${i}`], order: i }),
    );
    const r = searchTagEntries(many, '森林', 5);
    expect(r.hits).toHaveLength(5);
    expect(r.totalMatches).toBe(30);
  });

  it('空查询 → 空结果，不报错', () => {
    expect(searchTagEntries(ALL, '   ').hits).toEqual([]);
    expect(searchTagEntries(ALL, undefined as unknown as string).totalMatches).toBe(0);
  });

  it('英文别名大小写不敏感', () => {
    const en = entry({ key: 'b:6', name: 'Rooftop', aliases: ['Rooftop'], tags: [['rooftop']] });
    expect(searchTagEntries([en], 'rooftop').hits).toHaveLength(1);
  });
});
