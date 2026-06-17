/**
 * game-event.ts — GameEvent 系统测试
 *
 * 覆盖: EventBus 类 / 事件工厂 / EventBus Registry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EventBus,
  createGameEvent,
  createCombatEvent,
  createCraftEvent,
  createDiceEvent,
  createStatusEffectEvent,
  createLocationEvent,
  createPlotTriggerEvent,
  markEventProcessed,
  getEventBus,
  destroyEventBus,
  destroyAllEventBuses,
} from './game-event';
import type {
  GameEvent,
  GameEventType,
  CombatActionRequest,
  CraftActionRequest,
  DiceRollPayload,
} from './types';

// ========== Helpers ==========

function makeCombatAction(overrides: Partial<CombatActionRequest> = {}): CombatActionRequest {
  return {
    attackerId: 'char_1',
    defenderId: 'char_2',
    action: 'attack',
    ...overrides,
  };
}

function makeCraftRequest(overrides: Partial<CraftActionRequest> = {}): CraftActionRequest {
  return {
    characterId: 'char_1',
    industry: '锻造',
    stage: '成品',
    productName: '铁剑',
    targetQuality: '普通',
    quantity: 1,
    recipeId: 'recipe_001',
    hasRecipe: true,
    materials: [{ itemId: 'iron_ore', itemName: '铁矿石', quantity: 3, quality: '普通', dcModifier: 0 }],
    crafterTier: 1,
    crafterLevel: 3,
    coreAttributeValue: 10,
    resourceCosts: { hp: 0, mp: 5, sp: 10 },
    currentResources: { hp: 100, mp: 50, sp: 30 },
    d20Rolls: [15],
    ...overrides,
  };
}

function makeDicePayload(overrides: Partial<DiceRollPayload> = {}): DiceRollPayload {
  return {
    formula: 'd20',
    modifier: 2,
    reason: '攻击检定',
    ...overrides,
  };
}

// ========== EventBus 核心 ==========

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ---------- subscribe + publish ----------

  it('subscribe + publish 应触发对应类型处理器', async () => {
    const handler = vi.fn();
    bus.subscribe('combat_action', handler);
    const event = createGameEvent('combat_action', { test: true });
    await bus.publish(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('类型特定处理器仅对匹配类型触发，忽略其他类型', async () => {
    const combatHandler = vi.fn();
    const craftHandler = vi.fn();

    bus.subscribe('combat_action', combatHandler);
    bus.subscribe('craft_action', craftHandler);

    await bus.publish(createGameEvent('combat_action', {}));

    expect(combatHandler).toHaveBeenCalledTimes(1);
    expect(craftHandler).toHaveBeenCalledTimes(0);
  });

  it('subscribeAll 应对所有事件类型触发', async () => {
    const handler = vi.fn();
    bus.subscribeAll(handler);

    await bus.publish(createGameEvent('combat_action', {}));
    await bus.publish(createGameEvent('craft_action', {}));
    await bus.publish(createGameEvent('system', {}));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('subscribeWhen 应在 filter 返回 true 时触发', async () => {
    const handler = vi.fn();
    bus.subscribeWhen(
      (e) => e.type === 'combat_action',
      handler,
    );

    await bus.publish(createGameEvent('combat_action', {}));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('subscribeWhen 应在 filter 返回 false 时不触发', async () => {
    const handler = vi.fn();
    bus.subscribeWhen(
      (e) => e.type === 'combat_action',
      handler,
    );

    await bus.publish(createGameEvent('craft_action', {}));

    expect(handler).toHaveBeenCalledTimes(0);
  });

  // ---------- unsubscribe ----------

  it('subscribe 返回的取消函数应停止类型处理器', async () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('combat_action', handler);

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(1); // 未再触发
  });

  it('subscribeAll 返回的取消函数应停止全局处理器', async () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribeAll(handler);

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    await bus.publish(createGameEvent('craft_action', {}));
    expect(handler).toHaveBeenCalledTimes(1); // 未再触发
  });

  it('subscribeWhen 返回的取消函数应停止条件处理器', async () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribeWhen(
      (e) => e.type === 'combat_action',
      handler,
    );

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(1); // 未再触发
  });

  // ---------- publishAll ----------

  it('publishAll 应为每个事件触发处理器', async () => {
    const handler = vi.fn();
    bus.subscribeAll(handler);

    const events = [
      createGameEvent('combat_action', { n: 1 }),
      createGameEvent('craft_action', { n: 2 }),
      createGameEvent('status_effect', { n: 3 }),
    ];

    await bus.publishAll(events);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: { n: 1 } }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: { n: 2 } }));
    expect(handler).toHaveBeenNthCalledWith(3, expect.objectContaining({ data: { n: 3 } }));
  });

  // ---------- getHistory ----------

  it('getHistory 无参数应返回全部事件', async () => {
    await bus.publish(createGameEvent('combat_action', {}));
    await bus.publish(createGameEvent('craft_action', {}));

    expect(bus.getHistory()).toHaveLength(2);
  });

  it('getHistory 按类型过滤', async () => {
    await bus.publish(createGameEvent('combat_action', {}));
    await bus.publish(createGameEvent('craft_action', {}));
    await bus.publish(createGameEvent('combat_action', {}));

    const combatEvents = bus.getHistory('combat_action');
    expect(combatEvents).toHaveLength(2);
    expect(combatEvents.every((e) => e.type === 'combat_action')).toBe(true);
  });

  it('getHistory 带 limit 参数应返回最近 N 条', async () => {
    for (let i = 0; i < 10; i++) {
      await bus.publish(createGameEvent('system', { idx: i }));
    }

    const recent = bus.getHistory(undefined, 3);
    expect(recent).toHaveLength(3);
    // 应该是最新的 3 条 (idx 7, 8, 9)
    expect(recent[0].data.idx).toBe(7);
    expect(recent[1].data.idx).toBe(8);
    expect(recent[2].data.idx).toBe(9);
  });

  it('getHistory 按类型 + limit 同时过滤', async () => {
    for (let i = 0; i < 5; i++) {
      await bus.publish(createGameEvent('combat_action', { idx: i }));
      await bus.publish(createGameEvent('craft_action', { idx: i }));
    }

    const recent = bus.getHistory('combat_action', 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].data.idx).toBe(3);
    expect(recent[1].data.idx).toBe(4);
  });

  // ---------- getLatest ----------

  it('getLatest 无参数应返回最新事件', async () => {
    await bus.publish(createGameEvent('combat_action', { first: true }));
    await bus.publish(createGameEvent('craft_action', { latest: true }));

    const latest = bus.getLatest();
    expect(latest).toBeDefined();
    expect(latest!.type).toBe('craft_action');
    expect(latest!.data.latest).toBe(true);
  });

  it('getLatest 按类型应返回该类型最新事件', async () => {
    await bus.publish(createGameEvent('combat_action', { idx: 1 }));
    await bus.publish(createGameEvent('craft_action', { idx: 2 }));
    await bus.publish(createGameEvent('combat_action', { idx: 3 }));

    const latestCombat = bus.getLatest('combat_action');
    expect(latestCombat!.data.idx).toBe(3);
  });

  it('getLatest 在无事件时应返回 undefined', () => {
    expect(bus.getLatest()).toBeUndefined();
  });

  it('getLatest 在无匹配类型时应返回 undefined', async () => {
    await bus.publish(createGameEvent('combat_action', {}));
    expect(bus.getLatest('craft_action')).toBeUndefined();
  });

  // ---------- clearHistory / clearHandlers ----------

  it('clearHistory 应清空全部事件历史', async () => {
    await bus.publish(createGameEvent('combat_action', {}));
    await bus.publish(createGameEvent('craft_action', {}));
    expect(bus.size).toBe(2);

    bus.clearHistory();
    expect(bus.size).toBe(0);
    expect(bus.getHistory()).toHaveLength(0);
  });

  it('clearHandlers 应移除所有处理器，后续发布不再触发', async () => {
    const handler = vi.fn();
    bus.subscribe('combat_action', handler);
    bus.subscribeAll(handler);

    bus.clearHandlers();

    await bus.publish(createGameEvent('combat_action', {}));
    expect(handler).toHaveBeenCalledTimes(0);
  });

  // ---------- size ----------

  it('size getter 应反映历史数量', async () => {
    expect(bus.size).toBe(0);
    await bus.publish(createGameEvent('system', {}));
    expect(bus.size).toBe(1);
    await bus.publish(createGameEvent('system', {}));
    expect(bus.size).toBe(2);
  });

  // ---------- maxHistory ----------

  it('maxHistory 应限制历史数量（默认 500）', () => {
    const customBus = new EventBus();
    // 发布超过 500 条
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 600; i++) {
      promises.push(customBus.publish(createGameEvent('system', { idx: i })));
    }
    // 我们需要顺序发布以确保 slice 行为正确
    // 先等待全部完成
    return Promise.all(promises).then(() => {
      expect(customBus.size).toBe(500);
      // 应该保留最新的 500 条 (idx 100-599)
      const history = customBus.getHistory();
      expect(history[0].data.idx).toBe(100);
      expect(history[history.length - 1].data.idx).toBe(599);
    });
  });

  it('maxHistory 应支持自定义值', async () => {
    const smallBus = new EventBus({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      await smallBus.publish(createGameEvent('system', { idx: i }));
    }
    expect(smallBus.size).toBe(5);
    const history = smallBus.getHistory();
    expect(history[0].data.idx).toBe(5);
    expect(history[4].data.idx).toBe(9);
  });

  // ---------- 错误隔离 ----------

  it('处理器抛出异常不应阻塞其他处理器', async () => {
    const badHandler = vi.fn().mockRejectedValue(new Error('BOOM'));
    const goodHandler = vi.fn();

    bus.subscribe('combat_action', badHandler);
    bus.subscribe('combat_action', goodHandler);

    await bus.publish(createGameEvent('combat_action', {}));

    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('全局处理器错误 + 类型处理器错误互不影响', async () => {
    const badGlobal = vi.fn().mockRejectedValue(new Error('GLOBAL_BOOM'));
    const goodGlobal = vi.fn();
    const badTyped = vi.fn().mockRejectedValue(new Error('TYPED_BOOM'));
    const goodTyped = vi.fn();

    bus.subscribeAll(badGlobal);
    bus.subscribeAll(goodGlobal);
    bus.subscribe('combat_action', badTyped);
    bus.subscribe('combat_action', goodTyped);

    await bus.publish(createGameEvent('combat_action', {}));

    expect(badGlobal).toHaveBeenCalledTimes(1);
    expect(goodGlobal).toHaveBeenCalledTimes(1);
    expect(badTyped).toHaveBeenCalledTimes(1);
    expect(goodTyped).toHaveBeenCalledTimes(1);
  });

  // ---------- async 处理器 ----------

  it('应支持 async 处理器', async () => {
    const results: number[] = [];
    bus.subscribe('combat_action', async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(1);
    });
    bus.subscribe('combat_action', async () => {
      results.push(2);
    });

    await bus.publish(createGameEvent('combat_action', {}));

    expect(results).toHaveLength(2);
  });
});

// ========== 事件工厂 ==========

describe('事件工厂', () => {
  it('createGameEvent 应构建正确结构', () => {
    const event = createGameEvent('combat_action', { power: 100 }, 'agent_story');

    expect(event.id).toMatch(/^evt_\d+_\d+$/);
    expect(event.type).toBe('combat_action');
    expect(event.source).toBe('agent_story');
    expect(event.timestamp).toBeTypeOf('number');
    expect(event.data).toEqual({ power: 100 });
    expect(event.processed).toBe(false);
    expect(event.result).toBeUndefined();
  });

  it('createGameEvent source 默认为 system', () => {
    const event = createGameEvent('system', {});
    expect(event.source).toBe('system');
  });

  it('createCombatEvent 应包含 CombatActionRequest 数据', () => {
    const action = makeCombatAction({ action: 'defend', skillId: 'shield_block' });
    const event = createCombatEvent(action, 'agent_story');

    expect(event.type).toBe('combat_action');
    expect(event.source).toBe('agent_story');
    expect(event.data.action).toEqual(action);
    expect(event.data.action.action).toBe('defend');
    expect(event.data.action.skillId).toBe('shield_block');
  });

  it('createCraftEvent 应包含 CraftActionRequest 数据', () => {
    const request = makeCraftRequest({ recipeId: 'potion_001', toolBonus: 3 });
    const event = createCraftEvent(request);

    expect(event.type).toBe('craft_action');
    expect(event.data.request).toEqual(request);
    expect(event.data.request.recipeId).toBe('potion_001');
  });

  it('createDiceEvent 应有 subtype dice_roll', () => {
    const payload = makeDicePayload({ formula: '2d6+3' });
    const event = createDiceEvent(payload, 'agent_story');

    expect(event.type).toBe('system');
    expect(event.data.subtype).toBe('dice_roll');
    expect(event.data.payload).toEqual(payload);
    expect(event.data.payload.formula).toBe('2d6+3');
  });

  it('createStatusEffectEvent 应包含 characterId/action/effectName', () => {
    const event = createStatusEffectEvent('char_42', 'add', '中毒', 'agent_vars');

    expect(event.type).toBe('status_effect');
    expect(event.data.characterId).toBe('char_42');
    expect(event.data.action).toBe('add');
    expect(event.data.effectName).toBe('中毒');
    expect(event.source).toBe('agent_vars');
  });

  it('createStatusEffectEvent source 默认为 system', () => {
    const event = createStatusEffectEvent('char_1', 'remove', '昏迷');
    expect(event.source).toBe('system');
  });

  it('createLocationEvent 应包含 from/to', () => {
    const event = createLocationEvent('char_99', '酒馆', '广场', 'agent_story');

    expect(event.type).toBe('location_change');
    expect(event.data.characterId).toBe('char_99');
    expect(event.data.from).toBe('酒馆');
    expect(event.data.to).toBe('广场');
    expect(event.source).toBe('agent_story');
  });

  it('createPlotTriggerEvent 应包含 plotEventId', () => {
    const event = createPlotTriggerEvent('plot_007', 'activate');

    expect(event.type).toBe('plot_trigger');
    expect(event.data.plotEventId).toBe('plot_007');
    expect(event.data.action).toBe('activate');
    // 默认 source 为 plot_post_check
    expect(event.source).toBe('plot_post_check');
  });

  it('createPlotTriggerEvent 应支持自定义 source', () => {
    const event = createPlotTriggerEvent('plot_008', 'complete', 'agent_plot');
    expect(event.source).toBe('agent_plot');
  });

  // ---------- markEventProcessed ----------

  it('markEventProcessed 应设置 processed=true 并附加 result', () => {
    const event = createGameEvent('combat_action', {});
    const result = { effectId: 'eff_1', success: true, patches: [] };

    const marked = markEventProcessed(event, result);

    expect(marked).toBe(event); // 返回同一对象引用
    expect(marked.processed).toBe(true);
    expect(marked.result).toEqual(result);
  });

  it('markEventProcessed 无 result 时仅设置 processed=true', () => {
    const event = createGameEvent('system', {});
    const marked = markEventProcessed(event);

    expect(marked.processed).toBe(true);
    expect(marked.result).toBeUndefined();
  });

  // ---------- 事件 ID 唯一性 ----------

  it('每个事件的 ID 应唯一', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const e = createGameEvent('system', {});
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });

  it('不同类型工厂创建的事件 ID 也应唯一', () => {
    const ids = new Set<string>();
    ids.add(createGameEvent('combat_action', {}).id);
    ids.add(createCombatEvent(makeCombatAction()).id);
    ids.add(createCraftEvent(makeCraftRequest()).id);
    ids.add(createDiceEvent(makeDicePayload()).id);
    ids.add(createStatusEffectEvent('c1', 'add', 'poison').id);
    ids.add(createLocationEvent('c2', 'A', 'B').id);
    ids.add(createPlotTriggerEvent('p1', 'activate').id);
    // 应有 7 个不重复 ID
    expect(ids.size).toBe(7);
  });
});

// ========== EventBus Registry ==========

describe('EventBus Registry', () => {
  afterEach(() => {
    // 每个测试后清理 Registry
    destroyAllEventBuses();
  });

  it('getEventBus 应为相同 saveId 返回同一实例', () => {
    const bus1 = getEventBus('save_alpha');
    const bus2 = getEventBus('save_alpha');
    expect(bus1).toBe(bus2);
  });

  it('getEventBus 应为不同 saveId 返回不同实例', () => {
    const bus1 = getEventBus('save_alpha');
    const bus2 = getEventBus('save_beta');
    expect(bus1).not.toBe(bus2);
    expect(bus1).toBeInstanceOf(EventBus);
    expect(bus2).toBeInstanceOf(EventBus);
  });

  it('destroyEventBus 应清理处理器 + 历史 + 从注册表中移除', () => {
    const bus = getEventBus('save_to_destroy');
    const handler = vi.fn();
    bus.subscribeAll(handler);
    // 发布一个事件
    return (async () => {
      await bus.publish(createGameEvent('system', {}));
      expect(bus.size).toBe(1);

      destroyEventBus('save_to_destroy');

      expect(bus.size).toBe(0); // clearHistory 后
      // 尝试再次发布 — 处理器已被清除
      await bus.publish(createGameEvent('system', {}));
      expect(handler).toHaveBeenCalledTimes(1); // 仅首次触发

      // 再次 getEventBus 应创建新实例
      const newBus = getEventBus('save_to_destroy');
      expect(newBus).not.toBe(bus);
    })();
  });

  it('destroyEventBus 对不存在的 saveId 应无操作（不抛出异常）', () => {
    expect(() => destroyEventBus('nonexistent')).not.toThrow();
  });

  it('destroyAllEventBuses 应清理所有总线', () => {
    const bus1 = getEventBus('save_1');
    const bus2 = getEventBus('save_2');

    destroyAllEventBuses();

    // 重新获取应创建新实例
    const newBus1 = getEventBus('save_1');
    const newBus2 = getEventBus('save_2');

    expect(newBus1).not.toBe(bus1);
    expect(newBus2).not.toBe(bus2);
  });

  it('isolated — 不同 saveId 的事件不会交叉触发处理器', async () => {
    const busAlpha = getEventBus('alpha');
    const busBeta = getEventBus('beta');

    const alphaHandler = vi.fn();
    const betaHandler = vi.fn();

    busAlpha.subscribeAll(alphaHandler);
    busBeta.subscribeAll(betaHandler);

    await busAlpha.publish(createGameEvent('combat_action', {}));

    expect(alphaHandler).toHaveBeenCalledTimes(1);
    expect(betaHandler).toHaveBeenCalledTimes(0);
  });
});

// ========== 边缘情况 ==========

describe('边缘情况', () => {
  it('publishAll 空数组应无副作用', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribeAll(handler);

    await bus.publishAll([]);

    expect(handler).toHaveBeenCalledTimes(0);
    expect(bus.size).toBe(0);
  });

  it('同一处理器重复 subscribe 不应重复触发（Set 去重）', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.subscribe('combat_action', handler);
    bus.subscribe('combat_action', handler); // 重复订阅

    await bus.publish(createGameEvent('combat_action', {}));

    // Set 自动去重，应只触发一次
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('subscribeWhen 多次 filter=fn 各自独立取消', async () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    const unsub1 = bus.subscribeWhen((e) => e.data.era === 'early', h1);
    bus.subscribeWhen((e) => e.data.era === 'late', h2);

    await bus.publish(createGameEvent('system', { era: 'early' }));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(0);

    unsub1();

    await bus.publish(createGameEvent('system', { era: 'early' }));
    expect(h1).toHaveBeenCalledTimes(1); // 未再触发
  });
});
