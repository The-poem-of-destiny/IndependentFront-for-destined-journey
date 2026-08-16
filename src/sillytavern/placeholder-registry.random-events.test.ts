/**
 * `{{RANDOM_EVENTS}}` 渲染器测试（随机事件系统 v1 §5.1 / 裁定 §13-2）
 *
 * 分工同 `{{MAP_CONTEXT}}`：数据面（过滤 + 排序）是纯函数 `buildRandomEventOffer` 的事，
 * 本文件测的是**措辞与三条空串出口** —— 外壳、指令段、`[!]` 首访记号、候选行的形状，
 * 以及池空 / 系统关闭 / 战斗会话活跃三种情形下的零 token。
 *
 * 🔴 末尾那条**供值断言**是本文件最要紧的一条（blurByDefault 的教训）：单模块测试能证明
 *    渲染逻辑对，**证明不了有人把数据供进 ctx**。漏供的症状不是报错，是整块静默消失。
 */

import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_REGISTRY } from './placeholder-registry';
import type { RandomEventOfferEntry } from './random-event-context';
import type { AgentConfig, AgentContext } from './types';

// ══════════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════════

function mockConfig(): AgentConfig {
  return {
    agentId: 'story',
    apiEndpointId: 'ep1',
    model: 'test-model',
    enabled: true,
    worldBookIds: [],
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 30000,
    userId: 'test-user',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
  };
}

function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    userInput: '',
    history: [],
    worldBooks: [],
    characters: [],
    memories: [],
    plotEvents: [],
    variables: {},
    agentOutputs: new Map(),
    ...overrides,
  } as AgentContext;
}

function entry(over: Partial<RandomEventOfferEntry> = {}): RandomEventOfferEntry {
  return { name: '神秘商人', priority: 2, brief: '一名商人拦住去路。', forced: false, ...over };
}

/** offer + 可选上下文 → 渲染结果 */
function render(offer: RandomEventOfferEntry[], over?: Partial<AgentContext>): string {
  return PLACEHOLDER_REGISTRY['RANDOM_EVENTS'](
    mockCtx({ randomEventOffer: offer, ...over }),
    mockConfig(),
  );
}

// ══════════════════════════════════════════════════════════════
// 三条空串出口（§5.1 / 裁定 §13-2）
// ══════════════════════════════════════════════════════════════

describe('{{RANDOM_EVENTS}} —— 零 token 的三条出口', () => {
  it('池空（缺席或空数组）→ 空串，不留一对空标签', () => {
    expect(PLACEHOLDER_REGISTRY['RANDOM_EVENTS'](mockCtx(), mockConfig())).toBe('');
    expect(render([])).toBe('');
  });

  it('系统关闭 → 空串（裁定 §13-4：关掉之后预设里可能还留着这个占位符）', () => {
    expect(render([entry()], { randomEventsEnabled: false })).toBe('');
    // 缺席不读作「关」——真正的空池由 offer 判，两个判据不许混
    expect(render([entry()])).not.toBe('');
    expect(render([entry()], { randomEventsEnabled: true })).not.toBe('');
  });

  it('🔴 战斗会话活跃 → 全面静默（裁定 §13-2：候选驻池不丢，战后下一回合恢复）', () => {
    expect(render([entry()], { combatActive: true })).toBe('');
    // 战后回执（recentCombat）**不是**活跃位：拿它静默会正好压掉该恢复注入的那几轮
    expect(
      render([entry()], {
        combatActive: false,
        recentCombat: { allies: ['我'], enemies: ['狼'], outcome: 'ally_win', endedAtTurn: 3 },
      }),
    ).not.toBe('');
  });
});

// ══════════════════════════════════════════════════════════════
// 块形状
// ══════════════════════════════════════════════════════════════

describe('{{RANDOM_EVENTS}} —— 块形状', () => {
  it('外壳自带，模板不必再包一层中文标签', () => {
    const out = render([entry()]);
    expect(out.startsWith('<random_events>\n')).toBe(true);
    expect(out.endsWith('\n</random_events>')).toBe(true);
  });

  it('指令段讲清三件事：至多一个 / 可以不触发列表会保留 / 回执标记名字逐字一致', () => {
    const out = render([entry()]);
    expect(out).toContain('至多一个');
    expect(out).toContain('本回合不方便可以不触发，列表会保留');
    expect(out).toContain('<event_trigger name="事件名"/>');
    expect(out).toContain('逐字一致');
  });

  it('一条候选一行：`- 〔优先级 N〕名字：简报`', () => {
    const out = render([entry({ name: '神秘商人', priority: 2, brief: '一名商人拦住去路。' })]);
    const line = out.split('\n').find((l) => l.startsWith('- '));
    expect(line).toBe('- 〔优先级 2〕神秘商人：一名商人拦住去路。');
  });

  it('detail 有就补一格（紧凑一行），没有就整格不写', () => {
    const withDetail = render([entry({ detail: '他认得玩家的来历。' })]);
    expect(withDetail).toContain('（演绎指引：他认得玩家的来历。）');
    expect(render([entry()])).not.toContain('演绎指引');
  });

  it('多行简报/指引折成一行 —— 一条候选恒占一行，否则列表读乱', () => {
    const out = render([entry({ brief: '第一行\n  第二行', detail: 'A\nB' })]);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(out).toContain('第一行 第二行');
    expect(out).toContain('（演绎指引：A B）');
  });
});

// ══════════════════════════════════════════════════════════════
// forced / 顺序
// ══════════════════════════════════════════════════════════════

describe('{{RANDOM_EVENTS}} —— 首访与顺序', () => {
  it('forced 条目带 [!] 且排在最前（顺序由数据面给，渲染层照单全收）', () => {
    const out = render([
      entry({ name: '初临此地', priority: 9, brief: '你第一次踏上这片土地。', forced: true }),
      entry({ name: '神秘商人', priority: 2 }),
    ]);
    const rows = out.split('\n').filter((l) => l.startsWith('- '));
    expect(rows[0]).toBe('- [!]〔优先级 9〕初临此地：你第一次踏上这片土地。');
    expect(rows[1]?.startsWith('- 〔')).toBe(true);
  });

  it('🔴 没有 forced 条目时不讲 [!] 的含义（讲一个列表里不存在的记号是在教它认幻觉）', () => {
    expect(render([entry()])).not.toContain('[!]');
    expect(render([entry({ forced: true })])).toContain('必须尽快触发');
  });
});

// ══════════════════════════════════════════════════════════════
// 与剧情系统的关系（§5.1 末段）
// ══════════════════════════════════════════════════════════════

describe('{{RANDOM_EVENTS}} —— 剧情兼容句', () => {
  it('剧情系统开着 → 追加一句「触发时机须与当前剧情推进兼容」', () => {
    const out = render([entry()], { plotSettings: { mode: 'main', tabooContent: '' } as never });
    expect(out).toContain('触发时机须与当前剧情推进兼容。');
  });

  it('🔴 剧情系统关着（含 plotSettings 缺席）→ 不追加：本系统可独立于剧情系统工作', () => {
    expect(
      render([entry()], { plotSettings: { mode: 'off', tabooContent: '' } as never }),
    ).not.toContain('剧情推进兼容');
    expect(render([entry()])).not.toContain('剧情推进兼容');
  });
});

// ══════════════════════════════════════════════════════════════
// 供值链路（blurByDefault 教训：单模块测试证明不了有人供值）
// ══════════════════════════════════════════════════════════════

const UI_SOURCES: Record<string, string> = import.meta.glob('@ui/lib/game-pipeline.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('AgentContext 供值', () => {
  it('🔴 game-pipeline 的 buildContext 真的传了三格（候选 / 总开关 / 战斗活跃位）', () => {
    const source = Object.values(UI_SOURCES)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);

    expect(source).toContain('randomEventOffer: this.buildRandomEventOffer()');
    expect(source).toContain('randomEventsEnabled: getEngineSettings().randomEventsEnabled');
    // 战斗活跃位取 isInCombat（就绪/结算确认/v2/v3 四判据同源），不是 recentCombat
    expect(source).toContain('combatActive: this.game.isInCombat');
  });

  it('🔴 候选快照走纯函数 buildRandomEventOffer，且喂的是 flags + pack + 当日', () => {
    const source = Object.values(UI_SOURCES)[0] ?? '';
    expect(source).toContain("from '@engine/random-event-context'");
    expect(source).toContain('getRandomEventFlags(profile)');
    expect(source).toContain('getRandomEventPack()');
  });
});
