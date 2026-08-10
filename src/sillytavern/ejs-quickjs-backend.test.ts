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
    // 5s：实测全语料单 pass 348-583ms，留约 10 倍余量（原 1500ms 只有 3 倍，是拍的）
    expect(DEFAULT_QUICKJS_BUDGET.passTimeoutMs).toBe(5000);
    expect(DEFAULT_QUICKJS_BUDGET.memoryLimitBytes).toBe(64 * 1024 * 1024);
  });
});

// ═══════════════════════════════════════════════════════════
// 🔒 回归：interrupt 的两个「没装上」的窗口
// ═══════════════════════════════════════════════════════════

describe('QuickJS 后端 · interrupt 覆盖面', () => {
  it(
    'guest 种下死循环 `vars.toJSON` —— 快照与回传都被掐住，runPass 按时返回',
    async () => {
      // 快照那句是 `JSON.stringify(globalThis.vars)`，会调用 guest 自己种的 toJSON。
      // 曾经 interrupt 只装在条目正文那一段：快照在装它**之前**跑、回传在摘掉它**之后**跑，
      // 于是这两个窗口里死循环能永久冻住主线程 —— 「可中断」在那里整个是假的。
      const tiny = createQuickJsBackend({ budget: { entryTimeoutMs: 50, passTimeoutMs: 3000 } });
      const ctx = makeCtx();
      const started = Date.now();
      const outcomes = await tiny.runPass(
        [
          { uid: 1, content: '<% vars.toJSON = function () { while (true) {} } %>' },
          { uid: 2, content: '之后的正常条目' },
        ],
        ctx,
      );
      // 最要紧的断言是「它返回了」——修之前这里永久挂死，vitest 的超时都收不掉主线程。
      // 时限也是断言的一部分：两个窗口各被 entryTimeoutMs 兜住，量级就是几十毫秒。
      expect(Date.now() - started).toBeLessThan(5000);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].ok).toBe(true); // 种毒的那条自己是「成功」的
      // 后续条目照跑（只是丢了快照能力，D8 的回滚保证降级为「不回滚」）
      expect(outcomes[1].text).toBe('之后的正常条目');
      // 🔴 回传被掐 → 草稿保持 pass 开始的样子，不半写。
      //    这一条同时证明 readBackVars 那段真的装了 interrupt：没装就是永久冻结。
      expect(ctx.vars).toEqual({});
    },
    SLOW,
  );
});

// ═══════════════════════════════════════════════════════════
// 🔒 回归：runPass 永不抛 + 微任务泵的返回值
// ═══════════════════════════════════════════════════════════

/**
 * 造一个够跑完一趟 pass 的**假模块**（完全不碰 wasm）。
 * 专门用来打桩那些真模块里很难触发的边界：建 runtime/context 失败、`executePendingJobs` 的返回形状。
 *
 * `dump` 恒返回 `'0'` → `__ejsState` 永远是 0 → 条目永远「未落定」，pump 与 drain 两条路径都会走到。
 */
function makeFakeModule(
  options: {
    onNewRuntime?: () => void;
    onNewContext?: () => void;
    pendingJobs?: () => unknown;
  } = {},
) {
  const stats = { pumpCalls: 0, runtimeDisposed: 0, contextDisposed: 0 };
  const handle = () => ({ dispose: () => {} });
  const context = {
    evalCode: () => ({ value: handle() }),
    unwrapResult: (r: { value?: unknown }) => r.value,
    dump: () => '0',
    newFunction: () => handle(),
    newString: () => handle(),
    setProp: () => {},
    getProp: () => handle(),
    global: {},
    undefined: {},
    dispose: () => {
      stats.contextDisposed++;
    },
  };
  const runtime = {
    setMemoryLimit: () => {},
    setMaxStackSize: () => {},
    setInterruptHandler: () => {},
    removeInterruptHandler: () => {},
    newContext: () => {
      options.onNewContext?.();
      return context;
    },
    executePendingJobs: () => {
      stats.pumpCalls++;
      return options.pendingJobs?.() as never;
    },
    dispose: () => {
      stats.runtimeDisposed++;
    },
  };
  const module = {
    newRuntime: () => {
      options.onNewRuntime?.();
      return runtime;
    },
  };
  return { stats, loadModule: async () => module };
}

describe('QuickJS 后端 · runPass 永不抛（契约）', () => {
  it('newRuntime 抛 → 整 pass 回退原文，不抛穿', async () => {
    const fake = makeFakeModule({
      onNewRuntime: () => {
        throw new Error('模拟 newRuntime 失败');
      },
    });
    const b = createQuickJsBackend({ loadModule: fake.loadModule });
    const outcomes = await b.runPass(
      [
        { uid: 1, content: '<%= 1 + 1 %>' },
        { uid: 2, content: '文本' },
      ],
      makeCtx(),
    );
    expect(outcomes.map((o) => o.ok)).toEqual([false, false]);
    expect(outcomes.map((o) => o.text)).toEqual(['<%= 1 + 1 %>', '文本']);
    expect(outcomes[0].error).toContain('运行时创建失败');
  });

  it('newContext 抛 → 回退原文，且**已建起来的 runtime 被放掉**（否则漏一个 wasm 实例）', async () => {
    const fake = makeFakeModule({
      onNewContext: () => {
        throw new Error('模拟 newContext 失败');
      },
    });
    const b = createQuickJsBackend({ loadModule: fake.loadModule });
    const outcomes = await b.runPass([{ uid: 1, content: '<%= 1 %>' }], makeCtx());
    expect(outcomes[0]).toMatchObject({ ok: false, text: '<%= 1 %>' });
    expect(outcomes[0].error).toContain('上下文创建失败');
    expect(fake.stats.runtimeDisposed).toBe(1);
  });
});

describe('QuickJS 后端 · executePendingJobs 返回的是 DisposableResult 不是 number', () => {
  it('成功分支 `{ value: 0 }` → 「队列已空」早退真的触发（曾经恒不成立，空转满 64 轮）', async () => {
    const fake = makeFakeModule({ pendingJobs: () => ({ value: 0, dispose: () => {} }) });
    // 预算给得很宽：能早退就一定是靠 value === 0 判出来的，不是被 deadline 兜住的
    const b = createQuickJsBackend({
      loadModule: fake.loadModule,
      budget: { entryTimeoutMs: 5000, passTimeoutMs: 10_000 },
    });
    const started = Date.now();
    const outcomes = await b.runPass([{ uid: 1, content: '<% 1 %>' }], makeCtx());
    expect(outcomes[0].ok).toBe(false); // dump 恒 '0' → 永远未落定
    expect(outcomes[0].error).toContain('未落定');
    // pump 循环一轮 + drainJobs 一轮 = 2；曾经是 1 + MAX_DRAIN_ROUNDS(64)
    expect(fake.stats.pumpCalls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('失败分支的错误句柄被释放（不释放 = runtime.dispose 断言失败并 Abort 整个 wasm 实例）', async () => {
    let errorDisposed = 0;
    const fake = makeFakeModule({
      pendingJobs: () => {
        // 仿上游 DisposableFail：它自己的 dispose() 负责放掉 error 句柄
        const error = {
          dispose: () => {
            errorDisposed++;
          },
        };
        return { error, dispose: () => error.dispose() };
      },
    });
    const b = createQuickJsBackend({
      loadModule: fake.loadModule,
      budget: { entryTimeoutMs: 5000, passTimeoutMs: 10_000 },
    });
    await b.runPass([{ uid: 1, content: '<% 1 %>' }], makeCtx());
    expect(fake.stats.pumpCalls).toBe(2);
    // 每一次返回的失败结果都必须被释放，一个都不能漏
    expect(errorDisposed).toBe(fake.stats.pumpCalls);
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

// ═══════════════════════════════════════════════════════════
// COR-08 的加固面（2026-08-10 审查轮）—— 只读轴重建**失败要响，不要静默用上一条的残留**
// ═══════════════════════════════════════════════════════════

describe('QuickJS 后端 · stats 逐条目重建的加固', () => {
  it(
    '🔴 母本 __ejsStatsJson 不可写不可配置 —— 条目改不掉它，COR-08 换不了地方复活',
    async () => {
      const ctx = makeCtx({ stats: { 主角: { 等级: 7 } } });
      const out = await backend.runPass(
        [
          // 非严格模式下赋值静默失败；defineProperty 会抛，两种写法都不该改成功
          { uid: 1, content: '<% globalThis.__ejsStatsJson = \'{"主角":{"等级":999}}\' %>改过了' },
          { uid: 2, content: '<%= stats.主角.等级 %>' },
        ],
        ctx,
      );
      expect(out[1].text).toBe('7');
    },
    SLOW,
  );

  it(
    '🔴 条目把 stats 钉成不可配置 → 后续条目**判失败原文注入**，而不是静默读到残留',
    async () => {
      const ctx = makeCtx({ stats: { 主角: { 等级: 7 } } });
      const out = await backend.runPass(
        [
          {
            uid: 1,
            content:
              '<% Object.defineProperty(globalThis, "stats", { value: { 主角: { 等级: 999 } }, writable: false, configurable: false }) %>钉死',
          },
          { uid: 2, content: '<%= stats.主角.等级 %>' },
        ],
        ctx,
      );
      // 重建抛错 → 本条目不执行、原文注入。绝不能渲染成 999（那就是 COR-08 复活）
      expect(out[1].ok).toBe(false);
      expect(out[1].text).toBe('<%= stats.主角.等级 %>');
    },
    SLOW,
  );
});
