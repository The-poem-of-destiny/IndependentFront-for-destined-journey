/**
 * Phase 10: Placeholder Registry — Unified Agent Template System
 *
 * 职责:
 * 1. 定义 PLACEHOLDER_REGISTRY — 16 个 {{PLACEHOLDER}} → 解析函数的映射
 * 2. getDefaultTemplate(agentId) — 为每个 Agent 返回默认模板字符串
 * 3. setPlaceholderGlobals / resetPlaceholderGlobals — 管理跨函数共享的世界书/配置数据
 *
 * 设计原则:
 * - 完全替代旧的 AgentPromptTemplate.variableContext() + variableInstruction()
 * - Agent 通过 config.template 自定义模板字符串，未设置则使用 getDefaultTemplate()
 * - 兼容旧 ST 预设的 assemblePresetContent()（preset-loader 中）
 * - 模板解析由 template-resolver.ts 的 resolveTemplate() 负责（支持 localParams 注入链占位符）
 *
 * 可见性规则:
 * - NARRATIVE 使用 defaultHistoryLayers / defaultHistorySlice（从 agent-templates 导入）
 * - CHARACTER_STATE 使用 buildZoneContext + filterZoneContent（从 context-visibility 导入）
 * - LORE_BOOK 使用 worldbook-loader 的 getEntriesForAgent / filterActiveEntries / formatWorldBookEntries
 * - formatHistory / formatCharacters / formatMemories / formatPlotEvents 等私有函数在此模块内镜像实现
 */

import type { AgentContext, AgentConfig, WorldBook, CharacterState, PlaceholderResolver } from './types';
import { getEntriesForAgent, filterActiveEntries, formatWorldBookEntries } from './worldbook-loader';
import { parseSetvars, resolveGetvars, resolveRandoms } from './preset-loader';
import { buildZoneContext, filterZoneContent, getAgentZoneVisibility } from './context-visibility';
import { defaultHistoryLayers, defaultHistorySlice } from './agent-templates';

// ═══════════════════════════════════════════════════════════
// Module-Level Globals
// ═══════════════════════════════════════════════════════════

let _worldBooks: WorldBook[] = [];
let _configs: AgentConfig[] = [];

export function setPlaceholderGlobals(worldBooks: WorldBook[], configs: AgentConfig[]): void {
  _worldBooks = worldBooks;
  _configs = configs;
}

export function resetPlaceholderGlobals(): void {
  _worldBooks = [];
  _configs = [];
}

// ═══════════════════════════════════════════════════════════
// Private Formatting Helpers (mirror functions from agent-templates.ts)
// ═══════════════════════════════════════════════════════════

/** Mirror of agent-templates.ts formatCharacters (private, not exported) */
function formatCharacters(ctx: AgentContext): string {
  if (!ctx.characters?.length) return '';
  return ctx.characters.map(c =>
    `[${c.type}:${c.name}] Lv.${c.level} ${c.tierName} | HP:${c.hp}/${c.maxHp} MP:${c.mp}/${c.maxMp} | 位置:${c.location} | ${c.currentAction || '待机中'}`
  ).join('\n');
}

/** Mirror of agent-templates.ts formatMemories (private, not exported) */
function formatMemoriesEntries(ctx: AgentContext, topK?: number): string {
  const memories = ctx.memories ?? [];
  if (memories.length === 0) return '';
  const sliced = topK && topK > 0 ? memories.slice(0, topK) : memories;
  return sliced.map(m =>
    `[${m.id}] ${m.timeRange.start}~${m.timeRange.end} | 重要度:${m.importance}\n正文: ${m.content.slice(0, 300)}`
  ).join('\n---\n');
}

/** Mirror of agent-templates.ts formatPlotEvents (private, not exported) */
function formatPlotEventsEntries(ctx: AgentContext): string {
  const events = ctx.plotEvents ?? [];
  if (events.length === 0) return '';
  return events
    .filter(e => e.status === 'active' || e.status === 'pending')
    .map(e => `[${e.id}] ${e.title} (${e.status})\n${e.description.slice(0, 200)}`)
    .join('\n---\n');
}

// ═══════════════════════════════════════════════════════════
// Placeholder Registry
// ═══════════════════════════════════════════════════════════

export const PLACEHOLDER_REGISTRY: Record<string, PlaceholderResolver> = {

  // ---- Global Placeholders (10) ----

  /** {{SYS_PROMPT}} — Agent 的 systemPrompt，来自 agent-config.json */
  'SYS_PROMPT': (ctx, config, _params) => {
    return config.systemPrompt || '';
  },

  /** {{LORE_BOOK}} — 世界书条目过滤+格式化 */
  'LORE_BOOK': (ctx, config, params) => {
    if (_worldBooks.length === 0 || _configs.length === 0) return '';
    const agentId = config.agentId || '';
    const entries = getEntriesForAgent(agentId, _configs, _worldBooks);
    if (entries.length === 0) return '';
    const activeEntries = filterActiveEntries(entries);
    let formatted = formatWorldBookEntries(activeEntries);
    // 真机修(2026-07-18): 原 ST 角色卡世界书正文自带 {{setvar/getvar/random}} 宏（MVU 机制遗留）
    // → 注入前收集 setvar 变量表并剥离定义、替换 getvar 引用、解析 random——
    //   世界书内自洽的 setvar/getvar 对仍正常工作，孤立宏不再作为噪音喂给 AI（实测 story 系统消息含 25+36 处残留）
    const { variables: wbVars, stripped } = parseSetvars(formatted);
    formatted = resolveRandoms(resolveGetvars(stripped, wbVars));
    if (params?.limit) {
      const limit = parseInt(params.limit, 10);
      if (!isNaN(limit) && limit > 0) {
        return formatted.slice(0, limit);
      }
    }
    return formatted;
  },

  /** {{NARRATIVE}} — 格式化最近对话历史，支持 layers 参数（:slice 已废弃，再不截断） */
  'NARRATIVE': (ctx, config, params) => {
    const agentId = config.agentId || '';
    const layers = params?.layers ? parseInt(params.layers, 10) : defaultHistoryLayers(agentId);
    if (layers <= 0 || !ctx.history?.length) return '';
    const maxMessages = layers * 2;
    return ctx.history.slice(-maxMessages)
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');
  },

  /** {{USER_INPUT}} — 本轮用户输入 */
  'USER_INPUT': (ctx, _config, _params) => {
    return ctx.userInput || '';
  },

  /** {{CHARACTER_STATE}} — 角色状态，通过 zone 系统格式化 */
  'CHARACTER_STATE': (ctx, config, _params) => {
    const agentId = config.agentId || '';
    const zones = buildZoneContext(ctx);
    const npcZone = zones.npc;
    if (!npcZone) return '';
    const visibility = getAgentZoneVisibility(agentId).npc;
    if (visibility === 'NONE') return '';
    return filterZoneContent('npc', npcZone.content, visibility, agentId, ctx) || '';
  },

  /** {{INVENTORY}} — 遍历所有角色的背包物品 */
  'INVENTORY': (ctx, _config, _params) => {
    const characters = ctx.characters ?? [];
    if (characters.length === 0) return '';
    const lines: string[] = [];
    for (const char of characters) {
      const inv = char.inventory ?? [];
      if (inv.length === 0) continue;
      lines.push(`[${char.name}] 背包:`);
      for (const item of inv) {
        const rarityStr = item.rarity ? `, ${item.rarity}` : '';
        const typeStr = item.type ? ` (${item.type}${rarityStr})` : '';
        const desc = item.description ? ` — ${item.description}` : '';
        lines.push(`  ${item.name} ×${item.quantity}${typeStr}${desc}`);
      }
    }
    return lines.join('\n');
  },

  /** {{QUEST_STATE}} — 当前所有任务 (Phase 10g) */
  'QUEST_STATE': (ctx, _config, _params) => {
    const quests = ctx.quests ?? {};
    const entries = Object.entries(quests);
    if (entries.length === 0) return '(无任务)';
    const lines: string[] = [];
    for (const [name, q] of entries as [string, any][]) {
      const parts: string[] = [`  [${name}]`, `状态:${q.status || '—'}`, `优先级:${q.priority || '—'}`];
      if (q.objective) parts.push(`目标:${q.objective}`);
      if (q.progress) parts.push(`进度:${q.progress}`);
      if (q.detail) parts.push(`详情:${q.detail}`);
      if (q.reward) parts.push(`奖励:${q.reward}`);
      lines.push(parts.join(' | '));
    }
    return lines.join('\n');
  },

  /** {{GAME_TIME}} — 从 variables 中提取时间/位置/天气/纪元等世界键 */
  'GAME_TIME': (ctx, _config, _params) => {
    const vars = ctx.variables ?? {};
    const worldKeys = [
      '时间', 'time', 'timeOfDay',
      '位置', 'location', 'currentRegion', 'currentFaction',
      '天气', 'weather',
      '季节', 'season',
      '月相', 'moonPhase',
      '纪元', 'era',
      'dangerLevel',
    ];
    const parts: string[] = [];
    for (const k of worldKeys) {
      if (vars[k] != null) {
        parts.push(`${k}: ${vars[k]}`);
      }
    }
    return parts.join('\n');
  },

  /** {{ACTIVE_EFFECTS}} — 提取所有角色的状态效果 */
  'ACTIVE_EFFECTS': (ctx, _config, _params) => {
    const characters = ctx.characters ?? [];
    if (characters.length === 0) return '';
    const lines: string[] = [];
    for (const char of characters) {
      const effects = char.statusEffects ?? [];
      if (effects.length === 0) continue;
      const effectDescs = effects.map(e => {
        const timeStr = e.remainingTime != null ? ` (剩余${e.remainingTime}${e.timeUnit || '分钟'})` : ' (永久)';
        return `${e.name}[${e.category}]${timeStr} — ${e.description || ''}`;
      });
      lines.push(`[${char.name}] 状态效果: ${effectDescs.join('; ')}`);
    }
    return lines.join('\n');
  },

  /** {{MEMORY_ENTRIES}} — 格式化记忆列表，支持 top_k 参数 */
  'MEMORY_ENTRIES': (ctx, _config, params) => {
    const topK = params?.top_k ? parseInt(params.top_k, 10) : undefined;
    const formatted = formatMemoriesEntries(ctx, topK);
    if (!formatted) return '';
    const header = topK && topK > 0
      ? `**记忆库 (最近 ${topK} 条):**\n${formatted}`
      : `**记忆库:**\n${formatted}`;
    return header;
  },

  /** {{PLOT_EVENTS}} — 格式化剧情事件（仅 active + pending） */
  'PLOT_EVENTS': (ctx, _config, _params) => {
    const formatted = formatPlotEventsEntries(ctx);
    if (!formatted) return '';
    return `**活跃剧情事件:**\n${formatted}`;
  },

  // ---- Agent Communication Placeholders (6) ----
  // 多 Agent 间通过 agentOutputs Map 传递输出。输出可能是字符串或对象（如 memory_recall embedding 路径返回 { memories: [...] }）。
  // 对象 → JSON.stringify，字符串 → 原样返回，避免隐式 String(obj) 产生 "[object Object]"。

  /** {{AGENT.MEMORY_RECALL}} */
  'AGENT.MEMORY_RECALL': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('memory_recall');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.PLOT_PRE_CHECK}} */
  'AGENT.PLOT_PRE_CHECK': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('plot_pre_check');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.STORY}} */
  'AGENT.STORY': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('story');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.VARS_UPDATE}} */
  'AGENT.VARS_UPDATE': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('vars_update');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.MEMORY_SUMMARY}} */
  'AGENT.MEMORY_SUMMARY': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('memory_summary');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.REQUEST_DISPATCHER}} — request_dispatcher 调度器输出 */
  'AGENT.REQUEST_DISPATCHER': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('request_dispatcher');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  // ---- Chain Communication Placeholders (5) (localParams injected) ----
  'CRAFT_REQUEST': (_ctx, _config, _params) => '',
  'CHAR_DETECT': (_ctx, _config, _params) => '',
  'ITEM_REQUEST': (_ctx, _config, _params) => '',

  /** {{CHAR_GEN_RESULT}} — char_gen 输出 (从 agentOutputs 读取) */
  'CHAR_GEN_RESULT': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('char_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{CRAFT_RESULT}} — craft_gen 输出 (从 agentOutputs 读取) */
  'CRAFT_RESULT': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('craft_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },
};

// ═══════════════════════════════════════════════════════════
// Default Templates (per Agent)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TEMPLATES: Record<string, string> = {
  story: '{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n{{AGENT.PLOT_PRE_CHECK}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{GAME_TIME}}\n{{NARRATIVE}}\n{{USER_INPUT}}',
  memory_recall: '{{SYS_PROMPT}}\n{{MEMORY_ENTRIES}}\n{{NARRATIVE:layers=3}}\n{{USER_INPUT}}',
  // Phase 10 结构化（2026-07-20）: XML 分区 + 注释三要素 + 缓存排序。
  // {{PLOT_EVENTS}} 在管线中被 buildAgentMessages 的 localParams 覆盖为富上下文块
  // （<剧情大纲>+<剧情事件列表>+<当前状态>，见 agent-templates.ts buildPlotContextBlock）。
  plot_pre_check: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你判断剧情触发所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件——含尚未向玩家揭示的 hidden 事件，\n     防剧透只在 UI 层，你必须全量审视)、<当前状态>(时间/位置/主角层级一行摘要)。\n     这是你触发判断的唯一事件来源——triggeredEvents 的 title 必须与 <剧情事件列表> 逐字一致。\n     区块为空或缺大纲时（如支线模式初期）以现有内容为准，保守判断，不编造事件。-->\n\n<记忆召回>\n{{AGENT.MEMORY_RECALL}}\n</记忆召回>\n<!-- 上游记忆召回 Agent 给出的相关历史记忆。用于核对触发条件中的历史前提\n     （如「与铁匠建立信任之后」）。为空表示本轮无相关记忆——缺证据时按条件未满足处理。-->\n\n<最近对话>\n{{NARRATIVE:layers=3}}\n</最近对话>\n<!-- 🔴 每轮变化。最近 3 轮正文与玩家输入。评估证据强度时它是第二优先级——\n     低于本轮 <用户输入> 的明确行动，高于 <记忆召回> 中的旧线索。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言——触发判断的首要证据来源。-->',
  request_dispatcher: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成变量调度所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     判断角色种族和势力归属时参考此处。——稳定数据，优先查阅。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 当前存档中所有已有角色的列表（ID/Name/Race/Type/Tier/Location）。\n     这是你判断\"新角色 vs 已有角色\"的唯一依据——\n     角色名不在此表中 → 新角色 → <char_gen_request>；\n     角色名在此表中 → 已有角色 → <char_update_request>。-->\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n<!-- 所有角色背包中的物品、装备、材料清单。\n     这是你判断\"新物品 vs 已有物品\"的唯一依据——\n     物品名不在背包中 → 新物品 → <item_gen_request>；\n     物品名在背包中 → 已有物品 → <item_update_request>。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n<!-- 🔴 高频变化：本回合 Story Agent 生成的叙事正文。\n     仔细阅读全文，从中提取所有变量变化、新角色/物品出现、制作场景。——这是你的核心输入。-->',
  vars_update: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你更新角色/物品状态的完整上下文数据。       -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。         -->\n<!-- ⚠️ 需要写脚本时调用 get_script_reference 工具。     -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n\n<调度器输出>\n{{AGENT.REQUEST_DISPATCHER}}\n</调度器输出>\n<!-- request_dispatcher 的完整输出，包含 <char_update_request> 和 <item_update_request> 标签。\n     逐条读取每个标签，这是你需要处理的变更清单。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n\n<最近对话>\n{{NARRATIVE:layers=1}}\n</最近对话>',
  memory_summary: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{NARRATIVE:layers=4}}',
  // Phase 10 结构化（2026-07-20）: 同 plot_pre_check，{{PLOT_EVENTS}} 由 localParams 覆盖为富上下文块。
  plot_post_check: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你审视世界线与事件状态所需的完整上下文。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件)、<当前状态>(时间/位置/主角层级)。\n     eventUpdates 与 newChildEvents.parentTitle 只能引用 <剧情事件列表> 中逐字一致的标题；\n     世界线偏离程度以 <剧情大纲> 的预设走向为标尺。区块缺大纲时以事件列表为准，保守判断。-->\n\n<角色状态>\n{{CHARACTER_STATE}}\n</角色状态>\n<!-- 场景中角色的状态快照(层级/资源/位置等)。用于佐证事件完成/失败的客观后果\n     （如关键角色死亡 → 相关事件 fail）。以区块内容为准，缺失时不做推断。-->\n\n<最近对话>\n{{NARRATIVE:layers=4}}\n</最近对话>\n<!-- 最近 4 轮对话历史（不含本轮正文）。提供剧情连续性——判断世界线是否偏离时\n     结合前几轮走向一起看，避免把连续铺垫误判为突发变动。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言，与 <本轮正文> 对照理解玩家意图与选择后果。-->\n\n<本轮正文>\n{{AGENT.STORY}}\n</本轮正文>\n<!-- 🔴 每轮变化。本回合正文 AI 的完整输出——你审视的核心对象。\n     事件完成/失败、世界线变动的一切判断都必须以此处的直接证据为准。-->\n\n<本轮记忆总结>\n{{AGENT.MEMORY_SUMMARY}}\n</本轮记忆总结>\n<!-- 🔴 每轮变化。记忆总结 Agent 对本轮的压缩记录(含暗线线索)。\n     辅助你快速把握本轮要点；与 <本轮正文> 冲突时以正文为准。-->',
  plot_outline: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成剧情大纲所需的完整上下文。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<角色背景>\n{{CHARACTER_STATE}}\n</角色背景>\n<!-- 主角的种族/血脉/层级/属性/身份/背景故事/装备/技能/命定核心。\n     所有剧情必须以主角为核心展开——章节和事件的推动力必须来自主角的选择和成长。\n     不能偏成 NPC 传、世界观说明书或编年史。\n     以区块实际内容为准；缺字段时不做推断。-->\n\n<剧情配置>\n{{PLOT_EVENTS}}\n</剧情配置>\n<!-- 🔴 引擎注入的剧情配置（非事件列表）。由 create-store 通过 localParams 覆盖。\n     包含：模式(main=主线/side=支线)、持续年份、难度层级(T1-T7)、剧情偏向(战斗/解密/人际/恋爱/探索/政治/生存/悲剧)、\n     自定义偏好、是否允许世界书外NPC、专注区域(支线模式)、雷点(绝对禁止级)。\n     雷点优先级高于一切剧情偏好——绝对禁止生成雷点描述的任何内容。\n     区块为空时：默认 off 模式，不做推断。-->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n<!-- 当前激活的世界书条目。涵盖势力/地理/种族/文化/组织/行业/怪物生态。\n     大纲的势力冲突、地理锚点、文化背景必须以此为准。\n     区块为空时以通用奇幻设定为准，不凭空发明势力名/地名。-->\n\n<用户指令>\n{{USER_INPUT}}\n</用户指令>\n<!-- 🔴 每轮变化。初始生成 → "请根据以上信息生成剧情大纲" + 角色摘要；\n     修改模式 → 用户修改要求 + 上一版大纲完整 JSON。-->',
  // Phase 10 结构化模板：XML 分区 + 注释 + 缓存优化排序（稳定在上，动态在下）
  craft_gen: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成制作任务所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力关系、地理信息、行业规范等。\n     制作产物的外观描述、材质选择、工艺风格应与当前世界观保持一致。\n     例如：诺斯加德地区的锻造工艺偏向实用粗犷，而赛瑞利亚的炼金术精于优雅调配。-->\n\n<制作者状态>\n{{CHARACTER_STATE}}\n</制作者状态>\n<!-- 制作者及场景中其他角色的完整状态：基础属性(力量/智力/敏捷/精神)、当前HP/MP/SP、\n     等级与层级、已装备物品、已习得技能。制作准备阶段优先查阅此处获取核心属性值和层级信息，\n     以判断是否满足目标品质的层级封顶。若数据不足以完成检定，再调用 get_character 补充。-->\n\n<可用材料>\n{{INVENTORY}}\n</可用材料>\n<!-- 所有角色背包中的物品清单(材料/消耗品/装备等)。先查阅此处确认可用材料的种类和数量，\n     判断材料是否满足品质继承规则(至少2种同品质投入物)。若数据不完整再调用 get_inventory 补充。-->\n\n<本次制作需求>\n{{CRAFT_REQUEST}}\n</本次制作需求>\n<!-- 从正文 <craft_request> 标记中提取的制作需求。包含用户期望制作的物品、目标品质、行业类型、\n     预期效果描述等。这是你执行制作的核心依据——仔细阅读用户的需求，作为产物设计的起点。-->\n\n<当前剧情>\n{{NARRATIVE:layers=1}}\n</当前剧情>\n<!-- 最近的对话历史。帮助你理解制作发生的场景和上下文——在铁匠铺锻造与在篝火边修理，\n     叙事描写方式截然不同。制作叙事应与当前剧情场景自然衔接。-->',
  char_gen: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成角色所需的完整上下文数据。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖种族特性、血脉能力、势力关系、地理信息等。\n     角色外观、种族、文化背景、命名风格应与世界观保持一致。\n     例如：萨赫拉联邦多见黑发金瞳的沙漠血统，诺斯加德地区以金发碧眼为主。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 场景中所有已有角色的状态快照。第一步先查阅此处——检查是否存在同名角色，\n     若同名已有角色存在则直接复用其数据，不调用随机工具。\n     同时判断新角色与已有角色之间是否存在潜在的血缘、势力或社交关系。\n     若列表不完整需要查重，再调用 get_character 补充。-->\n\n<当前剧情场景>\n{{NARRATIVE:layers=1}}\n</当前剧情场景>\n<!-- 最近的对话历史。帮助你理解角色出场时的场景氛围——在酒馆偶遇、战场上对峙、\n     还是森林中邂逅，角色的外貌/装备/性格设定应贴合出场情境。-->\n\n<新角色描述>\n{{CHAR_DETECT}}\n</新角色描述>\n<!-- 从正文 <char_detect> 标记中提取的新角色描述，包含角色名、类型(npc/enemy/ally)、\n     外貌特征、行为表现、可能的背景线索。这是你生成角色的核心依据——\n     正文已明确的特征不要用随机工具覆盖，只用工具填充未提及的部分。-->',
  item_gen: '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成物品/技能/装备所需的完整上下文。  -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     装备名和技能名应符合对应的文化和审美风格，品质描述统一使用7级体系。-->\n\n<可用物品库>\n{{INVENTORY}}\n</可用物品库>\n<!-- 所有角色背包中已有的物品、装备、材料清单。生成新物品时注意不与已有物品重复，\n     同时确保新装备的强度不会碾压已有装备，保持数值合理递增。-->\n\n<角色生成结果>\n{{CHAR_GEN_RESULT}}\n</角色生成结果>\n<!-- char_gen 输出的完整角色数据，包含 <skill_requests>/<equipment_requests>/<item_requests>\n     以及 <ascension> 登神长阶块（如有）。每个 <request> 中含需求描述和理由——\n     仔细阅读每一个 request，理解需求背后的角色定位，再开始编写。\n     若需要补充查询角色详细属性，调用 get_character。-->\n\n<制作结果>\n{{CRAFT_RESULT}}\n</制作结果>\n<!-- craft_gen 输出的制作结果，包含 <item_requests>。\n     仅在制作品质链中触发——为制作产物编写具体数值。未触发制作时此区块为空。-->\n\n<物品需求>\n{{ITEM_REQUEST}}\n</物品需求>\n<!-- 从 <item_requests> 中提取的具体需求列表。每个 <request> 对应一个需要编写的条目。\n     request 中的自然语言描述是唯一的需求来源——不要自行增减条目或改变需求方向。\n     注意区分来源：char_gen 的角色物品 vs craft_gen 的制作产物。-->',
};

/** Get the default template for a given agent, or empty string if unknown */
export function getDefaultTemplate(agentId: string): string {
  return DEFAULT_TEMPLATES[agentId] || '';
}
