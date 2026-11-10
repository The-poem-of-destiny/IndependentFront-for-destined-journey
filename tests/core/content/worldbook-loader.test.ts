/**
 * worldbook-loader 测试 (Phase 8)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadWorldBooksSync,
  getEntriesForAgent,
  filterActiveEntries,
  filterBooksByEnabledEntries,
  matchKeyword,
  formatWorldBookEntries,
  hasDynamic,
  renderWorldBookEntries,
  prerenderWorldBookEntries,
  clearEjsCompileCache,
} from '../../../src/core/content/worldbook-loader';
import {
  setEjsBackend,
  resetEjsBackend,
  FailClosedBackend,
  clearEjsBackendCache,
} from '../../../src/core/ejs/ejs-backend';
import type { WorldBook, WorldBookEntry } from '../../../src/core/types/types';
import type { EjsEvalContext } from '../../../src/core/ejs/ejs-runtime';

// ========== Helpers ==========

const uid = (slug: string, partition = 'world_setting') => `fated:${partition}/${slug}`;
function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    uid: uid('one'),
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
  it('returns entries from books whose audiences include the agent', () => {
    const books = [
      makeBook({
        id: 'world_setting',
        entries: [
          makeEntry({
            uid: uid('one'),
            content: '世界主设定',
            extra: { lore: { audiences: ['story'] } },
          }),
        ],
      }),
      makeBook({
        id: 'adventure_area',
        entries: [
          makeEntry({
            uid: uid('two'),
            content: '白曜城',
            extra: { lore: { audiences: ['char_gen'] } },
          }),
        ],
      }),
    ];

    const entries = getEntriesForAgent('story', books);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('世界主设定');
  });

  it('returns empty for no books', () => {
    const entries = getEntriesForAgent('unknown', []);
    expect(entries).toHaveLength(0);
  });

  it('书没有声明读取范围 → 谁也读不到', () => {
    const books = [makeBook({ entries: [makeEntry()] })];
    const entries = getEntriesForAgent('story', books);
    expect(entries).toHaveLength(0);
  });

  it('条目读取范围不含该 Agent → 空', () => {
    const books = [
      makeBook({ entries: [makeEntry({ extra: { lore: { audiences: ['char_gen'] } } })] }),
    ];
    expect(getEntriesForAgent('story', books)).toHaveLength(0);
  });

  it('条目级 audiences 各自生效', () => {
    const books = [
      makeBook({
        entries: [
          makeEntry({
            uid: uid('one'),
            content: '条目声明',
            extra: { lore: { audiences: ['story'] } },
          }),
          makeEntry({
            uid: uid('two'),
            content: '只给 char_gen',
            extra: { lore: { audiences: ['char_gen'] } },
          }),
          makeEntry({ uid: uid('three'), content: '显式空', extra: { lore: { audiences: [] } } }),
        ],
      }),
      makeBook({
        id: 'adventure_area',
        entries: [
          makeEntry({
            uid: uid('four'),
            content: '书无声明、条目给 story',
            extra: { lore: { audiences: ['story'] } },
          }),
        ],
      }),
    ];

    expect(getEntriesForAgent('story', books).map((e) => e.uid)).toEqual([uid('one'), uid('four')]);
    expect(getEntriesForAgent('char_gen', books).map((e) => e.uid)).toEqual([uid('two')]);
  });
});

// ========== filterActiveEntries ==========

describe('filterActiveEntries', () => {
  it('returns enabled entries', () => {
    const entries = [makeEntry({ uid: uid('one'), enabled: true })];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(1);
  });

  it('filters out disabled entries (enabled 绝对优先)', () => {
    const entries = [makeEntry({ uid: uid('one'), enabled: false })];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(0);
  });

  it('mix: 只保留 enabled 的条目', () => {
    const entries = [
      makeEntry({ uid: uid('one'), enabled: true }),
      makeEntry({ uid: uid('two'), enabled: false }),
      makeEntry({ uid: uid('three'), enabled: true }),
    ];
    const result = filterActiveEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.uid)).toEqual([uid('one'), uid('three')]);
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
      makeEntry({ uid: uid('three'), content: '第三条', order: 300 }),
      makeEntry({ uid: uid('one'), content: '第一条', order: 100 }),
      makeEntry({ uid: uid('two'), content: '第二条', order: 200 }),
    ];
    const result = formatWorldBookEntries(entries);
    expect(result).toBe('第一条\n\n第二条\n\n第三条');
  });
});

// ========== filterBooksByEnabledEntries ==========

describe('filterBooksByEnabledEntries', () => {
  it.each([{ selected: [] }, { selected: [uid('core', 'system_core')] }])(
    '未选择内置角色时，所有 Agent 都排除默认启用的人物档案（$selected）',
    ({ selected }) => {
      const audiences = ['story', 'char_gen', 'vars_update'];
      const books = [
        makeBook({
          id: 'character',
          partition: 'character',
          builtIn: true,
          entries: ['guide', 'mage', 'merchant'].map((slug) =>
            makeEntry({
              uid: uid(slug, 'character'),
              content: `未选择的人物档案 ${slug}`,
              extra: { lore: { audiences, required: true } },
            }),
          ),
        }),
        makeBook({
          id: 'race',
          partition: 'race',
          builtIn: true,
          entries: [makeEntry({ uid: uid('human', 'race'), extra: { lore: { audiences } } })],
        }),
      ];
      const original = JSON.stringify(books);
      const filtered = filterBooksByEnabledEntries(books, selected);

      expect(filtered[0].entries).toEqual([]);
      for (const agentId of audiences) {
        expect(getEntriesForAgent(agentId, filtered).map((entry) => entry.uid)).toEqual([
          uid('human', 'race'),
        ]);
      }
      expect(JSON.stringify(books)).toBe(original);
    },
  );

  it('明确选择的内置角色覆盖默认停用，未选择的默认启用角色仍被排除', () => {
    const audiences = ['story', 'char_gen', 'vars_update'];
    const book = makeBook({
      id: 'character',
      partition: 'character',
      builtIn: true,
      entries: [
        makeEntry({
          uid: uid('selected', 'character'),
          enabled: false,
          extra: { lore: { audiences } },
        }),
        makeEntry({ uid: uid('unselected', 'character'), extra: { lore: { audiences } } }),
      ],
    });
    const filtered = filterBooksByEnabledEntries([book], [uid('selected', 'character')]);

    for (const agentId of audiences) {
      expect(getEntriesForAgent(agentId, filtered).map((entry) => entry.uid)).toEqual([
        uid('selected', 'character'),
      ]);
    }
    expect(book.entries.map((entry) => entry.enabled)).toEqual([false, true]);
  });

  it('未记录角色选择不改变用户角色书及其它分区的默认过滤语义', () => {
    const books = [
      makeBook({
        id: 'user-characters',
        partition: 'character',
        builtIn: false,
        entries: [makeEntry({ uid: 'user:character/custom_abc' })],
      }),
      makeBook({
        partition: 'creative_workshop',
        entries: [makeEntry({ uid: 'workshop.test:creative_workshop/rule' })],
      }),
    ];

    expect(filterBooksByEnabledEntries(books, [])).toEqual(books);
  });

  it('returns all books unchanged when enabledEntries is empty', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        entries: [
          makeEntry({ uid: uid('dalian', 'system_core') }),
          makeEntry({ uid: uid('nightingale', 'system_core') }),
        ],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, []);
    expect(result).toHaveLength(1);
    expect(result[0].entries).toHaveLength(2);
  });

  it('returns all books unchanged when enabledEntries is undefined/empty array', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: uid('core', 'system_core') })],
      }),
    ];
    expect(filterBooksByEnabledEntries(books, []).length).toBe(1);
  });

  it('keeps only matching uids for partitions in enabledEntries', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        entries: [
          makeEntry({ uid: uid('dalian', 'system_core'), content: '命运之轮' }),
          makeEntry({ uid: uid('nightingale', 'system_core'), content: '星辰指引' }),
          makeEntry({ uid: uid('shadow', 'system_core'), content: '暗影低语' }),
        ],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, [uid('dalian', 'system_core')]);
    expect(result).toHaveLength(1);
    expect(result[0].entries).toHaveLength(1);
    expect(result[0].entries[0].uid).toBe(uid('dalian', 'system_core'));
    expect(result[0].entries[0].content).toBe('命运之轮');
  });

  it('存档选中的内置命定核心应进入 Agent 激活条目', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        builtIn: true,
        entries: [
          makeEntry({
            uid: uid('dalian', 'system_core'),
            name: '命定系统-妲丽安核心',
            content: '妲丽安世界书正文',
            enabled: false,
            extra: { lore: { audiences: ['story'] } },
          }),
          makeEntry({
            uid: uid('nightingale', 'system_core'),
            name: '命定系统-小夜莺核心',
            enabled: false,
            extra: { lore: { audiences: ['story'] } },
          }),
        ],
      }),
    ];
    const filtered = filterBooksByEnabledEntries(books, [uid('dalian', 'system_core')]);
    const active = filterActiveEntries(getEntriesForAgent('story', filtered));

    expect(active.map((entry) => entry.uid)).toEqual([uid('dalian', 'system_core')]);
    expect(active[0].content).toBe('妲丽安世界书正文');
  });

  it('不覆盖工坊或用户书自身的 enabled=false', () => {
    const books = [
      makeBook({
        id: 'workshop:test',
        partition: 'creative_workshop',
        builtIn: false,
        entries: [makeEntry({ uid: 'workshop.test:creative_workshop/rule', enabled: false })],
      }),
    ];

    const filtered = filterBooksByEnabledEntries(books, ['workshop.test:creative_workshop/rule']);

    expect(filtered[0].entries).toHaveLength(1);
    expect(filtered[0].entries[0].enabled).toBe(false);
  });

  it('passes through books whose partition is not in enabledEntries', () => {
    const books = [
      makeBook({
        id: 'system_core',
        partition: 'system_core',
        entries: [makeEntry({ uid: uid('dalian', 'system_core') })],
      }),
      makeBook({
        id: 'race',
        partition: 'race',
        entries: [makeEntry({ uid: uid('human', 'race') }), makeEntry({ uid: uid('elf', 'race') })],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, [uid('dalian', 'system_core')]);
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
        entries: [
          makeEntry({ uid: uid('dalian', 'system_core') }),
          makeEntry({ uid: uid('nightingale', 'system_core') }),
        ],
      }),
      makeBook({
        partition: 'character',
        entries: [
          makeEntry({ uid: uid('selected', 'character') }),
          makeEntry({ uid: uid('other', 'character') }),
        ],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, [
      uid('dalian', 'system_core'),
      uid('selected', 'character'),
    ]);
    expect(result[0].entries.map((e) => e.uid)).toEqual([uid('dalian', 'system_core')]);
    expect(result[1].entries.map((e) => e.uid)).toEqual([uid('selected', 'character')]);
  });

  it('removes all entries for a partition when no uid matches', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: uid('dalian', 'system_core') })],
        name: '核心',
      }),
    ];
    const result = filterBooksByEnabledEntries(books, [uid('missing', 'system_core')]);
    expect(result[0].entries).toHaveLength(0);
  });

  it('handles multiple uids for same partition', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [
          makeEntry({ uid: uid('dalian', 'system_core') }),
          makeEntry({ uid: uid('nightingale', 'system_core') }),
          makeEntry({ uid: uid('shadow', 'system_core') }),
        ],
      }),
    ];
    const result = filterBooksByEnabledEntries(books, [
      uid('dalian', 'system_core'),
      uid('shadow', 'system_core'),
    ]);
    expect(result[0].entries).toHaveLength(2);
    expect(result[0].entries.map((e) => e.uid).sort()).toEqual([
      uid('dalian', 'system_core'),
      uid('shadow', 'system_core'),
    ]);
  });

  it('skips malformed enabledEntry values', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [makeEntry({ uid: uid('dalian', 'system_core') })],
      }),
    ];
    // 完整但不存在的 UID 触发过滤；旧数字 token 与畸形输入不参与解析。
    const result = filterBooksByEnabledEntries(books, [
      uid('missing', 'system_core'),
      'system_core:999',
      'system_core:abc',
      '',
      ':',
    ]);
    expect(result[0].entries).toHaveLength(0); // 仅合法命名空间 UID 参与匹配。
  });

  it('does not mutate input books', () => {
    const books = [
      makeBook({
        partition: 'system_core',
        entries: [
          makeEntry({ uid: uid('dalian', 'system_core') }),
          makeEntry({ uid: uid('nightingale', 'system_core') }),
        ],
      }),
    ];
    const originalLength = books[0].entries.length;
    filterBooksByEnabledEntries(books, [uid('dalian', 'system_core')]);
    expect(books[0].entries).toHaveLength(originalLength);
  });
});

// ========== 静/动分层 + EJS 求值（工坊 Phase 2 / ADR-30 D7-D9）==========

/** 一个最小求值上下文；`vars` 每次新建，避免用例间串味 */
function makeCtx(overrides: Partial<EjsEvalContext> = {}): EjsEvalContext {
  return { stats: {}, vars: {}, historyText: '', ...overrides };
}

describe('hasDynamic — D7 三根针', () => {
  it('三种动态特征各自命中', () => {
    expect(hasDynamic('前<% x %>后')).toBe(true);
    expect(hasDynamic('掷一下 {{random: a, b}}')).toBe(true);
    expect(hasDynamic('取值 {{getvar::foo}}')).toBe(true);
  });

  it('纯文本 / `{{setvar}}` 定义不算动态', () => {
    expect(hasDynamic('普通设定正文')).toBe(false);
    // setvar 定义确定性剥离，刻意不扫（D7 明文）
    expect(hasDynamic('{{setvar::foo::1}}')).toBe(false);
    expect(hasDynamic('')).toBe(false);
  });
});

describe('renderWorldBookEntries — 分层与保序', () => {
  beforeEach(() => clearEjsCompileCache());

  it('无动态特征的条目全部落静态区，动态区为空', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: 'A' }),
      makeEntry({ uid: uid('two'), content: 'B' }),
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.staticText).toBe('A\n\nB');
    expect(r.dynamicText).toBe('');
    expect(r.fallbackEntries).toEqual([]);
  });

  it('两区内部各自按 order 排序，同 order 保持入参顺序', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '静C', order: 300 }),
      makeEntry({ uid: uid('two'), content: '动<%= 2 %>', order: 200 }),
      makeEntry({ uid: uid('three'), content: '静A', order: 100 }),
      makeEntry({ uid: uid('four'), content: '动<%= 1 %>', order: 100 }),
      makeEntry({ uid: uid('five'), content: '静B', order: 100 }), // 与「静A」同 order → 稳定排序
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.staticText).toBe('静A\n\n静B\n\n静C');
    expect(r.dynamicText).toBe('动1\n\n动2');
  });

  it('只含 {{random}}/{{getvar}} 无 `<%` 的条目：进动态区但不求值，原文透传', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '{{random: 甲, 乙}}', order: 10 }),
      makeEntry({ uid: uid('two'), content: '{{getvar::foo}}', order: 20 }),
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.staticText).toBe('');
    expect(r.dynamicText).toBe('{{random: 甲, 乙}}\n\n{{getvar::foo}}');
    expect(r.fallbackEntries).toEqual([]);
  });

  it('EJS 条目相对顺序不变 → vars 写→读链按序可见', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '静态占位', order: 50 }),
      makeEntry({ uid: uid('two'), content: '<% setvar("n", 7) %>写', order: 100 }),
      makeEntry({ uid: uid('three'), content: '读<%= getvar("n") %>', order: 200 }),
    ];
    const vars: Record<string, any> = {};
    const r = renderWorldBookEntries(entries, makeCtx({ vars }));
    expect(r.dynamicText).toBe('写\n\n读7');
    expect(vars.n).toBe(7);
  });

  it('编译失败 → 原文注入 + 记入 fallbackEntries，其余条目照常', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '好<%= 1 + 1 %>', order: 10 }),
      makeEntry({ uid: uid('two'), content: '坏<% if ( %>', order: 20 }),
      makeEntry({ uid: uid('three'), content: '好<%= 3 %>', order: 30 }),
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText).toBe('好2\n\n坏<% if ( %>\n\n好3');
    expect(r.fallbackEntries).toHaveLength(1);
    expect(r.fallbackEntries[0].uid).toBe(uid('two'));
    expect(r.fallbackEntries[0].error).toMatch(/SyntaxError/);
  });

  it('执行失败 → 原文注入且该条目对 vars 的半途写入整体回滚', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '<% setvar("keep", 1) %>ok', order: 10 }),
      makeEntry({
        uid: uid('two'),
        content: '<% setvar("gone", 1); undefinedSymbol(); %>never',
        order: 20,
      }),
    ];
    const vars: Record<string, any> = {};
    const r = renderWorldBookEntries(entries, makeCtx({ vars }));
    expect(r.fallbackEntries).toHaveLength(1);
    expect(r.fallbackEntries[0].uid).toBe(uid('two'));
    expect(r.dynamicText).toContain('<% setvar("gone", 1); undefinedSymbol(); %>never');
    expect(vars.keep).toBe(1);
    expect(vars.gone).toBeUndefined();
  });

  it('回退条目仍留在动态区原位（不被挪到末尾）', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: '<%= "甲" %>', order: 10 }),
      makeEntry({ uid: uid('two'), content: '<% if ( %>', order: 20 }),
      makeEntry({ uid: uid('three'), content: '<%= "丙" %>', order: 30 }),
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText.split('\n\n')).toEqual(['甲', '<% if ( %>', '丙']);
  });

  it('空入参 → 两区皆空串（对齐 formatWorldBookEntries）', () => {
    const r = renderWorldBookEntries([], makeCtx());
    expect(r.staticText).toBe('');
    expect(r.dynamicText).toBe('');
    expect(r.fallbackEntries).toEqual([]);
  });

  it('不修改入参数组顺序', () => {
    const entries = [
      makeEntry({ uid: uid('one'), content: 'B', order: 200 }),
      makeEntry({ uid: uid('two'), content: 'A', order: 100 }),
    ];
    renderWorldBookEntries(entries, makeCtx());
    expect(entries.map((e) => e.uid)).toEqual([uid('one'), uid('two')]);
  });

  it('编译缓存：同一正文重复出现只编译一次（清缓存后结果不变）', () => {
    const same = '<%= getvar("k") %>';
    const entries = [
      makeEntry({ uid: uid('one'), content: same, order: 10 }),
      makeEntry({ uid: uid('two'), content: same, order: 20 }),
    ];
    const first = renderWorldBookEntries(entries, makeCtx({ vars: { k: 'x' } }));
    expect(first.dynamicText).toBe('x\n\nx');
    // 缓存命中不跳过执行 → 新 ctx 出新值
    const second = renderWorldBookEntries(entries, makeCtx({ vars: { k: 'y' } }));
    expect(second.dynamicText).toBe('y\n\ny');
    clearEjsCompileCache();
    const third = renderWorldBookEntries(entries, makeCtx({ vars: { k: 'z' } }));
    expect(third.dynamicText).toBe('z\n\nz');
  });
});

describe('renderWorldBookEntries — 同步路径的 fail-closed 闸门（F3）', () => {
  beforeEach(() => {
    clearEjsCompileCache();
    clearEjsBackendCache();
  });
  afterEach(() => resetEjsBackend());

  it('后端不是 Legacy 时同步路径不在宿主 realm 求值 → 原文注入 + 记回退', () => {
    setEjsBackend(new FailClosedBackend('隔离后端装载失败: 模拟'));
    const entries = [
      makeEntry({ uid: uid('one'), content: '静态', order: 10 }),
      makeEntry({ uid: uid('two'), content: '<%= 1 + 1 %>', order: 20 }),
    ];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.staticText).toBe('静态');
    // 未求值 → 原文（不是 "2"）
    expect(r.dynamicText).toBe('<%= 1 + 1 %>');
    expect(r.fallbackEntries).toHaveLength(1);
    expect(r.fallbackEntries[0].uid).toBe(uid('two'));
    expect(r.fallbackEntries[0].error).toContain('未求值');
  });

  it('闸门只挡 EJS —— 只含 {{random}}/{{getvar}} 的条目照旧原文透传、不记回退', () => {
    setEjsBackend(new FailClosedBackend('x'));
    const entries = [makeEntry({ uid: uid('one'), content: '{{getvar::foo}}', order: 10 })];
    const r = renderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText).toBe('{{getvar::foo}}');
    expect(r.fallbackEntries).toEqual([]);
  });

  it('默认 Legacy 后端（测试基线）下行为不变，照常求值', () => {
    const entries = [makeEntry({ uid: uid('one'), content: '<%= 1 + 1 %>', order: 10 })];
    expect(renderWorldBookEntries(entries, makeCtx()).dynamicText).toBe('2');
  });
});

describe('prerenderWorldBookEntries — 结果按下标回填（F4 回归）', () => {
  beforeEach(() => {
    clearEjsCompileCache();
    clearEjsBackendCache();
  });
  afterEach(() => resetEjsBackend());

  it('重复 UID 的非法输入仍逐下标渲染，各自正文各出现一次', async () => {
    // 协议入口禁止全局重复；底层渲染器面对未校验的非法输入也不能吞正文。
    const entries = [
      makeEntry({ uid: uid('duplicate'), content: '甲书<%= 1 + 1 %>', order: 10 }),
      makeEntry({ uid: uid('duplicate'), content: '乙书<%= 20 + 2 %>', order: 20 }),
    ];
    const r = await prerenderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText.split('\n\n')).toEqual(['甲书2', '乙书22']);
    expect(r.fallbackEntries).toEqual([]);
  });

  it('非法重复 UID + 其中一条失败：只有失败那条回退，另一条正常渲染', async () => {
    const entries = [
      makeEntry({ uid: uid('duplicate'), content: '好<%= "甲" %>', order: 10 }),
      makeEntry({ uid: uid('duplicate'), content: '坏<% if ( %>', order: 20 }),
      makeEntry({ uid: uid('duplicate'), content: '好<%= "丙" %>', order: 30 }),
    ];
    const r = await prerenderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText.split('\n\n')).toEqual(['好甲', '坏<% if ( %>', '好丙']);
    expect(r.fallbackEntries).toHaveLength(1);
    expect(r.fallbackEntries[0].uid).toBe(uid('duplicate'));
    expect(r.fallbackEntries[0].error).toMatch(/SyntaxError/);
  });

  it('非法重复 UID 条目夹着不需求值的宏条目时，下标仍不错位', async () => {
    const entries = [
      makeEntry({ uid: uid('duplicate'), content: '<%= "一" %>', order: 10 }),
      makeEntry({ uid: uid('duplicate'), content: '{{getvar::foo}}', order: 20 }), // 不进后端
      makeEntry({ uid: uid('duplicate'), content: '<%= "二" %>', order: 30 }),
    ];
    const r = await prerenderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText.split('\n\n')).toEqual(['一', '{{getvar::foo}}', '二']);
  });

  it('后端违约少返结果时按 D8 原文注入并留痕（不静默错位）', async () => {
    setEjsBackend({
      name: 'broken(测试桩)',
      interruptible: true,
      async runPass(list) {
        // 故意只返第一条 —— 下标回填必须让第二条走 `!outcome` 分支
        return list.slice(0, 1).map((e) => ({ uid: e.uid, text: '已渲染', ok: true }));
      },
      dispose() {},
    });
    const entries = [
      makeEntry({ uid: uid('one'), content: '<%= 1 %>', order: 10 }),
      makeEntry({ uid: uid('two'), content: '<%= 2 %>', order: 20 }),
    ];
    const r = await prerenderWorldBookEntries(entries, makeCtx());
    expect(r.dynamicText.split('\n\n')).toEqual(['已渲染', '<%= 2 %>']);
    expect(r.fallbackEntries).toHaveLength(1);
    expect(r.fallbackEntries[0].error).toContain('未返回该条目结果');
  });
});
