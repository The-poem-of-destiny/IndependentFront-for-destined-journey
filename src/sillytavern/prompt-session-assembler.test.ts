/**
 * prompt-session-assembler.test.ts — Delta 会话深模块测试（LLM 组装层 Delta 会话 · T2）
 *
 * 覆盖计划 §6 focused cases + 协议/分类机制不变量。数据一律来自匿名 fixture
 * （`fixtures/prompt-session/`），不碰真实导出/世界书/API Key。
 *
 * focused cases 与用例映射：
 * - 第二轮 messages 以前一轮实际请求加 assistant 为逐字节前缀
 *   → 「第二轮 wire messages 以前一轮实际请求 + assistant 为逐字节前缀」
 * - 两个 agentId 和两个 saveId 完全隔离 → 「两个 agentId 与两个 saveId 完全隔离」
 * - 过期 handle 不能覆盖新 revision → 「过期 handle 不能覆盖新 revision」组
 * - 失败后下一轮用当前状态重基线 → 「失败后下一轮用当前状态重基线」
 * - 静态签名变化重基线，单纯状态变化不重基线 → 「静态签名变化重基线；单纯状态变化不重基线」
 * - 达到已配置 token 预算时重基线；未配置时不猜 → 「达到已配置 token 预算时重基线；未配置时不猜」
 * - 空 tailPrompt 不产标签，非空值位于最后 → 「空 tailPrompt 不产标签；非空值位于最后」
 * - historyLayers 只决定 baseline 播种窗口；后续新消息按 id 追加，重基线后重新收窄
 *   → 「historyLayers 播种窗口 + 新消息按 id 追加 + 重基线后重新收窄」
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  preparePromptSession,
  completePromptSession,
  invalidatePromptSession,
  resetPromptSessionsForTest,
  activePromptSessionCount,
  PROMPT_SESSION_PROTOCOL_VERSION,
  type PreparePromptSessionInput,
  type PreparedPromptSession,
  type PromptSessionCompleteResult,
  type PromptSessionHandle,
  type PromptSessionRebaseReason,
} from './prompt-session-assembler';
import { buildAgentMessagesAsync } from './agent-templates';
import { USER_PLACEHOLDER_CONTENT } from './agent-client';
import * as worldbookLoader from './worldbook-loader';
import {
  fixtureItem,
  fixtureNpc,
  fixturePlayer,
  fixtureSkill,
  fixtureTranscript,
  fixtureWorldBook,
} from './fixtures/prompt-session/prompt-session-fixture';
import type { AgentConfig, AgentContext, ChatMessage, InventoryItem } from './types';

// ═══════════════════════════════════════════════════════════
// Test Context helpers
// ═══════════════════════════════════════════════════════════

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: 0 };
}

/** fixture 三组对话 → 带稳定 id 的历史消息 */
function fixtureHistory(): ChatMessage[] {
  return fixtureTranscript.map((m, i) => message(`fixture-msg-${i}`, m.role, m.content));
}

const GAME_TIME = {
  era: '复兴纪元',
  year: 488,
  month: 5,
  day: 12,
  weekday: 3,
  hour: 20,
  minute: 30,
};

/** 一块额外虚构物品（背包新增用） */
const dryFoodItem: InventoryItem = {
  name: '干粮',
  description: '一块烤干的饼。',
  quantity: 2,
  type: 'consumable',
  rarity: '普通',
};

/** 一个代表性上下文：两角色（阿岚带物品/技能）+ 动态世界书可见 + 变量 + 时间 + 上游输出。 */
function baseContext(): AgentContext {
  return makeContext({
    history: fixtureHistory(),
    characters: [
      { ...fixturePlayer, inventory: [fixtureItem], skills: [fixtureSkill] },
      fixtureNpc,
    ],
    variables: { sys: { 天气: '小雨' } },
    gameTime: GAME_TIME,
    userInput: '测试输入',
    agentOutputs: new Map([['story', '小铃把夜行的法子细细说了一遍。']]),
  });
}

function playerWithHp(hp: number): AgentContext['characters'][number] {
  return { ...fixturePlayer, hp, inventory: [fixtureItem], skills: [fixtureSkill] };
}

/**
 * 默认测试 Agent 配置：request_dispatcher + 自定义模板，覆盖四类占位符
 * （SYS_PROMPT=baseline-only / INVENTORY=projection-backed / NARRATIVE=append-cursor /
 *  USER_INPUT·AGENT.STORY=ephemeral），并挂上动态世界书。
 */
function makeCfg(agentId: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId,
    enabled: true,
    apiEndpointId: 'ep-test',
    model: 'model-test',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 60000,
    userId: '',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: [fixtureWorldBook.id],
    systemPrompt: '你是请求调度器。负责判断新老角色物品。',
    template: '{{SYS_PROMPT}}\n{{INVENTORY}}\n{{NARRATIVE}}\n{{USER_INPUT}}\n{{AGENT.STORY}}',
    ...overrides,
  };
}

function input(overrides: Partial<PreparePromptSessionInput> = {}): PreparePromptSessionInput {
  return {
    saveId: 'fixture-save',
    agentId: 'request_dispatcher',
    ctx: baseContext(),
    configs: [makeCfg('request_dispatcher')],
    worldBooks: [fixtureWorldBook],
    endpointId: 'ep-test',
    model: 'model-test',
    ...overrides,
  };
}

function systemContent(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === 'system');
  return sys ? sys.content : '';
}

function lastUserContent(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  return last.role === 'user' ? last.content : '';
}

function wireContent(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function wireText(messages: ChatMessage[]): string {
  return wireContent(messages)
    .map((m) => `${m.role}:${m.content}`)
    .join('\n');
}

// ═══════════════════════════════════════════════════════════

describe('prompt-session-assembler', () => {
  beforeEach(() => {
    resetPromptSessionsForTest();
  });

  // ── 导出契约（类型级引用，编译期钉住 T2 interface 不漂移）──

  it('模块导出形状（interface 类型可被测试引用，防 knip:ratchet 红）', () => {
    const handle: PromptSessionHandle = { saveId: 's', agentId: 'a', sessionId: 1, revision: 1 };
    const prepared: PreparedPromptSession = { messages: [], handle, rebased: false };
    const result: PromptSessionCompleteResult = { rawResponse: '' };
    const reason: PromptSessionRebaseReason = 'missing_session';
    expect([handle.sessionId, prepared.rebased, result.rawResponse, reason].join('|')).toBe(
      '1|false||missing_session',
    );
  });

  // ── 首轮形态 ──

  it('delta 协议版本常量钉住（升版即全局重基线，签名材料之一）', () => {
    expect(PROMPT_SESSION_PROTOCOL_VERSION).toBe('delta-v1');
  });

  it('首轮 system 与 buildAgentMessagesAsync 等价；首轮 user 只增加协议说明与可选 tail', async () => {
    const p1 = await preparePromptSession(input());
    expect(p1.rebased).toBe(true);
    expect(p1.rebaseReason).toBe('missing_session');
    expect(p1.handle).not.toBeNull();

    expect(p1.messages).toHaveLength(2); // [system, user]
    const [sys, user] = p1.messages;
    expect(sys.role).toBe('system');
    expect(user.role).toBe('user');

    // 与现有完整渲染器等价（T0 钉住的「首轮等价」契约延续到 T2）
    const asyncMsgs = await buildAgentMessagesAsync(
      'request_dispatcher',
      baseContext(),
      [makeCfg('request_dispatcher')],
      [fixtureWorldBook],
    );
    expect(sys.content).toBe(asyncMsgs![0].content);

    // 首轮 user：'继续' 触发 + code 固定协议说明
    expect(user.content.startsWith(USER_PLACEHOLDER_CONTENT)).toBe(true);
    expect(user.content).toContain('增量会话协议');
  });

  it('无有效模板的 agent 返回 handle null（不在 v1 范围，走无状态路径）', async () => {
    const p = await preparePromptSession(input({ agentId: 'nope', configs: [] }));
    expect(p.handle).toBeNull();
    expect(p.messages).toEqual([]);
    expect(p.rebased).toBe(false);
  });

  // ── 第二轮前缀 ──

  it('第二轮 wire messages 以前一轮实际请求 + assistant 为逐字节前缀', async () => {
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: '柜台后的小铃抬起头：「客官，夜路难走。」' });
    const p2 = await preparePromptSession(input());

    expect(p2.rebased).toBe(false);
    // 前 N-1 项 = 上一轮实际请求 + 成功 assistant 响应（逐字节前缀）
    const expectedPrefix = [
      ...wireContent(p1.messages),
      { role: 'assistant', content: '柜台后的小铃抬起头：「客官，夜路难走。」' },
    ];
    expect(wireContent(p2.messages.slice(0, -1))).toEqual(expectedPrefix);
    // 最后一条是本轮新 user delta（与首轮 user 不同）
    const last = p2.messages[p2.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).not.toBe(p1.messages[p1.messages.length - 1].content);
  });

  // ── 隔离 ──

  it('两个 agentId 与两个 saveId 完全隔离', async () => {
    const i1 = input(); // s1 / request_dispatcher
    const i2 = input({
      saveId: 's1',
      agentId: 'story',
      configs: [makeCfg('story', { template: '{{SYS_PROMPT}}\n{{USER_INPUT}}' })],
    });
    const i3 = input({ saveId: 's2' }); // s2 / request_dispatcher

    const p1 = await preparePromptSession(i1);
    completePromptSession(p1.handle!, { rawResponse: 'rd-1' });
    const p2 = await preparePromptSession(i2);
    completePromptSession(p2.handle!, { rawResponse: 'story-1' });
    const p3 = await preparePromptSession(i3);
    completePromptSession(p3.handle!, { rawResponse: 'rd-s2-1' });

    const p1b = await preparePromptSession(i1);
    const p2b = await preparePromptSession(i2);
    const p3b = await preparePromptSession(i3);
    expect(p1b.rebased).toBe(false);
    expect(p2b.rebased).toBe(false);
    expect(p3b.rebased).toBe(false);

    // 每个 transcript 只含自己的 assistant，不串状态
    expect(wireText(p1b.messages)).toContain('rd-1');
    expect(wireText(p1b.messages)).not.toContain('story-1');
    expect(wireText(p1b.messages)).not.toContain('rd-s2-1');
    expect(wireText(p2b.messages)).toContain('story-1');
    expect(wireText(p2b.messages)).not.toContain('rd-1');
    expect(wireText(p3b.messages)).toContain('rd-s2-1');
    expect(wireText(p3b.messages)).not.toContain('rd-1');
    expect(wireText(p3b.messages)).not.toContain('story-1');
    expect(activePromptSessionCount()).toBe(3);
  });

  // ── 过期 handle ──

  it('过期 handle 不能覆盖新 revision（invalidate 后旧 handle 回写被拒）', async () => {
    const p1 = await preparePromptSession(input());
    const stale = p1.handle!;
    invalidatePromptSession(stale); // 模拟失败/取消后清理

    const p2 = await preparePromptSession(input()); // 重建（missing_session 重基线）
    expect(p2.rebased).toBe(true);
    expect(p2.rebaseReason).toBe('missing_session');

    completePromptSession(stale, { rawResponse: '过期响应' }); // 旧 handle 应被忽略
    completePromptSession(p2.handle!, { rawResponse: '有效响应' });
    const p3 = await preparePromptSession(input());
    expect(p3.rebased).toBe(false);
    expect(wireText(p3.messages)).not.toContain('过期响应');
    expect(wireText(p3.messages)).toContain('有效响应');
  });

  it('重入（未完成再次 prepare）使旧 handle 失效并重基线（reentered）', async () => {
    const p1 = await preparePromptSession(input()); // inFlight = true
    const stale = p1.handle!;
    const p2 = await preparePromptSession(input()); // 重入 → 重基线
    expect(p2.rebased).toBe(true);
    expect(p2.rebaseReason).toBe('reentered');

    // 旧 handle 的回写被拒（session 已重建）
    completePromptSession(stale, { rawResponse: '旧响应' });
    completePromptSession(p2.handle!, { rawResponse: '新响应' });
    const p3 = await preparePromptSession(input());
    expect(p3.rebased).toBe(false);
    expect(wireText(p3.messages)).not.toContain('旧响应');
    expect(wireText(p3.messages)).toContain('新响应');
  });

  // ── 失败后重基线 ──

  it('失败后下一轮用当前状态重基线', async () => {
    const p1 = await preparePromptSession(input());
    invalidatePromptSession(p1.handle!); // 模拟最终失败/取消

    // 当前状态新增一件物品（干粮）—— 重基线必须反映它
    const ctx2 = {
      ...baseContext(),
      characters: [{ ...fixturePlayer, inventory: [fixtureItem, dryFoodItem] }, fixtureNpc],
    };
    const p2 = await preparePromptSession(input({ ctx: ctx2 }));
    expect(p2.rebased).toBe(true);
    expect(p2.rebaseReason).toBe('missing_session');
    // 新 baseline 反映当前权威状态（干粮已在背包）
    expect(systemContent(p2.messages)).toContain('干粮');
    // 无旧 assistant 角色消息残留（不是「清空 delta 回旧 baseline」）
    expect(p2.messages.every((m) => m.role !== 'assistant')).toBe(true);
  });

  // ── 签名 vs 状态 ──

  it('静态签名变化重基线；单纯状态变化不重基线（走 delta）', async () => {
    // ① 单纯状态变化（HP 70）→ 不重基线，delta 里只产 resource set
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: 'r1' });
    const ctx2 = { ...baseContext(), characters: [playerWithHp(70), fixtureNpc] };
    const p2 = await preparePromptSession(input({ ctx: ctx2 }));
    expect(p2.rebased).toBe(false);
    const user2 = lastUserContent(p2.messages);
    expect(user2).toContain('<context_delta');
    expect(user2).toContain('"op":"set"');
    expect(user2).toContain('"scope":"resource"');

    // ② 静态签名变化（model 换掉）→ 重基线
    completePromptSession(p2.handle!, { rawResponse: 'r2' });
    const p3 = await preparePromptSession(input({ model: 'model-other' }));
    expect(p3.rebased).toBe(true);
    expect(p3.rebaseReason).toBe('signature_changed');
  });

  it('tailPrompt 变化属于签名变化（触发重基线）', async () => {
    const p1 = await preparePromptSession(input({ tailPrompt: '旧指令' }));
    completePromptSession(p1.handle!, { rawResponse: 'r1' });
    const p2 = await preparePromptSession(input({ tailPrompt: '新指令' }));
    expect(p2.rebased).toBe(true);
    expect(p2.rebaseReason).toBe('signature_changed');
  });

  // ── token 预算 ──

  it('达到已配置 token 预算时重基线；未配置时不猜', async () => {
    // 未配置 contextWindowTokens → 即使 prompt token 很高也不重基线（不猜）
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: 'r1', promptTokens: 50000 });
    const p2 = await preparePromptSession(input());
    expect(p2.rebased).toBe(false);
    completePromptSession(p2.handle!, { rawResponse: 'r2', promptTokens: 60000 });

    // 配置 contextWindowTokens=100000：last=60000, growth=10000, maxTokens=4096
    // → 60000 + 10000 + 4096 = 74096 < 100000 → 不重基线
    const p3 = await preparePromptSession(input({ contextWindowTokens: 100000 }));
    expect(p3.rebased).toBe(false);
    completePromptSession(p3.handle!, { rawResponse: 'r3', promptTokens: 85000 });

    // last=85000, growth=25000 → 85000 + 25000 + 4096 = 114096 >= 100000 → 重基线
    const p4 = await preparePromptSession(input({ contextWindowTokens: 100000 }));
    expect(p4.rebased).toBe(true);
    expect(p4.rebaseReason).toBe('budget_exhausted');
  });

  // ── tailPrompt ──

  it('空 tailPrompt 不产标签；非空值位于最后', async () => {
    // 未配置 tailPrompt：首轮 user 不含 tail 标签
    const p1 = await preparePromptSession(input());
    const firstUser = lastUserContent(p1.messages);
    expect(firstUser).toContain(USER_PLACEHOLDER_CONTENT);
    expect(firstUser).toContain('增量会话协议');
    expect(firstUser).not.toContain('务必使用中文回答。');

    // 第二轮给非空 tailPrompt：delta 块在前，tail 在最末尾
    completePromptSession(p1.handle!, { rawResponse: 'r1' });
    const ctx2 = { ...baseContext(), characters: [playerWithHp(90), fixtureNpc] };
    const p2 = await preparePromptSession(input({ ctx: ctx2, tailPrompt: '务必使用中文回答。' }));
    const secondUser = lastUserContent(p2.messages);
    expect(secondUser.endsWith('务必使用中文回答。')).toBe(true);
    const deltaIdx = secondUser.indexOf('<context_delta');
    const tailIdx = secondUser.indexOf('务必使用中文回答。');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(tailIdx).toBeGreaterThan(deltaIdx);
  });

  // ── historyLayers 播种窗口 ──

  it('historyLayers 只决定 baseline 播种窗口；新消息按 id 追加；重基线后重新收窄', async () => {
    const six = fixtureHistory(); // 6 条
    const window4 = six.slice(2); // historyLayers=2 → 播种最近 2*2=4 条
    const cfg = makeCfg('request_dispatcher', { historyLayers: 2 });

    const p1 = await preparePromptSession(
      input({ ctx: { ...baseContext(), history: window4 }, configs: [cfg] }),
    );
    expect(p1.rebased).toBe(true);
    expect(systemContent(p1.messages)).toContain('「再教我怎么在夜里认路。」'); // 窗口内（第 5 条）
    expect(systemContent(p1.messages)).not.toContain('雨夜，你推开旅店的门'); // 窗口外（第 1 条）

    // 后续新增消息按 id 追加，不重基线
    completePromptSession(p1.handle!, { rawResponse: 'r1' });
    const newMsg7 = message('fixture-msg-6', 'user', '「天亮了。」');
    const newMsg8 = message('fixture-msg-7', 'assistant', '小铃吹熄了灯。');
    const ctx2 = { ...baseContext(), history: [...window4, newMsg7, newMsg8] };
    const p2 = await preparePromptSession(input({ ctx: ctx2, configs: [cfg] }));
    expect(p2.rebased).toBe(false);
    const user2 = lastUserContent(p2.messages);
    expect(user2).toContain('「天亮了。」');
    expect(user2).toContain('小铃吹熄了灯。');
    // delta 不重发已表示的旧消息
    expect(user2).not.toContain('雨夜，你推开旅店的门');

    // 历史被收窄 → 前缀被改 → 重基线（narrative_truncated），重基线后按新窗口重新播种
    completePromptSession(p2.handle!, { rawResponse: 'r2' });
    const ctx3 = { ...baseContext(), history: six.slice(4) }; // 收窄到 2 条
    const p3 = await preparePromptSession(input({ ctx: ctx3, configs: [cfg] }));
    expect(p3.rebased).toBe(true);
    expect(p3.rebaseReason).toBe('narrative_truncated');
    expect(systemContent(p3.messages)).toContain('「再教我怎么在夜里认路。」');
    expect(systemContent(p3.messages)).not.toContain('雨夜，你推开旅店的门');
  });

  // ── turn_context 只渲染 ephemeral ──

  it('turn_context 只渲染 ephemeral 占位符（不含 baseline/projection/append-cursor）', async () => {
    const p1 = await preparePromptSession(input());
    expect(systemContent(p1.messages)).toContain('薄荷油灯'); // INVENTORY 在 baseline system

    completePromptSession(p1.handle!, { rawResponse: 'r1' });
    const p2 = await preparePromptSession(input());
    const user2 = lastUserContent(p2.messages);
    expect(user2).toContain('测试输入'); // USER_INPUT（ephemeral）
    expect(user2).toContain('小铃把夜行的法子细细说了一遍。'); // AGENT.STORY（ephemeral）
    expect(user2).not.toContain('薄荷油灯'); // INVENTORY 不进 turn_context
  });

  // ── 动态世界书每轮至多求值一次 ──

  it('动态世界书每个装配轮至多求值一次', async () => {
    const spy = vi.spyOn(worldbookLoader, 'prerenderWorldBookEntries');
    try {
      const p1 = await preparePromptSession(input());
      expect(spy).toHaveBeenCalledTimes(1);
      completePromptSession(p1.handle!, { rawResponse: 'r1' });
      const p2 = await preparePromptSession(input());
      expect(p2.rebased).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2); // 第二轮也是「一轮一次」
    } finally {
      spy.mockRestore();
    }
  });

  // ── invalidate by saveId ──

  it('invalidate 传 saveId 清理该存档全部 session，不影响其他存档', async () => {
    await preparePromptSession(input()); // s1 的 session（inFlight）
    const a2 = await preparePromptSession(input({ saveId: 'other-save' }));
    completePromptSession(a2.handle!, { rawResponse: 'o1' });
    expect(activePromptSessionCount()).toBe(2);

    invalidatePromptSession('fixture-save');
    expect(activePromptSessionCount()).toBe(1);

    const a1b = await preparePromptSession(input());
    expect(a1b.rebased).toBe(true);
    expect(a1b.rebaseReason).toBe('missing_session');
    const a2b = await preparePromptSession(input({ saveId: 'other-save' }));
    expect(a2b.rebased).toBe(false); // 其他存档不受影响
  });
});
