import { describe, expect, it } from 'vitest';
import {
  extractStoryBeats,
  hasBeatMarkers,
  panelBlockRanges,
  panelTagPattern,
  resolveBeatBreaks,
  resolveStoryStage,
} from '../../../src/core/story/story-beats';

describe('面板标签识别（审查 A6：三处共用的唯一一份）', () => {
  it('认属性、内部空白与大小写；不认同前缀的别的标签', () => {
    const tags = (s: string) =>
      [...s.matchAll(panelTagPattern())].map((m) => `${m[1] ?? ''}${m[2].toLowerCase()}`);
    expect(tags('<action_info type="a">x</action_info>')).toEqual(['action_info', '/action_info']);
    expect(tags('< action_info >x</ action_info >')).toEqual(['action_info', '/action_info']);
    expect(tags('<ITEM_INFO>x</item_info>')).toEqual(['item_info', '/item_info']);
    expect(tags('<action_info_x>x</action_infos>')).toEqual([]);
  });

  it('面板区间：同名闭标签收束，漏写闭合延伸到文末', () => {
    const text = 'a<action_info>\n|x|1|\n\n|y|2|\n</ action_info >b<item_info>c';
    expect(panelBlockRanges(text)).toEqual([
      [1, text.indexOf('b')],
      [text.indexOf('<item_info>'), text.length],
    ]);
  });

  it('`<` 后接 10 万空白：很快结束', () => {
    const text = `<${' '.repeat(100_000)}/${' '.repeat(100_000)}x`;
    const t0 = performance.now();
    expect(panelBlockRanges(text)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('extractStoryBeats', () => {
  it('无标记时原样返回（逐字节不变）', () => {
    const text = '　　第一段。\n\n第二段。\n<action_info>|检定|d20=12|</action_info>';
    expect(extractStoryBeats(text)).toEqual({ content: text, breaks: [], enters: [] });
    expect(hasBeatMarkers(text)).toBe(false);
  });

  it('认四种写法：<beat>、<beat/>、</beat>、<beat enter="..."/>', () => {
    const result = extractStoryBeats(
      "甲\n<beat>\n乙\n</beat>\n丙\n<beat />\n丁\n<BEAT enter='某'/>\n戊",
    );
    expect(result.content).toBe('甲\n\n乙\n\n丙\n\n丁\n\n戊');
    expect(result.breaks).toEqual([3, 6, 9, 12]);
    expect(result.enters).toEqual([{ name: '某', at: 12 }]);
  });

  it('首尾标记与连续标记产生的空节被丢弃，登场名顺延到下一个非空节', () => {
    const result = extractStoryBeats(
      '<beat enter="艾琳"/>\n开场。\n<beat/>\n<beat enter="洛"/>\n\n续。\n<beat/>',
    );
    expect(result.content).toBe('开场。\n\n续。');
    expect(result.breaks).toEqual([5]);
    expect(result.enters).toEqual([
      { name: '艾琳', at: 0 },
      { name: '洛', at: 5 },
    ]);
  });

  it('保留节首全角缩进', () => {
    const result = extractStoryBeats('　　甲。\n<beat/>\n　　乙。');
    expect(result.content).toBe('　　甲。\n\n　　乙。');
    expect(result.breaks).toEqual([6]);
  });

  it('面板里的标记只剥不切，面板保持完整', () => {
    const result = extractStoryBeats(
      '叙述。\n<action_info>\n|行动者|甲|\n<beat/>\n|目标|乙|\n</action_info>\n<beat/>\n后续。',
    );
    expect(result.content).toBe(
      '叙述。\n<action_info>\n|行动者|甲|\n|目标|乙|\n</action_info>\n\n后续。',
    );
    expect(result.breaks).toEqual([result.content.indexOf('后续。')]);
  });

  it('enter 属性容错：多名、空名、无引号', () => {
    expect(extractStoryBeats('甲\n<beat enter="乙、丙"/>\n丁').enters).toEqual([
      { name: '乙', at: 3 },
      { name: '丙', at: 3 },
    ]);
    expect(extractStoryBeats('甲\n<beat enter=""/>\n丁').enters).toEqual([]);
    expect(extractStoryBeats('甲\n<beat enter=戊 />\n丁').enters).toEqual([{ name: '戊', at: 3 }]);
  });

  it('同名只记首次登场', () => {
    const result = extractStoryBeats('<beat enter="甲"/>一\n<beat enter="甲"/>\n二');
    expect(result.enters).toEqual([{ name: '甲', at: 0 }]);
  });
});

describe('resolveBeatBreaks / resolveStoryStage', () => {
  const content = '一。\n\n二。\n\n三。';

  it('有效断点原样采用', () => {
    expect(resolveBeatBreaks(content, { breaks: [4], enters: [] })).toEqual([4]);
  });

  it('缺席、为空或失效时按段落切', () => {
    expect(resolveBeatBreaks(content)).toEqual([4, 8]);
    expect(resolveBeatBreaks(content, { breaks: [], enters: [] })).toEqual([4, 8]);
    expect(resolveBeatBreaks(content, { breaks: [5], enters: [] })).toEqual([4, 8]);
    expect(resolveBeatBreaks(content, { breaks: [8, 4], enters: [] })).toEqual([4, 8]);
    expect(resolveBeatBreaks(content, { breaks: [99], enters: [] })).toEqual([4, 8]);
  });

  it('按段兜底不切开面板', () => {
    const text = '叙述。\n\n<item_info>\n名称：剑\n\n品质：优良\n</item_info>\n\n后续。';
    expect(resolveBeatBreaks(text)).toEqual([5, text.indexOf('后续。')]);
  });

  it('面板漏写闭合时视为延伸到文末', () => {
    expect(resolveBeatBreaks('甲。\n\n<action_info>\n|a|\n\n|b|')).toEqual([4]);
  });

  it('单段正文没有断点', () => {
    expect(resolveBeatBreaks('只有一段。')).toEqual([]);
    expect(resolveBeatBreaks('')).toEqual([]);
  });

  it('断点有效时只保留落在节首的登场锚点', () => {
    const stage = {
      breaks: [4],
      enters: [
        { name: '甲', at: 0 },
        { name: '乙', at: 4 },
        { name: '丙', at: 5 },
      ],
    };
    expect(resolveStoryStage(content, stage)).toEqual({
      breaks: [4],
      enters: [
        { name: '甲', at: 0 },
        { name: '乙', at: 4 },
      ],
      fallback: false,
    });
  });

  it('回退时登场锚点归到所在段落节首，越界丢弃', () => {
    const stage = {
      breaks: [5],
      enters: [
        { name: '甲', at: 6 },
        { name: '乙', at: 99 },
      ],
    };
    expect(resolveStoryStage(content, stage)).toEqual({
      breaks: [4, 8],
      enters: [{ name: '甲', at: 4 }],
      fallback: true,
    });
    expect(resolveStoryStage(content)).toEqual({ breaks: [4, 8], enters: [], fallback: true });
  });
});
