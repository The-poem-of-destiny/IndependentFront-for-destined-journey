import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptDirectContext,
  DIRECT_CACHE_REBUILD_DEFAULTS,
  DIRECT_CACHE_REBUILD_RANGE,
  discardDirectContext,
  installDirectCacheStore,
  normalizeDirectCacheRebuild,
  invalidateDirectContext,
  prepareDirectContext,
  serializeDirectContext,
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
    playerInput: 'turn 1',
    turnContext: { recall: 'recall-1', dice_pool: [[20, 7]], tailPrompt: '' } as Record<
      string,
      unknown
    >,
    history: [] as ChatMessage[],
    outputBudget: 100,
  };
}
const directContext = (content: string | null | undefined) =>
  JSON.parse(content!.match(/<direct_context>\n([\s\S]*?)\n<\/direct_context>/)![1]) as {
    set: Record<string, unknown>;
    remove: string[];
  };
const turnContext = (content: string | null | undefined) =>
  JSON.parse(content!.match(/<turn_context>\n([\s\S]*?)\n<\/turn_context>/)![1]) as Record<
    string,
    unknown
  >;
afterEach(() => {
  invalidateDirectContext(saveId);
  installDirectCacheStore();
});

describe('accepted direct context', () => {
  it('preserves the previous wire prefix and replaces changed sections with absolute values', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const next = input();
    next.history = [message()];
    next.playerInput = 'turn 2';
    next.frame.sections = { resources: { hp: 70 }, combat: null };
    const second = await prepareDirectContext(next);
    expect(second.rebaseReason).toBeUndefined();
    const retained = second.messages[second.retainedCount - 1]?.content;
    expect(retained).toContain('"hp":70');
    expect(retained).toContain('"remove":["inventory"]');
    expect(retained).not.toContain('iron');
  });

  it('第二楼请求的前缀与第一楼的留存部分逐字节一致，第一楼尾部不再出现，末尾是新尾部', async () => {
    const first = await prepareDirectContext(input());
    expect(first.retainedCount).toBe(first.messages.length - 1);
    const firstTail = first.messages[first.messages.length - 1].content!;
    expect(firstTail).toContain('recall-1');
    await acceptDirectContext(first, { acceptedMessages: [message('第一楼正文')] });
    const next = input();
    next.history = [message('第一楼正文')];
    next.playerInput = 'turn 2';
    next.turnContext = { recall: 'recall-2', dice_pool: [[6, 3]], tailPrompt: '' };
    const second = await prepareDirectContext(next);
    expect(second.rebaseReason).toBeUndefined();
    expect(JSON.stringify(second.messages.slice(0, first.retainedCount))).toBe(
      JSON.stringify(first.messages.slice(0, first.retainedCount)),
    );
    expect(second.messages[first.retainedCount]).toEqual({
      role: 'assistant',
      content: '第一楼正文',
    });
    expect(JSON.stringify(second.messages)).not.toContain('recall-1');
    expect(second.messages.some((m) => m.content === firstTail)).toBe(false);
    const tail = turnContext(second.messages[second.messages.length - 1].content);
    expect(tail.recall).toBe('recall-2');
    expect(tail.dice_pool).toEqual([[6, 3]]);
    expect(second.messages[second.retainedCount - 1].content).toContain(
      '<player_input>\nturn 2\n</player_input>',
    );
  });

  it('接纳后的会话不含尾部，assistant 只保留正文且没有 native', async () => {
    let record: DirectCacheRecord | undefined;
    installDirectCacheStore({
      load: async () => undefined,
      save: async (value) => {
        record = structuredClone(value);
      },
      delete: async () => {},
    });
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, {
      acceptedMessages: [
        { id: 'u1', role: 'user', content: '玩家输入', timestamp: 1 },
        { ...message('第一段'), id: 'a1' },
        { ...message('第二段'), id: 'a2' },
      ],
    });
    expect(record!.transcript).toHaveLength(first.retainedCount + 1);
    expect(JSON.stringify(record!.transcript)).not.toContain('<turn_context>');
    const assistant = record!.transcript[record!.transcript.length - 1];
    expect(assistant).toEqual({ role: 'assistant', content: '第一段\n\n第二段' });
    expect(assistant).not.toHaveProperty('native');
  });

  it('冷建请求的尾部不带 current：现值已整份在 set 里', async () => {
    const first = await prepareDirectContext(input());
    const delta = directContext(first.messages[first.retainedCount - 1].content);
    expect(delta.set).toMatchObject({ resources: { hp: 80 }, combat: null });
    const tail = turnContext(first.messages[first.messages.length - 1].content);
    expect(tail).not.toHaveProperty('current');
    expect(first.diagnostics.tailChars).toBe(
      first.messages[first.messages.length - 1].content!.length,
    );
  });

  it('combat 当轮变化时只在 set 里，未变的 resources 由尾部 current 重申', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const next = { ...input(), history: [message()] };
    next.frame.sections = { ...next.frame.sections, combat: { round: 2 } };
    const second = await prepareDirectContext(next);
    expect(second.rebaseReason).toBeUndefined();
    const delta = directContext(second.messages[second.retainedCount - 1].content);
    expect(delta.set).toEqual({ combat: { round: 2 } });
    const tail = turnContext(second.messages[second.messages.length - 1].content);
    expect(tail.current).toEqual({ resources: { hp: 80 } });
    expect(second.diagnostics.tailChars).toBe(
      second.messages[second.messages.length - 1].content!.length,
    );
    // 基线按冷建那份尾部计（不带 current）：等于此刻真去冷建的整份请求
    invalidateDirectContext(saveId);
    const cold = await prepareDirectContext(next);
    expect(cold.rebaseReason).toBe('missing_session');
    expect(second.diagnostics.baselineChars).toBe(cold.diagnostics.requestChars);
    expect(turnContext(cold.messages[cold.messages.length - 1].content)).not.toHaveProperty(
      'current',
    );
  });

  it('combat 与 resources 未变时不进留存消息的 set，但现值出现在尾部', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const next = { ...input(), history: [message()] };
    const second = await prepareDirectContext(next);
    const delta = directContext(second.messages[second.retainedCount - 1].content);
    expect(delta.set).toEqual({});
    expect(delta.remove).toEqual([]);
    const tail = turnContext(second.messages[second.messages.length - 1].content);
    expect(tail.current).toEqual({ resources: { hp: 80 }, combat: null });
  });

  it('does not save prepared or invalidated generations, and ignores late acceptance', async () => {
    const save = vi.fn();
    installDirectCacheStore({ load: async () => undefined, save, delete: async () => {} });
    const prepared = await prepareDirectContext(input());
    expect(save).not.toHaveBeenCalled();
    invalidateDirectContext(saveId);
    await acceptDirectContext(prepared, { acceptedMessages: [] });
    expect(save).not.toHaveBeenCalled();
    expect((await prepareDirectContext(input())).rebaseReason).toBe('missing_session');
  });

  it('discarding a rejected attempt keeps the accepted session for the retry', async () => {
    const save = vi.fn();
    installDirectCacheStore({ load: async () => undefined, save, delete: async () => {} });
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    expect(save).toHaveBeenCalledTimes(1);
    const next = { ...input(), history: [message()], playerInput: 'rejected attempt' };
    const rejected = await prepareDirectContext(next);
    expect(rejected.rebaseReason).toBeUndefined();
    discardDirectContext(rejected);
    // 被丢弃的票据迟到接纳也不得推进会话
    await acceptDirectContext(rejected, { acceptedMessages: [] });
    expect(save).toHaveBeenCalledTimes(1);
    const retry = await prepareDirectContext({ ...next, playerInput: 'retry' });
    expect(retry.rebaseReason).toBeUndefined();
    expect(retry.revision).toBe(2);
    expect(retry.messages.slice(0, first.retainedCount + 1)).toEqual([
      ...first.messages.slice(0, first.retainedCount),
      { role: 'assistant', content: 'accepted' },
    ]);
    expect(JSON.stringify(retry.messages)).not.toContain('rejected attempt');
    expect(retry.messages[retry.retainedCount - 1]?.content).toContain('retry');
  });

  it('cold-rebuilds after two consecutive rejected attempts and resets on acceptance', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const next = { ...input(), history: [message()] };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rejected = await prepareDirectContext({ ...next, playerInput: `rejected ${attempt}` });
      expect(rejected.rebaseReason).toBeUndefined();
      discardDirectContext(rejected);
    }
    const rebuilt = await prepareDirectContext({ ...next, playerInput: 'third try' });
    expect(rebuilt.rebaseReason).toBe('repeated_rejection');
    expect(rebuilt.revision).toBe(1);
    await acceptDirectContext(rebuilt, {
      acceptedMessages: [{ ...message('recovered'), id: 'a2' }],
    });
    const after = await prepareDirectContext({
      ...next,
      history: [message(), { ...message('recovered'), id: 'a2' }],
      playerInput: 'after recovery',
    });
    expect(after.rebaseReason).toBeUndefined();
    expect(after.revision).toBe(2);
  });

  it.each(['history', 'configuration', 'budget'] as const)(
    'rebuilds on %s changes using the fresh memory baseline',
    async (change) => {
      const first = await prepareDirectContext(input());
      await acceptDirectContext(first, { acceptedMessages: [message('old reply')] });
      const next = {
        ...input(),
        history: [message('old reply')],
        contextWindowTokens: undefined as number | undefined,
      };
      next.frame.history = [{ role: 'system', content: 'new summary' }];
      if (change === 'history') next.history = [message('edited')];
      if (change === 'configuration') next.signature = 'new';
      if (change === 'budget') {
        next.playerInput = 'x'.repeat(20000);
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

  it('窗口预算按含尾部的整份请求计算', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    // 第一楼刚好放得下；本轮尾部变大后整份请求超窗，即使留存部分几乎不变也不能放行
    const next = {
      ...input(),
      history: [message()],
      contextWindowTokens: Math.ceil(first.diagnostics.requestChars / 1.5) + 200,
    };
    next.turnContext = { recall: 'y'.repeat(30000) };
    await expect(prepareDirectContext(next)).rejects.toThrow('超出模型窗口');
  });

  it('folds the history on the ninth generation without an extra model request', async () => {
    for (let turn = 1; turn <= 9; turn++) {
      const prepared = await prepareDirectContext({ ...input(), playerInput: String(turn) });
      expect(prepared.revision).toBe(turn === 9 ? 1 : turn);
      if (turn === 9) expect(prepared.rebaseReason).toBe('turn_limit');
      await acceptDirectContext(prepared, { acceptedMessages: [] });
    }
  });

  it('restores an accepted persisted transcript and tolerates a failed cache write', async () => {
    let record: DirectCacheRecord | undefined;
    const save = vi.fn(async (value: DirectCacheRecord) => {
      record = structuredClone(value);
    });
    installDirectCacheStore({ load: async () => record, save, delete: async () => {} });
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [] });
    invalidateDirectContext(saveId);
    const second = await prepareDirectContext(input());
    expect(second.revision).toBe(2);
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(acceptDirectContext(second, { acceptedMessages: [] })).resolves.toBeUndefined();
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
    await acceptDirectContext(first, { acceptedMessages: [message('old reply')] });
    invalidateDirectContext(saveId);
    const next = { ...input(), history: [message('old reply')] };
    next.frame.prefix = [{ role: 'system', content: '新协议 ' + 'rules '.repeat(2000) }];
    next.frame.sections = { 'memory/MEM000001': '[MEM000001] 旧记忆', combat: null };
    const rebuilt = await prepareDirectContext(next);
    expect(rebuilt.rebaseReason).toBe('configuration_or_lore_changed');
    expect(JSON.stringify(rebuilt.messages)).not.toContain('old reply');
    const retained = rebuilt.messages[rebuilt.retainedCount - 1].content!;
    expect(retained).toContain('memory/MEM000001');
    expect(retained).not.toContain('memoryEntries');
  });
});

describe('重建时机可配置', () => {
  it('normalizeDirectCacheRebuild：缺席与非数字用默认，越界夹紧，楼数取整，消掉浮点尾数', () => {
    expect(normalizeDirectCacheRebuild()).toEqual(DIRECT_CACHE_REBUILD_DEFAULTS);
    expect(normalizeDirectCacheRebuild({})).toEqual(DIRECT_CACHE_REBUILD_DEFAULTS);
    expect(normalizeDirectCacheRebuild({ maxTurns: '12', growthLimit: null })).toEqual(
      DIRECT_CACHE_REBUILD_DEFAULTS,
    );
    expect(normalizeDirectCacheRebuild({ maxTurns: NaN, growthLimit: Infinity })).toEqual(
      DIRECT_CACHE_REBUILD_DEFAULTS,
    );
    expect(normalizeDirectCacheRebuild({ maxTurns: 0, growthLimit: 1 })).toEqual({
      maxTurns: DIRECT_CACHE_REBUILD_RANGE.maxTurns.min,
      growthLimit: DIRECT_CACHE_REBUILD_RANGE.growthLimit.min,
    });
    expect(normalizeDirectCacheRebuild({ maxTurns: 100, growthLimit: 9 })).toEqual({
      maxTurns: DIRECT_CACHE_REBUILD_RANGE.maxTurns.max,
      growthLimit: DIRECT_CACHE_REBUILD_RANGE.growthLimit.max,
    });
    expect(normalizeDirectCacheRebuild({ maxTurns: 7.6 }).maxTurns).toBe(8);
    expect(normalizeDirectCacheRebuild({ maxTurns: 7.4 }).maxTurns).toBe(7);
    // 滑块 0.1 步长累加出的浮点尾数
    expect(normalizeDirectCacheRebuild({ growthLimit: 1 + 0.1 * 3 }).growthLimit).toBe(1.3);
    expect(normalizeDirectCacheRebuild({ growthLimit: 0.1 + 0.2 + 1.4 }).growthLimit).toBe(1.7);
  });

  async function playTurns(count: number, rebuild?: { maxTurns?: number }) {
    const reasons: (string | undefined)[] = [];
    for (let turn = 1; turn <= count; turn++) {
      const prepared = await prepareDirectContext({
        ...input(),
        playerInput: String(turn),
        rebuild,
      });
      reasons.push(prepared.rebaseReason);
      await acceptDirectContext(prepared, { acceptedMessages: [] });
    }
    return reasons;
  }

  it('maxTurns=2 时第 3 楼以 turn_limit 重建', async () => {
    const reasons = await playTurns(3, { maxTurns: 2 });
    expect(reasons).toEqual(['missing_session', undefined, 'turn_limit']);
  });

  it('默认仍是第 9 楼重建', async () => {
    const reasons = await playTurns(9);
    expect(reasons.slice(1, 8).every((r) => r === undefined)).toBe(true);
    expect(reasons[8]).toBe('turn_limit');
  });

  async function grownSecond(reply: string, growthLimit?: number) {
    const first = await prepareDirectContext({ ...input(), rebuild: { growthLimit } });
    await acceptDirectContext(first, { acceptedMessages: [message(reply)] });
    return prepareDirectContext({
      ...input(),
      history: [message(reply)],
      rebuild: { growthLimit },
    });
  }

  it('调高 growthLimit 后原本会因增长重建的会话继续复用', async () => {
    const reply = 'x'.repeat(8000);
    expect((await grownSecond(reply)).rebaseReason).toBe('transcript_growth');
    invalidateDirectContext(saveId);
    const relaxed = await grownSecond(reply, 3);
    expect(relaxed.rebaseReason).toBeUndefined();
    expect(relaxed.diagnostics.growthLimit).toBe(3);
  });

  it('调低 growthLimit 后更早重建', async () => {
    // 约 1.25 倍：默认 1.4 下复用，1.2 下重建
    const reply = 'x'.repeat(3000);
    const kept = await grownSecond(reply);
    expect(kept.rebaseReason).toBeUndefined();
    expect(kept.diagnostics.requestChars / kept.diagnostics.baselineChars).toBeGreaterThan(1.2);
    invalidateDirectContext(saveId);
    const strict = await grownSecond(reply, 1.2);
    expect(strict.rebaseReason).toBe('transcript_growth');
    expect(strict.diagnostics.growthLimit).toBe(1.2);
  });

  it('两次请求之间只改阈值不会因签名变化而重建', async () => {
    const first = await prepareDirectContext({ ...input(), rebuild: { maxTurns: 5 } });
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const second = await prepareDirectContext({
      ...input(),
      history: [message()],
      rebuild: { maxTurns: 12, growthLimit: 2.5 },
    });
    expect(second.rebaseReason).toBeUndefined();
    expect(second.revision).toBe(2);
    expect(second.diagnostics.growthLimit).toBe(2.5);
  });
});

describe('按分区记账的诊断', () => {
  const charsOf = (messages: { content?: string | null }[]) =>
    messages.reduce((n, m) => n + (m.content ?? '').length, 0);

  it('冷建时列出全部分区，请求即基线', async () => {
    const first = await prepareDirectContext(input());
    const d = first.diagnostics;
    expect(d.rebased).toBe(true);
    expect(d.growthLimit).toBe(1.4);
    expect(d.requestChars).toBe(charsOf(first.messages));
    expect(d.baselineChars).toBe(d.requestChars);
    expect(d.tailChars).toBe(first.messages[first.messages.length - 1].content!.length);
    expect(d.sections).toEqual(
      [
        { key: 'inventory', action: 'set', chars: serializeDirectContext(['iron']).length },
        { key: 'resources', action: 'set', chars: serializeDirectContext({ hp: 80 }).length },
        { key: 'combat', action: 'set', chars: serializeDirectContext(null).length },
      ].sort((a, b) => b.chars - a.chars || (a.key < b.key ? -1 : 1)),
    );
    expect(d.otherSections).toBeUndefined();
  });

  it('复用时只列变化与移除的分区，基线是此刻冷建的整份请求', async () => {
    const first = await prepareDirectContext(input());
    await acceptDirectContext(first, { acceptedMessages: [message()] });
    const next = { ...input(), history: [message()] };
    next.frame.sections = { resources: { hp: 70 }, combat: null };
    const second = await prepareDirectContext(next);
    const d = second.diagnostics;
    expect(d.rebased).toBe(false);
    expect(d.sections).toEqual([
      { key: 'resources', action: 'set', chars: serializeDirectContext({ hp: 70 }).length },
      { key: 'inventory', action: 'remove', chars: 0 },
    ]);
    expect(d.requestChars).toBe(charsOf(second.messages));
    expect(d.tailChars).toBe(second.messages[second.messages.length - 1].content!.length);
    // 基线 = 静态前缀 + 完整分区的留存消息 + 同一份尾部
    const prefixChars = charsOf(next.frame.prefix);
    expect(d.baselineChars).toBeGreaterThan(prefixChars + d.tailChars);
    expect(d.baselineChars).toBeLessThan(d.requestChars);
  });

  it('超过 30 项时按字符数降序列出前 30 项，其余合并', async () => {
    const sections: Record<string, unknown> = {};
    for (let i = 1; i <= 35; i++) sections[`s${String(i).padStart(2, '0')}`] = 'x'.repeat(i);
    const value = input();
    value.frame.sections = sections;
    const { diagnostics } = await prepareDirectContext(value);
    expect(diagnostics.sections).toHaveLength(30);
    expect(diagnostics.sections[0]).toEqual({
      key: 's35',
      action: 'set',
      chars: serializeDirectContext('x'.repeat(35)).length,
    });
    expect(diagnostics.sections[29].key).toBe('s06');
    const restChars = [1, 2, 3, 4, 5].reduce(
      (n, i) => n + serializeDirectContext('x'.repeat(i)).length,
      0,
    );
    expect(diagnostics.otherSections).toEqual({ count: 5, chars: restChars });
  });

  it('增长超限重建时诊断记为重建并列出全部分区', async () => {
    let previous = await prepareDirectContext(input());
    await acceptDirectContext(previous, { acceptedMessages: [message('x'.repeat(8000))] });
    const history = [message('x'.repeat(8000))];
    const next = { ...input(), history };
    previous = await prepareDirectContext(next);
    expect(previous.rebaseReason).toBe('transcript_growth');
    expect(previous.diagnostics.rebased).toBe(true);
    expect(previous.diagnostics.sections.map((s) => s.key).sort()).toEqual([
      'combat',
      'inventory',
      'resources',
    ]);
  });
});
