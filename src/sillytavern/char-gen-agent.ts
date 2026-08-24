/**
 * Char Gen Agent — 角色生成编排模块 (Phase 6e)
 *
 * ADR-26: char_gen → item_gen SubAgent 链 (仅1次调用)
 * 触发时机: vars_update (Stage 2) 检测到 <char_detect> 标记后异步触发
 * 下一个流程 (Stage 3): char_update × N 并行，包含新生成的角色
 *
 * 职责:
 * 1. detectNewCharacters() — 扫描 <char_detect> + 过滤已存在角色
 * 2. runCharGenChain() — 完整链: callCharGenAgent → callItemGenAgent → assemble → buildPatches
 * 3. assembleCharacterState() — 纯函数: 合并 Agent 输出为完整 CharacterState
 * 4. buildCharGenPatches() — 生成 add_character + add_skill + add_item + equip_item patches
 *
 * 依赖注入 (测试友好):
 * - CharGenAgentDeps.clientFactory: AgentClient 工厂
 * - CharGenAgentDeps.stateManager: StateManager (可选，用于持久化)
 */

import type {
  AgentContext,
  ApiEndpoint,
  CharDetectMarker,
  CharGenRequestMarker,
  CharGenOutput,
  CharGenChainResult,
  ItemGenOutput,
  CharacterState,
  StatePatch,
  QualityLevel,
  InventoryItem,
  ToolDefinition,
  DamageType,
} from './types';
import { createDefaultCharacterState } from './types';
import type { Modifier } from './effect-types';
import type { DivinityLevel } from './types';
// 🆕 战斗 v3 (S3 2026-08-01): <automaton> 解析 → EffectAutomaton[]（v3 内核 DSL 类型）
import type { EffectAutomaton } from './combat-v3/types';
import { scanCharDetects } from './marker-protocol';
import { buildAgentMessagesAsync } from './agent-templates';
import { getTierConfig, calcResources } from './tier-constants';
import { xpToNextNumber } from './exp-table';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeSlot } from './field-enums';
import { validateItemOutput } from './combat-item-validator';
import type { ToolExecutionContext } from './types';
// Q-05：XML / JSON 解析的唯一工具面。参数顺序一律 (source, tag)，
// 名字自带语义（tagInner=内文 / tagBlock=含标签整块），不再有叫 extractTag 的东西。
import {
  tagInner,
  tagBlock,
  tagAttr,
  tagAttrInt,
  parseAttrsStr,
  stripInnerTags,
  parseNamedChildren,
  stripKnownChildBlocks,
} from './agent-xml';
import { extractJsonPayload } from './model-json';

/** 剥壳取 JSON；抠不到时退回原文（本文件历史行为——调用方自己 try/catch parse） */
function extractJsonOrRaw(text: string): string {
  return extractJsonPayload(text) ?? text;
}

// ========== Types ==========

export interface CharGenRequest {
  saveId: string;
  /** @deprecated 旧字段，新流程使用 marker (CharGenRequestMarker) */
  detection?: CharDetectMarker;
  /** 新流程：vars_update 输出的 char_gen_request marker */
  marker?: CharGenRequestMarker;
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 真机修(2026-07-17): 侧链 buildAgentMessages 需要完整配置才能拿到 systemPrompt + 世界书 */
  configs?: import('./types').AgentConfig[];
  worldBooks?: import('./types').WorldBook[];
  presets?: import('./types').AgentPreset[];
}

export interface CharGenAgentDeps {
  /** AgentClient 工厂 — 每次调用创建新实例 (缓存隔离) */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CharGenClient;
  /** StateManager 写入入口 (可选，测试可不提供) */
  stateManager?: {
    commitChatState: (patches: StatePatch[]) => Promise<void>;
  };
}

/**
 * CharGen 客户端接口 — 抽象的 API 调用层。
 * 生产环境使用 AgentClient，测试使用 mock。
 *
 * 🔴 2026-08-04: `chatWithTools` 是**必填**，且本接口不再声明 `chat`。
 *   此前 `chatWithTools` 可选 + 一条 `client.chat(messages)` 回退路径，而回退路径
 *   声明的是 `chat(messages: Array<…>)`、真正的 `AgentClient.chat` 收的是
 *   `chat(request: ChatRequest)`（messages 在 request 里）—— 形状不符，走上去
 *   `request.messages` 是 undefined，`ensureUserMessage` 读 `.length` 抛 TypeError，
 *   被 chat 的重试循环吞成 `{ error }`，最终报成一句和真因无关的「char_gen Agent 调用失败」。
 *
 *   那条路在生产里**不可达**：唯一的 clientFactory 是 `GamePipeline.getClientFactory()`，
 *   它返回的包装对象恒定带 `chatWithTools`（内部委托 `AgentClient.chatWithTools`，
 *   是类方法、不是可选属性），也没有任何开关能摘掉它 —— `AgentConfig.toolsEnabled`
 *   是 orchestrator 的概念，本链自带 clientFactory、根本不读它。
 *
 *   所以不修签名而是**删接口**：把 `chatWithTools` 提成必填，未来任何新 client
 *   少实现它当场编译不过，不必再靠一条永不执行的回退路径兜底。
 */
export interface CharGenClient {
  /** Phase 8.5 Agentic: 多轮 function calling —— 本链唯一的调用路径 */
  chatWithTools: (
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

// ========== Public API ==========

/**
 * 从 story 输出中检测新角色。
 * 扫描 <char_detect> 标记，过滤掉名字已存在于 existingChars 中的角色。
 *
 * @param storyOutput - Stage 1 story agent 的原始输出
 * @param existingChars - 当前存档中已有的角色列表
 * @returns 需要生成的新角色标记列表
 */
export function detectNewCharacters(
  storyOutput: string,
  existingChars: CharacterState[],
): CharDetectMarker[] {
  const allDetects = scanCharDetects(storyOutput);
  if (allDetects.length === 0) return [];

  const existingNames = new Set(existingChars.map((c) => c.name.toLowerCase()));

  return allDetects.filter((marker) => {
    // 如果没有名字，视为新角色（需要生成名字）
    if (!marker.characterName) return true;
    // 如果名字已存在，跳过
    return !existingNames.has(marker.characterName.toLowerCase());
  });
}

/**
 * 调用 char_gen Agent — 生成角色基础数据。
 * 使用 AgentClient 调用 AI，agentId='char_gen'。
 */
export async function callCharGenAgent(
  request: CharGenRequest,
  deps: CharGenAgentDeps,
): Promise<CharGenOutput> {
  // 新格式优先: CharGenRequestMarker (vars_update 输出)
  // 旧格式兼容: CharDetectMarker (Story Agent 输出的 char_detect)
  const markerOrDetect = request.marker ?? request.detection;
  const bodyText = markerOrDetect?.bodyText ?? markerOrDetect?.rawContent ?? '';

  // 真机修(2026-07-17): bodyText 不含标签属性 → characterName/race/tier 等指定信息丢失，
  // char_gen 自造名字（dispatcher 要"妲丽安"产出"薇拉"）。把属性拼成指定信息行注入。
  const attrs = (request.marker?.attributes ?? {}) as Record<string, string | undefined>;
  const attrLines = [
    attrs.characterName
      ? `指定名称: ${attrs.characterName}（正文已出现的名字必须沿用；若这是描述性称呼而正文里有真名，用真名）`
      : '',
    attrs.race && attrs.race !== '未知' ? `种族: ${attrs.race}` : '',
    attrs.tier && attrs.tier !== '未知' ? `层级: ${attrs.tier}` : '',
    attrs.characterType ? `类型: ${attrs.characterType}` : '',
    attrs.faction && attrs.faction !== '未知' ? `势力: ${attrs.faction}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const requestContent = [attrLines, bodyText].filter(Boolean).join('\n');

  // Bug fix 1: Set BOTH keys so templates with {{CHAR_DETECT}} or {{CHAR_GEN_REQUEST}} both resolve.
  // The char_gen template in agent-config.json uses {{CHAR_DETECT}}, but Phase 10 flows
  // via request_dispatcher may produce {{CHAR_GEN_REQUEST}} in newer template variants.
  const charLocalParams: Record<string, string> = {};
  if (requestContent) {
    charLocalParams['CHAR_DETECT'] = requestContent;
    charLocalParams['CHAR_GEN_REQUEST'] = requestContent;
  }

  // Bug fix 2: Do NOT overwrite agentOutputs with a tiny Map containing only the marker body.
  // The original context already has the full story output from the upstream agent.
  // The marker body is passed via charLocalParams (CHAR_DETECT / CHAR_GEN_REQUEST).
  // 真机修(2026-07-17): configs/worldBooks/presets 透传 — 此前恒 undefined，
  // char_gen 的 systemPrompt 退化为一行 stub + {{LORE_BOOK}} 恒空（命名/格式纪律全失效）。
  const messages = await buildAgentMessagesAsync(
    'char_gen',
    request.context,
    request.configs,
    request.worldBooks,
    request.presets,
    charLocalParams,
  );

  if (!messages) {
    throw new Error('char_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('char_gen', request.endpoint, request.saveId);

  // Phase 8.5 Agentic 路径（function calling 多轮循环）—— 唯一路径，见 CharGenClient 注释
  const tools = getToolsForAgent('char_gen');
  const toolContext: ToolExecutionContext = {
    characters: request.context.characters ?? [],
    variables: request.context.variables ?? {},
    saveId: request.saveId,
  };

  const result = await client.chatWithTools(
    { messages, tools, tool_choice: 'auto' },
    async (name, args) => executeToolCall(name, args, toolContext),
    { maxRounds: 10 },
  );

  if (result.error) {
    throw new Error(`char_gen Agent 调用失败: ${result.error}`);
  }

  const rawOutput = result.output ?? result.rawResponse;
  const parsed = parseCharGenOutput(rawOutput);
  parsed.rawXml = rawOutput;
  return parsed;
}

/**
 * 调用 item_gen Agent — 为已生成角色创建装备/技能/物品。
 * 使用 AgentClient 调用 AI，agentId='item_gen'。
 * ADR-26: 仅调用 1 次，防止高并发浪费 token。
 */
export async function callItemGenAgent(
  charData: CharGenOutput,
  request: CharGenRequest,
  deps: CharGenAgentDeps,
): Promise<ItemGenOutput> {
  const contextWithCharData: AgentContext = {
    ...request.context,
    agentOutputs: new Map([
      ['char_gen', JSON.stringify(charData)],
      ['story', request.marker?.rawContent ?? request.detection?.rawContent ?? ''],
    ]),
  };

  // Phase 10: Build localParams from char_gen's output for item_gen template resolution
  const charGenOutputJson = JSON.stringify(charData);
  const charItemLocalParams: Record<string, string> = {
    CHAR_GEN_RESULT: charGenOutputJson,
  };
  // 真机 fix(2026-07-18): 从 char_gen 原始 XML 提取 <item_requests>/<skill_requests>/<equipment_requests>
  // 旧代码在 JSON.stringify 输出里搜 XML 标签 → 永远搜不到 → ITEM_REQUEST 恒空
  const rawXml = charData.rawXml;
  if (rawXml) {
    const itemReqMatch = rawXml.match(/<item_requests>([\s\S]*?)<\/item_requests>/);
    const skillReqMatch = rawXml.match(/<skill_requests>([\s\S]*?)<\/skill_requests>/);
    const equipReqMatch = rawXml.match(/<equipment_requests>([\s\S]*?)<\/equipment_requests>/);
    if (itemReqMatch) charItemLocalParams.ITEM_REQUEST = itemReqMatch[1].trim();
    if (skillReqMatch) charItemLocalParams.SKILL_REQUEST = skillReqMatch[1].trim();
    if (equipReqMatch) charItemLocalParams.EQUIP_REQUEST = equipReqMatch[1].trim();
  }

  const messages = await buildAgentMessagesAsync(
    'item_gen',
    contextWithCharData,
    request.configs,
    request.worldBooks,
    request.presets,
    charItemLocalParams,
  );

  if (!messages) {
    throw new Error('item_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('item_gen', request.endpoint, request.saveId);

  // Phase 8.5 Agentic 路径（function calling 多轮循环）—— 唯一路径，见 CharGenClient 注释
  const tools = getToolsForAgent('item_gen');
  const toolContext: ToolExecutionContext = {
    characters: request.context.characters ?? [],
    variables: request.context.variables ?? {},
    saveId: request.saveId,
  };

  const result = await client.chatWithTools(
    { messages, tools, tool_choice: 'auto' },
    async (name, args) => executeToolCall(name, args, toolContext),
    { maxRounds: 10 },
  );

  if (result.error) {
    // item_gen 失败不阻断流程 — 返回空物品数据
    return { skills: [], equipment: [], inventory: [] };
  }

  const rawOutput = result.output ?? result.rawResponse;
  return parseItemGenOutput(rawOutput);
}

/**
 * 纯函数: 将 char_gen + item_gen 的输出合并为完整的 CharacterState。
 * 使用 createDefaultCharacterState() 作为基础模板。
 *
 * @param charData - char_gen Agent 的输出
 * @param itemData - item_gen Agent 的输出
 * @param overrides - 可选的额外覆盖
 */
export function assembleCharacterState(
  charData: CharGenOutput,
  itemData: ItemGenOutput,
  overrides: Partial<CharacterState> = {},
): CharacterState {
  const tierConfig = getTierConfig(charData.tier);
  const tierName = tierConfig?.name ?? '普通';

  // 合并技能: char_gen 自产优先，item_gen 补充（去重+合并）
  const charSkills = charData.skills ?? [];
  const itemGenSkills = itemData.skills ?? [];
  const charSkillNames = new Set(charSkills.map((s) => s.name));
  // item_gen 的 skill 不覆盖 char_gen 同名
  const mergedSkills = [...itemGenSkills.filter((s) => !charSkillNames.has(s.name)), ...charSkills];

  const skills = mergedSkills.map((s) => ({
    name: s.name,
    description: s.description,
    type: s.type,
    cost: s.cost ? { type: s.cost.type, amount: s.cost.amount } : undefined,
    cooldown: s.cooldown,
    level: 1,
    effects: s.effects,
    scripts: s.scripts,
    // 战斗 v2 (M4 5.5b): <modifiers>/<buffs>/<divinity> 透传（技能生产检定加值落库，S4 收 S2-2）
    // Q-13：这四个字段在 CharGenOutput / ItemGenOutput 上都已显式声明，不需要 as any
    ...(s.modifiers && s.modifiers.length > 0 ? { modifiers: s.modifiers } : {}),
    ...(s.buffs && s.buffs.length > 0 ? { buffs: s.buffs } : {}),
    ...(s.divinity !== undefined ? { divinity: s.divinity } : {}),
    // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传到 Skill 落库
    ...(s.automata && s.automata.length > 0 ? { automata: s.automata } : {}),
    // 🆕 skillPower 链路修复 (2026-08-04): 主体威力三字段透传到 Skill 落库
    ...(s.skillPower !== undefined ? { skillPower: s.skillPower } : {}),
    ...(s.relevantAttribute ? { relevantAttribute: s.relevantAttribute } : {}),
    ...(s.damageType ? { damageType: s.damageType } : {}),
  }));

  // 合并装备: char_gen 自产优先
  // M3: 装备产物直接写成带 equippedSlot 的 InventoryItem（规范 §3），scripts 无损传递（#45）
  const charEquip = charData.equipment ?? [];
  const itemGenEquip = itemData.equipment ?? [];
  const charEquipNames = new Set(charEquip.map((e) => e.name));
  const mergedEquip = [...itemGenEquip.filter((e) => !charEquipNames.has(e.name)), ...charEquip];

  const equippedItems: InventoryItem[] = mergedEquip.map((e) => ({
    name: e.name,
    description: e.description,
    quantity: 1,
    type: '装备',
    equippedSlot: normalizeSlot(e.slot), // 无法识别 → null（躺背包），铁律5
    stats: e.stats,
    durability: e.durability,
    maxDurability: e.durability,
    effects: e.effects,
    scripts: e.scripts, // M3: scripts 无损传递（#45）
    // 战斗 v2 (M4 5.5b): modifiers/buffs/divinity 透传到 InventoryItem（战斗管线 collect_mods 消费）
    ...(e.modifiers ? { modifiers: e.modifiers } : {}),
    ...(e.buffs ? { buffs: e.buffs } : {}),
    ...(e.divinity !== undefined ? { divinity: e.divinity } : {}),
    // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传到 InventoryItem（v3 编译进 activeEffects）
    ...(e.automata && e.automata.length > 0 ? { automata: e.automata } : {}),
  }));
  // 合并背包: char_gen 自产优先
  // M3: inventory 物品 effects/scripts 无损传递，废除 id 生成（#45）
  const charInv = charData.inventory ?? [];
  const itemGenInv = itemData.inventory ?? [];
  const charInvNames = new Set(charInv.map((i) => i.name));
  const mergedInv = [...itemGenInv.filter((i) => !charInvNames.has(i.name)), ...charInv];

  const inventory: InventoryItem[] = [
    ...mergedInv.map((inv) => ({
      name: inv.name,
      description: inv.description,
      type: inv.type,
      quantity: inv.quantity,
      rarity: (inv.rarity as QualityLevel) || undefined,
      effects: inv.effects, // M3: effects 无损传递（#45）
      scripts: inv.scripts, // M3: scripts 无损传递（#45）
      // 战斗 v2 (M4 5.5b): modifiers/buffs/divinity 透传
      ...(inv.modifiers ? { modifiers: inv.modifiers } : {}),
      ...(inv.buffs ? { buffs: inv.buffs } : {}),
      ...(inv.divinity !== undefined ? { divinity: inv.divinity } : {}),
      // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传到 InventoryItem
      ...(inv.automata && inv.automata.length > 0 ? { automata: inv.automata } : {}),
    })),
    // M3: 装备产物并入 inventory（equippedSlot 非空 = 已穿戴）
    ...equippedItems,
  ];

  return createDefaultCharacterState({
    type: 'npc',
    name: charData.name,
    race: charData.race,
    identity: charData.identity,
    occupation: charData.occupation,
    tier: charData.tier,
    tierName,
    level: charData.level,
    attributes: charData.attributes,
    ...calcResources(charData.tier, charData.attributes),
    expToNext: xpToNextNumber(charData.level),
    ascension: {
      enabled: charData.ascension.enabled,
      elements: (charData.ascension.elements ?? []).map((e, i) => ({
        name: e.name,
        description: e.description,
        effects: e.effects,
        effectDescriptions: itemData.elements?.[i]?.effectDescriptions,
        scripts: itemData.elements?.[i]?.scripts,
      })),
      authority: (charData.ascension.authorities ?? []).map((a, i) => ({
        name: a.name,
        description: a.description,
        effects: a.effects,
        costDescription: a.costDescription,
        effectDescriptions: itemData.authorities?.[i]?.effectDescriptions,
        scripts: itemData.authorities?.[i]?.scripts,
      })),
      law: (charData.ascension.laws ?? []).map((l) => ({
        name: l.name,
        description: l.description,
        effects: [...(l.passiveEffects ?? []), ...(l.activeEffects ?? [])],
        costDescription: l.costDescription,
      })),
      deityPosition: charData.ascension.deityPosition || '',
      divineKingdom: charData.ascension.divineKingdom || { name: '', description: '' },
    },
    skills,
    inventory,
    // M3/M6: 正式字段直写（规范 §2.1），customFields 只留真扩展数据（双写退役完成）
    appearance: charData.appearance,
    background: charData.background,
    personality: charData.personality,
    gender: charData.gender,
    outfit: charData.clothing,
    thoughts: charData.thoughts,
    customFields: {
      likes: charData.likes,
      faction: charData.faction,
      ascensionPath: charData.ascension.path,
      ascensionDescription: charData.ascension.description,
    },
    ...overrides,
  });
}

/**
 * 为生成的 CharacterState 构建 StatePatch[]（M3: 单 add_character 落库，零附属 patch）。
 *
 * M3 重写要点:
 * - 附属 add_skill/add_item/equip_item 整体删除 — 全部数据内嵌在 add_character value 里一次落库
 *   （旧行为: 附属 patch 恒 errors，靠 add_character 兜底；删掉即修 #11 且防 target 修好后的二次叠加）
 * - ascension 数据已嵌入 add_character value 本体，删除 set_variable patch（#12 杀）
 * - target 用 character.name（铁律1: 名字寻址）
 */
export function buildCharGenPatches(character: CharacterState): StatePatch[] {
  const patches: StatePatch[] = [];

  // 1. 添加角色 — 单 patch，所有数据内嵌（skills/inventory/ascension 已在 value 体内）
  patches.push({
    op: 'add_character',
    target: `characters.${character.name}`,
    value: character,
    metadata: { source: 'char_gen', phase: '6e' },
  });

  return patches;
}

/**
 * 完整的角色生成链入口 — char_gen → item_gen → assemble → buildPatches。
 *
 * 流程:
 * 1. callCharGenAgent() — 生成角色基础数据
 * 2. callItemGenAgent() — 生成装备/技能/物品 (仅1次)
 * 3. assembleCharacterState() — 合并为完整 CharacterState
 * 4. buildCharGenPatches() — 生成 StatePatch[]
 * 5. (可选) stateManager.commitChatState() — 持久化
 *
 * @returns CharGenChainResult (含 character + patches + narrativeSummary)
 */
export async function runCharGenChain(
  request: CharGenRequest,
  deps: CharGenAgentDeps,
): Promise<CharGenChainResult> {
  // Step 1: 生成角色基础数据
  const charData = await callCharGenAgent(request, deps);

  // Step 2: 生成装备/技能/物品 (仅1次, ADR-26)
  const itemData = await callItemGenAgent(charData, request, deps);

  // Step 3: 组装完整 CharacterState
  const playerLocation = resolvePlayerLocation(request);
  const character = assembleCharacterState(charData, itemData, {
    ...(playerLocation ? { location: playerLocation } : {}),
    present: true,
  });

  // Step 4: 生成 StatePatch[]
  const patches = buildCharGenPatches(character);

  // Step 5: (可选) 持久化
  if (deps.stateManager) {
    await deps.stateManager.commitChatState(patches);
  }

  // 叙事摘要
  const narrativeSummary = `新角色「${charData.name}」已生成: ${charData.race} ${charData.occupation.join('/')}, T${charData.tier} Lv.${charData.level}, ${charData.background.slice(0, 100)}`;

  return { character, patches, narrativeSummary };
}

// ──────────────────────────────────────────────────────────────────────────────
// 战斗 v3 召唤入口（M3.5，架构 §十 10.2 / plan §6.3）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗 v3 的新单位生成入口 — char_gen 战斗中调用（架构 §十 10.2，plan §6.3）。
 *
 * 与 runCharGenChain 并列存在，不改现有入口。差异：
 *   - 「战斗中、单个、**不落库**」——召唤物只活在 CombatState 内（ADR-11：单位属性/参战时机/
 *     持续时长 = 创造性归 char_gen；插入先攻/扣血/到期移除 = 确定性归内核）
 *   - 复用 callCharGenAgent → callItemGenAgent → assembleCharacterState 的现有链路，
 *     但**跳过 buildCharGenPatches / commitChatState**（不产生 add_character patch、不写 DB）
 *   - 输出 SummonedUnitDefinition（供 coordinator 构造 SupplyUnit 提交内核）
 *
 * @param req.prompt      召唤引导（种族/层级/定位/来源物品/召唤者意图）
 * @param req.constraints 边界（divinityCap 属性预算 持续轮数）——仅供 prompt 引导与 coordinator clamp
 * @param req.base        基础 CharGenRequest（saveId/context/endpoint/configs/worldBooks/presets）——复用上游请求上下文
 */
export async function runCharGenForCombat(
  req: {
    prompt: {
      race?: string;
      tier?: number;
      role?: string;
      sourceItem: string;
      summonerIntent: string;
    };
    constraints: { divinityCap: number; attributeBudget: number; durationRounds?: number };
    base: CharGenRequest;
  },
  deps: CharGenAgentDeps,
): Promise<import('./combat-v3/types').SummonedUnitDefinition> {
  // 构造一个 char_gen 可消费的 marker（bodyText 携带召唤引导，attribute 携带指定信息）
  const tierStr = req.prompt.tier !== undefined ? String(req.prompt.tier) : undefined;
  const rawContent = [
    '<char_gen_request race="' + (req.prompt.race ?? '') + '" tier="' + (tierStr ?? '') + '">',
    `来源物品: ${req.prompt.sourceItem}`,
    req.prompt.role ? `战斗定位: ${req.prompt.role}` : '',
    `召唤者意图: ${req.prompt.summonerIntent}`,
    req.constraints.durationRounds ? `持续回合: ${req.constraints.durationRounds}` : '',
    '</char_gen_request>',
  ]
    .filter((s) => s !== '')
    .join('\n');

  const marker: CharGenRequestMarker = {
    type: 'char_gen_request',
    attributes: {
      characterName: undefined,
      race: req.prompt.race,
      tier: tierStr,
      characterType: 'summon',
      faction: undefined,
    },
    bodyText: rawContent,
    rawContent,
    position: 0,
  };

  const request: CharGenRequest = { ...req.base, marker };

  // 链：char_gen → item_gen → assemble（无 buildPatches / 无 commitChatState）
  const charData = await callCharGenAgent(request, deps);
  const itemData = await callItemGenAgent(charData, request, deps);
  const character = assembleCharacterState(charData, itemData, { present: true });

  // 映射为 SummonedUnitDefinition（不落库）。CharacterState 无 defense/dr（那些在
  // CombatParticipant），召唤物防御/DR 走保守默认，由内核/后续战斗管线逐步精化。
  return {
    name: character.name,
    race: character.race,
    tier: character.tier,
    level: character.level,
    attributes: { ...character.attributes },
    hp: character.maxHp,
    mp: character.maxMp,
    sp: character.maxSp,
    defense: 0,
    dr: 0,
    penetration: 0,
    hitBonus: 10,
    dodgeBonus: 5,
    weaponAtk: 30,
    // 召唤物自身的登神强度：CharGenOutput 无顶层 divinity，按层级保守推导（T2+ 才非零），
    // 并严格 clamp 到约束 cap（架构 §6.2 ④ divinity ≤ 物品自身声明）
    divinity: Math.min(req.constraints.divinityCap, Math.max(0, charData.tier - 1)),
    side: 'player',
    joinTiming: 'next_round_head',
    ...(req.constraints.durationRounds
      ? { duration: { rounds: req.constraints.durationRounds } }
      : {}),
    actionEconomy: 'full',
    skills: charData.skills.map((s) => s.name),
    sourceItem: req.prompt.sourceItem,
  };
}

// ========== Internal Helpers ==========

// ── 战斗 v2 (M4 5.5b): <modifiers> 子元素解析 + 校验接入 ──

/**
 * 战斗物品产出校验结果（parse <modifiers> 后接入 validateItemOutput，违规 warn 不中断）。
 *
 * 设计: 本函数是「parse → 校验 → 收集」三合一，返回合规的 modifiers 数组 + 聚合 divinity。
 * 违规的 modifier 不进结果（避免一个坏 modifier 污染战斗管线），但只 console.warn 不抛，
 * 保证单件坏装备 modifier 不会让整条 item_gen 链失败（§6.6 校验规则接入点）。
 *
 * @param itemName 该元素的名字（装备/技能/物品名，用于 warn 日志溯源）
 * @param modifiers 从 <modifiers> 子元素 parse 出的全部 modifier（含可能违规的）
 * @param buffs 该元素附带的 buff（含可能违规的）
 * @returns { modifiers: 合规 Modifier[], divinity: 聚合登神等级 }
 */
function validateAndCollectCombatEffects(
  itemName: string,
  modifiers: Modifier[],
  buffs: ItemGenOutput['equipment'][number]['buffs'],
): { modifiers: Modifier[]; buffs: NonNullable<typeof buffs>; divinity?: DivinityLevel } {
  if (modifiers.length === 0 && (!buffs || buffs.length === 0)) {
    return { modifiers: [], buffs: [] as NonNullable<typeof buffs> };
  }

  const result = validateItemOutput({ modifiers, buffs: buffs ?? [] });

  // 收集合规 modifier（违规的丢弃 + warn）
  const validModifiers: Modifier[] = [];
  result.modifierErrors.forEach((errs, i) => {
    if (errs.length === 0) {
      validModifiers.push(modifiers[i]);
    } else {
      console.warn(
        `[item_gen] 元素「${itemName}」第 ${i + 1} 个 modifier 违规（已丢弃，不中断链路）:\n  ${errs.join('\n  ')}\n  原始: ${JSON.stringify(modifiers[i])}`,
      );
    }
  });

  // 收集合规 buff
  const validBuffs: NonNullable<typeof buffs> = [];
  if (buffs) {
    result.buffErrors.forEach((errs, i) => {
      if (errs.length === 0) {
        validBuffs.push(buffs[i]);
      } else {
        console.warn(
          `[item_gen] 元素「${itemName}」第 ${i + 1} 个 buff 违规（已丢弃，不中断链路）:\n  ${errs.join('\n  ')}\n  原始: ${JSON.stringify(buffs[i])}`,
        );
      }
    });
  }

  // 聚合 divinity：取合规 modifier 中最大的（§6.2「挂整件装备，不挂单个 modifier」——
  // AI 可能在每个 modifier 上都写 divinity 继承值，聚合取 max 作为装备级登神等级）
  let divinity: DivinityLevel | undefined;
  for (const m of validModifiers) {
    if (typeof m.divinity === 'number') {
      if (divinity === undefined || m.divinity > divinity) divinity = m.divinity;
    }
  }

  return {
    modifiers: validModifiers,
    buffs: validBuffs,
    ...(divinity !== undefined ? { divinity } : {}),
  };
}

/**
 * 从元素 innerContent 提取 <modifiers> 子元素，按行 parse JSON 成 Modifier[]。
 *
 * 格式（item_gen systemPrompt §输出格式）:
 *   <modifiers>
 *     {"category":"检定","source":"剑","checkType":"命中","bonus":5}
 *     {"category":"附加效果","source":"毒刃","buffName":"流血","sourceKey":"毒刃","stacks":1}
 *   </modifiers>
 *
 * 容错:
 * - 支持 <modifiers/> 自闭合（视为空）
 * - 跳过空行 / `<!-- 注释 -->` / `// 注释` 行
 * - 单行 parse 失败 → console.warn 跳过该行，不抛（AI 输出形状不可控，宽容归一）
 * - 裸 JSON 行（无 `category` 字段）→ 跳过并 warn（非 modifier 形状）
 *
 * @param innerContent 元素内部文本（<equip>/<skill>/<item> 的 innerContent）
 * @returns parse 出的 Modifier[]（未校验，校验由 validateAndCollectCombatEffects 做）
 */
function parseModifiersXML(innerContent: string): Modifier[] {
  // 提取 <modifiers>...</modifiers> 块（不支持嵌套，modifier 是叶子元素）
  const blockMatch = innerContent.match(/<modifiers\b[^>]*>([\s\S]*?)<\/modifiers>/i);
  if (!blockMatch) {
    // 自闭合 <modifiers/> 视为空
    if (/<modifiers\b[^>]*\/>/i.test(innerContent)) return [];
    return [];
  }
  const block = blockMatch[1];

  const modifiers: Modifier[] = [];
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    // 跳过注释行
    if (raw.startsWith('<!--') || raw.startsWith('//') || raw.startsWith('/*')) continue;
    // 去掉行尾注释（AI 可能写 `{"..."} // 注释`）
    const commentIdx = raw.indexOf('//');
    const jsonCandidate = commentIdx > 0 ? raw.slice(0, commentIdx).trim() : raw;

    // 找行内的 JSON 对象（{ ... }）
    const braceStart = jsonCandidate.indexOf('{');
    const braceEnd = jsonCandidate.lastIndexOf('}');
    if (braceStart < 0 || braceEnd <= braceStart) {
      console.warn(`[item_gen] <modifiers> 第 ${i + 1} 行非 JSON 对象，跳过: ${raw.slice(0, 100)}`);
      continue;
    }
    const jsonStr = jsonCandidate.slice(braceStart, braceEnd + 1);

    let obj: unknown;
    try {
      obj = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(
        `[item_gen] <modifiers> 第 ${i + 1} 行 JSON parse 失败，跳过: ${(e as Error).message} | 原文: ${raw.slice(0, 120)}`,
      );
      continue;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      console.warn(`[item_gen] <modifiers> 第 ${i + 1} 行非对象，跳过: ${raw.slice(0, 100)}`);
      continue;
    }
    // 必须有 category 字段才算 modifier 形状（判别字段，对齐 effect-types ModifierBase）
    if (!('category' in obj)) {
      console.warn(
        `[item_gen] <modifiers> 第 ${i + 1} 行缺 category 字段，跳过: ${raw.slice(0, 100)}`,
      );
      continue;
    }
    modifiers.push(obj as Modifier);
  }
  return modifiers;
}

/**
 * 🆕 战斗 v3 (S3 2026-08-01): 从元素 innerContent 提取 <automaton> 子元素，按行 parse JSON 成 EffectAutomaton[]。
 *
 * 格式（item_gen systemPrompt §输出格式，S4 将给具体模板）:
 *   <automaton>
 *     {"id":"剑.嗜血","name":"嗜血","source":"剑","owner":"<unitId>","subscribe":"damage.after","trigger":"ctx.damage.final > 0","priority":0,"divinity":0,"intents":[{"kind":"Heal","targetId":"<owner>","amount":"ctx.damage.final * 0.1"}]}
 *   </automaton>
 *
 * 容错（复用 parseModifiersXML 模式）:
 * - 支持 <automaton/> 自闭合（视为空）
 * - 跳过空行 / `<!-- 注释 -->` / `// 注释` 行
 * - 单行 parse 失败 → console.warn 跳过该行，不抛（AI 输出形状不可控，宽容归一）
 * - 裸 JSON 行（无 `subscribe` 字段）→ 跳过并 warn（非 automaton 形状）
 *
 * @param innerContent 元素内部文本（<equip>/<skill>/<item> 的 innerContent）
 * @returns parse 出的 EffectAutomaton[]（编译期校验由 compileEffectProgram 做，此处只做形状粗判）
 */
function parseAutomataXML(innerContent: string): EffectAutomaton[] {
  // 提取 <automaton>...</automaton> 块（不支持嵌套，automaton 是叶子元素）
  const blockMatch = innerContent.match(/<automaton\b[^>]*>([\s\S]*?)<\/automaton>/i);
  if (!blockMatch) {
    if (/<automaton\b[^>]*\/>/i.test(innerContent)) return [];
    return [];
  }
  const block = blockMatch[1];

  const automata: EffectAutomaton[] = [];
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith('<!--') || raw.startsWith('//') || raw.startsWith('/*')) continue;
    const commentIdx = raw.indexOf('//');
    const jsonCandidate = commentIdx > 0 ? raw.slice(0, commentIdx).trim() : raw;

    const braceStart = jsonCandidate.indexOf('{');
    const braceEnd = jsonCandidate.lastIndexOf('}');
    if (braceStart < 0 || braceEnd <= braceStart) {
      console.warn(`[item_gen] <automaton> 第 ${i + 1} 行非 JSON 对象，跳过: ${raw.slice(0, 100)}`);
      continue;
    }
    const jsonStr = jsonCandidate.slice(braceStart, braceEnd + 1);

    let obj: unknown;
    try {
      obj = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(
        `[item_gen] <automaton> 第 ${i + 1} 行 JSON parse 失败，跳过: ${(e as Error).message} | 原文: ${raw.slice(0, 120)}`,
      );
      continue;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      console.warn(`[item_gen] <automaton> 第 ${i + 1} 行非对象，跳过: ${raw.slice(0, 100)}`);
      continue;
    }
    // 必须有 subscribe + intents 才算 automaton 形状（判别字段，对齐 EffectAutomaton）
    if (!('subscribe' in obj) || !('intents' in obj)) {
      console.warn(
        `[item_gen] <automaton> 第 ${i + 1} 行缺 subscribe/intents 字段，跳过: ${raw.slice(0, 100)}`,
      );
      continue;
    }
    automata.push(obj as unknown as EffectAutomaton);
  }
  return automata;
}

/**
 * 解析 char_gen Agent 的输出。
 * 支持两种格式:
 * 1. JSON（旧格式，向后兼容）
 * 2. XML <char_result>（新 Agentic 格式，Phase 8.5）
 */
export function parseCharGenOutput(raw: string): CharGenOutput {
  // 先尝试 XML
  const xml = tagBlock(raw, 'char_result');
  if (xml) {
    const parsed = parseCharGenXML(xml);
    // 真机兜底（2026-07-17）: AI 输出 JSON（非 XML），parseCharGenXML 全字段兜底为 '未命名'
    // → 名字 = 默认值时回退 JSON 宽容归一（同 parseItemGenOutput 逻辑）
    if (parsed.name === '未命名' || parsed.name.startsWith('未命名')) {
      const jsonFallback = parseCharGenJSONLoose(xml);
      if (jsonFallback) return jsonFallback;
    }
    return parsed;
  }

  // 回退到 JSON
  try {
    const json = extractJsonOrRaw(raw);
    const data = JSON.parse(json);
    if (!data?.name) throw new Error('缺少 name');
    return charGenFromJSON(data);
  } catch {
    // 失败上浮（不静默产'未命名'默认角色）— handleCharGen per-marker catch 打日志跳过
    throw new Error(`char_gen 输出无法解析 (JSON+XML 均失败): ${raw.slice(0, 200)}`);
  }
}

/**
 * <char_result> 体内 JSON 宽容归一（真机兜底，同 parseItemGenJSONLoose）。
 * 接受: 对象 {name, race, tier, level, attributes, appearance, personality, ...}
 * appearance/personality 可以是对象（取 summary 字段）或字符串。
 */
function parseCharGenJSONLoose(text: string): CharGenOutput | null {
  const json = extractJsonOrRaw(text);
  if (!json) return null;
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !data.name) return null;
  return charGenFromJSON(data);
}

function charGenFromJSON(data: any): CharGenOutput {
  const attrs: Record<string, number> = {};
  if (data.attributes && typeof data.attributes === 'object') {
    for (const k of ['str', 'dex', 'con', 'int', 'spi']) {
      attrs[k] =
        typeof data.attributes[k] === 'number'
          ? data.attributes[k]
          : parseInt(data.attributes[k]) || 0;
    }
  }
  // 空对象 → 用默认值（但 0 保留）
  if (!Object.keys(attrs).length) {
    for (const k of ['str', 'dex', 'con', 'int', 'spi']) attrs[k] = 10;
  }

  const appearance = data.appearance;
  const personality = data.personality;

  return {
    name: data.name,
    race: data.race ?? '人类',
    gender: data.gender,
    faction: data.faction,
    tier: typeof data.tier === 'number' ? data.tier : 1,
    level: typeof data.level === 'number' ? data.level : 1,
    attributes: {
      str: attrs.str,
      dex: attrs.dex,
      con: attrs.con,
      int: attrs.int,
      spi: attrs.spi,
    },
    identity: Array.isArray(data.identity)
      ? data.identity
      : typeof data.identity === 'string'
        ? [data.identity]
        : [],
    occupation: Array.isArray(data.occupation)
      ? data.occupation
      : typeof data.occupation === 'string'
        ? [data.occupation]
        : [],
    // appearance/personality: 对象取 summary 纯文本，字符串直用
    background: data.background ?? data.lore?.origin ?? data.description ?? '',
    appearance:
      typeof appearance === 'object' && appearance
        ? (appearance.summary ?? appearance.description ?? JSON.stringify(appearance))
        : typeof appearance === 'string'
          ? appearance
          : '',
    clothing: data.clothing ?? data.outfit ?? '',
    personality:
      typeof personality === 'object' && personality
        ? (personality.summary ?? personality.description ?? JSON.stringify(personality))
        : typeof personality === 'string'
          ? personality
          : '',
    likes: data.likes ?? '',
    thoughts: data.thoughts ?? '',
    ascension: {
      enabled: false,
      path: '',
      description: '',
      elements: [],
      authorities: [],
      laws: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    skills: data.skills ?? [],
    equipment: data.equipment ?? [],
    inventory: data.inventory ?? [],
  };
}

/**
 * 从 <personality> 提取落库文本，兼容两种输出形态（2026-08-08）。
 *
 * 提示词与工具返回的性格编码（如 `wOaGz(A)`）是角色的**既定属性**，落库必须保留；
 * 旧实现 `tagInner ?? tagAttr` 只取内文，AI 把 code 写进属性（旧格式）时 code 被剥掉，
 * 落库只剩描述文本（真机 2026-08-08：`code="wHAGY(A)"` 的属性被丢弃）。
 *
 * 两种形态：
 *   · 新格式（推荐）`<personality>wOaGz(A)+冷静果断的性格描述</personality>`
 *       → code 与描述都在内文，`tagInner` 直接拿全，原样返回。
 *   · 旧格式 `<personality code="wOaGz(A)">冷静果断的性格描述</personality>`
 *       → code 在属性里，拼接成 `code+描述`，保证编码不丢。
 *   · 纯描述（无 code）→ 原样返回。
 *
 * 内文可能嵌套 AI 自作的子标签（如 <description>），经 stripInnerTags 剥成纯文本。
 */
export function extractPersonalityText(xml: string): string {
  const inner = stripInnerTags(tagInner(xml, 'personality') ?? '');
  const code = tagAttr(xml, 'personality', 'code');
  if (!code) return inner;
  if (!inner) return code;
  // 旧格式：属性 code + 内文描述 → 拼 `code+描述`；内文已含 code 前缀则不重复拼
  const codePrefix = `${code}+`;
  return inner.startsWith(codePrefix) ? inner : `${codePrefix}${inner}`;
}

/** 从 XML <char_result> 中解析角色数据 */
function parseCharGenXML(xml: string): CharGenOutput {
  // ascension 子结构
  const ascXML = tagInner(xml, 'ascension');
  const ascElements: CharGenOutput['ascension']['elements'] = [];
  const ascAuthorities: CharGenOutput['ascension']['authorities'] = [];
  const ascLaws: CharGenOutput['ascension']['laws'] = [];

  if (ascXML) {
    // 解析 <element> 子标签
    const elMatches = ascXML.matchAll(/<element\b([^>]*?)>([\s\S]*?)<\/element>/g);
    for (const m of elMatches) {
      const attrs = parseAttrsStr(m[1]);
      ascElements.push({
        name: attrs['name'] ?? '',
        description: attrs['description'] ?? '',
        effects:
          m[2]
            ?.trim()
            .split('\n')
            .filter((s) => s.trim())
            .map((s) => s.trim()) ?? [],
      });
    }
    // 解析 <authority> 子标签
    const auMatches = ascXML.matchAll(/<authority\b([^>]*?)>([\s\S]*?)<\/authority>/g);
    for (const m of auMatches) {
      const attrs = parseAttrsStr(m[1]);
      ascAuthorities.push({
        name: attrs['name'] ?? '',
        description: attrs['description'] ?? '',
        effects:
          m[2]
            ?.trim()
            .split('\n')
            .filter((s) => s.trim())
            .map((s) => s.trim()) ?? [],
        costDescription: attrs['cost'] ?? '',
      });
    }
    // 解析 <law> 子标签
    // 🔴 **正文体被丢掉** —— 正则第二个捕获组 `m[2]` 抓的是 `<law>…</law>` 之间的正文，
    //    但下面只读 `m[1]` 的属性；模型若把法则说明写在标签体里（而不是 description 属性里），
    //    那段文字直接蒸发。2026-08-05 收紧 lint 时由 `no-unused-vars` 逮到
    //    （原来是 `const innerText = m[2]?.trim()`，赋了值没人读，此前只是 warning）。
    //    没有就地接上，是因为要先定 `<law>` 的写法约定（属性优先还是标签体优先、两者都有时谁赢），
    //    那是模板/协议层的改动而不是 lint 清理 —— 留给单独一次提交。
    const lawMatches = ascXML.matchAll(/<law\b([^>]*?)>([\s\S]*?)<\/law>/g);
    for (const m of lawMatches) {
      const attrs = parseAttrsStr(m[1]);
      ascLaws.push({
        name: attrs['name'] ?? '',
        description: attrs['description'] ?? '',
        passiveEffects:
          attrs['passive']
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? [],
        activeEffects:
          attrs['active']
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? [],
        costDescription: attrs['cost'] ?? '',
      });
    }
  }

  // 技能/装备/物品 子结构 (char_gen 自行生成)
  const skillsXML = tagInner(xml, 'skills');
  const equipmentXML = tagInner(xml, 'equipment');
  const inventoryXML = tagInner(xml, 'inventory');

  const skills = skillsXML ? parseSkillsXML(skillsXML) : [];
  const equipment = equipmentXML ? parseEquipmentXML(equipmentXML) : [];
  const inventory = inventoryXML ? parseInventoryXML(inventoryXML) : [];

  return {
    name: tagInner(xml, 'name') ?? '未命名',
    race: tagInner(xml, 'race') ?? '人类',
    gender: tagInner(xml, 'gender') ?? '其他',
    faction: tagInner(xml, 'faction') ?? undefined,
    tier: parseInt(tagInner(xml, 'tier') ?? '1') || 1,
    level: parseInt(tagInner(xml, 'level') ?? '1') || 1,
    attributes: {
      // 真机修(2026-07-17): `|| 10` 会把 0 打回 10 — 意识体/灵体的 0 属性是合法值，改 NaN 检查
      str: tagAttrInt(xml, 'attributes', 'str', 10),
      dex: tagAttrInt(xml, 'attributes', 'dex', 10),
      con: tagAttrInt(xml, 'attributes', 'con', 10),
      int: tagAttrInt(xml, 'attributes', 'int', 10),
      spi: tagAttrInt(xml, 'attributes', 'spi', 10),
    },
    identity:
      tagInner(xml, 'identity')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    occupation:
      tagInner(xml, 'occupation')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    // 真机修(2026-07-17): AI 可能在叙事字段内嵌套子标签（<appearance>→<physical>/<voice>等），
    // extractTag 原样返回 → 落库带 XML 污染前端渲染。stripInnerTags 剥子标签留纯文本。
    background: stripInnerTags(tagInner(xml, 'background') ?? ''),
    appearance: stripInnerTags(tagInner(xml, 'appearance') ?? ''),
    clothing: stripInnerTags(tagInner(xml, 'clothing') ?? ''),
    personality: extractPersonalityText(xml),
    likes: stripInnerTags(tagInner(xml, 'likes') ?? ''),
    thoughts: stripInnerTags(tagInner(xml, 'thoughts') ?? ''),
    ascension: {
      enabled: (tagAttr(xml, 'ascension', 'enabled') ?? 'false') === 'true',
      path: tagAttr(xml, 'ascension', 'path') ?? '',
      description: tagAttr(xml, 'ascension', 'description') ?? '',
      elements: ascElements,
      authorities: ascAuthorities,
      laws: ascLaws,
      deityPosition: ascXML ? (tagInner(ascXML, 'deity_position') ?? '') : '',
      divineKingdom: (() => {
        if (!ascXML) return { name: '', description: '' };
        const kdXML = tagInner(ascXML, 'kingdom');
        return {
          name: kdXML ? (tagAttr(kdXML, 'kingdom', 'name') ?? tagInner(kdXML, 'name') ?? '') : '',
          description: kdXML
            ? (tagAttr(kdXML, 'kingdom', 'description') ?? tagInner(kdXML, 'description') ?? '')
            : '',
        };
      })(),
    },
    skills,
    equipment,
    inventory,
  };
}

/**
 * 解析 item_gen Agent 的输出。
 * 支持两种格式:
 * 1. JSON（旧格式，向后兼容）
 * 2. XML <item_result>（新 Agentic 格式，Phase 8.5）
 */
export function parseItemGenOutput(raw: string): ItemGenOutput {
  // 先尝试 XML
  const xml = tagBlock(raw, 'item_result');
  if (xml) {
    const parsed = parseItemGenXML(xml);
    // 真机兜底（2026-07-17）: AI 无视 XML 子元素教学、在 <item_result> 里塞 markdown JSON
    // → 子元素全空时回退 JSON 宽容归一（AI 输出形状不可控，翻译层宽容；杜绝静默零落库）
    if (!parsed.skills.length && !parsed.equipment.length && !parsed.inventory.length) {
      const jsonFallback = parseItemGenJSONLoose(xml);
      if (jsonFallback) return jsonFallback;
    }
    return parsed;
  }

  // 回退到 JSON
  try {
    const json = extractJsonOrRaw(raw);
    const data = JSON.parse(json);

    return {
      skills: data.skills ?? [],
      equipment: data.equipment ?? [],
      inventory: data.inventory ?? [],
    };
  } catch {
    // 不阻断流程
    return { skills: [], equipment: [], inventory: [] };
  }
}

/**
 * <item_result> 体内 JSON 宽容归一（真机兜底）。
 * 接受: 单对象 / 对象数组 / 已分组 {skills, equipment, inventory}。
 * 分类规则: 有 slot 或 type 判装备 → equipment；type=active/passive/技能 或有 cost/cooldown → skills；其余 → inventory。
 * 字段映射: rarity↔quality 互备（ItemGenOutput.equipment 用 quality，inventory 用 rarity）。
 */
function parseItemGenJSONLoose(text: string): ItemGenOutput | null {
  const json = extractJsonOrRaw(text);
  if (!json) return null;
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  // 已分组形状直接映射
  if (
    Array.isArray(data.skills) ||
    Array.isArray(data.equipment) ||
    Array.isArray(data.inventory)
  ) {
    return {
      skills: data.skills ?? [],
      equipment: data.equipment ?? [],
      inventory: data.inventory ?? [],
    };
  }

  const items: any[] = Array.isArray(data) ? data : [data];
  const out: ItemGenOutput = { skills: [], equipment: [], inventory: [] };
  const EQUIP_TYPES = new Set(['equipment', '装备', 'weapon', 'armor', '武器', '防具', '饰品']);
  const SKILL_TYPES = new Set(['skill', '技能', 'active', 'passive']);

  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.name) continue;
    const typeStr = String(it.type ?? '').toLowerCase();
    const isSkill =
      SKILL_TYPES.has(typeStr) ||
      (!it.slot && (it.cost !== undefined || it.cooldown !== undefined));
    const isEquip = !isSkill && (Boolean(it.slot) || EQUIP_TYPES.has(typeStr));

    // 战斗 v2 (M4 5.5b): JSON 兜底路径也校验 modifiers/buffs（AI 偶尔直出 JSON，同样要守铁律）
    const itModifiers: unknown[] = Array.isArray(it.modifiers) ? it.modifiers : [];
    const itBuffs: unknown[] = Array.isArray(it.buffs) ? it.buffs : [];
    // 🆕 战斗 v3 (S3 2026-08-01): JSON 兜底也收 automata（形状粗判 subscribe+intents，编译期校验由 compileEffectProgram 做）
    const itAutomata: EffectAutomaton[] = Array.isArray(it.automata)
      ? it.automata.filter(
          (a: any) => a && typeof a === 'object' && 'subscribe' in a && 'intents' in a,
        )
      : [];
    const combat: {
      modifiers: Modifier[];
      buffs: NonNullable<ItemGenOutput['equipment'][number]['buffs']>;
      divinity?: DivinityLevel;
    } =
      itModifiers.length > 0 || itBuffs.length > 0
        ? validateAndCollectCombatEffects(
            it.name,
            itModifiers as Modifier[],
            itBuffs as ItemGenOutput['equipment'][number]['buffs'],
          )
        : { modifiers: [], buffs: [] };
    // 聚合 divinity：优先取元素顶层 divinity，否则取 modifier 聚合
    const elemDivinity: DivinityLevel | undefined =
      typeof it.divinity === 'number' ? it.divinity : combat.divinity;

    if (isSkill) {
      out.skills.push({
        name: it.name,
        description: it.description ?? '',
        type: typeStr === 'passive' ? 'passive' : 'active',
        cost: it.cost,
        cooldown: it.cooldown,
        effects: it.effects,
        scripts: it.scripts,
        ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
        ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
        ...(elemDivinity !== undefined ? { divinity: elemDivinity } : {}),
        // 🆕 战斗 v3 (S3 2026-08-01): automata 透传（JSON 兜底路径）
        ...(itAutomata.length > 0 ? { automata: itAutomata } : {}),
        // 🆕 skillPower 链路修复 (2026-08-04): JSON 直出路径同样透传
        ...(typeof it.skillPower === 'number' ? { skillPower: it.skillPower } : {}),
        ...(it.relevantAttribute ? { relevantAttribute: it.relevantAttribute } : {}),
        ...(it.damageType ? { damageType: it.damageType } : {}),
        // 🆕 重铸 (2026-08-24): JSON 兜底路径同样收 replace（声明替换目标）
        ...(typeof it.replace === 'string' && it.replace ? { replace: it.replace } : {}),
      });
    } else if (isEquip) {
      out.equipment.push({
        slot: it.slot ?? '',
        name: it.name,
        description: it.description ?? '',
        stats: it.stats ?? {},
        durability: it.durability,
        quality: it.quality ?? it.rarity,
        // effects/scripts 透传（M3 无损映射，buildItemGenPatches/assembleCharacterState 消费）
        ...(it.effects ? { effects: it.effects } : {}),
        ...(it.scripts ? { scripts: it.scripts } : {}),
        ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
        ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
        ...(elemDivinity !== undefined ? { divinity: elemDivinity } : {}),
        // 🆕 战斗 v3 (S3 2026-08-01): automata 透传（JSON 兜底路径）
        ...(itAutomata.length > 0 ? { automata: itAutomata } : {}),
        // 🆕 重铸 (2026-08-24): JSON 兜底路径同样收 replace（声明替换目标）
        ...(typeof it.replace === 'string' && it.replace ? { replace: it.replace } : {}),
      } as ItemGenOutput['equipment'][number]);
    } else {
      out.inventory.push({
        name: it.name,
        description: it.description ?? '',
        quantity: typeof it.quantity === 'number' ? it.quantity : 1,
        type: it.type ?? '特殊',
        rarity: it.rarity ?? it.quality,
        ...(it.effects ? { effects: it.effects } : {}),
        ...(it.scripts ? { scripts: it.scripts } : {}),
        ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
        ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
        ...(elemDivinity !== undefined ? { divinity: elemDivinity } : {}),
        // 🆕 战斗 v3 (S3 2026-08-01): automata 透传（JSON 兜底路径）
        ...(itAutomata.length > 0 ? { automata: itAutomata } : {}),
        // 🆕 重铸 (2026-08-24): JSON 兜底路径同样收 replace（声明替换目标）
        ...(typeof it.replace === 'string' && it.replace ? { replace: it.replace } : {}),
      } as ItemGenOutput['inventory'][number]);
    }
  }

  if (!out.skills.length && !out.equipment.length && !out.inventory.length) return null;
  return out;
}

/** 从 XML <item_result> 中解析物品数据 */
function parseItemGenXML(xml: string): ItemGenOutput {
  const skillsXML = tagInner(xml, 'skills');
  const equipmentXML = tagInner(xml, 'equipment');
  const inventoryXML = tagInner(xml, 'inventory');
  const ascensionXML = tagInner(xml, 'ascension');

  const skills = skillsXML ? parseSkillsXML(skillsXML) : [];
  const equipment = equipmentXML ? parseEquipmentXML(equipmentXML) : [];
  const inventory = inventoryXML ? parseInventoryXML(inventoryXML) : [];

  // ascension 可能不存在（非登神角色）
  let elements: ItemGenOutput['elements'] | undefined;
  let authorities: ItemGenOutput['authorities'] | undefined;
  if (ascensionXML) {
    const elementsXML = tagInner(ascensionXML, 'elements');
    const authoritiesXML = tagInner(ascensionXML, 'authorities');
    if (elementsXML) elements = parseElementsXML(elementsXML);
    if (authoritiesXML) authorities = parseAuthoritiesXML(authoritiesXML);
  }

  return { skills, equipment, inventory, elements, authorities };
}

function parseSkillsXML(xml: string): ItemGenOutput['skills'] {
  // 🆕 skillPower 链路修复 (2026-08-04): <skill power/attr/dtype> 属性白名单（非法值丢弃，不污染 Skill）
  const ATTR_KEYS = new Set(['str', 'dex', 'con', 'int', 'spi']);
  const DMG_TYPES = new Set(['物理', '能量', '精神', '真实']);
  const matches = xml.matchAll(/<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/g);
  const results: ItemGenOutput['skills'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';

    // 提取 <effect name="...">content</effect> 子元素
    // Q-05：宽松正则（name 不必是第一个属性）。严格版会把 <effect type="buff" name="x"> 静默丢掉
    const effects = parseNamedChildren(innerContent, 'effect');

    // 提取 <script name="...">code</script> 子元素
    const scripts = parseNamedChildren(innerContent, 'script');

    // 战斗 v2 (M4 5.5b): 提取 <modifiers> 子元素 → Modifier[]，再校验接入（违规 warn 不中断）
    const rawModifiers = parseModifiersXML(innerContent);
    const combat = validateAndCollectCombatEffects(
      attrs['name'] ?? '未命名技能',
      rawModifiers,
      undefined,
    );
    // 🆕 战斗 v3 (S3 2026-08-01): 提取 <automaton> 子元素 → EffectAutomaton[]（编译期校验由 compileEffectProgram 做）
    const rawAutomata = parseAutomataXML(innerContent);

    // 描述 = 纯文本部分（去除所有嵌套子标签，包括 AI 自造的 <description>/<notes>/<ability> 等）
    // 优先取 <description> 子标签的文本内容，若无则剥所有标签留纯文本
    const descSubTag = innerContent.match(/<description\b[^>]*>([\s\S]*?)<\/description>/);
    // 真机 fix(2026-07-18): 预剥离 <effect>/<script> 块（含内容），防止子标签文本泄漏进 description
    // 战斗 v2: 同步剥离 <modifiers> 块
    const descText = stripKnownChildBlocks(innerContent);
    const description = descSubTag
      ? descSubTag[1].trim()
      : descText.replace(/<\/?[a-z_][\w-]*[^>]*>/gi, '').trim();
    // 中文 type 归一（真机实测 AI 产 '主动'/'被动' 直接落库 → UI 不识别）
    const skillType = (attrs['type'] ?? '').trim();
    const normalizedType: 'active' | 'passive' =
      skillType === '被动' || skillType === 'passive' ? 'passive' : 'active';

    // 🆕 skillPower 链路修复 (2026-08-04): <skill power="..." attr="..." dtype="..."> 属性 → skillPower/relevantAttribute/damageType
    const skillPowerAttr = attrs['power'] ? parseInt(attrs['power']) || 0 : undefined;
    const relevantAttrRaw = attrs['attr'];
    const relevantAttribute =
      relevantAttrRaw && ATTR_KEYS.has(relevantAttrRaw)
        ? (relevantAttrRaw as 'str' | 'dex' | 'con' | 'int' | 'spi')
        : undefined;
    const dtypeRaw = attrs['dtype'];
    const damageType = dtypeRaw && DMG_TYPES.has(dtypeRaw) ? (dtypeRaw as DamageType) : undefined;

    results.push({
      name: attrs['name'] ?? '未命名技能',
      description: description || (descSubTag ? '' : descText.replace(/<[^>]+>/g, '').trim()),
      type: normalizedType,
      cost: attrs['cost_type']
        ? {
            type: attrs['cost_type'] as 'HP' | 'MP' | 'SP',
            amount: parseInt(attrs['cost_amount'] ?? '0'),
          }
        : undefined,
      cooldown: attrs['cooldown'] ? parseInt(attrs['cooldown']) : undefined,
      effects: Object.keys(effects).length > 0 ? effects : undefined,
      scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
      ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
      ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
      ...(combat.divinity !== undefined ? { divinity: combat.divinity } : {}),
      // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传（编译期校验由 compileEffectProgram 做）
      ...(rawAutomata.length > 0 ? { automata: rawAutomata } : {}),
      // 🆕 skillPower 链路修复 (2026-08-04): 主体威力三字段透传
      ...(skillPowerAttr !== undefined ? { skillPower: skillPowerAttr } : {}),
      ...(relevantAttribute ? { relevantAttribute } : {}),
      ...(damageType ? { damageType } : {}),
      // 🆕 重铸 (2026-08-24): replace 属性 → 声明替换目标（AI 在重铸模式下点名被替换的已知条目）
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

function parseEquipmentXML(xml: string): ItemGenOutput['equipment'] {
  const matches = xml.matchAll(/<equip\s+([^>]*?)>([\s\S]*?)<\/equip>/g);
  const results: ItemGenOutput['equipment'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const statsStr = attrs['stats'] ?? '';
    const stats: Record<string, number> = {};
    for (const pair of statsStr.split(',')) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (k && v) stats[k] = parseFloat(v) || 0;
    }
    // 真机 fix(2026-07-18): 提取 <effect>/<script> 子标签，防止文本泄漏进 description
    const effects: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    const em = innerContent.matchAll(/<effect\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g);
    for (const em2 of em) {
      effects[em2[1]] = em2[2]?.trim() ?? '';
    }
    const sm = innerContent.matchAll(/<script\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g);
    for (const sm2 of sm) {
      scripts[sm2[1]] = sm2[2]?.trim() ?? '';
    }
    // 战斗 v2 (M4 5.5b): 提取 <modifiers> 子元素 → Modifier[]，再校验接入（违规 warn 不中断）
    const rawModifiers = parseModifiersXML(innerContent);
    const combat = validateAndCollectCombatEffects(
      attrs['name'] ?? '未命名装备',
      rawModifiers,
      undefined,
    );
    // 🆕 战斗 v3 (S3 2026-08-01): 提取 <automaton> 子元素 → EffectAutomaton[]
    const rawAutomata = parseAutomataXML(innerContent);
    // 预剥离 effect/script/modifiers 块，再 stripInnerTags 取纯文本描述
    const descText = stripKnownChildBlocks(innerContent);
    const qualityRaw = attrs['quality'];
    results.push({
      slot: attrs['slot'] ?? '饰品',
      name: attrs['name'] ?? '未命名装备',
      description: stripInnerTags(descText || innerContent),
      stats,
      durability: attrs['durability'] ? parseInt(attrs['durability']) : undefined,
      quality: qualityRaw && qualityRaw !== '?' ? qualityRaw : undefined,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
      ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
      ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
      ...(combat.divinity !== undefined ? { divinity: combat.divinity } : {}),
      // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传
      ...(rawAutomata.length > 0 ? { automata: rawAutomata } : {}),
      // 🆕 重铸 (2026-08-24): replace 属性 → 声明替换目标（AI 在重铸模式下点名被替换的已知条目）
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

function parseInventoryXML(xml: string): ItemGenOutput['inventory'] {
  const matches = xml.matchAll(/<item\s+([^>]*?)>([\s\S]*?)<\/item>/g);
  const results: ItemGenOutput['inventory'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    // 真机 fix(2026-07-18): 提取 <effect>/<script> 子标签，防止文本泄漏进 description
    const effects: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    const em = innerContent.matchAll(/<effect\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g);
    for (const em2 of em) {
      effects[em2[1]] = em2[2]?.trim() ?? '';
    }
    const sm = innerContent.matchAll(/<script\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g);
    for (const sm2 of sm) {
      scripts[sm2[1]] = sm2[2]?.trim() ?? '';
    }
    // 战斗 v2 (M4 5.5b): 提取 <modifiers> 子元素 → Modifier[]，再校验接入（违规 warn 不中断）
    const rawModifiers = parseModifiersXML(innerContent);
    const combat = validateAndCollectCombatEffects(
      attrs['name'] ?? '未命名物品',
      rawModifiers,
      undefined,
    );
    // 🆕 战斗 v3 (S3 2026-08-01): 提取 <automaton> 子元素 → EffectAutomaton[]
    const rawAutomata = parseAutomataXML(innerContent);
    // 预剥离 effect/script/modifiers 块，再 stripInnerTags 取纯文本描述
    const descText = stripKnownChildBlocks(innerContent);
    const rarityRaw = attrs['rarity'];
    results.push({
      name: attrs['name'] ?? '未命名物品',
      description: stripInnerTags(descText || innerContent),
      quantity: parseInt(attrs['quantity'] ?? '1') || 1,
      type: attrs['type'] ?? '消耗品',
      rarity: rarityRaw && rarityRaw !== '?' ? rarityRaw : undefined,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
      ...(combat.modifiers.length > 0 ? { modifiers: combat.modifiers } : {}),
      ...(combat.buffs.length > 0 ? { buffs: combat.buffs } : {}),
      ...(combat.divinity !== undefined ? { divinity: combat.divinity } : {}),
      // 🆕 战斗 v3 (S3 2026-08-01): <automaton> 透传
      ...(rawAutomata.length > 0 ? { automata: rawAutomata } : {}),
      // 🆕 重铸 (2026-08-24): replace 属性 → 声明替换目标（AI 在重铸模式下点名被替换的已知条目）
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

/**
 * Phase 9: 解析 <elements> 块内的 <element> 子标签。
 * 格式同 parseSkillsXML: 属性来自开标签, effect/script 子元素解析, 描述为纯文本部分。
 */
function parseElementsXML(xml: string): NonNullable<ItemGenOutput['elements']> {
  const matches = xml.matchAll(/<element\s+([^>]*?)>([\s\S]*?)<\/element>/g);
  const results: NonNullable<ItemGenOutput['elements']> = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';

    // 提取 <effect name="...">content</effect> 子元素 → effectDescriptions
    // Q-05：宽松正则（name 不必是第一个属性）—— 严格版会把 <effect type="x" name="y"> 静默丢掉
    const effectDescriptions = parseNamedChildren(innerContent, 'effect');

    // 提取 <script name="...">code</script> 子元素 → scripts
    const scripts = parseNamedChildren(innerContent, 'script');

    // 描述 = innerContent 中去除 effect/script 标签后的纯文本
    const description = innerContent
      .replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/g, '')
      .trim();

    results.push({
      name: attrs['name'] ?? '未命名要素',
      description: description || innerContent,
      effects: [],
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    });
  }
  return results;
}

/**
 * Phase 9: 解析 <authorities> 块内的 <authority> 子标签。
 * 与 parseElementsXML 相同模式，多了 cost_description 属性。
 */
function parseAuthoritiesXML(xml: string): NonNullable<ItemGenOutput['authorities']> {
  const matches = xml.matchAll(/<authority\s+([^>]*?)>([\s\S]*?)<\/authority>/g);
  const results: NonNullable<ItemGenOutput['authorities']> = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';

    // 提取 <effect name="...">content</effect> 子元素 → effectDescriptions
    // Q-05：宽松正则（name 不必是第一个属性）—— 严格版会把 <effect type="x" name="y"> 静默丢掉
    const effectDescriptions = parseNamedChildren(innerContent, 'effect');

    // 提取 <script name="...">code</script> 子元素 → scripts
    const scripts = parseNamedChildren(innerContent, 'script');

    // 描述 = innerContent 中去除 effect/script 标签后的纯文本
    const description = innerContent
      .replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/g, '')
      .trim();

    results.push({
      name: attrs['name'] ?? '未命名权能',
      description: description || innerContent,
      effects: [],
      costDescription: attrs['cost_description'] ?? '',
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    });
  }
  return results;
}

/**
 * 解析 vars_update 输出的 <status_effects> XML 块。
 * 返回 StatusEffect 数组，供 StateManager.applyAddStatusEffect 使用。
 */
export function parseStatusEffectsXML(xmlBody: string): Array<{
  owner: string;
  name: string;
  category: '增益' | '减益' | '特殊';
  description: string;
  stacks: number;
  maxStacks: number;
  remainingTime: number;
  timeUnit: '回合' | '分钟' | '小时';
  effects?: Record<string, string>;
  effectDescriptions?: Record<string, string>;
  scripts?: Record<string, string>;
}> {
  const results: any[] = [];
  const effectRegex =
    /<effect\s+([^>]*)>([\s\S]*?)((?:<effect\b[^>]*>[\s\S]*?<\/effect>\s*)*)((?:<script\b[^>]*>[\s\S]*?<\/script>\s*)*)<\/effect>/gi;
  let match: RegExpExecArray | null;

  while ((match = effectRegex.exec(xmlBody)) !== null) {
    const attrsStr = match[1].trim();
    const description = match[2].trim();
    const innerEffectsBlock = match[3];
    const scriptsBlock = match[4];

    const attrs = parseAttrsStr(attrsStr);
    const owner = attrs.owner || '';
    const name = attrs.name || '';
    const category = (attrs.category as '增益' | '减益' | '特殊') || '减益';
    const stacks = parseInt(attrs.stacks || '1', 10);
    const maxStacks = parseInt(attrs.maxStacks || attrs.stacks || '1', 10);
    const remainingTime = parseInt(attrs.remainingTime || '60', 10);
    const timeUnit = (attrs.timeUnit as '回合' | '分钟' | '小时') || '回合';

    const effects: Record<string, string> = {};
    const effectDescriptions: Record<string, string> = {};
    if (innerEffectsBlock) {
      const innerRegex = /<effect\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/gi;
      let innerMatch: RegExpExecArray | null;

      while ((innerMatch = innerRegex.exec(innerEffectsBlock)) !== null) {
        const efName = innerMatch[1].trim();
        const efDesc = innerMatch[2].trim();
        effects[efName] = efDesc;
        effectDescriptions[efName] = efDesc;
      }
    }

    const scripts: Record<string, string> = {};
    if (scriptsBlock) {
      const scriptRegex = /<script\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/script>/gi;
      let scriptMatch: RegExpExecArray | null;

      while ((scriptMatch = scriptRegex.exec(scriptsBlock)) !== null) {
        const scriptName = scriptMatch[1].trim();
        const scriptCode = scriptMatch[2].trim();
        scripts[scriptName] = scriptCode;
      }
    }

    results.push({
      owner,
      name,
      category,
      description,
      stacks,
      maxStacks,
      remainingTime,
      timeUnit,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    });
  }

  return results;
}

// XML / JSON 解析工具统一在 agent-xml.ts 与 model-json.ts（Q-05）——
// 本文件曾自带 8 个 helper，与 craft-gen-chain 的同名函数语义相反（见 agent-xml.ts 文件头）。

/**
 * 从 AgentContext 中解析玩家角色的 location。
 * 用于新登场 NPC 默认继承玩家当前位置（避免生成在「空串」位置）。
 */
function resolvePlayerLocation(request: CharGenRequest): string {
  const player = request.context.characters?.find((c) => c.type === 'player');
  return player?.location ?? '';
}

// ========== $chargen API ==========

export const $chargen = {
  /** 检测正文中的新角色标记 */
  detect: detectNewCharacters,
  /** 运行完整角色生成链 */
  generate: runCharGenChain,
  /** 组装 CharacterState (纯函数) */
  assemble: assembleCharacterState,
};
