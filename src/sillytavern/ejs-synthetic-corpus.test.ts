/**
 * ejs-synthetic-corpus.test.ts —— 合成语料（设计 §10.5 A/D/E 组）
 *
 * ## 与混淆语料的分工
 * - `ejs-scrambled-corpus.test.ts`：真实条目的**结构**副本 → 测「引擎跑真实形状会怎样」
 * - 本文件：**手写场景** → 测真实语料测不到的东西
 *   - **A 语法覆盖**：按 §9 实测特征表逐项造例（真实语料是混着来的，坏了不知道坏在哪条特征）
 *   - **D 契约不变式**：ADR-30 的读写语义、失败回滚、只读隔离、静动分层
 *   - **E 对抗**：良性内容里 0 命中的危险路径 —— 构造器逃逸、原型污染、环、死循环、
 *     灾难回溯、内存爆炸。**安全闸门只能靠这组。**
 *
 * ## 🔴 E 组的执行约束（改这里前先读）
 * 当前求值后端是 `new Function`：**同步、主线程、不可中断**。死循环 / 灾难回溯 / `repeat(1e9)`
 * 这几例真跑会**挂死测试进程**——vitest 的 timeout 救不了同步无限循环（它没机会调度）。
 *
 * 故这些用例由 `INTERRUPTIBLE_BACKEND` 开关控制，默认 `false` → `it.skip`，
 * 且**跳过理由写进测试名**（不做静默跳过）。文件末尾有一条**元测试**盯着这个开关：
 * 谁把它改成 `true` 而后端还不可中断，元测试就红 —— 防止 CI 被一行手滑永久卡死。
 *
 * 🟢 **QuickJS 后端已落地（T7）**：这三条对抗用例在那边是**真跑**的 ——
 * 见 `ejs-quickjs-backend.test.ts`（死循环 / 灾难回溯 / repeat(1e9) 全部被掐断）。
 * 本文件的开关保持 `false` 是**对的**：这里测的是 Legacy 后端的语义，它本来就不可中断。
 */

import { describe, it, expect } from 'vitest';
import {
  compileEjsEntry,
  executeEjsEntry,
  executeEjsEntryAsync,
  type EjsEvalContext,
} from './ejs-runtime';
import { hasDynamic, renderWorldBookEntries } from './worldbook-loader';
import { diffVars, measureDiffSize, EJS_DIFF_SIZE_LIMIT } from './ejs-vars-diff';
import type { WorldBookEntry } from './types';

// ========== 工具 ==========

function makeCtx(partial: Partial<EjsEvalContext> = {}): EjsEvalContext {
  return {
    stats: partial.stats ?? {},
    vars: partial.vars ?? {},
    historyText: partial.historyText ?? '',
  };
}

function render(content: string, ctx: EjsEvalContext = makeCtx()): string {
  const r = executeEjsEntry(compileEjsEntry(content), ctx);
  if (!r.ok) throw new Error(`预期渲染成功但失败了: ${r.error}`);
  return r.rendered;
}

function tryRender(content: string, ctx: EjsEvalContext = makeCtx()) {
  try {
    return executeEjsEntry(compileEjsEntry(content), ctx);
  } catch (err) {
    return { ok: false as const, error: `COMPILE: ${err instanceof Error ? err.message : err}` };
  }
}

function makeEntry(uid: number, content: string, order = 0): WorldBookEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: `synthetic-${uid}`,
    content,
    constant: true,
    selective: false,
    order,
    position: 'before_char',
    disable: false,
    probability: 100,
  } as unknown as WorldBookEntry;
}

// ═══════════════════════════════════════════════════════════
// A 组 —— 语法覆盖（按 §9 实测特征表逐项）
// ═══════════════════════════════════════════════════════════

describe('A 组 · 语法覆盖', () => {
  it('const/let 声明 + 跨块 if（语料主导模式，86 / 26 条目）', () => {
    const tpl = ['<%_ const lv = 12; if (lv >= 10) { _%>', '达标', '<%_ } _%>'].join('\n');
    expect(render(tpl)).toBe('达标\n');
    const tpl2 = ['<%_ const lv = 3; if (lv >= 10) { _%>', '达标', '<%_ } _%>'].join('\n');
    expect(render(tpl2)).toBe('');
  });

  it('跨块 for 循环', () => {
    const tpl = ['<%_ for (const n of [1, 2, 3]) { _%>', '<%= n %>', '<%_ } _%>'].join('');
    expect(render(tpl)).toBe('123');
  });

  it('while 循环', () => {
    expect(render('<% let i = 0; while (i < 3) i++; %><%= i %>')).toBe('3');
  });

  it('箭头函数 + map/filter/reduce', () => {
    expect(
      render('<%= [1,2,3].map(n => n * 2).filter(n => n > 2).reduce((a, b) => a + b, 0) %>'),
    ).toBe('10');
  });

  it('IIFE（26 条目）', () => {
    expect(render('<%- (function () { return "包起来"; })() %>')).toBe('包起来');
    expect(render('<%- (() => "箭头 IIFE")() %>')).toBe('箭头 IIFE');
  });

  it('模板字符串 + 标签模板（32 / 10 条目）', () => {
    expect(render('<%= `拼${1 + 1}接` %>')).toBe('拼2接');
    expect(render('<%= String.raw`a\\nb` %>')).toBe('a\\nb');
  });

  it('展开运算符（16 条目）', () => {
    expect(render('<%= [...[1,2], ...[3]].join("-") %>')).toBe('1-2-3');
    expect(render('<%= JSON.stringify({ ...{a:1}, b:2 }) %>')).toBe('{"a":1,"b":2}');
  });

  it('可选链（8 条目）', () => {
    const ctx = makeCtx({ vars: { 事件: { 冰之歌: { 阶段: 2 } } } });
    expect(render('<%= vars.事件?.冰之歌?.阶段 %>', ctx)).toBe('2');
    expect(render('<%= vars.不存在?.深?.路径 ?? "兜底" %>', ctx)).toBe('兜底');
  });

  it('计算下标 o[变量]（31 条目 —— 未来 AST 方案要靠 __idx 守卫的那批）', () => {
    const tpl = '<% const k = "乙"; const m = { 乙: "命中" }; %><%= m[k] %>';
    expect(render(tpl)).toBe('命中');
  });

  it('正则字面量含命名捕获组（19 条目）', () => {
    expect(render('<%= /(?<num>\\d+)/.exec("abc42").groups.num %>')).toBe('42');
    expect(render('<%= /^前.+后$/.test("前中后") %>')).toBe('true');
  });

  it('try/catch（5 条目 —— 作者用它做能力探测降级）', () => {
    const tpl = '<% let v; try { v = 不存在的宿主API(); } catch (e) { v = "降级"; } %><%= v %>';
    expect(render(tpl)).toBe('降级');
  });

  it('print() 输出函数（EJS 语言自带，非上游 API）', () => {
    expect(render('<% print("直接推"); %>')).toBe('直接推');
  });

  it('`<%#` 注释整块丢弃', () => {
    expect(render('前<%# 这段不该出现 %>后')).toBe('前后');
  });

  it('`<%%` 字面量 `<%`', () => {
    expect(render('<%%')).toBe('<%');
  });

  it('未闭合 `<%` 降级为文本（不吞内容）', () => {
    expect(render('正文 <% 没闭合')).toBe('正文 <% 没闭合');
  });

  it('await 条目：编译成 AsyncFunction，异步入口可跑', async () => {
    const compiled = compileEjsEntry('<% const v = await 1; %><%= v %>');
    expect(compiled.isAsync).toBe(true);
    const r = await executeEjsEntryAsync(compiled, makeCtx());
    expect(r.ok && r.rendered).toBe('1');
  });

  it('await 条目走同步入口 → 可读失败，不假装成功', () => {
    const r = tryRender('<% const v = await 1; %><%= v %>');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('AsyncEntryError');
  });

  it('文本位出现「await」这个词不触发异步编译（只看代码位）', () => {
    expect(compileEjsEntry('正文里写了 await 两个字<%= 1 %>').isAsync).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// D 组 —— 契约不变式（ADR-30）
// ═══════════════════════════════════════════════════════════

describe('D 组 · 契约不变式', () => {
  it('pass 内：前条目写 → 后条目立即可见（同一 ctx）', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("事件.阶段", 2) %>', ctx);
    expect(render('<%= getMessageVar("stat_data.事件.阶段") %>', ctx)).toBe('2');
  });

  it('读链 stats 优先于 vars（同名时只读面胜出）', () => {
    const ctx = makeCtx({ stats: { 命运点数: 9 }, vars: { 命运点数: 1 } });
    expect(render('<%= getMessageVar("stat_data.命运点数") %>', ctx)).toBe('9');
  });

  it('写永远落 vars，绝不触碰 stats', () => {
    const ctx = makeCtx({ stats: { 主角: { 生命值: 100 } } });
    render('<% setMessageVar("stat_data.主角.生命值", 1) %>', ctx);
    expect(ctx.stats.主角.生命值, 'stats 被写穿了').toBe(100);
    expect(ctx.vars.主角.生命值).toBe(1);
  });

  it('stats 只读隔离：整树读的深改不回流', () => {
    const ctx = makeCtx({ stats: { 主角: { 生命值: 100 } } });
    render('<% const all = getMessageVar("stat_data"); all.主角.生命值 = 999; %>', ctx);
    expect(ctx.stats.主角.生命值).toBe(100);
  });

  it('执行失败 → 该条目对 vars 的半途写入整体回滚，且引用不变', () => {
    const ctx = makeCtx({ vars: { 原有: 1 } });
    const varsRef = ctx.vars;
    const r = tryRender('<% setMessageVar("半途", 1); 不存在(); %>', ctx);
    expect(r.ok).toBe(false);
    expect(ctx.vars, '回滚必须就地进行（调用方持有同一引用）').toBe(varsRef);
    expect(ctx.vars).toEqual({ 原有: 1 });
  });

  it('危险路径段命中 → 整次写入静默拒绝（不做部分写）', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("a.__proto__.polluted", 1) %>', ctx);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ctx.vars.a).toBeUndefined();
  });

  it('自引用草稿（环）不炸：后续条目仍可执行', () => {
    const ctx = makeCtx();
    render('<% vars.self = vars; %>', ctx);
    const r = tryRender('<% setMessageVar("之后", 1) %>', ctx);
    expect(r.ok, '环形草稿让后续条目挂了').toBe(true);
  });

  it('静动分层：无动态特征的条目进静态区且字节稳定', () => {
    const entries = [makeEntry(1, '纯静态正文', 0), makeEntry(2, '<%= 1 + 1 %>', 1)];
    const a = renderWorldBookEntries(entries, makeCtx());
    const b = renderWorldBookEntries(entries, makeCtx());
    expect(a.staticText).toBe('纯静态正文');
    expect(a.staticText).toBe(b.staticText);
    expect(a.dynamicText).toBe('2');
  });

  it('静动分层三根针：`{{random}}` / `{{getvar}}` 也算动态', () => {
    expect(hasDynamic('纯文本')).toBe(false);
    expect(hasDynamic('<% 1 %>')).toBe(true);
    expect(hasDynamic('{{random::a,b}}')).toBe(true);
    expect(hasDynamic('{{getvar::x}}')).toBe(true);
    expect(hasDynamic('{{setvar::x::1}}'), 'setvar 定义是确定性剥离，不算动态').toBe(false);
  });

  it('条目失败 → 原文注入，不中断其余条目', () => {
    const entries = [makeEntry(1, '<% 不存在() %>', 0), makeEntry(2, '<%= "好的" %>', 1)];
    const result = renderWorldBookEntries(entries, makeCtx());
    expect(result.fallbackEntries.map((f) => f.uid)).toEqual([1]);
    expect(result.dynamicText).toContain('<% 不存在() %>');
    expect(result.dynamicText).toContain('好的');
  });

  it('EJS 差量 → VarsPatch：路径带 sys. 前缀，删除也能落到嵌套路径', () => {
    const base = { 事件: { 甲: 1, 乙: 2 } };
    const draft = { 事件: { 甲: 9 }, 新增: true };
    const diff = diffVars(base, draft);
    expect(diff.replace).toContainEqual({ path: 'sys.事件.甲', value: 9 });
    expect(diff.replace).toContainEqual({ path: 'sys.新增', value: true });
    expect(diff.remove).toContainEqual({ path: 'sys.事件.乙' });
  });

  it('差量体积护栏：超限可被检出（整份拒绝的判据）', () => {
    const big = { 大: 'x'.repeat(EJS_DIFF_SIZE_LIMIT + 1024) };
    expect(measureDiffSize(diffVars({}, big))).toBeGreaterThan(EJS_DIFF_SIZE_LIMIT);
    expect(measureDiffSize(diffVars({}, { 小: 1 }))).toBeLessThan(EJS_DIFF_SIZE_LIMIT);
  });

  it('代码位 ST 值宏改写：`{{roll}}` 可参与运算，文本位的宏原样留给下游', () => {
    expect(render('<%_ if ({{roll 1d100}} >= 1) { _%>命中<%_ } _%>')).toBe('命中');
    const passthrough = '{{user}} 掷了 {{roll 1d6}} 点';
    expect(render(passthrough)).toBe(passthrough);
  });
});

// ═══════════════════════════════════════════════════════════
// E 组 —— 对抗（真实语料 0 命中，安全闸门只能靠这组）
// ═══════════════════════════════════════════════════════════

/**
 * 🔴 当前后端（`new Function`）**不可中断**：同步死循环会挂死测试进程。
 * QuickJS 后端（§0.1 / T7）落地后翻 true，并同步修改文件末尾的元测试。
 */
const INTERRUPTIBLE_BACKEND = false;
const whenInterruptible = INTERRUPTIBLE_BACKEND ? it : it.skip;

describe('E 组 · 对抗', () => {
  it('🔴 Legacy 后端的已知洞：构造器逃逸拿得到真全局（SEC-02）', () => {
    // 断言的是 **Legacy 后端的当前事实**，不是期望行为 —— 参数遮蔽不是安全边界。
    // 🟢 生产已切 QuickJS（T7/T8），那边这条路是堵死的：
    //    `ejs-quickjs-backend.test.ts` 断言 `typeof …globalThis().fetch === 'undefined'`。
    // 本用例存在的意义是**钉住两个后端的差异**：谁哪天把生产切回 Legacy，就等于把这个洞放回来。
    const r = tryRender('<%= typeof stats.constructor.constructor("return globalThis")() %>');
    expect(r.ok).toBe(true);
    expect(
      r.ok && r.rendered,
      'Legacy 后端的逃逸被堵住了？—— 那说明沙盒模型变了，请同步更新 SEC-02 状态与本用例',
    ).toBe('object');
  });

  it('原型污染：经 setMessageVar 路径写 __proto__ 被拒', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("__proto__.polluted", 1) %>', ctx);
    render('<% setvar("constructor.polluted", 1) %>', ctx);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('原型污染：经差量出境时被剔除（vars → VarsPatch 那一段）', () => {
    const draft = JSON.parse('{"正常":1,"__proto__":{"polluted":true}}');
    const diff = diffVars({}, draft);
    expect(diff.replace.map((r) => r.path)).toEqual(['sys.正常']);
  });

  it('深递归爆栈被 catch 成条目级失败，不抛穿', () => {
    const r = tryRender('<% const f = (n) => f(n + 1); f(0); %>');
    expect(r.ok).toBe(false);
  });

  it('抛出物不可字符串化时也不抛穿（describeError 兜底）', () => {
    const r = tryRender('<% throw { get message() { throw 1; }, name: "X" } %>');
    expect(r.ok).toBe(false);
  });

  it('超大输出可被测量（pass 级输出预算的判据）', () => {
    const r = tryRender('<%= "x".repeat(300 * 1024) %>');
    expect(r.ok).toBe(true);
    expect(r.ok && r.rendered.length).toBeGreaterThan(256 * 1024);
  });

  whenInterruptible('[需可中断后端] 同步死循环被执行预算掐断', () => {
    const r = tryRender('<% while (true) {} %>');
    expect(r.ok).toBe(false);
  });

  whenInterruptible(
    '[需可中断后端] 灾难性正则回溯被掐断（单表达式，无循环 → AST tick 堵不住）',
    () => {
      const r = tryRender('<%= /(a+)+b/.test("a".repeat(40)) %>');
      expect(r.ok).toBe(false);
    },
  );

  whenInterruptible('[需可中断后端] 超大分配被内存上限拒绝', () => {
    const r = tryRender('<%= "x".repeat(1e9).length %>');
    expect(r.ok).toBe(false);
  });

  it('元测试：不可中断后端下，危险用例必须处于禁用状态', () => {
    // 这条是 CI 的保险丝。把 INTERRUPTIBLE_BACKEND 翻 true 而后端仍是 `new Function`，
    // 上面三条会真跑 → 测试进程永久挂死。本断言让「翻开关」这个动作必须连同本用例一起改，
    // 逼改的人回来读文件头那段约束。
    expect(
      INTERRUPTIBLE_BACKEND,
      '翻开关前请确认求值后端已可中断（QuickJS，设计 §0.1 / 切片 T7），并同步修改本用例',
    ).toBe(false);
  });
});
