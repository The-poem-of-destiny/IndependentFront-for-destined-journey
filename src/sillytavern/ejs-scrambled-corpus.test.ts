/**
 * ejs-scrambled-corpus.test.ts —— 混淆真实语料回归闸门（设计 §10.5）
 *
 * ## 这是什么
 * `tests/fixtures/ejs-scrambled-corpus.json` 是**真实世界书 EJS 条目的结构副本**：
 * 由 `scripts/scramble-worldbook-ejs.mjs` 把正文换成填充串、代码区 CJK 与 ASCII 标识符
 * 一致混淆而来。**不含任何可读的世界观内容**，但语法结构、控制流、API 调用点、
 * 读写链一字未改（生成器带自检闸门：混淆前后编译结果必须逐条一致，不一致拒绝写出）。
 *
 * ## 为什么不直接放真实语料
 * 4.4 MB 正文进 git（体积 + 内容授权协议），且真实语料是良性内容——
 * `.constructor` 0 次、死循环 0 次，**测不到危险路径**。危险路径归合成语料
 * （`ejs-synthetic-corpus.test.ts` E 组）。两者互补，都在 CI 跑，**零人工**。
 *
 * ## 闸门形态
 * 与 `worldbook-ejs-corpus.test.ts` 同款「已知回退白名单」：
 * 白名单外冒出新回退 = 本次改动引入回归，红；白名单里的条目被修好了（不再回退）
 * 也红——提醒来删行。**双向闸门**，防的是「悄悄变好」与「悄悄变坏」两头。
 *
 * ## 刷新夹具
 * ```
 * node scripts/scramble-worldbook-ejs.mjs --seed 20260801 \
 *   --src "<ST>/data/default-user/worlds/命定之诗与黄昏之歌v4.2.json,...(另两本)"
 * ```
 * 刷新后基线大概率变动——逐条确认是**语料变了**而不是**引擎坏了**，再更新本文件白名单。
 */

import { describe, it, expect } from 'vitest';
import { compileEjsEntry, executeEjsEntry, type EjsEvalContext } from './ejs-runtime';
import { hasDynamic, prerenderWorldBookEntries, renderWorldBookEntries } from './worldbook-loader';
import type { WorldBookEntry } from './types';

// ========== 夹具 ==========

interface ScrambledEntry {
  id: string;
  blocks: number;
  features: string[];
  content: string;
}
interface ScrambledFragment {
  feature: string;
  from: string;
  code: string;
  /** 含 `await` —— 结构自足，但今天的引擎用 `new Function`（非 async）编译不过。T1 落地后转绿 */
  needsAsync?: boolean;
}
interface Fixture {
  seed: number;
  stats: Record<string, number>;
  entries: ScrambledEntry[];
  fragments: ScrambledFragment[];
}

/**
 * 夹具用 Vite 的 `import.meta.glob(..., { query: '?raw' })` 取，**不用 node 的 fs/path** ——
 * 仓库没装 `@types/node`，`src/**` 下 `import 'node:fs'` 会让裸 tsc 报 TS2307
 * （口径同 `worldbook-ejs-corpus.test.ts`）。
 */
const RAW_FIXTURE = import.meta.glob('../../tests/fixtures/ejs-scrambled-corpus.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FIXTURE: Fixture = JSON.parse(Object.values(RAW_FIXTURE)[0]);

// ========== 求值上下文 ==========

/**
 * 混淆后的中文键与真实键无关，所以 stats 给什么内容都不影响闸门 ——
 * 闸门测的是「引擎跑真实**结构**时的成败分布」，不是数值正确性（那归合成语料 B 组）。
 * 这里给一棵最小骨架，形状对齐 `buildStatData` 的产物。
 */
function makeCtx(): EjsEvalContext {
  return {
    stats: {
      主角: {
        生命值: 100,
        生命值上限: 100,
        等级: 12,
        生命层级: '精英',
        属性: { 力量: 8, 敏捷: 7, 体质: 9, 智力: 6, 精神: 5, 属性点: 0 },
      },
      命运点数: 3,
      世界: { 时间: '复兴纪元001年-05月-24日-周日-15:30' },
    },
    vars: {},
    historyText: '玩家在咖啡馆里坐下，点了一杯热可可。',
  };
}

/** 编译 + 执行，返回状态分类（不比对输出字节——语料含随机） */
type Outcome =
  | { kind: 'ok'; rendered: string }
  | { kind: 'compile-error'; error: string }
  | { kind: 'exec-error'; error: string };

function runEntry(content: string, ctx: EjsEvalContext): Outcome {
  let compiled;
  try {
    compiled = compileEjsEntry(content);
  } catch (err) {
    return { kind: 'compile-error', error: err instanceof Error ? err.name : String(err) };
  }
  const result = executeEjsEntry(compiled, ctx);
  return result.ok
    ? { kind: 'ok', rendered: result.rendered }
    : { kind: 'exec-error', error: result.error.split(':')[0] };
}

// ========== 已知回退白名单（双向闸门）==========

/**
 * 混淆语料里注定回退的条目。原因分类见设计 §4 降级清单与 §3 能力面缺口 ——
 * 每一条都对应一个**尚未实现的能力**，实现后这里要删行（反向闸门会提醒）。
 */
const KNOWN_FALLBACKS: ReadonlyArray<{ id: string; why: string; fixedBy: string }> = [
  // —— 语言/顺序层面的**设计内**回退 ——
  // ST 宏嵌在代码位：`rewriteCodeMacros` 只降 `{{roll}}` / `{{random::}}` 这类**自足值宏**。
  // 这两条嵌的是 `{{setvar::}}` / `{{getvar::}}`——取值依赖宏链的 setvar 表，求值时机不安全，
  // **刻意不改写**（§5 别名层不承接口径）。属于设计内，不修。
  // （原第三条 wb5i#445536 嵌的是 `{{roll}}` —— 自足值宏，已由 rewriteCodeMacros 接住，出列。）
  { id: 'wb5i#131496', why: "宏嵌代码位 → Unexpected token '{'", fixedBy: '不修（设计内）' },
  { id: 'wb5i#674588', why: "宏嵌代码位 → Unexpected token '{'", fixedBy: '不修（设计内）' },

  // —— 同步入口吃不下 async 条目（生产走异步预渲染，那条路它们是通的）——
  // 本闸门跑的是**同步** runEntry，故这三条在此表内；「异步预渲染」describe 另有断言证明它们能跑。
  { id: 'wb5i#37830', why: 'AsyncEntryError（同步入口）', fixedBy: 'T1 异步预渲染路径已可跑' },
  { id: 'wb5i#525037', why: 'AsyncEntryError（同步入口）', fixedBy: 'T1 异步预渲染路径已可跑' },
  { id: 'wb5i#969626', why: 'AsyncEntryError（同步入口）', fixedBy: 'T1 异步预渲染路径已可跑' },
];

const KNOWN_FALLBACK_IDS = new Set(KNOWN_FALLBACKS.map((x) => x.id));

// ═══════════════════════════════════════════════════════════
// 夹具自身的完整性
// ═══════════════════════════════════════════════════════════

describe('混淆语料夹具', () => {
  it('非空、id 唯一（白名单按 id 索引的前提）', () => {
    expect(FIXTURE.entries.length).toBeGreaterThan(50);
    const ids = FIXTURE.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条都真的含 EJS 块', () => {
    for (const e of FIXTURE.entries) {
      expect(e.content).toContain('<%');
      expect(e.blocks).toBeGreaterThan(0);
    }
  });

  it('覆盖到关键语法与 API 特征（混淆没把结构洗掉）', () => {
    const seen = new Set(FIXTURE.entries.flatMap((e) => e.features));
    for (const must of [
      '跨块控制流',
      'await',
      'IIFE',
      '模板串',
      '可选链',
      '计算下标',
      'try/catch',
      'lodash',
      'getMessageVar',
      'setMessageVar',
      'getvar/setvar',
      'LocalVar',
      'matchChatMessages',
      '宏内嵌代码位',
    ]) {
      expect(seen, `特征「${must}」应在语料中出现`).toContain(must);
    }
  });

  it('不含可读的世界观正文（混淆有效性抽查）', () => {
    // 生成器把正文换成填充池字符；这些真实专有名词不该出现在任何位置
    const leaks = ['命定之诗', '艾莉亚', '卡米拉', '莉莉娅丝', '奥古斯提姆', '时间之门'];
    const all = FIXTURE.entries.map((e) => e.content).join('\n');
    for (const word of leaks) {
      expect(all, `混淆后不应出现「${word}」`).not.toContain(word);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 回归闸门
// ═══════════════════════════════════════════════════════════

describe('混淆语料 × 引擎 —— 回归闸门', () => {
  it('全量执行不抛穿（executeEjsEntry 永不外抛的契约）', () => {
    const ctx = makeCtx();
    for (const entry of FIXTURE.entries) {
      expect(() => runEntry(entry.content, ctx), `条目 ${entry.id} 抛穿了`).not.toThrow();
    }
  });

  it('回退集合 == 已知白名单（双向闸门）', () => {
    const fallbacks: string[] = [];
    for (const entry of FIXTURE.entries) {
      const ctx = makeCtx();
      const outcome = runEntry(entry.content, ctx);
      if (outcome.kind !== 'ok') fallbacks.push(entry.id);
    }

    const unexpected = fallbacks.filter((id) => !KNOWN_FALLBACK_IDS.has(id));
    expect(
      unexpected,
      `白名单外的新回退 = 引入了回归。若确属预期，来 KNOWN_FALLBACKS 补行并写明原因`,
    ).toEqual([]);

    // 反向：白名单条目被修好了 → 提醒删行
    expect(
      new Set(fallbacks),
      '白名单里有条目已不再回退（多半是新能力上线了）—— 来 KNOWN_FALLBACKS 删行',
    ).toEqual(KNOWN_FALLBACK_IDS);
  });

  it('成功条目的渲染结果不残留未求值的 `<%` 块', () => {
    for (const entry of FIXTURE.entries) {
      if (KNOWN_FALLBACK_IDS.has(entry.id)) continue;
      const outcome = runEntry(entry.content, makeCtx());
      if (outcome.kind !== 'ok') continue;
      expect(outcome.rendered, `${entry.id} 残留 EJS 块`).not.toMatch(/<%[^%]/);
    }
  });

  it('执行失败的条目对 vars 草稿零残留（条目级写回滚）', () => {
    for (const { id } of KNOWN_FALLBACKS) {
      const entry = FIXTURE.entries.find((e) => e.id === id);
      if (!entry) continue;
      const ctx = makeCtx();
      const before = JSON.stringify(ctx.vars);
      const outcome = runEntry(entry.content, ctx);
      if (outcome.kind === 'exec-error') {
        expect(JSON.stringify(ctx.vars), `${id} 失败后留下了半途写入`).toBe(before);
      }
    }
  });

  it('全部条目都被 hasDynamic 判为动态（含 `<%` 即动态，静态区不该混进来）', () => {
    for (const entry of FIXTURE.entries) {
      expect(hasDynamic(entry.content), `${entry.id} 应判为动态`).toBe(true);
    }
  });

  it('同一条目重复执行状态稳定（不因内部随机而在成功/失败间摇摆）', () => {
    for (const entry of FIXTURE.entries) {
      const a = runEntry(entry.content, makeCtx()).kind;
      const b = runEntry(entry.content, makeCtx()).kind;
      expect(b, `${entry.id} 两次执行状态不一致`).toBe(a);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 片段补充用例（真实条目切出来的最小编译单元）
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 异步预渲染路径（生产装配走这条）
// ═══════════════════════════════════════════════════════════

describe('异步预渲染 × 混淆语料', () => {
  /** 把整份语料当一个装配 pass 交给后端 */
  async function runPass() {
    const entries = FIXTURE.entries.map(
      (e, i) => ({ uid: i + 1, content: e.content, order: i }) as unknown as WorldBookEntry,
    );
    return prerenderWorldBookEntries(entries, makeCtx());
  }

  it('await 条目在异步路径下不再回退（T1 的全部意义）', async () => {
    const asyncIds = new Set(
      FIXTURE.entries
        .map((e, i) => ({ i: i + 1, isAsync: e.features.includes('await') }))
        .filter((x) => x.isAsync)
        .map((x) => x.i),
    );
    expect(asyncIds.size, '语料应含 await 条目').toBeGreaterThan(0);

    const result = await runPass();
    const fallbackIds = new Set(result.fallbackEntries.map((f) => f.uid));
    for (const id of asyncIds) {
      const reason = result.fallbackEntries.find((f) => f.uid === id)?.error ?? '';
      // await 本身不再是回退原因；这些条目可能仍因缺 getwi/TavernHelper 而回退，
      // 但错误必须**不是** AsyncEntryError / SyntaxError(await)
      if (fallbackIds.has(id)) {
        expect(reason, `uid=${id} 仍因 await 回退`).not.toMatch(/AsyncEntryError|await is only/);
      }
    }
  });

  it('异步路径的回退数 ≤ 同步路径（能力只增不减）', async () => {
    const asyncResult = await runPass();
    expect(asyncResult.fallbackEntries.length).toBeLessThanOrEqual(KNOWN_FALLBACKS.length);
  });

  it('静态区与同步路径逐字节一致（分层逻辑没有第二套）', async () => {
    const entries = FIXTURE.entries.map(
      (e, i) => ({ uid: i + 1, content: e.content, order: i }) as unknown as WorldBookEntry,
    );
    const asyncResult = await prerenderWorldBookEntries(entries, makeCtx());
    const syncResult = renderWorldBookEntries(entries, makeCtx());
    expect(asyncResult.staticText).toBe(syncResult.staticText);
  });
});

describe('真实片段补充用例', () => {
  it('片段集非空且带特征标签', () => {
    expect(FIXTURE.fragments.length).toBeGreaterThan(10);
    for (const f of FIXTURE.fragments) {
      expect(f.feature).toBeTruthy();
      expect(f.code).toContain('<%');
    }
  });

  it('非 await 片段全部可编译（未注入的 API 是运行期 ReferenceError，不是语法错）', () => {
    const broken: string[] = [];
    for (const f of FIXTURE.fragments) {
      if (f.needsAsync) continue;
      try {
        compileEjsEntry(f.code);
      } catch {
        broken.push(`${f.feature}@${f.from}`);
      }
    }
    expect(broken, '片段应全部可编译').toEqual([]);
  });

  it('await 片段编译成 AsyncFunction（T1 落地后转绿）', () => {
    const asyncFrags = FIXTURE.fragments.filter((f) => f.needsAsync);
    expect(asyncFrags.length, '语料含 await，夹具应抽到 await 片段').toBeGreaterThan(0);
    for (const f of asyncFrags) {
      const compiled = compileEjsEntry(f.code);
      expect(compiled.isAsync, `${f.feature}@${f.from} 应被判为 async 条目`).toBe(true);
    }
  });

  it('await 片段走同步入口时给可读失败（不假装成功）', () => {
    for (const f of FIXTURE.fragments.filter((x) => x.needsAsync)) {
      const r = executeEjsEntry(compileEjsEntry(f.code), makeCtx());
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('AsyncEntryError');
    }
  });

  it('片段执行不抛穿', () => {
    for (const f of FIXTURE.fragments) {
      const ctx = makeCtx();
      expect(() => runEntry(f.code, ctx), `片段 ${f.feature}@${f.from} 抛穿`).not.toThrow();
    }
  });
});
