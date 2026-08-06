/**
 * image-tag-bank-import.test.ts — ST 世界书 → 标签词库 转换器
 *
 * 用例分两类：
 * ① 真实样本（`image gen template.json` 的四条，逐字节抄进来）—— 证明「常规写法认得」
 * ② 畸形输入 —— 证明「读不懂的那条被跳过并留痕，而不是抛错让整本失败」
 */

import { describe, it, expect } from 'vitest';
import { parseTagBankLorebook, UNCATEGORIZED_LABEL } from './image-tag-bank-import';

/** 真实样本的四条（uid 0-3），字段裁到转换器真正会读的那几个 */
const SAMPLE = {
  entries: {
    '0': {
      uid: 0,
      key: ['温泉'],
      comment: '[场景]：温泉',
      content: '- 温泉：onsen, hot spring, steam, wooden bath',
      order: 2905,
      disable: false,
      constant: false,
    },
    '1': {
      uid: 1,
      key: ['公园', '长椅'],
      comment: '[场景]：公园/长椅',
      content: '- 公园/长椅：park, park bench, outdoors',
      order: 2905,
      disable: false,
      constant: false,
    },
    '2': {
      uid: 2,
      key: ['兽耳', '猫耳朵', '狐狸耳', '狗耳', '兔耳'],
      comment: '[特征]：兽耳',
      // 🔴 真实样本这一条的结尾就是一个 BOM（U+FEFF）——写成转义，别写字面量
      content:
        '- 兽耳：animal ears/cat ears/fox ears/dog ears/rabbit ears/animal ear fluff' +
        '\n' +
        '\uFEFF',
      order: 2913,
      disable: false,
      constant: false,
    },
    '3': {
      uid: 3,
      key: ['匕首', '剑', '武士刀'],
      comment: '[着装]：刀剑',
      content: '- 刀剑：dagger/sword/magic sword/holy sword/shadowbane/scabbard/katana',
      order: 2915,
      disable: false,
      constant: false,
    },
  },
};

describe('parseTagBankLorebook — 真实样本', () => {
  it('四条全部进库，分类/名字/标签各就各位', () => {
    const plan = parseTagBankLorebook(SAMPLE, { bankId: 'b1' });

    expect(plan.stats.total).toBe(4);
    expect(plan.stats.imported).toBe(4);
    expect(plan.stats.skipped).toBe(0);

    const onsen = plan.entries.find((e) => e.name === '温泉');
    expect(onsen).toBeDefined();
    expect(onsen?.category).toBe('场景');
    expect(onsen?.key).toBe('b1:0');
    expect(onsen?.order).toBe(2905);
    expect(onsen?.enabled).toBe(true);
    expect(onsen?.alwaysOn).toBe(false);
  });

  it('逗号分「同时成立」的格，斜杠分「同类候选」—— 两者不压平', () => {
    const plan = parseTagBankLorebook(SAMPLE);

    // 逗号：四格，每格一个候选
    const onsen = plan.entries.find((e) => e.name === '温泉');
    expect(onsen?.tags).toEqual([['onsen'], ['hot spring'], ['steam'], ['wooden bath']]);

    // 斜杠：一格，六个候选。压平的话 AI 会把六种耳朵一起写进提示词
    const ears = plan.entries.find((e) => e.name === '兽耳');
    expect(ears?.tags).toEqual([
      ['animal ears', 'cat ears', 'fox ears', 'dog ears', 'rabbit ears', 'animal ear fluff'],
    ]);
  });

  it('正文里重复的那个 `名字：` 前缀被剥掉，不进标签', () => {
    const plan = parseTagBankLorebook(SAMPLE);
    const park = plan.entries.find((e) => e.name === '公园/长椅');
    expect(park?.tags).toEqual([['park'], ['park bench'], ['outdoors']]);
    // 中文一个字都不该落进标签里
    expect(park?.tags.flat().join()).not.toMatch(/[\u4E00-\u9FFF]/);
  });

  it('别名 = 上游 key ∪ 名字 ∪ 名字里被斜杠分开的段', () => {
    const plan = parseTagBankLorebook(SAMPLE);

    const ears = plan.entries.find((e) => e.name === '兽耳');
    expect(ears?.aliases).toEqual(['兽耳', '猫耳朵', '狐狸耳', '狗耳', '兔耳']);

    // `公园/长椅` 自己拆出两段，与上游 key 去重后不重复
    const park = plan.entries.find((e) => e.name === '公园/长椅');
    expect(park?.aliases).toEqual(['公园/长椅', '公园', '长椅']);
  });

  it('BOM 被清掉，并留下一条 repaired 记录 —— 它骗得过肉眼和 diff', () => {
    const plan = parseTagBankLorebook(SAMPLE);

    const ears = plan.entries.find((e) => e.name === '兽耳');
    expect(ears?.raw).not.toMatch(/[\uFEFF\u200B-\u200D\u2060]/);
    expect(ears?.tags.flat().every((t) => !/\uFEFF/.test(t))).toBe(true);

    const repaired = plan.notes.filter((n) => n.kind === 'repaired');
    expect(repaired).toHaveLength(1);
    expect(repaired[0].uid).toBe(2);
  });

  it('分类分布按条数降序，且不依赖运行环境的 ICU 数据', () => {
    const plan = parseTagBankLorebook(SAMPLE);
    expect(plan.stats.categories).toEqual([
      { category: '场景', count: 2 },
      { category: '特征', count: 1 },
      { category: '着装', count: 1 },
    ]);
  });
});

describe('parseTagBankLorebook — 畸形输入一律不抛错', () => {
  const parse = (entries: unknown) => parseTagBankLorebook({ entries });

  it('整个文件读不懂 → 空计划，不抛', () => {
    for (const junk of [null, undefined, 42, 'nope', true]) {
      expect(() => parseTagBankLorebook(junk)).not.toThrow();
      expect(parseTagBankLorebook(junk).entries).toEqual([]);
    }
  });

  it('entries 是数组也吃（有些导出器就这么写）', () => {
    const plan = parse([{ uid: 7, comment: '[场景]：屋顶', content: '- 屋顶：rooftop' }]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].category).toBe('场景');
  });

  it('没有标签的条目被跳过并留痕，其余条目照常进库', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：空的', content: '' },
      b: { uid: 2, comment: '[场景]：好的', content: '- 好的：rooftop' },
    });
    expect(plan.entries.map((e) => e.name)).toEqual(['好的']);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.notes.find((n) => n.kind === 'skipped')?.uid).toBe(1);
  });

  it('没有方括号的 comment → 整串当名字，落进未分类', () => {
    const plan = parse({ a: { uid: 1, comment: '随便写的', content: '- x: rooftop' } });
    expect(plan.entries[0].name).toBe('随便写的');
    expect(plan.entries[0].category).toBe(UNCATEGORIZED_LABEL);
  });

  it('comment 缺席时退回正文里的中文标签名', () => {
    const plan = parse({ a: { uid: 1, content: '- 屋顶：rooftop, night' } });
    expect(plan.entries[0].name).toBe('屋顶');
    expect(plan.entries[0].tags).toEqual([['rooftop'], ['night']]);
  });

  it('一条里写了好几行 → 标签全部收进同一条', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：雨夜', content: '- 雨：rain, wet\n- 夜：night, moonlight' },
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].tags).toEqual([['rain'], ['wet'], ['night'], ['moonlight']]);
  });

  it('🔴 标签自带的冒号不被当成中文标签名剥掉', () => {
    // `rating:general` 与 NAI 的 `1.5::tag::` 都必须原样活下来 ——
    // 只看冒号的话会截出一个语法依然合法、意思完全不同的串（静默）
    const plan = parse({
      a: { uid: 1, comment: '[风格]：写实', content: '- 写实：rating:general, 1.5::detailed::' },
    });
    expect(plan.entries[0].tags).toEqual([['rating:general'], ['1.5::detailed::']]);
  });

  it('disable=true 进库但停用；constant=true 记成 alwaysOn', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：关掉的', content: '- x：rooftop', disable: true },
      b: { uid: 2, comment: '[画风]：常驻', content: '- x：masterpiece', constant: true },
    });
    expect(plan.entries.find((e) => e.uid === 1)?.enabled).toBe(false);
    expect(plan.entries.find((e) => e.uid === 2)?.alwaysOn).toBe(true);
  });

  it('U+FFFD 被清掉并留痕 —— 那代表已经丢失的字节，不该带进库', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：坏' + '\uFFFD' + '字', content: '- x：rooftop' },
    });
    expect(plan.entries[0].name).toBe('坏字');
    expect(plan.notes.some((n) => n.kind === 'repaired')).toBe(true);
  });

  it('标签里混着中文 → 进库，但报一条 warning', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：混的', content: '- 混的：rooftop, 这是注释' },
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.notes.some((n) => n.kind === 'warning')).toBe(true);
  });

  it('同名条目都留下，并报一条 duplicate（查询会一并返回，不是错误）', () => {
    const plan = parse({
      a: { uid: 1, comment: '[场景]：温泉', content: '- x：onsen' },
      b: { uid: 2, comment: '[特征]：温泉', content: '- x：steam' },
    });
    expect(plan.entries).toHaveLength(2);
    const dup = plan.notes.find((n) => n.kind === 'duplicate');
    expect(dup?.label).toBe('温泉');
  });

  it('几千条也只是一次函数调用（无 I/O，可在测试里跑满）', () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) {
      entries[String(i)] = {
        uid: i,
        comment: `[场景]：地点${i}`,
        content: `- 地点${i}：place${i}, indoors`,
      };
    }
    const plan = parseTagBankLorebook({ entries });
    expect(plan.stats.imported).toBe(3000);
    expect(plan.stats.categories).toEqual([{ category: '场景', count: 3000 }]);
  });
});
