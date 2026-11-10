import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptDirectContext,
  installDirectCacheStore,
  invalidateDirectContext,
  prepareDirectContext,
  type DirectCacheRecord,
  type DirectContextFrame,
} from '../../../src/core/prompts/direct-context-session';
import type { ChatMessage } from '../../../src/core/types/types';

const saveId = 'cached-context-test';
const message = (content = 'accepted'): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content,
  timestamp: 1,
});
function input() {
  return {
    saveId,
    signature: 'configuration-1',
    frame: {
      prefix: [{ role: 'system' as const, content: 'rules '.repeat(2000) }],
      history: [] as DirectContextFrame['history'],
      sections: { inventory: ['iron'], resources: { hp: 80 }, combat: null } as Record<
        string,
        unknown
      >,
    },
    turn: 'turn 1',
    history: [] as ChatMessage[],
    outputBudget: 100,
  };
}
afterEach(() => {
  invalidateDirectContext(saveId);
  installDirectCacheStore();
});

describe('accepted direct context', () => {
  it('preserves the previous wire prefix and replaces changed sections with absolute values', async () => {
    const first = await prepareDirectContext(input());
    const native = {
      protocol: 'gemini' as const,
      value: { role: 'model', parts: [{ text: 'accepted', thoughtSignature: 'opaque' }] },
    };
    await acceptDirectContext(first, {
      rawResponse: 'accepted',
      nativeAssistant: native,
      acceptedMessages: [message()],
    });
    const next = input();
    next.history = [message()];
    next.turn = 'turn 2';
    next.frame.sections = { resources: { hp: 70 }, combat: null };
    const second = await prepareDirectContext(next);
    expect(second.rebaseReason).toBeUndefined();
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages[second.messages.length - 2]?.native).toEqual(native);
    expect(second.messages[second.messages.length - 1]?.content).toContain('"hp":70');
    expect(second.messages[second.messages.length - 1]?.content).toContain(
      '"remove":["inventory"]',
    );
    expect(second.messages[second.messages.length - 1]?.content).not.toContain('iron');
  });

  it('does not save prepared or invalidated generations, and ignores late acceptance', async () => {
    const save = vi.fn();
    installDirectCacheStore({ load: async () => undefined, save, delete: async () => {} });
    const prepared = await prepareDirectContext(input());
    expect(save).not.toHaveBeenCalled();
    invalidateDirectContext(saveId);
    await acceptDirectContext(prepared, { rawResponse: 'bad', acceptedMessages: [] });
    expect(save).not.toHaveBeenCalled();
    expect((await prepareDirectContext(input())).rebaseReason).toBe('missing_session');
  });

  it.each(['history', 'configuration', 'budget'] as const)(
    'rebuilds on %s changes using the fresh memory baseline',
    async (change) => {
      const first = await prepareDirectContext(input());
      await acceptDirectContext(first, { rawResponse: 'old reply', acceptedMessages: [message()] });
      const next = {
        ...input(),
        history: [message()],
        contextWindowTokens: undefined as number | undefined,
      };
      next.frame.history = [{ role: 'system', content: 'new summary' }];
      if (change === 'history') next.history = [message('edited')];
      if (change === 'configuration') next.signature = 'new';
      if (change === 'budget') {
        next.turn = 'x'.repeat(20000);
        next.contextWindowTokens = 100;
      }
      if (change === 'budget')
        await expect(prepareDirectContext(next)).rejects.toThrow('超出模型窗口');
      else {
        const rebuilt = await prepareDirectContext(next);
        expect(rebuilt.rebaseReason).toBe(
          change === 'history' ? 'history_changed' : 'configuration_or_lore_changed',
        );
        expect(JSON.stringify(rebuilt.messages)).toContain('new summary');
        expect(JSON.stringify(rebuilt.messages)).not.toContain('old reply');
      }
    },
  );

  it('folds the history on the ninth generation without an extra model request', async () => {
    for (let turn = 1; turn <= 9; turn++) {
      const prepared = await prepareDirectContext({ ...input(), turn: String(turn) });
      expect(prepared.revision).toBe(turn === 9 ? 1 : turn);
      if (turn === 9) expect(prepared.rebaseReason).toBe('turn_limit');
      await acceptDirectContext(prepared, { rawResponse: 'ok', acceptedMessages: [] });
    }
  });

  it('restores an accepted persisted transcript and tolerates a failed cache write', async () => {
    let record: DirectCacheRecord | undefined;
    const save = vi.fn(async (value: DirectCacheRecord) => {
      record = structuredClone(value);
    });
    installDirectCacheStore({ load: async () => record, save, delete: async () => {} });
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { rawResponse: 'ok', acceptedMessages: [] });
    invalidateDirectContext(saveId);
    const second = await prepareDirectContext(input());
    expect(second.revision).toBe(2);
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      acceptDirectContext(second, { rawResponse: 'ok', acceptedMessages: [] }),
    ).resolves.toBeUndefined();
  });
});
