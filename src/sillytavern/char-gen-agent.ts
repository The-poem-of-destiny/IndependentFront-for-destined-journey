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
} from './types';
import { createDefaultCharacterState } from './types';
import { scanCharDetects } from './marker-protocol';
import { buildAgentMessages } from './agent-templates';
import { getTierConfig, calcHP, calcMP, calcSP } from './tier-constants';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeSlot } from './field-enums';
import type { ToolExecutionContext } from './types';

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
 */
export interface CharGenClient {
  chat(messages: Array<{ role: string; content: string }>): Promise<{
    output: string | null;
    rawResponse: string;
    tokensUsed: number;
    cacheHit: boolean;
    duration: number;
    error?: string;
  }>;

  /** 🆕 Phase 8.5 Agentic: 多轮 function calling 路径 */
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

  const existingNames = new Set(
    existingChars.map((c) => c.name.toLowerCase()),
  );

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
    attrs.characterName ? `指定名称: ${attrs.characterName}（正文已出现的名字必须沿用；若这是描述性称呼而正文里有真名，用真名）` : '',
    attrs.race && attrs.race !== '未知' ? `种族: ${attrs.race}` : '',
    attrs.tier && attrs.tier !== '未知' ? `层级: ${attrs.tier}` : '',
    attrs.characterType ? `类型: ${attrs.characterType}` : '',
    attrs.faction && attrs.faction !== '未知' ? `势力: ${attrs.faction}` : '',
  ].filter(Boolean).join('\n');
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
  const messages = buildAgentMessages('char_gen', request.context, request.configs, request.worldBooks, request.presets, charLocalParams);

  if (!messages) {
    throw new Error('char_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('char_gen', request.endpoint, request.saveId);

  // 🆕 Phase 8.5: 优先走 Agentic 路径（function calling 多轮循环）
  if (client.chatWithTools) {
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

  // 回退: 旧路径（无工具，直接 chat）
  const result = await client.chat(messages);

  if (result.error) {
    throw new Error(`char_gen Agent 调用失败: ${result.error}`);
  }

  const rawOutput = result.output ?? result.rawResponse;
  const fallbackParsed = parseCharGenOutput(rawOutput);
  fallbackParsed.rawXml = rawOutput;
  return fallbackParsed;
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

  const messages = buildAgentMessages('item_gen', contextWithCharData, request.configs, request.worldBooks, request.presets, charItemLocalParams);

  if (!messages) {
    throw new Error('item_gen 模板未找到 — 请检查 AGENT_TEMPLATES 注册');
  }

  const client = deps.clientFactory('item_gen', request.endpoint, request.saveId);

  // 🆕 Phase 8.5: 优先走 Agentic 路径（function calling 多轮循环）
  if (client.chatWithTools) {
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

  // 回退: 旧路径（无工具，直接 chat）
  const result = await client.chat(messages);

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
  const hpMultiplier = tierConfig?.hpMultiplier ?? 1;
  const mpMultiplier = tierConfig?.mpMultiplier ?? 1;
  const spMultiplier = tierConfig?.spMultiplier ?? 1;

  // 合并技能: char_gen 自产优先，item_gen 补充（去重+合并）
  const charSkills = charData.skills ?? [];
  const itemGenSkills = itemData.skills ?? [];
  const charSkillNames = new Set(charSkills.map(s => s.name));
  // item_gen 的 skill 不覆盖 char_gen 同名
  const mergedSkills = [...itemGenSkills.filter(s => !charSkillNames.has(s.name)), ...charSkills];

  const skills = mergedSkills.map((s) => ({
    name: s.name,
    description: s.description,
    type: s.type,
    cost: s.cost ? { type: s.cost.type, amount: s.cost.amount } : undefined,
    cooldown: s.cooldown,
    level: 1,
    effects: s.effects,
    scripts: s.scripts,
  }));

  // 合并装备: char_gen 自产优先
  // M3: 装备产物直接写成带 equippedSlot 的 InventoryItem（规范 §3），scripts 无损传递（#45）
  const charEquip = charData.equipment ?? [];
  const itemGenEquip = itemData.equipment ?? [];
  const charEquipNames = new Set(charEquip.map(e => e.name));
  const mergedEquip = [...itemGenEquip.filter(e => !charEquipNames.has(e.name)), ...charEquip];

  const equippedItems: InventoryItem[] = mergedEquip.map((e) => ({
    name: e.name,
    description: e.description,
    quantity: 1,
    type: '装备',
    equippedSlot: normalizeSlot(e.slot),   // 无法识别 → null（躺背包），铁律5
    stats: e.stats,
    durability: e.durability,
    maxDurability: e.durability,
    effects: (e as any).effects,
    scripts: (e as any).scripts,           // M3: scripts 无损传递（#45）
  }));

  // 合并背包: char_gen 自产优先
  // M3: inventory 物品 effects/scripts 无损传递，废除 id 生成（#45）
  const charInv = charData.inventory ?? [];
  const itemGenInv = itemData.inventory ?? [];
  const charInvNames = new Set(charInv.map(i => i.name));
  const mergedInv = [...itemGenInv.filter(i => !charInvNames.has(i.name)), ...charInv];

  const inventory: InventoryItem[] = [
    ...mergedInv.map((inv) => ({
      name: inv.name,
      description: inv.description,
      type: inv.type,
      quantity: inv.quantity,
      rarity: (inv.rarity as QualityLevel) || undefined,
      effects: (inv as any).effects,        // M3: effects 无损传递（#45）
      scripts: (inv as any).scripts,        // M3: scripts 无损传递（#45）
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
    hp: calcHP(charData.tier, charData.attributes.con),
    maxHp: calcHP(charData.tier, charData.attributes.con),
    mp: calcMP(charData.tier, charData.attributes.int),
    maxMp: calcMP(charData.tier, charData.attributes.int),
    sp: calcSP(charData.tier, charData.attributes.spi),
    maxSp: calcSP(charData.tier, charData.attributes.spi),
    ascension: {
      enabled: charData.ascension.enabled,
      elements: (charData.ascension.elements ?? []).map((e, i) => ({
        name: e.name, description: e.description, effects: e.effects,
        effectDescriptions: itemData.elements?.[i]?.effectDescriptions,
        scripts: itemData.elements?.[i]?.scripts,
      })),
      authority: (charData.ascension.authorities ?? []).map((a, i) => ({
        name: a.name, description: a.description, effects: a.effects, costDescription: a.costDescription,
        effectDescriptions: itemData.authorities?.[i]?.effectDescriptions,
        scripts: itemData.authorities?.[i]?.scripts,
      })),
      law: (charData.ascension.laws ?? []).map((l) => ({
        name: l.name, description: l.description,
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
  const character = assembleCharacterState(charData, itemData);

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

// ========== Internal Helpers ==========

/**
 * 解析 char_gen Agent 的输出。
 * 支持两种格式:
 * 1. JSON（旧格式，向后兼容）
 * 2. XML <char_result>（新 Agentic 格式，Phase 8.5）
 */
export function parseCharGenOutput(raw: string): CharGenOutput {
  // 先尝试 XML
  const xml = extractXML(raw, 'char_result');
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
    const json = extractJSON(raw);
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
  const json = extractJSON(text);
  if (!json) return null;
  let data: any;
  try { data = JSON.parse(json); } catch { return null; }
  if (!data || typeof data !== 'object' || !data.name) return null;
  return charGenFromJSON(data);
}

function charGenFromJSON(data: any): CharGenOutput {
  const attrs: Record<string, number> = {};
  if (data.attributes && typeof data.attributes === 'object') {
    for (const k of ['str', 'dex', 'con', 'int', 'spi']) {
      attrs[k] = typeof data.attributes[k] === 'number' ? data.attributes[k] : (parseInt(data.attributes[k]) || 0);
    }
  }
  // 空对象 → 用默认值（但 0 保留）
  if (!Object.keys(attrs).length) { for (const k of ['str', 'dex', 'con', 'int', 'spi']) attrs[k] = 10; }

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
    identity: Array.isArray(data.identity) ? data.identity : (typeof data.identity === 'string' ? [data.identity] : []),
    occupation: Array.isArray(data.occupation) ? data.occupation : (typeof data.occupation === 'string' ? [data.occupation] : []),
    // appearance/personality: 对象取 summary 纯文本，字符串直用
    background: data.background ?? data.lore?.origin ?? data.description ?? '',
    appearance: typeof appearance === 'object' && appearance ? (appearance.summary ?? appearance.description ?? JSON.stringify(appearance)) : (typeof appearance === 'string' ? appearance : ''),
    clothing: data.clothing ?? data.outfit ?? '',
    personality: typeof personality === 'object' && personality ? (personality.summary ?? personality.description ?? JSON.stringify(personality)) : (typeof personality === 'string' ? personality : ''),
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

/** 从 XML <char_result> 中解析角色数据 */
function parseCharGenXML(xml: string): CharGenOutput {
  // ascension 子结构
  const ascXML = extractTagBlock(xml, 'ascension');
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
        effects: m[2]?.trim().split('\n').filter(s => s.trim()).map(s => s.trim()) ?? [],
      });
    }
    // 解析 <authority> 子标签
    const auMatches = ascXML.matchAll(/<authority\b([^>]*?)>([\s\S]*?)<\/authority>/g);
    for (const m of auMatches) {
      const attrs = parseAttrsStr(m[1]);
      ascAuthorities.push({
        name: attrs['name'] ?? '',
        description: attrs['description'] ?? '',
        effects: m[2]?.trim().split('\n').filter(s => s.trim()).map(s => s.trim()) ?? [],
        costDescription: attrs['cost'] ?? '',
      });
    }
    // 解析 <law> 子标签
    const lawMatches = ascXML.matchAll(/<law\b([^>]*?)>([\s\S]*?)<\/law>/g);
    for (const m of lawMatches) {
      const attrs = parseAttrsStr(m[1]);
      const innerText = m[2]?.trim() ?? '';
      ascLaws.push({
        name: attrs['name'] ?? '',
        description: attrs['description'] ?? '',
        passiveEffects: attrs['passive']?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
        activeEffects: attrs['active']?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
        costDescription: attrs['cost'] ?? '',
      });
    }
  }

  // 技能/装备/物品 子结构 (char_gen 自行生成)
  const skillsXML = extractTagBlock(xml, 'skills');
  const equipmentXML = extractTagBlock(xml, 'equipment');
  const inventoryXML = extractTagBlock(xml, 'inventory');

  const skills = skillsXML ? parseSkillsXML(skillsXML) : [];
  const equipment = equipmentXML ? parseEquipmentXML(equipmentXML) : [];
  const inventory = inventoryXML ? parseInventoryXML(inventoryXML) : [];

  return {
    name: extractTag(xml, 'name') ?? '未命名',
    race: extractTag(xml, 'race') ?? '人类',
    gender: extractTag(xml, 'gender') ?? '其他',
    faction: extractTag(xml, 'faction') ?? undefined,
    tier: parseInt(extractTag(xml, 'tier') ?? '1') || 1,
    level: parseInt(extractTag(xml, 'level') ?? '1') || 1,
    attributes: {
      // 真机修(2026-07-17): `|| 10` 会把 0 打回 10 — 意识体/灵体的 0 属性是合法值，改 NaN 检查
      str: parseAttrIntKeepZero(xml, 'attributes', 'str', 10),
      dex: parseAttrIntKeepZero(xml, 'attributes', 'dex', 10),
      con: parseAttrIntKeepZero(xml, 'attributes', 'con', 10),
      int: parseAttrIntKeepZero(xml, 'attributes', 'int', 10),
      spi: parseAttrIntKeepZero(xml, 'attributes', 'spi', 10),
    },
    identity: extractTag(xml, 'identity')?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
    occupation: extractTag(xml, 'occupation')?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
    // 真机修(2026-07-17): AI 可能在叙事字段内嵌套子标签（<appearance>→<physical>/<voice>等），
    // extractTag 原样返回 → 落库带 XML 污染前端渲染。stripInnerTags 剥子标签留纯文本。
    background: stripInnerTags(extractTag(xml, 'background') ?? ''),
    appearance: stripInnerTags(extractTag(xml, 'appearance') ?? ''),
    clothing: stripInnerTags(extractTag(xml, 'clothing') ?? ''),
    personality: stripInnerTags(extractTag(xml, 'personality') ?? extractAttr(xml, 'personality', 'code') ?? ''),
    likes: stripInnerTags(extractTag(xml, 'likes') ?? ''),
    thoughts: stripInnerTags(extractTag(xml, 'thoughts') ?? ''),
    ascension: {
      enabled: (extractAttr(xml, 'ascension', 'enabled') ?? 'false') === 'true',
      path: extractAttr(xml, 'ascension', 'path') ?? '',
      description: extractAttr(xml, 'ascension', 'description') ?? '',
      elements: ascElements,
      authorities: ascAuthorities,
      laws: ascLaws,
      deityPosition: ascXML ? (extractTag(ascXML, 'deity_position') ?? '') : '',
      divineKingdom: (() => {
        if (!ascXML) return { name: '', description: '' };
        const kdXML = extractTagBlock(ascXML, 'kingdom');
        return {
          name: kdXML ? (extractAttr(kdXML, 'kingdom', 'name') ?? extractTag(kdXML, 'name') ?? '') : '',
          description: kdXML ? (extractAttr(kdXML, 'kingdom', 'description') ?? extractTag(kdXML, 'description') ?? '') : '',
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
  const xml = extractXML(raw, 'item_result');
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
    const json = extractJSON(raw);
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
  const json = extractJSON(text);
  if (!json) return null;
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  // 已分组形状直接映射
  if (Array.isArray(data.skills) || Array.isArray(data.equipment) || Array.isArray(data.inventory)) {
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
    const isSkill = SKILL_TYPES.has(typeStr) || (!it.slot && (it.cost !== undefined || it.cooldown !== undefined));
    const isEquip = !isSkill && (Boolean(it.slot) || EQUIP_TYPES.has(typeStr));

    if (isSkill) {
      out.skills.push({
        name: it.name,
        description: it.description ?? '',
        type: typeStr === 'passive' ? 'passive' : 'active',
        cost: it.cost,
        cooldown: it.cooldown,
        effects: it.effects,
        scripts: it.scripts,
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
      } as ItemGenOutput['inventory'][number]);
    }
  }

  if (!out.skills.length && !out.equipment.length && !out.inventory.length) return null;
  return out;
}

/** 从 XML <item_result> 中解析物品数据 */
function parseItemGenXML(xml: string): ItemGenOutput {
  const skillsXML = extractTagBlock(xml, 'skills');
  const equipmentXML = extractTagBlock(xml, 'equipment');
  const inventoryXML = extractTagBlock(xml, 'inventory');
  const ascensionXML = extractTagBlock(xml, 'ascension');

  const skills = skillsXML ? parseSkillsXML(skillsXML) : [];
  const equipment = equipmentXML ? parseEquipmentXML(equipmentXML) : [];
  const inventory = inventoryXML ? parseInventoryXML(inventoryXML) : [];

  // ascension 可能不存在（非登神角色）
  let elements: ItemGenOutput['elements'] | undefined;
  let authorities: ItemGenOutput['authorities'] | undefined;
  if (ascensionXML) {
    const elementsXML = extractTagBlock(ascensionXML, 'elements');
    const authoritiesXML = extractTagBlock(ascensionXML, 'authorities');
    if (elementsXML) elements = parseElementsXML(elementsXML);
    if (authoritiesXML) authorities = parseAuthoritiesXML(authoritiesXML);
  }

  return { skills, equipment, inventory, elements, authorities };
}

function parseSkillsXML(xml: string): ItemGenOutput['skills'] {
  const matches = xml.matchAll(/<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/g);
  const results: ItemGenOutput['skills'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';

    // 提取 <effect name="...">content</effect> 子元素
    const effects: Record<string, string> = {};
    const effectMatches = innerContent.matchAll(/<effect\s+name="([^"]*)">([\s\S]*?)<\/effect>/g);
    for (const em of effectMatches) {
      effects[em[1]] = em[2]?.trim() ?? '';
    }

    // 提取 <script name="...">code</script> 子元素
    const scripts: Record<string, string> = {};
    const scriptMatches = innerContent.matchAll(/<script\s+name="([^"]*)">([\s\S]*?)<\/script>/g);
    for (const sm of scriptMatches) {
      scripts[sm[1]] = sm[2]?.trim() ?? '';
    }

    // 描述 = 纯文本部分（去除所有嵌套子标签，包括 AI 自造的 <description>/<notes>/<ability> 等）
    // 优先取 <description> 子标签的文本内容，若无则剥所有标签留纯文本
    const descSubTag = innerContent.match(/<description\b[^>]*>([\s\S]*?)<\/description>/);
    // 真机 fix(2026-07-18): 预剥离 <effect>/<script> 块（含内容），防止子标签文本泄漏进 description
    // 对齐 parseElementsXML:922 的正确写法
    const descText = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/gi, '');
    const description = descSubTag
      ? descSubTag[1].trim()
      : descText.replace(/<\/?[a-z_][\w-]*[^>]*>/gi, '').trim();
    // 中文 type 归一（真机实测 AI 产 '主动'/'被动' 直接落库 → UI 不识别）
    const skillType = (attrs['type'] ?? '').trim();
    const normalizedType: 'active' | 'passive' =
      (skillType === '被动' || skillType === 'passive') ? 'passive' : 'active';

    results.push({
      name: attrs['name'] ?? '未命名技能',
      description: description || (descSubTag ? '' : descText.replace(/<[^>]+>/g, '').trim()),
      type: normalizedType,
      cost: attrs['cost_type'] ? { type: attrs['cost_type'] as 'HP' | 'MP' | 'SP', amount: parseInt(attrs['cost_amount'] ?? '0') } : undefined,
      cooldown: attrs['cooldown'] ? parseInt(attrs['cooldown']) : undefined,
      effects: Object.keys(effects).length > 0 ? effects : undefined,
      scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
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
      const [k, v] = pair.split(':').map(s => s.trim());
      if (k && v) stats[k] = parseFloat(v) || 0;
    }
    // 真机 fix(2026-07-18): 提取 <effect>/<script> 子标签，防止文本泄漏进 description
    const effects: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    const em = innerContent.matchAll(/<effect\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g);
    for (const em2 of em) { effects[em2[1]] = em2[2]?.trim() ?? ''; }
    const sm = innerContent.matchAll(/<script\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g);
    for (const sm2 of sm) { scripts[sm2[1]] = sm2[2]?.trim() ?? ''; }
    // 预剥离 effect/script 块，再 stripInnerTags 取纯文本描述
    const descText = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/gi, '');
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
    for (const em2 of em) { effects[em2[1]] = em2[2]?.trim() ?? ''; }
    const sm = innerContent.matchAll(/<script\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g);
    for (const sm2 of sm) { scripts[sm2[1]] = sm2[2]?.trim() ?? ''; }
    // 预剥离 effect/script 块，再 stripInnerTags 取纯文本描述
    const descText = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/gi, '');
    const rarityRaw = attrs['rarity'];
    results.push({
      name: attrs['name'] ?? '未命名物品',
      description: stripInnerTags(descText || innerContent),
      quantity: parseInt(attrs['quantity'] ?? '1') || 1,
      type: attrs['type'] ?? '消耗品',
      rarity: rarityRaw && rarityRaw !== '?' ? rarityRaw : undefined,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
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
    const effectDescriptions: Record<string, string> = {};
    const effectMatches = innerContent.matchAll(/<effect\s+name="([^"]*)">([\s\S]*?)<\/effect>/g);
    for (const em of effectMatches) {
      effectDescriptions[em[1]] = em[2]?.trim() ?? '';
    }

    // 提取 <script name="...">code</script> 子元素 → scripts
    const scripts: Record<string, string> = {};
    const scriptMatches = innerContent.matchAll(/<script\s+name="([^"]*)">([\s\S]*?)<\/script>/g);
    for (const sm of scriptMatches) {
      scripts[sm[1]] = sm[2]?.trim() ?? '';
    }

    // 描述 = innerContent 中去除 effect/script 标签后的纯文本
    const description = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/g, '').trim();

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
    const effectDescriptions: Record<string, string> = {};
    const effectMatches = innerContent.matchAll(/<effect\s+name="([^"]*)">([\s\S]*?)<\/effect>/g);
    for (const em of effectMatches) {
      effectDescriptions[em[1]] = em[2]?.trim() ?? '';
    }

    // 提取 <script name="...">code</script> 子元素 → scripts
    const scripts: Record<string, string> = {};
    const scriptMatches = innerContent.matchAll(/<script\s+name="([^"]*)">([\s\S]*?)<\/script>/g);
    for (const sm of scriptMatches) {
      scripts[sm[1]] = sm[2]?.trim() ?? '';
    }

    // 描述 = innerContent 中去除 effect/script 标签后的纯文本
    const description = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/g, '').trim();

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
  const effectRegex = /<effect\s+([^>]*)>([\s\S]*?)((?:<effect\b[^>]*>[\s\S]*?<\/effect>\s*)*)((?:<script\b[^>]*>[\s\S]*?<\/script>\s*)*)<\/effect>/gi;
  let match: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((match = effectRegex.exec(xmlBody)) !== null) {
    const attrsStr = match[1].trim();
    const description = match[2].trim();
    const innerEffectsBlock = match[3];
    const scriptsBlock = match[4];

    const attrs = parseAttrsStr(attrsStr);
    const owner = attrs.owner || '';
    const name = attrs.name || '';
    const category = attrs.category as '增益' | '减益' | '特殊' || '减益';
    const stacks = parseInt(attrs.stacks || '1', 10);
    const maxStacks = parseInt(attrs.maxStacks || attrs.stacks || '1', 10);
    const remainingTime = parseInt(attrs.remainingTime || '60', 10);
    const timeUnit = attrs.timeUnit as '回合' | '分钟' | '小时' || '回合';

    const effects: Record<string, string> = {};
    const effectDescriptions: Record<string, string> = {};
    if (innerEffectsBlock) {
      const innerRegex = /<effect\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/gi;
      let innerMatch: RegExpExecArray | null;
      // eslint-disable-next-line no-cond-assign
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
      // eslint-disable-next-line no-cond-assign
      while ((scriptMatch = scriptRegex.exec(scriptsBlock)) !== null) {
        const scriptName = scriptMatch[1].trim();
        const scriptCode = scriptMatch[2].trim();
        scripts[scriptName] = scriptCode;
      }
    }

    results.push({
      owner, name, category, description,
      stacks, maxStacks, remainingTime, timeUnit,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    });
  }

  return results;
}

// ── XML helpers ──

/** 从文本中提取指定 XML 标签的内容块 */
function extractXML(text: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = text.match(regex);
  return match ? match[0] : null;
}

/** 提取 XML 标签的文本内容 */
function extractTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * 剥离字段值内 AI 自作主张的嵌套 XML 标签（真机修 2026-07-17）。
 * 如 <appearance> 内嵌 <physical>/<voice>/<presence>、<personality> 内嵌 <code>/<description>。
 * 成对标签 → 保留内容（换行拼接）；孤立/残缺标签 → 删除。最多展开 3 层嵌套。
 */
function stripInnerTags(s: string): string {
  if (!s || !/<[a-z_]/i.test(s)) return s;
  let out = s;
  for (let i = 0; i < 3 && /<([a-z_][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/i.test(out); i++) {
    out = out.replace(/<([a-z_][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `${String(inner).trim()}\n`);
  }
  out = out.replace(/<\/?[a-z_][\w-]*[^>]*>/gi, '');  // 残留孤立标签清除
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 提取 XML 标签中的属性值 */
function extractAttr(xml: string, tagName: string, attrName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*"([^"]*)"`, 'i');
  const match = xml.match(regex);
  if (match) return match[1];
  // Try single quotes
  const regex2 = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*'([^']*)'`, 'i');
  const match2 = xml.match(regex2);
  return match2 ? match2[1] : null;
}

/** 提取标签内的子块 */
function extractTagBlock(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/** 提取属性并转 int — 缺失/非法用缺省值，但显式的 0 保留（真机修: 意识体 0 属性合法） */
function parseAttrIntKeepZero(xml: string, tag: string, attr: string, dflt: number): number {
  const v = parseInt(extractAttr(xml, tag, attr) ?? '');
  return Number.isNaN(v) ? dflt : v;
}

/** 解析属性字符串 key="val" key2="val2" */
function parseAttrsStr(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrStr)) !== null) {
    if (match[1] !== undefined) {
      attrs[match[1]] = match[2];
    } else if (match[3] !== undefined) {
      attrs[match[3]] = match[4];
    }
  }
  return attrs;
}

/**
 * 从可能含 markdown 代码块的文本中提取 JSON。
 * 处理 \`\`\`json ... \`\`\` 和 \`\`\` ... \`\`\` 包裹。
 */
function extractJSON(text: string): string {
  // 尝试匹配 \`\`\`json ... \`\`\`
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();

  // 尝试匹配 \`\`\` ... \`\`\`
  const codeBlockMatch = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // 查找第一个 { 到最后一个 }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text;
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
