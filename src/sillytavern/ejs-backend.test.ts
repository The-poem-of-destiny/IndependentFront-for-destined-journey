/**
 * ejs-backend.ts 测试 —— 求值后端接缝（能力面 §0.1 / 切片 T1）
 *
 * 这个文件本该在 T1 就存在。它缺席的直接后果：`LegacyBackend.runPass` 的
 * 逐条目回退、编译缓存的失效时机、生产切换的**失败降级**三件事全靠人眼保证，
 * 而其中两件在后续的评审里真的被发现有问题（见 ejs-backend-parity.test.ts）。
 *
 * 覆盖面：接缝本身（取/设/复位）· 编译缓存 · LegacyBackend 的 D8 行为 · 生产切换降级。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getEjsBackend,
  setEjsBackend,
  resetEjsBackend,
  getCompiledEntry,
  clearEjsBackendCache,
  LegacyBackend,
  FailClosedBackend,
  installProductionEjsBackend,
  type EjsBackend,
} from './ejs-backend';
import type { EjsEvalContext } from './ejs-runtime';

const ctx = (over: Partial<EjsEvalContext> = {}): EjsEvalContext => ({
  stats: over.stats ?? {},
  vars: over.vars ?? {},
  historyText: over.historyText ?? '',
  ...(over.seed !== undefined ? { seed: over.seed } : {}),
  ...(over.capabilities !== undefined ? { capabilities: over.capabilities } : {}),
});

beforeEach(() => {
  resetEjsBackend();
  clearEjsBackendCache();
});
afterEach(() => {
  resetEjsBackend();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════
// 接缝
// ═══════════════════════════════════════════════════════════

describe('后端接缝', () => {
  it('默认是 Legacy，且诚实声明自己不可中断', () => {
    const b = getEjsBackend();
    expect(b.name).toContain('legacy');
    // 🔴 这个 false 不是描述性的：对抗测试据此决定是否真跑死循环用例。
    // 谎报 true 会让 CI 挂死；谎报 false 会让危险用例静默跳过。
    expect(b.interruptible).toBe(false);
  });

  it('set → get 拿到同一个实例；reset 回到 Legacy', () => {
    const fake: EjsBackend = {
      name: 'fake',
      interruptible: true,
      runPass: async () => [],
      dispose: () => {},
    };
    setEjsBackend(fake);
    expect(getEjsBackend()).toBe(fake);
    resetEjsBackend();
    expect(getEjsBackend().name).toContain('legacy');
  });
});

// ═══════════════════════════════════════════════════════════
// 编译缓存
// ═══════════════════════════════════════════════════════════

describe('编译缓存', () => {
  it('同正文命中同一份编译产物（正文是缓存键）', () => {
    const a = getCompiledEntry('<%= 1 + 1 %>');
    const b = getCompiledEntry('<%= 1 + 1 %>');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.compiled).toBe(b.compiled);
  });

  it('不同正文各自编译', () => {
    const a = getCompiledEntry('<%= 1 %>');
    const b = getCompiledEntry('<%= 2 %>');
    if (a.ok && b.ok) expect(a.compiled).not.toBe(b.compiled);
  });

  it('编译失败也进缓存 —— 坏条目不该每回合重新编译一次再失败一次', () => {
    const a = getCompiledEntry('<% if ( %>');
    const b = getCompiledEntry('<% if ( %>');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it('clearEjsBackendCache 之后重新编译', () => {
    const a = getCompiledEntry('<%= 42 %>');
    clearEjsBackendCache();
    const b = getCompiledEntry('<%= 42 %>');
    if (a.ok && b.ok) expect(a.compiled).not.toBe(b.compiled);
  });
});

// ═══════════════════════════════════════════════════════════
// LegacyBackend
// ═══════════════════════════════════════════════════════════

describe('LegacyBackend.runPass', () => {
  const backend = new LegacyBackend();

  it('空入参直接返回空数组，不建任何上下文', async () => {
    expect(await backend.runPass([], ctx())).toEqual([]);
  });

  it('逐条目渲染，顺序与入参一致', async () => {
    const out = await backend.runPass(
      [
        { uid: 7, content: '甲' },
        { uid: 3, content: '<%= 1 + 1 %>' },
      ],
      ctx(),
    );
    expect(out.map((o) => o.uid)).toEqual([7, 3]);
    expect(out.map((o) => o.text)).toEqual(['甲', '2']);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('单条目失败 → 原文注入 + 带错因，其余条目照跑（D8）', async () => {
    const out = await backend.runPass(
      [
        { uid: 1, content: '<% 不存在的符号() %>' },
        { uid: 2, content: '好的' },
      ],
      ctx(),
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].text).toBe('<% 不存在的符号() %>');
    expect(out[0].error).toBeTruthy();
    expect(out[1]).toMatchObject({ ok: true, text: '好的' });
  });

  it('pass 内前条目写 → 后条目立即可见，且宿主草稿拿到最终态', async () => {
    const c = ctx();
    const out = await backend.runPass(
      [
        { uid: 1, content: '<% vars.计数 = 7 %>' },
        { uid: 2, content: '<%= vars.计数 %>' },
      ],
      c,
    );
    expect(out[1].text).toBe('7');
    expect(c.vars.计数).toBe(7);
  });

  it('失败条目的半途写整体回滚（D8）', async () => {
    const c = ctx();
    await backend.runPass([{ uid: 1, content: '<% vars.脏 = 1; 不存在() %>' }], c);
    expect(c.vars.脏).toBeUndefined();
  });

  it('async 条目照跑 —— 这正是接缝存在的理由之一', async () => {
    const out = await backend.runPass([{ uid: 1, content: '<%= await 41 + 1 %>' }], ctx());
    expect(out[0]).toMatchObject({ ok: true, text: '42' });
  });
});

// ═══════════════════════════════════════════════════════════
// 生产切换
// ═══════════════════════════════════════════════════════════

describe('FailClosedBackend', () => {
  it('全部条目原文注入 + 带可读原因（D8 语义）', async () => {
    const b = new FailClosedBackend('测试原因');
    const out = await b.runPass(
      [
        { uid: 1, content: '<%= 1 + 1 %>' },
        { uid: 2, content: '纯文本' },
      ],
      ctx(),
    );
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(out.map((o) => o.text)).toEqual(['<%= 1 + 1 %>', '纯文本']);
    expect(out[0].error).toContain('测试原因');
  });

  it('一行 EJS 都不执行 —— 草稿一个字节都不动', async () => {
    const c = ctx();
    await new FailClosedBackend('x').runPass([{ uid: 1, content: '<% vars.写了 = 1 %>' }], c);
    expect(c.vars).toEqual({});
  });
});

describe('installProductionEjsBackend', () => {
  it('装载成功 → 切到隔离后端，且 wasm 真的起来了', async () => {
    const ok = await installProductionEjsBackend();
    expect(ok).toBe(true);
    expect(getEjsBackend().interruptible).toBe(true);
    expect(getEjsBackend().name).toContain('quickjs');
    // 🔴 光看 name / interruptible 是不够的：那两样在 wasm 根本没装起来时也照样对。
    // 真跑一趟才能证明 `true` 的含义是「隔离在服役」而不是「JS 模块 import 成功了」。
    const c = ctx();
    const out = await getEjsBackend().runPass([{ uid: 1, content: '<%= 40 + 2 %>' }], c);
    expect(out[0]).toMatchObject({ ok: true, text: '42' });
  }, 30000);

  it('多次调用幂等（重复装不会把后端搞坏）', async () => {
    await installProductionEjsBackend();
    const first = getEjsBackend();
    await installProductionEjsBackend();
    expect(getEjsBackend().name).toBe(first.name);
  }, 30000);

  it('🔒 装载失败 → fail closed，**不退回 Legacy**', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 真让动态 import 炸掉（模拟 wasm 取不到 / 浏览器不支持 / CSP 拦截）
    vi.doMock('./ejs-quickjs-backend', () => {
      throw new Error('模拟 wasm 装载失败');
    });
    try {
      const ok = await installProductionEjsBackend();
      expect(ok).toBe(false);
      // 关键：终态是 fail-closed 而不是 legacy
      expect(getEjsBackend().name).toContain('fail-closed');
      expect(getEjsBackend().name).not.toContain('legacy');
      // 而且真的一行 EJS 都不跑
      const c = ctx();
      const out = await getEjsBackend().runPass([{ uid: 1, content: '<% vars.写了 = 1 %>' }], c);
      expect(out[0]).toMatchObject({ ok: false, text: '<% vars.写了 = 1 %>' });
      expect(c.vars).toEqual({});
      // 失败必须留痕（console.error，不是 warn —— 这是安全相关状态）
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.doUnmock('./ejs-quickjs-backend');
      vi.resetModules();
      spy.mockRestore();
    }
  }, 30000);

  it('🔒 模块 import 得到但 **wasm 装不起来** → 同样 fail closed（不是报成功）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 这一条与上一条的区别正是缺陷所在：JS 模块好好的，wasm 取不到（CDN 挂 / CSP 拦 / 不支持）。
    // 曾经装配只 import 不预热，于是这里会 **return true**、main.ts 一声不吭，
    // 而此后每个 pass 都静默退化成原文注入 —— 下游却按「隔离是真的」在做决策。
    let disposed = 0;
    vi.doMock('./ejs-quickjs-backend', () => ({
      createQuickJsBackend: () => ({
        name: 'quickjs(wasm)',
        interruptible: true,
        runPass: async () => [],
        dispose: () => {
          disposed++;
        },
        warmup: async () => {
          throw new Error('模拟 wasm 取不到');
        },
      }),
    }));
    try {
      const ok = await installProductionEjsBackend();
      expect(ok).toBe(false);
      expect(getEjsBackend().name).toContain('fail-closed');
      expect(getEjsBackend().name).not.toContain('quickjs');
      // 而且真的一行 EJS 都不跑
      const c = ctx();
      const out = await getEjsBackend().runPass([{ uid: 1, content: '<% vars.写了 = 1 %>' }], c);
      expect(out[0]).toMatchObject({ ok: false, text: '<% vars.写了 = 1 %>' });
      expect(c.vars).toEqual({});
      // 半成品后端必须被放掉，不能留一个悬着的 wasm 实例
      expect(disposed).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.doUnmock('./ejs-quickjs-backend');
      vi.resetModules();
      spy.mockRestore();
    }
  }, 30000);

  it('🔒 装载**期间**就已 fail closed —— 不留「先用 Legacy 渲染一轮」的窗口', async () => {
    const pending = installProductionEjsBackend();
    // 同步紧跟其后：此刻 wasm 还没装完
    const during = getEjsBackend();
    expect(during.name).toContain('fail-closed');
    expect(during.name).not.toContain('legacy');
    await pending;
  }, 30000);
});
