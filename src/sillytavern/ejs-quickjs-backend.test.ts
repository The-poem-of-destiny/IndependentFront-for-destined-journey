/**
 * ejs-quickjs-backend.ts 测试 —— 隔离后端（能力面 §0.1 / 切片 T7）
 *
 * ## 这个文件的重点是**安全属性**，不是渲染正确性
 * 渲染正确性由合成语料 A/D 组与混淆语料在 Legacy 后端上测（快、无 wasm 成本）。
 * 这里只回答一个问题：**换到 QuickJS 之后，SEC-02 的四条攻击是不是真的堵住了**。
 *
 * 实测基线（quickjs-emscripten 0.32，2026-08-01）：
 * - 构造器逃逸 → 拿到 guest 自己的全局，`fetch` 为 `undefined`
 * - 死循环 → interrupt 掐断
 * - 灾难性正则回溯 → interrupt 掐断（**AST 方案结构性做不到**）
 * - `"x".repeat(1e9)` → 内存上限拒绝
 *
 * ⚠️ 本文件会真加载 wasm，比其余测试慢一个量级 —— 故只放**必须真跑**的用例。
 */

import { describe, it, expect } from 'vitest';
import { createQuickJsBackend, DEFAULT_QUICKJS_BUDGET } from './ejs-quickjs-backend';
import type { EjsEvalContext } from './ejs-runtime';

function makeCtx(partial: Partial<EjsEvalContext> = {}): EjsEvalContext {
  return {
    stats: partial.stats ?? {},
    vars: partial.vars ?? {},
    historyText: partial.historyText ?? '',
    ...(partial.seed !== undefined ? { seed: partial.seed } : {}),
    ...(partial.capabilities !== undefined ? { capabilities: partial.capabilities } : {}),
  };
}

const backend = createQuickJsBackend();
/** wasm 首次装载有开销，给宽裕的超时 */
const SLOW = 30_000;

async function render(content: string, ctx: EjsEvalContext = makeCtx()) {
  const [outcome] = await backend.runPass([{ uid: 1, content }], ctx);
  return outcome;
}

// ═══════════════════════════════════════════════════════════
// 基础可用性
// ═══════════════════════════════════════════════════════════

describe('QuickJS 后端 · 基础', () => {
  it(
    '声明自己可中断（对抗用例据此决定是否真跑）',
    () => {
      expect(backend.name).toContain('quickjs');
      expect(backend.interruptible).toBe(true);
    },
    SLOW,
  );

  it(
    '文本 + 表达式 + 跨块控制流',
    async () => {
      expect((await render('纯文本')).text).toBe('纯文本');
      expect((await render('<%= 1 + 2 %>')).text).toBe('3');
      const tpl = '<%_ if (stats.主角.等级 >= 10) { _%>达标<%_ } _%>';
      expect((await render(tpl, makeCtx({ stats: { 主角: { 等级: 12 } } }))).text).toBe('达标');
      expect((await render(tpl, makeCtx({ stats: { 主角: { 等级: 3 } } }))).text).toBe('');
    },
    SLOW,
  );

  it(
    'pass 内前条目写 → 后条目立即可见（草稿留在 guest 内演化）',
    async () => {
      const ctx = makeCtx();
      const outcomes = await backend.runPass(
        [
          { uid: 1, content: '<% vars.计数 = 7 %>' },
          { uid: 2, content: '<%= vars.计数 %>' },
        ],
        ctx,
      );
      expect(outcomes[1].text).toBe('7');
      // pass 结束整体回传，宿主草稿拿到最终态
      expect(ctx.vars.计数).toBe(7);
    },
    SLOW,
  );

  it(
    '单条目失败不影响其余（D8 条目级隔离）',
    async () => {
      const outcomes = await backend.runPass(
        [
          { uid: 1, content: '<% 不存在的符号() %>' },
          { uid: 2, content: '<%= "好的" %>' },
        ],
        makeCtx(),
      );
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].text).toBe('<% 不存在的符号() %>'); // 原文注入
      expect(outcomes[1].ok).toBe(true);
      expect(outcomes[1].text).toBe('好的');
    },
    SLOW,
  );
});

// ═══════════════════════════════════════════════════════════
// 🔒 SEC-02 四条攻击
// ═══════════════════════════════════════════════════════════

describe('QuickJS 后端 · 安全属性（SEC-02）', () => {
  it(
    '构造器逃逸拿不到宿主全局 —— 这是换后端的**全部理由**',
    async () => {
      const r = await render('<%= typeof Object.constructor("return globalThis")().fetch %>');
      expect(r.ok).toBe(true);
      // guest realm 里也有 globalThis，但那是 **guest 自己的**：没有 fetch / localStorage / document
      expect(r.text).toBe('undefined');

      // ⚠️ `localStorage` **不在这张表里**，因为别名层刻意用同名 shim 占了这个位置（§5）。
      // 它的安全性由下一个用例单独证明：占位的是映射到 local 的 shim，不是宿主那个。
      for (const probe of ['fetch', 'document', 'XMLHttpRequest', 'indexedDB']) {
        const out = await render(
          `<%= typeof (({}).constructor.constructor("return globalThis")())["${probe}"] %>`,
        );
        expect(out.text, `${probe} 不该可达`).toBe('undefined');
      }
    },
    SLOW,
  );

  it(
    'localStorage 这个名字被 shim 占着 —— 拿到的不是宿主那个（API Key 就躺在宿主那个里）',
    async () => {
      const ctx = makeCtx({ capabilities: { projectId: 'p1' } });
      // 只有三个方法，没有 length / key / clear —— 真 Storage 一定有
      expect((await render('<%= typeof localStorage.length %>', ctx)).text).toBe('undefined');
      expect((await render('<%= typeof localStorage.clear %>', ctx)).text).toBe('undefined');
      // 读任何键都拿不到宿主的值
      expect((await render('<%= String(localStorage.getItem("apiKey")) %>', ctx)).text).toBe(
        'null',
      );
      // 写进去的东西落在项目私有 local 命名空间，不是宿主 Storage
      await backend.runPass([{ uid: 1, content: '<% localStorage.setItem("k", "v") %>' }], ctx);
      expect(ctx.vars._local?.p1?.k).toBe('v');
    },
    SLOW,
  );

  it(
    '死循环被 interrupt 掐断（Legacy 后端下这会挂死进程）',
    async () => {
      const r = await render('<% while (true) {} %>');
      expect(r.ok).toBe(false);
      expect(r.text).toContain('while (true)'); // 回退原文
    },
    SLOW,
  );

  it(
    '灾难性正则回溯被掐断 —— AST 方案结构性做不到（单表达式无循环）',
    async () => {
      const r = await render('<%= /(a+)+b/.test("' + 'a'.repeat(40) + '") %>');
      expect(r.ok).toBe(false);
    },
    SLOW,
  );

  it(
    '超大分配被内存上限拒绝',
    async () => {
      const r = await render('<%= "x".repeat(1e9).length %>');
      expect(r.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'pass 天花板：预算耗尽后剩余条目一律回退（DoS 防线）',
    async () => {
      const tiny = createQuickJsBackend({ budget: { passTimeoutMs: 1, entryTimeoutMs: 1 } });
      const outcomes = await tiny.runPass(
        Array.from({ length: 5 }, (_, i) => ({ uid: i + 1, content: '<% while (true) {} %>' })),
        makeCtx(),
      );
      expect(outcomes).toHaveLength(5);
      expect(outcomes.every((o) => !o.ok)).toBe(true);
      expect(outcomes.some((o) => (o.error ?? '').includes('pass 执行预算'))).toBe(true);
    },
    SLOW,
  );

  it('预算默认值符合 §6.2', () => {
    expect(DEFAULT_QUICKJS_BUDGET.entryTimeoutMs).toBe(50);
    expect(DEFAULT_QUICKJS_BUDGET.passTimeoutMs).toBe(1500);
    expect(DEFAULT_QUICKJS_BUDGET.memoryLimitBytes).toBe(64 * 1024 * 1024);
  });
});

// ═══════════════════════════════════════════════════════════
// 能力面在 guest 侧可用
// ═══════════════════════════════════════════════════════════

describe('QuickJS 后端 · 能力面', () => {
  it(
    '数据轴：stats / vars / world / engine',
    async () => {
      const ctx = makeCtx({
        stats: { 主角: { 生命值: 71 } },
        vars: { 事件: { 阶段: 2 } },
        capabilities: { turn: 9 },
      });
      expect((await render('<%= stats.主角.生命值 %>', ctx)).text).toBe('71');
      expect((await render('<%= vars.事件.阶段 %>', ctx)).text).toBe('2');
      expect((await render('<%= world.回合 %>', ctx)).text).toBe('9');
      expect((await render('<%= engine.name %>', ctx)).text).toBe('poem-of-destiny');
      expect((await render('<%= engine.has("lore.get") %>', ctx)).text).toBe('true');
    },
    SLOW,
  );

  it(
    '宿主查询：chat / char / quest / lore 经桥接同步返回',
    async () => {
      const ctx = makeCtx({
        capabilities: {
          history: [
            { role: 'user', content: '我去咖啡馆' },
            { role: 'assistant', content: '你推开门' },
          ],
          quests: { 寻琴: { status: '进行中' } } as never,
          lore: { get: (n) => (n === '设计' ? '设计正文' : null), list: () => ['设计'] },
        },
        historyText: '我去咖啡馆\n你推开门',
      });
      expect((await render('<%= chat.last("user") %>', ctx)).text).toBe('我去咖啡馆');
      expect((await render('<%= chat.match("咖啡馆") %>', ctx)).text).toBe('true');
      expect((await render('<%= quest.has("寻琴") %>', ctx)).text).toBe('true');
      expect((await render('<%= lore.get("设计") %>', ctx)).text).toBe('设计正文');
    },
    SLOW,
  );

  it(
    'fmt / rng / _ 在 guest 侧可用',
    async () => {
      const ctx = makeCtx({ seed: 'save-1#3' });
      expect((await render('<%= fmt.num(1234567) %>', ctx)).text).toBe('1,234,567');
      expect((await render('<%= fmt.yaml({ a: 1 }) %>', ctx)).text).toBe('a: 1');
      expect((await render('<%= _.size([1,2,3]) %>', ctx)).text).toBe('3');
      // 吃回调的 lodash 在 guest 侧实现（跨边界传函数不可行）
      expect(
        (await render('<%= JSON.stringify(_.mapValues({a:1}, v => v * 2)) %>', ctx)).text,
      ).toBe('{"a":2}');
      const roll = Number((await render('<%= rng.roll("1d6") %>', ctx)).text);
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    },
    SLOW,
  );

  it(
    'local 写回宿主草稿（唯一的持久写口之一）',
    async () => {
      const ctx = makeCtx({ capabilities: { projectId: 'p1' } });
      await backend.runPass([{ uid: 1, content: '<% local.set("k", "v") %>' }], ctx);
      // guest 侧 local 经桥接直接写宿主 caps，故宿主 vars 立即可见
      expect(ctx.vars._local?.p1?.k).toBe('v');
    },
    SLOW,
  );

  it(
    'ui.notify 经桥接到宿主出口，且受限频约束',
    async () => {
      const seen: string[] = [];
      const ctx = makeCtx({ capabilities: { notify: (m) => seen.push(m) } });
      await render(
        '<% ui.notify("一"); ui.notify("一"); ui.notify("二"); ui.notify("三"); ui.notify("四") %>',
        ctx,
      );
      expect(seen).toEqual(['一', '二', '三']);
    },
    SLOW,
  );
});
