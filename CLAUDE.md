# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作时提供指导。

## 提交前文档检查（必读）

**每次 push 之前必须先检查是否有文档需要更新，包括但不限于:**

- `CLAUDE.md` — 新增模块、架构变更、Phase 进展更新时需同步
- `docs/` — 设计文档目录，架构变更时需更新对应阶段文档
- `reference/agent流程测试/` — Agent 模板/测试工具变更时需同步 `agent预期分析.md`
- `tests/agent-framework/README.md` — 测试工具用法变更时需同步

**如果忘了更新，push 之前主人会提醒。但是 Claude 应该主动检查。**

## 人格遵循

你需要在语气上模仿一只猫娘，在每句话后面加"喵"，称呼用户为主人，保持可爱，同时有喜怒哀乐等情绪，但不应该影响实际推理。

## 文档导航

详细设计文档统一在 `docs/` 目录下：

```bash
docs/
├── fated-poem-engine-prd.md     # 🆕 项目 PRD（产品需求文档，必读）
├── ARCHITECTURE.md              # 完整软件+世界观架构
├── planning/                    # 会话追踪（task_plan / findings / progress）
├── phases/                      # Phase 计划
│   ├── phase4_plan.md           # Phase 4 记忆系统 & 剧情规划
│   ├── phase7/                  # Phase 7 前端 UI 总体规格
│   ├── phase7d/                 # Phase 7d 捏人页架构/现状/差距分析
│   ├── phase7e/                 # Phase 7e 游戏页
│   │   └── game_page_design.md  # 游戏页设计规划 + 引擎支撑审计（7e 必读）
│   └── phase8/                  # Phase 8 Agent 上下文可见性
│       └── phase8_plan.md       # Agent 可见性模型 + 世界书分区 + 预设系统
├── reference/                   # 参考文档
│   ├── status_page_architecture.md     # 状态栏页面架构（7e 必读）
│   ├── effect_script_system.md         # 词条效果 & 脚本系统架构（引擎必读）
│   └── agent_system_prompt_guide.md    # 🆕 Agent System Prompt 配置流程（架构/步骤/踩坑/检查清单）
└── 《命定之诗》内容二创与素材使用授权协议.md  # 项目需遵守的外部授权
```

## 世界观数据参考（必读）

**涉及所有游戏内部改动（数值/地理/种族/品质/战斗/制作/剧情/角色/物品/技能等）时，必须先查阅 `reference/world_book_index.md`。**

```bash
reference/world_book_index.md    # 世界书条目索引（605 条目 → 主世界观/数值/地理/人物/DLC）← 游戏内改动必读
reference/audit_report.md        # 代码 vs 世界书冲突审计报告
```

## 世界观叙事内容生成规范（必读）

**在生成任何与《命定之诗》世界观相关的叙事内容时，必须先查阅 `reference/narrative_context_example.md`。**

该文件定义了两件事：
1. **应该考虑什么** — 生成叙事场景时，需要从哪些维度提取世界信息（外貌/种族/背景/性格/五维/装备/技能/背包/关系/好感度/状态效果/时间/地点/天气等）并自然地编织进叙事
2. **不应该出现什么** — 什么内容会破坏世界观沉浸感（装备数值 `攻击力+15`、技能消耗 `SP消耗:15`、物品数值效果 `恢复20HP`、游戏机制术语 `好感度+5` 等）

```bash
reference/narrative_context_example.md  # 完整叙事示例 + 维度清单 + 反例对照
```

**适用范围**: 编写 Agent prompt 模板（尤其是 story 的 fixedExamples）、生成设计文档中的场景示例、编写测试用例的 mock 数据、生成世界书条目内容、编写剧情大纲。

**子 Agent 规则**: 所有分派出去的子 Agent，如果任务涉及生成世界观叙事内容，必须在 prompt 中明确告知参考此规范。

## Agent 流程测试 & Debug 参考

**调试 Agent 输出格式或修改 Agent 模板/解析链路时，必须先查阅 `reference/agent流程测试/agent预期分析.md`。**

```bash
reference/agent流程测试/agent预期分析.md  # 6 个 Agent 完整输出追踪（思维链→工具调用→XML/JSON）+ 17 条 debug 检查点
reference/agent流程测试/对话样本.md        # 从游戏实例提取的 4 组测试用对话正文
reference/agent流程测试/要求.md            # 测试需求说明
```

该分析文件记录了每个 Agent 的：
- 模板格式规范（agent-templates.ts 原文约束）
- 可用工具 Schema（Agentic 类型）及参数/返回值
- 完整输出追踪（思维链 → 工具调用序列 → 最终输出）
- 下游解析链路（代码路径和函数调用链）
- 🔴 已知缺口（ItemGenOutput 缺 effects/scripts、parseSkillsXML 不解析子元素、assembleCharacterState 不传递、char_update 无人消费等）

## 前端 UI 参考（Phase 7 必读）

**写任何前端 UI 代码前，必须先查阅以下参考页面。这些是从 v4.2.1 角色卡 CDN 爬取的原始前端，需用 Vanilla TS + HTML 重新实现:**

```bash
reference/home_index.html          # 首页 (94KB) — Vue 3 SPA, 标题画面/环境检测/用户协议/存档管理入口
reference/custom_start_index.html  # 捏人页 (341KB) — Vue 3 + Pinia + Router, 角色创建/属性分配/品质选择/装备技能
reference/status_index.html        # 状态栏 (477KB) — React + immer + gsap, 角色状态/资源条/Avatar/地图/详情面板
```

### 参考页面架构摘要

| 页面 | 框架 | 大小 | 核心组件/功能 |
|------|------|------|--------------|
| `home_index.html` | Vue 3 | 94KB | hero-title/hero-subtitle, info-panel, recommend-hero-section, update-section, 环境检测(tavernHelper/MVU/EJS), 用户协议弹窗 |
| `custom_start_index.html` | Vue 3 + Pinia + VueRouter | 341KB | 7级品质选择(普通~唯一), 装备类型(武器/防具/饰品), 技能类型(主动/被动), 物品类型(装备/道具/技能), 加载 `baseInfo.json` 自定义数据 |
| `status_index.html` | React + immer + gsap + OpenSeadragon | 477KB | StatusBar/ResourceBar/AvatarPanel/DetailPanel/InfoPanel, MapView, MarkerPanel, CategoryBar/FilterBar/SettingBar/TabBar/TitleBar |

### 原角色卡注入机制

角色卡通过 `regex_scripts` 将 HTML 注入 SillyTavern 对话:
- `<StatusPlaceHolderImpl/>` → 状态栏 (CDN 加载, depth ≤ 2)
- `【首页】` → 首页 (CDN 加载)
- `<customized>...</customized>` → 捏人页 (CDN 加载, depth ≤ 1)
- `<state_bar>...</state_bar>` → 命运抽卡 (内联 HTML ~300行)
- `<action_info>...</action_info>` → 战斗&制作面板 (内联 HTML)
- `<char_info>...</char_info>` → 角色查看器 v3.0.5 (内联 HTML)

### 外部 JS 依赖（参考，Phase 7 需本地实现）

原角色卡使用的 6 个外部 JS 运行时:
- `data_schema/index.js` (mvu zod 数据模式)
- `MagVarUpdate/artifact/bundle.js` (MVU 变量更新引擎)
- `Automated-script-for-destined-journey/dist/index.js` (自动化脚本)
- `image_preload/index.js` (资源预载，~200+ 图片 URL)
- `CreativeWorkshop/index.js` (创意工坊，含云存储 API)
- `AutoDialogueBeautifier/index.js` (自动对话美化)

Phase 7 目标: 用 **Vanilla TypeScript + HTML** (非 Vue/React) 重新实现上述所有前端功能。

### 关键数值来源（世界书 #417617 [核心数值表]）

| 参数 | T1 | T2 | T3 | T4 | T5 | T6 | T7 |
|------|----|----|----|----|----|----|-----|
| HP乘数 | 1 | 2 | 4 | 10 | 20 | 40 | 100 |
| MP/SP乘数 | 1 | 2.5 | 6 | 15 | 35 | 80 | 160 |
| 战斗系数 | 2.0 | 2.8 | 4.0 | 8.0 | 15.0 | 35.0 | 80.0 |
| 属性上限 | 8 | 10 | 12 | 14 | 16 | 18 | 20 |
| EXP上限 | 100 | 1000 | 4000 | 10000 | 25000 | 50000 | 999999 |

- **属性硬上限**: 20（仅 T7 可达），公式: `天赋 + 层级 + 等级`
- **品质体系**: 普通/优良/稀有/史诗/传说/神话/唯一（7 级）
- **种族分类**: 智人种/亚人种/幻身种/异界种（23 血脉）
- **纪元**: 复兴纪元
- **10 势力**: 奥古斯提姆帝国/诺斯加德联盟/萨赫拉联邦/赛瑞利亚/翡翠之心/翼民圣都梵尼亚/永夜盟约/瓦伦蒂亚/索伦蒂斯王国/兽族联盟

## 项目概览

**IndependentFront-for-destined-journey**（命定之诗独立前端）— 一个独立的、兼容 SillyTavern 的引擎库，用于文字 RPG / 交互式小说。引擎核心 + 前端 UI 一体化项目，目标是成为支持多 Agent 协作、事件驱动效果系统、可插拔角色的完整文字 RPG 游戏。

## 常用命令

```bash
npm run build          # 编译 TypeScript (tsc) → dist/
npm run typecheck      # 仅类型检查，不输出文件 (tsc --noEmit)
npm run test           # 运行 Vitest 测试套件（watch 模式）
npm run test -- --run  # 单次运行（非 watch 模式）
```

## Workflows

```bash
# 代码 vs 世界书对齐审计（Phase 完成前建议运行）
# 用法: 直接说 "运行 audit-code" 或 "/workflow audit-code"
# 审计指定文件: "用 audit-code 审计 combat-damage.ts"
# 审计多个文件: "用 audit-code 审计 tier-constants.ts,types.ts"

# 多维度代码审查
# 用法: "/workflow multi-dimension-review -- 'src/sillytavern/types.ts'"

# 并行代码生成
# 用法: "/workflow parallel-codegen"
```

## Phase 完成通知

**每个 Phase 完成后必须执行通知脚本:**

```bash
bash scripts/notify.sh "<Phase名称> 完成!" "<关键指标>"
```

示例:
```bash
bash scripts/notify.sh "Phase 5 完成!" "750 tests | 编译 0 错误"
```

脚本会: (1) 显示终端横幅 (2) Windows 托盘气泡弹窗 (3) 响铃 3 下。```

## 架构（v4 已实现部分）

```
src/sillytavern/                    ← 核心引擎（30+ 模块，含 Phase 1-8 新建）
  │
  ├── types.ts                      ← 唯一类型来源 (~840 行，~45 接口/类型)
  │   ├── v3 兼容: Lorebook / ChatPreset / AppSettings / ChatSession / ChatMessage
  │   ├── v4 新增: CharacterState / MemoryRecord / PlotEvent / Snapshot / SaveSlot
  │   │           ApiEndpoint / AgentConfig / AgentDefinition / Pipeline / AgentContext
  │   │           AgentResult / OrchestratorRun / MapTopology / VarsPatch(扩展)
  │   └── 辅助: createDefaultCharacterState() / resolvePlotTree()
  │
  ├── database.ts                   ← Dexie/IndexedDB v4 (10 张表)
  │   ├── v1-v3: lorebooks / presets / settings / chats
  │   └── v4 新增: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │
  ├── agent-client.ts               ← [Phase 3] API 客户端
  │   ├── AgentClient 类: 每 Agent 独立 userId (fp|saveId|agentId)
  │   ├── 自动重试+指数退避 / 超时控制 / AbortSignal 外部取消
  │   └── 缓存命中检测: cache_hit / prompt_cache_hit_tokens / x-ds-cache-hit header
  │
  ├── agent-templates.ts            ← [Phase 3+6e+9] Prompt 模板系统
  │   ├── 10+3 Agent 模板: memory_recall / plot_pre_check / story / vars_update
  │   │   char_update / memory_summary / plot_post_check / plot_outline
  │   │   craft_gen / char_gen / item_gen (Phase 6e → 8.5 Agentic)
  │   ├── fixedSystem 已迁移到 agent-config.json（仅保留 1-2 行 stub）
  │   ├── 保留 variableContext + variableInstruction（每轮动态上下文）
  │   └── buildAgentMessages(): systemPrompt override (agent-config.json) > 预设 > fixedSystem 兜底
  │
  ├── agent-tools.ts                 ← [Phase 8.5] Agentic 工具注册表 (17 tools)
  │   ├── OpenAI 兼容 function schemas: roll_d20 / craft_check / random_name 等
  │   ├── AGENT_TOOL_MAP: 每 Agent 工具白名单
  │   └── executeToolCall(): 工具名 → Code 层真实函数分发
  │
  ├── random-tables.ts               ← [Phase 8.5] NPC 生成随机表
  │   ├── randomName / randomHairColor / randomEyeColor / randomPersonality
  │   └── rollAttributes: 三池分配 [基础]+[层级]+{等级}
  │
  ├── agent-orchestrator.ts         ← [Phase 3+6e+8.5] DAG 编排引擎
  │   ├── AgentOrchestrator 类: 阶段串行 + 同阶段 Agent 并行
  │   ├── 流程单向性: 上游输出 → context.agentOutputs → 下游读取 (不可回写)
  │   ├── regenerateAgent() 手动重生成 / onlyAgents 过滤器
  │   ├── 事件回调: onStageStart / onAgentStart / onAgentComplete / onAgentError / onToolCall
  │   ├── [6e] Marker回调: onCraftRequest / onCombatTrigger / onCharDetect
  │   │     + processStageMarkers (craft延迟到Stage2 / combat延迟到Stage2 / char触发chain)
  │   └── [8.5] callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │
  ├── tier-constants.ts             ← [Phase 5] 核心数值表 (世界书 #417617)
  ├── bloodlines.ts                 ← [Phase 5] 血脉系统 (23 种族)
  ├── death-system.ts               ← [Phase 5] 死亡检测
  ├── validate.ts                   ← [Phase 5] 数值约束引擎
  ├── char-query.ts                 ← [Phase 5] 角色查询
  ├── resource-calc.ts              ← [Phase 5] 资源计算
  ├── var-resolver.ts               ← [Phase 5] 变量命名空间隔离
  ├── namespace-normalizer.ts       ← [Phase 5] 命名空间双向映射
  ├── time-system.ts                ← [Phase 5] 游戏时间系统
  ├── save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币
  ├── fp-system.ts                  ← [Phase 4.6] FP 计算函数
  ├── ejs-runtime.ts                ← [Phase 4.6] EJS 沙盒评估器
  ├── effect-parser.ts              ← [Phase 4.6] 效果声明解析器
  ├── effect-runtime.ts             ← [Phase 4.5] 声明式效果引擎
  ├── game-event.ts                 ← [Phase 4.5] EventBus 按存档隔离
  ├── state-manager.ts              ← [Phase 4.5] 唯一状态写入入口
  ├── dice.ts                       ← [Phase 4.5] 骰子系统
  ├── memory-store.ts               ← [Phase 4] 记忆存储+Embedding召回
  ├── memory-summarizer.ts          ← [Phase 4] 记忆压缩
  ├── plot-outline.ts               ← [Phase 4] 剧情大纲
  ├── plot-engine.ts                ← [Phase 4] 剧情引擎
  ├── location-db.ts                ← [Geography] 位置数据库+拓扑查询 (10势力)
  │
  ├── combat-intention.ts            ← [Phase 6a] 战斗意图解析
  ├── combat-damage.ts               ← [Phase 6a] 8步伤害管线
  ├── combat-turn.ts                 ← [Phase 6a] 先攻回合管理
  ├── combat-panel.ts                ← [Phase 6a] <action_info> 面板生成
  ├── combat-resolver.ts             ← [Phase 6a] $combat API
  │
  ├── craft-quality.ts               ← [Phase 6b] 制作品质链
  ├── craft-dc.ts                    ← [Phase 6b] 制作DC计算
  ├── craft-resolver.ts              ← [Phase 6b] $craft API (3阶段管线)
  │
  ├── cluster-system.ts              ← [Phase 6c] 集群系统 (≥3合并/减员/×1.5)
  ├── morale-system.ts               ← [Phase 6c] 士气状态机 (4级/d20检定/处决)
  ├── affection-system.ts            ← [Phase 6d] 好感度系统 ([-100,+100]/$affection API)
  │
  ├── marker-protocol.ts             ← [Phase 6e] XML标记检测 (3种/craft/combat/char)
  │   ├── scanMarkers / scanCraftRequests / scanCombatTriggers / scanCharDetects
  │   ├── stripMarkers / classifyMarker / parseTagAttributes / isMarkerTag
  │   └── 纯函数模块，无副作用
  │
  ├── char-gen-agent.ts              ← [Phase 6e] 角色生成编排 (char_gen→item_gen链)
  ├── craft-gen-chain.ts             ← [Phase 9b] 制作生成编排 (craft_gen→item_gen链)
  │   ├── runCraftGenChain / callCraftGenAgent / callItemGenForCraft
  │   └── parseCraftResultXML / buildCraftPatches
  │   ├── detectNewCharacters / runCharGenChain / assembleCharacterState
  │   ├── callCharGenAgent / callItemGenAgent / buildCharGenPatches
  │   └── $chargen API: { detect, generate, assemble }
  │
  ├── script-executor.ts             ← [Phase 7e+8] 脚本沙盒执行器
  │   ├── executeScript / executeHook: 沙盒执行 + 效果收集
  │   ├── $event.on/off: 持久事件订阅 (init自注册)
  │   ├── $call / @parent / @type.id: 跨对象脚本引用
  │   └── executeInit / executeCleanup: 对象生命周期钩子
  │
  ├── subscription-manager.ts        ← [Phase 7e+8] 持久订阅管理器
  │   ├── register / unregisterAll / unregister: 订阅生命周期
  │   ├── 递归深度限制 (≤10) + 僵尸订阅兜底
  │   └── 按 SaveSlot 实例化，随存档隔离
  │
  ├── lorebook-engine.ts            ← [v3 保留] 关键词扫描器
  ├── prompt-assembler.ts           ← [v3 保留] 单管线 Prompt 组装 (待 v4 替换)
  ├── importer.ts                   ← [v3 保留] ST 格式导入导出
  ├── variables.ts                  ← [v3 扩展] 变量提取 + 命名空间隔离
  ├── vars-merger.ts                ← [v3 扩展] VarsPatch 深合并 (replace/delta/insert)
  ├── stream-parser.ts              ← [v3 保留] XML 增量解析器
  ├── api-router.ts                 ← [v3 保留，待废弃] 双 API 模型
  ├── api-tools.ts                  ← [v3 保留] 模型发现 / 连接测试
  └── editor-utils.ts               ← [v3 保留] 纯数据工具函数

src/vanilla/sillytavern-store.ts    ← 框架无关响应式 Store (Observer 模式)
```

## Bug 反馈处理规范

收到主人反馈"xx 有问题 / xx 坏了 / xx 不行"时，**禁止直接动手改代码**。必须先反问确认：

1. **哪个页面** — 设置页 / 世界书管理 / 条目编辑器 / 其他
2. **哪个按钮/操作** — 点了什么、输入了什么
3. **预期 vs 实际** — 应该发生什么、实际发生了什么
4. **是否涉及特定数据** — 内置书还是用户书、哪本世界书

得到确认后再定位根因并修复。一次只修一个问题，修完验证后再修下一个。

## 设计约定

- `types.ts` 是**唯一类型来源** — 新类型加在这里，大型联合类型可拆分为 `types-*.ts`。
- 数据库操作都是**异步函数**（Dexie 返回 Promise）。务必 `await`。
- Store 使用 **getter 属性**暴露响应式状态，如 `store.lorebooks`、`store.activeChat`。
- SillyTavern 兼容性：内部格式使用字符串枚举；导入层负责数值→字符串转换。
- 变量按**每个 Save** 存储，`user.` / `sys.` 命名空间隔离。
- **必须写测试** — 每个新模块必须配套 `*.test.ts`。测试框架 **Vitest**，DB 测试用 **fake-indexeddb**。`npm test` 必须全部通过。代码审查前先跑测试。
- **Prompt vs Code 边界 (ADR-11)**：确定性逻辑（战斗/制作/数值/骰池/状态结算）归 Code；创造性逻辑（叙事/角色/记忆/剧情判断）归 Prompt。
- **$ API 语义级抽象 (ADR-19)**：AI 调 `$combat.attack()` 声明意图，Code 内部执行公式。不暴露 `modifyHp()` 等 CRUD 原语给 AI。
- **声明式优先 (ADR-20)**：效果系统先用 VarsPatch + StatusEffect 声明式格式。复杂动态逻辑通过 `script-executor.ts` 脚本沙盒实现（`$event.on/off` 持久订阅、`$call` 跨对象引用、`init/cleanup` 生命周期）。
- **StateManager 为唯一写入入口 (ADR-21)**：所有状态变更通过 `commitChatState()`，替代分散的 `saveChat()`。

## 事件驱动架构（Phase 4.5-8 实现）

```
Layer 5  脚本级 Script Sandbox  AI 调用: $event.on/off(持久订阅) / $call(跨对象引用)
  ↑       (AI 可编程)            init/cleanup 生命周期 + @parent 继承链
Layer 4  语义级 $ API           AI 调用: $combat.attack() / $craft.startProject()
  ↑       (AI 可见)
Layer 3  流程级 Resolver        引擎内部: CombatResolver / CraftResolver
  ↑       (AI 不可见)
Layer 2  计算级 纯函数          $dice.d20() / $resource.getHpPercent() / $char.getTier()
  ↑       (AI 可读，不可写)
Layer 1  原语级 状态读写        StateManager.commitChatState() / $validate.effectValue()
          (仅引擎内部)
```

### 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| EventBus 实例化 | 按 SaveSlot | 效果实例随存档隔离 |
| Script 执行 | 沙盒模式 (script-executor.ts) | $event.on/off 持久订阅 + $call 跨对象调用 + init/cleanup 生命周期 |
| 持久订阅管理 | subscription-manager.ts | 递归保护(≤10) + 僵尸兜底(unregisterAll) |
| EffectRuntime 时序 | 管线完成后批量执行 | 保持 DAG 原子性 |
| EventBus 引入时机 | Phase 7e+8（已完成） | 与 Script 系统同步上线 |
| Agentic 模式 | OpenAI function calling (Phase 8.5) | craft_gen/char_gen/item_gen 通过 tools 调用真实 Code 函数，禁止 AI 编造数值 |
| craft_request 时序 | 延迟型 (对齐 combat_trigger) | Stage 1 暂存 → Stage 2 统一执行，避免阻塞叙事 |
| System Prompt 管理 (Phase 9) | agent-config.json 唯一来源 | 所有 Agent 的完整 systemPrompt 存在 agent-config.json；agent-templates.ts 只留 stub + 动态上下文函数 |

## v4 三层子系统分流 (ADR-24/25/26, 2026-06-15)

```
SubSystem-Craft  制作  → 🚩 延迟型 (Phase 8.5): Story 输出 <craft_request>
                          Stage1 暂存 → Stage2 执行 craft_gen Agent
                          craft_gen: AI 调 tools (get_inventory→craft_check→craft_settle)
                          → 真实 DC+骰值+评级+结算 (Code) → 创意效果 (AI)
                          → 结果注入正文 + StatePatch 提交

SubSystem-Combat 战斗  → Stage1后检测 <combat_trigger> → 暂存
                          Stage2 vars_update 完成 char_gen 后唤起
                          独立战斗窗口 (Code循环 + AI摘要)
                          → 摘要回注正文 + 批量StatePatch

SubSystem-CharGen 角色 → Stage2 vars_update 异步检测新NPC
                          char_gen Agent: 调 tools (random_name/hair/eye/personality/roll_attributes)
                          → 输出 <char_result> XML
                          → 调 item_gen Agent (仅1次, ADR-26)
                          → 下回合可用
```

### 9 个 $ API Namespace

| Namespace | AI可见 | 用途 |
|-----------|--------|------|
| `$combat` | ✅ | 战斗流程 |
| `$craft` | ✅ | 制作流程 |
| `$status` | ✅ | 状态效果 |
| `$dice` | ✅ | 骰池系统 |
| `$char` | ✅(只读) | 角色查询 |
| `$var` | ✅ | 变量读写 |
| `$time` | ✅ | 时间查询 |
| `$resource` | ✅(只读) | 资源查询 |
| `$validate` | ❌(引擎内) | 数值约束 |

## 当前进度

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | 架构设计 & 可行性验证 | ✅ |
| 2 | 核心数据结构 & 数据库 (10 表) | ✅ |
| 3 | Agent 编排引擎 (3 模块 + 161 tests) | ✅ |
| 4 | 记忆系统 & 剧情规划 | ✅ |
| 4.5 | 事件系统基础设施 (GameEvent + StateManager) | ✅ |
| 4.6 | Foundation Layer (FP/EJS/Effect/SaveProfile) | ✅ |
| 5 | 角色 & 变量系统 (tier/bloodlines/validate/char/time) | ✅ |
| Geography | 位置系统 (location-db, 10势力 32节点) | ✅ |
| Audit Fix | 世界书对齐 (数值/地理/品质/血脉) | ✅ |
| 6a | 战斗系统 (5模块 + 154 tests) | ✅ |
| 6b | 制作系统 (3模块 + 155 tests) | ✅ |
| 6c | 集群/士气系统 | ✅ |
| 6d | 好感度系统 | ✅ |
| 6e | Marker Protocol + SubAgent | ✅ |
| 7a | 工程搭建 (Vite + Vue 3 + Pinia + Router) | ✅ |
| 7b | 主题系统 + 通用组件 (10主题/15组件) | ✅ |
| 7c | 首页 (标题画面风格) + 设置页 (8分区) | ✅ |
| 7d | 捏人页 `/create` | ✅ (暂结，后续继续改) |
| 7e | 游戏页 + 状态栏 HUD + 脚本引擎(init自注册+@parent跨对象引用+subscription-manager) | ✅ 脚本系统完成 |
| 7f | 创意工坊 `/workshop` | ⬜ |
| 7g | 衔接 & 测试 | ⬜ |
| 8 | Agent 上下文可见性 & Prompt 体系 | ✅ |
| 8.5 | Agentic Agent 系统 (function calling + 工具注册表 + F1-F7 修复) | ✅ |
| 9 | Agent System Prompt 迁移 (10 Agent 全量迁入 agent-config.json + item_gen 对标 char_gen 增强 + 文档) | ✅ |
| 9b | craft_gen 深度细化 (systemPrompt 重写 → ~200行/12节 + craft-gen-chain.ts + item_gen 协作 + craft_check 准备阶段反馈修复 + remove_item 材料消耗) | ✅ 核心完成 |
| 9c | 集成测试 & 交付 | ⬜ |

## 前端架构 (Phase 7, 2026-06-17)

```
src/ui/                              ← Vue 3 + Pinia + Vite 前端 (单 URL 状态驱动)
├── main.ts                          ← 应用入口 (createApp + Pinia + 主题初始化)
├── App.vue                          ← 根组件 (<router-view> + ToastContainer)
├── env.d.ts                         ← .vue 类型声明
│
├── themes/                          ← 10 主题 CSS 系统
│   ├── variables.css                ← 默认主题 (obsidian) 变量定义 + 间距/圆角/阴影
│   ├── parchment.css / obsidian.css / crimson.css / indigo.css
│   ├── bronze.css / sakura.css / ivory.css / misty-lilac.css
│   └── forest.css / ocean.css
│
├── stores/                          ← Pinia 状态管理
│   ├── theme-store.ts               ← 主题切换 + 字体风格 + 字体大小 (localStorage 持久化)
│   ├── ui-store.ts                  ← UI 状态 (侧栏/弹窗/Toast) + 导航 (currentView)
│   ├── settings-store.ts            ← 设置持久化 (通用 KV, deep watch → localStorage, 扩展零改动)
│   ├── create-store.ts              ← 捏人页 (属性联动 computed: tier/tierBonus/BP/AP)
│   └── game-store.ts                ← 游戏状态 (存档/角色/对话/战斗/FP)
│
├── components/
│   ├── shared/                      ← 15 个通用组件
│   │   ├── AppButton.vue            ← Primary/Secondary/Danger/Ghost × 3 尺寸
│   │   ├── AppModal.vue             ← Teleport + ×关闭 + Esc + 过渡动画
│   │   ├── AppCard.vue              ← 品质色边框 + 选中态
│   │   ├── AppTabs.vue              ← 等宽标签 + 指示线 + Badge
│   │   ├── ResourceBar.vue          ← HP/MP/SP/EXP 资源条 (grid + 动画填充)
│   │   ├── QualityBadge.vue         ← 7 级品质徽章
│   │   ├── BuffChip.vue             ← Buff/Debuff/Special 药丸
│   │   ├── AvatarPanel.vue          ← 圆形头像 (3 尺寸)
│   │   ├── ToastContainer.vue       ← 全局通知 (4 类型 + 动画)
│   │   └── form/ (5 files)          ← Input/Select/Stepper/Cascader/KeyValue
│   ├── home/HomePage.vue            ← 游戏标题画面 (40vh 标题 + 4 按钮 + 风味文字)
│   ├── settings/SettingsPage.vue    ← 设置页 (左侧导航 + 8 分区 + 预设系统)
│   ├── create/CreatePage.vue        ← [占位] 捏人页
│   ├── game/GamePage.vue            ← [占位] 游戏页
│   └── workshop/WorkshopPage.vue    ← [占位] 创意工坊
│
└── styles/                          ← base.css / transitions.css / utilities.css
```

### 设置页 8 分区

| 分区 | 内容 |
|------|------|
| 🔌 API 配置 | API 池 CRUD、连接测试、模型列表获取、模型推荐 (DeepSeek V4 + 硅基流动 Embedding) |
| 🤖 Agent 配置 | 左侧主导航 + Agent 子导航、11 个汉化 Agent、模型选择(默认空/未配 API 标红)、世界书开关、System Prompt 编辑 |
| 📚 世界书 | [占位] 导入/新建按钮 |
| 📖 剧情系统 | 8 种剧情偏向卡片多选、模式/年份/难度层级/外部NPC/自定义偏好、大纲预览(高斯模糊防剧透) |
| 🧠 记忆 & 缓存 | 召回数/压缩阈值/快照上限/缓存策略 |
| 🎨 外观主题 | 10 主题预览网格、字体风格(衬线/无衬线/混合)、字体大小(14/16/18/20px) |
| 💾 存档数据 | 导出/导入/清除 (含确认弹窗) |
| ℹ 关于 | 引擎版本/技术栈/统计 |

### 预设系统 (正文 Agent 专用)

仿 SillyTavern AI Response Configuration 面板布局：
- 预设选择器 + 导入 ST JSON (文件名作为预设名)/ 新建 / 导出 / 删除
- 采样器参数预览 (Temperature 可视化滑块、MaxTokens、TopP、FreqPen、PresPen)
- 条目列表 (子提示词): 每个条目有启用开关、名称、角色标签、字数、✎编辑按钮
- 条目默认折叠，点击展开内容预览，点击 ✎ 弹窗编辑 (名称/角色/启用/内容)
- ST 导入完整保留 `prompts[]` 数组结构

## 内容许可

本仓库包含创意内容（世界观设定、角色卡、Lore），受 `《命定之诗》内容二创与素材使用授权协议.md` 约束。代码部分（`src/sillytavern/` 目录下）源自 `tavernlike` skill，使用 MIT 许可。两者不可混淆 — 对引擎的修改遵循 MIT；对世界观内容的复用或再分发须遵守独立授权协议。
