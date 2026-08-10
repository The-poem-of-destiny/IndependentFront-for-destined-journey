/**
 * script-quickjs-backend 测试 —— SEC-02 的**验收**，不是单元测试
 *
 * 这个文件回答的是三个问题，每一个都对应审查里一条具体的越线判定：
 *
 * 1. **逃逸拿不到宿主** —— 构造器逃逸（`({}).constructor.constructor(...)`）在旧实现下
 *    拿回的是应用自己的 `globalThis`，于是 `indexedDB` → Dexie → API Key 全在手上。
 *    这里用一个只存在于**宿主**的哨兵值证明它拿不到。
 * 2. **有 CPU 预算** —— `init` 里一句 `for(;;);` 在旧实现下会在每次读档时冻死标签页。
 * 3. **脚本之间零泄漏** —— COR-08 那类「上一条写的东西被下一条看见」的分叉。
 *
 * 外加一整节**兼容性**：realm 换了，AI 已经写出来的那些脚本还得照跑。
 *
 * 🔴 断言方式统一是「guest 用 `$event.emit('probe', {...})` 把观察结果带出来」——
 *    与既有测试同一个手法（脚本没有返回值通道，副作用是唯一出口）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeScript, type ScriptContext } from './script-executor';
import {
  installProductionScriptBackend,
  resetScriptBackend,
  getScriptBackend,
} from './script-backend';
import type { ReadonlyHookSet } from './types';

/** 只存在于**宿主** realm 的哨兵 —— guest 但凡看得见它，就等于逃逸成功 */
const HOST_SENTINEL = '__SCRIPT_ISOLATE_HOST_SENTINEL__';

beforeAll(async () => {
  (globalThis as Record<string, unknown>)[HOST_SENTINEL] = 'api-key-would-be-here';
  const isolated = await installProductionScriptBackend();
  expect(isolated, 'QuickJS 隔离未装载 —— 本文件的断言将全部失去意义').toBe(true);
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>)[HOST_SENTINEL];
  resetScriptBackend();
});

function ctx(overrides: Partial<ScriptContext> = {}): ScriptContext {
  return {
    owner: 'char_1',
    target: 'char_2',
    event: {},
    self: { stacks: 1, remainingTime: null, name: 'probe' },
    ...overrides,
  };
}

/** 取出 `$event.emit('probe', {...})` 带出来的那一包 */
function probe(script: string, context: ScriptContext = ctx()): Record<string, unknown> {
  const result = executeScript(script, context);
  const found = result.events.find((e) => e.eventType === 'probe');
  return (found?.data ?? {}) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════
describe('红线 ③ —— 逃逸够不到宿主', () => {
  it('构造器逃逸拿到的是 guest 全局，看不见宿主哨兵', () => {
    const data = probe(`
      var g = null, how = 'none';
      try { g = ({}).constructor.constructor('return globalThis')(); how = 'ctor'; } catch (e) {}
      if (!g) { try { g = (function () { return this; })(); how = 'this'; } catch (e) {} }
      $event.emit('probe', {
        how: how,
        gotSomething: !!g,
        sawSentinel: !!(g && g['${HOST_SENTINEL}']),
        sentinelType: typeof (g && g['${HOST_SENTINEL}']),
      });
    `);
    // 逃逸「成功」是允许的 —— 拿到的是**这个沙盒自己的**全局，那本来就无害
    expect(data.gotSomething).toBe(true);
    // 但它绝不能是宿主的那个
    expect(data.sawSentinel).toBe(false);
    expect(data.sentinelType).toBe('undefined');
  });

  it('经桥接函数的 constructor 逃逸同样够不到宿主', () => {
    // `$resource.modifyHp` 是 guest 门面函数；旧实现里它是**宿主闭包**，
    // `.constructor` 直通宿主 Function。这条专门盯那个方向。
    const data = probe(`
      var g = null;
      try { g = $resource.modifyHp.constructor('return globalThis')(); } catch (e) {}
      $event.emit('probe', { sawSentinel: !!(g && g['${HOST_SENTINEL}']) });
    `);
    expect(data.sawSentinel).toBe(false);
  });

  it('网络与存储 API 一概不存在（fetch / indexedDB / XMLHttpRequest / WebSocket）', () => {
    const data = probe(`
      $event.emit('probe', {
        fetch: typeof fetch,
        idb: typeof indexedDB,
        xhr: typeof XMLHttpRequest,
        ws: typeof WebSocket,
        ls: typeof localStorage,
        doc: typeof document,
        win: typeof window,
      });
    `);
    for (const key of ['fetch', 'idb', 'xhr', 'ws', 'ls', 'doc', 'win']) {
      expect(data[key], `${key} 必须不可达`).toBe('undefined');
    }
  });

  it('Node 宿主的 process / require 也不可达（测试环境本身就有它们）', () => {
    const data = probe(`
      var viaEscape = null;
      try { viaEscape = ({}).constructor.constructor('return typeof process')(); } catch (e) { viaEscape = 'threw'; }
      $event.emit('probe', { direct: typeof process, req: typeof require, viaEscape: viaEscape });
    `);
    expect(data.direct).toBe('undefined');
    expect(data.req).toBe('undefined');
    // 逃逸出来的那个 realm 里同样没有 process —— 它是 guest 的 realm
    expect(data.viaEscape).toBe('undefined');
  });

  it('宿主全局是遮蔽成 undefined 而不是 ReferenceError（保真旧实现的形参遮蔽）', () => {
    // 旧实现下 `if (window)` 走 else 分支；若改成裸 ReferenceError，脚本会整个中断，
    // 而防御性写 `if (window)` 恰恰是 AI 爱写的形状
    const result = executeScript(
      'if (!window && !fetch) { $resource.modifyHp(owner, -1); }',
      ctx(),
    );
    expect(result.hpChanges).toEqual([{ charId: 'char_1', amount: -1 }]);
  });
});

// ═══════════════════════════════════════════════════════════
describe('CPU 预算 —— 死循环不再冻死标签页', () => {
  it('while(true) 在预算内被中断，且不抛穿', () => {
    const start = Date.now();
    let result!: ReturnType<typeof executeScript>;
    expect(() => {
      result = executeScript('while (true) {}', ctx());
    }).not.toThrow();
    const elapsed = Date.now() - start;

    // 预算 50ms；给足调度余量，但必须远小于「永久冻结」
    expect(elapsed).toBeLessThan(3000);
    expect(result.hpChanges).toHaveLength(0);
  });

  it('超时脚本不会毒化后端 —— 下一条脚本照常执行', () => {
    executeScript('while (true) {}', ctx());
    const result = executeScript('$resource.modifyHp(owner, -7)', ctx());
    expect(result.hpChanges).toEqual([{ charId: 'char_1', amount: -7 }]);
  });

  it('超时之前已经发生的副作用**保留**（与旧实现一致）', () => {
    const result = executeScript('$resource.modifyHp(owner, -3); while (true) {}', ctx());
    expect(result.hpChanges).toEqual([{ charId: 'char_1', amount: -3 }]);
  });

  it('自我调度的无穷 Promise 链也收得住', () => {
    const start = Date.now();
    expect(() => {
      executeScript('function f() { Promise.resolve().then(f); } f();', ctx());
    }).not.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
    // 后端仍然可用（抽干队列没把 wasm 实例 abort 掉）
    expect(executeScript('$resource.modifyHp(owner, -1)', ctx()).hpChanges).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('脚本之间零泄漏（COR-08 同形状缺陷的防线）', () => {
  it('前一条脚本种的全局，后一条看不见', () => {
    executeScript('globalThis.__leaked = "yes"; var alsoLeaked = 1;', ctx());
    const data = probe(`
      $event.emit('probe', {
        g: typeof globalThis.__leaked,
        v: typeof alsoLeaked,
      });
    `);
    expect(data.g).toBe('undefined');
    expect(data.v).toBe('undefined');
  });

  it('前一条脚本改内建原型，后一条不受影响', () => {
    executeScript('Array.prototype.pwned = function () { return 1; };', ctx());
    const data = probe(`$event.emit('probe', { pwned: typeof [].pwned });`);
    expect(data.pwned).toBe('undefined');
  });

  it('guest 改内建原型不会波及**宿主**', () => {
    executeScript('Object.prototype.__hostPolluted = 1;', ctx());
    expect(({} as Record<string, unknown>).__hostPolluted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
describe('兼容性 —— 换了 realm，既有脚本还得跑得动', () => {
  it('标准库与 ES6+ 语法齐全', () => {
    const data = probe(`
      const doubled = ((x) => x * 2)(21);
      const arr = [3, 1, 2].slice().sort().join('');
      const m = new Map([['k', 7]]);
      const { a, ...rest } = { a: 1, b: 2, c: 3 };
      $event.emit('probe', {
        json: JSON.parse(JSON.stringify({ ok: 1 })).ok,
        math: Math.max(...[1, 5, 3]),
        dateIsNum: typeof Date.now(),
        regex: /a(b)c/.exec('abc')[1],
        arr: arr,
        cjk: '灼烧之剑'.length,
        map: m.get('k'),
        arrow: doubled,
        tpl: \`v\${1 + 1}\`,
        spread: Object.keys(rest).length,
        destructured: a,
      });
    `);
    expect(data).toMatchObject({
      json: 1,
      math: 5,
      dateIsNum: 'number',
      regex: 'b',
      arr: '123',
      cjk: 4,
      map: 7,
      arrow: 42,
      tpl: 'v2',
      spread: 2,
      destructured: 1,
    });
  });

  it('console 可用且不抛（QuickJS 不自带，旧实现下脚本能调宿主 console）', () => {
    const result = executeScript(
      'console.log("debug"); console.warn("w"); $resource.modifyHp(owner, -2);',
      ctx(),
    );
    expect(result.hpChanges).toEqual([{ charId: 'char_1', amount: -2 }]);
  });

  it('"use strict" 语义保真 —— 未声明赋值仍是 ReferenceError', () => {
    // 旧实现的函数体带 "use strict"，漏 var 会抛并中断脚本。
    // 松散模式下它会静默建全局并继续往下跑 —— 那是一处静默分叉。
    const result = executeScript('undeclared = 1; $resource.modifyHp(owner, -1);', ctx());
    expect(result.hpChanges).toHaveLength(0);
  });

  it('中文字符串与对象原样过境（JSON 编组不吃字节）', () => {
    const result = executeScript(
      `$status.add(target, { name: '灼烧·改', category: '减益', stacks: 1, remainingTime: 3, timeUnit: '回合', source: '「引燃」的剑' });`,
      ctx(),
    );
    expect(result.adds[0].effect.name).toBe('灼烧·改');
    expect(result.adds[0].effect.source).toBe('「引燃」的剑');
  });

  it('readHooks 抛错时中断脚本，但**保留已收集的部分效果**（旧实现同款）', () => {
    const hooks: ReadonlyHookSet = {
      getHp: () => {
        throw new Error('hook boom');
      },
      getMaxHp: () => 100,
      getMp: () => 0,
      getMaxMp: () => 0,
      getSp: () => 0,
      getMaxSp: () => 0,
      getHpPercent: () => 0,
      getAttr: () => 0,
      getTier: () => 1,
      isPresent: () => true,
      getStatusEffects: () => [],
      hasStatus: () => false,
      getBuffStacks: () => 0,
    };
    const result = executeScript(
      '$resource.modifyHp(owner, -5); $resource.getHp(owner); $resource.modifyHp(owner, -99);',
      ctx({ readHooks: hooks }),
    );
    expect(result.hpChanges).toEqual([{ charId: 'char_1', amount: -5 }]);
  });

  it('$call 无界递归被深度护栏收住，不爆栈也不失控', () => {
    const scripts = { loop: "$call('loop');" };
    const start = Date.now();
    expect(() => {
      executeScript(scripts.loop, {
        owner: 'char_1',
        self: { stacks: 1, remainingTime: null, name: 'loop', scripts },
      });
    }).not.toThrow();
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

// ═══════════════════════════════════════════════════════════
describe('fail-closed —— 没装隔离就一行都不跑', () => {
  it('重置到 fail-closed 之后脚本无副作用，装回来又能跑', async () => {
    resetScriptBackend();
    expect(getScriptBackend().name).toBe('fail-closed(隔离不可用)');

    const blocked = executeScript('$resource.modifyHp(owner, -50)', ctx());
    expect(blocked.hpChanges).toHaveLength(0);

    expect(await installProductionScriptBackend()).toBe(true);
    const allowed = executeScript('$resource.modifyHp(owner, -50)', ctx());
    expect(allowed.hpChanges).toEqual([{ charId: 'char_1', amount: -50 }]);
  });
});
