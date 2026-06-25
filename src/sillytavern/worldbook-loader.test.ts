/**
 * worldbook-loader 测试 (Phase 8)
 */

import { describe, it, expect } from 'vitest';
import {
  loadWorldBooksSync,
  getEntriesForAgent,
  filterActiveEntries,
  matchKeyword,
  formatWorldBookEntries,
} from './worldbook-loader';
import type { WorldBook, WorldBookEntry, AgentConfig } from './types';

// ========== Helpers ==========

function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    uid: 1,
    name: '测试条目',
    content: '测试内容',
    enabled: true,
    constant: false,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
    ...overrides,
  };
}

function makeBook(overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: 'world_setting',
    name: '世界总览',
    partition: 'world_setting',
    entries: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'story',
    enabled: true,
    apiEndpointId: 'ep_1',
    model: 'test-model',
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1.0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 30000,
    userId: 'fp|test|story',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: [],
    ...overrides,
  };
}

// ========== loadWorldBooksSync ==========

describe('loadWorldBooksSync', () => {
  it('returns books for matching IDs', () => {
    const preloaded: Record<string, WorldBook> = {
      world_setting: makeBook({ id: 'world_setting', name: '世界总览' }),
      adventure_area: makeBook({ id: 'adventure_area', name: '地区详细' }),
    };
    const result = loadWorldBooksSync(['world_setting', 'adventure_area'], preloaded);
    expect(result).toHaveLength(2);
  });

  it('skips missing IDs', () => {
    const preloaded: Record<string, WorldBook> = {
      world_setting: makeBook(),
    };
    const result = loadWorldBooksSync(['world_setting', 'nonexistent'], preloaded);
    expect(result).toHaveLength(1);
  });
});

// ========== getEntriesForAgent ==========

describe('getEntriesForAgent', () => {
  it('returns entries from allowed world books', () => {
    const configs = [makeConfig({ agentId: 'story', worldBookIds: ['world_setting'] })];
    const books = [
      makeBook({
        id: 'world_setting',
        entries: [makeEntry({ uid: 1, content: '世界主设定' })],
      }),
      makeBook({
        id: 'adventure_area',
        entries: [makeEntry({ uid: 2, content: '白曜城' })],
      }),
    ];

    const entries = getEntriesForAgent('story', configs, books);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('世界主设定');
  });

  it('returns empty for unknown agent', () => {
    const entries = getEntriesForAgent('unknown', [], []);
    expect(entries).toHaveLength(0);
  });

  it('returns empty when agent has no world books', () => {
    const configs = [makeConfig({ agentId: 'story', worldBookIds: [] })];
    const books = [makeBook({ entries: [makeEntry()] })];
    const entries = getEntriesForAgent('story', configs, books);
    expect(entries).toHaveLength(0);
  });
});

// ========== filterActiveEntries ==========

describe('filterActiveEntries', () => {
  it('filters disabled entries', () => {
    const entries = [makeEntry({ uid: 1, enabled: false, constant: true })];
    const result = filterActiveEntries(entries, 'any text');
    expect(result).toHaveLength(0);
  });

  it('always returns constant entries', () => {
    const entries = [makeEntry({ uid: 1, constant: true })];
    const result = filterActiveEntries(entries, 'any text');
    expect(result).toHaveLength(1);
  });

  it('returns keyword-matched entries', () => {
    const entries = [makeEntry({ uid: 1, constant: false, key: ['白曜城'] })];
    const result = filterActiveEntries(entries, '你来到了白曜城的铁匠铺');
    expect(result).toHaveLength(1);
  });

  it('skips entries with no keyword match', () => {
    const entries = [makeEntry({ uid: 1, constant: false, key: ['白曜城'] })];
    const result = filterActiveEntries(entries, '你来到了林歌城');
    expect(result).toHaveLength(0);
  });

  it('skips entries with empty keys and constant=false', () => {
    const entries = [makeEntry({ uid: 1, constant: false, key: [] })];
    const result = filterActiveEntries(entries, 'any text');
    expect(result).toHaveLength(0);
  });
});

// ========== matchKeyword ==========

describe('matchKeyword', () => {
  it('matches single keyword', () => {
    const entry = { key: ['白曜城'], keysecondary: [], selectiveLogic: 0 };
    expect(matchKeyword(entry, '你来到了白曜城')).toBe(true);
  });

  it('case insensitive match', () => {
    const entry = { key: ['WHITEWOOD'], keysecondary: [], selectiveLogic: 0 };
    expect(matchKeyword(entry, 'whitewood castle')).toBe(true);
  });

  it('regex keyword match', () => {
    const entry = { key: ['/白.*城/'], keysecondary: [], selectiveLogic: 0 };
    expect(matchKeyword(entry, '白曜城铁匠铺')).toBe(true);
  });

  it('AND_ANY with secondary', () => {
    const entry = { key: ['白曜城'], keysecondary: ['铁匠', '市场'], selectiveLogic: 0 };
    expect(matchKeyword(entry, '白曜城铁匠铺')).toBe(true); // primary + any secondary
    expect(matchKeyword(entry, '白曜城远方')).toBe(false);   // primary but no secondary
  });

  it('NOT_ANY with secondary', () => {
    const entry = { key: ['白曜城'], keysecondary: ['战斗'], selectiveLogic: 2 };
    expect(matchKeyword(entry, '白曜城的铁匠铺')).toBe(true);  // primary, no combat keyword
    expect(matchKeyword(entry, '白曜城发生战斗')).toBe(false); // primary + combat keyword → excluded
  });

  it('AND_ALL with secondary', () => {
    const entry = { key: ['白曜城'], keysecondary: ['铁匠', '长剑'], selectiveLogic: 3 };
    expect(matchKeyword(entry, '白曜城铁匠铺打造长剑')).toBe(true);   // all matched
    expect(matchKeyword(entry, '白曜城铁匠铺打造盾牌')).toBe(false); // missing 长剑
  });

  it('returns false for empty key', () => {
    const entry = { key: [], keysecondary: [], selectiveLogic: 0 };
    expect(matchKeyword(entry, 'any text')).toBe(false);
  });
});

// ========== formatWorldBookEntries ==========

describe('formatWorldBookEntries', () => {
  it('returns empty string for no entries', () => {
    expect(formatWorldBookEntries([])).toBe('');
  });

  it('sorts by order and joins content', () => {
    const entries = [
      makeEntry({ uid: 1, content: '第三条', order: 300 }),
      makeEntry({ uid: 2, content: '第一条', order: 100 }),
      makeEntry({ uid: 3, content: '第二条', order: 200 }),
    ];
    const result = formatWorldBookEntries(entries);
    expect(result).toBe('第一条\n\n第二条\n\n第三条');
  });
});
