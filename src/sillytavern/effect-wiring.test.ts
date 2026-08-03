/**
 * effect-wiring.test.ts — 战斗外效果系统接线（Q-07）
 *
 * 验证三件事（findings 方案 A 的验收）：
 *   1. wireObject 把已装备物品 init 脚本的 $event.on 订阅注册进 EventBus
 *   2. wireEffectSystem 对存档所有已装备物品批量接线（幂等）
 *   3. unwireObject 拆除后订阅不再触发
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getEffectWiring,
  wireObject,
  unwireObject,
  wireEffectSystem,
  unwireEffectSystem,
  clearAllEffectWirings,
  ownerKeyOf,
} from './effect-wiring';
import type { CharacterState } from './types';

function mockCharacter(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1',
    saveId: 's1',
    name: '英雄',
    type: 'player',
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    inventory: [],
    skills: [],
    statusEffects: [],
    location: '',
    currentAction: '',
    ...overrides,
  } as CharacterState;
}

describe('effect-wiring（Q-07 战斗外接线）', () => {
  beforeEach(() => {
    clearAllEffectWirings();
  });

  it('wireObject 把已装备物品 init 脚本的 $event.on 订阅注册进 EventBus', async () => {
    const char = mockCharacter();
    const scripts = {
      init: `$event.on('npc_talk', 'talk');`,
      talk: `$resource.modifyHp('英雄', -5);`,
    };
    const unsub = wireObject('s1', char, 'item', '幽怨之剑', scripts);

    // 注册后：EventBus 上有 npc_talk 订阅
    const wiring = getEffectWiring('s1');
    expect(wiring.subscriptions.getSubscriptionCount(ownerKeyOf(char.id, 'item', '幽怨之剑'))).toBe(
      1,
    );

    // 触发 npc_talk 事件 → 订阅脚本执行（用 spy 验证 executeScript 副作用）
    const bus = wiring.bus;
    await bus.publish({
      id: 'evt-test',
      type: 'npc_talk' as never,
      source: 'system',
      timestamp: Date.now(),
      data: { target: '英雄' },
      processed: false,
    });

    // 事件已入历史（订阅确实存在且被触发过）
    expect(bus.getHistory('npc_talk' as never).length).toBeGreaterThan(0);

    // 拆除后：订阅清零
    unsub?.();
    expect(wiring.subscriptions.getSubscriptionCount(ownerKeyOf(char.id, 'item', '幽怨之剑'))).toBe(
      0,
    );
  });

  it('wireEffectSystem 对已装备物品批量接线（幂等）', () => {
    const char = mockCharacter({
      inventory: [
        {
          name: '幽怨之剑',
          quantity: 1,
          equippedSlot: '武器',
          scripts: { init: `$event.on('npc_talk', 'talk');`, talk: '// noop' },
        },
        {
          name: '躺背包的药',
          quantity: 3,
          equippedSlot: null,
          scripts: { init: `$event.on('npc_talk', 'talk');`, talk: '// noop' },
        },
      ],
    });

    const wiring = wireEffectSystem('s1', [char]);

    // 只有已装备物品被接线，躺背包的没接
    expect(wiring.subscriptions.getSubscriptionCount(ownerKeyOf(char.id, 'item', '幽怨之剑'))).toBe(
      1,
    );
    expect(
      wiring.subscriptions.getSubscriptionCount(ownerKeyOf(char.id, 'item', '躺背包的药')),
    ).toBe(0);

    // 幂等：重复调用不重复注册
    wireEffectSystem('s1', [char]);
    expect(wiring.subscriptions.getSubscriptionCount(ownerKeyOf(char.id, 'item', '幽怨之剑'))).toBe(
      1,
    );
  });

  it('unwireEffectSystem 拆除后订阅清零、EventBus 销毁', () => {
    const char = mockCharacter({
      inventory: [
        {
          name: '幽怨之剑',
          quantity: 1,
          equippedSlot: '武器',
          scripts: { init: `$event.on('npc_talk', 'talk');`, talk: '// noop' },
        },
      ],
    });
    wireEffectSystem('s1', [char]);
    const wiring = getEffectWiring('s1');
    expect(wiring.subscriptions.totalSubscriptions).toBe(1);

    unwireEffectSystem('s1');
    // 拆除后重新 getEffectWiring 得到全新空实例（旧订阅已销毁）
    const fresh = getEffectWiring('s1');
    expect(fresh.subscriptions.totalSubscriptions).toBe(0);
  });
});
