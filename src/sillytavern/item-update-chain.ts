/**
 * item-update-chain.ts
 *
 * 处理 vars_update 调度器输出的 <item_update_request> 标签。
 * 触发时机: Stage 2 (vars_update) 后，与其他回调并行。
 *
 * 流程: 解析标签属性 → 构建 StatePatch（Code 直接处理，无需 LLM Agent）
 */

import type { ItemUpdateRequestMarker, StatePatch } from './types';
import type { AgentContext, ApiEndpoint } from './types';
import type { AgentClient } from './agent-client';

export interface ItemUpdateDeps {
  client?: AgentClient;
  endpoint?: ApiEndpoint;
}

/**
 * 解析单个 item_update_request 标签为 StatePatch
 * 这是纯 Code 逻辑，不需要 Agent 调用
 */
function parseItemUpdateToPatch(marker: ItemUpdateRequestMarker): StatePatch | null {
  const { target, operation, quantity, owner } = marker.attributes;

  if (!target || !operation) return null;

  switch (operation) {
    case 'consume':
      // 消耗物品：减少数量
      return {
        op: 'delta_variable',
        target: `characters.${owner || 'player_1'}.inventory`,
        amount: -(Number(quantity) || 1),
        value: { name: target },
        metadata: { source: 'item_update', operation: 'consume' },
      };

    case 'transfer':
      // 转移物品归属
      return {
        op: 'set_variable',
        target: `characters.${target}.owner`,
        value: owner || '',
        metadata: { source: 'item_update', operation: 'transfer' },
      };

    case 'equip':
      // 装备物品
      return {
        op: 'equip_item',
        target: `characters.${owner || 'player_1'}`,
        value: target,
        metadata: { source: 'item_update', operation: 'equip' },
      };

    case 'unequip':
      // 卸下物品
      return {
        op: 'unequip_item',
        target: `characters.${owner || 'player_1'}`,
        value: target,
        metadata: { source: 'item_update', operation: 'unequip' },
      };

    case 'modify':
      // 修改物品属性
      return {
        op: 'set_variable',
        target: `characters.${owner || 'player_1'}.inventory`,
        value: { name: target, ...JSON.parse(marker.bodyText || '{}') },
        metadata: { source: 'item_update', operation: 'modify' },
      };

    default:
      return null;
  }
}

/**
 * 处理 vars_update 输出的 <item_update_request> 标签
 * Code 直接解析为 StatePatch，不调用 Agent
 */
export async function processItemUpdateRequests(
  markers: ItemUpdateRequestMarker[],
  _varsOutput: string,
  context: AgentContext,
  saveId: string,
  _deps: ItemUpdateDeps = {},
): Promise<StatePatch[]> {
  const patches = markers
    .map(parseItemUpdateToPatch)
    .filter((p): p is StatePatch => p !== null);

  if (patches.length > 0) {
    const { createStateManager } = await import('./state-manager');
    const sm = createStateManager(saveId);
    await sm.commitChatState(patches);
  }

  return patches;
}
