/**
 * Agent Prompt 模板系统 — Phase 10 简化版
 *
 * Phase 10 变更:
 * - fixedSystem + fixedExamples 缩减为最小存根（约一行中文描述）
 * - variableContext + variableInstruction 返回空字符串
 * - 完整提示词存放位置:
 *   - Story Agent: agent-config.json 的 preset → assemblePresetContent()
 *   - 其他 Agent: agent-config.json 的 systemPrompt 字段
 *   - 未来: placeholder-registry 的 {{PLACEHOLDER}} 模板
 *
 * 使用方式:
 *   const tpl = getAgentTemplate(agentId);
 *   const messages = buildAgentMessages(agentId, ctx, configs, worldBooks, presets);
 */

import type { AgentPromptTemplate, AgentContext, AgentConfig, AgentPreset, WorldBook } from './types';
import { getEntriesForAgent, filterActiveEntries, formatWorldBookEntries } from './worldbook-loader';
import { getPreset, assemblePresetContent } from './preset-loader';
import { buildZoneSection, buildZoneContext } from './context-visibility';

// ========== 通用工具 ==========

/**
 * Phase 8.6: 各 Agent 历史注入（最近几轮 user+ai 对）的默认值。
 * 由 buildAgentMessages 调用 formatHistory 时，优先读 ctx.agentConfig.historyLayers；
 * AgentConfig 未设该字段则回退到这里。层数 N → 注入最近 N*2 条消息（user/ai 一对）。
 */
export function defaultHistoryLayers(agentId: string): number {
  switch (agentId) {
    case 'story':            return 6;   // 正文 AI, 主上下文, 注入较多轮
    case 'memory_summary':   return 4;   // 记忆总结需看连续剧情
    case 'plot_post_check':  return 4;   // 剧情/世界线需连续上下文
    case 'plot_outline':     return 3;
    case 'memory_recall':    return 3;
    // 后置抽取型: 原本不看历史, 8.6 默认给 1 轮上轮辅助上文, 可配 0 关闭
    case 'vars_update':
    case 'char_update':
    case 'char_gen':
    case 'item_gen':
    case 'craft_gen':        return 1;
    default:                 return 2;
  }
}

/**
 * Phase 8.6: 各 Agent 每条历史正文截断字数的默认值。
 * 长正文 agent (story/memory_summary) 给较大值, 后置抽取型给中等值。
 */
export function defaultHistorySlice(agentId: string): number {
  switch (agentId) {
    case 'story':
    case 'memory_summary':   return 1500;
    case 'plot_post_check':
    case 'plot_outline':
    case 'memory_recall':    return 1000;
    // 后置型历史是辅助上文, 不必太长
    case 'vars_update':
    case 'char_update':
    case 'char_gen':
    case 'item_gen':
    case 'craft_gen':        return 800;
    default:                 return 800;
  }
}

/**
 * 格式化最近对话历史。层数 N → 注入最近 N*2 条 user/ai 消息；每条按 historySlice 截断。
 * 优先读 ctx.agentConfig.historyLayers/historySlice（per-agent 可配），回退到默认值。
 * ctx.agentConfig 可能为空（非 buildAgentMessages 路径, 如测试）, 此时代理 agentId 由 _proxyAgentId 提供。
 */
function formatHistory(ctx: AgentContext): string {
  const agentId = ctx.agentConfig?.agentId ?? (ctx as any)._proxyAgentId ?? '';
  const layers = ctx.agentConfig?.historyLayers ?? defaultHistoryLayers(agentId);
  const slice = ctx.agentConfig?.historySlice ?? defaultHistorySlice(agentId);
  if (layers <= 0) return '';                        // 0 层 = 不注入
  const maxMessages = layers * 2;                    // user/ai 一对算一层
  return ctx.history.slice(-maxMessages)
    .map(m => `[${m.role}]: ${m.content.slice(0, slice)}`)
    .join('\n');
}

/**
 * Phase 8.6: 注入最近对话历史作为"辅助上文"块 (含标题)。layers<=0 时返回空串。
 * 供后置抽取型 agent (vars_update/char_update/char_gen/craft_gen/item_gen) 在 story 输出前调用,
 * 让它们除本轮 story 外还能看到上一轮上下文 (如 vars_update 能据此判断前一轮位置)。
 */
function recentHistoryBlock(ctx: AgentContext): string {
  const h = formatHistory(ctx);
  return h ? `**最近对话:**\n${h}\n\n` : '';
}

function formatCharacters(ctx: AgentContext): string {
  if (!ctx.characters?.length) return '无角色数据';
  return ctx.characters.map(c =>
    `[${c.type}:${c.name}] Lv.${c.level} ${c.tierName} | HP:${c.hp}/${c.maxHp} MP:${c.mp}/${c.maxMp} | 位置:${c.location} | ${c.currentAction || '待机中'}`
  ).join('\n');
}

function formatMemories(ctx: AgentContext): string {
  if (!ctx.memories?.length) return '暂无相关记忆';
  return ctx.memories.map(m =>
    `[${m.id}] ${m.timeRange.start}~${m.timeRange.end} | 重要度:${m.importance}\n正文: ${m.content.slice(0, 300)}`
  ).join('\n---\n');
}

function formatPlotEvents(ctx: AgentContext): string {
  if (!ctx.plotEvents?.length) return '暂无活跃剧情事件';
  return ctx.plotEvents
    .filter(e => e.status === 'active' || e.status === 'pending')
    .map(e => `[${e.id}] ${e.title} (${e.status})\n${e.description.slice(0, 200)}`)
    .join('\n---\n');
}

function formatVariables(ctx: AgentContext): string {
  const vars = ctx.variables ?? {};
  const keys = Object.keys(vars);
  if (keys.length === 0) return '暂无变量';
  return keys.map(k => `${k}: ${JSON.stringify(vars[k])}`).join('\n');
}

function formatLorebook(ctx: AgentContext): string {
  if (!ctx.lorebookMatches?.length) return '';
  return ctx.lorebookMatches
    .map(m => m.entry.content)
    .join('\n\n');
}

// ========== Agent Templates (Phase 10: Minimal Stubs) ==========
// 完整提示词存放位置:
//   - Story Agent: agent-config.json 的 preset → assemblePresetContent()
//   - 其他 Agent: agent-config.json 的 systemPrompt 字段
//   - 未来: placeholder-registry 的 {{PLACEHOLDER}} 模板
// fixedSystem/fixedExamples 仅作类型占位和 fallback 兜底,
// variableContext/variableInstruction 已迁移到 placeholder-registry 模板系统.

export const AGENT_TEMPLATES: Record<string, AgentPromptTemplate> = {

  // ---- memory_recall: 记忆召回 ----
  memory_recall: {
    fixedSystem: '记忆召回系统。你从记忆库中筛选与用户输入最相关的记忆条目，只返回真正相关的记忆，宁缺毋滥。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"memories": [{"id": "MEM000001", "relevance": 0.95, "reason": "匹配原因"}]}',
    variableContext: (ctx: AgentContext) => formatMemories(ctx) ? `**当前记忆库:**\n${formatMemories(ctx)}` : '',
    variableInstruction: (ctx: AgentContext) => `用户输入: ${ctx.userInput}\n\n请从记忆库中召回与此相关的记忆条目。`,
  },

  // ---- plot_pre_check: 剧情触发检查（正文前，Phase 4） ----
  plot_pre_check: {
    fixedSystem: '剧情触发检查系统。根据剧情大纲和当前状况，判断需要触发哪些剧情事件、需要召回哪些剧情背景信息。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"triggeredEvents": [{"id": "evt_01", "reason": "触发原因"}], "relevantBackground": "剧情背景摘要"}',
    variableContext: (ctx: AgentContext) => formatPlotEvents(ctx) ? `**活跃剧情事件:**\n${formatPlotEvents(ctx)}` : '',
    variableInstruction: (ctx: AgentContext) => `**用户输入:** ${ctx.userInput}\n\n请根据剧情大纲和当前状况，判断需要触发哪些剧情事件。`,
  },

  // ---- story: 正文 AI (核心) ----
  story: {
    fixedSystem: '命定之诗叙事引擎。你生成下一段剧情正文，输出 <maintext>/<option>/<sum>/<vars> XML。使用第二人称"你"叙事，保持世界观一致性。完整提示词见 agent-config.json 和预设系统。',
    fixedExamples: '<maintext>示例正文</maintext>\n<option>选项A\n选项B</option>\n<sum>示例总结</sum>',
    variableContext: (ctx: AgentContext) => formatLorebook(ctx) ? `**世界设定:**\n${formatLorebook(ctx)}` : '',
    variableInstruction: (ctx: AgentContext) => `**最近对话:**\n${formatHistory(ctx)}\n\n**玩家输入:** ${ctx.userInput}\n\n请生成下一段剧情。`,
  },

  // ---- vars_update: 变量更新 ----
  vars_update: {
    fixedSystem: '变量更新系统。根据正文 AI 的输出提取需要更新的变量（replace/delta/insert/delta_time）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"replace": [{"path": "位置", "value": "白曜城"}], "delta": [{"path": "金钱", "amount": -50}]}',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**正文 AI 输出:**\n${storyOutput}\n\n请提取变量变更。`;
    },
  },

  // ---- char_update: 角色更新 ----
  char_update: {
    fixedSystem: '角色状态更新系统。根据正文 AI 的输出更新角色的 HP/MP/SP/装备/技能/位置/状态效果。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"characters": [{"id": "player_1", "changes": {"hp": 80}}]}',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**正文 AI 输出:**\n${storyOutput}\n\n请提取所有角色状态变化。`;
    },
  },

  // ---- memory_summary: 记忆总结 ----
  memory_summary: {
    fixedSystem: '记忆压缩系统。每轮对话结束后将重要事件总结为结构化记忆（content/hiddenLine/keywords/importance）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"content": "详细记忆正文(>=200字)", "hiddenLine": "暗线线索", "keywords": ["关键词1", "关键词2"], "importance": 5}',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `**本轮正文 AI 输出:**\n${storyOutput}\n\n**用户输入:** ${ctx.userInput}\n\n请为本轮对话生成一条记忆记录。`;
    },
  },

  // ---- plot_post_check: 剧情修正（正文后，Phase 4） ----
  plot_post_check: {
    fixedSystem: '世界线修正系统。分析剧情发展是否导致世界线变动，判断是否需要修改剧情大纲和事件状态（minor/moderate/major）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"worldLineChanged": false, "changeLevel": "none", "outlineChanges": {"action": "none"}, "eventUpdates": []}',
    variableContext: (ctx: AgentContext) => formatPlotEvents(ctx) ? `**活跃剧情事件:**\n${formatPlotEvents(ctx)}` : '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `**本轮正文 AI 输出:**\n${storyOutput}\n\n**用户输入:** ${ctx.userInput}\n\n请分析是否有世界线变动。`;
    },
  },

  // ---- plot_outline: 大纲生成（Phase 4） ----
  plot_outline: {
    fixedSystem: '大纲生成系统。根据剧情配置、世界观设定和角色信息生成完整剧情大纲（含章节划分和自检报告JSON）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"content": "# 大纲内容...", "chapters": [{"title": "章节标题", "summary": "章节摘要"}], "selfCritique": {"score": 7}}',
    variableContext: (ctx: AgentContext) => formatCharacters(ctx) !== '无角色数据' ? `**角色信息:**\n${formatCharacters(ctx)}` : '',
    variableInstruction: (ctx: AgentContext) => `**用户输入:** ${ctx.userInput}\n\n请根据以上信息生成一份剧情大纲。`,
  },

  // ---- craft_gen: 制作效果生成 (Phase 6e, Phase 9b 重写) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <craft_result> XML（含 <item_requests> 派发 item_gen）
  craft_gen: {
    fixedSystem: '制作系统。通过 tools 调用获取真实数据生成制作结果，输出 <craft_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**正文输出 (含 <craft_request> 标记):**\n${storyOutput}${ctx.agentConfig && (ctx.agentConfig as any)._craftRequest ? '\n\n<craft_request>' + (ctx.agentConfig as any)._craftRequest + '</craft_request>' : ''}\n\n请调用工具获取真实数据，输出 <craft_result> XML。`;
    },
  },

  // ---- char_gen: 角色生成 (Phase 6e) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <char_result> XML（含 <skill_requests>/<equipment_requests>/<item_requests>）
  char_gen: {
    fixedSystem: '角色生成系统。通过 tools 调用获取真实随机值生成角色，输出 <char_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**正文输出 (含 <char_detect> 标记):**\n${storyOutput}\n\n请调用工具获取随机值，只输出 <char_result> XML。如果没有 <char_detect> 标记，输出 <char_result><error>no char_detect found</error></char_result>。`;
    },
  },

  // ---- item_gen: 物品生成 (Phase 9) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <item_result> XML
  item_gen: {
    fixedSystem: '物品生成系统。基于 char_gen 输出通过 tools 生成技能/装备/道具，输出 <item_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
    variableContext: (ctx: AgentContext) => '',
    variableInstruction: (ctx: AgentContext) => {
      const charGenOutput = ctx.agentOutputs?.get('char_gen') ?? '';
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**生成的角色的数据 (char_gen 输出):**\n${charGenOutput}\n\n**正文上下文:**\n${storyOutput}\n\n请为该角色生成合适的装备、技能和背包物品。`;
    },
  },

  // ---- v3 兼容别名: plot_check / plot_correct ----
  plot_check: {
    fixedSystem: '剧情规划系统。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
    variableContext: (_ctx: AgentContext) => '',
    variableInstruction: (_ctx: AgentContext) => '',
  },

  plot_correct: {
    fixedSystem: '剧情修正系统。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
    variableContext: (_ctx: AgentContext) => '',
    variableInstruction: (_ctx: AgentContext) => '',
  },
};

// ========== 模板获取工具 ==========

/** 获取指定 Agent 的模板，不存在返回 undefined */
export function getAgentTemplate(agentId: string): AgentPromptTemplate | undefined {
  return AGENT_TEMPLATES[agentId];
}

/**
 * Phase 10: Build agent messages using the placeholder template system.
 *
 * For Story Agent: systemPrompt is assembled from preset entries via assemblePresetContent().
 * For other agents: systemPrompt comes from agent-config.json or fixedSystem fallback.
 *
 * system 消息 = 预设/模板 + 世界书 + 变量区
 * user 消息 = 正文/用户输入（variableInstruction）
 *
 * @param localParams - Phase 10: Local overrides for placeholders (chain callers pass {{CRAFT_REQUEST}}, etc.)
 */
export function buildAgentMessages(
  agentId: string,
  ctx: AgentContext,
  configs?: AgentConfig[],
  worldBooks?: WorldBook[],
  presets?: AgentPreset[],
  localParams?: Record<string, string>,
): Array<{ role: string; content: string }> | null {
  const tpl = getAgentTemplate(agentId);
  if (!tpl) return null;

  // Phase 8.6: 提前找到本 agent 的 config (供预设/世界书/历史注入共用)
  const config = configs?.find(c => c.agentId === agentId);
  // 关键: 不可 mutate 原 ctx (orchestrator 同 stage 多 agent 共享), 用浅拷贝注入 agentConfig
  const tplCtx: AgentContext = config ? { ...ctx, agentConfig: config } : ctx;

  // Step 1: Assemble SYS_PROMPT (preset > systemPrompt > fixedSystem fallback)
  let sysPromptContent = '';

  if (agentId === 'story' && presets && config?.presetId) {
    // Story Agent: assemble from preset
    const preset = getPreset(config.presetId, presets);
    if (preset) {
      sysPromptContent = assemblePresetContent(preset);
    }
  }

  if (!sysPromptContent && config?.systemPrompt) {
    // Other agents: use systemPrompt from agent-config.json
    sysPromptContent = config.systemPrompt;
  }

  if (!sysPromptContent) {
    // Fallback to old fixedSystem + fixedExamples (backward compatibility)
    sysPromptContent = [tpl.fixedSystem, tpl.fixedExamples].filter(Boolean).join('\n\n');
  }

  // Step 2: 世界书
  let worldBookSection = '';
  if (configs && worldBooks) {
    const entries = getEntriesForAgent(agentId, configs, worldBooks);
    const activeEntries = filterActiveEntries(
      entries,
      tplCtx.userInput + '\n' + (tplCtx.history.slice(-5).map(m => m.content).join('\n')),
    );
    worldBookSection = formatWorldBookEntries(activeEntries);
  }

  // Step 3: 变量区 (动态上下文)
  // Phase 8: 优先使用 zone-based 注入，未传 zones 时回退到旧的 variableContext()
  const variableSection = tplCtx.zones
    ? buildZoneSection(agentId, tplCtx)
    : tpl.variableContext(tplCtx);

  // Step 4: 正文/用户输入
  const bodySection = tpl.variableInstruction(tplCtx);

  const systemContent = [
    sysPromptContent,
    worldBookSection,
    variableSection,
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: bodySection },
  ];
}

/** 所有已注册的 Agent ID 列表 */
export const REGISTERED_AGENT_IDS = Object.keys(AGENT_TEMPLATES);
