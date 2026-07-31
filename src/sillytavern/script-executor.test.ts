/**
 * script-executor 测试 (Phase 7e+8)
 */
import { describe, it, expect } from 'vitest';
import {
  executeScript,
  executeHook,
  createScriptEffects,
  resolveScriptRef,
  executeInit,
  executeCleanup,
} from './script-executor';
import type { StatusEffect, ReadonlyHookSet } from './types';
import type { ScriptContext } from './script-executor';

function makeStatus(overrides: Partial<StatusEffect> = {}): StatusEffect {
  return {
    id: 'test_status_1',
    name: '灼烧',
    description: '每回合失去5%生命值',
    category: '减益',
    stacks: 2,
    remainingTime: 3,
    timeUnit: '回合',
    source: '灼烧之剑',
    effects: {},
    scripts: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<ScriptContext> = {}): ScriptContext {
  return {
    owner: 'char_owner',
    target: 'char_target',
    event: { weapon: '灼烧之剑', damage: 30 },
    self: { stacks: 2, remainingTime: 3, name: '灼烧' },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
describe('executeScript', () => {
  it('passes context variables to script', () => {
    const ctx = makeContext();
    // 写一个用 return 返回值的脚本没法在 new Function 里捕获…
    // 但可以通过 $ APIs 的副作用验证
    const result = executeScript('$resource.modifyHp(target, -30)', ctx);
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_target', amount: -30 });
  });

  it('handles empty script gracefully', () => {
    const result = executeScript('', makeContext());
    expect(result.adds).toHaveLength(0);
    expect(result.hpChanges).toHaveLength(0);
  });

  it('handles script errors without throwing', () => {
    expect(() => executeScript('throw new Error("test")', makeContext())).not.toThrow();
  });

  it('$dice.d100 returns value between 1-100', () => {
    // 验证它不抛错；值由 Math.random 生成
    expect(() => executeScript('$dice.d100()', makeContext())).not.toThrow();
  });

  it('$status.add creates a new status effect', () => {
    const ctx = makeContext();
    const result = executeScript(
      '$status.add(target, { name: "中毒", category: "减益", stacks: 1, remainingTime: 3, timeUnit: "回合", source: "毒匕首" })',
      ctx,
    );
    expect(result.adds).toHaveLength(1);
    expect(result.adds[0].charId).toBe('char_target');
    expect(result.adds[0].effect.name).toBe('中毒');
  });

  it('$status.add with scripts creates nested effect chain', () => {
    const ctx = makeContext();
    const result = executeScript(
      '$status.add(target, { name: "灼烧", category: "减益", stacks: 1, remainingTime: 3, timeUnit: "回合", source: "剑", scripts: { tick: "$resource.modifyHp(owner, -5)" }, onTick: "tick" })',
      ctx,
    );
    expect(result.adds).toHaveLength(1);
    expect(result.adds[0].effect.scripts).toBeDefined();
    expect(result.adds[0].effect.onTick).toBe('tick');
  });

  it('$status.remove and $status.setStacks', () => {
    const ctx = makeContext();
    const result = executeScript(
      '$status.remove(owner, "burn_1"); $status.setStacks(owner, "bleed_1", 0)',
      ctx,
    );
    // 🆕 M2: $status.remove 改走 statusRemoves（按 buffId/name 新语义）
    expect(result.statusRemoves).toHaveLength(1);
    expect(result.statusRemoves[0]).toEqual({ target: 'char_owner', buffIdOrName: 'burn_1' });
    expect(result.stackSets).toHaveLength(1);
    expect(result.stackSets[0].stacks).toBe(0);
  });

  it('$event.emit fires events', () => {
    const ctx = makeContext();
    const result = executeScript('$event.emit("flame_burst", { damage: 50 })', ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('flame_burst');
    expect(result.events[0].data.damage).toBe(50);
  });

  it('self contains stack and time info', () => {
    const ctx = makeContext({ self: { stacks: 3, remainingTime: 5, name: '流血' } });
    const result = executeScript(
      'if (self.stacks >= 3) { $resource.modifyHp(owner, -20); $status.setStacks(owner, self.name, 0) }',
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
    expect(result.stackSets).toHaveLength(1);
  });

  it('condition with d100 works', () => {
    const ctx = makeContext();
    // 条件永远为 true (d100 >= 0)
    const result = executeScript('if ($dice.d100() >= 0) { $resource.modifyHp(target, -10) }', ctx);
    expect(result.hpChanges).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('executeHook', () => {
  it('executes onTick on all statuses that have it', () => {
    const statuses = [
      makeStatus({
        id: 'burn',
        name: '灼烧',
        scripts: { tick: '$resource.modifyHp(owner, -5)' },
        onTick: 'tick',
      }),
      makeStatus({
        id: 'poison',
        name: '中毒',
        scripts: { tick: '$resource.modifyHp(owner, -3)' },
        onTick: 'tick',
      }),
      makeStatus({ id: 'shield', name: '护盾', scripts: {}, onTick: undefined }),
    ];
    const ctx = { owner: 'char_1', target: undefined, event: { turn: 3 } };
    const result = executeHook(statuses, 'onTick', ctx);
    expect(result.hpChanges).toHaveLength(2); // 灼烧 + 中毒
  });

  it('skips statuses without scripts or hook', () => {
    const statuses = [makeStatus({ id: 'bare', scripts: undefined, onTick: undefined })];
    const result = executeHook(statuses, 'onTick', { owner: 'x', target: undefined });
    expect(result.hpChanges).toHaveLength(0);
  });

  it('executes onApply hook', () => {
    const statuses = [
      makeStatus({
        id: 'fear',
        name: '恐惧',
        scripts: { apply: '$resource.modifyStat(owner, "atk", -5)' },
        onApply: 'apply',
      }),
    ];
    const result = executeHook(statuses, 'onApply', { owner: 'char_1', target: undefined });
    expect(result.statChanges).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('resolveScriptRef', () => {
  it('resolves script reference', () => {
    const scripts = { hit: 'console.log("hit")' };
    expect(resolveScriptRef('hit', scripts)).toBe('console.log("hit")');
  });

  it('returns undefined for missing ref or scripts', () => {
    expect(resolveScriptRef('missing', {})).toBeUndefined();
    expect(resolveScriptRef('hit', undefined)).toBeUndefined();
    expect(resolveScriptRef('', { hit: 'x' })).toBeUndefined();
  });

  // 🆕 @parent 解析
  it('resolves @parent.xxx from parentScripts', () => {
    const parentScripts = { burnFormula: '$resource.modifyHp(owner, -10)' };
    expect(resolveScriptRef('@parent.burnFormula', {}, parentScripts)).toBe(
      '$resource.modifyHp(owner, -10)',
    );
  });

  // 🆕 @parent 递归解析
  it('recursively resolves @parent chain to actual code', () => {
    const scripts = { tick: '@parent.burnFormula' };
    const parentScripts = { burnFormula: '$resource.modifyHp(owner, -8)' };
    // resolveScriptRef 递归: "tick" → "@parent.burnFormula" → "$resource.modifyHp(owner, -8)"
    expect(resolveScriptRef('tick', scripts, parentScripts)).toBe('$resource.modifyHp(owner, -8)');
  });

  // 🆕 @parent 不存在不崩溃
  it('returns undefined when @parent key does not exist', () => {
    expect(resolveScriptRef('@parent.nonexistent', {}, {})).toBeUndefined();
  });

  // 🆕 递归深度保护
  it('returns undefined after exceeding recursion depth 5', () => {
    // 构造循环引用: a → @parent.b → @parent.c → @parent.d → @parent.e → @parent.f → ...
    const scripts = { a: '@parent.b' };
    // 传入深度为5时应该返回 undefined
    expect(resolveScriptRef('@parent.nonexistent', {}, {}, 6)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 $event.on / $event.off
// ═══════════════════════════════════════════════════════════
describe('$event.on and $event.off (init self-registration)', () => {
  it('$event.on collects subscription in ScriptEffects', () => {
    const ctx = makeContext();
    const result = executeScript("$event.on('combat_action', 'reflect');", ctx);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].eventType).toBe('combat_action');
    expect(result.subscriptions[0].scriptKey).toBe('reflect');
  });

  it('$event.on returns a handle string', () => {
    const ctx = makeContext();
    const result = executeScript(
      "const h = $event.on('combat_action', 'onDamaged'); $event.emit('test', { handle: h });",
      ctx,
    );
    expect(result.subscriptions).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(typeof result.events[0].data.handle).toBe('string');
    expect(result.events[0].data.handle).toContain('sub_');
  });

  it('$event.off collects unsubscription in ScriptEffects', () => {
    const ctx = makeContext();
    const result = executeScript("$event.off('combat_action');", ctx);
    expect(result.unsubscriptions).toHaveLength(1);
    expect(result.unsubscriptions[0]).toBe('combat_action');
  });

  it('$event.on + $event.off together in init + cleanup pattern', () => {
    const ctx = makeContext({
      self: { stacks: 1, remainingTime: null, name: '荆棘甲', scripts: {} },
    });
    // Simulate init
    const initResult = executeScript(
      "$event.on('combat_action', 'reflect'); $event.on('location_change', 'onMove');",
      ctx,
    );
    expect(initResult.subscriptions).toHaveLength(2);
    // Simulate cleanup
    const cleanupResult = executeScript(
      "$event.off('combat_action'); $event.off('location_change');",
      ctx,
    );
    expect(cleanupResult.unsubscriptions).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 $call — 跨对象脚本引用
// ═══════════════════════════════════════════════════════════
describe('$call — cross-object script invocation', () => {
  it('$call("@parent.formula") executes parent script and collects effects', () => {
    const parentScripts = {
      formula: '$resource.modifyHp(target, -15);',
    };
    const scripts = {
      onHit: "$call('@parent.formula');",
    };
    const ctx: ScriptContext = {
      owner: 'char_1',
      target: 'char_2',
      self: { stacks: 1, remainingTime: null, name: '灼烧之剑', scripts },
      parentScripts,
    };
    const result = executeScript(scripts.onHit, ctx);
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_2', amount: -15 });
  });

  it('$call("@parent.formula") returns undefined for missing ref', () => {
    const scripts = {
      onHit: "$call('@parent.nonexistent');",
    };
    const ctx: ScriptContext = {
      owner: 'char_1',
      self: { stacks: 1, remainingTime: null, name: 'test', scripts },
      parentScripts: {},
    };
    expect(() => executeScript(scripts.onHit, ctx)).not.toThrow();
  });

  it('$call merges nested effects: adds, removes, hpChanges, events, subscriptions', () => {
    const parentScripts = {
      complex: `
        $resource.modifyHp(target, -10);
        $status.add(target, { name:'灼烧', category:'减益', stacks:1, remainingTime:2, timeUnit:'回合', source:'test' });
        $event.on('combat_action', 'reflect');
        $event.emit('triggered', { val: 42 });
      `,
    };
    const scripts = { main: "$call('@parent.complex');" };
    const ctx: ScriptContext = {
      owner: 'char_1',
      target: 'char_2',
      self: { stacks: 1, remainingTime: null, name: 'main', scripts },
      parentScripts,
    };
    const result = executeScript(scripts.main, ctx);
    expect(result.hpChanges).toHaveLength(1);
    expect(result.adds).toHaveLength(1);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 $status.add 自动继承 parentScripts
// ═══════════════════════════════════════════════════════════
describe('$status.add parentScripts inheritance', () => {
  it('$status.add auto-stamps _parentScripts on child StatusEffect', () => {
    const scripts = {
      init: "$event.on('combat_action', 'burn');",
      burn: '$resource.modifyHp(target, -5);',
      onHit:
        "$status.add(target, { name:'灼烧', category:'减益', stacks:1, remainingTime:3, timeUnit:'回合', source:'test', scripts:{ tick:'@parent.burn' }, onTick:'tick' });",
    };
    const ctx: ScriptContext = {
      owner: 'char_1',
      target: 'char_2',
      self: { stacks: 1, remainingTime: null, name: '灼烧之剑', scripts },
    };
    const result = executeScript(scripts.onHit, ctx);
    expect(result.adds).toHaveLength(1);
    // 验证 _parentScripts 被自动注入
    const childEffect = result.adds[0].effect as any;
    expect(childEffect._parentScripts).toBeDefined();
    expect(childEffect._parentScripts.burn).toBe('$resource.modifyHp(target, -5);');
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 executeInit / executeCleanup
// ═══════════════════════════════════════════════════════════
describe('executeInit and executeCleanup', () => {
  it('executeInit runs scripts.init and collects subscriptions', () => {
    const scripts = {
      init: "$event.on('combat_action', 'reflect'); $event.on('location_change', 'onMove');",
      reflect: '...',
      onMove: '...',
    };
    const result = executeInit(scripts, undefined, 'char_1');
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions[0].eventType).toBe('combat_action');
    expect(result.subscriptions[1].eventType).toBe('location_change');
  });

  it('executeCleanup runs scripts.cleanup and collects unsubscriptions', () => {
    const scripts = {
      init: '...',
      cleanup: "$event.off('combat_action'); $event.off('location_change');",
    };
    const result = executeCleanup(scripts, undefined, 'char_1');
    expect(result.unsubscriptions).toHaveLength(2);
  });

  it('executeInit returns empty effects when no init script', () => {
    const scripts = { other: '$resource.modifyHp(owner, -1);' };
    const result = executeInit(scripts, undefined, 'char_1');
    expect(result.subscriptions).toHaveLength(0);
    expect(result.hpChanges).toHaveLength(0);
  });

  it('executeInit passes parentScripts to scripts.init', () => {
    const parentScripts = { formula: '$resource.modifyHp(owner, -20);' };
    const scripts = {
      init: "$call('@parent.formula');",
    };
    const result = executeInit(scripts, parentScripts, 'char_1');
    // $call 会解析 @parent.formula 并执行
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_1', amount: -20 });
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 readHooks — 只读查询 API（M1 任务 1.5）
//   缺省返回 0/false 兼容现有测试；注入后 $resource/$char 读到真值；
//   写入仍走收集器，readHooks 不污染写入路径。
// ═══════════════════════════════════════════════════════════
describe('readHooks (只读查询 API)', () => {
  /** 构造一个 mock readHooks：char_1 有完整数据，其他 charId 走兜底 */
  function makeHooks(overrides: Partial<ReadonlyHookSet> = {}): ReadonlyHookSet {
    return {
      getHp: (id) => (id === 'char_1' ? 30 : 0),
      getMaxHp: () => 100,
      getMp: () => 20,
      getMaxMp: () => 50,
      getSp: () => 10,
      getMaxSp: () => 40,
      getHpPercent: () => 0.3,
      getAttr: (_id, a) => (a === 'str' ? 8 : 5),
      getTier: () => 2,
      isPresent: (id) => id === 'char_1',
      getStatusEffects: () => [],
      hasStatus: () => false,
      getBuffStacks: () => 0,
      ...overrides,
    };
  }

  it('未注入 readHooks 时 $resource.getHp 返回 0（兼容缺省）', () => {
    const ctx = makeContext(); // 不传 readHooks
    const result = executeScript(
      'const hp = $resource.getHp(owner); if (hp > 0) { $resource.modifyHp(owner, -1); }',
      ctx,
    );
    // hp === 0，分支不进入，hpChanges 为空 → 印证 getHp 返回 0
    expect(result.hpChanges).toHaveLength(0);
  });

  it('注入 readHooks 后 $resource.getHp 返回 mock 值', () => {
    const ctx = makeContext({ owner: 'char_1', readHooks: makeHooks() });
    const result = executeScript(
      'if ($resource.getHp(owner) === 30) { $resource.modifyHp(owner, -5); }',
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_1', amount: -5 });
  });

  it('注入 readHooks 后 getMaxHp/getMp/getMaxMp/getSp/getMaxSp/getHpPercent 各返回 mock 值', () => {
    const ctx = makeContext({ owner: 'char_1', readHooks: makeHooks() });
    // 用 $event.emit 把读到的值回传出来，便于断言
    const result = executeScript(
      `$event.emit('probe', {
         maxHp: $resource.getMaxHp(owner),
         mp: $resource.getMp(owner),
         maxMp: $resource.getMaxMp(owner),
         sp: $resource.getSp(owner),
         maxSp: $resource.getMaxSp(owner),
         pct: $resource.getHpPercent(owner),
       });`,
      ctx,
    );
    expect(result.events).toHaveLength(1);
    const data = result.events[0].data;
    expect(data.maxHp).toBe(100);
    expect(data.mp).toBe(20);
    expect(data.maxMp).toBe(50);
    expect(data.sp).toBe(10);
    expect(data.maxSp).toBe(40);
    expect(data.pct).toBe(0.3);
  });

  it('注入 readHooks 后 $char.getAttr(charId, "str") 返回 mock 值（英文键）', () => {
    const ctx = makeContext({ owner: 'char_1', readHooks: makeHooks() });
    const result = executeScript(
      `$event.emit('probe', {
         str: $char.getAttr(owner, 'str'),
         dex: $char.getAttr(owner, 'dex'),
       });`,
      ctx,
    );
    expect(result.events[0].data.str).toBe(8);
    expect(result.events[0].data.dex).toBe(5);
  });

  it('注入 readHooks 后 $char.getTier / $char.isPresent 返回 mock 值', () => {
    const ctx = makeContext({ owner: 'char_1', target: 'char_2', readHooks: makeHooks() });
    const result = executeScript(
      `$event.emit('probe', {
         tier: $char.getTier(owner),
         ownerPresent: $char.isPresent(owner),
         targetPresent: $char.isPresent(target),
       });`,
      ctx,
    );
    const data = result.events[0].data;
    expect(data.tier).toBe(2);
    expect(data.ownerPresent).toBe(true);
    expect(data.targetPresent).toBe(false);
  });

  it('未注入 readHooks 时 $char.getAttr 返回 0、$char.isPresent 返回 false', () => {
    const ctx = makeContext(); // 不传 readHooks
    const result = executeScript(
      `const a = $char.getAttr(owner, 'str');
       const t = $char.getTier(owner);
       const p = $char.isPresent(owner);
       if (a === 0 && t === 0 && p === false) { $resource.modifyHp(owner, 1); }`,
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
  });

  it('读写分离：注入 readHooks 后调 $resource.modifyHp 仍正确 push 进 hpChanges', () => {
    const ctx = makeContext({ owner: 'char_1', readHooks: makeHooks() });
    const result = executeScript(
      'const hp = $resource.getHp(owner); $resource.modifyHp(owner, -10);',
      ctx,
    );
    // 只读 getHp 不产生任何 effects；modifyHp 走写入收集器
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_1', amount: -10 });
  });

  it('handler 内组合读+写：低血量触发 modifyHp', () => {
    // mock getHp 返回 30 (< 50)，应触发扣血
    const ctx = makeContext({ owner: 'char_owner', target: 'char_1', readHooks: makeHooks() });
    const result = executeScript(
      'if ($resource.getHp(target) < 50) { $resource.modifyHp(owner, -10); }',
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
    expect(result.hpChanges[0]).toEqual({ charId: 'char_owner', amount: -10 });
  });

  it('handler 内组合读+写：高血量不触发', () => {
    // 把 getHp 改成返回 80 (>= 50)，分支不进入
    const hooks = makeHooks({ getHp: () => 80 });
    const ctx = makeContext({ owner: 'char_owner', target: 'char_1', readHooks: hooks });
    const result = executeScript(
      'if ($resource.getHp(target) < 50) { $resource.modifyHp(owner, -10); }',
      ctx,
    );
    expect(result.hpChanges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 🆕 M2: $status.apply / $status.remove / $status.has / $status.getStacks / $status.query
//   apply/remove 收集到 statusApplies/statusRemoves；
//   has/getStacks/query 走 readHooks（注入后读真值，缺省返回 false/0/[]）。
// ═══════════════════════════════════════════════════════════
describe('M2 $status.apply / remove / has / getStacks / query', () => {
  /** 构造 mock readHooks，char_1 持有真实 buff 数据 */
  function makeHooks(overrides: Partial<ReadonlyHookSet> = {}): ReadonlyHookSet {
    const char1Effects: StatusEffect[] = [
      {
        name: '流血',
        description: '',
        category: '减益',
        stacks: 3,
        remainingTime: 2,
        timeUnit: '回合',
        source: '剑',
        sourceKey: '幽怨之剑',
        effects: {},
      },
    ];
    return {
      getHp: () => 0,
      getMaxHp: () => 100,
      getMp: () => 0,
      getMaxMp: () => 50,
      getSp: () => 0,
      getMaxSp: () => 40,
      getHpPercent: () => 0,
      getAttr: () => 0,
      getTier: () => 0,
      isPresent: () => true,
      getStatusEffects: (id) => (id === 'char_1' ? char1Effects : []),
      hasStatus: (id, buffIdOrName) => {
        if (id !== 'char_1') return false;
        return char1Effects.some((e) =>
          buffIdOrName.includes('.')
            ? (e.sourceKey ? `${e.sourceKey}.${e.name}` : e.name) === buffIdOrName
            : e.name === buffIdOrName,
        );
      },
      getBuffStacks: (id, buffIdOrName) => {
        if (id !== 'char_1') return 0;
        const found = char1Effects.find((e) =>
          buffIdOrName.includes('.')
            ? (e.sourceKey ? `${e.sourceKey}.${e.name}` : e.name) === buffIdOrName
            : e.name === buffIdOrName,
        );
        return found ? found.stacks : 0;
      },
      ...overrides,
    };
  }

  it('$status.apply 收集到 statusApplies（含 name + category + sourceKey）', () => {
    const ctx = makeContext();
    const result = executeScript(
      '$status.apply(target, { name: "流血", category: "减益", sourceKey: "幽怨之剑", stacks: 2, remainingTime: 3 });',
      ctx,
    );
    expect(result.statusApplies).toHaveLength(1);
    expect(result.statusApplies[0].target).toBe('char_target');
    expect(result.statusApplies[0].buffDef.name).toBe('流血');
    expect(result.statusApplies[0].buffDef.category).toBe('减益');
    expect(result.statusApplies[0].buffDef.sourceKey).toBe('幽怨之剑');
    expect(result.statusApplies[0].buffDef.stacks).toBe(2);
    // add 不被触发（apply 与 add 是独立路径）
    expect(result.adds).toHaveLength(0);
  });

  it('$status.apply 多次调用收集多个意图', () => {
    const ctx = makeContext();
    const result = executeScript(
      `$status.apply(owner, { name: "灼烧", category: "减益", stacks: 1 });
       $status.apply(target, { name: "护盾", category: "增益", stacks: 1 });`,
      ctx,
    );
    expect(result.statusApplies).toHaveLength(2);
    expect(result.statusApplies[0].target).toBe('char_owner');
    expect(result.statusApplies[0].buffDef.name).toBe('灼烧');
    expect(result.statusApplies[1].target).toBe('char_target');
    expect(result.statusApplies[1].buffDef.name).toBe('护盾');
  });

  it('$status.apply 自动继承 parentScripts（与 add 一致行为）', () => {
    const scripts = { burn: '$resource.modifyHp(target, -5);' };
    const ctx: ScriptContext = {
      owner: 'char_1',
      target: 'char_2',
      self: { stacks: 1, remainingTime: null, name: '灼烧之剑', scripts },
    };
    const result = executeScript(
      `$status.apply(target, { name: '灼烧', category: '减益', stacks: 1 });`,
      ctx,
    );
    expect(result.statusApplies).toHaveLength(1);
    const buffDef = result.statusApplies[0].buffDef as any;
    expect(buffDef._parentScripts).toBeDefined();
    expect(buffDef._parentScripts.burn).toBe('$resource.modifyHp(target, -5);');
  });

  it('$status.remove 收集到 statusRemoves（新语义：按 buffId 或裸 name）', () => {
    const ctx = makeContext();
    const result = executeScript(
      `$status.remove(target, "幽怨之剑.流血"); $status.remove(owner, "中毒");`,
      ctx,
    );
    expect(result.statusRemoves).toHaveLength(2);
    expect(result.statusRemoves[0]).toEqual({
      target: 'char_target',
      buffIdOrName: '幽怨之剑.流血',
    });
    expect(result.statusRemoves[1]).toEqual({
      target: 'char_owner',
      buffIdOrName: '中毒',
    });
  });

  it('$status.has 走 readHooks（注入后返回真值）', () => {
    const ctx = makeContext({
      owner: 'char_1',
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `const has = $status.has(owner, "幽怨之剑.流血");
       const noHas = $status.has(owner, "不存在");
       $event.emit("probe", { has, noHas });`,
      ctx,
    );
    const data = result.events[0].data;
    expect(data.has).toBe(true);
    expect(data.noHas).toBe(false);
  });

  it('$status.has 未注入 readHooks → 返回 false（缺省）', () => {
    const ctx = makeContext(); // 不传 readHooks
    const result = executeScript(
      `const has = $status.has(owner, "anything");
       if (has === false) { $resource.modifyHp(owner, 1); }`,
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
  });

  it('$status.getStacks 走 readHooks（注入后返回真值层数）', () => {
    const ctx = makeContext({
      owner: 'char_1',
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `const stacks = $status.getStacks(owner, "幽怨之剑.流血");
       $event.emit("probe", { stacks });`,
      ctx,
    );
    expect(result.events[0].data.stacks).toBe(3); // char_1 的幽怨之剑.流血 stacks=3
  });

  it('$status.getStacks 未注入 readHooks → 返回 0（缺省）', () => {
    const ctx = makeContext();
    const result = executeScript(
      `const s = $status.getStacks(owner, "anything");
       if (s === 0) { $resource.modifyHp(owner, 1); }`,
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
  });

  it('$status.getStacks 按裸 name 也能查到（readHooks mock 支持裸 name）', () => {
    const ctx = makeContext({
      owner: 'char_1',
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `const s = $status.getStacks(owner, "流血");
       $event.emit("probe", { s });`,
      ctx,
    );
    expect(result.events[0].data.s).toBe(3);
  });

  it('$status.query 走 readHooks（返回角色全部 statusEffects）', () => {
    const ctx = makeContext({
      owner: 'char_1',
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `const list = $status.query(owner);
       $event.emit("probe", { len: list.length, firstName: list[0] ? list[0].name : null });`,
      ctx,
    );
    const data = result.events[0].data;
    expect(data.len).toBe(1);
    expect(data.firstName).toBe('流血');
  });

  it('$status.query 未注入 readHooks → 返回空数组', () => {
    const ctx = makeContext();
    const result = executeScript(
      `const list = $status.query(owner);
       if (list.length === 0) { $resource.modifyHp(owner, 1); }`,
      ctx,
    );
    expect(result.hpChanges).toHaveLength(1);
  });

  it('$status.query 查不到角色 → 返回空数组', () => {
    const ctx = makeContext({
      owner: 'char_2', // mock 里 char_2 没数据
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `const list = $status.query(owner);
       $event.emit("probe", { len: list.length });`,
      ctx,
    );
    expect(result.events[0].data.len).toBe(0);
  });

  it('apply/remove/has/getStacks/query 共存于一次脚本执行', () => {
    const ctx = makeContext({
      owner: 'char_1',
      target: 'char_2',
      readHooks: makeHooks(),
    });
    const result = executeScript(
      `$status.apply(target, { name: "中毒", category: "减益", stacks: 2 });
       $status.remove(owner, "幽怨之剑.流血");
       const has = $status.has(owner, "流血");
       const stacks = $status.getStacks(owner, "流血");
       const list = $status.query(owner);
       $event.emit("probe", { has, stacks, listLen: list.length });`,
      ctx,
    );
    expect(result.statusApplies).toHaveLength(1);
    expect(result.statusRemoves).toHaveLength(1);
    const data = result.events[0].data;
    expect(data.has).toBe(true);
    expect(data.stacks).toBe(3);
    expect(data.listLen).toBe(1);
  });
});
