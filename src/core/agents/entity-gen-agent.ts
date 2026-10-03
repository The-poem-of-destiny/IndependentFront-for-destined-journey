/**
 * Entity Gen Agent — 通用实体生成编排模块（2026-10-02）
 *
 * 把原 `char_gen`（角色）+ `item_gen`（技能/装备/道具）两个 Agent 合并为单个
 * **`entity_gen`**，以 `entityType` 分派：
 *
 * | entityType                     | 产出                                                |
 * | ------------------------------ | --------------------------------------------------- |
 * | `character`                    | 完整 CharacterState（自带的技能/装备/道具/登神内嵌） |
 * | `skill`/`equipment`/`item`     | 独立条目 → `add_skill` / `add_item`                  |
 * | `status`                       | 状态效果 → `add_status_effect`                        |
 * | `ascension`                    | 登神长阶 → `update_character.value.ascension`         |
 *
 * ## 硬改名（主人裁定 2026-10-02）
 * - **不做兼容壳、不做旧存档迁移**：旧 `char_gen` / `item_gen` agentId 全部退役。
 * - 实体产出**纯协议文本**：新增 `protocolText` + `tags`（两层），不再产
 *   `modifiers/buffs/automata/divinity`（这些字段已于 C5b 从实体模型删除）。
 * - 落库形状保留两种：角色单条 `add_character`；物品/技能复数 `add_item`/`add_skill`。
 *
 * ## 依赖注入（测试友好）
 * - `EntityGenDeps.clientFactory`: AgentClient 工厂
 * - `EntityGenDeps.stateManager`: StateManager（可选，用于持久化）
 */

import type {
  AgentContext,
  ApiEndpoint,
  EntityGenOutput,
  EntityGenRequestMarker,
  EntityStatusOutput,
  CharacterState,
  CharGenOutput,
  ItemGenOutput,
  StatePatch,
  QualityLevel,
  InventoryItem,
  ToolDefinition,
  ToolExecutionContext,
} from '../types/types';
import { createDefaultCharacterState } from '../types/types';
import { buildAgentMessagesAsync } from '../prompts/agent-templates';
import { getTierConfig, calcResources } from '../character/tier-constants';
import { xpToNextNumber } from '../character/exp-table';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeRarity, normalizeSlot } from '../content/field-enums';
import { parseEntityGenOutput } from './entity-gen-parse';

// ========== Types ==========

/** 角色生成请求（原 CharGenRequest） */
export interface EntityGenRequest {
  saveId: string;
  /** 新流程：request_dispatcher 输出的 entity_gen_request marker */
  marker?: EntityGenRequestMarker;
  /** 批量生成（技能/装备/道具一次打包） */
  markers?: EntityGenRequestMarker[];
  /** 正文（供 entity_gen 参考） */
  storyOutput?: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 侧链 buildAgentMessages 需要完整配置才能拿到 systemPrompt + 世界书 */
  configs?: import('../types/types').AgentConfig[];
  worldBooks?: import('../types/types').WorldBook[];
  presets?: import('../types/types').AgentPreset[];
  /**
   * 🧵 主线细化层（ADR-35 §3.4）：按实体化时点分流生产的节点投影（行为约束）。
   * 只进角色请求描述；motive 本体不进角色档案。
   */
  plotThreadInjection?: string;
}

export interface EntityGenDeps {
  /** AgentClient 工厂 — 每次调用创建新实例 (缓存隔离) */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => EntityGenClient;
  /** StateManager 写入入口 (可选，测试可不提供) */
  stateManager?: {
    commitDomainCommand: (patches: StatePatch[]) => Promise<void>;
  };
}

/** 一次生成调用的返回值 */
export interface EntityGenClientResult {
  output: string | null;
  rawResponse: string;
  tokensUsed: number;
  cacheHit: boolean;
  duration: number;
  error?: string;
}

/**
 * EntityGen 客户端接口 — 抽象的 API 调用层。
 *
 * `chatWithTools` 是生产路径（Phase 8.5 Agentic function calling）。
 * `chat` 保留为测试替身 / craft 链共用 client 的兜底（两者都缺席时返回空输出）。
 */
export interface EntityGenClient {
  chatWithTools?: (
    request: {
      messages: Array<{ role: string; content: string }>;
      tools: ToolDefinition[];
      tool_choice: string;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<any>,
    options: { maxRounds: number },
  ) => Promise<EntityGenClientResult>;

  chat?: (messages: Array<{ role: string; content: string }>) => Promise<EntityGenClientResult>;
}

export interface EntityGenChainResult {
  /** 组装后的完整角色状态（角色生成路径才非空） */
  character?: CharacterState;
  patches: StatePatch[];
  /** 叙事摘要（角色生成路径） */
  narrativeSummary: string;
  /** 实体产出（物品/技能/状态/登神路径） */
  itemOutput: EntityGenOutput;
}

/** 重铸目标：要重写的那一个条目（三选一，按名字寻址） */
export type RewriteTarget =
  | { kind: 'skill'; entry: ItemGenOutput['skills'][number] }
  | { kind: 'equipment'; entry: ItemGenOutput['equipment'][number] }
  | { kind: 'inventory'; entry: ItemGenOutput['inventory'][number] };

export interface RewriteLoadoutRequest {
  saveId: string;
  /** 持有者角色名（按名寻址，铁律1） */
  characterId: string;
  /** 要重铸的条目当前完整数据（喂给 entity_gen 当 <重铸目标>） */
  target: RewriteTarget;
  /** 玩家对现状问题的描述（可能含 debug 线索，可空） */
  userDescription?: string;
  /** 当前正文（供 entity_gen 参考，可空） */
  storyOutput?: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  configs?: import('../types/types').AgentConfig[];
  worldBooks?: import('../types/types').WorldBook[];
  presets?: import('../types/types').AgentPreset[];
}

export interface RewriteLoadoutResult {
  ok: boolean;
  patches: StatePatch[];
  itemOutput: EntityGenOutput;
  reason?: string;
}

const EMPTY_OUTPUT: EntityGenOutput = { skills: [], equipment: [], inventory: [], statuses: [] };

// ========== Public API ==========

/**
 * 统一入口 —— 以 `entityType` 分派。
 *
 * - 全部 marker 为 `character`（正常只有 1 个）→ 角色路径（单 `<entity_result>` 产全）
 * - 其余 → 物品/技能/状态/登神路径（可批量）
 */
export async function runEntityGenChain(
  request: EntityGenRequest,
  deps: EntityGenDeps,
): Promise<EntityGenChainResult> {
  const markers = resolveMarkers(request);
  if (markers.length === 0) {
    return { patches: [], narrativeSummary: '', itemOutput: EMPTY_OUTPUT };
  }

  const allCharacter = markers.every((m) => m.attributes.entityType === 'character');
  if (allCharacter) {
    return runCharacterGen(request, markers[0], deps);
  }
  return runEntityItemGen(request, markers, deps);
}

/** 解析请求中的 marker 列表（单个 / 批量） */
function resolveMarkers(request: EntityGenRequest): EntityGenRequestMarker[] {
  if (request.markers?.length) return request.markers;
  if (request.marker) return [request.marker];
  return [];
}

// ---------- 角色路径 ----------

/**
 * 角色生成：单次 `entity_gen` 调用产出 `<entity_result>`（character + 内嵌技能/装备/道具/登神）。
 * 落库：单条 `add_character`（所有数据内嵌在 value 体内）。
 */
async function runCharacterGen(
  request: EntityGenRequest,
  marker: EntityGenRequestMarker,
  deps: EntityGenDeps,
): Promise<EntityGenChainResult> {
  const output = await callEntityGenRaw(request, deps, buildCharacterLocalParams(request, marker));

  if (!output.character) {
    throw new Error('entity_gen 角色输出无法解析（缺 <character> 块且 JSON 兜底失败）');
  }

  const playerLocation = resolvePlayerLocation(request);
  const character = assembleCharacterState(output, {
    ...(playerLocation ? { location: playerLocation } : {}),
    present: true,
  });

  const patches: StatePatch[] = [
    {
      op: 'add_character',
      target: `characters.${character.name}`,
      value: character,
      metadata: { source: 'entity_gen', kind: 'character' },
    },
  ];

  if (deps.stateManager) await deps.stateManager.commitDomainCommand(patches);

  const charData = output.character;
  const narrativeSummary = `新角色「${charData.name}」已生成: ${charData.race} ${charData.occupation.join('/')}, T${charData.tier} Lv.${charData.level}, ${charData.background.slice(0, 100)}`;

  return { character, patches, narrativeSummary, itemOutput: output };
}

/** 角色请求描述：指定信息行 + 主线投影 + bodyText */
function buildCharacterLocalParams(
  request: EntityGenRequest,
  marker: EntityGenRequestMarker,
): Record<string, string> {
  const attrs = marker.attributes ?? {};
  const attrLines = [
    `实体类型: character（角色，含其技能/装备/道具/登神）`,
    attrs.characterName
      ? `指定名称: ${attrs.characterName}（若这是正文给出的真名则沿用；若只是「神秘女子」「守卫」等描述性称呼，除类型 enemy 的战斗单位沿用外，一律视为未指定，须调用 random_name_seed 生成真名）`
      : '',
    attrs.race && attrs.race !== '未知' ? `种族: ${attrs.race}` : '',
    attrs.tier && attrs.tier !== '未知' ? `层级: ${attrs.tier}` : '',
    attrs.characterType ? `类型: ${attrs.characterType}` : '',
    attrs.faction && attrs.faction !== '未知' ? `势力: ${attrs.faction}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const injection = request.plotThreadInjection ?? '';
  const bodyText = marker.bodyText ?? marker.rawContent ?? '';
  const requestContent = [attrLines, injection, bodyText].filter(Boolean).join('\n');

  return {
    ENTITY_REQUEST: requestContent,
    // 兼容角色模板里可能出现的旧占位符名（同一份内容）
    CHAR_DETECT: requestContent,
    // 🔴 模板里带 <重铸目标>/<重铸原因>/<制作结果> 三个块。localParams 不提供时
    //    template-resolver 对认不出的占位符**原样保留**（字面量泄漏进提示词），
    //    所以角色/召唤路径也必须显式填空（item-gen 链的历史教训，2026-10-02 照搬）。
    REWRITE_TARGET: '',
    REWRITE_REASON: '',
    CRAFT_RESULT: '',
  };
}

// ---------- 物品/技能/状态/登神路径 ----------

/** 把 markers 包成 `<entity_requests>` XML（纯函数，便于单测） */
export function buildEntityRequestsXML(markers: EntityGenRequestMarker[]): string {
  const lines: string[] = ['<entity_requests>'];
  for (const marker of markers) {
    const type = marker.attributes.entityType;
    const owner = marker.attributes.owner ? ` owner="${marker.attributes.owner}"` : '';
    const defaultType = type === 'status' || type === 'ascension' ? type : 'equipment';
    const slotAttr = type === 'equipment' ? ` slot="${guessSlot(marker.bodyText, type)}"` : '';
    lines.push(`  <request type="${defaultType}"${slotAttr}${owner}>`);
    lines.push(`    ${(marker.bodyText ?? '').trim()}`);
    lines.push(`  </request>`);
  }
  lines.push('</entity_requests>');
  return lines.join('\n');
}

/**
 * 物品/技能/状态/登神批量生成：一次 `entity_gen` 调用产 `<entity_result>`，
 * 按产出块构造 patches（owner 缺省取玩家名）。
 */
async function runEntityItemGen(
  request: EntityGenRequest,
  markers: EntityGenRequestMarker[],
  deps: EntityGenDeps,
): Promise<EntityGenChainResult> {
  const playerName = request.context.characters?.find((c) => c.type === 'player')?.name;
  const characterId = markers[0]?.attributes.owner ?? playerName;
  if (!characterId) {
    console.warn(
      '[entity-gen] 无 owner 且无玩家角色，跳过该 entity_gen_request:',
      markers[0]?.bodyText.slice(0, 50),
    );
    return { patches: [], narrativeSummary: '', itemOutput: EMPTY_OUTPUT };
  }

  const localParams: Record<string, string> = {
    ENTITY_REQUEST: buildEntityRequestsXML(markers),
    REWRITE_TARGET: '',
    REWRITE_REASON: '',
    CRAFT_RESULT: '',
  };

  const output = await callEntityGenRaw(request, deps, localParams);
  const patches = buildEntityGenPatches(output, characterId);

  if (deps.stateManager && patches.length > 0) {
    await deps.stateManager.commitDomainCommand(patches);
  }

  return { patches, narrativeSummary: '', itemOutput: output };
}

/**
 * 把 EntityGenOutput 转成 StatePatch（保留 M3 零 id / 按名寻址 / 装备单 add_item 带 equippedSlot）。
 *
 * - equipment → add_item（带 equippedSlot，slot 归一化）
 * - inventory → add_item
 * - skills → add_skill
 * - statuses → add_status_effect
 * - ascension → update_character.value.ascension
 */
export function buildEntityGenPatches(output: EntityGenOutput, characterId: string): StatePatch[] {
  const patches: StatePatch[] = [];

  for (const equip of output.equipment) {
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        name: equip.name,
        description: equip.description,
        quantity: 1,
        type: '装备',
        rarity: equip.quality,
        equippedSlot: normalizeSlot(equip.slot),
        stats: equip.stats,
        durability: equip.durability,
        maxDurability: equip.durability,
        ...(equip.effects && Object.keys(equip.effects).length > 0
          ? { effects: equip.effects }
          : {}),
        ...(equip.protocolText ? { protocolText: equip.protocolText } : {}),
        ...(equip.tags?.length ? { tags: equip.tags } : {}),
      },
      metadata: { source: 'entity_gen', kind: 'equipment' },
    });
  }

  for (const inv of output.inventory) {
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        name: inv.name,
        description: inv.description,
        quantity: inv.quantity,
        type: inv.type,
        rarity: inv.rarity,
        ...(inv.effects && Object.keys(inv.effects).length > 0 ? { effects: inv.effects } : {}),
        ...(inv.protocolText ? { protocolText: inv.protocolText } : {}),
        ...(inv.tags?.length ? { tags: inv.tags } : {}),
      },
      metadata: { source: 'entity_gen', kind: 'inventory' },
    });
  }

  for (const skill of output.skills) {
    patches.push({
      op: 'add_skill',
      target: `characters.${characterId}`,
      value: {
        name: skill.name,
        description: skill.description,
        type: skill.type,
        cost: skill.cost,
        cooldown: skill.cooldown,
        ...(skill.quality ? { rarity: skill.quality } : {}),
        effects: skill.effects,
        ...(skill.skillPower !== undefined ? { skillPower: skill.skillPower } : {}),
        ...(skill.relevantAttribute ? { relevantAttribute: skill.relevantAttribute } : {}),
        ...(skill.damageType ? { damageType: skill.damageType } : {}),
        ...(skill.protocolText ? { protocolText: skill.protocolText } : {}),
        ...(skill.tags?.length ? { tags: skill.tags } : {}),
      },
      metadata: { source: 'entity_gen', kind: 'skill' },
    });
  }

  for (const st of output.statuses ?? []) {
    const owner = st.owner || characterId;
    const value: EntityStatusOutput & { owner: string } = { ...st, owner };
    patches.push({
      op: 'add_status_effect',
      target: `characters.${owner}`,
      value,
      metadata: { source: 'entity_gen', kind: 'status' },
    });
  }

  if (output.ascension) {
    patches.push({
      op: 'update_character',
      target: `characters.${characterId}`,
      value: { ascension: mapAscension(output.ascension, output) },
      metadata: { source: 'entity_gen', kind: 'ascension' },
    });
  }

  return patches;
}

/**
 * 把 CharGenOutput.ascension 映射为落库形状（elements/authorities/law）。
 * `extra` 的 elements/authorities（独立登神块）提供 effectDescriptions。
 */
function mapAscension(
  asc: CharGenOutput['ascension'],
  extra?: EntityGenOutput,
): CharacterState['ascension'] {
  return {
    enabled: asc.enabled,
    elements: (asc.elements ?? []).map((e, i) => ({
      name: e.name,
      description: e.description,
      effects: e.effects,
      effectDescriptions: e.effectDescriptions ?? extra?.elements?.[i]?.effectDescriptions,
    })),
    authority: (asc.authorities ?? []).map((a, i) => ({
      name: a.name,
      description: a.description,
      effects: a.effects,
      costDescription: a.costDescription,
      effectDescriptions: a.effectDescriptions ?? extra?.authorities?.[i]?.effectDescriptions,
    })),
    law: (asc.laws ?? []).map((l) => ({
      name: l.name,
      description: l.description,
      effects: [...(l.passiveEffects ?? []), ...(l.activeEffects ?? [])],
      costDescription: l.costDescription,
    })),
    deityPosition: asc.deityPosition || '',
    divineKingdom: asc.divineKingdom || { name: '', description: '' },
  };
}

// ---------- 通用调用体 ----------

/**
 * 调 `entity_gen` 的公共执行体（角色/物品/制作/重铸共用）。
 * localParams 由调用方决定，注入模板占位符。
 */
export async function callEntityGenRaw(
  request: {
    context: AgentContext;
    endpoint: ApiEndpoint;
    saveId: string;
    storyOutput?: string;
    configs?: import('../types/types').AgentConfig[];
    worldBooks?: import('../types/types').WorldBook[];
    presets?: import('../types/types').AgentPreset[];
  },
  deps: EntityGenDeps,
  localParams: Record<string, string>,
): Promise<EntityGenOutput> {
  const contextWithStory: AgentContext = {
    ...request.context,
    ...(request.storyOutput !== undefined
      ? { agentOutputs: new Map([['story', request.storyOutput]]) }
      : {}),
  };

  try {
    const messages = await buildAgentMessagesAsync(
      'entity_gen',
      contextWithStory,
      request.configs,
      request.worldBooks,
      request.presets,
      localParams,
    );
    if (!messages || messages.length === 0) {
      // 模板找不到 / 空 messages 时返回空，不阻塞主流程（也避免打 API 触发 400）
      return EMPTY_OUTPUT;
    }

    const client = deps.clientFactory('entity_gen', request.endpoint, request.saveId);
    const tools = getToolsForAgent('entity_gen');
    const toolContext: ToolExecutionContext = {
      characters: request.context.characters ?? [],
      variables: request.context.variables ?? {},
      saveId: request.saveId,
    };

    let result: EntityGenClientResult;
    if (client.chatWithTools) {
      // Agentic 路径（生产）：function calling 多轮循环
      result = await client.chatWithTools(
        { messages, tools, tool_choice: tools.length > 0 ? 'auto' : 'none' },
        async (name, args) => executeToolCall(name, args, toolContext),
        { maxRounds: 10 },
      );
    } else if (client.chat) {
      // 兜底（测试替身 / craft 共用 client）
      result = await client.chat(messages);
    } else {
      return EMPTY_OUTPUT;
    }

    if (result.error) {
      console.warn('entity_gen 调用失败:', result.error);
      return EMPTY_OUTPUT;
    }
    if (!result.output && !result.rawResponse) return EMPTY_OUTPUT;

    return parseEntityGenOutput(result.output ?? result.rawResponse);
  } catch (err) {
    // entity_gen 失败不阻断主流程（与旧 char_gen/item_gen 链一致的容错策略）
    console.warn('entity_gen 调用失败，实体将无详细数值:', err);
    return EMPTY_OUTPUT;
  }
}

/**
 * 制作产物链入口（craft_gen 复用）：把 craft 的 `<item_requests>` 作为 ENTITY_REQUEST 注入。
 */
export async function callEntityGenForCraft(
  itemRequestsXML: string,
  craftDataXML: string,
  request: {
    context: AgentContext;
    endpoint: ApiEndpoint;
    saveId: string;
    storyOutput?: string;
    configs?: import('../types/types').AgentConfig[];
    worldBooks?: import('../types/types').WorldBook[];
    presets?: import('../types/types').AgentPreset[];
  },
  deps: EntityGenDeps,
): Promise<EntityGenOutput> {
  const output = await callEntityGenRaw(request, deps, {
    ENTITY_REQUEST: itemRequestsXML,
    CRAFT_RESULT: craftDataXML,
    REWRITE_TARGET: '',
    REWRITE_REASON: '',
  });
  return output;
}

// ---------- 组装 CharacterState ----------

/**
 * 纯函数：把 EntityGenOutput 组装为完整 CharacterState。
 * 角色自带的技能/装备/道具优先，顶层块（独立生成）补充去重。
 *
 * M3: 正式字段直写；ascension 数据内嵌；零 id。
 */
export function assembleCharacterState(
  output: EntityGenOutput,
  overrides: Partial<CharacterState> = {},
): CharacterState {
  const charData = output.character;
  if (!charData) {
    throw new Error('assembleCharacterState: output.character 缺失');
  }
  const tierConfig = getTierConfig(charData.tier);
  const tierName = tierConfig?.name ?? '普通';

  // 技能：角色自带优先，顶层补充（去重）
  const charSkills = charData.skills ?? [];
  const extraSkills = output.skills ?? [];
  const charSkillNames = new Set(charSkills.map((s) => s.name));
  const mergedSkills = [...extraSkills.filter((s) => !charSkillNames.has(s.name)), ...charSkills];

  const skills = mergedSkills.map((s) => {
    const rarity = normalizeRarity(s.quality ?? '');
    return {
      name: s.name,
      description: s.description,
      type: s.type,
      cost: s.cost ? { type: s.cost.type, amount: s.cost.amount } : undefined,
      cooldown: s.cooldown,
      level: 1,
      ...(rarity ? { rarity } : {}),
      effects: s.effects,
      ...(s.skillPower !== undefined ? { skillPower: s.skillPower } : {}),
      ...(s.relevantAttribute ? { relevantAttribute: s.relevantAttribute } : {}),
      ...(s.damageType ? { damageType: s.damageType } : {}),
      ...(s.protocolText ? { protocolText: s.protocolText } : {}),
      ...(s.tags?.length ? { tags: s.tags } : {}),
    };
  });

  // 装备：角色自带优先
  const charEquip = charData.equipment ?? [];
  const extraEquip = output.equipment ?? [];
  const charEquipNames = new Set(charEquip.map((e) => e.name));
  const mergedEquip = [...extraEquip.filter((e) => !charEquipNames.has(e.name)), ...charEquip];

  const equippedItems: InventoryItem[] = mergedEquip.map((e) => ({
    name: e.name,
    description: e.description,
    quantity: 1,
    type: '装备',
    equippedSlot: normalizeSlot(e.slot),
    stats: e.stats,
    durability: e.durability,
    maxDurability: e.durability,
    effects: e.effects,
    ...(e.protocolText ? { protocolText: e.protocolText } : {}),
    ...(e.tags?.length ? { tags: e.tags } : {}),
  }));

  // 背包：角色自带优先
  const charInv = charData.inventory ?? [];
  const extraInv = output.inventory ?? [];
  const charInvNames = new Set(charInv.map((i) => i.name));
  const mergedInv = [...extraInv.filter((i) => !charInvNames.has(i.name)), ...charInv];

  const inventory: InventoryItem[] = [
    ...mergedInv.map((inv) => ({
      name: inv.name,
      description: inv.description,
      type: inv.type,
      quantity: inv.quantity,
      rarity: (inv.rarity as QualityLevel) || undefined,
      effects: inv.effects,
      ...(inv.protocolText ? { protocolText: inv.protocolText } : {}),
      ...(inv.tags?.length ? { tags: inv.tags } : {}),
    })),
    ...equippedItems,
  ];

  // 状态效果（顶层 statuses）→ 落库 StatusEffect 形状
  const statusEffects: CharacterState['statusEffects'] = (output.statuses ?? []).map((st) => ({
    name: st.name,
    description: st.description,
    category: st.category,
    stacks: st.stacks,
    maxStacks: st.maxStacks,
    remainingTime: st.remainingTime,
    timeUnit: st.timeUnit,
    source: 'entity_gen',
    effects: {},
    ...(st.effects ? { effectDescriptions: st.effectDescriptions ?? { ...st.effects } } : {}),
    ...(st.protocolText ? { protocolText: st.protocolText } : {}),
    ...(st.tags?.length ? { tags: st.tags } : {}),
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
    ...calcResources(charData.tier, charData.attributes),
    expToNext: xpToNextNumber(charData.level),
    ascension: mapAscension(charData.ascension, output),
    skills,
    inventory,
    statusEffects,
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

// ========== 重铸（单条目，2026-08-24） ==========

/**
 * 把重铸输出转成「替换 patch」—— remove 旧的（按名）+ add 新的，同一次 commitDomainCommand 原子落库。
 * 只认 `replace === targetName` 的那一条。
 */
export function buildRewritePatches(
  output: EntityGenOutput,
  characterId: string,
  targetName: string,
): { patches: StatePatch[]; ok: boolean; reason?: string } {
  const patches: StatePatch[] = [];
  let matched: RewriteTarget | null = null;

  for (const sk of output.skills) {
    if (sk.replace && sk.replace === targetName) {
      matched = { kind: 'skill', entry: sk };
      break;
    }
  }
  if (!matched) {
    for (const eq of output.equipment) {
      if (eq.replace && eq.replace === targetName) {
        matched = { kind: 'equipment', entry: eq };
        break;
      }
    }
  }
  if (!matched) {
    for (const inv of output.inventory) {
      if (inv.replace && inv.replace === targetName) {
        matched = { kind: 'inventory', entry: inv };
        break;
      }
    }
  }
  if (!matched) {
    return {
      patches: [],
      ok: false,
      reason: 'entity_gen 未声明替换目标（replace 属性缺失或点名与目标不符）',
    };
  }

  // 1. remove 旧的（按名；技能 remove_skill，物品/装备 remove_item）
  patches.push(
    matched.kind === 'skill'
      ? { op: 'remove_skill', target: `characters.${characterId}`, value: { name: targetName } }
      : { op: 'remove_item', target: `characters.${characterId}`, value: { name: targetName } },
  );

  // 2. add 新的（照 buildEntityGenPatches 的形状）
  patches.push(
    ...buildEntityGenPatches(
      { ...EMPTY_OUTPUT, [matchedKindKey(matched.kind)]: [matched.entry as never] },
      characterId,
    ),
  );

  return { patches, ok: true };
}

function matchedKindKey(kind: RewriteTarget['kind']): 'skills' | 'equipment' | 'inventory' {
  return kind === 'skill' ? 'skills' : kind === 'equipment' ? 'equipment' : 'inventory';
}

/**
 * 单条目重铸：以条目当前数据 + 玩家描述为输入，调 entity_gen 重新编写该条目，
 * 然后 remove 旧的 + add 新的（同一次 commitDomainCommand，原子）。
 */
export async function rewriteLoadoutItem(
  request: RewriteLoadoutRequest,
  deps: EntityGenDeps,
): Promise<RewriteLoadoutResult> {
  const targetName = request.target.entry.name;
  const typeHint =
    request.target.kind === 'skill'
      ? 'skill'
      : request.target.kind === 'equipment'
        ? 'equipment'
        : 'item';

  const localParams: Record<string, string> = {
    ENTITY_REQUEST: `重铸模式：请重写条目「${targetName}」（类型 ${typeHint}），输出对应条目并在其上带 replace="${targetName}" 属性声明替换。`,
    REWRITE_TARGET: JSON.stringify(request.target.entry, null, 2),
    REWRITE_REASON: request.userDescription ?? '',
    CRAFT_RESULT: '',
  };

  const output = await callEntityGenRaw(
    { ...request, storyOutput: request.storyOutput ?? '' },
    deps,
    localParams,
  );

  const r = buildRewritePatches(output, request.characterId, targetName);
  if (!r.ok) return { ok: false, patches: [], itemOutput: output, reason: r.reason };

  if (deps.stateManager && r.patches.length > 0) {
    await deps.stateManager.commitDomainCommand(r.patches);
  }

  return { ok: true, patches: r.patches, itemOutput: output };
}

// ========== Helpers ==========

/** 从 AgentContext 解析玩家角色 location（新登场 NPC 默认继承） */
function resolvePlayerLocation(request: EntityGenRequest): string {
  const player = request.context.characters?.find((c) => c.type === 'player');
  return player?.location ?? '';
}

/**
 * 根据 marker.bodyText 粗略猜测装备槽位。
 * entity_gen 模板 prompt 用中文槽位名 (武器/护甲/身体/头部/饰品/腰带/鞋子/主手/副手/惯用手)。
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

// ========== $chargen API（兼容旧引用点） ==========

export const $chargen = {
  /** 运行完整实体生成链（角色/物品） */
  generate: runEntityGenChain,
  /** 组装 CharacterState (纯函数) */
  assemble: assembleCharacterState,
};
