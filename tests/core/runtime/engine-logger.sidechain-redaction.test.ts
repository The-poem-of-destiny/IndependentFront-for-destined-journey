/**
 * 侧链开始条目的密钥回归：entity_gen / craft_gen 的「侧链开始」曾在 info 级记录整份
 * request（含 endpoint.apiKey 与 headerOverrides）。那一刻 AgentClient 还没构造、密钥还没
 * 登记，短于 6 字符的头值更是永不登记 —— 两者都会明文落盘。
 *
 * 这里装内存 sink、触发侧链开始条目（clientFactory 直接抛，模拟「密钥登记之前」），
 * 断言 apiKey 与短头值不出现在任何条目里。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  resetEngineLoggerForTest,
} from '../../../src/core/runtime/engine-logger';
import type { EngineLogEntry, EngineLogSink } from '../../../src/core/runtime/engine-logger';
import { runEntityGenChain } from '../../../src/core/agents/entity-gen-agent';
import type { EntityGenRequest } from '../../../src/core/agents/entity-gen-agent';
import { runCraftGenChain } from '../../../src/core/crafting/craft-gen-chain';
import type { CraftGenRequest } from '../../../src/core/crafting/craft-gen-chain';
import type { AgentContext, ApiEndpoint } from '../../../src/core/types/types';

const API_KEY = 'sk-sidechain-REGRESSION-0001';
const SHORT_HEADER = 'h7x';

class MemorySink implements EngineLogSink {
  rows: EngineLogEntry[] = [];
  async write(entries: EngineLogEntry[]): Promise<void> {
    this.rows.push(...entries.map((entry) => ({ ...entry })));
  }
  async getLayerHead(): Promise<{ layer: number }> {
    return { layer: 0 };
  }
}

function makeEndpoint(): ApiEndpoint {
  return {
    id: 'ep-1',
    name: '测试端点',
    provider: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: API_KEY,
    defaultModel: 'model-x',
    models: ['model-x'],
    timeout: 60000,
    headerOverrides: { 'X-Tenant': SHORT_HEADER },
  };
}

function makeContext(): AgentContext {
  return {
    userInput: '输入',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
  } as unknown as AgentContext;
}

/** 构造客户端之前就失败：密钥此时一个都没登记 */
function failingFactory(): never {
  throw new Error('client 构造失败');
}

let sink: MemorySink;

beforeEach(() => {
  resetEngineLoggerForTest();
  sink = new MemorySink();
  installEngineLogSink(sink);
  configureEngineLogger({ enabled: true, level: 'trace' });
});

afterEach(() => {
  resetEngineLoggerForTest();
});

function expectNoSecrets(): void {
  const all = JSON.stringify(sink.rows);
  expect(all).not.toContain(API_KEY);
  expect(all).not.toContain(SHORT_HEADER);
}

describe('侧链开始条目不泄漏端点凭据', () => {
  it('entity_gen：只记白名单字段，apiKey 与短头值不在任何条目里', async () => {
    const request: EntityGenRequest = {
      saveId: 'save-1',
      marker: {
        type: 'entity_gen_request',
        rawContent: '<entity_gen_request type="item">药水</entity_gen_request>',
        position: 0,
        attributes: { entityType: 'item' },
        bodyText: '药水',
      },
      context: makeContext(),
      endpoint: makeEndpoint(),
      worldBooks: [],
      presets: [],
      configs: [],
    };
    await runEntityGenChain(request, { clientFactory: failingFactory }).catch(() => undefined);
    await flushEngineLog();

    const start = sink.rows.find((row) => row.msg === 'entity_gen 侧链开始');
    expect(start).toBeDefined();
    const payload = JSON.parse(start!.payload) as Record<string, unknown>;
    expect(payload.endpoint).toEqual({ id: 'ep-1', name: '测试端点' });
    expect(payload.model).toBe('model-x');
    expect(payload).not.toHaveProperty('worldBooks');
    expect(payload).not.toHaveProperty('context');
    expectNoSecrets();
  });

  it('craft_gen：只记白名单字段，apiKey 与短头值不在任何条目里', async () => {
    const request: CraftGenRequest = {
      saveId: 'save-1',
      marker: {
        type: 'craft_gen_request',
        rawContent: '<craft_gen_request>长剑</craft_gen_request>',
        position: 0,
        attributes: { productName: '长剑' },
        bodyText: '长剑',
      },
      storyOutput: '正文',
      context: makeContext(),
      endpoint: makeEndpoint(),
      worldBooks: [],
      presets: [],
      configs: [],
    };
    await runCraftGenChain(request, { clientFactory: failingFactory }).catch(() => undefined);
    await flushEngineLog();

    const start = sink.rows.find((row) => row.msg === 'craft_gen 侧链开始');
    expect(start).toBeDefined();
    const payload = JSON.parse(start!.payload) as Record<string, unknown>;
    expect(payload.endpoint).toEqual({ id: 'ep-1', name: '测试端点' });
    expect(payload).not.toHaveProperty('worldBooks');
    expectNoSecrets();
  });
});
