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
export type SubscriptionCallback = (effects: ScriptEffects, event: GameEvent) => void;

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

  /** 触发脚本产出的效果的出口（Q-07）。不设 = 效果被丢弃（旧行为）。 */
  private effectSink?: SubscriptionCallback;

  constructor(
    private eventBus: EventBus,
    maxRecursionDepth = 10,
  ) {
    this.maxRecursionDepth = maxRecursionDepth;
  }

  /**
   * 设置效果出口（Q-07 接线）。
   *
   * 在此之前 `handleEvent` 执行完脚本就把 `effects` 扔了 —— 注释写着「由调用方
   * （state-manager）统一 apply」，但从来没有那个调用方，于是订阅脚本里的
   * modifyHp/modifyStat/status 全部蒸发（和 Q-02 同一个形状的缺陷）。
   *
   * 本类**不自己写状态**（ADR-21）：只把效果交出去，由 effect-wiring 汇总、
   * state-manager 转成 StatePatch 走 commitChatState。
   */
  setEffectSink(cb: SubscriptionCallback | undefined): void {
    this.effectSink = cb;
  }

  /** 运行时调整最大递归深度。
   *
   *  战斗场景收紧到 5（套娃爆炸兜底），非战斗保持默认 10。
   *  - per-chain 细粒度由 `EventBus.emitChain` 的 `ctx.maxDepth` 管（链式 handler 侧）
   *  - 本方法管的是 `$event.on` 持久订阅触发的脚本递归（SubscriptionManager 侧）
   *
   *  注：真正的递归拦截验证需 `$event.emit` 接通（M3），当前 emit 收集后未 re-emit，
   *  故递归保护尚未通电；此方法先就位，供 M3 战斗管道开启战斗模式时调用。 */
  setMaxDepth(depth: number): void {
    this.maxRecursionDepth = depth;
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
    const handler = (event: GameEvent): void => {
      this.handleEvent(event, scriptKey, codeResolver, baseCtx);
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
      console.warn(`[SubscriptionManager] 事件递归超限 (${this.maxRecursionDepth}): ${event.type}`);
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

      // 瞬时事件（$event.emit）暂不 re-publish —— 见 setMaxDepth 注释的 M3 说明。
      // 它们随 effects 一起交给 sink，由上层决定要不要再发一轮。

      // Q-07：hpChanges/statChanges/status 等即时效果交给 sink（不设 sink 才丢弃）。
      // 本类不写状态，写入仍归 state-manager.commitChatState（ADR-21）。
      this.effectSink?.(effects, event);
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
