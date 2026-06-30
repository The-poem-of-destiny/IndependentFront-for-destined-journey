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
    const text = (ctx.userInput || '') + '\n' + (ctx.history?.slice(-5).map(m => m.content).join('\n') || '');
    const activeEntries = filterActiveEntries(entries, text);
    const formatted = formatWorldBookEntries(activeEntries);
    if (params?.limit) {
      const limit = parseInt(params.limit, 10);
      if (!isNaN(limit) && limit > 0) {
        return formatted.slice(0, limit);
      }
    }
    return formatted;
  },

  /** {{NARRATIVE}} — 格式化最近对话历史，支持 layers/slice 参数 */
  'NARRATIVE': (ctx, config, params) => {
    const agentId = config.agentId || '';
    const layers = params?.layers ? parseInt(params.layers, 10) : defaultHistoryLayers(agentId);
    const slice = params?.slice ? parseInt(params.slice, 10) : defaultHistorySlice(agentId);
    if (layers <= 0 || !ctx.history?.length) return '';
    const maxMessages = layers * 2;
    return ctx.history.slice(-maxMessages)
      .map(m => `[${m.role}]: ${m.content.slice(0, slice)}`)
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

  /** {{AGENT.MEMORY_RECALL}} */
  'AGENT.MEMORY_RECALL': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('memory_recall') || '';
  },

  /** {{AGENT.PLOT_PRE_CHECK}} */
  'AGENT.PLOT_PRE_CHECK': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('plot_pre_check') || '';
  },

  /** {{AGENT.STORY}} */
  'AGENT.STORY': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('story') || '';
  },

  /** {{AGENT.VARS_UPDATE}} */
  'AGENT.VARS_UPDATE': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('vars_update') || '';
  },

  /** {{AGENT.MEMORY_SUMMARY}} */
  'AGENT.MEMORY_SUMMARY': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('memory_summary') || '';
  },

  /** {{AGENT.CHAR_UPDATE}} */
  'AGENT.CHAR_UPDATE': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('char_update') || '';
  },

  // ---- Chain Communication Placeholders (5) (localParams injected) ----
  'CRAFT_REQUEST': (_ctx, _config, _params) => '',
  'CHAR_DETECT': (_ctx, _config, _params) => '',
  'ITEM_REQUEST': (_ctx, _config, _params) => '',

  /** {{CHAR_GEN_RESULT}} — char_gen 输出 (从 agentOutputs 读取) */
  'CHAR_GEN_RESULT': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('char_gen') || '';
  },

  /** {{CRAFT_RESULT}} — craft_gen 输出 (从 agentOutputs 读取) */
  'CRAFT_RESULT': (ctx, _config, _params) => {
    return ctx.agentOutputs?.get('craft_gen') || '';
  },
};

// ═══════════════════════════════════════════════════════════
// Default Templates (per Agent)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TEMPLATES: Record<string, string> = {
  story: '{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n{{AGENT.PLOT_PRE_CHECK}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{GAME_TIME}}\n{{NARRATIVE}}\n{{USER_INPUT}}',
  memory_recall: '{{SYS_PROMPT}}\n{{MEMORY_ENTRIES}}\n{{NARRATIVE:layers=3:slice=800}}\n{{USER_INPUT}}',
  plot_pre_check: '{{SYS_PROMPT}}\n{{PLOT_EVENTS}}\n{{AGENT.MEMORY_RECALL}}\n{{NARRATIVE:layers=3:slice=1000}}\n{{USER_INPUT}}',
  vars_update: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK}}',
  char_update: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{AGENT.VARS_UPDATE}}\n{{CHARACTER_STATE}}\n{{NARRATIVE:layers=1:slice=800}}',
  memory_summary: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{NARRATIVE:layers=4:slice=1500}}',
  plot_post_check: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{AGENT.MEMORY_SUMMARY}}\n{{PLOT_EVENTS}}\n{{CHARACTER_STATE}}\n{{NARRATIVE:layers=4:slice=1000}}',
  plot_outline: '{{SYS_PROMPT}}\n{{PLOT_EVENTS}}\n{{NARRATIVE:layers=3:slice=1000}}',
  craft_gen: '{{SYS_PROMPT}}\n{{CRAFT_REQUEST}}\n{{INVENTORY}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK}}\n{{NARRATIVE:layers=1:slice=800}}',
  char_gen: '{{SYS_PROMPT}}\n{{CHAR_DETECT}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK}}\n{{NARRATIVE:layers=1:slice=800}}',
  item_gen: '{{SYS_PROMPT}}\n{{ITEM_REQUEST}}\n{{CHAR_GEN_RESULT}}\n{{CRAFT_RESULT}}\n{{INVENTORY}}',
};

/** Get the default template for a given agent, or empty string if unknown */
export function getDefaultTemplate(agentId: string): string {
  return DEFAULT_TEMPLATES[agentId] || '';
}
