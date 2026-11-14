/**
 * story-turn-summary.test.ts — Story 上下文新模式的每回合总结契约
 * （先归档判断、后写摘要；计划 D28 / D29 / §7.2 / §8，Q13，T56）。
 */
import { describe, it, expect } from 'vitest';
import {
  STORY_TURN_SUMMARY_SYSTEM_PROMPT,
  STORY_TURN_SUMMARY_TEMPLATE,
  buildStoryTurnBackfillMessages,
  parseStoryTurnSummaryOutput,
} from '../../../src/core/memory/story-turn-summary';

describe('buildStoryTurnBackfillMessages（补建较早回合摘要）', () => {
  it('只要摘要、不做归档判断；带上该回合原文与未结事件名', () => {
    const [system, user] = buildStoryTurnBackfillMessages({
      userInput: '找铁匠',
      storyText: '铁匠答应三天交剑。',
      openEvents: '【订剑】\n- 付了定金',
    });
    expect(system.role).toBe('system');
    expect(system.content).toContain('不做事件是否结束的判断');
    expect(system.content).toContain('"archives": []');
    expect(user.content).toContain('<该回合玩家输入>\n找铁匠');
    expect(user.content).toContain('<该回合正文>\n铁匠答应三天交剑。');
    expect(user.content).toContain('【订剑】');
  });

  it('补建同样按精简规则：结论不写过程、默认一段、至少一段', () => {
    const [system] = buildStoryTurnBackfillMessages({
      userInput: '',
      storyText: '',
      openEvents: '',
    });
    expect(system.content).toContain('不写过程与修辞');
    expect(system.content).toContain('通常只输出 1 段');
    expect(system.content).toContain('segments 至少一段');
    expect(system.content).toContain('只写这一回合的新进展');
    expect(system.content).not.toContain('篇幅随内容走');
  });
});

describe('parseStoryTurnSummaryOutput', () => {
  it('按事件分段，事件名可空（闲聊不强制归类）；没有归档时 archives 为空', () => {
    const raw = `好的。\n<json>\n${JSON.stringify({
      segments: [
        { event: '北城失踪案', content: '答应守卫三天后带回线索。' },
        { event: '', content: '与店主闲聊天气。' },
      ],
    })}\n</json>`;
    expect(parseStoryTurnSummaryOutput(raw)).toEqual({
      archives: [],
      segments: [
        { content: '答应守卫三天后带回线索。', eventName: '北城失踪案' },
        { content: '与店主闲聊天气。' },
      ],
    });
  });

  it('短回合允许短摘要（不设最低字数）', () => {
    expect(parseStoryTurnSummaryOutput('{"segments":[{"content":"休息。"}]}')?.segments).toEqual([
      { content: '休息。' },
    ]);
  });

  it('归档判断：三种结局（含中文别名），字段残缺的条目逐条丢弃', () => {
    const parsed = parseStoryTurnSummaryOutput(
      JSON.stringify({
        archives: [
          {
            event: '送信',
            outcome: 'completed',
            evidence: '委托完成',
            overview: '把信送到',
            detail: { promises: '三天后再来' },
          },
          { event: '寻猫', outcome: '放弃', evidence: '不找了', overview: '放弃寻猫' },
          { event: '护送', outcome: '失败', evidence: '商人倒下', overview: '护送失败' },
          { event: '缺依据', outcome: 'completed', overview: 'x' },
          { event: '坏结局', outcome: 'paused', evidence: 'y', overview: 'x' },
        ],
        segments: [{ content: '一天过去了。' }],
      }),
    );
    expect(parsed?.archives.map((a) => [a.eventName, a.outcome])).toEqual([
      ['送信', 'completed'],
      ['寻猫', 'abandoned'],
      ['护送', 'failed'],
    ]);
    expect(parsed?.archives[0].detail).toEqual({
      cause: '',
      process: '',
      ending: '',
      promises: '三天后再来',
      impact: '',
    });
  });

  it('没有任何有效摘要片段 → null（归档判断一并作废，调用方当作摘要缺失处理）', () => {
    expect(parseStoryTurnSummaryOutput('{"segments":[{"content":"  "}]}')).toBeNull();
    expect(
      parseStoryTurnSummaryOutput(
        '{"archives":[{"event":"a","outcome":"completed","evidence":"b","overview":"c"}],"segments":[]}',
      ),
    ).toBeNull();
    expect(parseStoryTurnSummaryOutput('没有 JSON')).toBeNull();
    // 旧 memory_summary 契约的输出不被新解析器接受
    expect(
      parseStoryTurnSummaryOutput('{"content":"x","hiddenLine":"y","keywords":[]}'),
    ).toBeNull();
  });

  it('人物地点主题按模型语义解析、trim去重；旧输出缺字段保持未知', () => {
    const parsed = parseStoryTurnSummaryOutput(
      JSON.stringify({
        segments: [
          {
            content: '老人收到信',
            characters: [' 老人 ', '老人', 3, ''],
            locations: [' 北城 '],
            topics: ['送信', '承诺'],
          },
          { content: '旧摘要' },
        ],
      }),
    )!;
    expect(parsed.segments[0]).toEqual({
      content: '老人收到信',
      characters: ['老人'],
      locations: ['北城'],
      topics: ['送信', '承诺'],
    });
    expect(parsed.segments[1].characters).toBeUndefined();
    expect(parsed.segments[1].locations).toBeUndefined();
    expect(parsed.segments[1].topics).toBeUndefined();
  });

  it('片段数量不设静默上限，最后片段也完整保留', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ content: `段${i}` }));
    expect(parseStoryTurnSummaryOutput(JSON.stringify({ segments }))?.segments).toHaveLength(20);
  });

  it('提示词与模板的格式定义与解析器同源：先归档判断、后摘要，模板带未结事件', () => {
    expect(STORY_TURN_SUMMARY_SYSTEM_PROMPT).toContain('"archives"');
    expect(STORY_TURN_SUMMARY_SYSTEM_PROMPT).toContain('"segments"');
    expect(STORY_TURN_SUMMARY_SYSTEM_PROMPT.indexOf('第一步：归档判断')).toBeLessThan(
      STORY_TURN_SUMMARY_SYSTEM_PROMPT.indexOf('第二步：本回合摘要'),
    );
    expect(STORY_TURN_SUMMARY_TEMPLATE).toContain('{{STORY_OPEN_EVENTS}}');
    expect(STORY_TURN_SUMMARY_TEMPLATE).toContain('{{AGENT.STORY}}');
    expect(STORY_TURN_SUMMARY_TEMPLATE).toContain('{{USER_INPUT}}');
  });

  it('延续事件纯增量：不复述已记录前情，无进展不写段，结局照写，并给出对照示例', () => {
    const prompt = STORY_TURN_SUMMARY_SYSTEM_PROMPT;
    expect(prompt).toContain('已经记录过的起因、背景、人物身份、地点和既有条件一律不再重复');
    expect(prompt).toContain('没有新行动、新线索或新决定时，不为它写段落');
    // 「无进展不写段」与「至少一段」的兜底同句给出，避免输出空 segments
    expect(prompt).toContain('仍满足 segments 至少一段');
    expect(prompt).toContain('结局本身就是新进展');
    expect(prompt).toContain('精简：〔本回合行动〕，〔结果或状态变化〕。');
  });

  it('示例只用〔〕占位的因果骨架，不带具体名词，防止提示词污染', () => {
    const backfill = buildStoryTurnBackfillMessages({
      userInput: '',
      storyText: '',
      openEvents: '',
    })[0].content;
    for (const prompt of [STORY_TURN_SUMMARY_SYSTEM_PROMPT, backfill]) {
      expect(prompt).toContain('不输出〔〕');
      for (const concrete of ['铁匠', '玄铁', '北城', '酒保', '城主府', '金币']) {
        expect(prompt).not.toContain(concrete);
      }
    }
    // 示例区的每一行都是占位骨架，不夹带具体内容
    const examples = STORY_TURN_SUMMARY_SYSTEM_PROMPT.slice(
      STORY_TURN_SUMMARY_SYSTEM_PROMPT.indexOf('浓缩程度示例'),
      STORY_TURN_SUMMARY_SYSTEM_PROMPT.indexOf('只输出一个 <json> 块'),
    )
      .split('\n')
      .filter((line) => /^\s*(?:- )?(?:过细|精简|传闻与计划)：/.test(line));
    expect(examples).toHaveLength(5);
    for (const line of examples) expect(line).toContain('〔');
  });

  it('精简规则：索引定位、禁写清单、篇幅锚点、拆段收紧、至少一段', () => {
    const prompt = STORY_TURN_SUMMARY_SYSTEM_PROMPT;
    expect(prompt).toContain('不写过程与修辞');
    expect(prompt).toContain('环境渲染、心理活动');
    expect(prompt).toContain('1~2 句（约 30~80 字）');
    expect(prompt).toContain('一回合通常只输出 1 段');
    expect(prompt).toContain('segments 至少一段');
    expect(prompt).toContain('overview：一句话（30~50 字）');
    expect(prompt).toContain('每项最多一句话');
    // 旧规则鼓励为闲聊单独拆段，已删除
    expect(prompt).not.toContain('可以单独成段');
    // 浓缩示例放在第二步之后、输出格式之前
    expect(prompt.indexOf('浓缩程度示例')).toBeGreaterThan(prompt.indexOf('第二步：本回合摘要'));
    expect(prompt.indexOf('浓缩程度示例')).toBeLessThan(prompt.indexOf('<json>'));
  });
});
