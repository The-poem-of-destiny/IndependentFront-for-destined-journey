/**
 * prose-rewrite-agent.test.ts —— 正文润色侧链（DeepSeek beta 前缀续写）
 *
 * 钉住四件事：
 *   ① 消息装配形状（system / user / assistant 前缀，assistant 带 `prefix:true`）
 *   ② 前缀种子与思考模式开关（`extraBody`）确实随请求发出
 *   ③ 抽取：剥代码围栏 + trim；空产出 = 明确失败，绝不猜
 *   ④ 失败不抛穿、signal 原样透传、空正文短路不打网络
 */

import { describe, expect, it } from 'vitest';

import {
  PROSE_REWRITE_AGENT_ID,
  PROSE_REWRITE_EXTRA_BODY,
  PROSE_REWRITE_FALLBACK_PROMPT,
  PROSE_REWRITE_PREFIX_SEED,
  buildProseRewriteMessages,
  callProseRewriteAgent,
  extractProseRewriteOutput,
} from '../../../src/core/story/prose-rewrite-agent';
import type {
  ProseRewriteAgentDeps,
  ProseRewriteClient,
} from '../../../src/core/story/prose-rewrite-agent';
import type { AgentConfig, ApiEndpoint } from '../../../src/core/types/types';

// ═══════════════════════════════════════════════════════════
// buildProseRewriteMessages
// ═══════════════════════════════════════════════════════════

describe('buildProseRewriteMessages', () => {
  it('三条消息：system=提示词 / user=正文 / assistant=空前缀+prefix+思维链种子', () => {
    const messages = buildProseRewriteMessages('按规范重写。', '原始正文。');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'system', content: '按规范重写。' });
    expect(messages[1]).toEqual({ role: 'user', content: '原始正文。' });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      prefix: true,
      reasoning_content: PROSE_REWRITE_PREFIX_SEED,
    });
  });

  it('systemPrompt 为空 → 走通用兜底提示词（不是空 system）', () => {
    const messages = buildProseRewriteMessages('   ', '正文。');
    expect(messages[0].content).toBe(PROSE_REWRITE_FALLBACK_PROMPT);
    expect((messages[0].content as string).length).toBeGreaterThan(0);
  });

  it('可覆盖思维链种子', () => {
    const messages = buildProseRewriteMessages('x', 'y', '自定义种子：');
    expect(messages[2].reasoning_content).toBe('自定义种子：');
  });
});

// ═══════════════════════════════════════════════════════════
// extractProseRewriteOutput
// ═══════════════════════════════════════════════════════════

describe('extractProseRewriteOutput', () => {
  it('剥代码围栏 + trim', () => {
    expect(extractProseRewriteOutput('\n```\n改写后的正文。\n```\n')).toBe('改写后的正文。');
    expect(extractProseRewriteOutput('  裸正文。  ')).toBe('裸正文。');
  });

  it('空产出 → 空串（由调用方判失败）', () => {
    expect(extractProseRewriteOutput('')).toBe('');
    expect(extractProseRewriteOutput('   \n  ')).toBe('');
    expect(extractProseRewriteOutput('```\n```')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// callProseRewriteAgent
// ═══════════════════════════════════════════════════════════

describe('callProseRewriteAgent', () => {
  const endpoint = (): ApiEndpoint =>
    ({
      id: 'ep',
      name: 'deepseek-beta',
      baseUrl: 'https://api.deepseek.com/beta',
      apiKey: 'sk-x',
      defaultModel: 'deepseek-flash',
    }) as ApiEndpoint;

  const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      agentId: PROSE_REWRITE_AGENT_ID,
      enabled: true,
      apiEndpointId: 'ep',
      model: 'deepseek-flash',
      temperature: 0.8,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      retryOnFail: false,
      timeout: 0,
      userId: '',
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      worldBookIds: [],
      systemPrompt: '把这段正文重写得凝练一点。',
      ...over,
    }) as AgentConfig;

  function client(impl: ProseRewriteClient['chat']): {
    deps: ProseRewriteAgentDeps;
    seen: Array<{ agentId: string; request: Parameters<ProseRewriteClient['chat']>[0] }>;
  } {
    const seen: Array<{ agentId: string; request: Parameters<ProseRewriteClient['chat']>[0] }> = [];
    return {
      seen,
      deps: {
        clientFactory: (agentId) => ({
          chat: (request, signal) => {
            seen.push({ agentId, request });
            return impl(request, signal);
          },
        }),
      },
    };
  }

  const baseReq = () => ({
    saveId: 'save-1',
    bodyText: '  原始正文，写得很啰嗦。  ',
    endpoint: endpoint(),
    config: config(),
  });

  it('装配 → 调用 → 抽取，三步走通', async () => {
    const { deps, seen } = client(async () => ({
      output: '重写后的正文。',
      rawResponse: '',
    }));

    const result = await callProseRewriteAgent(baseReq(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('重写后的正文。');

    // 用 prose_rewrite 这个 agentId（→ 设置页那份配置、那个 API 池）
    expect(seen[0].agentId).toBe(PROSE_REWRITE_AGENT_ID);
    // 消息形状：系统提示 + 去空白的正文 + 前缀 assistant
    expect(seen[0].request.messages[0]).toEqual({
      role: 'system',
      content: '把这段正文重写得凝练一点。',
    });
    expect(seen[0].request.messages[1]).toEqual({
      role: 'user',
      content: '原始正文，写得很啰嗦。',
    });
    expect(seen[0].request.messages[2]).toMatchObject({ role: 'assistant', prefix: true });
    // 采样参数与模型取自该 agent 的配置
    expect(seen[0].request.model).toBe('deepseek-flash');
    expect(seen[0].request.temperature).toBe(0.8);
    expect(seen[0].request.maxTokens).toBe(4096);
  });

  it('🔴 强制开思维链 + reasoning_effort=max（extraBody 原样带出）', async () => {
    const { deps, seen } = client(async () => ({ output: 'x', rawResponse: '' }));
    await callProseRewriteAgent(baseReq(), deps);
    expect(seen[0].request.extraBody).toEqual(PROSE_REWRITE_EXTRA_BODY);
    expect(seen[0].request.extraBody).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('config.tailPrompt 作为思维链前缀种子优先（内容包下发，不新增 schema）', async () => {
    const { deps, seen } = client(async () => ({ output: 'x', rawResponse: '' }));
    await callProseRewriteAgent(
      { ...baseReq(), config: config({ tailPrompt: '内容包种子：' }) },
      deps,
    );
    expect(seen[0].request.messages[2].reasoning_content).toBe('内容包种子：');
  });

  it('客户端 error → 失败值，不抛穿', async () => {
    const { deps } = client(async () => ({ output: null, rawResponse: '', error: '429 限流' }));
    const result = await callProseRewriteAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('429');
  });

  it('客户端抛错 → 失败值，不抛穿', async () => {
    const { deps } = client(async () => {
      throw new Error('网络断了');
    });
    const result = await callProseRewriteAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('网络断了');
  });

  it('模型产出空正文 → 明确失败，绝不静默覆盖原文', async () => {
    const { deps } = client(async () => ({ output: '   \n ', rawResponse: '' }));
    const result = await callProseRewriteAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
  });

  it('空正文短路：根本不打网络', async () => {
    let called = false;
    const { deps } = client(async () => {
      called = true;
      return { output: 'x', rawResponse: '' };
    });
    const result = await callProseRewriteAgent({ ...baseReq(), bodyText: '   ' }, deps);
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('signal 原样透传给客户端', async () => {
    let seenSignal: AbortSignal | undefined;
    const { deps } = client(async (_req, signal) => {
      seenSignal = signal;
      return { output: 'x', rawResponse: '' };
    });
    const ac = new AbortController();
    await callProseRewriteAgent({ ...baseReq(), signal: ac.signal }, deps);
    expect(seenSignal).toBe(ac.signal);
  });
});
