/**
 * memory-summarizer.ts — 记忆总结引擎测试
 *
 * 覆盖:
 * - validateMemoryContent: 空字符串 / 短内容 / 有效内容 / 自定义 minChars
 * - parseMemorySummaryOutput: 有效 JSON / 部分缺失 JSON / 嵌入文本中的 JSON / 无效文本
 * - generateMemoryId: 无已有记忆 / 有记忆 / 有间隔 / 混入非 MEM ID
 * - createCompressionSummaryMemory: 字段验证 / 时间范围从 oldest/newest 提取
 * - summarizeAndSave: 完整管线（mocked 依赖） / 解析失败 / 校验失败 / 有/无 embedding endpoint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryRecord } from './types';

// ═══════════════════════════════════════════════════════════
// Mock 数据库 & memory-store — 必须在 import 被测模块之前
// ═══════════════════════════════════════════════════════════

const mockGetMemories = vi.fn();
const mockSaveMemory = vi.fn();
const mockComputeEmbedding = vi.fn();

vi.mock('./database', () => ({
  getMemories: (...args: any[]) => mockGetMemories(...args),
  saveMemory: (...args: any[]) => mockSaveMemory(...args),
}));

vi.mock('./memory-store', () => ({
  computeEmbedding: (...args: any[]) => mockComputeEmbedding(...args),
}));

import {
  generateMemoryId,
  validateMemoryContent,
  parseMemorySummaryOutput,
  summarizeAndSave,
  createCompressionSummaryMemory,
} from './memory-summarizer';
import type { MemorySummaryOutput } from './memory-summarizer';

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'MEM000001',
    saveId: 'save_test',
    createdAt: 1000000,
    realTimestamp: 2000000,
    timeRange: { start: '001-01-01', end: '001-01-02' },
    content: '这是一条测试记忆，内容足够长以满足最低字数要求。'.repeat(4),
    hiddenLine: '暗线测试内容',
    keywords: ['测试', '记忆'],
    relatedCharacterIds: ['char_1'],
    importance: 5,
    ...overrides,
  };
}

/** 生成满足最低字数 (≥200) 的内容 */
function longContent(label = '记忆'): string {
  return `这是${label}的正文内容，需要满足最低200字的要求。`.repeat(9);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════
// validateMemoryContent
// ═══════════════════════════════════════════════════════════

describe('validateMemoryContent', () => {
  it('空字符串应返回 valid=false，reason 包含"为空"', () => {
    const r = validateMemoryContent('');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('为空');
  });

  it('纯空白字符串应返回 valid=false', () => {
    const r = validateMemoryContent('   \n  \t  ');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('为空');
  });

  it('内容不足默认 200 字应返回 valid=false 并报告字数', () => {
    const short = '短内容';
    const r = validateMemoryContent(short);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('不足');
    expect(r.reason).toContain('200');
    expect(r.reason).toContain(String(short.length));
  });

  it('内容刚好满足默认 200 字应返回 valid=true', () => {
    const exact200 = 'A'.repeat(200);
    const r = validateMemoryContent(exact200);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('内容超过 200 字应返回 valid=true', () => {
    const r = validateMemoryContent(longContent());
    expect(r.valid).toBe(true);
  });

  it('自定义 minChars=100 时，100 字内容应通过校验', () => {
    const exact100 = 'B'.repeat(100);
    const r = validateMemoryContent(exact100, 100);
    expect(r.valid).toBe(true);
  });

  it('自定义 minChars=500 时，200 字内容应校验失败', () => {
    const content200 = 'C'.repeat(200);
    const r = validateMemoryContent(content200, 500);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('500');
    expect(r.reason).toContain('200');
  });
});

// ═══════════════════════════════════════════════════════════
// parseMemorySummaryOutput
// ═══════════════════════════════════════════════════════════

describe('parseMemorySummaryOutput', () => {
  it('完整合法 JSON 应解析成功并返回全部字段', () => {
    const json = JSON.stringify({
      content: longContent('童年'),
      hiddenLine: '暗线：主角失忆前的身份',
      keywords: ['失忆', '童年', '师父', '剑术'],
      importance: 8,
      timeRangeStart: '015-03-15',
      timeRangeEnd: '015-06-20',
    });
    const result = parseMemorySummaryOutput(json);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(longContent('童年'));
    expect(result!.hiddenLine).toBe('暗线：主角失忆前的身份');
    expect(result!.keywords).toEqual(['失忆', '童年', '师父', '剑术']);
    expect(result!.importance).toBe(8);
    expect(result!.timeRangeStart).toBe('015-03-15');
    expect(result!.timeRangeEnd).toBe('015-06-20');
  });

  it('keywords 超过 8 个时应收割为 8 个', () => {
    const json = JSON.stringify({
      content: longContent(),
      hiddenLine: '暗线',
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'],
      importance: 5,
    });
    const result = parseMemorySummaryOutput(json);
    expect(result).not.toBeNull();
    expect(result!.keywords).toHaveLength(8);
  });

  it('缺少 content 字段应返回 null', () => {
    const json = JSON.stringify({
      hiddenLine: '暗线',
      keywords: ['测试'],
    });
    expect(parseMemorySummaryOutput(json)).toBeNull();
  });

  it('缺少 hiddenLine 字段应返回 null', () => {
    const json = JSON.stringify({
      content: longContent(),
      keywords: ['测试'],
    });
    expect(parseMemorySummaryOutput(json)).toBeNull();
  });

  it('keywords 不是数组应返回 null', () => {
    const json = JSON.stringify({
      content: longContent(),
      hiddenLine: '暗线',
      keywords: '不是数组',
    });
    expect(parseMemorySummaryOutput(json)).toBeNull();
  });

  it('部分字段缺失时应使用默认值（timeRange 默认 "未知"）', () => {
    const json = JSON.stringify({
      content: longContent(),
      hiddenLine: '暗线',
      keywords: ['记忆'],
      importance: 9,
      // 不提供 timeRangeStart / timeRangeEnd
    });
    const result = parseMemorySummaryOutput(json);
    expect(result).not.toBeNull();
    expect(result!.timeRangeStart).toBe('未知');
    expect(result!.timeRangeEnd).toBe('未知');
  });

  it('importance 超出 1-10 范围时应 clamp', () => {
    const tooLow = JSON.stringify({
      content: longContent(),
      hiddenLine: '暗线',
      keywords: ['重要'],
      importance: -5,
    });
    const tooHigh = JSON.stringify({
      content: longContent(),
      hiddenLine: '暗线',
      keywords: ['重要'],
      importance: 99,
    });

    const rLow = parseMemorySummaryOutput(tooLow);
    const rHigh = parseMemorySummaryOutput(tooHigh);

    expect(rLow!.importance).toBe(1);
    expect(rHigh!.importance).toBe(10);
  });

  it('完全无效的文本应返回 null', () => {
    expect(parseMemorySummaryOutput('这是纯文本，不包含任何 JSON')).toBeNull();
    expect(parseMemorySummaryOutput('')).toBeNull();
  });

  it('嵌入在文本中的 JSON 应能被提取解析', () => {
    const wrapped = `这是一段 AI 的前言文本...
\`\`\`json
{
  "content": "${longContent('嵌入')}",
  "hiddenLine": "暗线内容",
  "keywords": ["嵌入", "测试"],
  "importance": 6,
  "timeRangeStart": "001-01-01",
  "timeRangeEnd": "001-01-05"
}
\`\`\`
这是后记文本。`;
    const result = parseMemorySummaryOutput(wrapped);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(longContent('嵌入'));
    expect(result!.hiddenLine).toBe('暗线内容');
    expect(result!.keywords).toEqual(['嵌入', '测试']);
  });

  it('嵌入文本中缺少 content 时应返回 null', () => {
    const wrapped = '前言 { "hiddenLine": "暗线", "keywords": ["k"] } 后记';
    expect(parseMemorySummaryOutput(wrapped)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// generateMemoryId
// ═══════════════════════════════════════════════════════════

describe('generateMemoryId', () => {
  it('无已有记忆时应返回 MEM000001', async () => {
    mockGetMemories.mockResolvedValue([]);
    const id = await generateMemoryId('save_1');
    expect(id).toBe('MEM000001');
    expect(mockGetMemories).toHaveBeenCalledWith('save_1');
  });

  it('已有 MEM000001-MEM000005 时应返回 MEM000006', async () => {
    mockGetMemories.mockResolvedValue([
      makeMemory({ id: 'MEM000001' }),
      makeMemory({ id: 'MEM000003' }),
      makeMemory({ id: 'MEM000005' }),
    ]);
    const id = await generateMemoryId('save_1');
    expect(id).toBe('MEM000006');
  });

  it('记忆 ID 有间隔时应找到最大编号并 +1', async () => {
    mockGetMemories.mockResolvedValue([
      makeMemory({ id: 'MEM000001' }),
      makeMemory({ id: 'MEM000042' }),
      makeMemory({ id: 'MEM000007' }),
    ]);
    const id = await generateMemoryId('save_1');
    expect(id).toBe('MEM000043');
  });

  it('混入非 MEM 格式的 ID 时应忽略它们', async () => {
    mockGetMemories.mockResolvedValue([
      makeMemory({ id: 'MEM000003' }),
      makeMemory({ id: 'old_format_999' }),
      makeMemory({ id: 'custom-id' }),
      makeMemory({ id: 'MEM000001' }),
      makeMemory({ id: '' }),
    ]);
    const id = await generateMemoryId('save_1');
    // 只有 MEM000003 和 MEM000001 是合法格式，最大 = 3，所以下一个是 4
    expect(id).toBe('MEM000004');
  });

  it('所有 ID 都非 MEM 格式时应返回 MEM000001', async () => {
    mockGetMemories.mockResolvedValue([
      makeMemory({ id: 'random-uuid' }),
      makeMemory({ id: 'legacy-001' }),
    ]);
    const id = await generateMemoryId('save_1');
    expect(id).toBe('MEM000001');
  });
});

// ═══════════════════════════════════════════════════════════
// createCompressionSummaryMemory
// ═══════════════════════════════════════════════════════════

describe('createCompressionSummaryMemory', () => {
  const oldMemories: MemoryRecord[] = [
    makeMemory({
      id: 'MEM000001',
      createdAt: 1000000,
      timeRange: { start: '001-01-01', end: '001-01-05' },
    }),
    makeMemory({
      id: 'MEM000002',
      createdAt: 2000000,
      timeRange: { start: '001-02-01', end: '001-02-10' },
    }),
    makeMemory({
      id: 'MEM000003',
      createdAt: 3000000,
      timeRange: { start: '001-03-01', end: '001-03-15' },
    }),
  ];

  it('应正确设置 saveId、content、hiddenLine、keywords、importance', () => {
    const result = createCompressionSummaryMemory(
      'save_cmp',
      oldMemories,
      '这是压缩后的摘要正文，长度超过200字符，用于验证字段正确性。'.repeat(6),
      '压缩暗线',
      ['压缩', '摘要'],
      7,
    );

    expect(result.saveId).toBe('save_cmp');
    expect(result.content).toContain('压缩后的摘要正文');
    expect(result.hiddenLine).toBe('压缩暗线');
    expect(result.keywords).toEqual(['压缩', '摘要']);
    expect(result.importance).toBe(7);
    expect(result.relatedCharacterIds).toEqual([]);
  });

  it('createdAt 应取最早记忆的时间戳', () => {
    const result = createCompressionSummaryMemory(
      'save_cmp',
      oldMemories,
      longContent('压缩'),
      '暗线',
      ['k'],
      5,
    );
    expect(result.createdAt).toBe(1000000); // oldest memory's createdAt
  });

  it('timeRange.start 应取第一条记忆的 start', () => {
    const result = createCompressionSummaryMemory(
      'save_cmp',
      oldMemories,
      longContent('压缩'),
      '暗线',
      ['k'],
      5,
    );
    expect(result.timeRange.start).toBe('001-01-01');
  });

  it('timeRange.end 应取最后一条记忆的 end', () => {
    const result = createCompressionSummaryMemory(
      'save_cmp',
      oldMemories,
      longContent('压缩'),
      '暗线',
      ['k'],
      5,
    );
    expect(result.timeRange.end).toBe('001-03-15');
  });

  it('空记忆列表时应使用默认值', () => {
    const result = createCompressionSummaryMemory(
      'save_empty',
      [],
      longContent('空'),
      '暗线',
      ['空'],
      3,
    );
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.timeRange.start).toBe('未知');
    expect(result.timeRange.end).toBe('未知');
  });

  it('不应包含 id 和 embedding 字段', () => {
    const result = createCompressionSummaryMemory(
      'save_cmp',
      oldMemories,
      longContent('压缩'),
      '暗线',
      ['k'],
      5,
    );
    expect('id' in result).toBe(false);
    expect('embedding' in result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// summarizeAndSave
// ═══════════════════════════════════════════════════════════

describe('summarizeAndSave', () => {
  const validOutput = JSON.stringify({
    content: longContent('冒险'),
    hiddenLine: '暗线：主角即将觉醒',
    keywords: ['冒险', '觉醒', '龙', '遗迹'],
    importance: 7,
    timeRangeStart: '015-06-01',
    timeRangeEnd: '015-06-10',
  });

  const embeddingEndpoint = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key',
    defaultModel: 'deepseek-chat',
  };

  beforeEach(() => {
    mockGetMemories.mockResolvedValue([]); // 默认无已有记忆 → MEM000001
    mockSaveMemory.mockResolvedValue('MEM000001');
    mockComputeEmbedding.mockResolvedValue(new Array(128).fill(0.1));
  });

  it('完整管线（含 embedding）应成功保存并返回 MemoryRecord', async () => {
    const result = await summarizeAndSave({
      saveId: 'save_1',
      agentRawOutput: validOutput,
      embeddingEndpoint,
      relatedCharacterIds: ['char_a', 'char_b'],
      relatedPlotEventId: 'plot_1',
      gameTimeRange: { start: '015-06-01', end: '015-06-10' },
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('MEM000001');
    expect(result!.saveId).toBe('save_1');
    expect(result!.content).toBe(longContent('冒险'));
    expect(result!.hiddenLine).toBe('暗线：主角即将觉醒');
    expect(result!.keywords).toEqual(['冒险', '觉醒', '龙', '遗迹']);
    expect(result!.importance).toBe(7);
    expect(result!.relatedCharacterIds).toEqual(['char_a', 'char_b']);
    expect(result!.relatedPlotEventId).toBe('plot_1');
    expect(result!.embedding).toBeDefined();
    expect(result!.embedding).toHaveLength(128);

    expect(mockComputeEmbedding).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(result);
  });

  it('不提供 embeddingEndpoint 时应保存无 embedding 的记忆', async () => {
    const result = await summarizeAndSave({
      saveId: 'save_2',
      agentRawOutput: validOutput,
    });

    expect(result).not.toBeNull();
    expect(result!.embedding).toBeUndefined();
    expect(mockComputeEmbedding).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledWith(result);
  });

  it('embedding 计算失败时应降级保存（无 embedding）', async () => {
    mockComputeEmbedding.mockRejectedValue(new Error('Embedding API 不可用'));

    const result = await summarizeAndSave({
      saveId: 'save_3',
      agentRawOutput: validOutput,
      embeddingEndpoint,
    });

    expect(result).not.toBeNull();
    expect(result!.embedding).toBeUndefined();
    expect(mockSaveMemory).toHaveBeenCalled(); // 仍然保存
  });

  it('解析失败时应抛出异常', async () => {
    await expect(
      summarizeAndSave({
        saveId: 'save_4',
        agentRawOutput: '纯文本，无法解析',
      }),
    ).rejects.toThrow('无法解析');
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('校验失败（content 不足 200 字）时应抛出异常', async () => {
    const shortOutput = JSON.stringify({
      content: '太短',
      hiddenLine: '暗线',
      keywords: ['短'],
      importance: 1,
    });

    await expect(
      summarizeAndSave({
        saveId: 'save_5',
        agentRawOutput: shortOutput,
      }),
    ).rejects.toThrow('记忆校验失败');
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('已有 5 条记忆时应生成 MEM000006', async () => {
    mockGetMemories.mockResolvedValue([
      makeMemory({ id: 'MEM000001' }),
      makeMemory({ id: 'MEM000002' }),
      makeMemory({ id: 'MEM000003' }),
      makeMemory({ id: 'MEM000004' }),
      makeMemory({ id: 'MEM000005' }),
    ]);

    const result = await summarizeAndSave({
      saveId: 'save_6',
      agentRawOutput: validOutput,
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('MEM000006');
  });

  it('不提供 gameTimeRange 时应使用解析出的 timeRange', async () => {
    const result = await summarizeAndSave({
      saveId: 'save_7',
      agentRawOutput: validOutput,
    });

    expect(result!.timeRange.start).toBe('015-06-01');
    expect(result!.timeRange.end).toBe('015-06-10');
  });

  it('提供 gameTimeRange 时应覆盖解析出的时间', async () => {
    const result = await summarizeAndSave({
      saveId: 'save_8',
      agentRawOutput: validOutput,
      gameTimeRange: { start: 'CUSTOM_START', end: 'CUSTOM_END' },
    });

    expect(result!.timeRange.start).toBe('CUSTOM_START');
    expect(result!.timeRange.end).toBe('CUSTOM_END');
  });
});
