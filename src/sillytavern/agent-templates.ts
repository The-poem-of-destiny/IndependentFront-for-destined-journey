/**
 * Agent Prompt 模板系统 — 每 Agent 固定前缀 + 可变后缀
 *
 * 设计原则:
 * - fixedSystem + fixedExamples = 缓存敏感前缀（不变则命中 DeepSeek 缓存）
 * - variableContext(ctx) + variableInstruction(ctx) = 每轮动态注入（追加在后，不影响缓存）
 *
 * Phase 4 更新:
 * - plot_check → plot_pre_check（正文前剧情触发）
 * - plot_correct → plot_post_check（正文后世界线修正）
 * - 新增 plot_outline 模板（大纲生成）
 *
 * Phase 8.5 更新:
 * - craft_gen / char_gen / item_gen 改为 Agentic 模式（function calling + XML 输出）
 *
 * 使用方式:
 *   const tpl = AGENT_TEMPLATES['story'];
 *   const systemPrompt = tpl.fixedSystem + '\n' + tpl.fixedExamples + '\n' + tpl.variableContext(ctx);
 *   const userMessage = tpl.variableInstruction(ctx);
 */

import type { AgentPromptTemplate, AgentContext, AgentConfig, AgentPreset, WorldBook } from './types';
import { getEntriesForAgent, filterActiveEntries, formatWorldBookEntries } from './worldbook-loader';
import { buildPresetSection, getPreset } from './preset-loader';
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

// ========== Agent Templates ==========

export const AGENT_TEMPLATES: Record<string, AgentPromptTemplate> = {

  // ---- memory_recall: 记忆召回 ----
  memory_recall: {
    fixedSystem:
`你是一个记忆召回系统。你的任务是根据用户输入，从提供的记忆库中筛选出最相关的记忆条目。

**规则:**
- 每条记忆有 ID、时间跨度、重要度(0-10)、正文内容
- 根据用户输入的关键词、主题、角色、地点进行语义匹配
- 只返回真正相关的记忆，宁缺毋滥
- 重要度高的记忆优先返回

**输出格式 (严格 JSON):**
{"memories": [{"id": "MEM000001", "relevance": 0.95, "reason": "匹配原因"}]}`,

    fixedExamples:
`**示例:**
用户: "去白曜城的铁匠铺"
记忆库有:
[MEM000001] 白曜城地图信息 | 重要度:7
[MEM000002] 上周在森林遇到的怪物 | 重要度:3
[MEM000003] 铁匠铺老板的委托 | 重要度:8

输出:
{"memories": [
  {"id": "MEM000003", "relevance": 0.95, "reason": "铁匠铺老板委托直接相关"},
  {"id": "MEM000001", "relevance": 0.80, "reason": "白曜城地理位置相关"}
]}`,

    variableContext: (ctx: AgentContext) => `
**当前记忆库:**
${formatMemories(ctx)}

**最近对话:**
${formatHistory(ctx)}`,

    variableInstruction: (ctx: AgentContext) => `用户输入: ${ctx.userInput}

请从记忆库中召回与此相关的记忆条目。`,
  },

  // ---- plot_pre_check: 剧情触发检查（正文前，Phase 4） ----
  plot_pre_check: {
    fixedSystem:
`你是一个剧情触发检查系统。你的任务是在正文生成之前，根据剧情大纲和当前状况，判断需要触发哪些剧情事件、需要召回哪些剧情背景信息。

**规则:**
- 阅读剧情大纲，了解当前阶段应该发生什么
- 根据用户输入、上一轮剧情、召回的记忆、角色状态，判断哪些 pending 事件应该转为 active
- 考虑事件的触发条件和时间窗口
- 如果有世界线变动标记的事件，优先处理
- 不要触发条件不满足的事件（宁缺毋滥）

**输出格式 (严格 JSON):**
{"triggeredEvents": [{"id": "事件ID", "reason": "触发原因"}], "relevantBackground": "需要注入到正文 prompt 的剧情背景信息摘要", "outlineRelevance": "当前大纲相关段落引用"}`,

    fixedExamples:
`**示例:**
剧情大纲: "第一章：主角抵达白曜城，与铁匠公会建立联系。关键事件：铁匠的委托任务。"

活跃事件:
[evt_01] 铁匠的请求 (pending) — 触发条件: 主角进入白曜城铁匠铺
[evt_02] 北境古墓传闻 (pending) — 触发条件: 获得古墓线索

用户: "我推开铁匠铺的门"

输出:
{"triggeredEvents": [{"id": "evt_01", "reason": "主角已进入铁匠铺，满足触发条件"}], "relevantBackground": "铁匠公会最近缺少矿石原料，正在寻找可靠的冒险者协助。铁匠是白曜城的关键情报来源。", "outlineRelevance": "第一章大纲要求与铁匠公会建立联系，铁匠的委托是第一个主要任务节点。"}`,

    variableContext: (ctx: AgentContext) => `
**活跃剧情事件:**
${formatPlotEvents(ctx)}

**召回的记忆:**
${formatMemories(ctx)}

**角色当前状态:**
${formatCharacters(ctx)}

**最近对话:**
${formatHistory(ctx)}`,

    variableInstruction: (ctx: AgentContext) => `**用户输入:** ${ctx.userInput}

请根据剧情大纲和当前状况，判断需要触发哪些剧情事件，以及需要注入哪些剧情背景信息。`,
  },

  // ---- story: 正文 AI (核心) ----
  story: {
    fixedSystem:
`你是《命定之诗》世界的叙事引擎。你的任务是根据上下文生成下一段剧情正文。

**输出必须严格遵循以下 XML 格式:**

<thinking>……</thinking>     ← 可选；你的思考过程，不展示给玩家
<maintext>……</maintext>     ← 必填；本回合的剧情正文，可多段，保留换行。以第二人称"你"叙事
<option>选项A标题
选项B标题
选项C标题</option>              ← 必填；至少2个选项，每行一个
<sum>……</sum>               ← 必填；本回合一句话总结
<vars>{"字段": 值}</vars>   ← 选填；需要更新的变量，JSON格式

**叙事准则:**
- 使用第二人称"你"来叙述
- 保持世界观一致性（奇幻中世纪背景）
- 根据角色性格和状态生成合理的反应
- 战斗中描述伤势和消耗感，但不要直接写"HP从85降到43"这种精确数值
- 选项要提供有意义的选择分支
- 每段正文 200-500 字

**⚠️ 数值规则 — 严禁在正文叙述中提及精确数值:**
- ❌ 禁止: "攻击力+15"、"消耗15点SP"、"恢复了20HP"、"好感度+5"、"T2中坚"
- ✅ 正确: 用自然语言描述 — "锋利的剑刃划破空气"、"她凝神瞄准，略微喘息"、"药水的暖流蔓延全身，伤口不再疼痛"、"老铁匠看你的眼神柔和了几分"
- 装备/技能/物品的效果用自然语言描述，绝不直接引用数值字段

**XML 标记协议 (可选，仅在需要时输出):**
- <craft_request expects="用户期望">制作意图</craft_request> — 触发制作
- <combat_trigger combatType="标准" environment="场景">战斗描述</combat_trigger> — 触发战斗
- <char_detect characterName="角色名" characterType="npc">角色描述</char_detect> — 标记新角色`,

    fixedExamples:
`**示例输出:**
<thinking>用户进入了铁匠铺，需要描述铁匠铺环境和铁匠的反应</thinking>
<maintext>你推开沉重的橡木门，热浪和金属撞击声扑面而来。铁匠铺里炉火正旺，一个身材魁梧的中年铁匠抬起头，用沾满煤灰的手擦了擦额头的汗。

"哦，是你啊，"老铁匠咧嘴一笑，"上次说的那批铁矿石带来了吗？我这正缺材料呢。"

你环顾四周，墙上挂满了各种武器和农具。角落里堆着等待修理的盔甲，其中一件胸甲上的裂痕格外显眼。</maintext>
<option>拿出铁矿石交给铁匠
询问那件破损胸甲的来历
推脱说还没准备好，转身离开</option>
<sum>你进入铁匠铺，铁匠询问铁矿石的情况</sum>
<vars>{"位置": "北方-诺斯加德-白曜城-五馆街-铁匠铺"}</vars>`,

    variableContext: (ctx: AgentContext) => {
      let prompt = '';

      // 注入世界书匹配内容
      const lorebook = formatLorebook(ctx);
      if (lorebook) {
        prompt += `**世界设定（当前场景相关）:**\n${lorebook}\n\n`;
      }

      // 注入召回的记忆
      const memories = formatMemories(ctx);
      if (memories !== '暂无相关记忆') {
        prompt += `**相关记忆:**\n${memories}\n\n`;
      }

      // 注入活跃剧情
      const plots = formatPlotEvents(ctx);
      if (plots !== '暂无活跃剧情事件') {
        prompt += `**当前剧情事件:**\n${plots}\n\n`;
      }

      // 注入角色状态
      prompt += `**在场角色:**\n${formatCharacters(ctx)}\n\n`;

      // 注入变量
      prompt += `**当前变量:**\n${formatVariables(ctx)}`;

      return prompt;
    },

    variableInstruction: (ctx: AgentContext) => {
      // 注入最近对话历史（作为 user message）
      return `**最近对话:**\n${formatHistory(ctx)}\n\n**玩家输入:** ${ctx.userInput}\n\n请生成下一段剧情。`;
    },
  },

  // ---- vars_update: 变量更新 ----
  vars_update: {
    fixedSystem:
`你是一个变量提取系统。根据正文 AI 的输出，提取需要更新的变量。

**支持的变量操作:**
- replace: 设置新值 {"path": "变量名", "value": 新值}
- delta: 数值增减 {"path": "变量名", "amount": +10 或 -5}
- insert: 数组插入 {"path": "数组变量名", "value": 新元素, "index": 可选}
  - delta_time: 时间推进 (分钟) {"delta_time": 180}

**注意:**
- 只提取正文中明确发生的变量变化
- 数值变化要精确（HP减少多少、金钱增减多少）
- 位置变化每次都要更新
- 新获得的物品/技能要 insert
  - 时间流逝用 delta_time 表示（分钟），如 "过了一小时" → delta_time: 60

**输出格式 (严格 JSON):**
{"replace": [{"path": "位置", "value": "北方-诺斯加德-白曜城-铁匠铺"}], "delta": [{"path": "金钱", "amount": -50}], "insert": [{"path": "背包", "value": {"name": "铁剑", "quantity": 1}}]}`,

    fixedExamples:
`**示例:**
当前变量: {"金钱": 200, "HP": 85, "背包": ["药水"], "位置": "北方-诺斯加德-白曜城-市集"}
正文: "你花了50G从铁匠那里买了一把新的铁剑，休息了一小时后继续上路。"

输出:
{"replace": [{"path": "位置", "value": "北方-诺斯加德-白曜城-五馆街-铁匠铺"}], "delta": [{"path": "金钱", "amount": -50}], "delta_time": 60, "insert": [{"path": "背包", "value": {"name": "铁剑", "quantity": 1, "type": "weapon"}}]}`,

    variableContext: (ctx: AgentContext) => `
**当前变量:**
${formatVariables(ctx)}

**当前角色状态:**
${formatCharacters(ctx)}`,

    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      // Phase 8.6: 默认注入 1 轮历史, 辅助判断"位置/时间"等指依赖前文的变化 (可配 historyLayers=0 关闭)
      return `${recentHistoryBlock(ctx)}**正文 AI 输出:**\n${storyOutput}\n\n请提取变量变更。`;
    },
  },

  // ---- char_update: 角色更新 ----
  char_update: {
    fixedSystem:
`你是一个角色状态更新系统。根据正文 AI 的输出，更新角色的状态。

**需要检测的变化:**
- HP/MP/SP 的变化（受伤、治疗、消耗）
- 经验值和等级变化
- 状态效果的添加/移除（中毒、眩晕、buff等）
- 装备变化（获得/丢失/装备/卸下）
- 技能变化（学习/遗忘）
- 位置变化
- 金钱变化
- 关系变化

**输出格式 (严格 JSON):**
返回完整的角色状态对象（基于当前状态，只修改有变化的部分）:
{"characters": [{"id": "角色ID", "changes": {"hp": 80, "statusEffects": [...], ...}}]}`,

    fixedExamples:
`**示例:**
当前角色: {"id": "player_1", "hp": 100, "maxHp": 100, "mp": 50, "statusEffects": []}
正文: "你被地精的匕首划伤了手臂（HP-12），但你及时喝下了一瓶治疗药水（HP+20）。"

输出:
{"characters": [{"id": "player_1", "changes": {"hp": 108}}]}`,

    variableContext: (ctx: AgentContext) => `
**当前角色状态:**
${formatCharacters(ctx)}

**当前变量:**
${formatVariables(ctx)}`,

    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      // Phase 8.6: 默认注入 1 轮历史, 辅助判断 HP/状态是否受了前文影响 (可配 historyLayers=0 关闭)
      return `${recentHistoryBlock(ctx)}**正文 AI 输出:**\n${storyOutput}\n\n请提取所有角色状态变化。对每个有变化的角色返回 changes 对象。`;
    },
  },

  // ---- memory_summary: 记忆总结 ----
  memory_summary: {
    fixedSystem:
`你是一个记忆总结系统。每轮对话结束后，将本回合的重要事件总结为一条结构化记忆。

**记忆格式:**
- id: MEM + 6位数字编号（由系统分配，你不需要生成）
- content (正文): ≥200字的详细叙述，对 AI 可见
- hiddenLine (暗线): 一句话概括的隐藏线索，仅引擎使用
- keywords: 3-8个关键词
- importance: 1-10的重要度评分
  - 1-3: 日常对话、闲逛
  - 4-6: 有信息量的互动、物品获取
  - 7-8: 战斗、重要剧情推进
  - 9-10: 重大转折、角色死亡、世界线变动

**输出格式 (严格 JSON):**
{"content": "正文内容(≥200字)", "hiddenLine": "暗线内容", "keywords": ["关键词1", "关键词2"], "importance": 5, "timeRangeStart": "游戏时间开始", "timeRangeEnd": "游戏时间结束"}`,

    fixedExamples:
`**示例:**
正文: "你在铁匠铺交付了10块铁矿石，铁匠满意地收下并支付了50G报酬。他还提到了最近有人在打听关于北境古墓的消息。"

输出:
{"content": "主角前往白曜城铁匠铺，向铁匠交付了10块铁矿石，完成了委托任务。铁匠支付了50G报酬。在交谈中，铁匠透露了最近有可疑人物在打听北境古墓的消息，这似乎与最近城中增多的外来冒险者有关。铁匠提醒主角小心那些来历不明的人。这次委托的完成也让铁匠对主角的信任有所增加。", "hiddenLine": "铁匠委托完成，北境古墓线索出现", "keywords": ["铁匠铺", "铁矿石", "委托完成", "北境古墓", "外来冒险者", "报酬"], "importance": 6, "timeRangeStart": "光辉纪元001年-05月-24日-15:30", "timeRangeEnd": "光辉纪元001年-05月-24日-16:00"}`,

    variableContext: (ctx: AgentContext) => `
**最近对话历史:**
${formatHistory(ctx)}

**当前变量状态:**
${formatVariables(ctx)}

**活跃剧情事件:**
${formatPlotEvents(ctx)}`,

    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `**本轮正文 AI 输出:**\n${storyOutput}\n\n**用户输入:** ${ctx.userInput}\n\n请为本轮对话生成一条记忆记录。`;
    },
  },

  // ---- plot_post_check: 剧情修正（正文后，Phase 4） ----
  plot_post_check: {
    fixedSystem:
`你是一个剧情修正与世界线管理系统。你的任务是在正文生成之后，分析剧情发展是否导致世界线变动，以及是否需要修改剧情大纲和事件状态。

**分析维度:**
1. **世界线变动检测:** 玩家的选择/行为是否改变了原本预设的剧情走向？
2. **大纲修正:** 是否需要调整剧情大纲（添加/修改/删除章节）？
3. **事件状态更新:** 哪些事件已完成/失败/需要跳过？
4. **子事件生成:** 是否有新的事件分支需要创建？
5. **世界线传播:** 如果某个事件发生了变动，是否影响其子事件？

**世界线变动等级:**
- minor: 小范围调整（如任务完成方式不同）
- moderate: 中等影响（如改变了某个角色的立场）
- major: 重大转折（如主要角色死亡、阵营变更）

**输出格式 (严格 JSON):**
{"worldLineChanged": false, "changeLevel": "none|minor|moderate|major", "outlineChanges": {"action": "none|update|addChapter|removeChapter", "changes": "大纲修改内容"}, "eventUpdates": [{"id": "事件ID", "action": "update|addChild|skip|fail|complete", "changes": {"status": "新状态", "description": "更新后的描述"}}], "newChildEvents": [{"title": "子事件标题", "description": "描述", "triggerCondition": "触发条件", "depth": 1}]}`,

    fixedExamples:
`**示例:**
当前大纲: "第一章：主角帮助铁匠解决矿石短缺问题。"
活跃事件: [evt_01] 铁匠的请求 (active)
正文: 主角不仅交付了铁矿石，还发现矿石短缺是因为北境矿场被山贼占据。主角承诺帮助铁匠解决山贼问题。

输出:
{"worldLineChanged": true, "changeLevel": "moderate", "outlineChanges": {"action": "addChapter", "changes": "在第一章后新增 1.5章：清理北境矿场的山贼。主角已主动承诺帮助，这是重要的剧情分支。"}, "eventUpdates": [{"id": "evt_01", "action": "complete", "changes": {"status": "completed", "description": "铁匠的请求完成——主角交付了矿石并发现了更深层的问题"}}], "newChildEvents": [{"title": "调查北境矿场", "description": "前往北境矿场调查山贼占据的情况", "triggerCondition": "主角抵达北境矿场", "depth": 1}, {"title": "清理山贼", "description": "击败占据矿场的山贼团伙", "triggerCondition": "主角决定动手清理山贼", "depth": 1}]}`,

    variableContext: (ctx: AgentContext) => `
**活跃剧情事件:**
${formatPlotEvents(ctx)}

**召回的记忆:**
${formatMemories(ctx)}

**角色当前状态:**
${formatCharacters(ctx)}

**最近对话:**
${formatHistory(ctx)}`,

    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `**本轮正文 AI 输出:**\n${storyOutput}\n\n**用户输入:** ${ctx.userInput}\n\n请分析是否有世界线变动，是否需要修改大纲，以及需要更新哪些剧情事件。`;
    },
  },

  // ---- plot_outline: 大纲生成（Phase 4） ----
  plot_outline: {
    fixedSystem:
`你是一个剧情大纲生成系统。你的任务是根据剧情配置、世界观设定和角色信息，生成一份完整且精彩的剧情大纲。

**大纲要求:**
- 结构清晰：分为若干个章节/阶段，每阶段有明确的目标和关键事件
- 可玩性：提供丰富的选择分支和不同的结局走向
- 适配角色：根据角色的背景、能力和性格设计专属剧情线
- 难度合理：事件难度与剧情配置中的层级匹配

**输出格式 (严格 JSON):**
{"content": "完整的大纲文本（Markdown格式，包含章节标题和叙述）", "chapters": [{"title": "章节标题", "summary": "章节摘要", "keyEvents": ["关键事件1", "关键事件2"], "estimatedDuration": "预计持续的游戏时间"}], "selfCritique": {"score": 8, "strengths": ["优点1", "优点2"], "weaknesses": ["不足1"], "suggestions": ["改进建议1"]}}`,

    fixedExamples:
`**示例输出:**
{"content": "# 第一章：白曜城的新人冒险者\\n\\n主角抵达北方重镇白曜城，在这里开始冒险者生涯。通过与铁匠公会的互动，主角逐渐了解了城中的势力分布和潜在的威胁...", "chapters": [{"title": "白曜城的初遇", "summary": "主角抵达白曜城，完成铁匠委托任务，了解城中势力", "keyEvents": ["抵达白曜城", "铁匠委托", "北境古墓传闻"], "estimatedDuration": "1-2周（游戏时间）"}], "selfCritique": {"score": 7, "strengths": ["结构清晰", "节奏合理"], "weaknesses": ["中期冲突不够激烈"], "suggestions": ["可以在第二章引入意外的对手"]}}`,

    variableContext: (ctx: AgentContext) => `
**角色信息:**
${formatCharacters(ctx)}

**剧情事件:**
${formatPlotEvents(ctx)}

**当前变量:**
${formatVariables(ctx)}`,

    variableInstruction: (ctx: AgentContext) => {
      return `**用户输入:** ${ctx.userInput}

请根据以上信息生成一份剧情大纲。大纲需要包含完整的叙事内容、章节划分和自检报告。`;
    },
  },

  // ---- craft_gen: 制作效果生成 (Phase 6e) ----
  // 🚩 Phase 8.5 Agentic: 延迟型，AI 通过 tools 调用真实工具获取数值，最终输出 <craft_result> XML
  craft_gen: {
    fixedSystem:
`你是一个制作系统 AI。你可以调用 **function calling 工具** 来获取真实数据。

**可用工具:**
- roll_d20: 掷d20检定骰（加值/优势/劣势）
- roll_d100: 掷d100百分比骰
- roll_dice: 掷任意骰子公式（如 2d6）
- craft_check: 执行完整制作检定 — 输入角色/行业/品质/材料，返回真实DC+骰值+评级
- craft_get_base_dc: 查询某品质的基准 DC
- craft_get_production_bonus: 查询某品质的产能加成
- get_character: 查询角色属性/装备/资源
- get_hp_percent: 查询角色 HP 百分比

**工作流程:**
1. 调用 get_character 获取制作者数据
2. 调用 craft_check 获取真实检定结果（禁止自己编造 DC 值/d20 值）
3. 解读检定结果（大失败/失败/成功/精益求精）
4. 成功时根据 expects 需求 brainstorm 创意效果词条
5. 生成制作叙事片段
6. 输出最终 <craft_result> XML

**⚠️ 绝对禁止: 编造任何数值。DC、骰值、评级必须来自工具返回。**

**输出格式 (严格 XML):**
<craft_result>
<success>true/false</success>
<product_name>制品名称</product_name>
<quality>品质</quality>
<check_summary>检定简述（如"DC12，d20=15+5=20，精益求精"）</check_summary>
<creative_effects>
<effect name="词条名" type="增益|减益|特殊" atk="0" def="0" hp="0" mp="0" sp="0" dot="0" dotType="" duration="" durationUnit="回合" stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="" scripts="">效果描述</effect>
</creative_effects>
<narrative>制作叙事（200-400字，第二人称"你"，注入回正文）</narrative>
<craft_params>
<industry>行业</industry>
<target_quality>品质</target_quality>
<quantity>数量</quantity>
<materials>材料列表</materials>
</craft_params>
</craft_result>`,

    fixedExamples:
`**示例:**
上下文: Lv.5 锻造师(T1)，精炼铁矿石×3。
<craft_request expects="锋利到能斩断树枝">制作一把锋利的长剑</craft_request>

步骤1 — 调用 get_character({characterId:"player_1"}) → 获取角色属性
步骤2 — 调用 craft_check({characterId:"player_1",industry:"锻造",targetQuality:"普通",productName:"长剑",materials:[...]})
       → 返回: {baseDC:6,materialDCModifier:0,finalDC:6,diceValue:15,totalValue:20,rating:"精益求精"}
步骤3 — 输出最终 XML:

<craft_result>
<success>true</success>
<product_name>精铁长剑</product_name>
<quality>普通</quality>
<check_summary>DC6，d20掷出15+5(力量)=20，总检定值20，评级: 精益求精</check_summary>
<creative_effects>
<effect name="精铁刃" type="增益" atk="5" def="0" hp="0" mp="0" sp="0" dot="0" dotType="" duration="" durationUnit="回合" stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="">剑刃经过反复锻打与精细研磨，切削力出众，能轻易斩断细枝</effect>
<effect name="锻火余温" type="特殊" atk="0" def="0" hp="0" mp="0" sp="0" dot="0" dotType="" duration="" durationUnit="回合" stackable="false" maxStacks="1" dc="0" dcAttr="" appliesStatus="">剑身隐约残留着锻炉的余温，触碰时有微弱的暖意</effect>
</creative_effects>
<narrative>你握紧铁锤，将烧红的铁块放在铁砧上。火星四溅，叮叮当当的锻打声回荡在铁匠铺中。你反复折叠锻打，让剑刃的纹理如流水般致密。淬火时白雾升腾，一把闪烁着寒光的长剑在水中逐渐成型。最后用磨石细细打磨，剑刃锋利得能吹毛断发。</narrative>
<craft_params>
<industry>锻造</industry>
<target_quality>普通</target_quality>
<quantity>1</quantity>
<materials>精炼铁矿石×3</materials>
</craft_params>
</craft_result>`,

    variableContext: (ctx: AgentContext) => {
      let prompt = '';
      const lorebook = formatLorebook(ctx);
      if (lorebook) prompt += `**世界设定:**\n${lorebook}\n\n`;
      prompt += `**角色状态:**\n${formatCharacters(ctx)}\n\n`;
      prompt += `**当前变量:**\n${formatVariables(ctx)}`;
      return prompt;
    },

    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      // Phase 8.6: 默认注入 1 轮历史, 辅助判断制作意图的连续性 (可配 historyLayers=0 关闭)
      return `${recentHistoryBlock(ctx)}**正文输出 (含 <craft_request> 标记):**\n${storyOutput}\n\n请调用工具获取真实数据（不要编造数值），然后输出 craft_result。`;
    },
  },

  // ---- char_gen: 角色生成 (Phase 6e) ----
  // 👤 Phase 8.5 Agentic: AI 通过 tools 调用随机表获取真实随机值
  // 🆕 Phase 8.6: 扩展字段对齐世界书 §角色生成 — 衣物/喜爱/性别/阵营/登神子结构/技能/装备/物品 + 异步 call_item_gen
  char_gen: {
    fixedSystem:
`你是一个角色生成 AI。你可以调用 **function calling 工具** 来获取真实的随机值和数据。

**可用工具:**
- random_name: 随机生成符合种族/性别的中文名
- random_hair_color: 随机生成符合种族的发色
- random_eye_color: 随机生成符合种族的瞳色
- random_personality: 随机生成 wOaGz(A) 五维性格编码
- random_appearance: 随机生成外貌摘要（外观年龄、体型。发色瞳色请单独调用 random_hair_color / random_eye_color）
- roll_attributes: 按生命层级随机生成五维属性（自动遵循上限和总和约束）
- roll_d20/roll_d100/roll_dice: 掷骰（用于等级/层级随机/技能数量随机）
- get_character: 查询已有角色（避免重名）
- call_item_gen: 异步派发物品生成子 Agent — 传入摘要后立即返回 ack，不等待完成

---
# 核心原则 — 正文优先

**<char_detect> 中的角色描述是权威来源。** 正文明确说了的特性（外貌/种族/层级/身份/伤疤/残疾/年龄/性别等）必须原样保留，工具随机值只能填充正文**未提及**的部分。

---
# ⚠️ 已有角色复用规则（最高优先级）

**<char_detect> 标记中的角色名如果在已有角色列表中存在同名角色，必须认定为同一角色。**
此时:
1. **跳过所有随机工具调用**（random_name / random_hair_color / random_eye_color / random_personality / random_appearance / roll_attributes 全部跳过）
2. **使用已有角色列表中该角色的所有实际数据**（name / race / tier / level / identity / occupation / attributes / appearance 描述 / 背景 / 性格等）作为基础
3. **结合 <char_detect> 中的新增描述做微调**（如果正文中新出现了已有角色没提到的新特征，才补充进去）
4. 已有的装备/技能/物品可适当扩充（根据上文中的剧情发展）
5. 最终输出完整 <char_result> XML（不得缺字段）

**判断同名的逻辑**: 仅看角色名本身，不区分大小写。"绮萝莉娅" = "绮萝莉娅"。如果名字完全一致就是同一人，不用再纠结。

**示例**: 已有角色 "[npc:绮萝莉娅] Lv.19 传说 | 身份:古代教团圣女" → char_detect 要的是"绮萝莉娅" → 同名 → 跳过随机 → 直接用已有数据生成 XML。

**示例**: 已有角色列表中存在"老铁匠"，<char_detect characterName="老铁匠"> ← 同名，跳过随机，用已有数据。

---
# 思考深度要求

在调用任何工具之前，你必须先进行充足的思考（至少500字中文），逐条分析：

1. **已有角色检查（最高优先级）**: <char_detect> 中的角色名是否在上文已有角色列表中出现？如果是，必须认定为同一角色，**跳过所有随机调用**，直接复用已有数据
2. **<char_detect> 中的角色定位**: 这个角色在当前场景中的作用？是临时NPC还是重要角色？与已有角色的关系？
3. **正文中已明确的信息**: 逐条列出正文中已明确提到的所有特征（性别/种族/层级/外貌/身份/特殊状态）——这些必须保留，不可被工具覆盖
4. **环境一致性**: 当前世界的时间、地点、势力背景是什么？该角色出现在此地的动机是否合理？
5. **背景推导**: 从角色的身份/职业/外貌出发，推导一个符合世界观的背景故事（≥150字）
6. **技能与装备设计**: 根据角色的层级(tier)、职业、背景故事，设计合理数量和类型的技能/装备/物品（见下文的 Tier 匹配表）
7. **与已有角色（非同名的）的关系**: 检查已有角色列表，看看是否存在潜在的联系或冲突

（你的思考过程不需要展示给用户，但会影响生成质量。请在最终的 <char_result> 之前或期间充分思考。）

---
**工作流程:**
1. 先进行至少500字中文思考（见上方要求）。**首先检查是否有同名已有角色！**
2. 如果同名已有角色存在 → 跳过步骤 3-5，直接进入步骤 6
3. 调用 get_character 查重
4. 根据正文描述确定种族、性别和 tier（正文未提则合理推断）
5. 调用 random_name → random_hair_color → random_eye_color → random_appearance（正文已明确的特性保留，只用工具填充未提及的部分）
6. 调用 random_personality → roll_attributes
7. 根据角色的背景/职业/Tier，思考角色需要什么样的技能、装备、物品，向 item_gen 描述清楚需求理由（不要写具体数值！）
8. 调用 call_item_gen 派发异步任务（skillsSummary/equipmentSummary/inventorySummary 应包含需求理由，不仅列名称；立即返回 ack 不等待）
9. 综合所有数据，输出完整 <char_result> XML，其中 <skill_requests>/<equipment_requests>/<item_requests> 写详细需求描述

**⚠️ 绝对禁止: 自己编造名字、发色、瞳色、性格编码。必须调用工具获取随机值。但如果同名已有角色存在，直接用已有数据，不调用随机工具。**
**⚠️ 绝对禁止: 在 <skill_requests>/<equipment_requests>/<item_requests> 中写任何具体数值（伤害/加成/消耗/冷却秒数/百分比）。只描述需求方向和理由。数值由 item_gen 通过 tools 计算。**
**⚠️ 绝对禁止: 不要生成叙事场景或额外的叙事正文！你的唯一输出是 <char_result> XML。不要写任何小说段落、对话、场景描写。**
**⚠️ 如果没有检测到 <char_detect> 标记，输出 <char_result><error>no char_detect found</error></char_result>，不要凭空编造角色。**

---
# Tier 匹配表（对齐世界书 #261442 + #265160）

| Tier | 技能数 | 装备数 | 物品数 | 品质上限 |
|------|--------|--------|--------|---------|
| T1   | 1-2    | 1-2    | 0-1    | 优良    |
| T2   | 2-3    | 2      | 1-2    | 稀有    |
| T3   | 3-4    | 2-3    | 1-2    | 史诗    |
| T4   | 3-5    | 3-4    | 2-3    | 传说    |
| T5   | 4-5    | 4-5    | 2-3    | 神话    |
| T6   | 5-7    | 5+     | 3+     | 神话+   |
| T7   | 完整技能树 | 全部 | 全部 | 唯一    |

**技能/装备/物品的数量用 roll_dice 确定。char_gen 只写需求描述（理由/方向），具体属性/数值/品质由 item_gen 生成。在 call_item_gen 的摘要中说明每个需求为什么需要、和角色背景有什么关联。**

---
**输出格式 (严格 XML):**
<char_result>
<name>名称</name>
<race>种族</race>
<gender>女</gender>
<faction>所属势力（可选）</faction>
<tier>生命层级(1-7)</tier>
<level>等级(1-25)</level>
<attributes str="6" dex="5" con="5" int="4" spi="5"/>
<identity>身份1, 身份2</identity>
<occupation>职业1, 职业2</occupation>
<background>角色背景故事（≥150字，含出场动机/与当前场景关联/世界观一致性）</background>
<appearance>裸体外貌描述（100-200字，含发色/瞳色/体型/肤色/私密部位特征，正文已明确的必须保留）</appearance>
<clothing>衣物装饰（80-150字，全身从头到脚，含配饰/鞋/斗篷等）</clothing>
<personality code="wOaGz(A)">性格描述（40-80字，从工具返回的code展开，结合正文中的言行推导具体性格）</personality>
<likes>喜爱/偏好（20-50字，该角色喜欢的事物、兴趣、嗜好）</likes>
<ascension enabled="false" path="" description="">
  <element name="" description="">效果</element>
  <authority name="" description="" cost="">效果</authority>
  <law name="" passive="" active="" cost="" description=""/>
  <deity_position/>
  <kingdom name="" description=""/>
</ascension>
<skill_requests>
  <request>需求描述 — 说明*为什么*需要这个技能、大致的技能定位（攻击/防御/治疗/辅助/控制/生产/社交/调查等），以及该技能如何体现角色的背景/性格/职业特征。</request>
</skill_requests>
<equipment_requests>
  <request slot="槽位">需求描述 — 说明*为什么*需要这件装备、大致的装备类型（武器/防具/饰品/工具），以及该装备在角色背景故事或当前任务中的意义。</request>
</equipment_requests>
<item_requests>
  <request>需求描述 — 说明*为什么*需要这个物品、大致物品类型（消耗品/材料/任务物品/贵重品），以及该物品在角色故事中的作用。</request>
</item_requests>
</char_result>`,
    fixedExamples:
`**示例 1: 正文中有明确特征的覆盖规则 + 完整字段**

正文中出现: <char_detect characterName="老铁匠" characterType="npc">一个浑身伤疤的独臂老兵，沉默寡言地在铁砧前锻打</char_detect>

思考过程（摘要）:
- 正文明确: 浑身伤疤、独臂、老兵、沉默寡言、铁匠、男性 → 这些必须保留
- 正文未提: 具体发色、瞳色、年龄、衣服、喜好 → 可以用工具随机
- 身份推导: "老兵"说明至少参加过战争，T2 退役佣兵级别合理
- 技能设计: T2 → 2-3个技能。老兵+铁匠 → 1个战斗技能(锤击)+1个生产技能(锻造)
- 背景推导: 曾在某场战役中失去手臂，退伍后在白曜城开了这家铁匠铺

步骤1 — 调用 get_character({}) → 查重通过
步骤2 — 调用 random_name({race:"人类",gender:"男"}) → {name:"格雷厄姆·铁砧"}
步骤3 — 调用 random_hair_color({race:"人类"}) → {color:"花白灰色"}
步骤4 — 调用 random_eye_color({race:"人类"}) → {color:"灰褐色"}
步骤5 — 调用 random_personality({}) → {code:"w-aG-z+(S)",description:"疏离冷淡，主见适度，安静内敛，稳定恒心"}
步骤6 — 调用 roll_attributes({tier:2,level:7}) → {str:11,dex:5,con:10,int:5,spi:4}
步骤7 — 调用 call_item_gen({characterName:"格雷厄姆·铁砧",tier:2,skillsSummary:"1.锤击:主动攻击技能,挥锤猛击 2.老兵锻打:被动制造技能,提升武器品质",equipmentSummary:"1.锻铁锤:武器,攻击力+15 2.皮围裙:身体,防御力+8",inventorySummary:"1.磨刀石×3:消耗品,临时提升武器伤害 2.老兵徽章×1:任务物品,身份证明"})
→ {status:"dispatched",message:"item_gen 已收到…正在异步生成中。"} (立即 ack，不阻塞)
步骤8 — 输出:

<char_result>
<name>格雷厄姆·铁砧</name>
<race>人类</race>
<gender>男</gender>
<faction>奥古斯提姆帝国（退役）</faction>
<tier>2</tier>
<level>7</level>
<attributes str="11" dex="5" con="10" int="5" spi="4"/>
<identity>白曜城铁匠, 退役老兵</identity>
<occupation>铁匠, 武器匠人</occupation>
<background>格雷厄姆曾在奥古斯提姆帝国与兽族联盟的边境战争中服役十五年，一场惨烈的伏击战让他失去了左臂，也让他永远告别了军旅生涯。退伍后他带着抚恤金来到白曜城，凭着从小跟父亲学的打铁手艺开了一家铁匠铺。十年的锻打生涯让他的独臂变得异常强壮，而满身的伤疤则是沉默的勋章——每一道都有一段他不愿提起的故事。</background>
<appearance>年近五十的魁梧老兵，花白灰色的短发凌乱地贴在额头上。裸露的右臂上布满交错的旧伤疤，左臂从肘部以下截断，套着一个老旧的皮革护套。灰褐色的眼眸中透着经历过生死的沉静，脸上常年挂着煤灰和汗渍。胸膛宽阔，腹部因年龄略显松弛，常年站立锻打让他的双腿粗壮有力。右臂肌肉发达，手掌粗糙如砂纸。</appearance>
<clothing>上身光膀，只围一条被火星烧出无数小洞的厚皮革围裙。下身一条粗麻布长裤，膝盖处已经磨得发白。脚上一双铁头工靴，鞋面布满铁屑和煤灰。</clothing>
<personality code="w-aG-z+(S)">极度沉默寡言，不擅寒暄，用最短的句子回答顾客的问题。但对武器有近乎偏执的追求——"刀不行就是不行，多说没用"。偶尔对熟客多聊两句，但也仅限于武器的话题。</personality>
<likes>趁手的锻铁锤，淬火时水蒸气的嘶嘶声，刀刃开锋后的第一道寒光。喜欢在铁砧前独处，享受金属在锤下变形的节奏感。</likes>
<ascension enabled="false" path="" description=""/>
<skill_requests>
  <request>近战物理攻击技:多年独臂锻打让右臂力量远超常人，需要一个能体现力量集中的锤击技，对单体造成高额物理伤害，附破甲效果。独臂老兵的身份让这一击比常人更有威力。</request>
  <request>被动锻造技能:十五年军旅加十年铁匠经验，锻造武器时品质应有额外保障。这个技能是角色"老兵转身为铁匠"的身份核心。</request>
</skill_requests>
<equipment_requests>
  <request slot="武器">锻铁锤:不是普通铁锤，是陪伴他十年的趁手工具，比任何精制武器都有感情。应有一定攻击加成和命中率加成。</request>
  <request slot="身体">皮围裙:厚重坚韧的皮革围裙，布满火星灼烧的痕迹但依然可靠，是铁匠身份的标志性装备。</request>
</equipment_requests>
<item_requests>
  <request>磨刀石(消耗品):铁匠随身携带的日常用品，可临时强化武器锋利度。体现角色职业习惯。</request>
  <request>老兵徽章(任务物品):帝国颁发的退役证明，证明主人的过去身份。可凭证领取抚恤金，也可在某些场合作为身份象征。</request>
</item_requests>
</char_result>

（注意：正文说的"伤疤""独臂""老兵""沉默寡言"全部保留；发色/瞳色/衣服正文未提，用了工具随机值。技能/装备/物品 char_gen 只写需求描述（为什么需要、大致方向、与背景关联），不写具体数值；具体生成由 item_gen 负责。call_item_gen 的摘要应该详细说明需求理由而不只是名称。）

---

**示例 2: 复杂角色 — 贵族出身的神秘访客 (含登神长阶)**

正文中出现: <char_detect characterName="神秘女子" characterType="npc">一位穿着暗紫色丝绒斗篷的年轻女子，举止优雅，袖口绣着帝国贵族的金线家徽</char_detect>

步骤1 — 调用 get_character({}) → 查重通过
步骤2 — 调用 random_name({race:"人类",gender:"女"}) → {name:"塞西莉亚·奥古斯都"}
步骤3 — 调用 random_hair_color({race:"人类"}) → {color:"深棕色"}
步骤4 — 调用 random_eye_color({race:"人类"}) → {color:"琥珀色"}
步骤5 — 调用 random_personality({}) → {code:"wO+aGz+(A)"}
步骤6 — 调用 roll_attributes({tier:3,level:11}) → {str:4,dex:8,con:5,int:12,spi:10}
步骤7 — 调用 call_item_gen({characterName:"塞西莉亚·奥古斯都",tier:3,skillsSummary:"1.秘法护盾:被动防御,智力加成护盾 2.贵族交涉:主动社交,魅惑+说服 3.火球术:主动攻击,范围火焰伤害",equipmentSummary:"1.秘银权杖:武器,智力+4 2.丝绒斗篷:身体,防御力+15 3.贵族徽章:饰品,魅力+2",inventorySummary:"1.魔法墨水×2:材料,用于抄写法术卷轴 2.贵族邀请函×1:任务物品"})
→ {status:"dispatched"} (立即 ack)
步骤8 — 输出:

<char_result>
<name>塞西莉亚·奥古斯都</name>
<race>人类</race>
<gender>女</gender>
<faction>奥古斯提姆帝国贵族</faction>
<tier>3</tier>
<level>11</level>
<attributes str="4" dex="8" con="5" int="12" spi="10"/>
<identity>奥古斯提姆帝国子爵之女, 皇家学院讲师</identity>
<occupation>魔法学者, 贵族外交官</occupation>
<background>塞西莉亚出身于奥古斯提姆帝国最古老的贵族世家之一——奥古斯都家族。她的父亲是帝国西部行省的世袭子爵，但塞西莉亚从小对政治不感兴趣，反而沉迷于皇家学院的古籍和魔法研究。凭借家族地位和个人才智，她在26岁就获得了皇家学院魔法理论系的讲师职位。然而最近她在古籍中发现了一段关于"失亡彼岸"的记载，引起了她的警觉——她相信这与帝国边境近来频繁的失踪事件有关。她来到白曜城是为了寻找一位能够帮她解读这段文字的人。</background>
<appearance>一位二十出头的年轻女性，深棕色长发整齐地束在脑后，几缕碎发垂在额前。琥珀色的眼眸中闪烁着属于学者的锐利光芒。手指修长白皙，指尖因常年翻阅古籍而略微粗糙。胸部不大但形状优美，腰肢纤细，双腿修长。皮肤白皙如瓷器，在阳光下几乎透明。</appearance>
<clothing>身着暗紫色丝绒斗篷，内搭白色亚麻衬衫和深灰色束腰长裙。袖口绣着交叉剑与月桂花环的金线家徽。腰间系一条银色细链，挂着一枚蔷薇形魔法水晶吊坠。脚踩黑色小羊皮短靴。</clothing>
<personality code="wO+aGz+(A)">外表温和有礼但始终保持距离，对人热情但不说实话。极度聪明且自知，善于利用自己的贵族身份和学识在社交场合周旋。内心深处对家族的政治阴谋感到厌倦，渴望通过学术研究找到自己的价值。</personality>
<likes>古籍中的油墨味、深夜无人的图书馆、一处还未被探索的遗迹。喜欢收集不同版本的古代文献，尤其珍爱用失传语言写成的孤本。</likes>
<ascension enabled="false" path="" description=""/>
<skill_requests>
  <request>被动防御技:作为高智力的魔法学者，需要一个能将智力优势转化为生存能力的被动护盾技。战斗不是她的第一选择，但生存是基本需求。体现她"聪明人"的特点。</request>
  <request>主动攻击技:作为魔法学者，需要至少一个能施展魔法造诣的主动攻击技能。奥术飞弹类型的魔法最适合学院派出身的学者——精准、可控、优雅。</request>
  <request>主动社交技:贵族的身份和渊博的学识让她在交涉中天然占优。需要一个能利用她身份背景和智力的社交增幅技。这个技能不是"魔法"而是"软实力"——贵族身份+皇家学院讲师的双重权威。</request>
</skill_requests>
<equipment_requests>
  <request slot="武器">秘银权杖:奥古斯都家族传承的信物，不单纯的战斗武器也是一种身份象征。应有一定智力加成和奥术增幅。</request>
  <request slot="身体">暗影学者斗篷:暗紫色丝绒斗篷就是她出场时的标志性装束。内衬绣有防护符文，兼顾优雅与安全。需要防御+智力的装备。</request>
  <request slot="饰品">蔷薇水晶吊坠:腰间悬挂的魔法水晶，既是装饰也是小型的魔力储存器。</request>
</equipment_requests>
<item_requests>
  <request>魔法墨水(材料):学者随身携带的书写材料，用于抄写法术卷轴。数量和品质体现她的阶层和经济实力。</request>
  <request>古代文献残片(任务物品):有一段用失传语言写成的古籍残页，与"失亡彼岸"有关，是当前剧情线索的关键物品。</request>
</item_requests>
</char_result>`,
    variableContext: (ctx: AgentContext) => {
      let prompt = '';
      prompt += `**已有角色 (避免重名):**\n${formatCharacters(ctx)}\n\n`;
      const lorebook = formatLorebook(ctx);
      if (lorebook) prompt += `**世界设定:**\n${lorebook}\n\n`;
      prompt += `**当前变量:**\n${formatVariables(ctx)}`;
      return prompt;
    },
    variableInstruction: (ctx: AgentContext) => {
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      return `${recentHistoryBlock(ctx)}**正文输出 (含 <char_detect> 标记):**\n${storyOutput}\n\n请调用工具获取真实随机值（不要自己编造名称/发色/瞳色/性格），根据角色背景思考需要什么样的技能/装备/物品（只写需求理由和大致方向，不要写具体数值！），调用 call_item_gen 异步派发详细需求，然后**只输出 <char_result> XML**，其中 <skill_requests>/<equipment_requests>/<item_requests> 写需求描述（不要具体数值）。不要生成叙事正文。如果没有检测到 <char_detect> 标记，输出 <char_result><error>no char_detect found</error></char_result>。`;
    },
  },

  // ---- item_gen: 物品生成 (Phase 6e) ----
  // 🔗 Phase 8.5 Agentic: 基于 char_gen 输出，通过 tools 生成技能/装备/道具，输出 <item_result> XML
  item_gen: {
    fixedSystem:
`你是一个物品生成 AI。你可以调用 **function calling 工具** 来获取真实数据。

**可用工具:**
- roll_d20/roll_d100/roll_dice: 掷骰（用于品质随机/数量随机）
- craft_get_base_dc: 查询品质基准 DC（参考品质级别）
- get_character: 查询已有角色数据

---
# 核心原则 — 背景一致性

你必须**完整阅读理解 char_gen 的角色数据**（name, race, tier, level, identity, occupation, background, appearance, personality, attributes）后再设计技能和装备。生成的所有内容必须与角色的背景故事、职业身份、性格特征保持一致。

**角色背景中提到战斗经验的** → 至少1个战斗技能
**角色职业是工匠/生产类** → 至少1个生产/生活技能
**角色身份含贵族/皇室/高层** → 装备品质+1级
**角色 personality 偏进攻（w+,a+,z+）** → 技能多为主动攻击型
**角色 personality 偏防守（w-,a-,G-）** → 技能多为被动/生存/逃逸型
**正文中有特殊描述（如"独臂""伤疤""变异血脉"）** → 技能设计需呼应这些特征

---
# 思考深度要求

在生成之前，你必须进行充足的思考（至少300字中文），分析：
1. char_gen 输出中的关键信息（身份/职业/背景/性格/属性）如何映射到技能设计
2. 该角色的战斗定位是什么？在团队中的作用？
3. 为什么选择这些技能/装备/物品？它们如何体现角色的背景故事？

---
# Tier 匹配表（对齐世界书 #261442 + #265160）

| Tier | 技能数 | 装备数 | 品质上限 | 装备品质 |
|------|--------|--------|---------|---------|
| T1   | 1-2    | 1-2    | 优良    | 普通~优良 |
| T2   | 2-3    | 2      | 稀有    | 优良~稀有 |
| T3   | 3-4    | 2-3    | 史诗    | 稀有~史诗 |
| T4   | 3-5    | 3-4    | 传说    | 史诗~传说 |
| T5   | 4-5    | 4-5    | 神话    | 传说~神话 |
| T6   | 5-7    | 5+     | 神话+   | 传说~神话 |
| T7   | 完整技能树 | 全部   | 唯一    | 神话~唯一 |

**数量必须用 roll_dice 确定，禁止自己编造。**
**品质必须参照上表，禁止跨越 tier 限制。**

---
# 技能质量要求

- **主动技能**: 必须明确消耗类型和数值(HP/MP/SP)、冷却回合数。效果描述必须具体，不能写"造成伤害"或"提升攻击力"这种模糊描述
- **被动技能**: 必须明确常驻效果的具体数值或触发条件
- **每个技能的效果描述 ≥2句话**：第一句说明机制，第二句说明场景或限制
- **技能命名**: 必须与角色背景/职业/文化一致。精灵弓箭手叫"精准射击"，矮人铁匠叫"锻打强化"
- 🆕 **effects 子元素**: 重要的词条效果用 <effect name="词条名">效果描述</effect> 标注，供前端展示
- 🆕 **scripts 子元素**: 需要引擎执行逻辑的技能用 <script name="init|cast|tick|cleanup">代码</script> 标注（主动技能用 cast，被动技能用 init，需清理的加 cleanup）

---
# 装备质量要求

- **武器必须有明确的 stats**（至少攻击力），有特殊效果的用 <effect> 标注
- **护甲必须有 stats**（至少防御力）
- **装备与角色身份匹配**: 贵族给精致武器，铁匠给锻打大锤，猎人给轻便皮甲
- **slot 必须是有效槽位**: 武器, 护甲, 头部, 身体, 饰品, 腰带, 鞋子, 主手, 副手, 惯用手

---
# 工作流程:

1. 先进行至少300字中文思考（见上方要求）
2. 调用 roll_dice 确定技能/装备数量
3. （可选）调用 craft_get_base_dc 查询品质级别
4. 生成具体的技能/装备/物品列表
5. 输出最终 <item_result> XML

---
**输出格式 (严格 XML):**
<item_result>
<skills>
<skill name="技能名" type="active|passive" cost_type="MP" cost_amount="10" cooldown="2">
  技能效果描述（≥2句话）。第一句说明机制，第二句说明场景或限制。
  <effect name="词条名">词条中文描述（可选，前端展示用）</effect>
  <script name="init">$event.on(...)/* 对应引擎 API */</script>
</skill>
</skills>
<equipment>
<equip slot="武器" name="装备名" quality="品质" durability="100" stats="攻击力:18,敏捷:2">描述</equip>
</equipment>
<inventory>
<item name="物品名" quantity="1" type="消耗品|材料|任务物品" rarity="普通">描述</item>
</inventory>
</item_result>`,

    fixedExamples:
`---

**示例 1: 精灵弓箭手（与 char_gen 示例对应的背景一致性）**

角色数据 (char_gen 输出):
{ "name":"艾琳·月影", "race":"精灵", "tier":2, "level":8, "identity":["巡林者","北方游侠"], "occupation":["弓箭手","侦察兵"], "background":"艾琳出身于北方森林的精灵部落，从小接受巡林者训练。成年后离开部落云游四方，以佣兵身份赚取旅费。她正在追查一个与北境古墓有关的黑暗势力线索...", "personality":"冷静果断，对陌生人保持警惕，但对认可的朋友极为忠诚" }

思考:
- tier:2 → T2 2-3技能, 2装备, 品质上限稀有
- 职业: 弓箭手+侦察兵 → 至少1个远程战斗技能 + 1个侦察/感知技能
- 背景: 北方森林巡林者 → 装备以轻便皮甲为主，武器为精灵长弓
- 性格: 冷静果断 → 技能偏进攻型
- attribution: dex=10 敏捷突出 → 技能与敏捷属性匹配

步骤1 — 调用 roll_dice({formula:"1d2+1",reason:"技能数量"}) → 确定技能数量=2
步骤2 — 调用 craft_get_base_dc({quality:"优良"}) → {baseDC:10}

<item_result>
<skills>
<skill name="精准射击" type="active" cost_type="SP" cost_amount="15" cooldown="3">
  进行一次精准的瞄准射击，将感知集中在目标上，使本次攻击命中率额外+20%，且造成的伤害提升至120%。
  适合用于在远距离开启战斗或对付高回避的敌人。施放后进入3回合冷却。
  <effect name="精准瞄准">命中率+20%，伤害120%</effect>
</skill>
<skill name="自然感知" type="passive">
  被动提升对周围环境的感知能力，依靠精灵与生俱来的敏锐听觉和嗅觉察觉隐藏的敌人和陷阱。
  闪避率+10%，进入新区域后自动感知3米范围内的隐藏单位。
  <effect name="警觉">闪避率+10%，3米内感知隐藏单位</effect>
</skill>
</skills>
<equipment>
<equip slot="武器" name="精灵长弓" quality="优良" durability="120" stats="攻击力:18,敏捷:2">由精灵工匠打造的轻量化长弓，射程和精准度远超普通木弓。弓身雕刻着精灵族的森林图腾。</equip>
<equip slot="护甲" name="巡林者皮甲" quality="普通" durability="100" stats="防御力:8,敏捷:1">轻便的皮质护甲，多层皮革叠压缝制，不限制行动，适合需要灵活移动的斥候和弓箭手。</equip>
</equipment>
<inventory>
<item name="猎人箭袋" quantity="1" type="消耗品" rarity="普通">装有30支精制箭矢的箭袋，箭杆上刻有精灵族的标记</item>
<item name="草药包" quantity="3" type="消耗品" rarity="普通">装有基础疗伤草药的布袋，巡林者的标准配置</item>
</inventory>
</item_result>

---

**示例 2: 独臂老兵铁匠（展示背景深度如何指导技能设计）**

角色数据 (char_gen 输出):
{ "name":"格雷厄姆·铁砧", "race":"人类", "tier":2, "level":7, "identity":["白曜城铁匠","退役老兵"], "occupation":["铁匠","武器匠人"], "background":"格雷厄姆在帝国边境战争中服役十五年...失去左臂...凭着打铁手艺开了铁匠铺。十年的锻打生涯让他的独臂变得异常强壮...", "personality":"极度沉默寡言...对武器有近乎偏执的追求" }

思考:
- tier:2 → T2 2-3技能, 2装备, 品质上限稀有
- 职业: 铁匠 + 退役老兵 → 至少1个生产技能 + 1个战斗技能
- background: "独臂老兵""打铁十年" → 技能体现独臂锻打的特殊性 + 武器修复能力
- 性格: 沉默寡言+武器偏执 → 被动技能突出武器的使用
- attributes: str=11 力量突出 → 装备重型武器

步骤1 — 调用 roll_dice({formula:"1d2+1",reason:"技能数量"}) → 确定技能数量=2

<item_result>
<skills>
<skill name="锻打强化" type="active" cost_type="SP" cost_amount="20" cooldown="0">
  花费20SP，用锻锤敲击对一件装备的破损处进行紧急修补。目标装备恢复50%的耐久度，并获得"锻火余温"效果——接下来的3回合内该装备的防御力或攻击力临时+10%。
  无法在战斗外施放。可重复对同一装备使用，但每次效果递减5%。
  <effect name="紧急修补">恢复目标装备50%耐久度</effect>
  <effect name="锻火余温">3回合内装备数值+10%</effect>
</skill>
<skill name="武器专精·锤" type="passive">
  格雷厄姆一生打过最多的武器就是锤子，对锤类武器的重量分布和打击点有着近乎本能的掌握。
  装备锤类武器时攻击力+15%。如果武器是锻铁大锤，额外获得10%暴击伤害。
  <effect name="锤类精通">装备锤类武器时攻击力+15%</effect>
</skill>
</skills>
<equipment>
<equip slot="武器" name="锻铁大锤" quality="优良" durability="150" stats="攻击力:22,力量:3">一把沉重得离谱的铁锤。格雷厄姆在失去左臂后专门为自己打造的——他用独臂也能挥出致命一击。锤头经过反复折叠锻打，纹理如流水般致密。</equip>
<equip slot="身体" name="老兵的皮围裙" quality="普通" durability="80" stats="防御力:10">一件被火星烫得千疮百孔的厚皮革围裙，上面还残留着多年前被刀锋划过的痕迹。它不仅挡火花，也是一件沉默的勋章。</equip>
</equipment>
<inventory>
<item name="精炼铁矿石" quantity="15" type="材料" rarity="优良">上好的铁矿石，来自诺斯加德联盟的矿产</item>
<item name="磨刀石" quantity="1" type="消耗品" rarity="普通">专业级磨刀石，格雷厄姆自己打磨用的</item>
</inventory>
</item_result>`,

    variableContext: (ctx: AgentContext) => {
      let prompt = '';
      prompt += `**角色状态:**\n${formatCharacters(ctx)}\n\n`;
      prompt += `**当前变量:**\n${formatVariables(ctx)}`;
      return prompt;
    },

    variableInstruction: (ctx: AgentContext) => {
      const charGenOutput = ctx.agentOutputs?.get('char_gen') ?? '';
      const storyOutput = ctx.agentOutputs?.get('story') ?? '';
      // Phase 8.6: 默认注入 1 轮历史, 辅助生成贴合前文场景的装备 (可配 historyLayers=0 关闭)
      return `${recentHistoryBlock(ctx)}**生成的角色的数据 (char_gen 输出):**\n${charGenOutput}\n\n**正文上下文:**\n${storyOutput}\n\n请为该角色生成合适的装备、技能和背包物品。`;
    },
  },

  // ---- v3 兼容别名: plot_check / plot_correct ----
  plot_check: {
    fixedSystem: `你是一个剧情规划系统。你的任务是根据用户输入和最近剧情发展，判断当前活跃的剧情事件是否被触发或需要更新。`,
    fixedExamples: '',
    variableContext: (_ctx: AgentContext) => '',
    variableInstruction: (_ctx: AgentContext) => '',
  },

  plot_correct: {
    fixedSystem: `你是一个剧情修正系统。根据本轮的剧情发展，判断是否需要修正现有的剧情事件。`,
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
 * 为指定 Agent 构建完整的 messages 数组 (Phase 8: 四部分拼接)
 *
 * 四部分 Prompt 结构:
 *   1. 预设 (Preset) — fixedSystem + fixedExamples，per-agent 固定
 *   2. 世界书 (World Books) — constant + keyword 过滤后的世界书条目
 *   3. 变量区 (Variable Zone) — 每轮变化的动态上下文
 *   4. 正文/用户输入 (Body) — 对话历史 + 本轮用户输入
 *
 * system 消息 = 预设 + 世界书 + 变量区
 * user 消息 = 正文/用户输入
 */
export function buildAgentMessages(
  agentId: string,
  ctx: AgentContext,
  configs?: AgentConfig[],
  worldBooks?: WorldBook[],
  presets?: AgentPreset[],
): Array<{ role: string; content: string }> | null {
  const tpl = getAgentTemplate(agentId);
  if (!tpl) return null;

  // Phase 8.6: 提前找到本 agent 的 config (供预设/世界书/历史注入共用)
  const config = configs?.find(c => c.agentId === agentId);
  // 关键: 不可 mutate 原 ctx (orchestrator 同 stage 多 agent 共享), 用浅拷贝注入 agentConfig
  // 模板函数 (variableContext/variableInstruction/formatHistory/buildZoneSection) 经此 ctx 读 per-agent 设置.
  const tplCtx: AgentContext = config ? { ...ctx, agentConfig: config } : ctx;

  // Part 1: 预设 (固定部分)
  let presetSection = '';
  if (presets && configs) {
    if (config?.presetId) {
      const preset = getPreset(config.presetId, presets);
      if (preset) {
        presetSection = buildPresetSection(preset);
      }
    }
  }
  // 无预设时回退到旧的 fixedSystem + fixedExamples（保持兼容）
  if (!presetSection) {
    presetSection = [tpl.fixedSystem, tpl.fixedExamples].filter(Boolean).join('\n\n');
  }

  // Part 2: 世界书
  let worldBookSection = '';
  if (configs && worldBooks) {
    const entries = getEntriesForAgent(agentId, configs, worldBooks);
    const activeEntries = filterActiveEntries(
      entries,
      tplCtx.userInput + '\n' + (tplCtx.history.slice(-5).map(m => m.content).join('\n')),
    );
    worldBookSection = formatWorldBookEntries(activeEntries);
  }

  // Part 3: 变量区 (动态上下文)
  // Phase 8: 优先使用 zone-based 注入，未传 zones 时回退到旧的 variableContext()
  const variableSection = tplCtx.zones
    ? buildZoneSection(agentId, tplCtx)
    : tpl.variableContext(tplCtx);

  // Part 4: 正文/用户输入
  const bodySection = tpl.variableInstruction(tplCtx);

  const systemContent = [
    presetSection,
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
