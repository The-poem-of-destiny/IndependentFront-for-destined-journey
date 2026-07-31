/**
 * script-registry 测试 (M1 战斗 v2 · 任务 1.3)
 *
 * ScriptRegistry 是 EventBus.subscribeChain 的声明式 facade。
 * 测试用真实 EventBus（不 mock），验证端到端：声明注册 → emitChain 链式变换 → 注销失效。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScriptRegistry } from './script-registry';
import { EventBus, createGameEvent } from './game-event';
import type { ScriptDeclaration } from './script-registry';

describe('ScriptRegistry', () => {
  let bus: EventBus;
  let registry: ScriptRegistry;

  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
    registry = new ScriptRegistry(bus);
  });

  // ═══════════════════════════════════════════════════════════
  // 基础注册/触发
  // ═══════════════════════════════════════════════════════════

  it('register 单条 → emitChain 触发 handler 变换 params', async () => {
    registry.register(
      {
        event: 'combat.attack.collect_attacker_mods',
        source: '力量戒指',
        owner: 'char_1',
        handler: (p: any) => ({ ...p, baseDamage: p.baseDamage + 100 }),
      },
      'char_1:item:力量戒指',
    );

    const result = await bus.emitChain(
      'combat.attack.collect_attacker_mods',
      { baseDamage: 50 },
      { combatants: ['char_1'] },
    );
    expect(result).toEqual({ baseDamage: 150 });
  });

  it('registerAll 批量注册多条 → 链式累加', async () => {
    const decls: ScriptDeclaration[] = [1, 2, 3].map((n) => ({
      event: 'mod',
      source: `戒指${n}`,
      owner: 'char_1',
      handler: (p: any) => ({ ...p, baseDamage: p.baseDamage + 100 }),
    }));
    registry.registerAll(decls, 'char_1:item:戒指组');

    const result = await bus.emitChain('mod', { baseDamage: 0 }, { combatants: ['char_1'] });
    expect(result).toEqual({ baseDamage: 300 });
  });

  // ═══════════════════════════════════════════════════════════
  // 注销生命周期
  // ═══════════════════════════════════════════════════════════

  it('unregisterOwner 全量注销后 emitChain 不再触发', async () => {
    registry.register(
      { event: 'mod', source: '剑', owner: 'char_1', handler: (p: any) => ({ ...p, hit: true }) },
      'char_1:item:剑',
    );
    expect(registry.getDeclarationCount('char_1:item:剑')).toBe(1);

    registry.unregisterOwner('char_1:item:剑');
    expect(registry.getDeclarationCount('char_1:item:剑')).toBe(0);

    const result = await bus.emitChain('mod', { v: 1 }, { combatants: ['char_1'] });
    expect(result).toEqual({ v: 1 }); // 无变换
  });

  it('register 返回的注销函数只注销该条（不影响同 owner 其他声明）', async () => {
    const unsub = registry.register(
      { event: 'mod', source: 'A', owner: 'char_1', handler: (p: any) => ({ ...p, a: true }) },
      'char_1:item:A',
    );
    registry.register(
      { event: 'mod', source: 'B', owner: 'char_1', handler: (p: any) => ({ ...p, b: true }) },
      'char_1:item:B',
    );

    unsub();
    const result = await bus.emitChain('mod', {}, { combatants: ['char_1'] });
    expect(result).toEqual({ b: true }); // A 注销，B 仍在
  });

  // ═══════════════════════════════════════════════════════════
  // 条件 / 优先级 / 在场过滤（验证元数据正确转发给 subscribeChain）
  // ═══════════════════════════════════════════════════════════

  it('condition 返回 false 的声明被跳过', async () => {
    registry.register(
      {
        event: 'mod',
        source: '条件戒',
        owner: 'char_1',
        handler: (p: any) => ({ ...p, applied: true }),
        condition: (p: any) => p.baseDamage > 100,
      },
      'char_1:item:条件戒',
    );

    // baseDamage=50 不满足 >100，跳过
    const r1 = await bus.emitChain('mod', { baseDamage: 50 }, { combatants: ['char_1'] });
    expect(r1).toEqual({ baseDamage: 50 });
    // baseDamage=200 满足，应用
    const r2 = await bus.emitChain('mod', { baseDamage: 200 }, { combatants: ['char_1'] });
    expect(r2).toEqual({ baseDamage: 200, applied: true });
  });

  it('priority 决定多条声明的执行顺序（升序：小的先）', async () => {
    const order: string[] = [];
    registry.register(
      {
        event: 'mod',
        source: '高优',
        owner: 'char_1',
        priority: 10,
        handler: (p: any) => {
          order.push('高');
          return p;
        },
      },
      'char_1:item:高',
    );
    registry.register(
      {
        event: 'mod',
        source: '低优',
        owner: 'char_1',
        priority: 1,
        handler: (p: any) => {
          order.push('低');
          return p;
        },
      },
      'char_1:item:低',
    );

    await bus.emitChain('mod', {}, { combatants: ['char_1'] });
    expect(order).toEqual(['低', '高']); // priority 1 先于 10
  });

  it('owner 不在 combatants 的声明被在场过滤跳过', async () => {
    registry.register(
      {
        event: 'mod',
        source: '远剑',
        owner: 'char_99',
        handler: (p: any) => ({ ...p, far: true }),
      },
      'char_99:item:远剑',
    );
    registry.register(
      {
        event: 'mod',
        source: '近剑',
        owner: 'char_1',
        handler: (p: any) => ({ ...p, near: true }),
      },
      'char_1:item:近剑',
    );

    const result = await bus.emitChain('mod', {}, { combatants: ['char_1'] });
    expect(result).toEqual({ near: true }); // char_99 远剑被过滤
  });

  // ═══════════════════════════════════════════════════════════
  // 多 owner / clear / 边缘
  // ═══════════════════════════════════════════════════════════

  it('多个 ownerKey 互不干扰', () => {
    registry.register({ event: 'a', source: 's1', handler: (p) => p }, 'owner:A');
    registry.register({ event: 'b', source: 's2', handler: (p) => p }, 'owner:B');
    expect(registry.getDeclarationCount('owner:A')).toBe(1);
    expect(registry.getDeclarationCount('owner:B')).toBe(1);

    registry.unregisterOwner('owner:A');
    expect(registry.getDeclarationCount('owner:A')).toBe(0);
    expect(registry.getDeclarationCount('owner:B')).toBe(1); // B 不受影响
  });

  it('clear 清空所有 owner 的声明', async () => {
    registry.register(
      { event: 'mod', source: 's1', owner: 'c1', handler: (p: any) => ({ ...p, x: 1 }) },
      'c1:item:s1',
    );
    registry.register(
      { event: 'mod', source: 's2', owner: 'c2', handler: (p: any) => ({ ...p, y: 2 }) },
      'c2:item:s2',
    );

    registry.clear();
    expect(registry.getDeclarationCount('c1:item:s1')).toBe(0);
    expect(registry.getDeclarationCount('c2:item:s2')).toBe(0);

    const r = await bus.emitChain('mod', {}, { combatants: ['c1', 'c2'] });
    expect(r).toEqual({}); // 全清后不再变换
  });

  it('unregisterOwner 对未知 ownerKey 不抛错', () => {
    expect(() => registry.unregisterOwner('nonexistent:owner')).not.toThrow();
  });

  it('声明式（emitChain）与命令式（publish）走不同注册表，互不串台（任务 1.6 兼容核心）', async () => {
    registry.register(
      {
        event: 'mod',
        source: '声明',
        owner: 'char_1',
        handler: (p: any) => ({ ...p, declared: true }),
      },
      'char_1:item:声明',
    );
    const pubHandler = vi.fn();
    bus.subscribe('combat_action', pubHandler);

    // emitChain 触发声明式 handler，但不触发命令式 pubHandler
    const r = await bus.emitChain('mod', {}, { combatants: ['char_1'] });
    expect(r).toEqual({ declared: true });
    expect(pubHandler).not.toHaveBeenCalled();

    // publish 触发命令式，但不影响链式注册表
    await bus.publish(createGameEvent('combat_action', { x: 1 }));
    expect(pubHandler).toHaveBeenCalledTimes(1);
  });
});
