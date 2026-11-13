import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptDirectContext,
  discardDirectContext,
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

  it('discarding a rejected attempt keeps the accepted session for the retry', async () => {
    const save = vi.fn();
    installDirectCacheStore({ load: async () => undefined, save, delete: async () => {} });
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { rawResponse: 'accepted', acceptedMessages: [message()] });
    expect(save).toHaveBeenCalledTimes(1);
    const next = { ...input(), history: [message()], turn: 'rejected attempt' };
    const rejected = await prepareDirectContext(next);
    expect(rejected.rebaseReason).toBeUndefined();
    discardDirectContext(rejected);
    // 被丢弃的票据迟到接纳也不得推进会话
    await acceptDirectContext(rejected, { rawResponse: 'late', acceptedMessages: [] });
    expect(save).toHaveBeenCalledTimes(1);
    const retry = await prepareDirectContext({ ...next, turn: 'retry' });
    expect(retry.rebaseReason).toBeUndefined();
    expect(retry.revision).toBe(2);
    expect(retry.messages.slice(0, first.messages.length + 1)).toEqual([
      ...first.messages,
      { role: 'assistant', content: 'accepted' },
    ]);
    expect(JSON.stringify(retry.messages)).not.toContain('rejected attempt');
    expect(retry.messages[retry.messages.length - 1]?.content).toContain('retry');
  });

  it('cold-rebuilds after two consecutive rejected attempts and resets on acceptance', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { rawResponse: 'accepted', acceptedMessages: [message()] });
    const next = { ...input(), history: [message()] };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rejected = await prepareDirectContext({ ...next, turn: `rejected ${attempt}` });
      expect(rejected.rebaseReason).toBeUndefined();
      discardDirectContext(rejected);
    }
    const rebuilt = await prepareDirectContext({ ...next, turn: 'third try' });
    expect(rebuilt.rebaseReason).toBe('repeated_rejection');
    expect(rebuilt.revision).toBe(1);
    await acceptDirectContext(rebuilt, {
      rawResponse: 'recovered',
      acceptedMessages: [{ ...message(), id: 'a2' }],
    });
    const after = await prepareDirectContext({
      ...next,
      history: [message(), { ...message(), id: 'a2' }],
      turn: 'after recovery',
    });
    expect(after.rebaseReason).toBeUndefined();
    expect(after.revision).toBe(2);
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

  it('cold-rebuilds a persisted session once the protocol prefix text changes', async () => {
    let record: DirectCacheRecord | undefined;
    installDirectCacheStore({
      load: async () => record,
      save: async (value) => {
        record = structuredClone(value);
      },
      delete: async () => {},
    });
    // 旧协议 + 整块记忆库的已接纳会话，刷新后只剩持久化记录
    const old = input();
    old.frame.sections = { memoryEntries: '**记忆库:**\n[MEM000001] 旧记忆', combat: null };
    const first = await prepareDirectContext(old);
    await acceptDirectContext(first, { rawResponse: 'old reply', acceptedMessages: [message()] });
    invalidateDirectContext(saveId);
    const next = { ...input(), history: [message()] };
    next.frame.prefix = [{ role: 'system', content: '新协议 ' + 'rules '.repeat(2000) }];
    next.frame.sections = { 'memory/MEM000001': '[MEM000001] 旧记忆', combat: null };
    const rebuilt = await prepareDirectContext(next);
    expect(rebuilt.rebaseReason).toBe('configuration_or_lore_changed');
    expect(JSON.stringify(rebuilt.messages)).not.toContain('old reply');
    const tail = rebuilt.messages[rebuilt.messages.length - 1].content!;
    expect(tail).toContain('memory/MEM000001');
    expect(tail).not.toContain('memoryEntries');
  });
});
