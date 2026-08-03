/**
 * Phase 10: Placeholder Registry — Unified Agent Template System
 *
 * 职责:
 * 1. 定义 PLACEHOLDER_REGISTRY — 18 个 {{PLACEHOLDER}} → 解析函数的映射
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
 * - LORE_BOOK 使用 worldbook-loader 的 getEntriesForAgent / filterActiveEntries / renderWorldBookEntries
 * - formatHistory / formatCharacters / formatMemories / formatPlotEvents 等私有函数在此模块内镜像实现
 */

import type {
  AgentContext,
  AgentConfig,
  WorldBook,
  CharacterState,
  PlaceholderResolver,
} from './types';
import {
  getEntriesForAgent,
  filterActiveEntries,
  renderWorldBookEntries,
} from './worldbook-loader';
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

/**
 * uid → 所属世界书名（仅用于 EJS 回退告警的可读性）。
 * uid 在跨书场景可能重复，取首个命中即可——这是日志文案不是寻址。
 */
function bookNameOfUid(uid: number): string {
  for (const book of _worldBooks) {
    if (book.entries?.some((e) => e.uid === uid)) return book.name || book.id;
  }
  return '?';
}

/** Mirror of agent-templates.ts formatCharacters (private, not exported) */
function formatCharacters(ctx: AgentContext): string {
  if (!ctx.characters?.length) return '';
  return ctx.characters
    .map(
      (c) =>
        `[${c.type}:${c.name}] Lv.${c.level} ${c.tierName} | HP:${c.hp}/${c.maxHp} MP:${c.mp}/${c.maxMp} | 位置:${c.location} | ${c.currentAction || '待机中'}`,
    )
    .join('\n');
}

/** Mirror of agent-templates.ts formatMemories (private, not exported) */
function formatMemoriesEntries(ctx: AgentContext, topK?: number): string {
  const memories = ctx.memories ?? [];
  if (memories.length === 0) return '';
  const sliced = topK && topK > 0 ? memories.slice(0, topK) : memories;
  return sliced
    .map(
      (m) =>
        `[${m.id}] ${m.timeRange.start}~${m.timeRange.end} | 重要度:${m.importance}\n正文: ${m.content.slice(0, 300)}`,
    )
    .join('\n---\n');
}

/** Mirror of agent-templates.ts formatPlotEvents (private, not exported) */
function formatPlotEventsEntries(ctx: AgentContext): string {
  const events = ctx.plotEvents ?? [];
  if (events.length === 0) return '';
  return events
    .filter((e) => e.status === 'active' || e.status === 'pending')
    .map((e) => `[${e.id}] ${e.title} (${e.status})\n${e.description.slice(0, 200)}`)
    .join('\n---\n');
}

// ═══════════════════════════════════════════════════════════
// LORE_BOOK 共享实现（{{LORE_BOOK}} / {{LORE_BOOK_STATIC}} / {{LORE_BOOK_DYNAMIC}} 三者同源）
// ═══════════════════════════════════════════════════════════

/**
 * 世界书条目过滤 + 静/动分层 + EJS 求值 + 宏剥离 —— 三个 LORE_BOOK 占位符的唯一实现。
 *
 * 工坊 P2 (ADR-30 D1/D7)：条目过滤后走 `renderWorldBookEntries` —— 静态区（无 `<%`/`{{random`/
 * `{{getvar}}` 特征）字节稳定排在前，动态区 EJS 求值后沉到尾部，最大化 prompt cache 前缀。
 *
 * 分区选择：
 * - `forcedSection` 传入 → 忽略 `params.section`，只返回该区（供裸名占位符 `{{LORE_BOOK_STATIC}}` /
 *   `{{LORE_BOOK_DYNAMIC}}` 钉死分区用；裸名不接受用户改区）
 * - 否则看 `params.section`（`static` / `dynamic`）
 * - 两者都没有 → 静态区 + 动态区顺序连拼（默认行为，普通用户无感）
 * - `limit=N` → 三种写法通用，对最终文本截断
 *
 * 宏链（parseSetvars → resolveGetvars → resolveRandoms）位置**不动**，仍在 EJS 之后，
 * 对**本次返回的那段文本**独立跑。⚠️ 拆开两区时两区各自成一次宏作用域——
 * 静态区定义的 `{{setvar}}` 不再对动态区的 `{{getvar}}` 可见，这是拆分的固有代价。
 *
 * 🔴 **pass 级 memo（幂等保障）**：拆分写法让本函数在同一 pass 被调多次，
 * 而 EJS 条目不保证幂等（计数器式 `setMessageVar` 在语料里合法）——重复求值 = 写翻倍落库。
 * 故首次求值把整份 `renderWorldBookEntries` 结果缓存到 `ctx.ejsPass.loreRender`，
 * 后续出现（无论哪个占位符、哪个分区）只从缓存挑段。不同 Agent 的 pass 各自新建 ejsPass，天然隔离。
 * 无 ejsPass 的退化路径不缓存——一次性上下文没有二次出现问题（写即弃）。
 */
function resolveLoreBookSection(
  ctx: AgentContext,
  config: AgentConfig,
  params: Record<string, string> | undefined,
  forcedSection?: 'static' | 'dynamic',
): string {
  if (_worldBooks.length === 0 || _configs.length === 0) return '';
  const agentId = config.agentId || '';
  const entries = getEntriesForAgent(agentId, _configs, _worldBooks);
  if (entries.length === 0) return '';
  const activeEntries = filterActiveEntries(entries);

  // 求值上下文取本次装配 pass 的草稿（buildAgentMessages 挂在 tplCtx.ejsPass 上）。
  // 极端路径（外部直接调 resolver / 老测试）无草稿 → 退化为一次性空草稿：求值照跑，写即弃。
  const ejsCtx = ctx.ejsPass ?? { stats: ctx.statData ?? {}, vars: {}, historyText: '' };

  const memo = ctx.ejsPass?.loreRender;
  let staticText: string;
  let dynamicText: string;
  if (memo && memo.agentId === agentId) {
    // 本 pass 已求值过 —— 直接复用，绝不二次执行 EJS（回退告警也已在首次打过）
    staticText = memo.staticText;
    dynamicText = memo.dynamicText;
  } else {
    // 无 memo 的同步兜底路（2026-08-01 修 F3 的裁定）：
    // 生产装配一律走 `buildAgentMessagesAsync` —— 它预渲染完把结果灌进 `ejsPass.loreRender`，
    // 上面那条 memo 分支才是生产的正常路径，这里只剩测试与外部直接调 resolver 的极端路径。
    // 保留调用而不删，是因为 `renderWorldBookEntries` 自身已带 fail-closed 闸门：
    // 当前后端不是 `LegacyBackend`（= 生产的 QuickJS / fail-closed）时它**不在宿主 realm 求值**，
    // 按 D8 原文注入并记回退。故这里不会成为绕过隔离的后门；测试默认 Legacy 后端下行为不变。
    const rendered = renderWorldBookEntries(activeEntries, ejsCtx);
    staticText = rendered.staticText;
    dynamicText = rendered.dynamicText;
    if (ctx.ejsPass) {
      ctx.ejsPass.loreRender = {
        agentId,
        staticText,
        dynamicText,
        fallbackEntries: rendered.fallbackEntries,
      };
    }
    if (rendered.fallbackEntries.length > 0) {
      console.warn(
        `[LORE_BOOK] agent=${agentId} 有 ${rendered.fallbackEntries.length} 个条目 EJS 失败、已回退原文注入: ` +
          rendered.fallbackEntries.map((f) => `${bookNameOfUid(f.uid)}#${f.uid}`).join(', '),
      );
      // 同步送进诊断出口（同步 resolver 这条路；异步预渲染那条在 agent-templates）
      try {
        ctx.ejsFallback?.({
          agentId,
          entries: rendered.fallbackEntries.map((f) => ({
            uid: f.uid,
            bookName: bookNameOfUid(f.uid),
            error: f.error,
          })),
        });
      } catch (err) {
        console.warn('[LORE_BOOK] EJS 回退诊断出口抛错（已忽略）:', err);
      }
    }
  }

  // 裸名占位符钉死分区，优先级高于 params.section（用户给 {{LORE_BOOK_STATIC:section=dynamic}} 也不改区）
  const section = forcedSection ?? params?.section;
  let formatted: string;
  if (section === 'static') formatted = staticText;
  else if (section === 'dynamic') formatted = dynamicText;
  else formatted = [staticText, dynamicText].filter(Boolean).join('\n\n');

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
}

// ═══════════════════════════════════════════════════════════
// Placeholder Registry
// ═══════════════════════════════════════════════════════════

export const PLACEHOLDER_REGISTRY: Record<string, PlaceholderResolver> = {
  // ---- Global Placeholders (12) ----

  /** {{SYS_PROMPT}} — Agent 的 systemPrompt，来自 agent-config.json */
  SYS_PROMPT: (ctx, config, _params) => {
    return config.systemPrompt || '';
  },

  /**
   * {{LORE_BOOK}} — 世界书条目（静态区 + 动态区连拼）。
   * 支持 `section=static` / `section=dynamic` 参数化拆区，以及 `limit=N` 截断。
   * 完整语义（分层 / 宏作用域 / pass 级 memo）见 `resolveLoreBookSection`。
   */
  LORE_BOOK: (ctx, config, params) => resolveLoreBookSection(ctx, config, params),

  /**
   * {{LORE_BOOK_STATIC}} — 等价于 `{{LORE_BOOK:section=static}}` 的裸名写法。
   *
   * 存在理由：参数化写法在 story 预设链路上会被剥离/漏检（preset-loader 与 agent-templates 的
   * 白名单都按精确 `{{名字}}` 匹配），裸名才能穿过全部正则闸门。行为与参数化形态完全一致：
   * 共用同一份 pass 级 memo（同 pass 内与 `{{LORE_BOOK_DYNAMIC}}` 同时出现也只求值一次 EJS），
   * 同样支持 `limit=N`。
   *
   * ⚠️ 与参数化拆区同样的固有代价：静/动两区各自成一次宏作用域——
   * 静态区定义的 `{{setvar}}` 不再对动态区的 `{{getvar}}` 可见。
   */
  LORE_BOOK_STATIC: (ctx, config, params) => resolveLoreBookSection(ctx, config, params, 'static'),

  /**
   * {{LORE_BOOK_DYNAMIC}} — 等价于 `{{LORE_BOOK:section=dynamic}}` 的裸名写法。
   * 存在理由、memo 共享与 `limit=N` 支持同 {{LORE_BOOK_STATIC}}。
   *
   * ⚠️ 同样各自成一次宏作用域：本区的 `{{getvar}}` 看不到静态区定义的 `{{setvar}}`。
   */
  LORE_BOOK_DYNAMIC: (ctx, config, params) =>
    resolveLoreBookSection(ctx, config, params, 'dynamic'),

  /** {{NARRATIVE}} — 格式化最近对话历史，支持 layers 参数（:slice 已废弃，再不截断） */
  NARRATIVE: (ctx, config, params) => {
    const agentId = config.agentId || '';
    const layers = params?.layers ? parseInt(params.layers, 10) : defaultHistoryLayers(agentId);
    if (layers <= 0 || !ctx.history?.length) return '';
    const maxMessages = layers * 2;
    return ctx.history
      .slice(-maxMessages)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');
  },

  /** {{USER_INPUT}} — 本轮用户输入 */
  USER_INPUT: (ctx, _config, _params) => {
    return ctx.userInput || '';
  },

  /** {{CHARACTER_STATE}} — 角色状态，通过 zone 系统格式化 */
  CHARACTER_STATE: (ctx, config, _params) => {
    const agentId = config.agentId || '';
    const zones = buildZoneContext(ctx);
    const npcZone = zones.npc;
    if (!npcZone) return '';
    const visibility = getAgentZoneVisibility(agentId).npc;
    if (visibility === 'NONE') return '';
    return filterZoneContent('npc', npcZone.content, visibility, agentId, ctx) || '';
  },

  /** {{INVENTORY}} — 遍历所有角色的背包物品 */
  INVENTORY: (ctx, _config, _params) => {
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

  /** {{SKILL_STATE}} — 主角/在场角色的技能清单（含开局初始技能声明） */
  SKILL_STATE: (ctx, _config, _params) => {
    const lines: string[] = [];

    // ① 落库技能（item_gen 已生成的 / 已有角色的技能）
    for (const char of ctx.characters ?? []) {
      const skills = char.skills ?? [];
      if (skills.length === 0) continue;
      lines.push(`[${char.name}] 技能:`);
      for (const sk of skills) {
        const typeLabel = sk.type === 'active' ? '主动' : sk.type === 'passive' ? '被动' : '';
        const effs = sk.effects
          ? ` [${Object.entries(sk.effects)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}]`
          : '';
        lines.push(`  [${typeLabel}] ${sk.name} — ${sk.description || ''}${effs}`);
        // 不显示 cost/cooldown/scripts（同 CHARACTER_STATE KEYS 策略）
      }
    }

    // ② 开局初始技能声明（openingPrompt 的 `--- 初始技能 ---` 段）。
    //    主角 skills 落库为空（交给 item_gen 生成），request_dispatcher 必须从这份
    //    声明里识别初始技能并逐条发 `<item_gen_request itemType="skill">`。
    const opening = ctx.openingPrompt ?? '';
    if (opening) {
      const segMatch = opening.match(/---\s*初始技能\s*---([\s\S]*?)(?=\n---\s*|\n\n*---|$)/);
      const seg = segMatch?.[1] ?? '';
      const lines2 = seg
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines2.length > 0) {
        lines.push('');
        lines.push('【开局初始技能声明】（尚未落库，需生成）:');
        lines.push(...lines2);
      }
    }

    return lines.join('\n');
  },

  /** {{QUEST_STATE}} — 当前所有任务 (Phase 10g) */
  QUEST_STATE: (ctx, _config, _params) => {
    const quests = ctx.quests ?? {};
    const entries = Object.entries(quests);
    if (entries.length === 0) return '(无任务)';
    const lines: string[] = [];
    for (const [name, q] of entries as [string, any][]) {
      const parts: string[] = [
        `  [${name}]`,
        `状态:${q.status || '—'}`,
        `优先级:${q.priority || '—'}`,
      ];
      if (q.objective) parts.push(`目标:${q.objective}`);
      if (q.progress) parts.push(`进度:${q.progress}`);
      if (q.detail) parts.push(`详情:${q.detail}`);
      if (q.reward) parts.push(`奖励:${q.reward}`);
      lines.push(parts.join(' | '));
    }
    return lines.join('\n');
  },

  /** {{GAME_TIME}} — 从 variables 中提取时间/位置/天气/纪元等世界键 */
  GAME_TIME: (ctx, _config, _params) => {
    const vars = ctx.variables ?? {};
    const worldKeys = [
      '时间',
      'time',
      'timeOfDay',
      '位置',
      'location',
      'currentRegion',
      'currentFaction',
      '天气',
      'weather',
      '季节',
      'season',
      '月相',
      'moonPhase',
      '纪元',
      'era',
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
  ACTIVE_EFFECTS: (ctx, _config, _params) => {
    const characters = ctx.characters ?? [];
    if (characters.length === 0) return '';
    const lines: string[] = [];
    for (const char of characters) {
      const effects = char.statusEffects ?? [];
      if (effects.length === 0) continue;
      const effectDescs = effects.map((e) => {
        const timeStr =
          e.remainingTime != null ? ` (剩余${e.remainingTime}${e.timeUnit || '分钟'})` : ' (永久)';
        return `${e.name}[${e.category}]${timeStr} — ${e.description || ''}`;
      });
      lines.push(`[${char.name}] 状态效果: ${effectDescs.join('; ')}`);
    }
    return lines.join('\n');
  },

  /** {{MEMORY_ENTRIES}} — 格式化记忆列表，支持 top_k 参数 */
  MEMORY_ENTRIES: (ctx, _config, params) => {
    const topK = params?.top_k ? parseInt(params.top_k, 10) : undefined;
    const formatted = formatMemoriesEntries(ctx, topK);
    if (!formatted) return '';
    const header =
      topK && topK > 0
        ? `**记忆库 (最近 ${topK} 条):**\n${formatted}`
        : `**记忆库:**\n${formatted}`;
    return header;
  },

  /** {{PLOT_EVENTS}} — 格式化剧情事件（仅 active + pending） */
  PLOT_EVENTS: (ctx, _config, _params) => {
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
  CRAFT_REQUEST: (_ctx, _config, _params) => '',
  CHAR_DETECT: (_ctx, _config, _params) => '',
  ITEM_REQUEST: (_ctx, _config, _params) => '',

  /** {{CHAR_GEN_RESULT}} — char_gen 输出 (从 agentOutputs 读取) */
  CHAR_GEN_RESULT: (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('char_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{CRAFT_RESULT}} — craft_gen 输出 (从 agentOutputs 读取) */
  CRAFT_RESULT: (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('craft_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },
};

// ═══════════════════════════════════════════════════════════
// Default Templates (per Agent)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TEMPLATES: Record<string, string> = {
  story:
    '{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n{{AGENT.PLOT_PRE_CHECK}}\n{{LORE_BOOK_STATIC}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK_DYNAMIC}}\n{{GAME_TIME}}\n{{NARRATIVE}}\n{{USER_INPUT}}',
  memory_recall: '{{SYS_PROMPT}}\n{{MEMORY_ENTRIES}}\n{{NARRATIVE:layers=3}}\n{{USER_INPUT}}',
  // Phase 10 结构化（2026-07-20）: XML 分区 + 注释三要素 + 缓存排序。
  // {{PLOT_EVENTS}} 在管线中被 buildAgentMessages 的 localParams 覆盖为富上下文块
  // （<剧情大纲>+<剧情事件列表>+<当前状态>，见 agent-templates.ts buildPlotContextBlock）。
  plot_pre_check:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你判断剧情触发所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件——含尚未向玩家揭示的 hidden 事件，\n     防剧透只在 UI 层，你必须全量审视)、<当前状态>(时间/位置/主角层级一行摘要)。\n     这是你触发判断的唯一事件来源——triggeredEvents 的 title 必须与 <剧情事件列表> 逐字一致。\n     区块为空或缺大纲时（如支线模式初期）以现有内容为准，保守判断，不编造事件。-->\n\n<记忆召回>\n{{AGENT.MEMORY_RECALL}}\n</记忆召回>\n<!-- 上游记忆召回 Agent 给出的相关历史记忆。用于核对触发条件中的历史前提\n     （如「与铁匠建立信任之后」）。为空表示本轮无相关记忆——缺证据时按条件未满足处理。-->\n\n<最近对话>\n{{NARRATIVE:layers=3}}\n</最近对话>\n<!-- 🔴 每轮变化。最近 3 轮正文与玩家输入。评估证据强度时它是第二优先级——\n     低于本轮 <用户输入> 的明确行动，高于 <记忆召回> 中的旧线索。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言——触发判断的首要证据来源。-->',
  request_dispatcher:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成变量调度所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     判断角色种族和势力归属时参考此处。——稳定数据，优先查阅。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 当前存档中所有已有角色的列表（ID/Name/Race/Type/Tier/Location）。\n     这是你判断\"新角色 vs 已有角色\"的唯一依据——\n     角色名不在此表中 → 新角色 → <char_gen_request>；\n     角色名在此表中 → 已有角色 → <char_update_request>。-->\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n<!-- 所有角色背包中的物品、装备、材料清单。\n     这是你判断\"新物品 vs 已有物品\"的唯一依据——\n     物品名不在背包中 → 新物品 → <item_gen_request>；\n     物品名在背包中 → 已有物品 → <item_update_request>。-->\n\n<已有技能>\n{{SKILL_STATE}}\n</已有技能>\n<!-- 🔴 2026-08-02 新增: 所有角色的技能清单（含开局初始技能声明）。\n     这是你判断\"新技能 vs 已有技能\"的唯一依据——\n     技能名不在下表中 → 新技能 → <item_gen_request itemType="skill">（逐条单独发）；\n     技能名已在表中 → 已有技能，不重复生成。\n     开局初始技能声明标了「尚未落库，需生成」→ 逐条发 <item_gen_request itemType="skill">\n     让 item_gen 生成 stats/modifiers/automata。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n<!-- 🔴 高频变化：本回合 Story Agent 生成的叙事正文。\n     仔细阅读全文，从中提取所有变量变化、新角色/物品出现、制作场景。——这是你的核心输入。-->',
  vars_update:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你更新角色/物品状态的完整上下文数据。       -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。         -->\n<!-- ⚠️ 需要写脚本时调用 get_script_reference 工具。     -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n\n<调度器输出>\n{{AGENT.REQUEST_DISPATCHER}}\n</调度器输出>\n<!-- request_dispatcher 的完整输出，包含 <char_update_request> 和 <item_update_request> 标签。\n     逐条读取每个标签，这是你需要处理的变更清单。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n\n<最近对话>\n{{NARRATIVE:layers=1}}\n</最近对话>',
  memory_summary: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{NARRATIVE:layers=4}}',
  // Phase 10 结构化（2026-07-20）: 同 plot_pre_check，{{PLOT_EVENTS}} 由 localParams 覆盖为富上下文块。
  plot_post_check:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你审视世界线与事件状态所需的完整上下文。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件)、<当前状态>(时间/位置/主角层级)。\n     eventUpdates 与 newChildEvents.parentTitle 只能引用 <剧情事件列表> 中逐字一致的标题；\n     世界线偏离程度以 <剧情大纲> 的预设走向为标尺。区块缺大纲时以事件列表为准，保守判断。-->\n\n<角色状态>\n{{CHARACTER_STATE}}\n</角色状态>\n<!-- 场景中角色的状态快照(层级/资源/位置等)。用于佐证事件完成/失败的客观后果\n     （如关键角色死亡 → 相关事件 fail）。以区块内容为准，缺失时不做推断。-->\n\n<最近对话>\n{{NARRATIVE:layers=4}}\n</最近对话>\n<!-- 最近 4 轮对话历史（不含本轮正文）。提供剧情连续性——判断世界线是否偏离时\n     结合前几轮走向一起看，避免把连续铺垫误判为突发变动。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言，与 <本轮正文> 对照理解玩家意图与选择后果。-->\n\n<本轮正文>\n{{AGENT.STORY}}\n</本轮正文>\n<!-- 🔴 每轮变化。本回合正文 AI 的完整输出——你审视的核心对象。\n     事件完成/失败、世界线变动的一切判断都必须以此处的直接证据为准。-->\n\n<本轮记忆总结>\n{{AGENT.MEMORY_SUMMARY}}\n</本轮记忆总结>\n<!-- 🔴 每轮变化。记忆总结 Agent 对本轮的压缩记录(含暗线线索)。\n     辅助你快速把握本轮要点；与 <本轮正文> 冲突时以正文为准。-->',
  plot_outline:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成剧情大纲所需的完整上下文。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<角色背景>\n{{CHARACTER_STATE}}\n</角色背景>\n<!-- 主角的种族/血脉/层级/属性/身份/背景故事/装备/技能/命定核心。\n     所有剧情必须以主角为核心展开——章节和事件的推动力必须来自主角的选择和成长。\n     不能偏成 NPC 传、世界观说明书或编年史。\n     以区块实际内容为准；缺字段时不做推断。-->\n\n<剧情配置>\n{{PLOT_EVENTS}}\n</剧情配置>\n<!-- 🔴 引擎注入的剧情配置（非事件列表）。由 create-store 通过 localParams 覆盖。\n     包含：模式(main=主线/side=支线)、持续年份、难度层级(T1-T7)、剧情偏向(战斗/解密/人际/恋爱/探索/政治/生存/悲剧)、\n     自定义偏好、是否允许世界书外NPC、专注区域(支线模式)、雷点(绝对禁止级)。\n     雷点优先级高于一切剧情偏好——绝对禁止生成雷点描述的任何内容。\n     区块为空时：默认 off 模式，不做推断。-->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前激活的世界书条目。涵盖势力/地理/种族/文化/组织/行业/怪物生态。\n     大纲的势力冲突、地理锚点、文化背景必须以此为准。\n     区块为空时以通用奇幻设定为准，不凭空发明势力名/地名。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<用户指令>\n{{USER_INPUT}}\n</用户指令>\n<!-- 🔴 每轮变化。初始生成 → "请根据以上信息生成剧情大纲" + 角色摘要；\n     修改模式 → 用户修改要求 + 上一版大纲完整 JSON。-->',
  // Phase 10 结构化模板：XML 分区 + 注释 + 缓存优化排序（稳定在上，动态在下）
  craft_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成制作任务所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力关系、地理信息、行业规范等。\n     制作产物的外观描述、材质选择、工艺风格应与当前世界观保持一致。\n     例如：诺斯加德地区的锻造工艺偏向实用粗犷，而赛瑞利亚的炼金术精于优雅调配。-->\n\n<制作者状态>\n{{CHARACTER_STATE}}\n</制作者状态>\n<!-- 制作者及场景中其他角色的完整状态：基础属性(力量/智力/敏捷/精神)、当前HP/MP/SP、\n     等级与层级、已装备物品、已习得技能。制作准备阶段优先查阅此处获取核心属性值和层级信息，\n     以判断是否满足目标品质的层级封顶。若数据不足以完成检定，再调用 get_character 补充。-->\n\n<可用材料>\n{{INVENTORY}}\n</可用材料>\n<!-- 所有角色背包中的物品清单(材料/消耗品/装备等)。先查阅此处确认可用材料的种类和数量，\n     判断材料是否满足品质继承规则(至少2种同品质投入物)。若数据不完整再调用 get_inventory 补充。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<本次制作需求>\n{{CRAFT_REQUEST}}\n</本次制作需求>\n<!-- 从正文 <craft_request> 标记中提取的制作需求。包含用户期望制作的物品、目标品质、行业类型、\n     预期效果描述等。这是你执行制作的核心依据——仔细阅读用户的需求，作为产物设计的起点。-->\n\n<当前剧情>\n{{NARRATIVE:layers=1}}\n</当前剧情>\n<!-- 最近的对话历史。帮助你理解制作发生的场景和上下文——在铁匠铺锻造与在篝火边修理，\n     叙事描写方式截然不同。制作叙事应与当前剧情场景自然衔接。-->',
  char_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成角色所需的完整上下文数据。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖种族特性、血脉能力、势力关系、地理信息等。\n     角色外观、种族、文化背景、命名风格应与世界观保持一致。\n     例如：萨赫拉联邦多见黑发金瞳的沙漠血统，诺斯加德地区以金发碧眼为主。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 场景中所有已有角色的状态快照。第一步先查阅此处——检查是否存在同名角色，\n     若同名已有角色存在则直接复用其数据，不调用随机工具。\n     同时判断新角色与已有角色之间是否存在潜在的血缘、势力或社交关系。\n     若列表不完整需要查重，再调用 get_character 补充。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<当前剧情场景>\n{{NARRATIVE:layers=1}}\n</当前剧情场景>\n<!-- 最近的对话历史。帮助你理解角色出场时的场景氛围——在酒馆偶遇、战场上对峙、\n     还是森林中邂逅，角色的外貌/装备/性格设定应贴合出场情境。-->\n\n<新角色描述>\n{{CHAR_DETECT}}\n</新角色描述>\n<!-- 从正文 <char_detect> 标记中提取的新角色描述，包含角色名、类型(npc/enemy/ally)、\n     外貌特征、行为表现、可能的背景线索。这是你生成角色的核心依据——\n     正文已明确的特征不要用随机工具覆盖，只用工具填充未提及的部分。-->',
  item_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成物品/技能/装备所需的完整上下文。  -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     装备名和技能名应符合对应的文化和审美风格，品质描述统一使用7级体系。-->\n\n<可用物品库>\n{{INVENTORY}}\n</可用物品库>\n<!-- 所有角色背包中已有的物品、装备、材料清单。生成新物品时注意不与已有物品重复，\n     同时确保新装备的强度不会碾压已有装备，保持数值合理递增。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<角色生成结果>\n{{CHAR_GEN_RESULT}}\n</角色生成结果>\n<!-- char_gen 输出的完整角色数据，包含 <skill_requests>/<equipment_requests>/<item_requests>\n     以及 <ascension> 登神长阶块（如有）。每个 <request> 中含需求描述和理由——\n     仔细阅读每一个 request，理解需求背后的角色定位，再开始编写。\n     若需要补充查询角色详细属性，调用 get_character。-->\n\n<制作结果>\n{{CRAFT_RESULT}}\n</制作结果>\n<!-- craft_gen 输出的制作结果，包含 <item_requests>。\n     仅在制作品质链中触发——为制作产物编写具体数值。未触发制作时此区块为空。-->\n\n<物品需求>\n{{ITEM_REQUEST}}\n</物品需求>\n<!-- 从 <item_requests> 中提取的具体需求列表。每个 <request> 对应一个需要编写的条目。\n     request 中的自然语言描述是唯一的需求来源——不要自行增减条目或改变需求方向。\n     注意区分来源：char_gen 的角色物品 vs craft_gen 的制作产物。-->',
  // Q-04: 以下三个是**退役/别名** agentId，生产链路不会调它们（战斗主持已换 combat_v3，
  // 走 coordinator 自己的装配；plot_check / plot_correct 是 v3 兼容别名）。它们仍留在
  // AGENT_TEMPLATES 与 context-visibility 的可见性表里，所以这里给一条最小模板 ——
  // 让「没有默认模板」这个状态在仓库里彻底不存在，buildAgentMessages 只剩一条路。
  combat: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
  plot_check: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
  plot_correct: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
};

/** Get the default template for a given agent, or empty string if unknown */
export function getDefaultTemplate(agentId: string): string {
  return DEFAULT_TEMPLATES[agentId] || '';
}
