/**
 * effect-wiring.ts — 战斗外效果系统接线（Q-07，T1 接线缺口）
 *
 * 架构真源：AGENTS.md P1-11（效果系统「基础设施全部齐全，唯一缺口是接线」）+
 * docs/reviews/2026-08-03-code-quality-refactor/findings-t1-wiring-gap.md#q-07
 *
 * 本模块把三层「只存在于类型与测试」的战斗外效果基座接进生产路径：
 *   1. EventBus          —— 按存档实例化（getEventBus，此前生产零调用）
 *   2. ScriptRegistry    —— 声明式：已装备物品/技能的 scripts 注册为 subscribeChain handler
 *   3. SubscriptionManager —— 动态式：物品 init 脚本里 $event.on() 注册的持久订阅
 *
 * 接线点（对应 findings 方案 A）：
 *   - wireEffectSystem(saveId, characters)：存档加载时对每件已装备物品执行 init + 注册
 *   - wireObject / unwireObject：装备时 init + 注册，卸下时 cleanup + 注销
 *
 * 铁律（ADR-21）：本模块**只负责脚本注册/订阅**，不产生任何 StatePatch——
 * 状态变更仍必须走 state-manager.commitChatState（唯一写入口）。脚本里收集的
 * hpChanges/statChanges 等效果由调用方按现有 convertScriptEffects 语义提交。
 */

import { getEventBus, destroyEventBus } from './game-event';
import { ScriptRegistry } from './script-registry';
import { SubscriptionManager } from './subscription-manager';
import { executeInit, executeCleanup, createScriptEffects } from './script-executor';
import type { ScriptEffects } from './script-executor';
import type { CharacterState, GameEvent } from './types';

/** 每存档的效果系统实例（EventBus + 两个注册 facade） */
export interface EffectWiring {
  /** 存档专属 EventBus（emitChain 触发已装备物品效果） */
  bus: ReturnType<typeof getEventBus>;
  /** 声明式注册表（物品/技能 scripts → subscribeChain） */
  registry: ScriptRegistry;
  /** 动态订阅管理器（$event.on 持久订阅） */
  subscriptions: SubscriptionManager;
  /** 已注册的 ownerKey 集合（幂等 + 调试） */
  owners: Set<string>;
  sources: Map<
    string,
    {
      char: CharacterState;
      objectType: 'item' | 'skill';
      name: string;
      scripts: Record<string, string>;
      parentScripts?: Record<string, string>;
    }
  >;
  /** 本轮 publish 的效果收集桶（非 publish 期间为 undefined） */
  collector?: ScriptEffects;
}

/** 把 src 的各类效果并进 dst（Q-07：一轮 publish 内多个订阅的产出要合并） */
function mergeScriptEffects(dst: ScriptEffects, src: ScriptEffects): void {
  dst.adds.push(...src.adds);
  dst.removes.push(...src.removes);
  dst.stackSets.push(...src.stackSets);
  dst.events.push(...src.events);
  dst.hpChanges.push(...src.hpChanges);
  dst.statChanges.push(...src.statChanges);
  dst.subscriptions.push(...src.subscriptions);
  dst.unsubscriptions.push(...src.unsubscriptions);
  dst.statusApplies.push(...src.statusApplies);
  dst.statusRemoves.push(...src.statusRemoves);
}

/** 存档 → EffectWiring 实例缓存（随存档生命周期） */
const wirings = new Map<string, EffectWiring>();

/** 生成 ownerKey：{charId}:{objectType}:{objectName}（对齐 ScriptRegistry 契约） */
export function ownerKeyOf(charId: string, objectType: 'item' | 'skill', name: string): string {
  return `${charId}:${objectType}:${name}`;
}

/** 取某存档的效果系统实例（不存在则惰性创建） */
export function getEffectWiring(saveId: string): EffectWiring {
  let w = wirings.get(saveId);
  if (!w) {
    const bus = getEventBus(saveId);
    const wiring: EffectWiring = {
      bus,
      registry: new ScriptRegistry(bus),
      subscriptions: new SubscriptionManager(bus),
      owners: new Set(),
      sources: new Map(),
    };
    // Q-07：订阅脚本产出的效果汇进本轮 publish 的桶（无桶 = 非 publish 期间触发，丢弃并告警）
    wiring.subscriptions.setEffectSink((effects) => {
      if (wiring.collector) mergeScriptEffects(wiring.collector, effects);
      else console.warn(`[effect-wiring] ${saveId}: publish 之外触发的订阅效果被丢弃`);
    });
    w = wiring;
    wirings.set(saveId, w);
  }
  return w;
}

/**
 * 取某存档已建立的效果系统实例；**不存在则返回 undefined，不创建**。
 *
 * state-manager 每次 commit 都会问一次，用 getEffectWiring 会给每个存档凭空建出
 * EventBus + 两个 facade（包括从没装过带脚本物品的存档、以及每个测试用的假 saveId）。
 */
export function peekEffectWiring(saveId: string): EffectWiring | undefined {
  return wirings.get(saveId);
}

/**
 * 把一批 GameEvent 发到存档 EventBus，并收集订阅脚本产出的效果。
 *
 * 这就是 Q-07 缺的那半：`wireEffectSystem` 只建了**注册面**（谁订阅了什么），
 * 没有任何生产代码去 publish，于是订阅永远不会被触发。现在 state-manager 每次
 * commit 后把本次产生的 GameEvent 走这里发出去。
 *
 * 本函数**不写任何状态**（ADR-21）：只把效果交回调用方，由 state-manager 转成
 * StatePatch 再走 commitChatState。
 */
export async function publishToEffectSystem(
  saveId: string,
  events: GameEvent[],
): Promise<ScriptEffects> {
  const acc = createScriptEffects();
  const w = wirings.get(saveId);
  if (!w || events.length === 0) return acc;
  // 没有任何持久订阅时直接短路 —— 绝大多数存档是这种情况
  if (w.subscriptions.totalSubscriptions === 0) return acc;

  w.collector = acc;
  try {
    for (const event of events) {
      await w.bus.publish(event);
    }
  } finally {
    w.collector = undefined;
  }
  return acc;
}

/**
 * 对一件已装备物品/技能执行 init 并注册其效果脚本。
 * - 执行 init 脚本 → 收集 $event.on 持久订阅 → 注册到 SubscriptionManager
 * - 返回该对象的注销函数（卸下/移除时调用）
 */
export function wireObject(
  saveId: string,
  char: CharacterState,
  objectType: 'item' | 'skill',
  name: string,
  scripts: Record<string, string> | undefined,
  parentScripts?: Record<string, string>,
): (() => void) | undefined {
  if (!scripts || Object.keys(scripts).length === 0) return undefined;
  const w = getEffectWiring(saveId);
  const ownerKey = ownerKeyOf(char.id, objectType, name);

  const previous = w.sources.get(ownerKey);
  if (
    previous &&
    JSON.stringify(previous.scripts) === JSON.stringify(scripts) &&
    JSON.stringify(previous.parentScripts) === JSON.stringify(parentScripts)
  )
    return undefined;
  if (previous)
    unwireObject(
      saveId,
      previous.char,
      previous.objectType,
      previous.name,
      previous.scripts,
      previous.parentScripts,
    );
  scripts = { ...scripts };
  parentScripts = parentScripts ? { ...parentScripts } : undefined;
  w.sources.set(ownerKey, { char, objectType, name, scripts, parentScripts });
  w.owners.add(ownerKey);

  // 执行 init 脚本，收集 $event.on 持久订阅 → SubscriptionManager
  const initEffects = executeInit(scripts, parentScripts, char.id);
  for (const sub of initEffects.subscriptions) {
    w.subscriptions.register(
      ownerKey,
      sub.eventType as never,
      sub.scriptKey,
      (key) => scripts[key],
      { owner: char.id, parentScripts },
    );
  }

  // 组合注销：清空动态订阅 + 释放 owner 标记
  return () => {
    w.subscriptions.unregisterAll(ownerKey);
    w.owners.delete(ownerKey);
    w.sources.delete(ownerKey);
  };
}

/**
 * 对一件已装备物品/技能执行 cleanup 并注销其效果脚本。
 * @returns cleanup 收集的效果（供调用方按现有语义提交，可为空）
 */
function unwireObject(
  saveId: string,
  char: CharacterState,
  objectType: 'item' | 'skill',
  name: string,
  scripts: Record<string, string> | undefined,
  parentScripts?: Record<string, string>,
): ScriptEffects {
  const w = getEffectWiring(saveId);
  const ownerKey = ownerKeyOf(char.id, objectType, name);
  w.subscriptions.unregisterAll(ownerKey);
  w.owners.delete(ownerKey);
  w.sources.delete(ownerKey);
  if (!scripts) return createScriptEffects();
  return executeCleanup(scripts, parentScripts, char.id);
}

/**
 * 存档加载时全量接线：遍历所有角色，对每件已装备物品（equippedSlot 非空）执行 init + 注册，
 * 对所有带 scripts 的技能执行 init + 注册。幂等 —— 重复调用对已注册对象跳过。
 */
export function wireEffectSystem(saveId: string, characters: CharacterState[]): EffectWiring {
  return reconcileEffectWiring(saveId, characters);
}

/** Replace subscriptions only when their authoritative owner or script changes. */
export function reconcileEffectWiring(saveId: string, characters: CharacterState[]): EffectWiring {
  const w = getEffectWiring(saveId);
  const desired = new Set<string>();
  for (const char of characters) {
    for (const item of char.inventory ?? []) {
      if (item.equippedSlot && item.scripts && Object.keys(item.scripts).length)
        desired.add(ownerKeyOf(char.id, 'item', item.name));
    }
    for (const skill of char.skills ?? []) {
      if (skill.scripts && Object.keys(skill.scripts).length)
        desired.add(ownerKeyOf(char.id, 'skill', skill.name));
    }
  }
  for (const [key, source] of w.sources) {
    if (!desired.has(key))
      unwireObject(
        saveId,
        source.char,
        source.objectType,
        source.name,
        source.scripts,
        source.parentScripts,
      );
  }
  for (const char of characters) {
    for (const item of char.inventory ?? []) {
      if (item.equippedSlot) {
        wireObject(saveId, char, 'item', item.name, item.scripts);
      }
    }
    for (const skill of char.skills ?? []) {
      if (skill.scripts && Object.keys(skill.scripts).length > 0) {
        wireObject(saveId, char, 'skill', skill.name, skill.scripts);
      }
    }
  }
  return w;
}

/** 存档切换/销毁时拆除效果系统（清空订阅 + 销毁 EventBus） */
export function unwireEffectSystem(saveId: string): void {
  const w = wirings.get(saveId);
  if (w) {
    w.subscriptions.clear();
    w.registry.clear();
    w.owners.clear();
    w.sources.clear();
    destroyEventBus(saveId);
    wirings.delete(saveId);
  }
}

/** 测试辅助：清空所有效果系统实例 */
export function clearAllEffectWirings(): void {
  for (const saveId of [...wirings.keys()]) {
    unwireEffectSystem(saveId);
  }
}
