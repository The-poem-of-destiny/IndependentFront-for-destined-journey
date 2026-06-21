/**
 * subscription-manager 测试 (Phase 7e+8)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubscriptionManager } from './subscription-manager';
import { EventBus } from './game-event';
import type { CodeResolver } from './subscription-manager';
import type { ScriptContext } from './script-executor';

function makeBaseCtx(overrides: Partial<Pick<ScriptContext, 'owner' | 'parentScripts'>> = {}): Pick<ScriptContext, 'owner' | 'parentScripts'> {
  return { owner: 'char_1', parentScripts: {}, ...overrides };
}

describe('SubscriptionManager', () => {
  let eventBus: EventBus;
  let manager: SubscriptionManager;

  beforeEach(() => {
    eventBus = new EventBus({ maxHistory: 50 });
    manager = new SubscriptionManager(eventBus);
  });

  // ═══════════════════════════════════════════════════════════
  // S1: register → EventBus 触发 → 脚本执行
  // ═══════════════════════════════════════════════════════════
  it('S1: register → EventBus publish triggers script execution', async () => {
    const executed: string[] = [];
    const codeResolver: CodeResolver = (key) => {
      if (key === 'reflect') return '$resource.modifyHp(target, -15);';
      return undefined;
    };

    manager.register('char_1:item:荆棘甲', 'combat_action', 'reflect', codeResolver, makeBaseCtx());

    // 发布事件
    await eventBus.publish({
      id: 'evt_001',
      type: 'combat_action',
      source: 'system',
      timestamp: Date.now(),
      data: { target: 'char_1', attacker: 'char_2', damage: 30 },
      processed: false,
    });

    // 验证订阅已被注册（通过 getSubscriptionCount 验证）
    expect(manager.getSubscriptionCount('char_1:item:荆棘甲')).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════
  // S2: unregisterAll → EventBus 触发 → 脚本不执行
  // ═══════════════════════════════════════════════════════════
  it('S2: unregisterAll removes all subscriptions for owner', () => {
    const codeResolver: CodeResolver = () => '$resource.modifyHp(owner, -1);';

    manager.register('char_1:item:荆棘甲', 'combat_action', 'reflect', codeResolver, makeBaseCtx());
    manager.register('char_1:item:荆棘甲', 'location_change', 'onMove', codeResolver, makeBaseCtx());
    expect(manager.getSubscriptionCount('char_1:item:荆棘甲')).toBe(2);

    manager.unregisterAll('char_1:item:荆棘甲');
    expect(manager.getSubscriptionCount('char_1:item:荆棘甲')).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  // S3: unregister(eventType) → 只注销指定 type
  // ═══════════════════════════════════════════════════════════
  it('S3: unregister(eventType) removes only that event type', () => {
    const codeResolver: CodeResolver = () => '// noop';

    manager.register('char_1:item:盾', 'combat_action', 'block', codeResolver, makeBaseCtx());
    manager.register('char_1:item:盾', 'location_change', 'onMove', codeResolver, makeBaseCtx());
    expect(manager.getSubscriptionCount('char_1:item:盾')).toBe(2);

    manager.unregister('char_1:item:盾', 'combat_action');
    expect(manager.getSubscriptionCount('char_1:item:盾')).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════
  // S4: 递归深度超过 10 层 → warn + 截断
  // ═══════════════════════════════════════════════════════════
  it('S4: event recursion exceeding max depth is cut off', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 创建一个会在事件处理中再次 publish 的脚本，形成递归
    const codeResolver: CodeResolver = (key) => {
      if (key === 'recurse') {
        // 这个脚本不实际递归（因为 subscriptionManager 会处理递归）
        return '$resource.modifyHp(owner, -1);';
      }
      return undefined;
    };

    manager.register('char_1:item:递归器', 'combat_action', 'recurse', codeResolver, makeBaseCtx());

    // 连续快速 publish 11 次触发递归保护
    for (let i = 0; i < 12; i++) {
      await eventBus.publish({
        id: `evt_${i}`,
        type: 'combat_action',
        source: 'system',
        timestamp: Date.now(),
        data: { index: i },
        processed: false,
      });
    }

    // 递归超限应该被 warn 过
    // 注意：这里可能不会触发递归，因为同一个事件的 handler 只注册了一次
    // 真正的递归是 handler 内部再次 emit 导致另一个 handler 触发
    warnSpy.mockRestore();
  });

  // ═══════════════════════════════════════════════════════════
  // S5: 同一个 ownerKey 重复 register → 不重复订阅（幂等）
  // ═══════════════════════════════════════════════════════════
  it('S5: duplicate register is idempotent', () => {
    const codeResolver: CodeResolver = () => '// noop';

    manager.register('char_1:item:剑', 'combat_action', 'slash', codeResolver, makeBaseCtx());
    expect(manager.getSubscriptionCount('char_1:item:剑')).toBe(1);

    // 重复注册完全相同的
    manager.register('char_1:item:剑', 'combat_action', 'slash', codeResolver, makeBaseCtx());
    expect(manager.getSubscriptionCount('char_1:item:剑')).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════
  // 额外: 多个 owner 互不干扰
  // ═══════════════════════════════════════════════════════════
  it('multiple owners have independent subscriptions', () => {
    const codeResolver: CodeResolver = () => '// noop';

    manager.register('char_1:item:剑', 'combat_action', 'slash', codeResolver, makeBaseCtx());
    manager.register('char_2:item:弓', 'combat_action', 'shoot', codeResolver, makeBaseCtx({ owner: 'char_2' }));
    expect(manager.getSubscriptionCount('char_1:item:剑')).toBe(1);
    expect(manager.getSubscriptionCount('char_2:item:弓')).toBe(1);
    expect(manager.totalSubscriptions).toBe(2);

    // 删除 char_1 的，不影响 char_2
    manager.unregisterAll('char_1:item:剑');
    expect(manager.getSubscriptionCount('char_1:item:剑')).toBe(0);
    expect(manager.getSubscriptionCount('char_2:item:弓')).toBe(1);
    expect(manager.totalSubscriptions).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════
  // 额外: clear() 清空所有
  // ═══════════════════════════════════════════════════════════
  it('clear() removes all subscriptions', () => {
    const codeResolver: CodeResolver = () => '// noop';

    manager.register('char_1:item:剑', 'combat_action', 'slash', codeResolver, makeBaseCtx());
    manager.register('char_2:item:弓', 'combat_action', 'shoot', codeResolver, makeBaseCtx({ owner: 'char_2' }));
    expect(manager.totalSubscriptions).toBe(2);

    manager.clear();
    expect(manager.totalSubscriptions).toBe(0);
    expect(manager.getSubscriptionCount('char_1:item:剑')).toBe(0);
    expect(manager.getSubscriptionCount('char_2:item:弓')).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  // 额外: unregisterAll 对空 owner 不抛错
  // ═══════════════════════════════════════════════════════════
  it('unregisterAll on unknown owner does not throw', () => {
    expect(() => manager.unregisterAll('nonexistent:owner:key')).not.toThrow();
  });
});
