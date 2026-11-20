import { describe, expect, it } from 'vitest';
import {
  projectStoryOutput,
  projectStreamingStory,
  projectStreamingStoryStaged,
} from '../../../src/core/story/story-output';

describe('projectStoryOutput', () => {
  it('extracts main text and numbered options through one interface', () => {
    const result = projectStoryOutput(
      `<maintext>第一段。\n\n第二段。</maintext>\n<options>\n1. 前进\n2、等待\n</options>`,
    );

    expect(result).toEqual({ content: '第一段。\n\n第二段。', options: ['前进', '等待'] });
  });

  it('supports the legacy singular option envelope', () => {
    const result = projectStoryOutput('<maintext>正文。</maintext><option>观察\n离开</option>');
    expect(result).toEqual({ content: '正文。', options: ['观察', '离开'] });
  });

  it('does not duplicate options when the closing tag contains whitespace', () => {
    const result = projectStoryOutput(
      '<maintext>正文。</maintext><options>1. 观察\n2. 离开</options   >',
    );
    expect(result.options).toEqual(['观察', '离开']);
  });

  it('ignores explanatory lines inside the numbered options envelope', () => {
    const result = projectStoryOutput(
      '<maintext>正文。</maintext><options>以下是可选行动：\n1. 观察\n2、离开</options>',
    );
    expect(result.options).toEqual(['观察', '离开']);
  });

  it('handles an unclosed options envelope without leaking it into prose', () => {
    const result = projectStoryOutput('<maintext>正文。\n<options>\n1. 观察\n2. 离开');
    expect(result).toEqual({ content: '正文。', options: ['观察', '离开'] });
  });

  it('keeps narrative formatting tags but removes non-rendering audio markers', () => {
    const result = projectStoryOutput(
      '<maintext><dalian name="妲丽安">你好</dalian><play_audio mood="安静"/></maintext>',
    );
    expect(result.content).toBe('<dalian name="妲丽安">你好</dalian>');
  });

  // 随机事件 v1：`<event_trigger>` 与 `<play_audio>` 同类 —— 零渲染意义的回执标记。
  // 结算侧读的是未投影的原始输出，所以这里剥干净不会让事件漏结算。
  it('removes non-rendering random-event trigger markers', () => {
    const result = projectStoryOutput(
      '<maintext>商人拦住去路。<event_trigger name="神秘商人"/></maintext>',
    );
    expect(result.content).toBe('商人拦住去路。');
  });

  it('removes structured sections from bare legacy output', () => {
    const result = projectStoryOutput(
      '正文。\n<thinking>不展示</thinking>\n<sum>摘要</sum>\n<vars>{"x":1}</vars>',
    );
    expect(result.content).toBe('正文。');
  });
});

describe('projectStreamingStory', () => {
  it('suppresses wrapper and option tags from partial output', () => {
    expect(projectStreamingStory('<main')).toBe('');
    expect(projectStreamingStory('<maintext>正在生成')).toBe('正在生成');
    expect(projectStreamingStory('<maintext>正文。</main')).toBe('正文。');
    expect(projectStreamingStory('<maintext>正文。</maintext>\n<options>\n1. 选')).toBe('正文。');
  });

  it('replaces leaked preamble once the maintext envelope arrives', () => {
    expect(projectStreamingStory('先分析格式……')).toBe('');
    expect(projectStreamingStory('先分析格式……\n<maintext>玩家可见正文')).toBe('玩家可见正文');
  });

  it('does not treat an inline format mention as the streaming envelope', () => {
    expect(projectStreamingStory('要用 <maintext> 包裹正文哦……')).toBe('');
  });

  it('keeps completed and streamed prose in parity', () => {
    const raw = '<maintext>夜色渐深。\n\n门被推开。</maintext><options>\n1. 查看\n</options>';
    expect(projectStreamingStory(raw)).toBe(projectStoryOutput(raw).content);
  });
});

describe('gametxt 同义正文信封', () => {
  it('完成态：gametxt 包裹的正文与选项正常提取', () => {
    const result = projectStoryOutput(
      '<gametxt>第一段。\n\n第二段。</gametxt>\n<options>\n1. 前进\n2、等待\n</options>',
    );
    expect(result).toEqual({ content: '第一段。\n\n第二段。', options: ['前进', '等待'] });
  });

  it('流式：半截标签 / 正在生成 / 半截闭标签都不漏尖括号', () => {
    expect(projectStreamingStory('<game')).toBe('');
    expect(projectStreamingStory('<gametxt>正在生成')).toBe('正在生成');
    expect(projectStreamingStory('<gametxt>正文。</game')).toBe('正文。');
    expect(projectStreamingStory('<gametxt>正文。</gametxt>\n<options>\n1. 选')).toBe('正文。');
  });

  it('流式：gametxt 信封到达后替换掉前面泄漏的文字', () => {
    expect(projectStreamingStory('先分析格式……\n<gametxt>玩家可见正文')).toBe('玩家可见正文');
  });

  it('流式：行内提及 <gametxt> 不当作信封', () => {
    expect(projectStreamingStory('要用 <gametxt> 包裹正文哦……')).toBe('');
  });

  it('两种信封嵌套（两种顺序）都只留正文、无残留标签', () => {
    expect(projectStoryOutput('<maintext><gametxt>正文</gametxt></maintext>').content).toBe('正文');
    expect(projectStoryOutput('<gametxt><maintext>正文</maintext></gametxt>').content).toBe('正文');
  });

  it('两种信封并列时取后一个', () => {
    expect(projectStoryOutput('<maintext>前文</maintext>\n<gametxt>后文</gametxt>').content).toBe(
      '后文',
    );
  });

  it('开闭标签不配对时以任一种闭标签收尾', () => {
    const result = projectStoryOutput('<gametxt>正文</maintext><options>1. 观察</options>');
    expect(result).toEqual({ content: '正文', options: ['观察'] });
  });

  it('标签大小写不敏感', () => {
    expect(projectStoryOutput('<GameTxt>正文。</GameTxt>').content).toBe('正文。');
  });

  it('gametxt 下流式与完成态一致', () => {
    const raw = '<gametxt>夜色渐深。\n\n门被推开。</gametxt><options>\n1. 查看\n</options>';
    expect(projectStreamingStory(raw)).toBe(projectStoryOutput(raw).content);
  });
});

describe('正文分节（<beat/>）', () => {
  it('无标记时与现状一致，且不带 stage 字段', () => {
    const raw = '<maintext>第一段。\n\n第二段。</maintext><options>1. 走</options>';
    const result = projectStoryOutput(raw);
    expect(result).toStrictEqual({ content: '第一段。\n\n第二段。', options: ['走'] });
    expect('stage' in result).toBe(false);
  });

  it('剥掉标记、节间以空行拼接并记下断点与登场', () => {
    const result = projectStoryOutput(
      '<maintext>开场。\n<beat enter="艾琳"/>\n她走进来。\n<beat/>\n结尾。</maintext>',
    );
    expect(result.content).toBe('开场。\n\n她走进来。\n\n结尾。');
    expect(result.stage).toEqual({ breaks: [5, 12], enters: [{ name: '艾琳', at: 5 }] });
  });

  it('流式：半截 <bea 与 <beat enter="… 不外漏', () => {
    expect(projectStreamingStory('<maintext>第一节。\n<bea')).toBe('第一节。');
    expect(projectStreamingStory('<maintext>第一节。\n<beat enter="艾')).toBe('第一节。');
    expect(projectStreamingStory('<maintext>第一节。\n<b')).toBe('第一节。');
  });

  it('流式分节投影：content 与 projectStreamingStory 一致，闭合后 closed', () => {
    const partial = '<maintext>一。\n<beat/>\n二。\n<beat enter="洛"/>\n三';
    const staged = projectStreamingStoryStaged(partial);
    expect(staged).toEqual({
      content: '一。\n\n二。\n\n三',
      breaks: [4, 8],
      enters: [{ name: '洛', at: 8 }],
      closed: false,
    });
    expect(staged.content).toBe(projectStreamingStory(partial));
    expect(projectStreamingStoryStaged(`${partial}。</maintext>`).closed).toBe(true);
    expect(projectStreamingStoryStaged('思考中')).toEqual({
      content: '',
      breaks: [],
      enters: [],
      closed: false,
    });
  });

  it('流式与完成态的分节一致', () => {
    const raw = '<maintext>一。\n<beat/>\n二。</maintext><options>1. 走</options>';
    const done = projectStoryOutput(raw);
    const staged = projectStreamingStoryStaged(raw);
    expect(staged.content).toBe(done.content);
    expect(staged.breaks).toEqual(done.stage?.breaks);
  });
});
