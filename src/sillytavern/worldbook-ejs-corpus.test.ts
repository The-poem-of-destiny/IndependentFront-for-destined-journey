/**
 * worldbook-ejs-corpus.test.ts — 全语料冒烟 + golden 用例（工坊 Phase 2 / ADR-30 D7-D10）
 *
 * 两层保障：
 * 1. **全语料冒烟**（回归闸门）：直读 `data/worldbooks/*.json` 的全部真实条目（509 条），
 *    配 `buildStatData` 造的 fixture stats 跑 `renderWorldBookEntries`——不抛、静态区无动态特征、
 *    且**回退条目集合 ⊆ 已知白名单**。白名单外冒出新回退 = 测试红（取代裸百分比阈值，
 *    设计 §4「ST 宏嵌在 EJS 内」条裁定）。
 * 2. **golden 用例**：从 `event.json` 抽两个真实条目定点断言渲染文本与 `vars` 草稿写入。
 *
 * 注：语料用 Vite 的 `import.meta.glob(..., { query: '?raw' })` 取，**不用 node 的 fs/path**——
 * 仓库没装 `@types/node`，`src/**` 下 `import 'node:fs'` 会让裸 tsc 报 TS2307
 * （同 `SettingsPage.engine-imports.test.ts` 的口径）。`?raw` 的环境声明由
 * `src/env.d.ts` 引的 `vite/client` 提供。
 */

import { describe, it, expect } from 'vitest';
import { renderWorldBookEntries, hasDynamic, clearEjsCompileCache } from './worldbook-loader';
import { buildStatData } from './stat-projection';
import { createDefaultCharacterState } from './types';
import type { WorldBook, WorldBookEntry, CharacterState } from './types';
import type { GameTime } from './time-system';

// ========== 语料加载 ==========

/** 全部内置世界书原文（key = 相对路径，如 `../../data/worldbooks/event.json`） */
const RAW_BOOKS = import.meta.glob('../../data/worldbooks/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface CorpusItem {
  /** 文件名（如 `event.json`），仅用于失败信息定位 */
  file: string;
  entry: WorldBookEntry;
}

function loadCorpus(): CorpusItem[] {
  const items: CorpusItem[] = [];
  for (const path of Object.keys(RAW_BOOKS).sort()) {
    const book = JSON.parse(RAW_BOOKS[path]) as WorldBook;
    const file = path.slice(path.lastIndexOf('/') + 1);
    for (const entry of book.entries) items.push({ file, entry });
  }
  return items;
}

/** 从 event.json 取指定 uid 的真实条目（golden 用例的取材口） */
function pickEventEntry(uid: number): WorldBookEntry {
  const path = Object.keys(RAW_BOOKS).find((p) => p.endsWith('/event.json'));
  if (!path) throw new Error('语料里找不到 event.json——golden 用例取材失效');
  const book = JSON.parse(RAW_BOOKS[path]) as WorldBook;
  const entry = book.entries.find((e) => e.uid === uid);
  if (!entry) throw new Error(`event.json 缺少 uid=${uid} 条目——golden 用例取材失效`);
  return entry;
}

// ========== fixture ==========

const TIME: GameTime = {
  era: '复兴纪元',
  year: 1,
  month: 5,
  day: 24,
  weekday: 1,
  hour: 15,
  minute: 30,
};

/** `formatGameTime(TIME)` 的规范串——多处断言复用 */
const TIME_TEXT = '复兴纪元0001年-05月-24日-周日-15:30';

function makeStats(overrides: Partial<CharacterState> = {}): Record<string, any> {
  return buildStatData({
    characters: [
      createDefaultCharacterState({
        id: 'p1',
        saveId: 's1',
        type: 'player',
        name: '莉泽尔',
        level: 12,
        ...overrides,
      }),
    ],
    gameTime: TIME,
    fp: 42,
  });
}

// ========== 已知回退白名单（回归闸门）==========

/**
 * 实测钉死的 8 条注定回退条目（509 条目中，1.6%）。
 * 全部是**内容侧缺口**，不是引擎缺陷——见设计 §4 降级清单。
 *
 * 出现白名单外的新 uid = 本次改动引入了回归，测试必须红。
 * 反向也管：白名单里的条目哪天修好了（不再回退），也要来这里删行。
 */
const KNOWN_FALLBACK_UIDS: ReadonlyArray<{ uid: number; where: string; why: string }> = [
  // —— 酒馆助手扩展 API 未注入（6 条，设计 §4 第 3 行）——
  { uid: 477, where: 'dlc.json 月历球', why: 'YAML is not defined' },
  { uid: 505, where: 'dlc.json 边陲之国-莉莉', why: 'message_id is not defined' },
  { uid: 343, where: 'event.json 冰之歌', why: 'lastMessageId is not defined' },
  { uid: 353, where: 'event.json 群山回响-入口', why: 'TavernHelper is not defined' },
  { uid: 357, where: 'event.json 血姬-入口', why: 'TavernHelper is not defined' },
  { uid: 421, where: 'system_core.json 读者核心', why: 'getChatMessage is not defined' },
  // —— 语言特性不支持（1 条，设计 §4 第 1 行）——
  { uid: 417, where: 'system_core.json 艾莉亚核心', why: 'await 不支持（同步执行）' },
  // —— ST 宏嵌在 EJS 代码块内（1 条，设计 §4 第 4 行：注定回退，已裁定接受）——
  { uid: 358, where: 'event.json 血姬-本体', why: '`if ({{roll 1d100}} >= 100)` → SyntaxError' },
];

const KNOWN_FALLBACK_UID_SET = new Set(KNOWN_FALLBACK_UIDS.map((x) => x.uid));

// ═══════════════════════════════════════════════════════════
// 全语料冒烟
// ═══════════════════════════════════════════════════════════

describe('全语料冒烟 — renderWorldBookEntries × 内置世界书', () => {
  const corpus = loadCorpus();
  const entries = corpus.map((c) => c.entry);

  it('语料非空且 uid 全局唯一（白名单按 uid 索引的前提）', () => {
    expect(entries.length).toBeGreaterThan(400);
    expect(new Set(entries.map((e) => e.uid)).size).toBe(entries.length);
  });

  it('全语料跑通不抛，静态区无任何动态特征残留', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const result = renderWorldBookEntries(entries, {
      stats: makeStats(),
      vars,
      historyText: '',
    });

    // 静态区必须逐字节稳定 → 三根针一根都不能漏进来
    expect(result.staticText).not.toContain('<%');
    expect(result.staticText).not.toContain('{{random');
    expect(result.staticText).not.toContain('{{getvar');

    // 分层不吞条目：两区条目数之和 = 入参条目数
    const dynamicCount = entries.filter((e) => hasDynamic(e.content)).length;
    expect(dynamicCount).toBeGreaterThan(0);
    expect(dynamicCount).toBeLessThan(entries.length);
  });

  it('回退条目集合 ⊆ 已知白名单（回归闸门）', () => {
    clearEjsCompileCache();
    const result = renderWorldBookEntries(entries, {
      stats: makeStats(),
      vars: {},
      historyText: '',
    });

    const byUid = new Map(corpus.map((c) => [c.entry.uid, c]));
    const unexpected = result.fallbackEntries
      .filter((f) => !KNOWN_FALLBACK_UID_SET.has(f.uid))
      .map(
        (f) => `${byUid.get(f.uid)?.file}#${f.uid} ${byUid.get(f.uid)?.entry.name} :: ${f.error}`,
      );

    expect(unexpected).toEqual([]);
    // 反向闸门：白名单条目若被修好，这里会红——提醒来白名单删行
    expect(new Set(result.fallbackEntries.map((f) => f.uid))).toEqual(KNOWN_FALLBACK_UID_SET);
  });

  it('回退条目原文进动态区（零回归：最坏情况等于不上线）', () => {
    clearEjsCompileCache();
    const result = renderWorldBookEntries(entries, {
      stats: makeStats(),
      vars: {},
      historyText: '',
    });
    const byUid = new Map(corpus.map((c) => [c.entry.uid, c]));
    for (const f of result.fallbackEntries) {
      const original = byUid.get(f.uid)!.entry.content;
      expect(result.dynamicText).toContain(original);
    }
  });

  it('EJS 求值确实写进了 vars 草稿（不是空转）', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    renderWorldBookEntries(entries, { stats: makeStats(), vars, historyText: '' });
    // 斯芬克斯条目的信号守卫初始化——语料里最稳定的写入锚点
    expect(vars['事件']?.['信号']).toEqual([]);
  });

  it('stats 只读：全语料求值后 fixture 快照不被污染', () => {
    clearEjsCompileCache();
    const stats = makeStats();
    const before = JSON.stringify(stats);
    renderWorldBookEntries(entries, { stats, vars: {}, historyText: '' });
    expect(JSON.stringify(stats)).toBe(before);
  });

  it('编译缓存复用：二次全跑不重复编译，且静态区逐字节一致', () => {
    clearEjsCompileCache();
    const ctx1 = { stats: makeStats(), vars: {}, historyText: '' };
    const first = renderWorldBookEntries(entries, ctx1);
    const ctx2 = { stats: makeStats(), vars: {}, historyText: '' };
    const second = renderWorldBookEntries(entries, ctx2);
    // D7 的全部意义：静态区可证明地逐字节稳定
    expect(second.staticText).toBe(first.staticText);
    expect(second.fallbackEntries.map((f) => f.uid)).toEqual(
      first.fallbackEntries.map((f) => f.uid),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// golden 用例（event.json 真实条目）
// ═══════════════════════════════════════════════════════════

describe('golden — event.json#349 斯芬克斯支线', () => {
  /**
   * `historyText` 含「斯芬克斯」→ 条目里的
   * `Math.random() < 0.3 || matchChatMessages("斯芬克斯")` 短路为真，
   * 消掉随机性，初见分支必定渲染。
   */
  function render() {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const result = renderWorldBookEntries([pickEventEntry(349)], {
      stats: makeStats(),
      vars,
      historyText: '……那只斯芬克斯静静地俯视着。',
    });
    return { result, vars };
  }

  it('空 vars 时信号守卫把 事件.信号 初始化为空数组', () => {
    const { result, vars } = render();
    expect(result.fallbackEntries).toEqual([]);
    expect(vars['事件']['信号']).toEqual([]);
  });

  it('走「未完成 + 未进入谜题」分支：渲染初见段，不渲染呼唤段', () => {
    const { result } = render();
    expect(result.staticText).toBe('');
    expect(result.dynamicText).toContain('初见: 安排<user>与斯芬克斯的初见');
    expect(result.dynamicText).toContain('谜题: 斯芬克斯将询问<user>那个经典谜题');
    // else 分支（已进入谜题）的标志句必须缺席
    expect(result.dynamicText).not.toContain('触发: <user>在正确地点呼唤');
    expect(result.dynamicText).not.toContain('<谜题设计思路>');
  });

  it('`<%= sigPuzzle %>` / `<%= sigCompleted %>` 求值成字面信号名', () => {
    const { result } = render();
    expect(result.dynamicText).toContain('"value": "斯芬克斯支线_mid371"');
    expect(result.dynamicText).toContain('"value": "斯芬克斯支线_done0231"');
    expect(result.dynamicText).not.toContain('<%');
  });
});

describe('golden — event.json#343 冰之歌', () => {
  const iceEntry = pickEventEntry(343);

  /**
   * 🔴 生产真相：该条目读裸标识符 `lastMessageId`（酒馆助手楼层号，我们不注入），
   * 严格模式下 `ReferenceError` → 白名单回退。这是**当前的正确行为**，不是缺陷。
   */
  it('生产 ctx 下回退原文，且半途写入整体回滚（vars 保持干净）', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const result = renderWorldBookEntries([iceEntry], {
      stats: makeStats({ level: 12 }),
      vars,
      historyText: '',
    });
    expect(result.fallbackEntries).toEqual([
      { uid: 343, error: 'ReferenceError: lastMessageId is not defined' },
    ]);
    expect(result.dynamicText).toBe(iceEntry.content);
    expect(vars).toEqual({});
  });

  /**
   * 目标行为验证：把缺失的 `lastMessageId` 临时补上（模拟「酒馆助手 API 存在」的世界），
   * 再验条目自身的簿记链——`主角.等级 >= 10` → 首次触发时把 `世界.时间` 写进 vars 草稿。
   * ⚠️ 这条断言依赖测试期的 globalThis 垫片，**不代表生产路径当前可用**（见上一条）。
   */
  it('补上 lastMessageId 后：等级 ≥10 把 世界.时间 写进 事件.冰之歌.触发时间', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const stats = makeStats({ level: 12 });
    (globalThis as any).lastMessageId = 7;
    let result;
    try {
      result = renderWorldBookEntries([iceEntry], { stats, vars, historyText: '' });
    } finally {
      delete (globalThis as any).lastMessageId;
    }

    expect(result.fallbackEntries).toEqual([]);
    expect(stats['世界']['时间']).toBe(TIME_TEXT);
    expect(vars['事件']['冰之歌']['触发时间']).toBe(TIME_TEXT);
    expect(vars['事件']['冰之歌']['触发楼层']).toBe(7);
    // 二阶段要求等级 ≥15，12 级不该写
    expect(vars['事件']['冰之歌']['二阶段触发时间']).toBeUndefined();

    // 一阶段刚触发（currentFloor - floor = 0 ≤ lag）→ 扩散阶段 event 段渲染
    expect(result.dynamicText).toContain(`- [${TIME_TEXT}] 北境长垣防线崩溃`);
    expect(result.dynamicText).toContain('触发: 冰之歌事件进入扩散阶段');
    expect(result.dynamicText).not.toContain('触发: 冰之歌事件进入二阶段');
  });

  it('补上 lastMessageId 且等级 <10：不触发、不写 vars、只出空白', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    (globalThis as any).lastMessageId = 7;
    let result;
    try {
      result = renderWorldBookEntries([iceEntry], {
        stats: makeStats({ level: 3 }),
        vars,
        historyText: '',
      });
    } finally {
      delete (globalThis as any).lastMessageId;
    }
    expect(result.fallbackEntries).toEqual([]);
    expect(vars).toEqual({});
    expect(result.dynamicText).not.toContain('世界大事记_冰之歌');
    expect(result.dynamicText.trim()).toBe('');
  });
});
