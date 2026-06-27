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
  CharGenOutput,
  CharGenChainResult,
  ItemGenOutput,
  CharacterState,
  StatePatch,
  QualityLevel,
  EquipmentSlot,
  InventoryItem,
  ToolDefinition,
} from './types';
import { createDefaultCharacterState } from './types';
import { scanCharDetects } from './marker-protocol';
import { buildAgentMessages } from './agent-templates';
import { getTierConfig, calcHP, calcMP, calcSP } from './tier-constants';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import type { ToolExecutionContext } from './types';

// ========== Types ==========

export interface CharGenRequest {
  saveId: string;
  detection: CharDetectMarker;
  context: AgentContext;
  endpoint: ApiEndpoint;
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
  const messages = buildAgentMessages('char_gen', {
    ...request.context,
    agentOutputs: new Map([['story', request.detection.rawContent]]),
  });

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
    return parseCharGenOutput(rawOutput);
  }

  // 回退: 旧路径（无工具，直接 chat）
  const result = await client.chat(messages);

  if (result.error) {
    throw new Error(`char_gen Agent 调用失败: ${result.error}`);
  }

  const rawOutput = result.output ?? result.rawResponse;
  return parseCharGenOutput(rawOutput);
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
      ['story', request.detection.rawContent],
    ]),
  };

  const messages = buildAgentMessages('item_gen', contextWithCharData);

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
    id: crypto.randomUUID(),
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
  const charEquip = charData.equipment ?? [];
  const itemGenEquip = itemData.equipment ?? [];
  const charEquipNames = new Set(charEquip.map(e => e.name));
  const mergedEquip = [...itemGenEquip.filter(e => !charEquipNames.has(e.name)), ...charEquip];

  const equipment: EquipmentSlot[] = mergedEquip.map((e) => {
    const itemId = crypto.randomUUID();
    return {
      slot: e.slot,
      itemId,
      name: e.name,
      description: e.description,
      stats: e.stats,
      durability: e.durability,
      maxDurability: e.durability,
      effects: (e as any).effects,
    };
  });

  // 合并背包: char_gen 自产优先
  const charInv = charData.inventory ?? [];
  const itemGenInv = itemData.inventory ?? [];
  const charInvNames = new Set(charInv.map(i => i.name));
  const mergedInv = [...itemGenInv.filter(i => !charInvNames.has(i.name)), ...charInv];

  const inventory: InventoryItem[] = mergedInv.map((inv) => ({
    id: crypto.randomUUID(),
    name: inv.name,
    description: inv.description,
    type: inv.type,
    quantity: inv.quantity,
    rarity: (inv.rarity as QualityLevel) || undefined,
  }));

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
      elements: Object.fromEntries(
        (charData.ascension.elements ?? []).map((e, i) => [
          `el_${i}`,
          { name: e.name, description: e.description, effects: e.effects },
        ]),
      ),
      authority: Object.fromEntries(
        (charData.ascension.authorities ?? []).map((a, i) => [
          `au_${i}`,
          { name: a.name, description: a.description, effects: a.effects, costDescription: a.costDescription },
        ]),
      ),
      law: Object.fromEntries(
        (charData.ascension.laws ?? []).map((l, i) => [
          `law_${i}`,
          { name: l.name, description: l.description, effects: [...(l.passiveEffects ?? []), ...(l.activeEffects ?? [])], costDescription: l.costDescription },
        ]),
      ),
      deityPosition: charData.ascension.deityPosition || '',
      divineKingdom: charData.ascension.divineKingdom || { name: '', description: '' },
    },
    equipment,
    skills,
    inventory,
    customFields: {
      background: charData.background,
      appearance: charData.appearance,
      personality: charData.personality,
      gender: charData.gender,
      likes: charData.likes,
      clothing: charData.clothing,
      faction: charData.faction,
      ascensionPath: charData.ascension.path,
      ascensionDescription: charData.ascension.description,
    },
    ...overrides,
  });
}

/**
 * 为生成的 CharacterState 构建 StatePatch[]。
 * 产出: add_character + add_skill × N + add_item × N + equip_item × N
 */
export function buildCharGenPatches(character: CharacterState): StatePatch[] {
  const patches: StatePatch[] = [];

  // 1. 添加角色
  patches.push({
    op: 'add_character',
    target: `characters.${character.id}`,
    value: character,
    metadata: { source: 'char_gen', phase: '6e' },
  });

  // 2. 添加技能
  for (const skill of character.skills) {
    patches.push({
      op: 'add_skill',
      target: `characters.${character.id}.skills`,
      value: skill,
      metadata: { source: 'item_gen' },
    });
  }

  // 3. 添加背包物品
  for (const item of character.inventory) {
    patches.push({
      op: 'add_item',
      target: `characters.${character.id}.inventory`,
      value: item,
      metadata: { source: 'item_gen' },
    });
  }

  // 4. 装备物品
  for (const equip of character.equipment) {
    patches.push({
      op: 'equip_item',
      target: `characters.${character.id}.equipment`,
      value: equip,
      metadata: { source: 'item_gen' },
    });
  }

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
function parseCharGenOutput(raw: string): CharGenOutput {
  // 先尝试 XML
  const xml = extractXML(raw, 'char_result');
  if (xml) {
    return parseCharGenXML(xml);
  }

  // 回退到 JSON
  try {
    const json = extractJSON(raw);
    const data = JSON.parse(json);

    if (!data.name) throw new Error('char_gen 输出缺少 name 字段');
    if (!data.race) throw new Error('char_gen 输出缺少 race 字段');

    return {
      name: data.name,
      race: data.race,
      tier: data.tier ?? 1,
      level: data.level ?? 1,
      attributes: {
        str: data.attributes?.str ?? 10,
        dex: data.attributes?.dex ?? 10,
        con: data.attributes?.con ?? 10,
        int: data.attributes?.int ?? 10,
        spi: data.attributes?.spi ?? 10,
      },
      identity: data.identity ?? [],
      occupation: data.occupation ?? [],
      background: data.background ?? '',
      appearance: data.appearance ?? '',
      clothing: data.clothing ?? '',
      personality: data.personality ?? '',
      likes: data.likes ?? '',
      gender: data.gender ?? '其他',
      faction: data.faction,
      ascension: {
        enabled: data.ascension?.enabled ?? false,
        path: data.ascension?.path ?? '',
        description: data.ascension?.description ?? '',
        elements: data.ascension?.elements ?? [],
        authorities: data.ascension?.authorities ?? [],
        laws: data.ascension?.laws ?? [],
        deityPosition: data.ascension?.deityPosition ?? '',
        divineKingdom: data.ascension?.divineKingdom ?? { name: '', description: '' },
      },
      skills: data.skills ?? [],
      equipment: data.equipment ?? [],
      inventory: data.inventory ?? [],
    };
  } catch {
    throw new Error(`char_gen 输出无法解析 (JSON+XML 均失败): ${raw.slice(0, 200)}`);
  }
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
      str: parseInt(extractAttr(xml, 'attributes', 'str') ?? '10') || 10,
      dex: parseInt(extractAttr(xml, 'attributes', 'dex') ?? '10') || 10,
      con: parseInt(extractAttr(xml, 'attributes', 'con') ?? '10') || 10,
      int: parseInt(extractAttr(xml, 'attributes', 'int') ?? '10') || 10,
      spi: parseInt(extractAttr(xml, 'attributes', 'spi') ?? '10') || 10,
    },
    identity: extractTag(xml, 'identity')?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
    occupation: extractTag(xml, 'occupation')?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
    background: extractTag(xml, 'background') ?? '',
    appearance: extractTag(xml, 'appearance') ?? '',
    clothing: extractTag(xml, 'clothing') ?? '',
    personality: extractTag(xml, 'personality') ?? extractAttr(xml, 'personality', 'code') ?? '',
    likes: extractTag(xml, 'likes') ?? '',
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
function parseItemGenOutput(raw: string): ItemGenOutput {
  // 先尝试 XML
  const xml = extractXML(raw, 'item_result');
  if (xml) {
    return parseItemGenXML(xml);
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

/** 从 XML <item_result> 中解析物品数据 */
function parseItemGenXML(xml: string): ItemGenOutput {
  const skillsXML = extractTagBlock(xml, 'skills');
  const equipmentXML = extractTagBlock(xml, 'equipment');
  const inventoryXML = extractTagBlock(xml, 'inventory');

  const skills = skillsXML ? parseSkillsXML(skillsXML) : [];
  const equipment = equipmentXML ? parseEquipmentXML(equipmentXML) : [];
  const inventory = inventoryXML ? parseInventoryXML(inventoryXML) : [];

  return { skills, equipment, inventory };
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

    // 描述 = 技能内容中的纯文本部分（去除 effect/script 标签）
    const description = innerContent.replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/g, '').trim();

    results.push({
      name: attrs['name'] ?? '未命名技能',
      description: description || innerContent,
      type: (attrs['type'] as 'active' | 'passive') ?? 'active',
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
    const statsStr = attrs['stats'] ?? '';
    const stats: Record<string, number> = {};
    for (const pair of statsStr.split(',')) {
      const [k, v] = pair.split(':').map(s => s.trim());
      if (k && v) stats[k] = parseFloat(v) || 0;
    }
    results.push({
      slot: attrs['slot'] ?? '饰品',
      name: attrs['name'] ?? '未命名装备',
      description: m[2]?.trim() ?? '',
      stats,
      durability: attrs['durability'] ? parseInt(attrs['durability']) : undefined,
      quality: attrs['quality'],
    });
  }
  return results;
}

function parseInventoryXML(xml: string): ItemGenOutput['inventory'] {
  const matches = xml.matchAll(/<item\s+([^>]*?)>([\s\S]*?)<\/item>/g);
  const results: ItemGenOutput['inventory'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    results.push({
      name: attrs['name'] ?? '未命名物品',
      description: m[2]?.trim() ?? '',
      quantity: parseInt(attrs['quantity'] ?? '1') || 1,
      type: attrs['type'] ?? '消耗品',
      rarity: attrs['rarity'],
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
