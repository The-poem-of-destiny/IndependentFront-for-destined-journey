/**
 * character-appearance-agent.test.ts —— AI 报外貌的抽取（D56/D57）
 *
 * 🔴 本模块的两条 doctrine 都在「宁可少拿，不可猜错」这一侧：
 *   ① 抽不到 → 空数组，绝不抛（外貌是锦上添花，不该把「少件衣服」升级成「没有图」）
 *   ② 认不出的槽名 → 丢弃，绝不猜（猜错会把「疤」写进「发色」，而且**永久**落进
 *      会话副本，之后每张图都错）
 */
import { describe, it, expect } from 'vitest';

import {
  APPEARANCE_PROMPT_RULES,
  bootstrapAppearance,
  isUsableBaseline,
  parseCharacterAppearances,
} from './character-appearance-agent';
import { APPEARANCE_SLOT_ORDER, EMPTY_APPEARANCE } from './character-appearance';

describe('parseCharacterAppearances', () => {
  it('抽出一个角色的多个槽', () => {
    const out = parseCharacterAppearances(`
<image_prompt>1girl, standing</image_prompt>
<character_appearance name="艾莉丝">
hairStyle: short hair, shoulder length
features: scar over left eye
</character_appearance>
`);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('艾莉丝');
    expect(out[0].patch).toEqual({
      hairStyle: 'short hair, shoulder length',
      features: 'scar over left eye',
    });
  });

  it('一次响应里多个角色各自成块', () => {
    const out = parseCharacterAppearances(`
<character_appearance name="艾莉丝">outfit: white robe</character_appearance>
<character_appearance name="格雷">condition: bleeding</character_appearance>
`);
    expect(out.map((r) => r.name)).toEqual(['艾莉丝', '格雷']);
  });

  it('🔴 名字原样保留，不 trim 内部、不归一化（要与标记里的名字 === 对上）', () => {
    const out = parseCharacterAppearances(
      '<character_appearance name="苏 婉">outfit: robe</character_appearance>',
    );
    expect(out[0].name).toBe('苏 婉');
  });

  it('槽名容错：驼峰 / 下划线 / 中文 / 大小写都认', () => {
    const out = parseCharacterAppearances(`
<character_appearance name="甲">
HairColor: silver hair
hair_style: long hair
服装: white robe
EXPRESSION: calm
</character_appearance>
`);
    expect(out[0].patch).toEqual({
      hairColor: 'silver hair',
      hairStyle: 'long hair',
      outfit: 'white robe',
      expression: 'calm',
    });
  });

  it('🔴 认不出的槽名直接丢弃，绝不猜进别的槽', () => {
    const out = parseCharacterAppearances(`
<character_appearance name="甲">
shoe_size: 38
outfit: robe
</character_appearance>
`);
    expect(out[0].patch).toEqual({ outfit: 'robe' });
  });

  it('值过标点归一化（模型在中文语境里极易带出全角逗号）', () => {
    const out = parseCharacterAppearances(
      '<character_appearance name="甲">outfit: white robe，gold trim</character_appearance>',
    );
    expect(out[0].patch.outfit).toBe('white robe, gold trim');
  });

  it('空名字的块丢弃（对不上任何角色，留着只会长出查不中的垃圾行）', () => {
    expect(
      parseCharacterAppearances('<character_appearance name="">outfit: x</character_appearance>'),
    ).toEqual([]);
  });

  it('一个可用槽都没有的块不产出记录', () => {
    expect(
      parseCharacterAppearances('<character_appearance name="甲">???</character_appearance>'),
    ).toEqual([]);
  });

  it('🔴 没有块 / 空串 / 畸形标签 → 空数组，绝不抛', () => {
    expect(parseCharacterAppearances('')).toEqual([]);
    expect(parseCharacterAppearances('<image_prompt>1girl</image_prompt>')).toEqual([]);
    expect(parseCharacterAppearances('<character_appearance name="甲">没闭合')).toEqual([]);
  });

  it('可重复调用（正则的 lastIndex 不会把第二次调用吃掉）', () => {
    const raw = '<character_appearance name="甲">outfit: robe</character_appearance>';
    expect(parseCharacterAppearances(raw)).toEqual(parseCharacterAppearances(raw));
  });
});

describe('bootstrapAppearance —— 首次出场建基线（D57）', () => {
  it('patch 落在空白基线上，没写的槽是空串而不是缺席', () => {
    const out = bootstrapAppearance({ count: '1girl', hairColor: 'silver hair' });
    expect(out.count).toBe('1girl');
    expect(out.hairColor).toBe('silver hair');
    for (const slot of APPEARANCE_SLOT_ORDER) {
      expect(typeof out[slot]).toBe('string');
    }
  });

  it('空 patch → 全空基线（与 EMPTY_APPEARANCE 相同）', () => {
    expect(bootstrapAppearance({})).toEqual(EMPTY_APPEARANCE);
  });
});

describe('isUsableBaseline', () => {
  it('全空 = 与没有基线一回事', () => {
    expect(isUsableBaseline(EMPTY_APPEARANCE)).toBe(false);
    expect(isUsableBaseline({ ...EMPTY_APPEARANCE, outfit: '   ' })).toBe(false);
  });

  it('有一个槽有内容就算可用', () => {
    expect(isUsableBaseline({ ...EMPTY_APPEARANCE, count: '1girl' })).toBe(true);
  });
});

describe('提示词规则与解析器同源', () => {
  it('🔴 规则里列出的槽名，解析器必须全都认得', () => {
    for (const slot of APPEARANCE_SLOT_ORDER) {
      expect(APPEARANCE_PROMPT_RULES).toContain(slot);
      // 反向：照规则里的写法产一块，解析器要能抽出这个槽
      const out = parseCharacterAppearances(
        `<character_appearance name="甲">${slot}: value</character_appearance>`,
      );
      expect(out[0]?.patch[slot]).toBe('value');
    }
  });

  it('规则明说「只写变了的槽」与「名单里的角色写全」——两条缺一条都会让副本长歪', () => {
    expect(APPEARANCE_PROMPT_RULES).toContain('只写这一刻');
    // 🔴 「第一次出场」改成了「输入里给的名单」（2026-08-05）：模型看不到库，
    //    自己判断不出谁是第一次出场，那条规则于是永远不触发、D57 不可达。
    //    现在由引擎在 `charactersNeedingBaseline` 里点名。
    expect(APPEARANCE_PROMPT_RULES).toContain('尚无外观设定的角色');
  });
});
