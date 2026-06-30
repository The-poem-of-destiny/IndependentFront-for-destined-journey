/**
 * Craft Gen Chain — 制作生成编排模块 (Phase 9b)
 *
 * ADR-25: craft_gen → item_gen SubAgent 链 (对标 char_gen → item_gen)
 * 触发时机: Stage 2 (vars_update) 处理 <craft_request> 标记时触发
 *
 * 职责:
 * 1. runCraftGenChain() — 完整链: callCraftGenAgent → callItemGenForCraft → buildCraftPatches
 * 2. parseCraftResultXML() — 解析 craft_gen 的 <craft_result> XML 输出
 * 3. buildCraftPatches() — 生成 add_item + equip_item + delta_exp + delta_fp + delta_hp/mp/sp patches
 *
 * 协作关系:
 * - craft_gen: 做制作检定、确认成败、描述产物需求和叙事 (Code管线 → AI叙事)
 * - item_gen: 读 craft_gen 的 <item_requests> 写出具体数值物品 (<item_result> XML)
 * - 和 char_gen → item_gen 完全一致的协作模式
 *
 * 依赖注入 (测试友好):
 * - CraftGenDeps.clientFactory: AgentClient 工厂
 * - CraftGenDeps.stateManager: StateManager (可选，用于持久化)
 */

import type {
  AgentContext,
  ApiEndpoint,
  CraftRequestMarker,
  ItemGenOutput,
  StatePatch,
  QualityLevel,
  CraftRating,
  CraftIndustry,
  ToolDefinition,
} from './types';
import { buildAgentMessages } from './agent-templates';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import type { ToolExecutionContext } from './types';

// ========== Types ==========

export interface CraftGenRequest {
  saveId: string;
  marker: CraftRequestMarker;
  storyOutput: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
}

export interface CraftGenDeps {
  /** AgentClient 工厂 — 每次调用创建新实例 (缓存隔离) */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CraftGenClient;
  /** StateManager 写入入口 (可选，测试可不提供) */
  stateManager?: {
    commitChatState: (patches: StatePatch[]) => Promise<void>;
  };
}

/**
 * CraftGen 客户端接口 — 抽象的 API 调用层。
 * 生产环境使用 AgentClient，测试使用 mock。
 */
export interface CraftGenClient {
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

/**
 * craft_gen 解析后的结构化输出
 */
export interface CraftGenOutput {
  success: boolean;
  productName: string;
  quality: QualityLevel;
  rating: CraftRating;
  checkSummary: string;
  perfectionBonus?: string;
  itemRequests: ItemRequest[];
  narrative: string;
  craftParams: {
    industry: CraftIndustry;
    targetQuality: QualityLevel;
    stage: string;
    quantity: number;
    materials: string;
    expGained: number;
    fpGained: number;
  };
}

/**
 * craft_gen 的 <request> 子元素 — 派发给 item_gen 的制品需求
 */
export interface ItemRequest {
  type: 'equipment' | 'inventory';
  slot?: string;   // equipment: 武器/头部/身体/腿部/脚部/首饰/戒指/项链
  quality: string;
  description: string;  // 纯自然语言，不含数值
}

export interface CraftGenChainResult {
  narrative: string;
  patches: StatePatch[];
  craftOutput: CraftGenOutput;
  itemOutput: ItemGenOutput | null;
}

// ========== Public API ==========

/**
 * 调用 craft_gen Agent — 执行制作管线。
 * 使用 Agentic 路径 (function calling) 获取真实工具数据。
 */
export async function callCraftGenAgent(
  request: CraftGenRequest,
  deps: CraftGenDeps,
): Promise<CraftGenOutput> {
  // 构建上下文: 将 story 输出（含 <craft_request>）和 marker 信息注入 agentOutputs
  const markerContext = [
    `一般制作请求: ${request.marker.bodyText ?? request.marker.rawContent}`,
    request.marker.industry ? `行业: ${request.marker.industry}` : '',
    request.marker.productName ? `产物名: ${request.marker.productName}` : '',
    request.marker.targetQuality ? `目标品质: ${request.marker.targetQuality}` : '',
    request.marker.expects ? `期望效果: ${request.marker.expects}` : '',
  ].filter(Boolean).join('\n');

  const ctxWithStory: AgentContext = {
    ...request.context,
    agentOutputs: new Map([
      ['story', markerContext],
    ]),
  };

  const messages = buildAgentMessages('craft_gen', ctxWithStory);

  if (!messages) {
    throw new Error('craft_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('craft_gen', request.endpoint, request.saveId);

  // Agentic 路径: function calling 多轮循环
  if (client.chatWithTools) {
    const tools = getToolsForAgent('craft_gen');

    const toolContext: ToolExecutionContext = {
      characters: request.context.characters ?? [],
      variables: request.context.variables ?? {},
      saveId: request.saveId,
    };

    const result = await client.chatWithTools(
      {
        messages,
        tools,
        tool_choice: 'auto',
      },
      async (name: string, args: Record<string, any>) => {
        return executeToolCall(name, args, toolContext);
      },
      { maxRounds: 8 },
    );

    if (result.error) {
      // 如果 Agentic 失败，回退到普通 chat
      const fallbackResult = await client.chat(messages);
      if (fallbackResult.output) {
        return parseCraftResultXML(fallbackResult.output);
      }
      throw new Error(`craft_gen Agentic 调用失败: ${result.error}`);
    }

    if (!result.output) {
      throw new Error('craft_gen 未返回输出');
    }

    return parseCraftResultXML(result.output);
  }

  // Fallback: 普通 chat
  const result = await client.chat(messages);
  if (!result.output) {
    throw new Error('craft_gen 未返回输出');
  }

  return parseCraftResultXML(result.output);
}

/**
 * 调用 item_gen Agent 为制作产物生成数值。
 * 将 craft_gen 的 <item_requests> 作为输入传给 item_gen。
 *
 * @param craftOutput - craft_gen 的解析后输出
 * @param request - 原始 craft 请求 (用于获取角色上下文)
 * @param deps - 依赖注入
 */
export async function callItemGenForCraft(
  craftOutput: CraftGenOutput,
  request: CraftGenRequest,
  deps: CraftGenDeps,
): Promise<ItemGenOutput> {
  // 如果没有 item_requests，跳过 item_gen
  if (!craftOutput.itemRequests || craftOutput.itemRequests.length === 0) {
    return { skills: [], equipment: [], inventory: [] };
  }

  // 将 craft_output 格式化为 item_gen 可理解的 XML 片段
  // 对标 char_gen 传给 item_gen 的 <skill_requests>/<equipment_requests>/<item_requests>
  const itemRequestsXML = craftOutput.itemRequests.map((req) => {
    const slotAttr = req.slot ? ` slot="${req.slot}"` : '';
    return `<request type="${req.type}"${slotAttr} quality="${req.quality}">\n${req.description}\n</request>`;
  }).join('\n');

  const craftDataXML = [
    `<craft_output>`,
    `  <product_name>${craftOutput.productName}</product_name>`,
    `  <quality>${craftOutput.quality}</quality>`,
    `  <rating>${craftOutput.rating}</rating>`,
    `  <item_requests>`,
    `    ${itemRequestsXML}`,
    `  </item_requests>`,
    `</craft_output>`,
  ].join('\n');

  try {
    // 构建 item_gen 上下文 — 对标 char_gen→item_gen: agentOutputs['char_gen'] 传角色数据
    const contextWithCraftData: AgentContext = {
      ...request.context,
      agentOutputs: new Map([
        ['craft_gen', craftDataXML],
        ['story', request.storyOutput],
      ]),
    };

    const messages = buildAgentMessages('item_gen', contextWithCraftData);
    if (!messages) {
      // item_gen 模板找不到时，返回空，不阻塞主流程
      return { skills: [], equipment: [], inventory: [] };
    }

    const client = deps.clientFactory('item_gen', request.endpoint, request.saveId);

    // Agentic 路径
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
        { maxRounds: 5 },
      );

      if (result.output) {
        return parseItemGenOutput(result.output);
      }
    }

    // Fallback: 普通 chat
    const result = await client.chat(messages);
    if (result.output) {
      return parseItemGenOutput(result.output);
    }
  } catch (err) {
    // item_gen 失败不阻塞主流程 — 和 char_gen→item_gen 一致的容错策略
    console.warn('item_gen for craft 调用失败，制品将无详细数值:', err);
  }

  return { skills: [], equipment: [], inventory: [] };
}

/**
 * 解析 craft_gen 的 <craft_result> XML 输出。
 *
 * 尝试顺序:
 * 1. XML <craft_result> 标签
 * 2. JSON (兜底)
 */
export function parseCraftResultXML(xml: string): CraftGenOutput {
  // 尝试提取 <craft_result> XML
  const craftTag = extractTag('craft_result', xml);
  if (craftTag) {
    return parseCraftResultTag(craftTag);
  }

  // 尝试 JSON 兜底
  const json = extractJSON(xml);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      return {
        success: parsed.success ?? false,
        productName: parsed.product_name ?? parsed.productName ?? '',
        quality: (parsed.quality ?? '普通') as QualityLevel,
        rating: (parsed.rating ?? '失败') as CraftRating,
        checkSummary: parsed.check_summary ?? parsed.checkSummary ?? '',
        perfectionBonus: parsed.perfection_bonus ?? parsed.perfectionBonus,
        itemRequests: parseItemRequestsJSON(parsed),
        narrative: parsed.narrative ?? '',
        craftParams: {
          industry: (parsed.industry ?? '锻造') as CraftIndustry,
          targetQuality: (parsed.target_quality ?? parsed.targetQuality ?? '普通') as QualityLevel,
          stage: parsed.stage ?? '成品',
          quantity: parsed.quantity ?? 1,
          materials: parsed.materials ?? '',
          expGained: parsed.exp_gained ?? parsed.expGained ?? 0,
          fpGained: parsed.fp_gained ?? parsed.fpGained ?? 0,
        },
      };
    } catch {
      // JSON parse failed — fall through to throw
    }
  }

  throw new Error(`无法解析 craft_gen 输出: ${xml.slice(0, 200)}`);
}

/**
 * 从 craft_result 和 item_gen 输出构建 StatePatch 列表。
 *
 * 生成的 patches:
 * - add_item: 产物写入背包
 * - equip_item: 装备类产物自动装备到对应槽位
 * - delta_exp: 经验奖励
 * - delta_fp: FP 奖励
 * - delta_hp/delta_mp/delta_sp: 资源消耗（由 craft_settle 工具内部提交，这里做兜底）
 */
export function buildCraftPatches(
  craftOutput: CraftGenOutput,
  itemOutput: ItemGenOutput | null,
  characterId: string,
): StatePatch[] {
  const patches: StatePatch[] = [];

  // 只有成功才产出物品
  if (!craftOutput.success) {
    return patches;
  }

  const productName = craftOutput.productName;

  // 1. 产物写入背包 (add_item)
  patches.push({
    op: 'add_item',
    target: `characters.${characterId}`,
    value: {
      id: `craft_${Date.now()}`,
      name: productName,
      description: craftOutput.checkSummary,
      quantity: craftOutput.craftParams.quantity,
      type: 'equipment',
      rarity: craftOutput.quality,
    },
  });

  // 2. 合并 item_gen 产出的物品数据
  if (itemOutput) {
    // 装备 → add_item + equip_item
    for (const equip of itemOutput.equipment) {
      patches.push({
        op: 'add_item',
        target: `characters.${characterId}`,
        value: {
          id: `craft_eq_${equip.slot}_${Date.now()}`,
          name: equip.name,
          description: equip.description,
          quantity: 1,
          type: 'equipment',
          rarity: equip.quality ?? craftOutput.quality,
        },
      });
      patches.push({
        op: 'equip_item',
        target: `characters.${characterId}`,
        value: {
          slot: equip.slot,
          itemId: `craft_eq_${equip.slot}_${Date.now()}`,
          name: equip.name,
        },
        metadata: {
          stats: equip.stats,
          durability: equip.durability,
        },
      });
    }

    // 库存品 → add_item
    for (const inv of itemOutput.inventory) {
      patches.push({
        op: 'add_item',
        target: `characters.${characterId}`,
        value: {
          id: `craft_inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: inv.name,
          description: inv.description,
          quantity: inv.quantity,
          type: inv.type,
          rarity: inv.rarity,
        },
      });
    }
  } else {
    // 没有 item_gen 输出: 只记录产物名称，后续可补
  }

  // 3. 经验 & FP 奖励
  if (craftOutput.craftParams.expGained > 0) {
    patches.push({
      op: 'delta_variable',
      target: `characters.${characterId}.exp`,
      amount: craftOutput.craftParams.expGained,
    });
  }
  if (craftOutput.craftParams.fpGained > 0) {
    patches.push({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: craftOutput.craftParams.fpGained,
    });
  }

  return patches;
}

/**
 * 完整 craft_gen 管线:
 * 1. callCraftGenAgent() → 制作检定 + 叙事
 * 2. callItemGenForCraft() → 产物数值 (如有 <item_requests>)
 * 3. buildCraftPatches() → StatePatch[]
 * 4. 可选持久化
 *
 * @returns { narrative, patches, craftOutput, itemOutput }
 *   - narrative: 注入回 story output 的制作叙事
 *   - patches: 提交给 StateManager 的状态变更
 */
export async function runCraftGenChain(
  request: CraftGenRequest,
  deps: CraftGenDeps,
): Promise<CraftGenChainResult> {
  // Step 1: callCraftGenAgent
  const craftOutput = await callCraftGenAgent(request, deps);

  // Step 2: callItemGenForCraft (only if successful and has item_requests)
  let itemOutput: ItemGenOutput | null = null;
  if (craftOutput.success && craftOutput.itemRequests.length > 0) {
    itemOutput = await callItemGenForCraft(craftOutput, request, deps);
  }

  // Step 3: build patches
  const characterId = request.marker.characterId ?? 'player_1';
  const patches = buildCraftPatches(craftOutput, itemOutput, characterId);

  // Step 4: optional persistence
  if (deps.stateManager) {
    await deps.stateManager.commitChatState(patches);
  }

  return {
    narrative: craftOutput.narrative,
    patches,
    craftOutput,
    itemOutput,
  };
}

// ========== XML Parsing Helpers ==========

/**
 * 解析 <craft_result> 标签内容
 */
function parseCraftResultTag(xml: string): CraftGenOutput {
  const success = extractTagContent('success', xml)?.trim().toLowerCase() === 'true';
  const productName = extractTagContent('product_name', xml)?.trim() ?? '';
  const quality = (extractTagContent('quality', xml)?.trim() ?? '普通') as QualityLevel;
  const rating = (extractTagContent('rating', xml)?.trim() ?? '失败') as CraftRating;
  const checkSummary = extractTagContent('check_summary', xml)?.trim() ?? '';
  const perfectionBonus = extractTagContent('perfection_bonus', xml)?.trim() || undefined;
  const narrative = extractTagContent('narrative', xml)?.trim() ?? '';

  // 解析 <item_requests> 块
  const itemRequestsXML = extractTagContent('item_requests', xml);
  const itemRequests = itemRequestsXML ? parseItemRequestsXML(itemRequestsXML) : [];

  // 解析 <craft_params>
  const craftParamsXML = extractTagContent('craft_params', xml);
  const craftParams = parseCraftParams(craftParamsXML ?? '');

  return {
    success,
    productName,
    quality,
    rating,
    checkSummary,
    perfectionBonus,
    itemRequests,
    narrative,
    craftParams,
  };
}

/**
 * 解析 <item_requests> 中的 <request> 子元素
 */
function parseItemRequestsXML(xml: string): ItemRequest[] {
  const requests: ItemRequest[] = [];
  const regex = /<request\b([^>]*?)>([\s\S]*?)<\/request>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const attrs = parseAttrsStr(match[1] ?? '');
    requests.push({
      type: (attrs['type'] as 'equipment' | 'inventory') ?? 'equipment',
      slot: attrs['slot'],
      quality: attrs['quality'] ?? '普通',
      description: (match[2] ?? '').trim(),
    });
  }

  return requests;
}

/**
 * 从 JSON 格式的 craft_gen 输出中提取 item_requests
 */
function parseItemRequestsJSON(parsed: any): ItemRequest[] {
  const reqs = parsed.item_requests ?? parsed.itemRequests ?? [];
  if (!Array.isArray(reqs)) return [];
  return reqs.map((r: any) => ({
    type: (r.type ?? 'equipment') as 'equipment' | 'inventory',
    slot: r.slot,
    quality: r.quality ?? '普通',
    description: r.description ?? '',
  }));
}

/**
 * 解析 <craft_params> 标签内容
 */
function parseCraftParams(xml: string): CraftGenOutput['craftParams'] {
  return {
    industry: (extractTagContent('industry', xml)?.trim() ?? '锻造') as CraftIndustry,
    targetQuality: (extractTagContent('target_quality', xml)?.trim() ?? '普通') as QualityLevel,
    stage: extractTagContent('stage', xml)?.trim() ?? '成品',
    quantity: parseInt(extractTagContent('quantity', xml)?.trim() ?? '1', 10) || 1,
    materials: extractTagContent('materials', xml)?.trim() ?? '',
    expGained: parseInt(extractTagContent('exp_gained', xml)?.trim() ?? '0', 10) || 0,
    fpGained: parseInt(extractTagContent('fp_gained', xml)?.trim() ?? '0', 10) || 0,
  };
}

// ========== Reused XML Utilities ==========
// (mirrors char-gen-agent.ts helpers for self-contained operation)

/**
 * 提取 XML 标签内容 (不包含标签本身)
 */
function extractTagContent(tagName: string, xml: string): string | null {
  const regex = new RegExp(`<${escapeRegex(tagName)}[^>]*?>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1] : null;
}

/**
 * 提取完整的 XML 标签块 (含标签)
 */
function extractTag(tagName: string, text: string): string | null {
  const regex = new RegExp(`<${escapeRegex(tagName)}[^>]*?>[\\s\\S]*?<\\/${escapeRegex(tagName)}>`, 'i');
  const match = regex.exec(text);
  return match ? match[0] : null;
}

/**
 * 从文本中提取 JSON (支持 markdown code block 和裸花括号)
 */
function extractJSON(text: string): string | null {
  // 尝试 ```json ... ``` 包裹
  const codeBlock = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match = codeBlock.exec(text);
  while (match) {
    const content = match[1].trim();
    if (content.startsWith('{') || content.startsWith('[')) return content;
    match = codeBlock.exec(text);
  }

  // 尝试裸花括号 (最外层)
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return null;
}

/**
 * 解析 XML 属性字符串 "key1="val1" key2="val2"" 为 Record
 */
function parseAttrsStr(attrsStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrsStr)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== Lazy Import for parseItemGenOutput ==========

/**
 * 懒加载 char-gen-agent 的 parseItemGenOutput。
 * 避免循环依赖 — craft-gen-chain 不直接 import char-gen-agent。
 */
async function parseItemGenOutput(raw: string): Promise<ItemGenOutput> {
  const { parseItemGenOutput } = await import('./char-gen-agent');
  return parseItemGenOutput(raw);
}
