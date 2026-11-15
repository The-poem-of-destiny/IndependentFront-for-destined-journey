import { describe, expect, it } from 'vitest';
import { buildLlmRequest } from '../../../src/core/api/llm-adapter';
import { directCacheUsage } from '../../../src/core/api/prompt-caching';

describe('direct provider cache policy', () => {
  const base = {
    protocol: 'openai-chat' as const,
    model: 'test',
    stream: false,
    userId: 'test',
    messages: [
      { role: 'system' as const, content: 'stable rules' },
      { role: 'user' as const, content: 'current turn' },
    ],
  };
  it('leaves ordinary and generic compatible requests unchanged', () => {
    expect(buildLlmRequest({ ...base, cachePolicy: 'prefix' })).toEqual(buildLlmRequest(base));
  });
  it('only emits explicit OpenAI controls when selected', () => {
    const result = buildLlmRequest({ ...base, cachePolicy: 'openai', cacheKey: 'save:direct' });
    expect(result.body.prompt_cache_key).toBe('save:direct');
    expect(result.body.messages).toEqual(
      base.messages.map((m) => ({ ...m, prompt_cache_breakpoint: { mode: 'explicit' } })),
    );
    expect(() => buildLlmRequest({ ...base, cachePolicy: 'anthropic' })).toThrow('Claude');
  });
  it('marks the Claude fixed prefix and uses automatic conversation caching', () => {
    const result = buildLlmRequest({
      ...base,
      protocol: 'anthropic-messages',
      cachePolicy: 'anthropic',
    });
    expect(result.body.system).toEqual([
      { type: 'text', text: 'stable rules', cache_control: { type: 'ephemeral' } },
    ]);
    expect(result.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(
      buildLlmRequest({
        ...base,
        protocol: 'anthropic-messages',
        cachePolicy: 'anthropic',
        bodyOverrides: { cache_control: { type: 'ephemeral', ttl: '1h' } },
      }).body.cache_control,
    ).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
  describe('Claude 静态前缀断点（cacheStaticSystemCount）', () => {
    const claude = (
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
      cacheStaticSystemCount?: number,
    ) =>
      buildLlmRequest({
        ...base,
        protocol: 'anthropic-messages',
        cachePolicy: 'anthropic',
        messages,
        ...(cacheStaticSystemCount === undefined ? {} : { cacheStaticSystemCount }),
      }).body;
    const marks = (body: Record<string, unknown>) =>
      (body.system as { text: string; cache_control?: unknown }[]).map((b) =>
        b.cache_control ? b.text : null,
      );
    const shaped = [
      { role: 'system' as const, content: '协议' },
      { role: 'system' as const, content: '预设' },
      { role: 'system' as const, content: '固定世界书' },
      { role: 'system' as const, content: '正文历史' },
      { role: 'system' as const, content: '前情摘要' },
      { role: 'user' as const, content: '本轮' },
    ];

    it('断点落在静态前缀末尾与最后一块，不再标第一块', () => {
      const body = claude(shaped, 3);
      expect(marks(body)).toEqual([null, null, '固定世界书', null, '前情摘要']);
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('静态末尾就是最后一块时只有一个断点', () => {
      expect(marks(claude(shaped.slice(0, 3).concat(shaped.slice(5)), 3))).toEqual([
        null,
        null,
        '固定世界书',
      ]);
    });

    it('前 N 条含空内容 system 时按过滤后的下标换算', () => {
      const messages = [
        { role: 'system' as const, content: '协议' },
        { role: 'system' as const, content: '' },
        { role: 'system' as const, content: '预设' },
        { role: 'system' as const, content: '' },
        { role: 'system' as const, content: '正文历史' },
        { role: 'user' as const, content: '本轮' },
      ];
      expect(marks(claude(messages, 4))).toEqual([null, '预设', '正文历史']);
    });

    it('不给字段时与旧行为一致（第一块 + 最后一块）', () => {
      const body = claude(shaped);
      expect(marks(body)).toEqual(['协议', null, null, null, '前情摘要']);
      expect(body.system).toEqual(
        shaped
          .filter((m) => m.role === 'system')
          .map((m, i, all) => ({
            type: 'text',
            text: m.content,
            ...(i === 0 || i === all.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
          })),
      );
    });
  });

  describe('留存末尾断点（cacheRetainedMessageCount）', () => {
    // 会话 = 静态前缀 + 已留存的历史（user/assistant）+ 本轮留存消息 + 不留存的尾部
    const conversation = [
      { role: 'system' as const, content: '协议' },
      { role: 'system' as const, content: '前情摘要' },
      { role: 'user' as const, content: '第一楼留存' },
      { role: 'assistant' as const, content: '第一楼正文' },
      { role: 'user' as const, content: '第二楼留存' },
      { role: 'user' as const, content: '第二楼尾部' },
    ];
    type Block = { type: string; text: string; cache_control?: unknown };
    const claudeBody = (cacheRetainedMessageCount?: number) =>
      buildLlmRequest({
        ...base,
        protocol: 'anthropic-messages',
        cachePolicy: 'anthropic',
        messages: conversation,
        cacheStaticSystemCount: 1,
        ...(cacheRetainedMessageCount === undefined ? {} : { cacheRetainedMessageCount }),
      }).body;
    const marked = (body: Record<string, unknown>) =>
      (body.messages as { content: Block[] }[]).flatMap((m) =>
        m.content.filter((b) => b.cache_control).map((b) => b.text),
      );

    it('Claude：断点落在留存块上，尾部块没有断点，也没有顶层自动断点', () => {
      const body = claudeBody(5);
      const messages = body.messages as { role: string; content: Block[] }[];
      // 留存消息与尾部同为 user，合并成同一条 Claude 消息的两个块
      expect(messages[messages.length - 1].content.map((b) => b.text)).toEqual([
        '第二楼留存',
        '第二楼尾部',
      ]);
      expect(messages[messages.length - 1].content[0].cache_control).toEqual({
        type: 'ephemeral',
      });
      expect(messages[messages.length - 1].content[1].cache_control).toBeUndefined();
      expect(marked(body)).toEqual(['第二楼留存']);
      expect(body.cache_control).toBeUndefined();
      // 显式断点：静态前缀末尾 + 最后一块 system + 留存末尾，不超过 4 个
      const systemMarks = (body.system as Block[]).filter((b) => b.cache_control).length;
      expect(systemMarks + marked(body).length).toBeLessThanOrEqual(4);
    });

    it('Claude：留存末尾是 assistant 时断点落在它的块上', () => {
      const body = claudeBody(4);
      expect(marked(body)).toEqual(['第一楼正文']);
      expect(body.cache_control).toBeUndefined();
    });

    it('Claude：不给字段时与旧行为一致（顶层自动断点、消息块不打标）', () => {
      const body = claudeBody();
      expect(marked(body)).toEqual([]);
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('OpenAI：原本打在最后一条消息上的断点改打在最后一条留存消息上', () => {
      const result = buildLlmRequest({
        ...base,
        cachePolicy: 'openai',
        messages: conversation,
        cacheRetainedMessageCount: 5,
      });
      const flags = (result.body.messages as { prompt_cache_breakpoint?: unknown }[]).map(
        (m) => !!m.prompt_cache_breakpoint,
      );
      expect(flags).toEqual([true, true, false, false, true, false]);
      const legacy = buildLlmRequest({ ...base, cachePolicy: 'openai', messages: conversation });
      expect(
        (legacy.body.messages as { prompt_cache_breakpoint?: unknown }[]).map(
          (m) => !!m.prompt_cache_breakpoint,
        ),
      ).toEqual([true, true, false, false, false, true]);
    });
  });

  it('counts Claude reads and writes as input, preserving unknown usage', () => {
    expect(
      directCacheUsage('anthropic-messages', {
        inputTokens: 50,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        outputTokens: 30,
      }),
    ).toMatchObject({
      inputTokens: 1250,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      cacheMissTokens: 50,
      totalTokens: 1280,
    });
    expect(directCacheUsage('anthropic-messages', {}).inputTokens).toBeUndefined();
    expect(directCacheUsage('anthropic-messages', { inputTokens: 50 })).toMatchObject({
      cacheMissTokens: 50,
      inputTokens: undefined,
      totalTokens: undefined,
    });
    expect(
      directCacheUsage('openai-chat', { inputTokens: 1000, cacheReadTokens: 800 }).cacheMissTokens,
    ).toBe(200);
    expect(directCacheUsage('gemini', { inputTokens: 1000 }).cacheMissTokens).toBeUndefined();
  });
});
