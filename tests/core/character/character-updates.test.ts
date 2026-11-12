import { describe, expect, it } from 'vitest';
import {
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
    expect(parseCharacterUpdates('正文')).toEqual({ present: false, updates: [], warnings: [] });
    expect(parseCharacterUpdates(envelope([]))).toEqual({
      present: true,
      updates: [],
      warnings: [],
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
});
