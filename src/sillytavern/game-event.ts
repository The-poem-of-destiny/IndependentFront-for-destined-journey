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
  GameEvent,
  GameEventType,
  StatePatch,
  EffectDefinition,
  CombatActionRequest,
  CraftActionRequest,
  DiceRollPayload,
  ReadonlyHookSet,
} from './types';

// ========== EventBus ==========

export type EventHandler = (event: GameEvent) => Promise<void> | void;
export type EventFilter = (event: GameEvent) => boolean;

export interface EventBusConfig {
  /** 最大保留事件数 */
  maxHistory?: number;
}

// ========== 链式事件管道（M1 战斗 v2） ==========

/**
 * 链式 handler —— 接收 params，返回（可能修改过的）params。
 *
 * 与 {@link EventHandler} 不同：链式 handler 关注的是「参数流水线变换」
 * （如战斗伤害管线 baseDamage → 戒指1 → 戒指2 → 最终值），而非「通知」。
 */
export type ChainHandler<P = any> = (params: P, ctx: ChainContext) => P | Promise<P>;

/**
 * 链式调用上下文 —— 每次 emitChain 调用时构造。
 *
 * - `combatants` 给出参战者列表，配合 {@link ChainSubscription.owner} 做在场过滤
 * - `source` 仅用于历史记录溯源
 * - `maxDepth` / `readHooks` 为 M1 占位字段，本批次不消费（后续任务接线）
 */
export interface ChainContext {
  /** 参战者 charId 列表（在场过滤；缺省=不过滤） */
  combatants?: string[];
  /** 触发源标识（写入历史记录的 GameEvent.source） */
  source?: string;
  /** 本次链的套娃深度上限（缺省=用 SubscriptionManager 默认，M1 此字段先占位不消费） */
  maxDepth?: number;
  /** 只读查询钩子（M1 先占位字段，handler 内部如需可自行读 ctx.readHooks） */
  readHooks?: ReadonlyHookSet;
}

/**
 * 链式订阅注册条目。
 *
 * 调度顺序：`(priority 升序, order 升序, 注册序)`。
 * 在场过滤：`owner` 给定且不在 `ctx.combatants` 时跳过；`owner` 缺省=永在场。
 */
export interface ChainSubscription {
  /** 订阅的事件类型（点分式如 `combat.attack.request`，或现有扁平字面量） */
  type: string;
  /** 链式 handler */
  handler: ChainHandler;
  /** 优先级，默认 0，升序（小的先执行） */
  priority?: number;
  /** 同 priority 内的次序，默认 0，升序 */
  order?: number;
  /** 在场过滤用 charId；缺省=永在场（系统/环境 buff） */
  owner?: string;
  /** 条件过滤；返回 false 的订阅跳过（不进入链） */
  condition?: (params: any, ctx: ChainContext) => boolean;
}

export class EventBus {
  private handlers: Map<GameEventType, Set<EventHandler>> = new Map();
  private globalHandlers: Set<EventHandler> = new Set();
  private history: GameEvent[] = [];
  private maxHistory: number;
  /** 链式订阅注册表（与 handlers/globalHandlers 分离，两套互不干扰） */
  private chainHandlers: Map<string, ChainSubscription[]> = new Map();
  /** 链式递归深度计数器（emitChain 入口 ++、finally --；per-EventBus 实例级） */
  private chainDepth = 0;
  /** 当前链继承的递归深度上限 —— 外层 emitChain 的 ctx.maxDepth 设定，内层递归若未自带则继承 */
  private currentChainMaxDepth = Infinity;

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

  // ========== 链式事件管道（M1 战斗 v2） ==========

  /**
   * 链式订阅注册。
   *
   * 与 {@link subscribe} 走独立注册表（{@link chainHandlers}），两套互不干扰：
   * 同一 type 上既可有 publish 订阅又可有链式订阅，publish 触发前者、emitChain 触发后者。
   *
   * @returns 注销函数 —— 调用后从注册表中移除该订阅（按引用匹配）
   */
  subscribeChain(sub: ChainSubscription): () => void {
    if (!this.chainHandlers.has(sub.type)) {
      this.chainHandlers.set(sub.type, []);
    }
    const arr = this.chainHandlers.get(sub.type)!;
    arr.push(sub);
    return () => {
      const list = this.chainHandlers.get(sub.type);
      if (!list) {
        return;
      }
      const idx = list.indexOf(sub);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        this.chainHandlers.delete(sub.type);
      }
    };
  }

  /**
   * 链式触发 —— 按 `(priority 升序, order 升序, 注册序)` 顺序调用该 type 的链式订阅者，
   * 前一个返回的 params 作后一个的输入，返回最终 params。
   *
   * 调度规则：
   * - **排序**：复制订阅数组后稳定排序（JS Array.sort 稳定，注册序自然保留为末位 tie-breaker）
   * - **在场过滤**（排序后、执行前一次性）：`ctx.combatants` 给定时，跳过 `owner` 给定且不在 combatants 的订阅；`owner` 缺省=永在场
   * - **条件过滤**：`subscription.condition` 返回 false 的跳过（执行阶段判断，便于拿到当前 params）
   * - **错误隔离**：单个 handler 抛错不阻塞链（console.warn），沿用上一个 params 继续传递
   * - **历史记录**：构造 GameEvent（`data = initialParams`，`source = ctx.source ?? 'system'`）入 history，受 maxHistory 截断
   * - **async**：handler 顺序 await（链式语义要求严格顺序，非并发）
   */
  async emitChain<P>(type: string, initialParams: P, ctx: ChainContext = {}): Promise<P> {
    // 0. 递归深度保护（per-chain：ctx.maxDepth 限定本次链及其内部递归；战斗场景传 5）
    // 内层递归 emitChain 若未自带 ctx.maxDepth，则继承外层 currentChainMaxDepth。
    this.chainDepth++;
    const maxDepth = ctx.maxDepth ?? this.currentChainMaxDepth;
    if (this.chainDepth > maxDepth) {
      console.warn(`[EventBus.emitChain] 链式递归超限 (max ${maxDepth}, type=${type})`);
      this.chainDepth--;
      return initialParams;
    }
    const prevMaxDepth = this.currentChainMaxDepth;
    if (ctx.maxDepth !== undefined) {
      this.currentChainMaxDepth = ctx.maxDepth;
    }

    try {
      // 1. 入历史（与 publish 走同一 history，受 maxHistory 截断）
      // emitChain 的 type 为 string（支持点分命名如 combat.attack.request，对齐 RFC D8），
      // 而 createGameEvent 工厂签名约束为 GameEventType 闭合枚举（保住其他调用方类型安全）。
      // 这里直接构造对象 + 复用模块级 nextEventId()，避免放宽工厂签名。
      const event: GameEvent = {
        id: nextEventId(),
        type: type as GameEventType,
        source: ctx.source ?? 'system',
        timestamp: Date.now(),
        data: initialParams as Record<string, any>,
        processed: false,
      };
      this.history.push(event);
      if (this.history.length > this.maxHistory) {
        this.history = this.history.slice(-this.maxHistory);
      }

      // 2. 取订阅数组（空则直接返回，链不变换）
      const subs = this.chainHandlers.get(type);
      if (!subs || subs.length === 0) {
        return initialParams;
      }

      // 3. 稳定排序：(priority 升序, order 升序)；注册序靠 indexOf 自然保留为末位
      const sorted = [...subs].sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) {
          return pa - pb;
        }
        const oa = a.order ?? 0;
        const ob = b.order ?? 0;
        return oa - ob;
      });

      // 4. 在场过滤（一次性）：ctx.combatants 给定时，剔除 owner 给定且不在场的订阅
      const combatants = ctx.combatants;
      const filtered = combatants
        ? sorted.filter((s) => s.owner === undefined || combatants.includes(s.owner))
        : sorted;

      // 5. 链式执行：前一个返回值作后一个输入，错误隔离不中断链
      let params = initialParams;
      for (const sub of filtered) {
        if (sub.condition && !sub.condition(params, ctx)) {
          continue;
        }
        try {
          params = await sub.handler(params, ctx);
        } catch (err) {
          // 单个 handler 抛错不阻塞链，沿用当前 params 继续传递
          console.warn(
            `[EventBus.emitChain] handler 抛错 (type=${type}, source=${ctx.source ?? 'system'}):`,
            err,
          );
        }
      }
      return params;
    } finally {
      this.chainDepth--;
      this.currentChainMaxDepth = prevMaxDepth;
    }
  }

  // ========== 查询 ==========

  /** 获取事件历史 */
  getHistory(type?: GameEventType, limit?: number): GameEvent[] {
    let filtered = type ? this.history.filter((e) => e.type === type) : this.history;
    if (limit) {
      filtered = filtered.slice(-limit);
    }
    return filtered;
  }

  /** 获取最新事件 */
  getLatest(type?: GameEventType): GameEvent | undefined {
    if (type) {
      return this.history.filter((e) => e.type === type).pop();
    }
    return this.history[this.history.length - 1];
  }

  /** 清空历史 */
  clearHistory(): void {
    this.history = [];
  }

  /** 移除所有处理器（含链式订阅） */
  clearHandlers(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
    this.chainHandlers.clear();
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
export function createDiceEvent(payload: DiceRollPayload, source: string = 'system'): GameEvent {
  return createGameEvent('system', { subtype: 'dice_roll', payload }, source);
}

/** 创建状态效果事件 */
export function createStatusEffectEvent(
  characterId: string,
  action: 'add' | 'remove' | 'update',
  effectName: string,
  source: string = 'system',
): GameEvent {
  return createGameEvent(
    'status_effect',
    {
      characterId,
      action,
      effectName,
    },
    source,
  );
}

/** 创建位置变更事件 */
export function createLocationEvent(
  characterId: string,
  from: string,
  to: string,
  source: string = 'system',
): GameEvent {
  return createGameEvent(
    'location_change',
    {
      characterId,
      from,
      to,
    },
    source,
  );
}

/** 创建剧情触发事件 */
export function createPlotTriggerEvent(
  eventId: string,
  action: string,
  source: string = 'plot_post_check',
): GameEvent {
  return createGameEvent(
    'plot_trigger',
    {
      plotEventId: eventId,
      action,
    },
    source,
  );
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
