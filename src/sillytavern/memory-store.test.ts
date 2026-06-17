/**
 * memory-store.ts — Embedding 召回引擎 & 记忆压缩测试
 *
 * Tests: cosineSimilarity, computeEmbedding, recallMemories,
 *         getRoundCount, checkCompressionNeeded, applyCompression,
 *         saveMemoryWithEmbedding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MemoryRecord } from './types';

// ═══════════════════════════════════════════════════════════════
// Mock hoisting — function refs available before module import
// ═══════════════════════════════════════════════════════════════

const mockGetMemories = vi.hoisted(() => vi.fn());
const mockSaveMemory = vi.hoisted(() => vi.fn());
const mockDeleteMemory = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

// Mock database module (hoisted by Vitest)
vi.mock('./database', () => ({
  getMemories: mockGetMemories,
  getRecentMemories: vi.fn(),
  saveMemory: mockSaveMemory,
  deleteMemory: mockDeleteMemory,
}));

// Stub global fetch
vi.stubGlobal('fetch', mockFetch);

// ═══════════════════════════════════════════════════════════════
// Dynamic import after mocks are applied
// ═══════════════════════════════════════════════════════════════

const {
  computeEmbedding,
  cosineSimilarity,
  recallMemories,
  getRoundCount,
  checkCompressionNeeded,
  applyCompression,
  saveMemoryWithEmbedding,
} = await import('./memory-store');

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeEndpoint(overrides: Partial<{ baseUrl: string; apiKey: string; defaultModel: string }> = {}) {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key-12345',
    defaultModel: 'deepseek-chat',
    ...overrides,
  };
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
function makeMemories(count: number, saveId = 'save_test', baseOpts: Partial<MemoryRecord> = {}): MemoryRecord[] {
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
    json: async () => { throw new Error('not json'); },
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
    expect(fetchUrl).toContain('/embeddings');
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

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toBe('https://api.example.com/v1/embeddings');
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
    const mem1 = makeMemory({ id: 'MEM000001', embedding: [1, 0, 0], importance: 1 });
    const mem2 = makeMemory({ id: 'MEM000002', embedding: [0, 1, 0], importance: 5 });
    const mem3 = makeMemory({ id: 'MEM000003', embedding: [1, 1, 0], importance: 3 });
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
    const memEmbedded = makeMemory({ id: 'MEM000001', embedding: [0.9, 0.1, 0.0], importance: 1 });
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
    const memories = makeMemories(20, 'save_1', { embedding: [0.1, 0.2, 0.3] });
    mockGetMemoriesResolved(memories);
    mockFetchResolved([0.1, 0.2, 0.3]);

    const result = await recallMemories('save_1', 'query', 5, makeEndpoint());

    expect(result).toHaveLength(5);
  });

  it('should return all memories when topK exceeds available count', async () => {
    const memories = makeMemories(3, 'save_1', { embedding: [0.1, 0.2] });
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
// 6. applyCompression — mock deleteMemory + saveMemory
// ═══════════════════════════════════════════════════════════════

describe('applyCompression', () => {
  it('should delete each old memory and save the summary', async () => {
    const oldMemories = makeMemories(5, 'save_1');
    const summaryMemory = makeMemory({
      id: 'MEM_SUMMARY',
      content: '这是压缩后的摘要记忆，包含了之前5条记忆的关键信息。'.repeat(4),
    });

    await applyCompression('save_1', oldMemories, summaryMemory);

    // Should call deleteMemory for each old memory
    expect(mockDeleteMemory).toHaveBeenCalledTimes(5);
    for (const mem of oldMemories) {
      expect(mockDeleteMemory).toHaveBeenCalledWith(mem.id);
    }

    // Should call saveMemory once with the summary
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(summaryMemory);
  });

  it('should handle empty oldMemories array', async () => {
    const summaryMemory = makeMemory({ id: 'MEM_SUMMARY' });

    await applyCompression('save_1', [], summaryMemory);

    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(summaryMemory);
  });

  it('should delete all old memories before saving the summary (ordering)', async () => {
    const oldMemories = makeMemories(3, 'save_1');
    const summaryMemory = makeMemory({ id: 'MEM_SUMMARY' });

    const callOrder: string[] = [];
    mockDeleteMemory.mockImplementation(async () => { callOrder.push('delete'); });
    mockSaveMemory.mockImplementation(async () => { callOrder.push('save'); });

    await applyCompression('save_1', oldMemories, summaryMemory);

    // All deletes before the save
    expect(callOrder.slice(0, 3).every(s => s === 'delete')).toBe(true);
    expect(callOrder[callOrder.length - 1]).toBe('save');
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

    // The embedding should be set on the memory
    expect(result.embedding).toEqual(embedding);
    // saveMemory should be called with the memory (now with embedding)
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(memory);
  });

  it('should save memory without embedding on API failure', async () => {
    mockFetchRejected(new Error('Network error'));

    const memory = makeMemory({ embedding: [1, 2, 3], keywords: ['探索'] });
    const result = await saveMemoryWithEmbedding(memory, makeEndpoint());

    // Original embedding should be cleared
    expect(result.embedding).toBeUndefined();
    // saveMemory should still be called
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledWith(memory);
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

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain('custom.api.com');
  });
});
