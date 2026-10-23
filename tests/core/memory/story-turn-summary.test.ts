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
});
