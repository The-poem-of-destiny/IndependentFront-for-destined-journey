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
  CraftGenRequestMarker,
  ItemGenOutput,
  StatePatch,
  QualityLevel,
  CraftRating,
  CraftIndustry,
  ToolDefinition,
} from './types';
import { buildAgentMessagesAsync } from './agent-templates';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeSlot, normalizeItemType } from './field-enums';
import type { ToolExecutionContext } from './types';
// Q-05：XML / JSON 解析的唯一工具面（参数顺序一律 (source, tag)）
import { tagInner, tagBlock, parseAttrsStr } from './agent-xml';
import { extractJsonPayload } from './model-json';

// ========== Types ==========

export interface CraftGenRequest {
  saveId: string;
  marker: CraftRequestMarker | CraftGenRequestMarker; // 兼容新旧
  storyOutput: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 真机修(2026-07-17): 侧链 buildAgentMessages 需要完整配置才能拿到 systemPrompt + 世界书 */
  configs?: import('./types').AgentConfig[];
  worldBooks?: import('./types').WorldBook[];
  presets?: import('./types').AgentPreset[];
}

/** Helper: extract attributes from old or new marker shape */
function getMarkerAttr(
  marker: CraftRequestMarker | CraftGenRequestMarker,
  key: string,
): string | undefined {
  if (marker.type === 'craft_gen_request') {
    return (marker as CraftGenRequestMarker).attributes[
      key as keyof CraftGenRequestMarker['attributes']
    ] as string | undefined;
  }
  return (marker as any)[key] as string | undefined;
}

/** Helper: get body text from old or new marker */
function getMarkerBody(marker: CraftRequestMarker | CraftGenRequestMarker): string {
  if (marker.type === 'craft_gen_request') {
    return (marker as CraftGenRequestMarker).bodyText || '';
  }
  return (marker as CraftRequestMarker).bodyText || '';
}

export interface CraftGenDeps {
  /** AgentClient 工厂 — 每次调用创建新实例 (缓存隔离) */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CraftGenClient;
  /** StateManager 写入入口 (可选，测试可不提供) */
  stateManager?: {
    commitDomainCommand: (patches: StatePatch[]) => Promise<void>;
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
  /** Engine settlement, never parsed from model output. */
  settlementPatches?: StatePatch[];
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
  slot?: string; // equipment: 武器/头部/身体/腿部/脚部/首饰/戒指/项链
  quality: string;
  description: string; // 纯自然语言，不含数值
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
  // 构建上下文: 兼容新旧 marker 格式
  const markerBody = getMarkerBody(request.marker);
  const markerContext = [
    `一般制作请求: ${markerBody || request.marker.rawContent}`,
    getMarkerAttr(request.marker, 'industry')
      ? `行业: ${getMarkerAttr(request.marker, 'industry')}`
      : '',
    getMarkerAttr(request.marker, 'productName')
      ? `产物名: ${getMarkerAttr(request.marker, 'productName')}`
      : '',
    getMarkerAttr(request.marker, 'targetQuality')
      ? `目标品质: ${getMarkerAttr(request.marker, 'targetQuality')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const ctxWithStory: AgentContext = {
    ...request.context,
    agentOutputs: new Map([['story', markerContext]]),
  };

  const craftLocalParams: Record<string, string> = {
    CRAFT_REQUEST: markerBody || request.storyOutput,
  };

  // 真机修(2026-07-17): configs/worldBooks/presets 透传
  const messages = await buildAgentMessagesAsync(
    'craft_gen',
    ctxWithStory,
    request.configs,
    request.worldBooks,
    request.presets,
    craftLocalParams,
  );

  if (!messages) {
    throw new Error('craft_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('craft_gen', request.endpoint, request.saveId);

  // Agentic 路径: function calling 多轮循环
  if (client.chatWithTools) {
    const tools = getToolsForAgent('craft_gen');

    const settlementPatches: StatePatch[] = [];
    const parseOutput = (output: string): CraftGenOutput => ({
      ...parseCraftResultXML(output),
      settlementPatches: settlementPatches.length ? settlementPatches : undefined,
    });
    const toolContext: ToolExecutionContext = {
      characters: request.context.characters ?? [],
      variables: request.context.variables ?? {},
      saveId: request.saveId,
      stageCraftSettlement: (patches) => settlementPatches.push(...patches),
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
      // maxRounds=10 统一三条链口径 (item/char/craft)，craft_gen 需 get_inventory→craft_check→craft_settle 多轮往返
      { maxRounds: 10 },
    );

    if (result.error) {
      // 如果 Agentic 失败，回退到普通 chat
      const fallbackResult = await client.chat(messages);
      if (fallbackResult.output) {
        return parseOutput(fallbackResult.output);
      }
      throw new Error(`craft_gen Agentic 调用失败: ${result.error}`);
    }

    if (!result.output) {
      throw new Error('craft_gen 未返回输出');
    }

    return parseOutput(result.output);
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
  const itemRequestsXML = craftOutput.itemRequests
    .map((req) => {
      const slotAttr = req.slot ? ` slot="${req.slot}"` : '';
      return `<request type="${req.type}"${slotAttr} quality="${req.quality}">\n${req.description}\n</request>`;
    })
    .join('\n');

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

  // Phase 10: Build localParams from craft_gen's output for item_gen template resolution
  const craftItemLocalParams: Record<string, string> = {};
  // Extract <item_requests> from craftDataXML if present
  const craftItemReqMatch = craftDataXML.match(/<item_requests>([\s\S]*?)<\/item_requests>/);
  if (craftItemReqMatch) {
    craftItemLocalParams.ITEM_REQUEST = craftItemReqMatch[1].trim();
  }
  // Pass craft result
  craftItemLocalParams.CRAFT_RESULT = craftDataXML;

  try {
    // 构建 item_gen 上下文 — 对标 char_gen→item_gen: agentOutputs['char_gen'] 传角色数据
    const contextWithCraftData: AgentContext = {
      ...request.context,
      agentOutputs: new Map([
        ['craft_gen', craftDataXML],
        ['story', request.storyOutput],
      ]),
    };

    // 真机修(2026-07-17): configs/worldBooks/presets 透传
    const messages = await buildAgentMessagesAsync(
      'item_gen',
      contextWithCraftData,
      request.configs,
      request.worldBooks,
      request.presets,
      craftItemLocalParams,
    );
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
        // maxRounds=10 对齐独立 item_gen 链：equipment 类工具序列 5 轮会触顶
        { maxRounds: 10 },
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
  const craftTag = tagBlock(xml, 'craft_result');
  if (craftTag) {
    return parseCraftResultTag(craftTag);
  }

  // 尝试 JSON 兜底
  const json = extractJsonPayload(xml);
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
 * - delta_hp/delta_mp/delta_sp: 资源消耗（由 craft_settle 暂存，与制品同事务提交）
 */
export function buildCraftPatches(
  craftOutput: CraftGenOutput,
  itemOutput: ItemGenOutput | null,
  characterId: string,
): StatePatch[] {
  const patches: StatePatch[] = [];

  const productName = craftOutput.productName;

  // 1. 主产物写入背包 (add_item) — 仅成功产出完整制品
  // M3: item_gen equipment 已细化同名产物时跳过 — 以 item_gen 的完整数据为准
  // 不再两步落库；stats/durability/maxDurability 直写 value（#7）
  // S4d（2026-08-01 失败品链路）：失败时跳过主产物——失败品由 item_gen 以 <item_requests> 产出（下方第 2 步）
  if (craftOutput.success) {
    const productElaboratedByItemGen =
      itemOutput?.equipment.some((e) => e.name === productName) ?? false;
    if (!productElaboratedByItemGen) {
      patches.push({
        op: 'add_item',
        target: `characters.${characterId}`,
        value: {
          name: productName,
          description: craftOutput.checkSummary,
          quantity: craftOutput.craftParams.quantity,
          type: normalizeItemType('equipment') ?? '装备',
          rarity: craftOutput.quality,
        },
      });
    }
  }

  // 2. 合并 item_gen 产出的物品数据（M3: 装备单 add_item 带 equippedSlot，不再两步）
  // S4d：成功=完整制品；失败=失败品/残料（craft_gen prompt 要求 type="inventory" 材料类）
  //   ——失败品不 auto-equip（剥离 equippedSlot），也不进装备槽，仅背包可见
  if (itemOutput) {
    for (const equip of itemOutput.equipment) {
      patches.push({
        op: 'add_item',
        target: `characters.${characterId}`,
        value: {
          name: equip.name,
          description: equip.description,
          quantity: 1,
          type: '装备',
          rarity: equip.quality ?? craftOutput.quality,
          // 失败品不 auto-equip（S4d：craft_gen 失败时产物留在背包，不穿上）
          equippedSlot: craftOutput.success
            ? normalizeSlot(equip.slot) // M3: slot 归一化
            : undefined,
          stats: equip.stats, // M3: stats 归位 value（#7）
          durability: equip.durability, // M3: durability 归位 value（#7）
          maxDurability: equip.durability,
          // 战斗 v2 (M4 5.5b): modifiers/buffs/divinity 写进 patch value（战斗管线 collect_mods 消费）
          ...(equip.modifiers ? { modifiers: equip.modifiers } : {}),
          ...(equip.buffs ? { buffs: equip.buffs } : {}),
          ...(equip.divinity !== undefined ? { divinity: equip.divinity } : {}),
          // 🆕 战斗 v3 (S3 2026-08-01): <automaton> DSL 自由效果透传
          ...(equip.automata && equip.automata.length > 0 ? { automata: equip.automata } : {}),
        },
      });
    }

    // 库存品 → add_item
    for (const inv of itemOutput.inventory) {
      patches.push({
        op: 'add_item',
        target: `characters.${characterId}`,
        value: {
          name: inv.name,
          description: inv.description,
          quantity: inv.quantity,
          type: normalizeItemType(inv.type) ?? inv.type, // M3: type 归一化（#38）
          rarity: inv.rarity,
          // 战斗 v2 (M4 5.5b): modifiers/buffs/divinity 写进 patch value
          ...(inv.modifiers ? { modifiers: inv.modifiers } : {}),
          ...(inv.buffs ? { buffs: inv.buffs } : {}),
          ...(inv.divinity !== undefined ? { divinity: inv.divinity } : {}),
          // 🆕 战斗 v3 (S3 2026-08-01): <automaton> DSL 自由效果透传
          ...(inv.automata && inv.automata.length > 0 ? { automata: inv.automata } : {}),
        },
      });
    }
  }

  // 3. 经验奖励 → update_character delta（M3: 不再走 delta_variable，#12 exp 侧）
  // S4d：失败/大失败不结算 EXP/FP（craft_gen 失败时 expGained/fpGained 为 0，这里双重保险）
  if (
    !craftOutput.settlementPatches &&
    craftOutput.success &&
    craftOutput.craftParams.expGained > 0
  ) {
    patches.push({
      op: 'update_character',
      target: `characters.${characterId}`,
      value: { totalExp: craftOutput.craftParams.expGained },
      metadata: { source: 'craft_gen', delta: true },
    });
  }
  // 4. FP 奖励 → delta_variable profile.fp（M5 改 FP op 前保持现状）
  if (
    !craftOutput.settlementPatches &&
    craftOutput.success &&
    craftOutput.craftParams.fpGained > 0
  ) {
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

  // Step 2: callItemGenForCraft
  // S4d（2026-08-01 失败品链路）：成功/失败都发 item_gen——
  //   craft_gen prompt 要求失败时也输出 <item_requests>（失败品/残料，type="inventory" 材料类），
  //   item_gen 为失败品写数值（品质普通/低值），buildCraftPatches 落库但不 auto-equip、不结算 EXP/FP。
  let itemOutput: ItemGenOutput | null = null;
  if (craftOutput.itemRequests.length > 0) {
    itemOutput = await callItemGenForCraft(craftOutput, request, deps);
  }

  // Step 3: build patches（M3: owner 优先 marker attribute，缺省取 context 玩家名；#6 player_1 灭绝）
  const characterId =
    getMarkerAttr(request.marker, 'characterId') ??
    request.context.characters?.find((c) => c.type === 'player')?.name ??
    '';
  if (!characterId) {
    console.warn('[craft-gen-chain] 无 owner 且无玩家角色，craft patches 将跳过角色目标');
    return { narrative: craftOutput.narrative, patches: [], craftOutput, itemOutput };
  }
  const patches = [
    ...(craftOutput.settlementPatches ?? []),
    ...buildCraftPatches(craftOutput, itemOutput, characterId),
  ];

  // Step 4: optional persistence
  if (deps.stateManager) {
    await deps.stateManager.commitDomainCommand(patches);
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
  const success = tagInner(xml, 'success')?.trim().toLowerCase() === 'true';
  const productName = tagInner(xml, 'product_name')?.trim() ?? '';
  const quality = (tagInner(xml, 'quality')?.trim() ?? '普通') as QualityLevel;
  const rating = (tagInner(xml, 'rating')?.trim() ?? '失败') as CraftRating;
  const checkSummary = tagInner(xml, 'check_summary')?.trim() ?? '';
  const perfectionBonus = tagInner(xml, 'perfection_bonus')?.trim() || undefined;
  const narrative = tagInner(xml, 'narrative')?.trim() ?? '';

  // 解析 <item_requests> 块
  const itemRequestsXML = tagInner(xml, 'item_requests');
  const itemRequests = itemRequestsXML ? parseItemRequestsXML(itemRequestsXML) : [];

  // 解析 <craft_params>
  const craftParamsXML = tagInner(xml, 'craft_params');
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
    industry: (tagInner(xml, 'industry')?.trim() ?? '锻造') as CraftIndustry,
    targetQuality: (tagInner(xml, 'target_quality')?.trim() ?? '普通') as QualityLevel,
    stage: tagInner(xml, 'stage')?.trim() ?? '成品',
    quantity: parseInt(tagInner(xml, 'quantity')?.trim() ?? '1', 10) || 1,
    materials: tagInner(xml, 'materials')?.trim() ?? '',
    expGained: parseInt(tagInner(xml, 'exp_gained')?.trim() ?? '0', 10) || 0,
    fpGained: parseInt(tagInner(xml, 'fp_gained')?.trim() ?? '0', 10) || 0,
  };
}

// XML / JSON 解析工具统一在 agent-xml.ts 与 model-json.ts（Q-05）——
// 本文件曾自带一套镜像 helper，其中 extractTag 与 char-gen-agent 的同名函数**语义相反**：
// 这边 (tag, text) 返回含标签整块，那边 (xml, tag) 返回标签内文。签名同为 (string, string)，
// 连定义带调用一起复制过去编译照过，运行时把整块 XML 当字段值写进档案。

// ========== Lazy Import for parseItemGenOutput ==========

/**
 * 懒加载 char-gen-agent 的 parseItemGenOutput。
 * 避免循环依赖 — craft-gen-chain 不直接 import char-gen-agent。
 */
async function parseItemGenOutput(raw: string): Promise<ItemGenOutput> {
  const { parseItemGenOutput } = await import('./char-gen-agent');
  return parseItemGenOutput(raw);
}
