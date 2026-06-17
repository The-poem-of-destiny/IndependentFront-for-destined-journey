/**
 * GameEvent 系统 — 事件总线 + 事件工厂
 *
 * Phase 4.5 核心模块。职责:
 * 1. 按 SaveSlot 实例化的 EventBus（效果实例随存档隔离）
 * 2. 事件创建（工厂函数）
 * 3. 事件处理管线（pre-processor → processor → post-processor）
 * 4. 事件历史记录
 *
 * EventBus 引入时机: Phase 6c（按需）— 当前用声明式验证覆盖度
 */

import type {
  GameEvent, GameEventType,
  StatePatch, EffectDefinition,
  CombatActionRequest, CraftActionRequest,
  DiceRollPayload,
} from './types';

// ========== EventBus ==========

export type EventHandler = (event: GameEvent) => Promise<void> | void;
export type EventFilter = (event: GameEvent) => boolean;

export interface EventBusConfig {
  /** 最大保留事件数 */
  maxHistory?: number;
}

export class EventBus {
  private handlers: Map<GameEventType, Set<EventHandler>> = new Map();
  private globalHandlers: Set<EventHandler> = new Set();
  private history: GameEvent[] = [];
  private maxHistory: number;

  constructor(config: EventBusConfig = {}) {
    this.maxHistory = config.maxHistory ?? 500;
  }

  // ========== 事件发布 ==========

  /** 发布事件（同步通知所有处理器） */
  async publish(event: GameEvent): Promise<void> {
    // 记录历史
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    // 全局处理器
    for (const handler of this.globalHandlers) {
      try {
        await handler(event);
      } catch {
        // 处理器错误不阻塞其他处理器
      }
    }

    // 类型特定处理器
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch {
          // 处理器错误不阻塞其他处理器
        }
      }
    }
  }

  /** 批量发布事件 */
  async publishAll(events: GameEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  // ========== 订阅 ==========

  /** 订阅特定类型的事件 */
  subscribe(type: GameEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    // 返回取消订阅函数
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /** 订阅所有事件 */
  subscribeAll(handler: EventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  /** 条件订阅 — 仅当 filter 返回 true 时触发 */
  subscribeWhen(filter: EventFilter, handler: EventHandler): () => void {
    const wrapped: EventHandler = async (event) => {
      if (filter(event)) {
        await handler(event);
      }
    };
    return this.subscribeAll(wrapped);
  }

  // ========== 查询 ==========

  /** 获取事件历史 */
  getHistory(type?: GameEventType, limit?: number): GameEvent[] {
    let filtered = type
      ? this.history.filter(e => e.type === type)
      : this.history;
    if (limit) {
      filtered = filtered.slice(-limit);
    }
    return filtered;
  }

  /** 获取最新事件 */
  getLatest(type?: GameEventType): GameEvent | undefined {
    if (type) {
      return this.history.filter(e => e.type === type).pop();
    }
    return this.history[this.history.length - 1];
  }

  /** 清空历史 */
  clearHistory(): void {
    this.history = [];
  }

  /** 移除所有处理器 */
  clearHandlers(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }

  /** 事件数量 */
  get size(): number {
    return this.history.length;
  }
}

// ========== 事件工厂 ==========

let eventCounter = 0;

function nextEventId(): string {
  eventCounter++;
  return `evt_${Date.now()}_${eventCounter}`;
}

/** 创建通用 GameEvent */
export function createGameEvent(
  type: GameEventType,
  data: Record<string, any>,
  source: string = 'system',
): GameEvent {
  return {
    id: nextEventId(),
    type,
    source,
    timestamp: Date.now(),
    data,
    processed: false,
  };
}

/** 创建战斗事件 */
export function createCombatEvent(
  action: CombatActionRequest,
  source: string = 'system',
): GameEvent {
  return createGameEvent('combat_action', { action }, source);
}

/** 创建制作事件 */
export function createCraftEvent(
  request: CraftActionRequest,
  source: string = 'system',
): GameEvent {
  return createGameEvent('craft_action', { request }, source);
}

/** 创建骰子事件 */
export function createDiceEvent(
  payload: DiceRollPayload,
  source: string = 'system',
): GameEvent {
  return createGameEvent('system', { subtype: 'dice_roll', payload }, source);
}

/** 创建状态效果事件 */
export function createStatusEffectEvent(
  characterId: string,
  action: 'add' | 'remove' | 'update',
  effectName: string,
  source: string = 'system',
): GameEvent {
  return createGameEvent('status_effect', {
    characterId,
    action,
    effectName,
  }, source);
}

/** 创建位置变更事件 */
export function createLocationEvent(
  characterId: string,
  from: string,
  to: string,
  source: string = 'system',
): GameEvent {
  return createGameEvent('location_change', {
    characterId,
    from,
    to,
  }, source);
}

/** 创建剧情触发事件 */
export function createPlotTriggerEvent(
  eventId: string,
  action: string,
  source: string = 'plot_post_check',
): GameEvent {
  return createGameEvent('plot_trigger', {
    plotEventId: eventId,
    action,
  }, source);
}

/** 标记事件为已处理 */
export function markEventProcessed(event: GameEvent, result?: any): GameEvent {
  event.processed = true;
  if (result) {
    event.result = result;
  }
  return event;
}

// ========== EventBus Registry ==========

/** 按 SaveSlot 管理 EventBus 实例 */
const busRegistry = new Map<string, EventBus>();

/** 获取或创建存档专属 EventBus */
export function getEventBus(saveId: string): EventBus {
  if (!busRegistry.has(saveId)) {
    busRegistry.set(saveId, new EventBus());
  }
  return busRegistry.get(saveId)!;
}

/** 销毁存档的 EventBus */
export function destroyEventBus(saveId: string): void {
  const bus = busRegistry.get(saveId);
  if (bus) {
    bus.clearHandlers();
    bus.clearHistory();
    busRegistry.delete(saveId);
  }
}

/** 销毁所有 EventBus */
export function destroyAllEventBuses(): void {
  for (const bus of busRegistry.values()) {
    bus.clearHandlers();
    bus.clearHistory();
  }
  busRegistry.clear();
}
