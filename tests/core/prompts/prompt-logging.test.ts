/**
 * 提示装配脚手架的引擎日志埋点（代表性断言）：
 * - `resolveTemplate` 在 trace 级逐个记录占位符解析结果
 * - `assemblePresetContent` 记录启用条目、宏预处理前后与预填充
 * - 日志器关闭时两者都不产生条目，且返回值不变
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTemplate } from '../../../src/core/prompts/template-resolver';
import { assemblePresetContent } from '../../../src/core/prompts/preset-loader';
import {
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  resetEngineLoggerForTest,
} from '../../../src/core/runtime/engine-logger';
import type {
  EngineLogEntry,
  EngineLogLayerHead,
  EngineLogSink,
} from '../../../src/core/runtime/engine-logger';
import type { AgentConfig, AgentContext, AgentPreset } from '../../../src/core/types/types';

class MemorySink implements EngineLogSink {
  rows: EngineLogEntry[] = [];
  async write(entries: EngineLogEntry[]): Promise<void> {
    this.rows.push(...entries.map((entry) => ({ ...entry })));
  }
  async getLayerHead(): Promise<EngineLogLayerHead> {
    return { layer: 0 };
  }
}

const ctx = {} as AgentContext;
const config = { agentId: 'story' } as AgentConfig;

function makePreset(): AgentPreset {
  return {
    id: 'preset-1',
    name: '测试预设',
    fixedSystem: '',
    fixedExamples: '',
    settings: {
      prefill: { enabled: true },
      prompts: [
        {
          identifier: 'a',
          role: 'system',
          content: '{{setvar::称呼::旅人}}你好，{{getvar::称呼}} {{USER_INPUT}}',
          enabled: true,
          injection_order: 10,
        },
        {
          identifier: 'b',
          role: 'system',
          content: '停用条目',
          enabled: false,
          injection_order: 15,
        },
        {
          identifier: 'c',
          role: 'assistant',
          content: '预填充前缀',
          enabled: true,
          injection_order: 20,
        },
      ],
    },
  } as unknown as AgentPreset;
}

let sink: MemorySink;

beforeEach(() => {
  resetEngineLoggerForTest();
  sink = new MemorySink();
  installEngineLogSink(sink);
});

afterEach(() => {
  resetEngineLoggerForTest();
});

describe('prompt.placeholder', () => {
  it('trace 级逐个记录占位符名、来源与解析结果', async () => {
    configureEngineLogger({ enabled: true, level: 'trace' });
    const out = resolveTemplate('A {{FOO}} B {{ZZZ_NOT_REGISTERED}}', 'story', ctx, config, {
      FOO: '本地值',
    });
    expect(out).toBe('A 本地值 B {{ZZZ_NOT_REGISTERED}}');
    await flushEngineLog();
    const row = sink.rows.find((r) => r.cat === 'prompt.placeholder');
    expect(row).toBeDefined();
    expect(row!.level).toBe('trace');
    expect(JSON.parse(row!.payload).placeholders).toEqual([
      { name: 'FOO', params: '', source: 'local', value: '本地值' },
      { name: 'ZZZ_NOT_REGISTERED', params: '', source: 'unknown', value: null },
    ]);
  });

  it('debug 级不记占位符明细', async () => {
    configureEngineLogger({ enabled: true, level: 'debug' });
    resolveTemplate('{{FOO}}', 'story', ctx, config, { FOO: 'x' });
    await flushEngineLog();
    expect(sink.rows.filter((r) => r.cat === 'prompt.placeholder')).toHaveLength(0);
  });
});

describe('prompt.preset', () => {
  it('记录启用/跳过的条目、宏预处理前后与预填充', async () => {
    configureEngineLogger({ enabled: true, level: 'debug' });
    const out = assemblePresetContent(makePreset());
    await flushEngineLog();
    const row = sink.rows.find((r) => r.cat === 'prompt.preset');
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.enabledEntries.map((e: { identifier: string }) => e.identifier)).toEqual(['a']);
    expect(payload.skippedEntries.map((e: { identifier: string }) => e.identifier)).toEqual([
      'b',
      'c',
    ]);
    expect(payload.macroPreprocessed).toBe(true);
    expect(payload.beforeMacros).toContain('{{getvar::称呼}}');
    expect(payload.afterMacros).toContain('你好，旅人');
    expect(payload.prefill).toEqual({ field: 'content', content: '预填充前缀' });
    expect(payload.result).toBe(out);
  });
});

describe('日志器关闭', () => {
  it('不产生条目且返回值与开启时一致', async () => {
    const offTemplate = resolveTemplate('A {{FOO}}', 'story', ctx, config, { FOO: '值' });
    const offPreset = assemblePresetContent(makePreset());
    await flushEngineLog();
    expect(sink.rows).toHaveLength(0);

    configureEngineLogger({ enabled: true, level: 'trace' });
    expect(resolveTemplate('A {{FOO}}', 'story', ctx, config, { FOO: '值' })).toBe(offTemplate);
    expect(assemblePresetContent(makePreset())).toBe(offPreset);
  });
});
