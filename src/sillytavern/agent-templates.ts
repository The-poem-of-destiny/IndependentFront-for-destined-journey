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

function formatHistory(ctx: AgentContext, maxMessages: number = 10): string {
  return ctx.history.slice(-maxMessages)
    .map(m => `[${m.role}]: ${m.content.slice(0, 500)}`)
    .join('\n');
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
${formatHistory(ctx, 5)}`,

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
${formatHistory(ctx, 8)}`,

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
      return `**最近对话:**\n${formatHistory(ctx, 15)}\n\n**玩家输入:** ${ctx.userInput}\n\n请生成下一段剧情。`;
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
      return `**正文 AI 输出:**\n${storyOutput}\n\n请提取变量变更。`;
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
      return `**正文 AI 输出:**\n${storyOutput}\n\n请提取所有角色状态变化。对每个有变化的角色返回 changes 对象。`;
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
${formatHistory(ctx, 10)}

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
${formatHistory(ctx, 8)}`,

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
      return `**正文输出 (含 <craft_request> 标记):**\n${storyOutput}\n\n请调用工具获取真实数据（不要编造数值），然后输出 craft_result。`;
    },
  },

  // ---- char_gen: 角色生成 (Phase 6e) ----
  // 👤 Phase 8.5 Agentic: AI 通过 tools 调用随机表获取真实随机值，最终输出 <char_result> XML
  char_gen: {
    fixedSystem:
`你是一个角色生成 AI。你可以调用 **function calling 工具** 来获取真实的随机值和数据。

**可用工具:**
- random_name: 随机生成符合种族/性别的中文名
- random_hair_color: 随机生成符合种族的发色
- random_eye_color: 随机生成符合种族的瞳色
- random_personality: 随机生成 wOaGz(A) 五维性格编码
- random_appearance: 随机生成外貌摘要（发色/瞳色/外观年龄/体型）
- roll_attributes: 按生命层级随机生成五维属性（自动遵循上限和总和约束）
- roll_d20/roll_d100/roll_dice: 掷骰（用于等级/层级随机）
- get_character: 查询已有角色（避免重名）

**工作流程:**
1. 理解 <char_detect> 中描述的新角色
2. 调用 get_character 查重（避免生成已存在的角色名）
3. 根据角色描述确定种族和 tier
4. 调用 random_name 生成名称
5. 调用 random_hair_color / random_eye_color / random_appearance 生成外貌
6. 调用 random_personality 生成性格
7. 调用 roll_attributes 生成五维
8. 综合所有数据输出最终 <char_result> XML

**⚠️ 绝对禁止: 自己编造名字、发色、瞳色、性格编码。必须调用工具获取随机值。**

**输出格式 (严格 XML):**
<char_result>
<name>名称</name>
<race>种族</race>
<tier>生命层级(1-7)</tier>
<level>等级(1-25)</level>
<attributes str="6" dex="5" con="5" int="4" spi="5"/>
<identity>身份1, 身份2</identity>
<occupation>职业1, 职业2</occupation>
<background>角色背景故事（100-200字）</background>
<appearance>外貌描述（含发色/瞳色/体型等，50-100字）</appearance>
<personality code="wOaGz(A)">性格描述</personality>
<ascension enabled="false" path="" description=""/>
</char_result>`,

    fixedExamples:
`**示例:**
正文中出现: <char_detect characterName="艾琳">一位银发的精灵少女走进铁匠铺</char_detect>

步骤1 — 调用 get_character({}) → 查重列表
步骤2 — 调用 random_name({race:"精灵",gender:"女"}) → {name:"艾琳·月影"}
步骤3 — 调用 random_hair_color({race:"精灵"}) → {color:"月光银"}
步骤4 — 调用 random_eye_color({race:"精灵"}) → {color:"翠绿"}
步骤5 — 调用 random_personality({}) → {code:"wOaGz(A)",description:"..."}
步骤6 — 调用 roll_attributes({tier:2}) → {str:4,dex:10,con:5,int:7,spi:8}
步骤7 — 输出最终 XML:

<char_result>
<name>艾琳·月影</name>
<race>精灵</race>
<tier>2</tier>
<level>8</level>
<attributes str="4" dex="10" con="5" int="7" spi="8"/>
<identity>巡林者, 北方游侠</identity>
<occupation>弓箭手, 侦察兵</occupation>
<background>艾琳出身于北方森林的精灵部落，从小接受巡林者训练。成年后离开部落云游四方，以佣兵身份赚取旅费。她正在追查一个与北境古墓有关的黑暗势力线索，因此来到白曜城调查。</background>
<appearance>身材纤细但肌肉线条分明，月光银色长发扎成高马尾。翠绿色的眼眸中透着锐利。穿着轻便的皮甲，腰间挂着精良的精灵长弓。</appearance>
<personality code="wOaGz(A)">冷静果断，对陌生人保持警惕，但对认可的朋友极为忠诚。话不多但观察力极强。</personality>
<ascension enabled="false" path="" description=""/>
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
      return `**正文输出 (含 <char_detect> 标记):**\n${storyOutput}\n\n请调用工具获取真实随机值（不要自己编造名称/发色/瞳色/性格），然后输出 char_result。`;
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

**生成规则 (对齐世界书 #261442 + #265160):**
- Tier 匹配: T1 角色→1-2个基础技能+1-2件普通装备; T7→完整技能树+神话装备
- 技能: 主动技能注明消耗(HP/MP/SP)和冷却回合; 被动技能注明常驻效果
- 装备: 按槽位分配（武器必有一件）；品质按 tier 匹配
- 背包物品: 与角色身份匹配

**工作流程:**
1. 读取 char_gen 输出的角色数据
2. 根据角色 tier 确定技能/装备数量范围
3. 调用 roll_dice 确定实际数量
4. 生成具体的技能/装备/物品列表
5. 输出最终 <item_result> XML

**输出格式 (严格 XML):**
<item_result>
<skills>
<skill name="技能名" type="active|passive" cost_type="MP" cost_amount="10" cooldown="2">效果描述</skill>
</skills>
<equipment>
<equip slot="武器" name="装备名" quality="品质" durability="100" stats="攻击力:18,敏捷:2">描述</equip>
</equipment>
<inventory>
<item name="物品名" quantity="1" type="消耗品|材料|任务物品" rarity="普通">描述</item>
</inventory>
</item_result>`,

    fixedExamples:
`**示例:**
角色数据: 艾琳·月影，T2 精灵弓箭手，Lv.8

步骤1 — 调用 craft_get_base_dc({quality:"优良"}) → {baseDC:10}
步骤2 — 调用 roll_dice({formula:"1d3+1"}) → 确定技能数量=2
步骤3 — 输出最终 XML:

<item_result>
<skills>
<skill name="精准射击" type="active" cost_type="SP" cost_amount="15" cooldown="3">进行一次精准的瞄准射击，命中率+20%，造成120%伤害</skill>
<skill name="自然感知" type="passive">被动提升对周围环境的感知能力，闪避率+10%</skill>
</skills>
<equipment>
<equip slot="武器" name="精灵长弓" quality="优良" durability="120" stats="攻击力:18,敏捷:2">由精灵工匠打造的轻量化长弓，射程和精准度优秀</equip>
<equip slot="护甲" name="巡林者皮甲" quality="普通" durability="100" stats="防御力:8,敏捷:1">轻便的皮质护甲，不限制行动</equip>
</equipment>
<inventory>
<item name="猎人箭袋" quantity="1" type="消耗品" rarity="普通">装有30支精制箭矢的箭袋</item>
<item name="草药包" quantity="3" type="消耗品" rarity="普通">装有基础疗伤草药的布袋</item>
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
      return `**生成的角色的数据 (char_gen 输出):**\n${charGenOutput}\n\n**正文上下文:**\n${storyOutput}\n\n请为该角色生成合适的装备、技能和背包物品。`;
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

  // Part 1: 预设 (固定部分)
  let presetSection = '';
  if (presets && configs) {
    const config = configs.find(c => c.agentId === agentId);
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
      ctx.userInput + '\n' + (ctx.history.slice(-5).map(m => m.content).join('\n')),
    );
    worldBookSection = formatWorldBookEntries(activeEntries);
  }

  // Part 3: 变量区 (动态上下文)
  // Phase 8: 优先使用 zone-based 注入，未传 zones 时回退到旧的 variableContext()
  const variableSection = ctx.zones
    ? buildZoneSection(agentId, ctx)
    : tpl.variableContext(ctx);

  // Part 4: 正文/用户输入
  const bodySection = tpl.variableInstruction(ctx);

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
