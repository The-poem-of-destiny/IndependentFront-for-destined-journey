/**
 * worldbook-loader 测试 (Phase 8)
 */

import { describe, it, expect } from 'vitest';
import {
  loadWorldBooksSync,
  getEntriesForAgent,
  filterActiveEntries,
  filterBooksByEnabledEntries,
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
  it('returns enabled entries', () => {
    const entries = [makeEntry({ uid: 1, enabled: true })];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(1);
  });

  it('filters out disabled entries (enabled 绝对优先)', () => {
    const entries = [makeEntry({ uid: 1, enabled: false })];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(0);
  });

  it('mix: 只保留 enabled 的条目', () => {
    const entries = [
      makeEntry({ uid: 1, enabled: true }),
      makeEntry({ uid: 2, enabled: false }),
      makeEntry({ uid: 3, enabled: true }),
    ];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.uid)).toEqual([1, 3]);
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
    expect(matchKeyword(entry, '白曜城远方')).toBe(false); // primary but no secondary
  });

  it('NOT_ANY with secondary', () => {
    const entry = { key: ['白曜城'], keysecondary: ['战斗'], selectiveLogic: 2 };
    expect(matchKeyword(entry, '白曜城的铁匠铺')).toBe(true); // primary, no combat keyword
    expect(matchKeyword(entry, '白曜城发生战斗')).toBe(false); // primary + combat keyword → excluded
  });

  it('AND_ALL with secondary', () => {
    const entry = { key: ['白曜城'], keysecondary: ['铁匠', '长剑'], selectiveLogic: 3 };
    expect(matchKeyword(entry, '白曜城铁匠铺打造长剑')).toBe(true); // all matched
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

// ========== filterBooksByEnabledEntries ==========

describe('filterBooksByEnabledEntries', () => {
  it('returns all books unchanged when enabledEntries is empty', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        entries: [makeEntry({ uid: 413 }), makeEntry({ uid: 414 })],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, []);
    expect(result).toHaveLength(1);
    expect(result[0].entries).toHaveLength(2);
  });

  it('returns all books unchanged when enabledEntries is undefined/empty array', () => {
    const books = [makeBook({ partition: 'system_core', entries: [makeEntry({ uid: 1 })] })];
    expect(filterBooksByEnabledEntries(books, []).length).toBe(1);
  });

  it('keeps only matching uids for partitions in enabledEntries', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        entries: [
          makeEntry({ uid: 413, content: '命运之轮' }),
          makeEntry({ uid: 414, content: '星辰指引' }),
          makeEntry({ uid: 415, content: '暗影低语' }),
        ],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, ['system_core:413']);
    expect(result).toHaveLength(1);
    expect(result[0].entries).toHaveLength(1);
    expect(result[0].entries[0].uid).toBe(413);
    expect(result[0].entries[0].content).toBe('命运之轮');
  });

  it('passes through books whose partition is not in enabledEntries', () => {
    const books = [
      makeBook({ id: 'system_core', partition: 'system_core', entries: [makeEntry({ uid: 413 })] }),
      makeBook({
        id: 'race',
        partition: 'race',
        entries: [makeEntry({ uid: 1 }), makeEntry({ uid: 2 })],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, ['system_core:413']);
    expect(result).toHaveLength(2);
    // system_core: filtered
    expect(result[0].entries).toHaveLength(1);
    // race: untouched (not in enabledEntries)
    expect(result[1].entries).toHaveLength(2);
  });

  it('filters multiple books by their respective enabled entries', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: 413 }), makeEntry({ uid: 414 })],
      }),
      makeBook({
        partition: 'character',
        entries: [makeEntry({ uid: 301 }), makeEntry({ uid: 302 })],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, ['system_core:413', 'character:301']);
    expect(result[0].entries.map((e) => e.uid)).toEqual([413]);
    expect(result[1].entries.map((e) => e.uid)).toEqual([301]);
  });

  it('removes all entries for a partition when no uid matches', () => {
    const books = [
      makeBook({ partition: 'system_core', entries: [makeEntry({ uid: 413 })], name: '核心' }),
    ];
    const result = filterBooksByEnabledEntries(books, ['system_core:999']);
    expect(result[0].entries).toHaveLength(0);
  });

  it('handles multiple uids for same partition', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: 413 }), makeEntry({ uid: 414 }), makeEntry({ uid: 415 })],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, ['system_core:413', 'system_core:415']);
    expect(result[0].entries).toHaveLength(2);
    expect(result[0].entries.map((e) => e.uid).sort()).toEqual([413, 415]);
  });

  it('skips malformed enabledEntry values', () => {
    const books = [makeBook({ partition: 'system_core', entries: [makeEntry({ uid: 413 })] })];
    // mixed: one valid pair with non-matching uid, others malformed
    const result = filterBooksByEnabledEntries(books, [
      'system_core:999',
      'system_core:abc',
      '',
      ':',
    ]);
    expect(result[0].entries).toHaveLength(0); // only system_core:999 parsed, uid 999 doesn't match 413
  });

  it('does not mutate input books', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: 413 }), makeEntry({ uid: 414 })],
      }),
    ];
    const originalLength = books[0].entries.length;
    filterBooksByEnabledEntries(books, ['system_core:413']);
    expect(books[0].entries).toHaveLength(originalLength);
  });
});
