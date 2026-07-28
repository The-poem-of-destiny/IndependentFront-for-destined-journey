/**
 * ScriptRegistry — 声明式脚本注册 (M1 战斗 v2)
 *
 * 职责: 把"效果来源"(物品/技能/buff/天赋) 携带的静态脚本清单，按 ownerKey 分组
 *      注册到 EventBus 链式管道 (subscribeChain)，参与 emitChain 的参数流水线变换。
 *
 * 定位 (RFC D5): 它是 EventBus.subscribeChain 的"声明式 facade"，不是第三套效果系统 ——
 *  - ScriptRegistry:   静态声明 (物品定义时写好清单，装备即注册整份，卸下即全注销)
 *  - SubscriptionManager: 动态订阅 (AI 脚本运行时 $event.on，scriptKey 模式，走 handlers 注册表)
 * 两者各走各的注册表 (chainHandlers vs handlers)，互不干扰。
 *
 * 契约对齐: docs/reference/combat-system-architecture.md §三（脚本契约）
 * RFC: docs/planning/2026-07-28-combat-v2-m1-rfc.md §3 D5 + §4.2
 */

import type { EventBus, ChainHandler, ChainContext } from './game-event';

/** 声明式脚本条目 —— 对齐架构 §3.1 脚本契约 */
export interface ScriptDeclaration {
  /** 订阅的事件类型（点分式如 combat.attack.collect_attacker_mods，或现有扁平字面量） */
  event: string;
  /** 静态身份 —— 物品/技能名（buff id 前缀、调试溯源用；不随 owner 变） */
  source: string;
  /** 动态持有人 charId（在场过滤 + handler 读持有者状态用；装备转移时变） */
  owner?: string;
  /** 链式 handler —— 收 params 返回 params（变换管道） */
  handler: ChainHandler;
  /** 触发条件（可选）；返回 false 的跳过（不进入链） */
  condition?: (params: any, ctx: ChainContext) => boolean;
  /** 链内优先级（默认 0，升序）。注：登神 divinity 的冲突仲裁是 M2 modifier 的事，不混 */
  priority?: number;
  /** 同 priority 内次序（默认 0，升序） */
  order?: number;
}

/**
 * 声明式脚本注册表 —— 按 ownerKey 分组管理链式订阅。
 *
 * ownerKey 格式与 SubscriptionManager 对齐: `{charId}:{objectType}:{objectName}`
 * （如 `char_1:item:幽怨之剑`）。按 SaveSlot 实例化，与 EventBus/SubscriptionManager 同生命周期。
 */
export class ScriptRegistry {
  /** ownerKey → 该 owner 注册的注销函数集合 */
  private owners: Map<string, Set<() => void>> = new Map();

  constructor(private bus: EventBus) {}

  /** 注册单条声明。返回该条的注销函数（调用后从链式注册表移除）。 */
  register(decl: ScriptDeclaration, ownerKey: string): () => void {
    const unsubscribe = this.bus.subscribeChain({
      type: decl.event,
      handler: decl.handler,
      priority: decl.priority,
      order: decl.order,
      owner: decl.owner,
      condition: decl.condition,
    });

    let entries = this.owners.get(ownerKey);
    if (!entries) {
      entries = new Set();
      this.owners.set(ownerKey, entries);
    }
    entries.add(unsubscribe);

    // 组合注销：从 EventBus 移除订阅 + 从 owner 集合移除引用
    return () => {
      unsubscribe();
      entries!.delete(unsubscribe);
      if (entries!.size === 0) {
        this.owners.delete(ownerKey);
      }
    };
  }

  /**
   * 批量注册（物品装备时）—— 一次注册整份 scripts 清单。
   * @returns 整批的注销函数（调用后全量移除）
   */
  registerAll(decls: ScriptDeclaration[], ownerKey: string): () => void {
    const unsubs = decls.map((d) => this.register(d, ownerKey));
    return () => {
      for (const u of unsubs) u();
    };
  }

  /** 全量注销某 owner 的所有声明（物品卸下/掉落/丢弃时调用）。 */
  unregisterOwner(ownerKey: string): void {
    const entries = this.owners.get(ownerKey);
    if (!entries) return;
    for (const unsub of entries) {
      unsub();
    }
    this.owners.delete(ownerKey);
  }

  /** 查询某 owner 的活跃声明数 */
  getDeclarationCount(ownerKey: string): number {
    return this.owners.get(ownerKey)?.size ?? 0;
  }

  /** 全部注销（存档切换时调用） */
  clear(): void {
    for (const entries of this.owners.values()) {
      for (const unsub of entries) {
        unsub();
      }
    }
    this.owners.clear();
  }
}
