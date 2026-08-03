import { describe, expect, it } from 'vitest';
import { computeConversationalDepths } from './chat-depth';

describe('computeConversationalDepths', () => {
  it('counts backward across user/assistant messages and ignores system events', () => {
    const messages = [
      { id: 'u1', role: 'user' as const },
      { id: 'a1', role: 'assistant' as const },
      { id: 's1', role: 'system' as const },
      { id: 'u2', role: 'user' as const },
      { id: 'a2', role: 'assistant' as const },
    ];

    expect(Object.fromEntries(computeConversationalDepths(messages))).toEqual({
      a2: 0,
      u2: 1,
      a1: 2,
      u1: 3,
    });
  });

  it('recalculates prior depths when a conversational message is appended', () => {
    const before = [
      { id: 'u1', role: 'user' as const },
      { id: 'a1', role: 'assistant' as const },
    ];
    const after = [...before, { id: 's1', role: 'system' as const }];
    const completed = [...after, { id: 'u2', role: 'user' as const }];

    expect(computeConversationalDepths(before).get('a1')).toBe(0);
    expect(computeConversationalDepths(after).get('a1')).toBe(0);
    expect(computeConversationalDepths(completed).get('a1')).toBe(1);
  });
});
