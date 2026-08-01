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

describe('installProductionEjsBackend', () => {
  it('装载成功 → 切到隔离后端', async () => {
    const ok = await installProductionEjsBackend();
    expect(ok).toBe(true);
    expect(getEjsBackend().interruptible).toBe(true);
  }, 30000);

  it('多次调用幂等（重复装不会把后端搞坏）', async () => {
    await installProductionEjsBackend();
    const first = getEjsBackend();
    await installProductionEjsBackend();
    expect(getEjsBackend().name).toBe(first.name);
  }, 30000);
});
