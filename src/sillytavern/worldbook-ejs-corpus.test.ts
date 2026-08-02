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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  renderWorldBookEntries,
  prerenderWorldBookEntries,
  hasDynamic,
  clearEjsCompileCache,
} from './worldbook-loader';
import { LegacyBackend, clearEjsBackendCache, resetEjsBackend, setEjsBackend } from './ejs-backend';
import { createQuickJsBackend } from './ejs-quickjs-backend';
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
 * 实测钉死的 7 条注定回退条目（509 条目中，1.4%）。
 * 全部是**内容侧缺口**，不是引擎缺陷——见设计 §4 降级清单。
 *
 * 出现白名单外的新 uid = 本次改动引入了回归，测试必须红。
 * 反向也管：白名单里的条目哪天修好了（不再回退），也要来这里删行。
 */
const KNOWN_FALLBACK_UIDS: ReadonlyArray<{ uid: number; where: string; why: string }> = [
  // 🟢 **空表**（2026-08-01，能力面 T4/T5）：原先 7 条回退全部由新能力接管 ——
  //    TavernHelper / getChatMessage / lastMessageId / message_id / YAML / localStorage / toastr
  //    进了别名层（§5），await 由 T1 的 AsyncFunction 接住。内置全语料 **零回退**。
  //    这里一旦冒出新条目 = 引入了回归。
];

const KNOWN_FALLBACK_UID_SET = new Set(KNOWN_FALLBACK_UIDS.map((x) => x.uid));

/**
 * **QuickJS 后端**的独立基线（F11）。
 *
 * 上面那张表跑的是 `LegacyBackend`（本模块的默认值），而**生产跑的是 QuickJS** ——
 * 只测 Legacy 等于给隔离后端留了一整块无闸门区：QuickJS 独有的回归（编组丢失、
 * 能力面没接上 guest、预算掐断）在全绿的测试下也照样能上线。
 *
 * 期望两张表**相等**：能力面在两个后端上是同一套语义（T4/T5 的全部意义）。
 * 不等 = 后端间出现了语义漂移，要么补 shim 要么在这里写明白是哪条后端限制。
 */
const QUICKJS_KNOWN_FALLBACK_UIDS: ReadonlyArray<{ uid: number; where: string; why: string }> = [
  // 🟢 **空表**（2026-08-01）：唯一一条 dlc#477（月历球 › 当前月历内容展示）已修 ——
  //    guest 侧 lodash shim 补上了 `_.chain` / `.value()`（与 `ejs-lodash-shim.ts` 的
  //    CHAIN_METHODS 同一张表）。两张白名单现在都是空的 = 两后端零漂移，正是 T4/T5 的目标态。
];

const QUICKJS_KNOWN_FALLBACK_UID_SET = new Set(QUICKJS_KNOWN_FALLBACK_UIDS.map((x) => x.uid));

/**
 * 两后端**登记在案**的基线差异（= QuickJS 白名单 − Legacy 白名单，双向）。
 * 跨后端对拍用它当预期，而不是硬写 uid：改任一张白名单，这里自动跟着走。
 */
const BACKEND_DIVERGENCE = new Set(
  [...QUICKJS_KNOWN_FALLBACK_UID_SET, ...KNOWN_FALLBACK_UID_SET].filter(
    (uid) => QUICKJS_KNOWN_FALLBACK_UID_SET.has(uid) !== KNOWN_FALLBACK_UID_SET.has(uid),
  ),
);

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

  it('回退条目集合 ⊆ 已知白名单（回归闸门，走生产的异步预渲染路径）', async () => {
    clearEjsCompileCache();
    // 🔴 必须用 prerenderWorldBookEntries：同步路径吃不下 async 条目（T1 起 await 走异步入口），
    //    拿同步路径当闸门会把「生产能跑」的条目误报成回退。
    const result = await prerenderWorldBookEntries(entries, {
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
// 全语料冒烟 × QuickJS 后端（生产真身）
// ═══════════════════════════════════════════════════════════

describe('全语料冒烟 — prerenderWorldBookEntries × QuickJS 后端', () => {
  const corpus = loadCorpus();
  const entries = corpus.map((c) => c.entry);
  /** 真 wasm 后端：整份语料一个 pass，首次装载有秒级开销 */
  const backend = createQuickJsBackend();
  /** wasm 装载 + 509 条目一趟 pass —— 比 Legacy 慢一个量级，给宽裕的超时 */
  const SLOW = 120_000;

  beforeAll(() => {
    // 编译缓存是后端间共享的（键=正文），但 QuickJS 在 guest 侧自己编译，
    // 这里清一次只为让两条基线各自从干净状态起跑。
    clearEjsCompileCache();
    clearEjsBackendCache();
    setEjsBackend(backend);
  });

  afterAll(() => {
    // 🔴 必须还原：`current` 是模块级单例，留着 QuickJS 会把同进程内其余测试文件
    //    （尤其走同步 `renderWorldBookEntries` 的那些）全部推进 fail-closed 分支。
    resetEjsBackend();
    clearEjsCompileCache();
    clearEjsBackendCache();
  });

  it(
    '回退条目集合 == QuickJS 已知白名单（双向闸门）',
    async () => {
      const result = await prerenderWorldBookEntries(entries, {
        stats: makeStats(),
        vars: {},
        historyText: '',
      });

      const byUid = new Map(corpus.map((c) => [c.entry.uid, c]));
      const unexpected = result.fallbackEntries
        .filter((f) => !QUICKJS_KNOWN_FALLBACK_UID_SET.has(f.uid))
        .map(
          (f) => `${byUid.get(f.uid)?.file}#${f.uid} ${byUid.get(f.uid)?.entry.name} :: ${f.error}`,
        );

      expect(unexpected, 'QuickJS 下冒出白名单外的回退 = 隔离后端出现回归').toEqual([]);
      // 反向闸门：白名单条目被修好了也要来删行
      expect(new Set(result.fallbackEntries.map((f) => f.uid))).toEqual(
        QUICKJS_KNOWN_FALLBACK_UID_SET,
      );
    },
    SLOW,
  );

  it(
    '两后端基线只差登记在案的那几条（能力面语义漂移闸门）',
    async () => {
      const quick = await prerenderWorldBookEntries(entries, {
        stats: makeStats(),
        vars: {},
        historyText: '',
      });
      // 临时切回 Legacy 量同一份语料，量完立刻切回来 —— 两条基线用同一批条目、同一份 ctx 形状
      setEjsBackend(new LegacyBackend());
      let legacy;
      try {
        legacy = await prerenderWorldBookEntries(entries, {
          stats: makeStats(),
          vars: {},
          historyText: '',
        });
      } finally {
        setEjsBackend(backend);
      }
      const q = new Set(quick.fallbackEntries.map((f) => f.uid));
      const l = new Set(legacy.fallbackEntries.map((f) => f.uid));
      const diff = new Set([...q, ...l].filter((uid) => q.has(uid) !== l.has(uid)));
      expect(diff, '两后端出现未登记的语义漂移 —— 去两张白名单里对账').toEqual(BACKEND_DIVERGENCE);
    },
    SLOW,
  );

  it(
    'QuickJS 下 EJS 真的求过值（vars 草稿被写 + 静态区无动态残留）',
    async () => {
      const vars: Record<string, any> = {};
      const result = await prerenderWorldBookEntries(entries, {
        stats: makeStats(),
        vars,
        historyText: '',
      });
      // 编组回传不是空转：斯芬克斯信号守卫的初始化必须跨 wasm 边界传回宿主草稿
      expect(vars['事件']?.['信号']).toEqual([]);
      expect(result.staticText).not.toContain('<%');
      expect(result.dynamicText).not.toContain('<%=');
    },
    SLOW,
  );
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
   * 🟢 T5 起 `lastMessageId` 由别名层提供（→ `world.回合`），该条目在**生产 ctx 下直接跑通**，
   * 不再回退。此前它是「白名单回退」的样板，现在是「能力接管」的样板。
   */
  it('生产 ctx 下正常求值（lastMessageId 已由别名层接管）', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const result = renderWorldBookEntries([iceEntry], {
      stats: makeStats({ level: 12 }),
      vars,
      historyText: '',
      capabilities: { turn: 7 },
    });
    expect(result.fallbackEntries).toEqual([]);
    expect(result.dynamicText).not.toBe(iceEntry.content);
    expect(vars['事件']['冰之歌']['触发楼层']).toBe(7);
  });

  /**
   * 条目自身的簿记链：`主角.等级 >= 10` → 首次触发时把 `世界.时间` 写进 vars 草稿。
   * 楼层号经 `capabilities.turn` 供给（别名层把它映射成 `lastMessageId` / `message_id`）。
   */
  it('等级 ≥10 把 世界.时间 写进 事件.冰之歌.触发时间', () => {
    clearEjsCompileCache();
    const vars: Record<string, any> = {};
    const stats = makeStats({ level: 12 });
    const result = renderWorldBookEntries([iceEntry], {
      stats,
      vars,
      historyText: '',
      capabilities: { turn: 7 },
    });

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
