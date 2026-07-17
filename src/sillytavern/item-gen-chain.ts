/**
 * Item Gen Chain — 独立物品/技能生成编排模块 (Phase 9c)
 *
 * 对标 craft-gen-chain.ts 的 craft_gen → item_gen 链，但这里上游是
 * request_dispatcher 发出的 `<item_gen_request>` 标记（含 itemType/source/owner
 * + 自然语言描述），由 GamePipeline 的 onItemGenRequest 回调触发。
 *
 * 职责:
 * 1. runItemGenChain() — 完整链: callItemGenForRequest → parseItemGenOutput → buildItemGenPatches
 * 2. buildItemGenPatches() — 把 ItemGenOutput (skills/equipment/inventory)
 *    转成 add_skill / add_item / equip_item StatePatch
 *
 * 协作关系:
 * - request_dispatcher: 解析正文 + <已有物品>，对"新物品"发出 <item_gen_request>
 * - item_gen: 读 marker.bodyText 描述，产出 <item_result> XML (skills/equipment/inventory)
 *   （item_gen 可调 get_character 查 owner 数据，避免重复物品）
 * - 和 char_gen → item_gen、craft_gen → item_gen 完全一致的 item_gen 调用方式
 *
 * 设计要点:
 * - 装备落库两步: add_item (写进背包) + equip_item (同 id，搬进装备栏)。
 *   applyEquipItem 按 itemId 从背包移除，所以两步必须用同一 id。
 * - item_gen 的 XML 产物不含 id，由本模块补生成 (crypto.randomUUID)。
 * - 失败不阻断主流程 — 和 char_gen/craft_gen 链一致的容错策略。
 *
 * 依赖注入 (测试友好):
 * - ItemGenChainDeps.clientFactory: AgentClient 工厂
 * - ItemGenChainDeps.stateManager: StateManager (可选，用于持久化)
 */

import type {
  AgentContext,
  ApiEndpoint,
  ItemGenRequestMarker,
  ItemGenOutput,
  StatePatch,
  ToolDefinition,
} from './types';
import { buildAgentMessages } from './agent-templates';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import type { ToolExecutionContext } from './types';

// ========== Types ==========

export interface ItemGenChainRequest {
  saveId: string;
  marker: ItemGenRequestMarker;
  storyOutput: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
}

export interface ItemGenChainDeps {
  /** AgentClient 工厂 — 每次调用创建新实例 (缓存隔离) */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => ItemGenChainClient;
  /** StateManager 写入入口 (可选，测试可不提供) */
  stateManager?: {
    commitChatState: (patches: StatePatch[]) => Promise<void>;
  };
}

/**
 * ItemGen 链客户端接口 — 抽象的 API 调用层。
 * 生产环境使用 AgentClient，测试使用 mock。
 */
export interface ItemGenChainClient {
  chat(messages: Array<{ role: string; content: string }>): Promise<{
    output: string | null;
    rawResponse: string;
    tokensUsed: number;
    cacheHit: boolean;
    duration: number;
    error?: string;
  }>;

  /** Phase 8.5 Agentic: 多轮 function calling 路径 */
  chatWithTools?: (
    request: {
      messages: Array<{ role: string; content: string }>;
      tools: ToolDefinition[];
      tool_choice: string;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<any>,
    options: { maxRounds: number },
  ) => Promise<{
    output: string | null;
    rawResponse: string;
    tokensUsed: number;
    cacheHit: boolean;
    duration: number;
    error?: string;
  }>;
}

export interface ItemGenChainResult {
  patches: StatePatch[];
  itemOutput: ItemGenOutput;
}

// ========== Public API ==========

/**
 * 完整独立 item_gen 链:
 * 1. callItemGenForRequest() — 调 item_gen Agent 生成 skills/equipment/inventory
 * 2. buildItemGenPatches() — 转成 StatePatch[] (补 id)
 * 3. 可选持久化 (stateManager.commitChatState)
 */
export async function runItemGenChain(
  request: ItemGenChainRequest,
  deps: ItemGenChainDeps,
): Promise<ItemGenChainResult> {
  // Step 1: 调 item_gen Agent
  const itemOutput = await callItemGenForRequest(request, deps);

  // Step 2: 转成 patches (owner 来自 marker.attributes.owner，缺省兜底 player_1)
  const characterId = request.marker.attributes.owner ?? 'player_1';
  const patches = buildItemGenPatches(itemOutput, characterId);

  // Step 3: optional persistence
  if (deps.stateManager && patches.length > 0) {
    await deps.stateManager.commitChatState(patches);
  }

  return {
    patches,
    itemOutput,
  };
}

/**
 * 调用 item_gen Agent — 根据独立 item_gen_request marker 生成物品/技能/装备。
 *
 * 将 marker 的描述包成 <item_requests> 注入 item_gen 模板的 {{ITEM_REQUEST}} 占位符。
 * agentOutputs['story'] 传正文，供 item_gen 参考（与 char/craft 链一致）。
 * Agentic 路径 (function calling) 优先，回退到普通 chat。
 */
async function callItemGenForRequest(
  request: ItemGenChainRequest,
  deps: ItemGenChainDeps,
): Promise<ItemGenOutput> {
  const marker = request.marker;
  const itemType = marker.attributes.itemType ?? 'equipment';
  const slotAttr = itemType === 'equipment' ? ` slot="${guessSlot(marker.bodyText, itemType)}"` : '';
  // item_gen 模板的 <request> 子元素期望含描述；type 约束它生成的条目类别。
  const itemRequestsXML = [
    `<item_requests>`,
    `  <request type="${itemType}"${slotAttr}>`,
    `    ${marker.bodyText.trim()}`,
    `  </request>`,
    `</item_requests>`,
  ].join('\n');

  const itemLocalParams: Record<string, string> = {
    ITEM_REQUEST: itemRequestsXML,
    // 独立链没有 char_gen / craft_gen 上游，留空注释给 item_gen 提示
    CHAR_GEN_RESULT: '（无 — 本次为 request_dispatcher 直接触发的独立物品生成，参考上方 <物品需求>）',
    CRAFT_RESULT: '',
  };

  // 构建 item_gen 上下文 — agentOutputs['story'] 传正文，对标 char/craft 链
  const contextWithStory: AgentContext = {
    ...request.context,
    agentOutputs: new Map([
      ['story', request.storyOutput],
    ]),
  };

  try {
    const messages = buildAgentMessages('item_gen', contextWithStory, undefined, undefined, undefined, itemLocalParams);
    if (!messages || messages.length === 0) {
      // item_gen 模板找不到 / 产出空 messages 时返回空，不阻塞主流程
      // （避免空 messages 打 API 触发 HTTP 400 "missing field messages"）
      return { skills: [], equipment: [], inventory: [] };
    }

    const client = deps.clientFactory('item_gen', request.endpoint, request.saveId);

    // Agentic 路径优先: function calling 多轮循环
    if (client.chatWithTools) {
      const tools = getToolsForAgent('item_gen');
      const toolContext: ToolExecutionContext = {
        characters: request.context.characters ?? [],
        variables: request.context.variables ?? {},
        saveId: request.saveId,
      };

      const result = await client.chatWithTools(
        { messages, tools, tool_choice: tools.length > 0 ? 'auto' : 'none' },
        async (name: string, args: Record<string, any>) => {
          return executeToolCall(name, args, toolContext);
        },
        // maxRounds=10 对齐 orchestrator (game-pipeline maxToolCallRounds:10) 与 char_gen 链；
        // equipment 类需 get_script_reference/get_character/get_inventory + 最终输出 ≈ 4-5 轮，5 轮会触顶
        { maxRounds: 10 },
      );

      if (result.output) {
        return parseItemGenOutput(result.output);
      }
      // 🆕 B: chatWithTools 已执行但未拿到 output（超轮/出错）时不再 Fallback 打第二次普通 chat：
      //   item_gen 的 system 提示含 function-calling 工具指令，不带 tools 再调只会让 AI 混乱、
      //   且极易重蹈 HTTP 400，纯属浪费一次失败调用。直接当失败返回空。
      console.warn('item_gen (独立链) Agentic 路径无 output:', result.error ?? 'no output');
      return { skills: [], equipment: [], inventory: [] };
    }

    // Fallback: 仅当 client 不支持 chatWithTools（如测试 mock）时走普通 chat
    const result = await client.chat(messages);
    if (result.output) {
      return parseItemGenOutput(result.output);
    }
  } catch (err) {
    // item_gen 失败不阻塞主流程 — 和 char_gen/craft_gen 链一致的容错策略
    console.warn('item_gen (独立链) 调用失败，物品将无详细数值:', err);
  }

  return { skills: [], equipment: [], inventory: [] };
}

/**
 * 从 ItemGenOutput 构建 StatePatch 列表 (补 id)。
 *
 * 生成的 patches:
 * - add_item: inventory 物品 + equipment 装备 (先写进背包)
 * - equip_item: equipment 装备 (同 id，搬进装备栏)
 * - add_skill: skills
 *
 * 注意: 装备要先 add_item 再 equip_item，且两步用同一 itemId —— 否则
 * state-manager.applyEquipItem 按 itemId 从背包查找会找不到。
 */
export function buildItemGenPatches(
  itemOutput: ItemGenOutput,
  characterId: string,
): StatePatch[] {
  const patches: StatePatch[] = [];
  const ts = Date.now();

  // 1. 装备 → add_item + equip_item (同 id 两步)
  // M3 重写: equipment 是 ItemGenOutput 的 AI 输出结构（M3 处理语义）；equip_item 按 name+slot 寻址
  for (const equip of itemOutput.equipment) {
    const itemId = `itemgen_eq_${ts}_${Math.random().toString(36).slice(2, 8)}`;
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        id: itemId,
        name: equip.name,
        description: equip.description,
        quantity: 1,
        type: 'equipment',
        rarity: equip.quality,
      },
      metadata: { source: 'item_gen', kind: 'equipment' },
    });
    patches.push({
      op: 'equip_item',
      target: `characters.${characterId}`,
      value: {
        itemId,
        slot: equip.slot,
        name: equip.name,
        stats: equip.stats,
      },
      metadata: { source: 'item_gen', kind: 'equipment' },
    });
  }

  // 2. 背包物品 → add_item
  for (const inv of itemOutput.inventory) {
    const itemId = `itemgen_inv_${ts}_${Math.random().toString(36).slice(2, 8)}`;
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        id: itemId,
        name: inv.name,
        description: inv.description,
        quantity: inv.quantity,
        type: inv.type,
        rarity: inv.rarity,
      },
      metadata: { source: 'item_gen', kind: 'inventory' },
    });
  }

  // 3. 技能 → add_skill
  for (const skill of itemOutput.skills) {
    const skillId = `itemgen_skill_${ts}_${Math.random().toString(36).slice(2, 8)}`;
    patches.push({
      op: 'add_skill',
      target: `characters.${characterId}`,
      value: {
        id: skillId,
        name: skill.name,
        description: skill.description,
        type: skill.type,
        cost: skill.cost,
        cooldown: skill.cooldown,
        effects: skill.effects,
        scripts: skill.scripts,
      },
      metadata: { source: 'item_gen', kind: 'skill' },
    });
  }

  return patches;
}

/**
 * 根据 marker.bodyText 粗略猜测装备槽位。
 * item_gen 模板 prompt 用中文槽位名 (武器/护甲/身体/头部/饰品/腰带/鞋子/主手/副手/惯用手)。
 */
function guessSlot(bodyText: string, itemType: string): string {
  if (itemType !== 'equipment') return '';
  const t = bodyText;
  if (/杖|剑|刀|弓|枪|斧|锤|棍|长枪|匕/.test(t)) return '武器';
  if (/袍|甲|铠|衣|衫|长袍/.test(t)) return '身体';
  if (/盔|帽|冠|头巾/.test(t)) return '头部';
  if (/靴|鞋|护腿|腿甲/.test(t)) return '鞋子';
  if (/戒|戒指/.test(t)) return '饰品';
  if (/项链|护符|项圈/.test(t)) return '饰品';
  if (/腰带|束带/.test(t)) return '腰带';
  return '身体';
}

// ========== Lazy Import for parseItemGenOutput ==========

/**
 * 懒加载 char-gen-agent 的 parseItemGenOutput。
 * 避免循环依赖 — 与 craft-gen-chain 一致。
 */
async function parseItemGenOutput(raw: string): Promise<ItemGenOutput> {
  const { parseItemGenOutput } = await import('./char-gen-agent');
  return parseItemGenOutput(raw);
}