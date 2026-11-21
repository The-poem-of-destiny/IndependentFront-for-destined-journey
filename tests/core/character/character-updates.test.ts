import { describe, expect, it } from 'vitest';
import { CHARACTER_UPDATE_PROTOCOL } from '../../../src/core/character/character-chronicle';
import {
  LIST_FIELDS,
  TEXT_FIELDS,
  parseCharacterUpdates,
  stripCharacterUpdates,
} from '../../../src/core/character/character-updates';
import { projectStoryOutput, projectStreamingStory } from '../../../src/core/story/story-output';

const event = {
  title: '约定同行',
  summary: '与旅人约定同行。',
  time: { kind: 'this_turn' },
  importance: 9,
};
const envelope = (characters: unknown[]) =>
  `<maintext>你走出旅舍。</maintext><character_updates>${JSON.stringify({ characters })}</character_updates>`;

describe('narrator character updates', () => {
  it('distinguishes missing, empty and malformed blocks', () => {
    expect(parseCharacterUpdates('正文')).toEqual({
      present: false,
      updates: [],
      warnings: [],
      notes: [],
    });
    expect(parseCharacterUpdates(envelope([]))).toEqual({
      present: true,
      updates: [],
      warnings: [],
      notes: [],
    });
    expect(parseCharacterUpdates('<character_updates>{bad}').warnings).toHaveLength(1);
    expect(parseCharacterUpdates(envelope([]) + '<character_updates>').warnings).toHaveLength(1);
    expect(
      parseCharacterUpdates('<character_updates>{bad}</character_updates>').warnings,
    ).toHaveLength(1);
  });
  it('rejects mechanical fields and invalid entries without discarding independent characters', () => {
    const result = parseCharacterUpdates(
      envelope([
        { name: '旅人', profile_changes: { hp: 2 }, chronicle: [event] },
        {
          name: '向导',
          profile_changes: { goals: '寻找渡口' },
          chronicle: [
            event,
            { ...event, importance: 11 },
            { ...event, time: { kind: 'past', label: '少年时期' } },
          ],
        },
      ]),
    );
    expect(result.updates.map((u) => u.name)).toEqual(['向导']);
    expect(result.updates[0].chronicle).toHaveLength(2);
    expect(result.updates[0].chronicle[1].time).toEqual({ kind: 'past', label: '少年时期' });
    expect(result.warnings).toHaveLength(2);
  });
  it('never exposes partial or complete control data in player prose or cached assistant history', () => {
    const raw = envelope([{ name: '向导', chronicle: [event] }]);
    for (let i = 0; i <= raw.length; i++)
      expect(projectStreamingStory(raw.slice(0, i))).not.toMatch(
        /character_updates|importance|约定同行/,
      );
    expect(projectStoryOutput(raw).content).toBe('你走出旅舍。');
    expect(projectStoryOutput('正文<character_updates>{"characters":[').content).toBe('正文');
    expect(stripCharacterUpdates(raw)).toBe('<maintext>你走出旅舍。</maintext>');
  });
  it('剥除 JSON 代码围栏（U1）', () => {
    const body = JSON.stringify({
      characters: [{ name: '向导', profile_changes: {}, chronicle: [event] }],
    });
    const result = parseCharacterUpdates(
      `正文<character_updates>
\`\`\`json
${body}
\`\`\`
</character_updates>`,
    );
    expect(result.warnings).toEqual([]);
    expect(result.notes).not.toHaveLength(0);
    expect(result.updates[0].chronicle).toHaveLength(1);
  });
  it('无损纠正 profile_changes 的常见偏差（U2）', () => {
    const result = parseCharacterUpdates(
      envelope([
        {
          name: '向导',
          profile_changes: { clothing: '旅行斗篷', goals: null, race: '  ', aliases: '老向导' },
          chronicle: [],
        },
      ]),
    );
    expect(result.warnings).toEqual([]);
    expect(result.notes).not.toHaveLength(0);
    expect(result.updates[0].profile_changes).toEqual({ outfit: '旅行斗篷', aliases: ['老向导'] });
  });
  it('同时给出 clothing 与 outfit 时不改写，仍按未知字段告警', () => {
    const result = parseCharacterUpdates(
      envelope([
        { name: '向导', profile_changes: { clothing: '斗篷', outfit: '皮甲' }, chronicle: [] },
      ]),
    );
    expect(result.updates).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
  it('chronicle 缺失或为 null 时按无经历处理（U3）', () => {
    const result = parseCharacterUpdates(
      envelope([
        { name: '向导', profile_changes: { goals: '寻找渡口' } },
        { name: '旅人', profile_changes: {}, chronicle: null },
      ]),
    );
    expect(result.warnings).toEqual([]);
    expect(result.notes).toHaveLength(2);
    expect(result.updates.map((u) => u.chronicle)).toEqual([[], []]);
  });
  it('经历 time 缺失或为字符串 this_turn、people 为字符串时纠正（U4）', () => {
    const { time: _time, ...noTime } = event;
    const result = parseCharacterUpdates(
      envelope([
        {
          name: '向导',
          profile_changes: {},
          chronicle: [noTime, { ...event, time: 'this_turn', people: '旅人' }],
        },
      ]),
    );
    expect(result.warnings).toEqual([]);
    expect(result.notes).not.toHaveLength(0);
    expect(result.updates[0].chronicle.map((c) => c.time)).toEqual([
      { kind: 'this_turn' },
      { kind: 'this_turn' },
    ]);
    expect(result.updates[0].chronicle[1].people).toEqual(['旅人']);
  });
  it('未知档案字段与越界重要度仍进 warnings', () => {
    const result = parseCharacterUpdates(
      envelope([
        { name: '旅人', profile_changes: { likes: '甜食' }, chronicle: [] },
        { name: '向导', profile_changes: {}, chronicle: [{ ...event, importance: 11 }] },
      ]),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.updates.map((u) => u.name)).toEqual(['向导']);
  });
  it('协议文本列出每个档案白名单字段', () => {
    for (const key of [...TEXT_FIELDS, ...LIST_FIELDS])
      expect(CHARACTER_UPDATE_PROTOCOL).toContain(key);
    expect(CHARACTER_UPDATE_PROTOCOL).toContain('不加代码围栏');
  });
});
