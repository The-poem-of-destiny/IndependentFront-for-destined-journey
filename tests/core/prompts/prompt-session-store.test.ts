/**
 * prompt-session-store.test.ts — Delta 会话持久化（问题 2，2026-09-26）
 *
 * 覆盖：刷新后从 Dexie 续用（而不是冷基线）、签名变化仍重基线、invalidate 删行、
 * 删除存档级联删。用 fake-indexeddb（tests/setup.ts 注入）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearAllData,
  getDatabase,
  initializeDatabase,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { createDexiePromptSessionStore } from '../../../src/core/prompts/prompt-session-store';
import {
  activePromptSessionCount,
  completePromptSession,
  installPromptSessionStore,
  invalidatePromptSession,
  preparePromptSession,
  resetPromptSessionsForTest,
  type PreparePromptSessionInput,
} from '../../../src/core/prompts/prompt-session-assembler';
import { fixtureWorldBook } from '../fixtures/prompt-session/prompt-session-fixture';
import type { AgentConfig, AgentContext } from '../../../src/core/types/types';

const SAVE_ID = 'persist-save';

function makeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'request_dispatcher',
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
    systemPrompt: '你是请求调度器。',
    template: '{{SYS_PROMPT}}\n{{USER_INPUT}}',
    ...overrides,
  };
}

function baseContext(): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
  };
}

function input(overrides: Partial<PreparePromptSessionInput> = {}): PreparePromptSessionInput {
  return {
    saveId: SAVE_ID,
    agentId: 'request_dispatcher',
    ctx: baseContext(),
    configs: [makeCfg()],
    worldBooks: [fixtureWorldBook],
    endpointId: 'ep-test',
    model: 'model-test',
    ...overrides,
  };
}

async function waitForRowCount(expected: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await getDatabase().promptSessions.count()).toBe(expected);
  });
}

describe('prompt-session-store', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
    resetPromptSessionsForTest();
    installPromptSessionStore(createDexiePromptSessionStore());
  });

  afterEach(() => {
    installPromptSessionStore(null);
    resetPromptSessionsForTest();
  });

  it('刷新后续用：内存清空后从 Dexie 恢复 transcript，第二轮不重基线', async () => {
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: '第一轮回复。' });
    await waitForRowCount(1);

    // 模拟页面刷新：内存会话全丢，仅剩 Dexie 行
    resetPromptSessionsForTest();
    expect(activePromptSessionCount()).toBe(0);

    const p2 = await preparePromptSession(input());
    expect(p2.rebased).toBe(false);
    expect(p2.handle?.revision).toBe(2);
    // 恢复出来的 transcript 含上一轮 assistant，仍是精确前缀
    expect(p2.messages.some((m) => m.role === 'assistant' && m.content === '第一轮回复。')).toBe(
      true,
    );
  });

  it('持久化行签名与当前配置不符时冷建基线（不续用陈旧 transcript）', async () => {
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: '第一轮回复。' });
    await waitForRowCount(1);

    resetPromptSessionsForTest();
    const p2 = await preparePromptSession(input({ tailPrompt: '新增末尾指令' }));
    expect(p2.rebased).toBe(true);
    expect(p2.rebaseReason).toBe('signature_changed');
  });

  it('invalidatePromptSession(saveId) 删除该存档的持久化行', async () => {
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: '第一轮回复。' });
    await waitForRowCount(1);

    invalidatePromptSession(SAVE_ID);
    await waitForRowCount(0);
  });

  it('删除存档级联删除 promptSessions 行', async () => {
    const p1 = await preparePromptSession(input());
    completePromptSession(p1.handle!, { rawResponse: '第一轮回复。' });
    await waitForRowCount(1);

    await saveSaveSlot({
      id: SAVE_ID,
      slot: 1,
      name: '测试存档',
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    } as never);
    const { deleteSaveSlot } = await import('../../../src/core/persistence/database');
    await deleteSaveSlot(SAVE_ID);
    await waitForRowCount(0);
  });
});
