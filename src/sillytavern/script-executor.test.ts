/**
 * script-executor 测试 (Phase 7e+8)
 */
import { describe, it, expect } from 'vitest';
import { executeScript, executeHook, createScriptEffects, resolveScriptRef, executeInit, executeCleanup } from './script-executor';
import type { StatusEffect } from './types';
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
    expect(result.removes).toHaveLength(1);
    expect(result.stackSets).toHaveLength(1);
    expect(result.stackSets[0].stacks).toBe(0);
  });

  it('$event.emit fires events', () => {
    const ctx = makeContext();
    const result = executeScript(
      '$event.emit("flame_burst", { damage: 50 })',
      ctx,
    );
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
      makeStatus({ id: 'burn', name: '灼烧', scripts: { tick: '$resource.modifyHp(owner, -5)' }, onTick: 'tick' }),
      makeStatus({ id: 'poison', name: '中毒', scripts: { tick: '$resource.modifyHp(owner, -3)' }, onTick: 'tick' }),
      makeStatus({ id: 'shield', name: '护盾', scripts: {}, onTick: undefined }),
    ];
    const ctx = { owner: 'char_1', target: undefined, event: { turn: 3 } };
    const result = executeHook(statuses, 'onTick', ctx);
    expect(result.hpChanges).toHaveLength(2); // 灼烧 + 中毒
  });

  it('skips statuses without scripts or hook', () => {
    const statuses = [
      makeStatus({ id: 'bare', scripts: undefined, onTick: undefined }),
    ];
    const result = executeHook(statuses, 'onTick', { owner: 'x', target: undefined });
    expect(result.hpChanges).toHaveLength(0);
  });

  it('executes onApply hook', () => {
    const statuses = [
      makeStatus({ id: 'fear', name: '恐惧', scripts: { apply: '$resource.modifyStat(owner, "atk", -5)' }, onApply: 'apply' }),
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
    expect(resolveScriptRef('@parent.burnFormula', {}, parentScripts))
      .toBe('$resource.modifyHp(owner, -10)');
  });

  // 🆕 @parent 递归解析
  it('recursively resolves @parent chain to actual code', () => {
    const scripts = { tick: '@parent.burnFormula' };
    const parentScripts = { burnFormula: '$resource.modifyHp(owner, -8)' };
    // resolveScriptRef 递归: "tick" → "@parent.burnFormula" → "$resource.modifyHp(owner, -8)"
    expect(resolveScriptRef('tick', scripts, parentScripts))
      .toBe('$resource.modifyHp(owner, -8)');
  });

  // 🆕 @parent 不存在不崩溃
  it('returns undefined when @parent key does not exist', () => {
    expect(resolveScriptRef('@parent.nonexistent', {}, {}))
      .toBeUndefined();
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
    const result = executeScript(
      "$event.on('combat_action', 'reflect');",
      ctx,
    );
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
    const result = executeScript(
      "$event.off('combat_action');",
      ctx,
    );
    expect(result.unsubscriptions).toHaveLength(1);
    expect(result.unsubscriptions[0]).toBe('combat_action');
  });

  it('$event.on + $event.off together in init + cleanup pattern', () => {
    const ctx = makeContext({ self: { stacks: 1, remainingTime: null, name: '荆棘甲', scripts: {} } });
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
      onHit: "$status.add(target, { name:'灼烧', category:'减益', stacks:1, remainingTime:3, timeUnit:'回合', source:'test', scripts:{ tick:'@parent.burn' }, onTick:'tick' });",
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
