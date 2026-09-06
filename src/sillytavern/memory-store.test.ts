/**
 * memory-store.ts — Embedding 召回引擎 & 记忆压缩测试
 *
 * Tests: cosineSimilarity, computeEmbedding, recallMemories,
 *         getRoundCount, checkCompressionNeeded, applyCompression,
 *         saveMemoryWithEmbedding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmbeddingMetadata, MemoryRecord } from './types';
// type-only import：不产生运行时依赖，vi.mock 仍能正常拦截 './memory-store'
import type { RecallDiagnostics } from './memory-store';

// ═══════════════════════════════════════════════════════════════
// Mock hoisting — function refs available before module import
// ═══════════════════════════════════════════════════════════════

const mockGetMemories = vi.hoisted(() => vi.fn());
const mockSaveMemory = vi.hoisted(() => vi.fn());
const mockDeleteMemories = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

// Mock database module (hoisted by Vitest)
vi.mock('./database', () => ({
  getMemories: mockGetMemories,
  getRecentMemories: vi.fn(),
  saveMemory: mockSaveMemory,
  deleteMemories: mockDeleteMemories,
}));

// Stub global fetch
vi.stubGlobal('fetch', mockFetch);

// ═══════════════════════════════════════════════════════════════
// Dynamic import after mocks are applied
// ═══════════════════════════════════════════════════════════════

const {
  computeEmbedding,
  computeEmbeddingWithMeta,
  cosineSimilarity,
  recallMemories,
  getRoundCount,
  checkCompressionNeeded,
  applyCompression,
  saveMemoryWithEmbedding,
  computeEmbeddingSpaceId,
  normalizeEndpointIdentity,
  buildEmbeddingMetadata,
  buildEmbeddingText,
  validateEmbeddingVector,
  classifyStoredVector,
  hashTextDeterministic,
  EMBEDDING_PREPROCESSING_VERSION,
  MAX_EMBEDDING_DIMENSIONS,
} = await import('./memory-store');

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeEndpoint(
  overrides: Partial<{ baseUrl: string; apiKey: string; defaultModel: string }> = {},
) {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key-12345',
    defaultModel: 'deepseek-chat',
    ...overrides,
  };
}

/**
 * 为某条记忆构造与 `makeEndpoint()` 同空间的元数据（recall 余弦用例需要查询端与
 * 存储端 spaceId 一致，否则按 F09 语义会判 incompatible）。
 */
function metaFor(embedding: number[], model = 'deepseek-chat'): EmbeddingMetadata {
  return buildEmbeddingMetadata(embedding, makeEndpoint(), model, 'test-input');
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `MEM${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
    saveId: 'save_test',
    createdAt: Date.now(),
    realTimestamp: Date.now(),
    timeRange: { start: '001-01-01', end: '001-01-02' },
    content: '这是一条测试记忆，内容足够长以满足最低字数要求。'.repeat(4),
    hiddenLine: '暗线内容：测试暗线数据',
    keywords: ['测试', '记忆'],
    relatedCharacterIds: ['char_1'],
    importance: 5,
    ...overrides,
  };
}

/** Create N memories with sequential ids and timestamps */
function makeMemories(
  count: number,
  saveId = 'save_test',
  baseOpts: Partial<MemoryRecord> = {},
): MemoryRecord[] {
  return Array.from({ length: count }, (_, i) =>
    makeMemory({
      id: `MEM${String(i + 1).padStart(6, '0')}`,
      saveId,
      createdAt: 1000 + i * 10,
      realTimestamp: Date.now() + i * 1000,
      importance: (i % 10) + 1,
      keywords: [`keyword_${i}`],
      ...baseOpts,
    }),
  );
}

/** Fake embedding response from OpenAI-compatible API */
function makeEmbeddingResponse(embedding: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 8, total_tokens: 8 },
    }),
    text: async () => '',
  };
}

/** Fake error response */
function makeErrorResponse(status: number, body = 'Internal Server Error') {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  };
}

// Type-safe mock helpers to avoid "never" inference issues
function mockGetMemoriesResolved(memories: MemoryRecord[]) {
  mockGetMemories.mockResolvedValueOnce(memories);
}

function mockFetchResolved(embedding: number[]) {
  mockFetch.mockResolvedValueOnce(makeEmbeddingResponse(embedding));
}

function mockFetchRejected(error: Error) {
  mockFetch.mockRejectedValueOnce(error);
}

function mockFetchErrorResolved(status: number, body?: string) {
  mockFetch.mockResolvedValueOnce(makeErrorResponse(status, body));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// 1. cosineSimilarity — pure unit tests (no DB, no fetch)
// ═══════════════════════════════════════════════════════════════

describe('cosineSimilarity', () => {
  it('identical vectors should return 1', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('scaled identical vectors should return 1 (direction matters, not magnitude)', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it('orthogonal vectors should return 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('opposite vectors should return -1', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });

  it('different dimensions should throw', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(() => cosineSimilarity(a, b)).toThrow('向量维度不匹配');
  });

  it('zero vector with non-zero returns 0 (denominator guard)', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('both zero vectors should return 0', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('generic similarity for non-trivial vectors (same direction)', () => {
    const a = [0.1, 0.3, 0.5, 0.7];
    const b = [0.2, 0.4, 0.6, 0.8];
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('partially similar vectors (exact 0.5)', () => {
    const a = [1, 0, 1, 0];
    const b = [1, 1, 0, 0];
    // cos = (1*1 + 0*1 + 1*0 + 0*0) / (sqrt(2)*sqrt(2)) = 1/2 = 0.5
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 10);
  });

  it('empty vectors should return 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. computeEmbedding — mock fetch
// ═══════════════════════════════════════════════════════════════

describe('computeEmbedding', () => {
  it('should return embedding on success', async () => {
    const expectedEmbedding = [0.01, 0.02, 0.03, 0.04, 0.05];
    mockFetchResolved(expectedEmbedding);

    const result = await computeEmbedding('hello world', makeEndpoint());

    expect(result).toEqual(expectedEmbedding);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toBe('/api/embeddings');
  });

  it('reports provider usage and request metadata to the debug observer', async () => {
    mockFetchResolved([0.1, 0.2, 0.3]);
    const observe = vi.fn();

    await (computeEmbedding as any)(
      'billable input',
      makeEndpoint(),
      undefined,
      undefined,
      observe,
    );

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'billable input',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        promptTokens: 8,
        totalTokens: 8,
        dimensions: 3,
      }),
    );
  });

  it('should use custom model when provided', async () => {
    mockFetchResolved([0.1, 0.2]);

    await computeEmbedding('test', makeEndpoint(), 'custom-model');

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.model).toBe('custom-model');
  });

  it('should fall back to defaultModel when model not provided', async () => {
    mockFetchResolved([0.1, 0.2]);

    await computeEmbedding('test', makeEndpoint({ defaultModel: 'default-embed' }));

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.model).toBe('default-embed');
  });

  it('should use the text as input in the request', async () => {
    mockFetchResolved([0.1]);

    await computeEmbedding('some input text', makeEndpoint());

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.input).toBe('some input text');
  });

  it('should throw on HTTP error response (500)', async () => {
    mockFetchErrorResolved(500, 'Server Error');

    await expect(computeEmbedding('test', makeEndpoint())).rejects.toThrow('Embedding API 500');
  });

  it('should throw on 401 unauthorized', async () => {
    mockFetchErrorResolved(401, 'Unauthorized');

    await expect(computeEmbedding('test', makeEndpoint())).rejects.toThrow('Embedding API 401');
  });

  it('should throw on malformed response (missing data array)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: null }),
      text: async () => '',
    });

    await expect(computeEmbedding('test', makeEndpoint())).rejects.toThrow('格式异常');
  });

  it('should throw on empty data array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: [] }),
      text: async () => '',
    });

    await expect(computeEmbedding('test', makeEndpoint())).rejects.toThrow('格式异常');
  });

  it('should throw when data[0].embedding is not an array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: 'not-an-array' }],
      }),
      text: async () => '',
    });

    await expect(computeEmbedding('test', makeEndpoint())).rejects.toThrow('格式异常');
  });

  it('should strip trailing slash from baseUrl', async () => {
    mockFetchResolved([0.1, 0.2]);

    await computeEmbedding('test', makeEndpoint({ baseUrl: 'https://api.example.com/v1/' }));

    // 同源路由：url 固定，真实 baseUrl（已 strip 尾斜杠）走 X-Target-Base-URL header
    expect(mockFetch.mock.calls[0][0]).toBe('/api/embeddings');
    const headers = (mockFetch.mock.calls[0][1] as any).headers;
    expect(headers['X-Target-Base-URL']).toBe('https://api.example.com/v1');
  });

  it('should include authorization header', async () => {
    mockFetchResolved([0.1]);

    await computeEmbedding('test', makeEndpoint({ apiKey: 'sk-my-key' }));

    const fetchHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(fetchHeaders['Authorization']).toBe('Bearer sk-my-key');
  });

  it('should pass AbortSignal to fetch', async () => {
    const controller = new AbortController();
    mockFetchResolved([0.1]);

    await computeEmbedding('test', makeEndpoint(), undefined, controller.signal);

    const fetchSignal = mockFetch.mock.calls[0][1].signal;
    expect(fetchSignal).toBe(controller.signal);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. recallMemories — mock getMemories + computeEmbedding (fetch)
// ═══════════════════════════════════════════════════════════════

describe('recallMemories', () => {
  it('should return empty array when there are no memories', async () => {
    mockGetMemoriesResolved([]);

    const result = await recallMemories('save_1', 'query', 5, makeEndpoint());

    expect(result).toEqual([]);
    // fetch should NOT be called when there are no memories
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should rank memories with embeddings by cosine similarity (topK)', async () => {
    const emb1 = [1, 0, 0];
    const emb2 = [0, 1, 0];
    const emb3 = [1, 1, 0];
    const mem1 = makeMemory({
      id: 'MEM000001',
      embedding: emb1,
      importance: 1,
      embeddingMeta: metaFor(emb1),
    });
    const mem2 = makeMemory({
      id: 'MEM000002',
      embedding: emb2,
      importance: 5,
      embeddingMeta: metaFor(emb2),
    });
    const mem3 = makeMemory({
      id: 'MEM000003',
      embedding: emb3,
      importance: 3,
      embeddingMeta: metaFor(emb3),
    });
    mockGetMemoriesResolved([mem1, mem2, mem3]);

    // Query embedding = [1, 0, 0] — most similar to mem1
    mockFetchResolved([1, 0, 0]);

    const result = await recallMemories('save_1', 'query', 2, makeEndpoint());

    expect(result).toHaveLength(2);
    // mem1 should be first (cos=1 with [1,0,0])
    expect(result[0].memory.id).toBe('MEM000001');
    expect(result[0].score).toBeCloseTo(1, 5);
    // mem3 should be second (cos ≈ 0.707 with [1,0,0])
    expect(result[1].memory.id).toBe('MEM000003');
  });

  it('should handle memories without embeddings (fallback sort by importance)', async () => {
    const mem1 = makeMemory({ id: 'MEM000001', embedding: undefined, importance: 2 });
    const mem2 = makeMemory({ id: 'MEM000002', embedding: undefined, importance: 9 });
    const mem3 = makeMemory({ id: 'MEM000003', embedding: undefined, importance: 5 });
    mockGetMemoriesResolved([mem1, mem2, mem3]);
    mockFetchResolved([1, 0, 0]);

    const result = await recallMemories('save_1', 'query', 2, makeEndpoint());

    expect(result).toHaveLength(2);
    // Without embeddings: sorted by importance desc → mem2 (9), mem3 (5)
    expect(result[0].memory.id).toBe('MEM000002');
    expect(result[0].score).toBe(0);
    expect(result[1].memory.id).toBe('MEM000003');
    expect(result[1].score).toBe(0);
  });

  it('should put memories with embeddings before those without', async () => {
    const emb = [0.9, 0.1, 0.0];
    const memEmbedded = makeMemory({
      id: 'MEM000001',
      embedding: emb,
      importance: 1,
      embeddingMeta: metaFor(emb),
    });
    const memNoEmbedding = makeMemory({ id: 'MEM000002', embedding: undefined, importance: 10 });
    mockGetMemoriesResolved([memEmbedded, memNoEmbedding]);
    // Query embedding matches memEmbedded
    mockFetchResolved([0.9, 0.1, 0.0]);

    const result = await recallMemories('save_1', 'query', 2, makeEndpoint());

    expect(result).toHaveLength(2);
    // Embedded memory should be first even though it has lower importance
    expect(result[0].memory.id).toBe('MEM000001');
    expect(result[0].score).toBeCloseTo(1, 5);
    expect(result[1].memory.id).toBe('MEM000002');
    expect(result[1].score).toBe(0);
  });

  it('should fall back to importance + time sort when embedding API fails', async () => {
    const mem1 = makeMemory({ id: 'MEM000001', importance: 3, createdAt: 3000 });
    const mem2 = makeMemory({ id: 'MEM000002', importance: 7, createdAt: 1000 });
    const mem3 = makeMemory({ id: 'MEM000003', importance: 7, createdAt: 2000 });
    mockGetMemoriesResolved([mem1, mem2, mem3]);
    mockFetchRejected(new Error('Network error'));

    const result = await recallMemories('save_1', 'query', 3, makeEndpoint());

    expect(result).toHaveLength(3);
    // Sorted by importance desc, then createdAt desc for ties
    // importance 7 tie → createdAt desc: mem3 (2000), mem2 (1000)
    expect(result[0].memory.id).toBe('MEM000003'); // importance 7, createdAt 2000
    expect(result[1].memory.id).toBe('MEM000002'); // importance 7, createdAt 1000
    expect(result[2].memory.id).toBe('MEM000001'); // importance 3
    expect(result[0].score).toBe(0);
    expect(result[1].score).toBe(0);
    expect(result[2].score).toBe(0);
  });

  it('should apply topK limit correctly', async () => {
    const emb = [0.1, 0.2, 0.3];
    const memories = makeMemories(20, 'save_1', {
      embedding: emb,
      embeddingMeta: metaFor(emb),
    });
    mockGetMemoriesResolved(memories);
    mockFetchResolved([0.1, 0.2, 0.3]);

    const result = await recallMemories('save_1', 'query', 5, makeEndpoint());

    expect(result).toHaveLength(5);
  });

  it('should return all memories when topK exceeds available count', async () => {
    const emb = [0.1, 0.2];
    const memories = makeMemories(3, 'save_1', {
      embedding: emb,
      embeddingMeta: metaFor(emb),
    });
    mockGetMemoriesResolved(memories);
    mockFetchResolved([0.1, 0.2]);

    const result = await recallMemories('save_1', 'query', 10, makeEndpoint());

    expect(result).toHaveLength(3);
  });

  it('should pass AbortSignal through (empty memories, no fetch called)', async () => {
    const controller = new AbortController();
    mockGetMemoriesResolved([]);

    // Should not throw even with signal
    const result = await recallMemories('save_1', 'query', 5, makeEndpoint(), controller.signal);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3b. F09 — 空间指纹 / 向量校验 / 召回分区 / 溯源兜底
// ═══════════════════════════════════════════════════════════════

describe('F09 normalizeEndpointIdentity / computeEmbeddingSpaceId', () => {
  it('同一端点 + 模型 + 维度 → 空间指纹稳定', () => {
    const a = computeEmbeddingSpaceId(makeEndpoint(), 'deepseek-chat', 3);
    const b = computeEmbeddingSpaceId(makeEndpoint(), 'deepseek-chat', 3);
    expect(a).toBe(b);
  });

  it('key 轮换不改变空间指纹（同端 + 同模型 + 同维度照常兼容）', () => {
    const a = computeEmbeddingSpaceId(
      { baseUrl: 'https://api.deepseek.com/v1' },
      'deepseek-chat',
      3,
    );
    const b = computeEmbeddingSpaceId(
      { baseUrl: 'https://api.deepseek.com/v1' },
      'deepseek-chat',
      3,
    );
    expect(a).toBe(b);
    expect(a).not.toContain('sk-');
  });

  it('尾斜杠 / 显式默认端口 / userinfo / query 不改变指纹', () => {
    const base = computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1' }, 'm', 3);
    expect(computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1/' }, 'm', 3)).toBe(base);
    expect(computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com:443/v1' }, 'm', 3)).toBe(
      base,
    );
    expect(
      computeEmbeddingSpaceId({ baseUrl: 'https://user:pass@api.example.com/v1' }, 'm', 3),
    ).toBe(base);
    expect(computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1?x=1#h' }, 'm', 3)).toBe(
      base,
    );
  });

  it('不同模型 / 不同维度 → 不同空间', () => {
    const base = computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1' }, 'm', 3);
    expect(computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1' }, 'other', 3)).not.toBe(
      base,
    );
    expect(computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1' }, 'm', 128)).not.toBe(
      base,
    );
  });

  it('非 URL baseUrl 同样稳定且剥离敏感片段', () => {
    const base = normalizeEndpointIdentity('api.example.com/v1');
    expect(normalizeEndpointIdentity('api.example.com/v1/')).toBe(base);
    expect(normalizeEndpointIdentity('user:pw@api.example.com/v1')).not.toContain('user:pw');
    expect(normalizeEndpointIdentity('api.example.com/v1?token=secret')).not.toContain('token');
  });
});

describe('F09 buildEmbeddingMetadata / hashTextDeterministic / buildEmbeddingText', () => {
  it('同一文本 + 同一配置 → 元数据可复现（contentRevision 稳定）', () => {
    const m1 = buildEmbeddingMetadata([1, 2, 3], makeEndpoint(), 'deepseek-chat', 'x');
    const m2 = buildEmbeddingMetadata([1, 2, 3], makeEndpoint(), 'deepseek-chat', 'x');
    expect(m1.spaceId).toBe(m2.spaceId);
    expect(m1.contentRevision).toBe(m2.contentRevision);
    expect(hashTextDeterministic('x')).toBe('fd0c5087'); // 钉死算法，防静默漂移
  });

  it('文本变 → contentRevision 变', () => {
    const m1 = buildEmbeddingMetadata([1, 2, 3], makeEndpoint(), 'm', 'a');
    const m2 = buildEmbeddingMetadata([1, 2, 3], makeEndpoint(), 'm', 'b');
    expect(m1.contentRevision).not.toBe(m2.contentRevision);
  });

  it('buildEmbeddingText 收敛记忆输入的拼接格式', () => {
    expect(buildEmbeddingText(['战斗', '胜利'], '正文')).toBe('[战斗, 胜利] 正文');
    expect(buildEmbeddingText([], '正文')).toBe('[] 正文');
  });
});

describe('F09 validateEmbeddingVector', () => {
  it('合法向量通过', () => {
    expect(validateEmbeddingVector([1, 2, 3])).toEqual({ valid: true });
  });

  it('空 / 非数组 / NaN / Infinity / 字符串元素 / 零向量 / 超上限 → 非法', () => {
    expect(validateEmbeddingVector([]).valid).toBe(false);
    expect(validateEmbeddingVector('nope' as unknown).valid).toBe(false);
    expect(validateEmbeddingVector([1, NaN]).valid).toBe(false);
    expect(validateEmbeddingVector([1, Infinity]).valid).toBe(false);
    expect(validateEmbeddingVector(['x' as unknown, 2]).valid).toBe(false);
    expect(validateEmbeddingVector([0, 0, 0]).valid).toBe(false);
    expect(validateEmbeddingVector(new Array(MAX_EMBEDDING_DIMENSIONS + 1).fill(1)).valid).toBe(
      false,
    );
  });

  it('expectedDimensions 精确比对', () => {
    expect(validateEmbeddingVector([1, 2], { expectedDimensions: 3 }).valid).toBe(false);
    expect(validateEmbeddingVector([1, 2, 3], { expectedDimensions: 3 }).valid).toBe(true);
  });
});

describe('F09 classifyStoredVector', () => {
  const spaceId = computeEmbeddingSpaceId({ baseUrl: 'https://api.example.com/v1' }, 'm', 3);
  const meta = buildEmbeddingMetadata(
    [1, 2, 3],
    { baseUrl: 'https://api.example.com/v1' },
    'm',
    't',
  );

  it('无向量 → missing', () => {
    expect(classifyStoredVector(undefined, undefined, spaceId, 3).kind).toBe('missing');
  });

  it('空 / NaN / 零向量 → invalid（坏数据只丢自己）', () => {
    expect(classifyStoredVector([], meta, spaceId, 3).kind).toBe('invalid');
    expect(classifyStoredVector([1, NaN], meta, spaceId, 3).kind).toBe('invalid');
    expect(classifyStoredVector([0, 0, 0], meta, spaceId, 3).kind).toBe('invalid');
  });

  it('无元数据（legacy）→ incompatible，哪怕维度相同也不假定同一空间', () => {
    expect(classifyStoredVector([1, 2, 3], undefined, spaceId, 3).kind).toBe('incompatible');
  });

  it('spaceId 不同 → incompatible（同维不同模型同端不同名也拒绝余弦）', () => {
    const otherSpace = computeEmbeddingSpaceId(
      { baseUrl: 'https://api.example.com/v1' },
      'other',
      3,
    );
    // meta 属于 'm' 空间，查询在 'other' 空间
    expect(classifyStoredVector([1, 2, 3], meta, otherSpace, 3).kind).toBe('incompatible');
  });

  it('元数据维度与查询不符 → invalid（空间同但维度矛盾 = 元数据损坏）', () => {
    const badMeta = { ...meta, dimensions: 99 };
    expect(classifyStoredVector([1, 2, 3], badMeta, spaceId, 3).kind).toBe('invalid');
  });

  it('同空间 + 同维度 → compatible', () => {
    expect(classifyStoredVector([1, 2, 3], meta, spaceId, 3).kind).toBe('compatible');
  });
});

describe('F09 computeEmbeddingWithMeta', () => {
  it('返回向量 + 同空间元数据（模型/维度/预处理版本齐全）', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockFetchResolved(embedding);

    const result = await computeEmbeddingWithMeta('text', makeEndpoint());
    expect(result.embedding).toEqual(embedding);
    expect(result.meta).toMatchObject({
      model: 'deepseek-chat',
      dimensions: 3,
      preprocessingVersion: EMBEDDING_PREPROCESSING_VERSION,
    });
    expect(result.meta.spaceId).toContain('deepseek-chat|d3|');
  });

  it('provider 报告模型不同时记入 modelRevision', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ embedding: [1, 2, 3], index: 0 }],
        model: 'resolved-other-model',
      }),
      text: async () => '',
    });

    const result = await computeEmbeddingWithMeta('text', makeEndpoint());
    expect(result.meta.modelRevision).toBe('resolved-other-model');
  });

  it('provider 返回空数组 → 抛「向量非法」', async () => {
    mockFetchResolved([]);
    await expect(computeEmbeddingWithMeta('text', makeEndpoint())).rejects.toThrow('向量非法');
  });

  it('provider 返回含 NaN 的向量 → 抛「向量非法」', async () => {
    mockFetchResolved([1, NaN]);
    await expect(computeEmbeddingWithMeta('text', makeEndpoint())).rejects.toThrow('向量非法');
  });

  it('provider 返回零向量 → 抛「向量非法」', async () => {
    mockFetchResolved([0, 0, 0]);
    await expect(computeEmbeddingWithMeta('text', makeEndpoint())).rejects.toThrow('向量非法');
  });
});

describe('F09 recallMemories — 溯源与兜底', () => {
  it('换维度模型：旧向量与查询不同维 → 不抛、不参与余弦、重要性兜底', async () => {
    // 旧档 3 维向量（无元数据 = legacy），查询端模型返回 128 维
    const memHigh = makeMemory({ id: 'MEM000002', importance: 9, embedding: [1, 0, 0] });
    const memLow = makeMemory({ id: 'MEM000001', importance: 2, embedding: [0, 1, 0] });
    mockGetMemoriesResolved([memLow, memHigh]);
    mockFetchResolved(new Array(128).fill(0.1));

    let diag: RecallDiagnostics | undefined;
    const result = await recallMemories(
      'save_1',
      'query',
      2,
      makeEndpoint(),
      undefined,
      undefined,
      (d) => {
        diag = d;
      },
    );

    expect(result).toHaveLength(2);
    // importance 兜底：9 分的在前面；score 恒 0（不冒充余弦分）
    expect(result[0].memory.id).toBe('MEM000002');
    expect(result[0].score).toBe(0);
    expect(result[0].source).toBe('fallback');
    expect(diag?.queryDimensions).toBe(128);
    expect(diag?.incompatible).toBe(2);
    expect(diag?.compatible).toBe(0);
  });

  it('同维不同模型：spaceId 不同 → 不按余弦排序，按 importance 兜底', async () => {
    const emb = [1, 0, 0];
    // 存储端来自另一个模型 → 不同空间（哪怕维度同为 3）
    const foreignMeta = buildEmbeddingMetadata(
      emb,
      { baseUrl: 'https://api.deepseek.com/v1' },
      'text-embedding-v1',
      't',
    );
    const memA = makeMemory({
      id: 'MEM000001',
      importance: 3,
      embedding: [1, 0, 0],
      embeddingMeta: foreignMeta,
    });
    const memB = makeMemory({
      id: 'MEM000002',
      importance: 8,
      embedding: [0, 0, 1],
      embeddingMeta: foreignMeta,
    });
    mockGetMemoriesResolved([memA, memB]);
    mockFetchResolved([1, 0, 0]); // 查询端 'deepseek-chat'

    const result = await recallMemories('save_1', 'query', 2, makeEndpoint());

    // 与查询向量最像的 memA 不得排第一 —— 跨空间余弦被禁止，8 分兜底优先
    expect(result[0].memory.id).toBe('MEM000002');
    expect(result[0].score).toBe(0);
    expect(result.every((r) => r.source === 'fallback')).toBe(true);
  });

  it('key 轮换（同空间）：余弦照常参与，不被误判不兼容', async () => {
    const emb = [1, 0, 0];
    const mem = makeMemory({
      id: 'MEM000001',
      embedding: emb,
      embeddingMeta: metaFor(emb),
    });
    mockGetMemoriesResolved([mem]);
    mockFetchResolved([1, 0, 0]);

    const result = await recallMemories(
      'save_1',
      'query',
      1,
      makeEndpoint({ apiKey: 'sk-rotated-key' }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('cosine');
    expect(result[0].score).toBeCloseTo(1, 5);
  });

  it('一条坏数据不毒化整次召回：compatible 正常排名，坏条目走兜底', async () => {
    const goodEmb = [1, 0, 0];
    const good = makeMemory({
      id: 'MEM000001',
      importance: 3,
      embedding: goodEmb,
      embeddingMeta: metaFor(goodEmb),
    });
    const zeroVec = makeMemory({ id: 'MEM000002', importance: 9, embedding: [0, 0, 0] }); // invalid
    const noEmb = makeMemory({ id: 'MEM000003', importance: 7 }); // missing
    mockGetMemoriesResolved([good, zeroVec, noEmb]);
    mockFetchResolved([1, 0, 0]);

    const result = await recallMemories('save_1', 'query', 3, makeEndpoint());

    expect(result).toHaveLength(3);
    expect(result[0].memory.id).toBe('MEM000001'); // 唯一 compatible 排最前
    expect(result[0].score).toBeCloseTo(1, 5);
    // 坏数据只被剥夺「余弦资格」，记忆文本仍以兜底身份补进剩余槽
    expect(result.map((r) => r.memory.id)).toEqual(['MEM000001', 'MEM000002', 'MEM000003']);
    expect(result[1].source).toBe('fallback');
    expect(result[1].score).toBe(0);
  });

  it('存量无指纹（legacy 全库）：纯 importance/recency 兜底且诊断诚实', async () => {
    const mem1 = makeMemory({ id: 'MEM000001', importance: 3, embedding: [1, 0, 0] });
    const mem2 = makeMemory({ id: 'MEM000002', importance: 8, embedding: [0, 1, 0] });
    mockGetMemoriesResolved([mem1, mem2]);
    mockFetchResolved([1, 0, 0]);

    let diag: RecallDiagnostics | undefined;
    const result = await recallMemories(
      'save_1',
      'query',
      2,
      makeEndpoint(),
      undefined,
      undefined,
      (d) => {
        diag = d;
      },
    );

    expect(result.map((r) => r.memory.id)).toEqual(['MEM000002', 'MEM000001']);
    expect(result.every((r) => r.source === 'fallback' && r.score === 0)).toBe(true);
    expect(diag?.incompatible).toBe(2);
    expect(diag?.compatible).toBe(0);
    expect(diag?.spaceId).toContain('deepseek-chat');
    expect(JSON.stringify(diag)).not.toContain('sk-');
  });

  it('查询失败（provider 500）→ 非致命兜底 + queryError 诊断，不抛', async () => {
    const mem1 = makeMemory({ id: 'MEM000001', importance: 3, embedding: [1, 0, 0] });
    const mem2 = makeMemory({ id: 'MEM000002', importance: 8, embedding: [0, 1, 0] });
    mockGetMemoriesResolved([mem1, mem2]);
    mockFetchErrorResolved(500, 'Server Error');

    let diag: RecallDiagnostics | undefined;
    const result = await recallMemories(
      'save_1',
      'query',
      2,
      makeEndpoint(),
      undefined,
      undefined,
      (d) => {
        diag = d;
      },
    );

    expect(result).toHaveLength(2);
    expect(result[0].memory.id).toBe('MEM000002');
    expect(result.every((r) => r.score === 0)).toBe(true);
    expect(diag?.queryError).toContain('Embedding API 500');
    expect(diag?.total).toBe(2);
  });

  it('查询向量非法（provider 返回 NaN）→ 同样兜底，queryError 给出原因', async () => {
    mockGetMemoriesResolved([makeMemory({ id: 'MEM000001', importance: 5 })]);
    mockFetchResolved([NaN, 1, 2]);

    let diag: RecallDiagnostics | undefined;
    const result = await recallMemories(
      'save_1',
      'query',
      1,
      makeEndpoint(),
      undefined,
      undefined,
      (d) => {
        diag = d;
      },
    );

    expect(result[0].score).toBe(0);
    expect(result[0].source).toBe('fallback');
    expect(diag?.queryError).toContain('向量非法');
  });

  it('兼容足量时不掺兜底；不足才按槽位补齐（fallbackUsed 语义）', async () => {
    const emb = [1, 0, 0];
    const compatible = makeMemory({
      id: 'MEM000001',
      importance: 1,
      embedding: emb,
      embeddingMeta: metaFor(emb),
    });
    const legacy = makeMemory({
      id: 'MEM000002',
      importance: 9,
      embedding: [0, 1, 0],
    });
    mockGetMemories.mockResolvedValue([compatible, legacy]);
    // 本用例连续召回两次（topK 不同），fetch 也必须是常驻 mock
    mockFetch.mockResolvedValue(makeEmbeddingResponse([1, 0, 0]));

    // topK=1：只要 cosine，不掺兜底
    const oneResult = await recallMemories('save_1', 'query', 1, makeEndpoint());
    expect(oneResult).toHaveLength(1);
    expect(oneResult[0].source).toBe('cosine');
    expect(oneResult[0].memory.id).toBe('MEM000001');

    // topK=2：余 1 槽由 importance 兜底补上，score=0
    const twoResults = await recallMemories('save_1', 'query', 2, makeEndpoint());
    expect(twoResults).toHaveLength(2);
    expect(twoResults[0].source).toBe('cosine');
    expect(twoResults[1].source).toBe('fallback');
    expect(twoResults[1].memory.id).toBe('MEM000002');
    expect(twoResults[1].score).toBe(0);
  });

  it('诊断：compatible / missing / invalid 计数分离且不含凭据', async () => {
    const goodEmb = [1, 0, 0];
    mockGetMemoriesResolved([
      makeMemory({
        id: 'MEM000001',
        embedding: goodEmb,
        embeddingMeta: metaFor(goodEmb),
      }),
      makeMemory({ id: 'MEM000002', embedding: [NaN, 1, 1] }), // invalid
      makeMemory({ id: 'MEM000003' }), // missing
    ]);
    mockFetchResolved([1, 0, 0]);

    let diag: RecallDiagnostics | undefined;
    await recallMemories('save_1', 'query', 3, makeEndpoint(), undefined, undefined, (d) => {
      diag = d;
    });

    expect(diag).toMatchObject({
      total: 3,
      compatible: 1,
      missing: 1,
      invalid: 1,
      incompatible: 0,
      fallbackUsed: true,
      queryDimensions: 3,
    });
    expect(JSON.stringify(diag)).not.toContain('sk-');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. getRoundCount — mock getMemories
// ═══════════════════════════════════════════════════════════════

describe('getRoundCount', () => {
  it('should return the count of memories', async () => {
    const memories = makeMemories(42, 'save_1');
    mockGetMemoriesResolved(memories);

    const count = await getRoundCount('save_1');

    expect(count).toBe(42);
    expect(mockGetMemories).toHaveBeenCalledWith('save_1');
  });

  it('should return 0 when there are no memories', async () => {
    mockGetMemoriesResolved([]);

    const count = await getRoundCount('save_1');

    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. checkCompressionNeeded — mock getMemories
// ═══════════════════════════════════════════════════════════════

describe('checkCompressionNeeded', () => {
  it('should return needed=false when under threshold', async () => {
    const memories = makeMemories(50, 'save_1');
    mockGetMemoriesResolved(memories);

    const result = await checkCompressionNeeded('save_1', 100);

    expect(result.needed).toBe(false);
    expect(result.oldMemories).toEqual([]);
  });

  it('should return needed=false when exactly at threshold', async () => {
    const memories = makeMemories(100, 'save_1');
    mockGetMemoriesResolved(memories);

    const result = await checkCompressionNeeded('save_1', 100);

    expect(result.needed).toBe(false);
    expect(result.oldMemories).toEqual([]);
  });

  it('should return needed=true with oldest memories when over threshold', async () => {
    const memories = makeMemories(120, 'save_1');
    mockGetMemoriesResolved(memories);

    const result = await checkCompressionNeeded('save_1', 100);

    expect(result.needed).toBe(true);
    // Excess = 120 - 100 = 20 oldest memories (sorted by createdAt asc)
    expect(result.oldMemories).toHaveLength(20);
    // Should be the 20 oldest (createdAt 1000, 1010, 1020, ...)
    expect(result.oldMemories[0].id).toBe('MEM000001');
    expect(result.oldMemories[19].id).toBe('MEM000020');
  });

  it('should return all memories when threshold is 0', async () => {
    const memories = makeMemories(5, 'save_1');
    mockGetMemoriesResolved(memories);

    const result = await checkCompressionNeeded('save_1', 0);

    expect(result.needed).toBe(true);
    expect(result.oldMemories).toHaveLength(5);
  });

  it('should use correct saveId when querying', async () => {
    mockGetMemoriesResolved([]);

    await checkCompressionNeeded('specific_save', 50);

    expect(mockGetMemories).toHaveBeenCalledWith('specific_save');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. applyCompression — mock deleteMemories + saveMemory
// ═══════════════════════════════════════════════════════════════

describe('applyCompression', () => {
  it('should delete each old memory and save the summary', async () => {
    const oldMemories = makeMemories(5, 'save_1');
    const summaryMemory = makeMemory({
      id: 'MEM_SUMMARY',
      content: '这是压缩后的摘要记忆，包含了之前5条记忆的关键信息。'.repeat(4),
    });

    await applyCompression('save_1', oldMemories, summaryMemory);

    // 一次 bulkDelete，且这 5 条的 id 一条不少（逐条删已改为批量，语义等价）
    expect(mockDeleteMemories).toHaveBeenCalledTimes(1);
    expect(mockDeleteMemories).toHaveBeenCalledWith(oldMemories.map((m) => m.id));

    // Should call saveMemory once with the summary
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(summaryMemory);
  });

  it('should handle empty oldMemories array', async () => {
    const summaryMemory = makeMemory({ id: 'MEM_SUMMARY' });

    await applyCompression('save_1', [], summaryMemory);

    // 空数组照样交给 bulkDelete —— 它对空输入早退，一行都删不掉（等价于此前的"不调用"）
    expect(mockDeleteMemories).toHaveBeenCalledWith([]);
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(summaryMemory);
  });

  it('should delete all old memories before saving the summary (ordering)', async () => {
    const oldMemories = makeMemories(3, 'save_1');
    const summaryMemory = makeMemory({ id: 'MEM_SUMMARY' });

    const callOrder: string[] = [];
    mockDeleteMemories.mockImplementation(async () => {
      callOrder.push('delete');
    });
    mockSaveMemory.mockImplementation(async () => {
      callOrder.push('save');
    });

    await applyCompression('save_1', oldMemories, summaryMemory);

    // 删除（一次批量）必须发生在写摘要之前
    expect(callOrder).toEqual(['delete', 'save']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. saveMemoryWithEmbedding — mock computeEmbedding (fetch) + saveMemory
// ═══════════════════════════════════════════════════════════════

describe('saveMemoryWithEmbedding', () => {
  it('should save memory with embedding on API success', async () => {
    const embedding = [0.11, 0.22, 0.33, 0.44];
    mockFetchResolved(embedding);

    const memory = makeMemory({ embedding: undefined, keywords: ['战斗', '胜利'] });
    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    // The embedding should be set on the memory, plus its provenance metadata
    expect(result.embedding).toEqual(embedding);
    expect(result.embeddingMeta).toBeDefined();
    expect(result.embeddingMeta?.dimensions).toBe(4);
    expect(result.embeddingMeta?.spaceId).toContain('deepseek-chat|d4|');
    expect(result.embeddingMeta?.preprocessingVersion).toBe(EMBEDDING_PREPROCESSING_VERSION);
    // saveMemory should be called with the memory (now with embedding)
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(memory);
  });

  it('should save memory without embedding on API failure (metadata cleared atomically)', async () => {
    mockFetchRejected(new Error('Network error'));

    const staleMeta = buildEmbeddingMetadata(
      [1, 2, 3],
      makeEndpoint(),
      'deepseek-chat',
      'old-text',
    );
    const memory = makeMemory({
      embedding: [1, 2, 3],
      embeddingMeta: staleMeta,
      keywords: ['探索'],
    });
    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    // Original embedding AND its metadata should both be cleared (atomic pair)
    expect(result.embedding).toBeUndefined();
    expect(result.embeddingMeta).toBeUndefined();
    // saveMemory should still be called
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(memory);
  });

  it('provider 返回非法向量时保存为无 embedding（并原子清空元数据）', async () => {
    mockFetchResolved([NaN, 1, 2]);

    const memory = makeMemory({
      embedding: [1, 2, 3],
      embeddingMeta: metaFor([1, 2, 3]),
      keywords: ['探索'],
    });
    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    expect(result.embedding).toBeUndefined();
    expect(result.embeddingMeta).toBeUndefined();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('should build embedding text from keywords and content', async () => {
    mockFetchResolved([0.1, 0.2]);

    const memory = makeMemory({
      keywords: ['战斗', '胜利', '史诗'],
      content: '这是一段关于激烈战斗的叙述。',
    });

    await saveMemoryWithEmbedding(memory, makeEndpoint());

    // Verify the embedding text format sent to the API
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.input).toContain('[战斗, 胜利, 史诗]');
    expect(fetchBody.input).toContain('这是一段关于激烈战斗的叙述。');
  });

  it('should preserve original memory fields after save', async () => {
    mockFetchResolved([0.5, 0.6]);

    const memory = makeMemory({
      id: 'MEM_ORIGINAL_01',
      saveId: 'save_preserve',
      importance: 8,
      hiddenLine: 'hidden line content',
    });

    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    expect(result.id).toBe('MEM_ORIGINAL_01');
    expect(result.saveId).toBe('save_preserve');
    expect(result.importance).toBe(8);
    expect(result.hiddenLine).toBe('hidden line content');
    expect(result.embedding).toEqual([0.5, 0.6]);
  });

  it('should handle API 503 error gracefully (save without embedding)', async () => {
    mockFetchErrorResolved(503, 'Service Unavailable');

    const memory = makeMemory({ embedding: undefined });
    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    expect(result.embedding).toBeUndefined();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('should use the provided endpoint for the embedding call', async () => {
    mockFetchResolved([0.1]);

    const endpoint = makeEndpoint({ baseUrl: 'https://custom.api.com/v2', apiKey: 'sk-custom' });
    await saveMemoryWithEmbedding(makeMemory(), endpoint);

    // 同源路由：url 固定，endpoint.baseUrl 走 X-Target-Base-URL header
    expect(mockFetch.mock.calls[0][0]).toBe('/api/embeddings');
    const headers = (mockFetch.mock.calls[0][1] as any).headers;
    expect(headers['X-Target-Base-URL']).toBe('https://custom.api.com/v2');
  });
});
