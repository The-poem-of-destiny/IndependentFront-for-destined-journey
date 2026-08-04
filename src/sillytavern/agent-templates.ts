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

import type {
  AgentPromptTemplate,
  AgentContext,
  AgentConfig,
  AgentPreset,
  WorldBook,
  WorldBookEntry,
} from './types';
import type { GameTime } from './time-system';
import { MONTH_NAMES } from './time-system';
import {
  getEntriesForAgent,
  filterActiveEntries,
  renderWorldBookEntries,
  prerenderWorldBookEntries,
} from './worldbook-loader';
import { getPreset, assemblePresetContent } from './preset-loader';
import { buildZoneContext } from './context-visibility';
import { resolveTemplateWithGlobals } from './template-resolver';
import type { EjsCapabilityInput } from './ejs-capabilities';
import { DANGEROUS_PATH_SEGMENTS } from './var-resolver';
import { getDefaultTemplate } from './placeholder-registry';

// ========== 通用工具 ==========

/**
 * Phase 8.6: 各 Agent 历史注入（最近几轮 user+ai 对）的默认值。
 * 由 buildAgentMessages 调用 formatHistory 时，优先读 ctx.agentConfig.historyLayers；
 * AgentConfig 未设该字段则回退到这里。层数 N → 注入最近 N*2 条消息（user/ai 一对）。
 */
export function defaultHistoryLayers(agentId: string): number {
  switch (agentId) {
    case 'story':
      return 6; // 正文 AI, 主上下文, 注入较多轮
    case 'memory_summary':
      return 4; // 记忆总结需看连续剧情
    case 'plot_post_check':
      return 4; // 剧情/世界线需连续上下文
    case 'plot_outline':
      return 3;
    case 'memory_recall':
      return 3;
    // 后置抽取型: 原本不看历史, 8.6 默认给 1 轮上轮辅助上文, 可配 0 关闭
    case 'request_dispatcher':
    case 'vars_update':
    case 'char_gen':
    case 'item_gen':
    case 'craft_gen':
      return 1;
    default:
      return 2;
  }
}

/**
 * Phase 8.6: 各 Agent 每条历史正文截断字数的默认值。
 * 长正文 agent (story/memory_summary) 给较大值, 后置抽取型给中等值。
 */
export function defaultHistorySlice(agentId: string): number {
  switch (agentId) {
    case 'story':
    case 'memory_summary':
      return 1500;
    case 'plot_post_check':
    case 'plot_outline':
    case 'memory_recall':
      return 1000;
    // 后置型历史是辅助上文, 不必太长
    case 'request_dispatcher':
    case 'vars_update':
    case 'char_gen':
    case 'item_gen':
    case 'craft_gen':
      return 800;
    default:
      return 800;
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
  if (layers <= 0) return ''; // 0 层 = 不注入
  const maxMessages = layers * 2; // user/ai 一对算一层
  return ctx.history
    .slice(-maxMessages)
    .map((m) => {
      const displayRole = m.role === 'system' ? 'assistant' : m.role;
      return `[${displayRole}]: ${m.content.slice(0, slice)}`;
    })
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

// ========== 工坊 Phase 2 / ADR-30: EJS 求值 pass 上下文 ==========

/**
 * 深拷贝（纯数据面）：数组/Date/纯对象递归，其余（函数、类实例）原样返回；危险键剔除。
 * 语义对齐 `ejs-runtime.ts` 的同名私有函数（那边不导出，此处不跨模块耦合，各留一份十行实现）。
 * 危险键集来自 `var-resolver`（全仓唯一定义）。
 */
function deepCloneVars<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepCloneVars(v)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, any> = {};
  for (const k of Object.keys(value as Record<string, any>)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = deepCloneVars((value as Record<string, any>)[k]);
  }
  return out as unknown as T;
}

/**
 * `matchChatMessages()` 的检索面：该 Agent 历史窗口内的消息正文拼接串。
 *
 * 窗口口径**复用历史注入口径**（`config.historyLayers` → `defaultHistoryLayers(agentId)`，
 * 层数 N → 最近 N*2 条），与提示里实际能看到的历史一致（设计 §4 降级：上游可查全聊天记录，我们查注入窗口）。
 * 刻意**不套 `historySlice` 截断**——那是给 AI 看的省字数手段，用来做子串/正则命中会误判「没提到」。
 */
export function buildEjsHistoryText(
  agentId: string,
  ctx: AgentContext,
  config?: AgentConfig,
): string {
  const layers =
    config?.historyLayers ?? ctx.agentConfig?.historyLayers ?? defaultHistoryLayers(agentId);
  if (layers <= 0 || !ctx.history?.length) return '';
  return ctx.history
    .slice(-layers * 2)
    .map((m) => m.content ?? '')
    .join('\n');
}

/**
 * 构造本次装配 pass 的 EJS 求值上下文（设计 D4/D5/D6）。
 *
 * - `stats`：`ctx.statData` 的 **pass 级克隆**（回合级投影只建一次，克隆杜绝跨 pass 写泄漏）
 * - `vars`：`ctx.variables.sys` 的 pass 级草稿；条目按序在其上读写，后续条目立即可见
 * - 持 `ejsVarsCommit` 权且 `ctx.ejsVarsDrafts` 存在 → 把 `{ base, draft }` 登记进表。
 *   `draft` 就是返回值里那个对象引用（求值写入后调用方拿到最终态）；`base` 是另一份独立克隆。
 *   往 Map 里 set **不算 mutate 原 ctx 的既有字段**（容器由上游创建并共享）。
 */
/**
 * 组装能力面输入（能力面 §3.3-§3.12）。
 *
 * 🔴 `lore` 的可见性是**安全相关**的：`getEntriesForAgent` 已经按 Phase 8 分区过滤，
 * 这里只在它的产出里查 —— EJS 绝不能成为绕过可见性模型的旁路。
 */
function buildCapabilityInput(
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig | undefined,
  configs: AgentConfig[] | undefined,
  worldBooks: WorldBook[] | undefined,
): EjsCapabilityInput {
  /**
   * 可见条目 + uid→书名 索引，**惰性建、建一次**。
   *
   * 为什么不在函数体里直接算：本函数是**每 Agent 每回合**都会跑的热路径，而这两样
   * 只有 `lore.get/list` 用得上 —— 真机语料里绝大多数条目一次都不调。
   * 急切构建等于给每一次提示装配平白加一遍全量条目扫描（内置书 600+ 条目）。
   */
  let loreIndex: { visible: WorldBookEntry[]; bookOf: Map<number, string> } | null = null;
  const getLoreIndex = () => {
    if (loreIndex) return loreIndex;
    const visible =
      configs && worldBooks
        ? filterActiveEntries(getEntriesForAgent(agentId, configs, worldBooks))
        : [];
    const bookOf = new Map<number, string>();
    for (const book of worldBooks ?? []) {
      for (const e of book.entries ?? []) bookOf.set(e.uid, book.name);
    }
    loreIndex = { visible, bookOf };
    return loreIndex;
  };

  return {
    history: (ctx.history ?? []).map((m) => ({ role: m.role, content: m.content ?? '' })),
    characters: ctx.characters,
    affections: ctx.affections,
    gameTime: ctx.gameTime,
    quests: ctx.quests,
    focusQuest: ctx.focusQuest,
    turn: ctx.history?.length ?? 0,
    charLoreBook: config?.worldBookIds?.[0] ?? '',
    projectId: 'builtin',
    engineVersion: undefined,
    lore: {
      get: (entryName, bookName) => {
        const { visible, bookOf } = getLoreIndex();
        const name = String(entryName ?? '');
        const hit = visible.find(
          (e) => e.name === name && (bookName === undefined || bookOf.get(e.uid) === bookName),
        );
        return hit ? (hit.content ?? '') : null;
      },
      list: (bookName) => {
        const { visible, bookOf } = getLoreIndex();
        return visible
          .filter((e) => bookOf.get(e.uid) === String(bookName ?? ''))
          .map((e) => e.name ?? '');
      },
    },
    notify: ctx.ejsNotify,
    log: ctx.ejsLog,
  };
}

function buildEjsPassContext(
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig | undefined,
  configs?: AgentConfig[],
  worldBooks?: WorldBook[],
): NonNullable<AgentContext['ejsPass']> {
  const sysVars = (ctx.variables?.sys ?? {}) as Record<string, any>;
  const draft = deepCloneVars(sysVars);

  if (config?.ejsVarsCommit === true && ctx.ejsVarsDrafts) {
    ctx.ejsVarsDrafts.set(agentId, { base: deepCloneVars(sysVars), draft });
  }

  return {
    stats: deepCloneVars(ctx.statData ?? {}),
    vars: draft,
    historyText: buildEjsHistoryText(agentId, ctx, config),
    // 🔴 少了这一行，§3.5-§3.12 的八个 namespace 在生产里全取默认空值：
    // `char.all()` 空数组、`quest.has()` 恒 false、`lore.get()` 恒 null、`ui.notify` 无出口。
    // 字段可选，所以漏接**编译期不报**——由 backend-parity 与 wiring 测试盯住（见 agent-templates.test.ts）。
    capabilities: buildCapabilityInput(agentId, ctx, config, configs, worldBooks),
    // 种子**不掺 agentId**：同一回合多个 Agent 装配同一条目时应看到同一个掷骰结果，
    // 否则「战斗 Agent 与叙事 Agent 对同一事件掷出不同的数」——那是分裂，不是随机（设计 §7）。
    seed: ctx.ejsSeed,
  };
}

/**
 * 把 EJS 回退条目送进 `ctx.ejsFallback`（带上书名，光有 uid 在 UI 上没法读）。
 *
 * 永不抛：诊断出口挂了不能反过来打断提示装配。
 */
function reportEjsFallback(
  agentId: string,
  ctx: AgentContext,
  entries: Array<{ uid: number; error: string }>,
  worldBooks: WorldBook[] | undefined,
): void {
  if (!ctx.ejsFallback || entries.length === 0) return;
  const bookOf = new Map<number, string>();
  for (const book of worldBooks ?? []) {
    for (const e of book.entries ?? []) bookOf.set(e.uid, book.name);
  }
  try {
    ctx.ejsFallback({
      agentId,
      entries: entries.map((f) => ({ uid: f.uid, bookName: bookOf.get(f.uid), error: f.error })),
    });
  } catch (err) {
    console.warn('[LORE_BOOK] EJS 回退诊断出口抛错（已忽略）:', err);
  }
}

// 🪦 Q-05：`formatCharacters` / `formatPlotEvents` 已删除。它们的最后调用点是 Q-04 删掉的
//    提示词闭包，此后是死代码；placeholder-registry 里那两份「Mirror of agent-templates」
//    才是现役实现（`{{CHARACTER_STATE}}` / `{{PLOT_EVENTS}}` 走它们）。
//    注意两边的空态串本就不同（这里返回「无角色数据」哨兵，placeholder 侧返回空串让占位符
//    渲染为空）——不是抄漏，别「统一」回来。本文件仍在用的是下面的 formatPlotEventsFull。

function formatGameTime(gt?: GameTime): string {
  if (!gt) return '';
  return (
    `${gt.era}${gt.year}年${MONTH_NAMES[gt.month - 1]}${gt.day}日 ` +
    `${String(gt.hour).padStart(2, '0')}:${String(gt.minute).padStart(2, '0')}`
  );
}

// ========== 剧情 Agent 动态上下文 (步5 每轮管线接线) ==========

/** 大纲摘要块: 标题/版本/摘要 + 当前章节 + 正文（截断）。大纲由 game-pipeline buildContext 挂到 ctx.plotOutline */
function formatPlotOutline(ctx: AgentContext): string {
  const o = (ctx as any).plotOutline as
    | {
        title?: string;
        summary?: string;
        content?: string;
        version?: number;
        directionAnchors?: string;
        chapters?: Array<{ title: string; summary: string; status: string }>;
      }
    | undefined
    | null;
  if (!o) return '';
  const lines: string[] = [];
  lines.push(
    `《${o.title || '未命名大纲'}》(v${o.version ?? 1})${o.summary ? ` — ${o.summary}` : ''}`,
  );
  if (o.directionAnchors) lines.push(`大方向锚: ${o.directionAnchors}`);
  const current =
    o.chapters?.find((c) => c.status === 'active') ??
    o.chapters?.find((c) => c.status === 'pending');
  if (current)
    lines.push(`当前大事件: ${current.title}${current.summary ? ` — ${current.summary}` : ''}`);
  if (o.chapters?.length) {
    lines.push(`大事件进度: ${o.chapters.map((c) => `${c.title}[${c.status}]`).join(' → ')}`);
  }
  if (o.content) lines.push(o.content.slice(0, 2000));
  return lines.join('\n');
}

/** 活跃/待触发事件全量列表（含 visibility=hidden——防剧透只在 UI 层，对 AI 必须可见）: 标题+描述+触发条件 + 大事件级 NPC议程/反事实基线 */
function formatPlotEventsFull(ctx: AgentContext): string {
  const events = (ctx.plotEvents ?? []).filter(
    (e) => e.status === 'active' || e.status === 'pending',
  );
  if (!events.length) return '';
  return events
    .map((e) => {
      const cond = e.triggerCondition ? `\n触发条件: ${e.triggerCondition}` : '';
      // 大事件（depth 0）附带 NPC 议程 + 反事实基线，供 post_check 做议程级演化判断
      const agendas = e.depth === 0 && e.npcAgendas ? `\nNPC议程: ${e.npcAgendas}` : '';
      const absent = e.depth === 0 && e.ifAbsent ? `\n不介入演化: ${e.ifAbsent}` : '';
      return `《${e.title}》(${e.status})\n${e.description.slice(0, 300)}${cond}${agendas}${absent}`;
    })
    .join('\n---\n');
}

/** 角色状态摘要（位置/时间/主角层级） */
function formatStateSummary(ctx: AgentContext): string {
  const parts: string[] = [];
  const time = formatGameTime(ctx.gameTime);
  if (time) parts.push(`时间: ${time}`);
  const player = ctx.characters?.find((c) => c.type === 'player') ?? ctx.characters?.[0];
  if (player?.location) parts.push(`位置: ${player.location}`);
  if (player) parts.push(`主角: ${player.name} Lv.${player.level} ${player.tierName}`);
  return parts.join(' | ');
}

/** plot_outline 动态注入: 剧情配置（含雷点/偏向）+ 位置/时间 + 近期剧情摘要 */
function formatPlotSettingsContext(ctx: AgentContext): string {
  const ps = ctx.plotSettings;
  if (!ps) return '';
  const lines: string[] = [`模式: ${ps.mode}`];
  if (ps.tabooContent)
    lines.push(`雷点（绝对禁止生成的内容，优先级高于一切偏好）: ${ps.tabooContent}`);
  if (ps.mode === 'main' && ps.main) {
    lines.push(`主线持续年份: ${ps.main.durationYears}`);
    lines.push(`世界书外NPC: ${ps.main.allowNonWorldbookNpc ? '允许' : '禁止'}`);
    if (ps.main.difficultyTier) lines.push(`难度层级: T${ps.main.difficultyTier}`);
    if (ps.main.genrePreference?.length)
      lines.push(`剧情偏向: ${ps.main.genrePreference.join('/')}`);
    if (ps.main.customPreference) lines.push(`自定义偏好: ${ps.main.customPreference}`);
  }
  if (ps.mode === 'side' && ps.side) {
    if (ps.side.focusRegion) lines.push(`专注区域: ${ps.side.focusRegion}`);
  }
  return lines.join('\n');
}

// ========== Agent Templates (Phase 10: Minimal Stubs) ==========
// 完整提示词存放位置:
//   - Story Agent: agent-config.json 的 preset → assemblePresetContent()
//   - 其他 Agent: agent-config.json 的 systemPrompt 字段
//   - 模板: placeholder-registry 的 {{PLACEHOLDER}} 模板（DEFAULT_TEMPLATES 覆盖全部 Agent）
// fixedSystem/fixedExamples 仅作类型占位和 systemPrompt 缺失时的兜底。
//
// 🪦 Q-04：variableContext/variableInstruction 两个闭包已删除。它们在 Phase 10 就被
//    placeholder-registry 取代，此后唯一调用点是 buildFallbackMessages —— 而那条路只在
//    「config.template 与 DEFAULT_TEMPLATES 双双为空」时才走，DEFAULT_TEMPLATES 补齐后
//    不再存在这样的 Agent。留着的后果是：改提示词的人改了闭包里的句子却毫无效果。

export const AGENT_TEMPLATES: Record<string, AgentPromptTemplate> = {
  // ---- memory_recall: 记忆召回 ----
  memory_recall: {
    fixedSystem:
      '记忆召回系统。你从记忆库中筛选与用户输入最相关的记忆条目，只返回真正相关的记忆，宁缺毋滥。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '{"memories": [{"id": "MEM000001", "relevance": 0.95, "reason": "匹配原因"}]}',
  },

  // ---- plot_pre_check: 剧情触发检查（正文前，Phase 4） ----
  plot_pre_check: {
    fixedSystem:
      '剧情触发检查系统。根据剧情大纲和当前状况，判断需要触发哪些剧情事件、需要召回哪些剧情背景信息。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"triggeredEvents": [{"title": "事件标题", "reason": "触发原因"}], "relevantBackground": "剧情背景摘要", "directive": "本轮推进建议"}',
  },

  // ---- story: 正文 AI (核心) ----
  story: {
    fixedSystem:
      '命定之诗叙事引擎。你生成下一段剧情正文，输出 <maintext>/<option>/<sum>/<vars> XML。使用第二人称"你"叙事，保持世界观一致性。完整提示词见 agent-config.json 和预设系统。',
    fixedExamples:
      '<maintext>示例正文</maintext>\n<option>选项A\n选项B</option>\n<sum>示例总结</sum>',
  },

  // ---- request_dispatcher: 请求调度器（原 vars_update）----
  request_dispatcher: {
    fixedSystem:
      '请求调度系统。分析正文后判断新-vs-已有角色/物品/制作，输出 <json> 全局变量 + XML request 标签分派给下游 Agent。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"replace": [{"path": "位置", "value": "白曜城"}], "delta": [{"path": "金钱", "amount": -50}]}',
  },

  // ---- vars_update: 变量更新（合并原 char_update + item_update，可选 Agentic）----
  vars_update: {
    fixedSystem:
      '角色/物品状态更新系统。根据请求调度器的标签更新角色状态和物品状态，必要时调用工具编写状态效果脚本。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"characters": {"replace": [{"name": "理查德", "path": "hp", "value": 88}]}, "items": {"consume": [{"owner": "理查德", "target": "治疗药水", "quantity": 1}]}}',
  },

  // ---- memory_summary: 记忆总结 ----
  memory_summary: {
    fixedSystem:
      '记忆压缩系统。每轮对话结束后将重要事件总结为结构化记忆（content/hiddenLine/keywords/importance）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"content": "详细记忆正文(>=200字)", "hiddenLine": "暗线线索", "keywords": ["关键词1", "关键词2"], "importance": 5}',
  },

  // ---- plot_post_check: 剧情修正（正文后，Phase 4） ----
  plot_post_check: {
    fixedSystem:
      '世界线修正系统。分析剧情发展是否导致世界线变动，判断是否需要修改剧情大纲和事件状态（minor/moderate/major）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"worldLineChanged": false, "changeLevel": "none", "outlineChanges": {"action": "none", "changes": ""}, "eventUpdates": [{"title": "事件标题", "action": "complete"}], "newChildEvents": []}',
  },

  // ---- plot_outline: 大纲生成（Phase 4） ----
  plot_outline: {
    fixedSystem:
      '大纲生成系统。根据剧情配置、世界观设定和角色信息生成完整剧情大纲（含章节划分和自检报告JSON）。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples:
      '{"title": "大纲标题", "summary": "一句话摘要", "content": "# 大纲内容...", "chapters": [{"title": "章节标题", "summary": "章节摘要", "keyEvents": [{"title": "", "description": "", "triggerHint": ""}]}], "selfCritique": {"score": 7}}',
  },

  // ---- craft_gen: 制作效果生成 (Phase 6e, Phase 9b 重写) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <craft_result> XML（含 <item_requests> 派发 item_gen）
  craft_gen: {
    fixedSystem:
      '制作系统。通过 tools 调用获取真实数据生成制作结果，输出 <craft_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  // ---- char_gen: 角色生成 (Phase 6e) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <char_result> XML（含 <skill_requests>/<equipment_requests>/<item_requests>）
  char_gen: {
    fixedSystem:
      '角色生成系统。通过 tools 调用获取真实随机值生成角色，输出 <char_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  // ---- item_gen: 物品生成 (Phase 9) ----
  // 完整提示词已迁移到 agent-config.json 的 systemPrompt 字段
  // 输出格式: <item_result> XML
  item_gen: {
    fixedSystem:
      '物品生成系统。基于 char_gen 输出通过 tools 生成技能/装备/道具，输出 <item_result> XML。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  // ---- combat: 战斗主持人 (M4 战斗 v2) ----
  // 完整提示词在 agent-config.json 的 systemPrompt 字段
  // 输出格式: 每回合战斗叙事 + 结束时 <combat_summary>
  combat: {
    fixedSystem:
      '战斗主持人系统。通过 tools 调用执行战斗动作（数值由代码计算），每回合输出战斗叙事，结束时输出 <combat_summary>。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  // ---- image_prompt: 情景插画的中文 → danbooru 侧链 (图像生成 G 阶段, D28) ----
  // 完整提示词在 agent-config.json 的 systemPrompt 字段（G 阶段先落临时最小版，D55）
  // 输出格式: <image_prompt> / <image_negative> / <image_desc> 三个 XML 标签
  // 🔴 它**不进** src/ui/components/settings/agent/agent-list.ts 的 AGENT_LIST（D53）——
  //    渲染在设置页第 13 分区「🖼 图像生成」，同一份配置不开两个入口。combat_v3 同例。
  image_prompt: {
    fixedSystem:
      '情景插画提示词系统。把 story 写的那句中文场景描述转成 danbooru 标签串，输出 <image_prompt>/<image_negative>/<image_desc>。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  // ---- v3 兼容别名: plot_check / plot_correct ----
  plot_check: {
    fixedSystem: '剧情规划系统。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },

  plot_correct: {
    fixedSystem: '剧情修正系统。完整提示词见 agent-config.json 和模板系统。',
    fixedExamples: '',
  },
};

// ========== 模板获取工具 ==========

/** 获取指定 Agent 的模板，不存在返回 undefined */
export function getAgentTemplate(agentId: string): AgentPromptTemplate | undefined {
  return AGENT_TEMPLATES[agentId];
}

/**
 * 步5: 剧情 Agent 的富上下文块 — 覆盖模板里的 {{PLOT_EVENTS}} 占位符。
 * 默认占位符只给 [id]+标题+截断描述，剧情 Agent 需要大纲/触发条件/状态摘要。
 * hidden 事件对 AI 必须可见（防剧透只在 UI 层）。
 */
export function buildPlotContextBlock(agentId: string, ctx: AgentContext): string {
  const parts: string[] = [];
  if (agentId === 'plot_outline') {
    const settings = formatPlotSettingsContext(ctx);
    if (settings) parts.push(`<剧情配置>\n${settings}\n</剧情配置>`);
  }
  const outline = formatPlotOutline(ctx);
  if (outline) parts.push(`<剧情大纲>\n${outline}\n</剧情大纲>`);
  const events = formatPlotEventsFull(ctx);
  if (events) parts.push(`<剧情事件列表>\n${events}\n</剧情事件列表>`);
  const state = formatStateSummary(ctx);
  if (state) parts.push(`<当前状态>\n${state}\n</当前状态>`);
  return parts.join('\n\n');
}

const PLOT_AGENT_IDS = new Set(['plot_pre_check', 'plot_post_check', 'plot_outline']);

/**
 * 检测 story 预设是否自带系统占位符区块（规范预设）。
 * 命中 → 预设内部已有 {{LORE_BOOK}}/{{USER_INPUT}} 等占位符，需预解析 + 简化 template（去重）。
 * 未命中（纯 ST 预设 / 测试桩）→ 走默认 template 追加兜底。
 */
const STORY_PRESET_PLACEHOLDER_RE =
  /\{\{(?:LORE_BOOK|LORE_BOOK_STATIC|LORE_BOOK_DYNAMIC|USER_INPUT|CHARACTER_STATE|GAME_TIME|NARRATIVE|AGENT\.MEMORY_RECALL|AGENT\.PLOT_PRE_CHECK)\}\}/;

/**
 * Phase 10: Build agent messages using the placeholder template system.
 *
 * For Story Agent: systemPrompt is assembled from preset entries via assemblePresetContent().
 * For other agents: systemPrompt comes from agent-config.json or fixedSystem fallback.
 *
 * The template system replaces old manual assembly (worldBookSection, variableSection, bodySection).
 * All content is resolved through {{PLACEHOLDER}} references in a unified template string.
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
  const config = configs?.find((c) => c.agentId === agentId);
  // 关键: 不可 mutate 原 ctx (orchestrator 同 stage 多 agent 共享), 用浅拷贝注入 agentConfig
  // 工坊 P2: 同时挂本 pass 的 EJS 求值上下文（stats 克隆 + vars 草稿 + 历史检索面），
  // 供 {{LORE_BOOK}} resolver / buildFallbackMessages 消费。
  // 🔴 `ctx.ejsPass` 已存在 → **复用**，不重建。
  //    `buildAgentMessagesAsync` 会先建好 pass 并跑完预渲染（含 vars 草稿写入 + ejsVarsDrafts 登记）；
  //    这里若重建，那份草稿连同 EJS 的写会被一个空的新草稿顶掉，静默丢状态。
  const tplCtx: AgentContext = {
    ...ctx,
    ...(config ? { agentConfig: config } : {}),
    ejsPass: ctx.ejsPass ?? buildEjsPassContext(agentId, ctx, config, configs, worldBooks),
  };

  // Step 1: Get the template string
  // Priority: 1) agent-config.json template field  2) getDefaultTemplate from placeholder-registry  3) empty string
  const configuredTemplate = config?.template || '';
  const defaultTemplate = getDefaultTemplate(agentId);
  const usesBuiltinDefaultTemplate =
    !configuredTemplate ||
    configuredTemplate.replace(/\r\n/g, '\n').trim() ===
      defaultTemplate.replace(/\r\n/g, '\n').trim();
  let template = configuredTemplate || defaultTemplate;
  // Q-04: 曾经这里落到 buildFallbackMessages（用 tpl.variableContext/variableInstruction 手工拼）。
  // DEFAULT_TEMPLATES 补齐全部 Agent 后不存在无模板的 Agent，「没模板 → null」是唯一分支。
  if (!template) return null;

  // Step 2: Assemble SYS_PROMPT content (Story uses preset, others use systemPrompt)
  let sysPromptContent = '';
  // 真机修(2026-07-23): story 规范预设自带 <本次任务信息参考> 区块（含全套系统占位符）时，
  // 预解析预设内部占位符 + 简化 template，避免与默认 template 的追加占位符重复渲染同一段数据。
  let storyPresetHasPlaceholders = false;

  if (agentId === 'story' && presets && config?.presetId) {
    // Story Agent: assemble from preset
    const preset = getPreset(config.presetId, presets);
    if (preset) {
      // ⚠️ 传 '' 并**不能**阻止默认块：assemblePresetContent 内部是
      //    `defaultContextBlock || DEFAULT_STORY_CONTEXT_BLOCK`，空串会落回默认块。
      //    实际行为：预设自带占位符 → 直接返回原文，不追加；预设不带占位符 → 追加
      //    DEFAULT_STORY_CONTEXT_BLOCK，随后下面的检测必然命中、走预解析把它就地渲染。
      //    两条路都不会重复渲染同一段数据，故结果正确，只是这里的 '' 是无效参数。
      const presetContent = assemblePresetContent(preset, '');
      storyPresetHasPlaceholders = STORY_PRESET_PLACEHOLDER_RE.test(presetContent);
      if (storyPresetHasPlaceholders) {
        // 规范预设内部写满 {{LORE_BOOK}}/{{CHARACTER_STATE}}/{{AGENT.MEMORY_RECALL}}/
        // {{NARRATIVE}}/{{USER_INPUT}} 等系统占位符。但 resolveTemplate 单层扫描只解析
        // template 原文、不递归解析 SYS_PROMPT 展开值内部（见 template-resolver.ts），
        // 这里对预设内容预跑一次 resolveTemplate，把内部占位符就地渲染成数据。
        // 收益: 数据在预设中部 <本次任务信息参考> 原地渲染一次（不重复），预设前半段
        // 静态内容保持稳定 → 缓存友好（动态字节仅落在预设中部的 MEMORY/NARRATIVE/INPUT 处，
        // 而非像旧实现那样动态 memory 排在 25 万字世界书之前导致整段 miss）。
        // 安全: 占位符正则 [A-Z] 开头，不会误伤小写 ST 宏（getvar/char/user 已由
        // assemblePresetContent 处理完毕）。
        sysPromptContent = resolveTemplateWithGlobals(
          presetContent,
          agentId,
          tplCtx,
          config ?? ({ agentId } as AgentConfig),
          worldBooks ?? [],
          configs ?? [],
          localParams ?? {},
        );
      } else {
        sysPromptContent = presetContent;
      }
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

  // story + 规范预设（已预解析内部占位符）+ 未自定义 template → 简化为 {{SYS_PROMPT}}，
  // 避免默认 template 追加的 {{LORE_BOOK}} 等与预设内部占位符重复渲染同一段数据。
  // 无预设 / 预设无占位符 / 自定义 template 场景仍走完整 template 兜底。
  if (agentId === 'story' && storyPresetHasPlaceholders && usesBuiltinDefaultTemplate) {
    template = '{{SYS_PROMPT}}';
  }

  // Step 3: Set globals and resolve
  const wbs = worldBooks ?? [];
  const cfgs = configs ?? [];

  // Build localParams with SYS_PROMPT override (the assembled preset/systemPrompt)
  const allLocalParams: Record<string, string> = {
    SYS_PROMPT: sysPromptContent,
    ...(localParams ?? {}),
  };

  // 步5: 剧情 Agent 用富上下文块覆盖 {{PLOT_EVENTS}}（大纲+触发条件+hidden事件+状态摘要）
  if (PLOT_AGENT_IDS.has(agentId) && !('PLOT_EVENTS' in allLocalParams)) {
    const plotBlock = buildPlotContextBlock(agentId, tplCtx);
    if (plotBlock) allLocalParams['PLOT_EVENTS'] = plotBlock;
  }

  const resolved = resolveTemplateWithGlobals(
    template,
    agentId,
    tplCtx,
    config ?? ({ agentId } as AgentConfig),
    wbs,
    cfgs,
    allLocalParams,
  );

  return [{ role: 'system', content: resolved }];
}

/**
 * 异步装配入口 —— **生产路径用这个**（能力面设计 §11 切片 T1）。
 *
 * 形态是「**异步预渲染 + 同步 resolver**」，刻意不把整条模板链改异步：
 *
 * ```
 * 建 pass 上下文 → await 预渲染世界书（唯一的异步点） → 灌进 ejsPass.loreRender
 *   → 同步 buildAgentMessages（{{LORE_BOOK}} resolver 只从 memo 挑段，不再求值）
 * ```
 *
 * 收益：`PlaceholderResolver` / `resolveTemplate` 的签名**一个字不改**（否则 227 个单测跟着塌），
 * 而 `await getwi(...)` 这类 async 条目能跑了，将来切 QuickJS 后端也只动预渲染这一步。
 *
 * ⚠️ 同步的 `buildAgentMessages` 仍然可用（测试/极端路径），只是遇到 async 条目会按 D8 回退原文。
 */
export async function buildAgentMessagesAsync(
  agentId: string,
  ctx: AgentContext,
  configs?: AgentConfig[],
  worldBooks?: WorldBook[],
  presets?: AgentPreset[],
  localParams?: Record<string, string>,
): Promise<Array<{ role: string; content: string }> | null> {
  if (!getAgentTemplate(agentId)) return null;

  const config = configs?.find((c) => c.agentId === agentId);
  const ejsPass = buildEjsPassContext(agentId, ctx, config, configs, worldBooks);

  if (configs && worldBooks) {
    const activeEntries = filterActiveEntries(getEntriesForAgent(agentId, configs, worldBooks));
    const rendered = await prerenderWorldBookEntries(activeEntries, ejsPass);
    ejsPass.loreRender = {
      agentId,
      staticText: rendered.staticText,
      dynamicText: rendered.dynamicText,
      fallbackEntries: rendered.fallbackEntries,
    };
    if (rendered.fallbackEntries.length > 0) {
      console.warn(
        `[LORE_BOOK] agent=${agentId} 有 ${rendered.fallbackEntries.length} 个条目 EJS 失败、已回退原文注入`,
      );
      // 同时送进诊断出口 —— console.warn 没人翻，DebugPanel 与导出 JSON 才是能被看到的地方
      reportEjsFallback(agentId, ctx, rendered.fallbackEntries, worldBooks);
    }
  }

  return buildAgentMessages(
    agentId,
    { ...ctx, ejsPass },
    configs,
    worldBooks,
    presets,
    localParams,
  );
}

/** 所有已注册的 Agent ID 列表 */
export const REGISTERED_AGENT_IDS = Object.keys(AGENT_TEMPLATES);
