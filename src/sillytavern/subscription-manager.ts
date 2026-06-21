/**
 * SubscriptionManager — 脚本持久订阅管理器 (Phase 7e+8)
 *
 * 职责:
 * 1. $event.on() 注册的持久订阅 → 注册到 EventBus
 * 2. $event.off() / 对象销毁 → 取消订阅（僵尸兜底）
 * 3. 递归深度限制（防止事件风暴）
 *
 * 生命周期:
 *   对象激活 (装备/施加/获得) → 执行 init → $event.on() → 在此注册
 *   对象失效 (卸下/移除/失去) → 执行 cleanup → $event.off() → 在此注销
 *   兜底: unregisterAll(ownerKey) 清理所有残留
 */

import type { EventBus } from './game-event';
import type { GameEvent, GameEventType } from './types';
import type { ScriptContext } from './script-executor';
import { executeScript, createScriptEffects } from './script-executor';
import type { ScriptEffects } from './script-executor';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 订阅条目 */
interface SubscriptionEntry {
  eventType: GameEventType;
  scriptKey: string;
  unsubscribe: () => void;
}

/** 代码解析器 — 给定 scriptKey 返回实际 JS 代码 */
export type CodeResolver = (scriptKey: string) => string | undefined;

/** 脚本执行回调 — 订阅触发时调用 */
export type SubscriptionCallback = (
  effects: ScriptEffects,
  event: GameEvent,
) => void;

// ═══════════════════════════════════════════════════════════
// SubscriptionManager
// ═══════════════════════════════════════════════════════════

export class SubscriptionManager {
  /** ownerKey → Set<SubscriptionEntry> */
  private owners: Map<string, Set<SubscriptionEntry>> = new Map();
  /** 递归深度计数器 (per-event) */
  private recursionDepth = 0;
  /** 最大递归深度 */
  private maxRecursionDepth: number;

  constructor(
    private eventBus: EventBus,
    maxRecursionDepth = 10,
  ) {
    this.maxRecursionDepth = maxRecursionDepth;
  }

  // ========== 注册 ==========

  /**
   * 注册持久订阅。
   *
   * @param ownerKey  - 拥有者标识: "{charId}:{objectType}:{objectId}"
   * @param eventType - 监听的 GameEventType
   * @param scriptKey - scripts 里的键名
   * @param codeResolver - 从 scriptKey 解析实际 JS 代码的函数
   * @param baseCtx   - 基础执行上下文 (owner, parentScripts 等)
   */
  register(
    ownerKey: string,
    eventType: GameEventType,
    scriptKey: string,
    codeResolver: CodeResolver,
    baseCtx: Pick<ScriptContext, 'owner' | 'parentScripts'>,
  ): void {
    // 获取或创建 owner 的订阅集合
    let entries = this.owners.get(ownerKey);
    if (!entries) {
      entries = new Set();
      this.owners.set(ownerKey, entries);
    }

    // 检查是否已有相同 eventType+scriptKey 的订阅（幂等）
    for (const entry of entries) {
      if (entry.eventType === eventType && entry.scriptKey === scriptKey) {
        return; // 已存在，跳过
      }
    }

    // 创建 EventBus 订阅
    const self = this;
    const handler = (event: GameEvent): void => {
      self.handleEvent(event, scriptKey, codeResolver, baseCtx);
    };

    const unsubscribe = this.eventBus.subscribe(eventType, handler);

    entries.add({ eventType, scriptKey, unsubscribe });
  }

  // ========== 注销 ==========

  /**
   * 注销指定 owner 的所有订阅（兜底清理）。
   * 即使 AI 忘了写 cleanup 或 cleanup 执行失败，引擎也会调用此方法。
   */
  unregisterAll(ownerKey: string): void {
    const entries = this.owners.get(ownerKey);
    if (!entries) return;

    for (const entry of entries) {
      entry.unsubscribe();
    }
    this.owners.delete(ownerKey);
  }

  /**
   * 注销指定 owner 的特定 eventType 订阅。
   * 对应 $event.off(eventType)。
   */
  unregister(ownerKey: string, eventType: GameEventType): void {
    const entries = this.owners.get(ownerKey);
    if (!entries) return;

    for (const entry of entries) {
      if (entry.eventType === eventType) {
        entry.unsubscribe();
        entries.delete(entry);
      }
    }

    // 如果该 owner 没有任何订阅了，清理
    if (entries.size === 0) {
      this.owners.delete(ownerKey);
    }
  }

  /**
   * 注销指定 owner 的某个特定 handle。
   * handle 格式: "sub_{index}_{eventType}"
   */
  unregisterByHandle(ownerKey: string, handle: string): void {
    // handle 包含 eventType，提取它
    const entries = this.owners.get(ownerKey);
    if (!entries) return;

    // 尝试匹配：handle 格式为 "sub_N_eventType"
    for (const entry of entries) {
      if (handle.includes(entry.eventType)) {
        entry.unsubscribe();
        entries.delete(entry);
        break; // 一个 handle 对应一个订阅
      }
    }

    if (entries.size === 0) {
      this.owners.delete(ownerKey);
    }
  }

  // ========== 查询 ==========

  /** 获取指定 owner 的活跃订阅数 */
  getSubscriptionCount(ownerKey: string): number {
    return this.owners.get(ownerKey)?.size ?? 0;
  }

  /** 获取所有 owner 的活跃订阅总数 */
  get totalSubscriptions(): number {
    let count = 0;
    for (const entries of this.owners.values()) {
      count += entries.size;
    }
    return count;
  }

  /** 清空所有订阅（存档切换时调用） */
  clear(): void {
    for (const entries of this.owners.values()) {
      for (const entry of entries) {
        entry.unsubscribe();
      }
    }
    this.owners.clear();
    this.recursionDepth = 0;
  }

  // ========== 内部：事件处理 ==========

  private handleEvent(
    event: GameEvent,
    scriptKey: string,
    codeResolver: CodeResolver,
    baseCtx: Pick<ScriptContext, 'owner' | 'parentScripts'>,
  ): void {
    // 递归深度检查
    this.recursionDepth++;
    if (this.recursionDepth > this.maxRecursionDepth) {
      console.warn(
        `[SubscriptionManager] 事件递归超限 (${this.maxRecursionDepth}): ${event.type}`,
      );
      this.recursionDepth--;
      return;
    }

    try {
      // 解析脚本代码
      const code = codeResolver(scriptKey);
      if (!code) return;

      // 构造沙盒上下文
      const ctx: ScriptContext = {
        owner: baseCtx.owner,
        target: event.data?.target as string | undefined,
        event: event.data ?? {},
        self: {
          stacks: 0,
          remainingTime: null,
          name: `sub:${scriptKey}`,
        },
        parentScripts: baseCtx.parentScripts,
      };

      // 执行脚本
      const effects = executeScript(code, ctx);

      // 处理 $event.on（套娃注册 — 脚本内部又注册了新订阅）
      for (const sub of effects.subscriptions) {
        this.register(
          `${baseCtx.owner}:subscription:nested`,
          sub.eventType as GameEventType,
          sub.scriptKey,
          codeResolver,
          baseCtx,
        );
      }

      // 处理 $event.off（套娃注销）
      for (const unsub of effects.unsubscriptions) {
        this.unregisterByHandle(`${baseCtx.owner}:subscription:nested`, unsub);
      }

      // 处理瞬时事件（$event.emit）
      for (const evt of effects.events) {
        // 瞬时事件不持久存储，只在此次触发的上下文中处理
        // 如果脚本内 emit 了事件，其他订阅者会通过 EventBus 自动收到
      }

      // 注意: hpChanges/statChanges/status adds 等即时效果
      // 由调用方（state-manager）在脚本执行后统一 apply
      // 持久订阅的脚本执行结果需要在外部处理
    } catch (err) {
      console.error(
        '[SubscriptionManager] 订阅脚本执行失败:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.recursionDepth--;
    }
  }
}
