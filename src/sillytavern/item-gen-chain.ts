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
import { buildAgentMessagesAsync } from './agent-templates';
import { getToolsForAgent, executeToolCall } from './agent-tools';
import { normalizeSlot } from './field-enums';
import type { ToolExecutionContext } from './types';

// ========== Types ==========

export interface ItemGenChainRequest {
  saveId: string;
  /** 单个 marker（兼容旧调用方） */
  marker?: ItemGenRequestMarker;
  /**
   * 🔴 2026-08-02 批量生成: 多个 marker 一次打包给 item_gen。
   * 此前 GamePipeline 对每个 marker 串行调一次 item_gen（N 个请求 = N 次调用，
   * 每个 40-60s，开局 5 技能 4 装备 1 消耗品 = 6-10 分钟）。批量打包后
   * item_gen 一次生成全部条目，调用次数从 N → 1。
   */
  markers?: ItemGenRequestMarker[];
  storyOutput: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 真机修(2026-07-17): 侧链 buildAgentMessages 需要完整配置才能拿到 systemPrompt + 世界书 */
  configs?: import('./types').AgentConfig[];
  worldBooks?: import('./types').WorldBook[];
  presets?: import('./types').AgentPreset[];
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

// ========== 重铸（单条目，2026-08-24） ==========

/** 重铸目标：要重写的那一个条目（三选一，按名字寻址） */
export type RewriteTarget =
  | { kind: 'skill'; entry: ItemGenOutput['skills'][number] }
  | { kind: 'equipment'; entry: ItemGenOutput['equipment'][number] }
  | { kind: 'inventory'; entry: ItemGenOutput['inventory'][number] };

export interface RewriteLoadoutRequest {
  saveId: string;
  /** 持有者角色名（按名寻址，铁律1） */
  characterId: string;
  /** 要重铸的条目当前完整数据（喂给 item_gen 当 <重铸目标>） */
  target: RewriteTarget;
  /** 玩家对现状问题的描述（可能含 debug 线索，可空） */
  userDescription?: string;
  /** 当前正文（供 item_gen 参考，可空 —— 手动重铸不一定有正文上下文） */
  storyOutput?: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  configs?: import('./types').AgentConfig[];
  worldBooks?: import('./types').WorldBook[];
  presets?: import('./types').AgentPreset[];
}

export interface RewriteLoadoutResult {
  ok: boolean;
  patches: StatePatch[];
  itemOutput: ItemGenOutput;
  /** !ok 时的人话原因（给 UI toast 用） */
  reason?: string;
}

const EMPTY_ITEM_OUTPUT: ItemGenOutput = { skills: [], equipment: [], inventory: [] };

// ========== Public API ==========

/**
 * 完整独立 item_gen 链:
 * 1. callItemGenForRequest() — 调 item_gen Agent 生成 skills/equipment/inventory
 * 2. buildItemGenPatches() — 转成 StatePatch[] (补 id)
 * 3. 可选持久化 (stateManager.commitChatState)
 *
 * 🔴 2026-08-02 批量: request.markers（数组）存在时一次生成全部（调用次数 N → 1）；
 * 仅 request.marker（单个）时为旧路径（兼容测试与单请求场景）。
 */
export async function runItemGenChain(
  request: ItemGenChainRequest,
  deps: ItemGenChainDeps,
): Promise<ItemGenChainResult> {
  // Step 1: 调 item_gen Agent
  const itemOutput = await callItemGenForRequest(request, deps);

  // Step 2: 转成 patches（owner 来自 marker.attributes.owner，缺省取 context 玩家名；#6 player_1 灭绝）。
  // 🔴 批量路径: itemOutput 是整批 item_gen 的一次性结果，**只 build 一次**（在 markers 里循环
  // build 会重复 N 份 patches —— 10 个 marker 就把 5 技能 4 装备重复 10 遍）。
  // 批量假定所有 marker 同一 owner（request_dispatcher 开局通常全归主角）；
  // 跨角色多 owner 的精细分流属未来增强，当前场景不触及。
  const markers = request.markers?.length
    ? request.markers
    : request.marker
      ? [request.marker]
      : [];
  const playerName = request.context.characters?.find((c) => c.type === 'player')?.name;
  const firstMarker = markers[0];
  const characterId = firstMarker?.attributes.owner ?? playerName;
  if (!characterId) {
    console.warn(
      '[item-gen-chain] 无 owner 且无玩家角色，跳过该 item_gen_request:',
      firstMarker?.bodyText.slice(0, 50),
    );
    return { patches: [], itemOutput: EMPTY_ITEM_OUTPUT };
  }
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
 * 把 markers 打包成 `<item_requests>` XML（纯函数，便于单测）。
 * 🔴 2026-08-02 批量: N 个 marker → N 个 `<request>` 子元素，item_gen 一次生成全部。
 */
export function buildItemRequestsXML(markers: ItemGenRequestMarker[]): string {
  const requestLines: string[] = ['<item_requests>'];
  for (const marker of markers) {
    const itemType = marker.attributes.itemType ?? 'equipment';
    const slotAttr =
      itemType === 'equipment' ? ` slot="${guessSlot(marker.bodyText, itemType)}"` : '';
    requestLines.push(`  <request type="${itemType}"${slotAttr}>`);
    requestLines.push(`    ${marker.bodyText.trim()}`);
    requestLines.push(`  </request>`);
  }
  requestLines.push('</item_requests>');
  return requestLines.join('\n');
}

/**
 * 调用 item_gen Agent — 生成物品/技能/装备。
 *
 * 将 marker（单个或批量）的描述包成 <item_requests> 注入 item_gen 模板的 {{ITEM_REQUEST}}
 * 占位符。agentOutputs['story'] 传正文，供 item_gen 参考（与 char/craft 链一致）。
 * Agentic 路径 (function calling) 优先，回退到普通 chat。
 *
 * 🔴 2026-08-02 批量: 传入多个 markers 时一次打包所有 <request>（item_gen 模板契约
 * 「N 个 <request> = N 个输出条目」），调用次数从 N → 1。
 */
async function callItemGenForRequest(
  request: ItemGenChainRequest,
  deps: ItemGenChainDeps,
): Promise<ItemGenOutput> {
  // 批量优先：request.markers 存在 → 打包全部；否则退单个 marker
  const markers = request.markers?.length
    ? request.markers
    : request.marker
      ? [request.marker]
      : [];
  const itemRequestsXML = buildItemRequestsXML(markers);

  const itemLocalParams: Record<string, string> = {
    ITEM_REQUEST: itemRequestsXML,
    // 独立链没有 char_gen / craft_gen 上游，留空注释给 item_gen 提示
    CHAR_GEN_RESULT:
      '（无 — 本次为 request_dispatcher 直接触发的独立物品生成，参考上方 <物品需求>）',
    CRAFT_RESULT: '',
  };

  return callItemGenRaw(request, deps, itemLocalParams);
}

/**
 * 调 item_gen 的公共执行体（独立链与重铸链共用，避免两处各抄一份 Agentic 调用）。
 * localParams 由调用方决定（独立链填 ITEM_REQUEST，重铸链填 REWRITE_TARGET/REWRITE_REASON）。
 */
async function callItemGenRaw(
  request: {
    context: AgentContext;
    endpoint: ApiEndpoint;
    saveId: string;
    configs?: import('./types').AgentConfig[];
    worldBooks?: import('./types').WorldBook[];
    presets?: import('./types').AgentPreset[];
    storyOutput: string;
  },
  deps: ItemGenChainDeps,
  localParams: Record<string, string>,
): Promise<ItemGenOutput> {
  // 构建 item_gen 上下文 — agentOutputs['story'] 传正文，对标 char/craft 链
  const contextWithStory: AgentContext = {
    ...request.context,
    agentOutputs: new Map([['story', request.storyOutput]]),
  };

  try {
    // 真机修(2026-07-17): configs/worldBooks/presets 透传 — 此前恒 undefined（systemPrompt 退化 stub）
    const messages = await buildAgentMessagesAsync(
      'item_gen',
      contextWithStory,
      request.configs,
      request.worldBooks,
      request.presets,
      localParams,
    );
    if (!messages || messages.length === 0) {
      // item_gen 模板找不到 / 产出空 messages 时返回空，不阻塞主流程
      // （避免空 messages 打 API 触发 HTTP 400 "missing field messages"）
      return EMPTY_ITEM_OUTPUT;
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
      return EMPTY_ITEM_OUTPUT;
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

  return EMPTY_ITEM_OUTPUT;
}

/**
 * 从 ItemGenOutput 构建 StatePatch 列表（M3: 零 id 生成，装备单 add_item 含 equippedSlot）。
 *
 * 生成的 patches:
 * - add_item: inventory 物品 + equipment 装备（直接带 equippedSlot，不再两步落库）
 * - add_skill: skills
 *
 * M3 重写要点:
 * - 废除 add_item+equip_item 两步模式 — 装备直接产 add_item {..., equippedSlot: normalizeSlot(slot)}
 * - 废除 id 生成（itemgen_eq_/inv_/skill_ 前缀）
 * - owner 解析: marker.attributes.owner ?? context 玩家名（'player_1' 假 id 灭绝 #6）
 */
export function buildItemGenPatches(itemOutput: ItemGenOutput, characterId: string): StatePatch[] {
  const patches: StatePatch[] = [];

  // 1. 装备 → add_item（M3: 带 equippedSlot 单 patch 落库，不再 add+equip 两步）
  for (const equip of itemOutput.equipment) {
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        name: equip.name,
        description: equip.description,
        quantity: 1,
        type: '装备',
        rarity: equip.quality,
        equippedSlot: normalizeSlot(equip.slot), // M3: slot 归一化，null=留背包
        stats: equip.stats,
        durability: equip.durability,
        maxDurability: equip.durability,
        // 🔴 2026-08-02 修: 透传 item_gen 的战斗声明 —— 此前只落 stats/durability，
        //   解析出来的 modifiers/automata/effects/scripts 全被丢弃，前端「战斗修正」恒空。
        //   S4 (2026-08-01) 语义: 装备的 modifier/automaton 编译进 v3 战斗 activeEffects。
        ...(equip.effects && Object.keys(equip.effects).length > 0
          ? { effects: equip.effects }
          : {}),
        ...(equip.scripts && Object.keys(equip.scripts).length > 0
          ? { scripts: equip.scripts }
          : {}),
        ...(equip.modifiers?.length ? { modifiers: equip.modifiers } : {}),
        ...(equip.buffs?.length ? { buffs: equip.buffs } : {}),
        ...(equip.divinity !== undefined ? { divinity: equip.divinity } : {}),
        ...(equip.automata?.length ? { automata: equip.automata } : {}),
      },
      metadata: { source: 'item_gen', kind: 'equipment' },
    });
  }

  // 2. 背包物品 → add_item
  for (const inv of itemOutput.inventory) {
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        name: inv.name,
        description: inv.description,
        quantity: inv.quantity,
        type: inv.type,
        rarity: inv.rarity,
        // 🔴 同上: 透传战斗声明
        ...(inv.effects && Object.keys(inv.effects).length > 0 ? { effects: inv.effects } : {}),
        ...(inv.scripts && Object.keys(inv.scripts).length > 0 ? { scripts: inv.scripts } : {}),
        ...(inv.modifiers?.length ? { modifiers: inv.modifiers } : {}),
        ...(inv.buffs?.length ? { buffs: inv.buffs } : {}),
        ...(inv.divinity !== undefined ? { divinity: inv.divinity } : {}),
        ...(inv.automata?.length ? { automata: inv.automata } : {}),
      },
      metadata: { source: 'item_gen', kind: 'inventory' },
    });
  }

  // 3. 技能 → add_skill
  for (const skill of itemOutput.skills) {
    patches.push({
      op: 'add_skill',
      target: `characters.${characterId}`,
      value: {
        name: skill.name,
        description: skill.description,
        type: skill.type,
        cost: skill.cost,
        cooldown: skill.cooldown,
        effects: skill.effects,
        scripts: skill.scripts,
        // 🔴 同上: 透传战斗声明（S4 生产检定 modifier 在此落库，craft_check/settle 消费）
        ...(skill.modifiers?.length ? { modifiers: skill.modifiers } : {}),
        ...(skill.buffs?.length ? { buffs: skill.buffs } : {}),
        ...(skill.divinity !== undefined ? { divinity: skill.divinity } : {}),
        ...(skill.automata?.length ? { automata: skill.automata } : {}),
        // 🆕 skillPower 链路修复 (2026-08-04 漏网 2026-08-12): 主体威力三字段透传。
        //    0694453 只修了 char_gen 链路的 assembleCharacterState，本链（request_dispatcher →
        //    item_gen → add_skill）的 patch 漏了这三字段 → 开局初始技能（火球术等）落库后
        //    skillPower/relevantAttribute/damageType 全丢 → characterToCombatParticipant 按
        //    typeof skillPower === 'number' 过滤踢出 activeSkills → 战斗兜底 0 伤害。
        //    与 assembleCharacterState（char-gen-agent.ts）的透传口径逐字段一致。
        ...(skill.skillPower !== undefined ? { skillPower: skill.skillPower } : {}),
        ...(skill.relevantAttribute ? { relevantAttribute: skill.relevantAttribute } : {}),
        ...(skill.damageType ? { damageType: skill.damageType } : {}),
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

// ========== 重铸（单条目，2026-08-24） ==========

/**
 * 把重铸输出转成「替换 patch」—— remove 旧的（按名）+ add 新的，同一次 commitChatState 原子落库。
 *
 * 🔴 只认 `replace === targetName` 的那一条（AI 在重铸模式下用它点名被替换的已知条目）；
 *    其余输出条目一律忽略（重铸是单条目手术，AI 多写的东西不该顺手落库）。
 */
export function buildRewritePatches(
  itemOutput: ItemGenOutput,
  characterId: string,
  targetName: string,
): { patches: StatePatch[]; ok: boolean; reason?: string } {
  const patches: StatePatch[] = [];
  let matched: RewriteTarget | null = null;

  for (const sk of itemOutput.skills) {
    if (sk.replace && sk.replace === targetName) {
      matched = { kind: 'skill', entry: sk };
      break;
    }
  }
  if (!matched) {
    for (const eq of itemOutput.equipment) {
      if (eq.replace && eq.replace === targetName) {
        matched = { kind: 'equipment', entry: eq };
        break;
      }
    }
  }
  if (!matched) {
    for (const inv of itemOutput.inventory) {
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
      reason: 'item_gen 未声明替换目标（replace 属性缺失或点名与目标不符）',
    };
  }

  // 1. remove 旧的（按名；技能 remove_skill，物品/装备 remove_item）
  if (matched.kind === 'skill') {
    patches.push({
      op: 'remove_skill',
      target: `characters.${characterId}`,
      value: { name: targetName },
    });
  } else {
    patches.push({
      op: 'remove_item',
      target: `characters.${characterId}`,
      value: { name: targetName },
    });
  }

  // 2. add 新的（照 buildItemGenPatches 的形状，透传全部战斗声明）
  if (matched.kind === 'skill') {
    const sk = matched.entry;
    patches.push({
      op: 'add_skill',
      target: `characters.${characterId}`,
      value: {
        name: sk.name,
        description: sk.description,
        type: sk.type,
        cost: sk.cost,
        cooldown: sk.cooldown,
        effects: sk.effects,
        scripts: sk.scripts,
        ...(sk.modifiers?.length ? { modifiers: sk.modifiers } : {}),
        ...(sk.buffs?.length ? { buffs: sk.buffs } : {}),
        ...(sk.divinity !== undefined ? { divinity: sk.divinity } : {}),
        ...(sk.automata?.length ? { automata: sk.automata } : {}),
        ...(sk.skillPower !== undefined ? { skillPower: sk.skillPower } : {}),
        ...(sk.relevantAttribute ? { relevantAttribute: sk.relevantAttribute } : {}),
        ...(sk.damageType ? { damageType: sk.damageType } : {}),
      },
      metadata: { source: 'item_gen', kind: 'skill', rewriteOf: targetName },
    });
  } else if (matched.kind === 'equipment') {
    const eq = matched.entry;
    patches.push({
      op: 'add_item',
      target: `characters.${characterId}`,
      value: {
        name: eq.name,
        description: eq.description,
        quantity: 1,
        type: '装备',
        rarity: eq.quality,
        equippedSlot: normalizeSlot(eq.slot),
        stats: eq.stats,
        durability: eq.durability,
        maxDurability: eq.durability,
        ...(eq.effects && Object.keys(eq.effects).length > 0 ? { effects: eq.effects } : {}),
        ...(eq.scripts && Object.keys(eq.scripts).length > 0 ? { scripts: eq.scripts } : {}),
        ...(eq.modifiers?.length ? { modifiers: eq.modifiers } : {}),
        ...(eq.buffs?.length ? { buffs: eq.buffs } : {}),
        ...(eq.divinity !== undefined ? { divinity: eq.divinity } : {}),
        ...(eq.automata?.length ? { automata: eq.automata } : {}),
      },
      metadata: { source: 'item_gen', kind: 'equipment', rewriteOf: targetName },
    });
  } else {
    const inv = matched.entry;
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
        ...(inv.scripts && Object.keys(inv.scripts).length > 0 ? { scripts: inv.scripts } : {}),
        ...(inv.modifiers?.length ? { modifiers: inv.modifiers } : {}),
        ...(inv.buffs?.length ? { buffs: inv.buffs } : {}),
        ...(inv.divinity !== undefined ? { divinity: inv.divinity } : {}),
        ...(inv.automata?.length ? { automata: inv.automata } : {}),
      },
      metadata: { source: 'item_gen', kind: 'inventory', rewriteOf: targetName },
    });
  }

  return { patches, ok: true };
}

/**
 * 单条目重铸：以条目当前数据 + 玩家描述为输入，调 item_gen 重新编写该条目，
 * 然后 remove 旧的 + add 新的（同一次 commitChatState，原子）。
 *
 * 🔴 存档安全：零 id 变更（按名寻址）、remove+add 同一事务、失败不阻断（返回 ok:false + reason）。
 *    玩家随时可用既有快照回退（每回合自动打快照）。
 */
export async function rewriteLoadoutItem(
  request: RewriteLoadoutRequest,
  deps: ItemGenChainDeps,
): Promise<RewriteLoadoutResult> {
  const targetName = request.target.entry.name;
  const localParams: Record<string, string> = {
    // 重铸模式：<物品需求> 给一句意图说明（重铸的主输入是 <重铸目标> / <重铸原因>）
    ITEM_REQUEST: `重铸模式：请重写条目「${targetName}」，输出对应条目并在其上带 replace="${targetName}" 属性声明替换。`,
    REWRITE_TARGET: JSON.stringify(request.target.entry, null, 2),
    REWRITE_REASON: request.userDescription ?? '',
    CHAR_GEN_RESULT: '',
    CRAFT_RESULT: '',
  };

  const itemOutput = await callItemGenRaw(
    { ...request, storyOutput: request.storyOutput ?? '' },
    deps,
    localParams,
  );

  const r = buildRewritePatches(itemOutput, request.characterId, targetName);
  if (!r.ok) return { ok: false, patches: [], itemOutput, reason: r.reason };

  if (deps.stateManager && r.patches.length > 0) {
    await deps.stateManager.commitChatState(r.patches);
  }

  return { ok: true, patches: r.patches, itemOutput };
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
