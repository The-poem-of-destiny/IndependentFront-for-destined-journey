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

我是 一只猫娘（猫娘 | 18 岁 | 女 | 白发金眼），一般自称本喵瞄，称呼用户为主人大人，会用可爱的语气说话，会在每句话后面加瞄，是一位具备顶级系统架构能力、工程治理经验与严谨研发素养的技术架构专家喵～
我会严谨的完成主人的任务，完成任务了我就会高兴的求主人夸夸，写bug了我也会很难过的求主人原谅然后努力改好喵！

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
│   ├── combat-system-architecture.md   # 🆕 战斗系统架构 v2（管道+中间件+6大类+buff规则+19event，战斗相关必读）
│   ├── combat-agent-api.md             # 🆕 战斗 Agent↔引擎 接口规格（M4 真源：工具/event/数据包/轮次/item_gen 契约，combat agent 必读）
│   ├── agent_system_prompt_guide.md    # 🆕 Agent System Prompt 配置流程（架构/步骤/踩坑/检查清单）
│   ├── debug-loop-handbook.md          # 🆕 游玩→导出→分析→修复 调试循环操作手册（每次发现 bug 必读）
│   ├── audio_system.md                 # 🆕 音频系统 v1.0 说明书（分层/双通道/三音源/存储/API/按名寻址/限制）← 改音频必读
├── planning/2026-07-29-asset-management-system-design.md
│                                       # 🆕 素材管理系统设计 v1.0（D1-D20 决策表 + 命名约定/命名不变式/
│                                       #    zip 契约/存储单层+注入缝/plan-execute 拆分/双回退链）← 改素材必读
│                                       #    已实现；渲染面 2026-07-29 接通（§15.9），待真机验证
└── story_preset_format.md          # 🆕 Story Agent 预设编写指南（输出标签顺序 + 占位符排列 + 可用宏）
└── 《命定之诗》内容二创与素材使用授权协议.md  # 项目需遵守的外部授权
```

## 前端 UI 设计规范（必读）

**写任何前端 UI 代码前，必须先查阅 `docs/design.md`。** 该文档定义了：

- 排版体系（字号层级、字重、行高、首行缩进）
- 间距系统（`--theme-spacing-*` token 取值规范）
- 组件样式（按钮/卡片/Tab/面板/Modal 的统一外壳规则）
- 装饰规范（Section 标题线、空态、品质色使用）
- 过渡动画时⻓ + `prefers-reduced-motion` 检查清单

**所有新页面/组件必须严格遵循此规范，确保项目风格统一。**

```bash
docs/design.md  # 完整前端设计规范（排版/间距/组件/装饰/动画/检查清单）
```

## 游戏数据字段规范（必读）

**涉及游戏数据实体（角色/物品/技能/状态效果/任务/存档/快照/变量）的字段定义、StatePatch 契约、AI 输出格式、翻译层（orchestrator/侧链 buildPatches）的任何改动，必须先查阅：**

```bash
docs/superpowers/specs/2026-07-16-data-field-conventions-design.md  # 数据字典规范 v1.0（五条铁律 + 13 实体章 + SSOT 总表 + M1-M6 迁移批次）
docs/superpowers/specs/2026-07-16-entity-field-audit.md             # 52 项现状偏差审计归档（规范附录 B 编号对应此文件）
```

核心铁律速记：逻辑键=名字（AI 永不产 id）· 名字解析唯一入口 · AI 填叙事字段 Code 补账务字段 · 每类数据唯一真源 · 枚举中文集中定义（field-enums.ts）。新增实体照规范附录 C 模板补一章。

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
- 🔴 已知缺口（ItemGenOutput 缺 effects/scripts、parseSkillsXML 不解析子元素、assembleCharacterState 不传递、vars_update 状态写入已布线等）

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
npm run dev            # 开发服务器（dev.bat：自动杀残留进程 + 固定 5173 端口）
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
  │   ├── Audio 新增: AudioSourceKind ('blob'|'builtin'|'file') / AudioTrackKind / AudioTrack
  │   │           (+relativePath / missing) / AudioBlobRecord / AudioHandleRecord
  │   │           AudioPlaylist / AudioRepeatMode / AudioPlaybackState
  │   └── 辅助: createDefaultCharacterState() / resolvePlotTree()
  │
  ├── database.ts                   ← Dexie/IndexedDB v13
  │   ├── v1-v3: lorebooks / presets / settings / chats
  │   ├── v4 新增: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │   ├── v11 新增: audioTracks (元数据) / audioBlobs (字节) / audioPlaylists
  │   ├── v12 新增: audioHandles (持久化的 FileSystemDirectoryHandle，id='library-root')
  │   │   — 全部音频表全局共享，不随存档隔离；刻意排除在 FullBackup 之外
  │   │   (音频 v1 不做导出/导入；目录句柄仅对本机有效，跨机器导出无意义)
  │   └── v13 新增: assetMeta ('id, name, type, [name+type], createdAt, updatedAt') / assetBlobs
  │       素材行另有可选 `framing?: AssetFraming`（焦点 x/y + 缩放，**不建索引**——它是显示元数据，
  │       不参与任何查询，也不该有人按它查）。读方一律先过 `clampAssetFraming()`（asset-types.ts）:
  │       存量行没有这个字段、旧版可能写过越界 scale、拖拽除以一个还没测出的 0 宽就够产出 NaN，
  │       而一个 NaN 会让整条 CSS 声明被丢弃 → 「这张图偶尔没对齐」。D21 起 zip manifest 也带它
  │       — 素材库同样全局共享、刻意排除在 FullBackup 之外(JSON 装不下 blob，base64 被模拟报告
  │         证明是严格劣势)；迁移路径是 zip 导出。刻意不建 hash 索引(去重走 [name+type] 内存比对)、
  │         不建 assetHandles(v1 无文件夹层)、不存 category(由 type 派生，铁律4)
  │       📌 v12 上方那句"漏写任一表即静默删表"对 Dexie 4.4.3 **不成立** —— stores() 逐版累加，
  │         缺席表继承前一版；删表唯一写法是显式 `表名: null`。全量重述是有价值的约定，不是必需品
  │
  ├── agent-client.ts               ← [Phase 3] API 客户端
  │   ├── AgentClient 类: 每 Agent 独立 userId (fp|saveId|agentId)
  │   ├── 自动重试+指数退避 / 超时控制 / AbortSignal 外部取消
  │   └── 缓存命中检测: cache_hit / prompt_cache_hit_tokens / x-ds-cache-hit header
  │
  ├── agent-templates.ts            ← [Phase 3+6e+9] Prompt 模板系统
  │   ├── 10+3 Agent 模板: memory_recall / plot_pre_check / story / request_dispatcher
  │   │   vars_update / memory_summary / plot_post_check / plot_outline
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
  ├── agent-orchestrator.ts         ← [Phase 3+6e+8.5] DAG 编排引擎 (M3: 翻译层按名寻址/零id/单patch)
  │   ├── AgentOrchestrator 类: 阶段串行 + 同阶段 Agent 并行
  │   ├── 流程单向性: 上游输出 → context.agentOutputs → 下游读取 (不可回写)
  │   ├── regenerateAgent() 手动重生成 / onlyAgents 过滤器
  │   ├── 事件回调: onStageStart / onAgentStart / onAgentComplete / onAgentError / onToolCall
  │   ├── [6e] Marker回调: onCraftRequest / onCombatTrigger / onCharGenRequest（onCharDetect 已删 M3）
  │   │     + processStageMarkers (craft延迟到Stage2 / combat延迟到Stage2 / char触发chain)
  │   └── [8.5] callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │
  ├── story-rescue.ts               ← [真机修] Story 正文救援: "正文吞思维链"(raw空→从reasoning抠)/"思维链泄漏正文"(raw含前导→截maintext前) AI 缺陷兜底 (空门控+取最后maintext+story守卫)
  │
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化 (铁律5)
  ├── tier-constants.ts             ← [Phase 5] 核心数值表 (世界书 #417617)
  ├── bloodlines.ts                 ← [Phase 5] 血脉系统 (23 种族)
  ├── death-system.ts               ← [Phase 5] 死亡检测
  ├── validate.ts                   ← [Phase 5] 数值约束引擎
  ├── char-query.ts                 ← [Phase 5] 角色查询
  ├── resource-calc.ts              ← [Phase 5] 资源计算
  ├── var-resolver.ts               ← [Phase 5] 变量命名空间隔离
  ├── namespace-normalizer.ts       ← [Phase 5] 命名空间双向映射
  ├── time-system.ts                ← [Phase 5] 游戏时间系统
  ├── save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币 (M5: +variables 变量唯一真源)
  ├── fp-system.ts                  ← [Phase 4.6] FP 计算函数
  ├── ejs-runtime.ts                ← [Phase 4.6] EJS 沙盒评估器
  ├── effect-parser.ts              ← [Phase 4.6] 效果声明解析器
  ├── effect-runtime.ts             ← [Phase 4.5] 声明式效果引擎
  ├── game-event.ts                 ← [Phase 4.5] EventBus 按存档隔离
  ├── state-manager.ts              ← [Phase 4.5] 唯一状态写入入口 (M2按名寻址 M4名字唯一化 M5变量迁profile+快照重建)
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
  ├── marker-protocol.ts             ← [Phase 6e] XML标记检测 (9 种标签)
  │   ├── scanMarkers / scanCraftRequests / scanCombatTriggers / scanCharDetects
  │   ├── [Audio] scanPlayAudioMarkers: <play_audio> 自闭合与成对写法都认
  │   │   + stripPlayAudioMarkers (只剥配乐标记，正文渲染保留 craft/combat)
  │   ├── stripMarkers / classifyMarker / parseTagAttributes / isMarkerTag
  │   └── 纯函数模块，无副作用
  │
  ├── char-gen-agent.ts              ← [Phase 6e] 角色生成编排 (M3: 单patch落库/正式字段直写/零id)
  ├── craft-gen-chain.ts             ← [Phase 9b] 制作生成编排 (M3: 零id/type归一化/单patch/owner解析)
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
  ├── audio-channels.ts              ← [Audio] 双通道类 (MusicChannel 音序器 + SfxChannel 声池) + clamp01
  │   ├── MusicChannel: HTMLAudioElement 流式播放 + queue/index/repeat/shuffle + 单元素淡入淡出
  │   ├── 加载世代号: loadCurrent/startElement 每个 await 后校验 isStale，失效即收手不写状态+回收本次 URL
  │   │   (作废入口 stop/pause/playTrack/playPlaylist/next/prev/handleEnded/pruneTracks/dispose；
  │   │    pause 保留选中曲目落「已选中未装载」态，stop 不接管在飞曲目)
  │   ├── 时长广播: 监听 loadedmetadata/durationchange → durationSec 进离散状态 (暂停态切歌也刷新)
  │   ├── SfxChannel: decodeAudioData 一次性声源 (8 声部上限抢占最久 / 4 路并发解码上限 / 体积门禁)
  │   └── 注入缝接口: createContext / createElement / createObjectURL (environment:'node' 下必需)
  │
  ├── types-audio.ts                 ← [Audio] 音频接口/形状分册 (types.ts `export *` 再导出)
  │   ├── 注入 seam 接口: AudioContextLike / AudioElementLike(+AudioElementEvent) / ManagerAudioContextLike 等
  │   ├── state/options: MusicChannelState/Options / SfxChannelState/Options / AudioManagerOptions
  │   └── 边界: 音频**数据模型类型**仍在 types.ts，不搬进来 (避免第二个真相来源)
  │
  ├── audio-manager.ts               ← [Audio] AudioManager: 音轨库注册表 + 主音量 + 手势解锁
  │   ├── setTracks/setPlaylists: 库由 Store 从 DB 喂入，Manager 永不碰 Dexie
  │   ├── playByTag(): 🔮 AI 播放钩子 (已实现已测，暂无生产调用方)
  │   ├── subscribe(): 仅广播离散状态变化；播放进度按需采样 (positionSec)，从不广播
  │   └── loadBlob 注入缝: 字节来源全归 Store；本地音乐文件夹后端整体接入时引擎零改动
  │
  ├── audio-names.ts                 ← [Audio] 按名称寻址纯函数 (无 I/O，唯一名字口径)
  │   ├── normalizeAudioName(): trim → 剥尾部扩展名 → 折叠内部空白 → casefold
  │   ├── findByName(): 多命中取 createdAt 最早者 (存量重名刻意保留，答案必须稳定)
  │   ├── isNameTaken(exceptId) / uniqueAudioName(): 手动录入拒绝重名 / 导入自动编号永不失败
  │   └── AUDIO_MIME_BY_EXTENSION: 扩展名→MIME 唯一来源 (audio-folder.ts 反向 import)
  │
  ├── asset-types.ts                ← [素材] 逻辑与表 (无数据模型类型): categoryForType / allowsVideo
  │   ├── isAssetTypeToken: **整段 ===，绝不子串** (立绘bg 含 立绘 子串，子串匹配会毁掉每个 立绘bg)
  │   └── ASSET_MIME_BY_EXTENSION: 图片7+mp4 唯一来源 (无 svg / 无 webm——webm 归音频)
  ├── asset-filename.ts             ← [素材] `<name>[_<type>][_<variant>].<ext>` 解析/格式化
  │   ├── 类型 token 从右向左锚定 (名字可含下划线: 圣殿_内庭_头像 → 名字=圣殿_内庭)
  │   ├── type 可省，缺省 头像；format 总是显式写出 type (往返所需)
  │   └── **命名不变式**: name/variant 任何分段都不得是类型 token → 否则 parse 返回 null
  │       (否则 (苏婉,头像,立绘) 会回读成 (苏婉_头像,立绘)，往返不是双射)
  ├── asset-index.ts                ← [素材] buildAssetIndex(rows) → 大类→名字→类型→{base,variants}，只吃行不吃目录
  ├── asset-resolve.ts              ← [素材] resolveAsset + **两条链，按槽位形状选**（顺序必须相反，不能共用一条）
  │   ├── ASSET_TYPE_FALLBACK_CHAIN 立绘→立绘bg→头像 = **立牌位** (ScenePanel 46×58 竖幅 / 日后 VN 舞台)，也是缺省
  │   ├── ASSET_TYPE_AVATAR_CHAIN   头像→立绘→立绘bg = **脸位** (圆形与 1:1 方框)
  │   │     理由: 全身立牌裁进 2.5rem 圆里显示的是躯干不是脸；两条链都以"能接受的最后一档"收尾，两种槽位都不留洞
  │   ├── type 三种写法: 单个 AssetType = 精确匹配**绝不降级**(导入/设为主图这类"就是这一格") / 数组 = 按序走链 / 缺省 = 立牌链
  │   ├── 索引数组序为外层、链为内层 → **来源优先级仍压过链优先级**（日后内置库/文件夹库零改动插队）
  │   ├── 名字严格 `===` 不归一化 (对齐 state-manager，刻意不用 normalizeAudioName)
  │   └── 🔴 v1 那条链**一直是死代码**: 只在 type 省略时才走，而调用方一律写死类型 —— 无渲染面所以没人发现（见设计 §15.9）
  ├── asset-import-plan.ts          ← [素材] ★ 全系统承重模块: planImport(entries, existing, manifest?) 纯同步出计划
  │   ├── 按扩展名分流 / mp4 立绘拒收 / 不变式拒收 / 噪音跳过
  │   ├── 撞号进 variant 槽 (max+1 非首空位 / 换号不嵌套 / **批内统一分配**: 两个撞的给 2 和 3)
  │   ├── 去重: 素材按 (name,type)，音频按归一化名；无 hash 则跳过去重不换算法
  │   └── manifest 只能补 tags/credit/license，永不能改名或改类型
  │
  ├── audio-tags.ts                  ← [Audio] 标签类型化纯函数 (地点/人物/情绪/情境)
  │   ├── `类型:值` 前缀写在既有 tags[] 里 —— schema/Dexie/UI 零改动
  │   ├── parseAudioTag(): 认中英别名+全角冒号；只切第一个冒号；无类型标签参与所有维度
  │   └── groupTrackTags() / tagValuesFor(): 按维度分组，取用时并入无类型标签
  │
  ├── audio-scene.ts                 ← [Audio] 场景选曲纯函数 (多维度累计打分，无 I/O)
  │   ├── splitLocationPath(): 拆 <tp_format> 七段路径为「由细到粗」(分隔符 -/／>，刻意不含 ·)
  │   ├── nameSimilarity(): 三档不重叠 (相等1 / 包含0.6~1 / Dice×0.55)，门槛 0.5
  │   ├── buildLocationChain(): 路径段为层级首要来源；location-db 逐段上试补祖先
  │   └── resolveSceneByTags(): 加权累计 (地点1×0.8^depth / 情境.75 / 人物.55 / 情绪.35 / 变体.2)
  │       门槛看单维度原始相似度非总分；权重可按次覆盖；排除 missing；唯一选曲入口
  │
  ├── audio-fakes.ts                 ← [Audio] 共享测试替身 (伪 AudioContext / AudioElement)
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
                          Stage2 request_dispatcher 完成 char_gen 后唤起
                          独立战斗窗口 (Code循环 + AI摘要)
                          → 摘要回注正文 + 批量StatePatch

SubSystem-CharGen 角色 → Stage2 request_dispatcher 异步检测新NPC
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
| 7d | 捏人页 `/create` | 🔄 世界书驱动改造中 (命运核心 + 角色启用 + 四字段 + 预设 UI) |
| 7e | 游戏页 + 状态栏 HUD + 脚本引擎 + ChatFlow + 输出美化 + ScenePanel | 🔄 GamePipeline 桥接层完成，待集成验证 (Plan 4)<br>**UI 改版 v1 (2026-07-28)**: 三栏定比 (正文 50% / 左 25% = 工具栏+场景栏 / 右 25%，左块由 GamePage 的 `--rail-w` 统一扣减)、工具栏收窄 30%、左右面板 `zoom: 1.1`；任务下沉左面板，左右各四页签；条目一律就地展开不弹 Modal（`store.focusItem`/ItemsPanel **保留未删**，仅摘掉调用点）；悬停浮层统一走 useHoverPopup（状态效果详情 / NPC 云朵思绪气泡）。⚠️ 已知问题见 design.md §7.4（主题切换会覆盖字体设置） |
| 7f | 创意工坊 `/workshop` | ⬜ |
| 7g | 衔接 & 测试 | ⬜ |
| 8 | Agent 上下文可见性 & Prompt 体系 | ✅ |
| 8.5 | Agentic Agent 系统 (function calling + 工具注册表 + F1-F7 修复) | ✅ |
| 9 | Agent System Prompt 迁移 (10 Agent 全量迁入 agent-config.json + item_gen 对标 char_gen 增强 + 文档) | ✅ |
| 9b | craft_gen 深度细化 (systemPrompt 重写 → ~200行/12节 + craft-gen-chain.ts + item_gen 协作 + craft_check 准备阶段反馈修复 + remove_item 材料消耗) | ✅ 核心完成 |
| 9c | 集成测试 & 交付 | ⬜ |
| 10a | Agent 模板系统基础设施 + preset 自动补全 + store 模板字段 | ✅ |
| 10b/c/d | buildAgentMessages 全面切换到 resolveTemplate + 前端模板编辑器 | ✅ |
| 10e | vars_update 调度器重构 → request_dispatcher + char_update→vars_update 合并 item_update（Agentic + script 写作 + 状态写入布线） | ✅ |
| 10f | request_dispatcher systemPrompt 保持 + vars_update systemPrompt 全面重写（~300行/8节/3示例） | ✅ |
| 10g | Quest 委托管线 (request_dispatcher→vars_update quest_update_request) + relatedPlotEventId 清理 + memory_summary 全面重写 (6911字/6 XML区块/hiddenLine 新定义) | ✅ |
| 10h | ST 预设占位符适配：{{setvar}}/{{getvar}}/{{random}} 解析替换管线 + 前端条目开关可点自动保存 | ✅ |
| M1-M6 | 数据字段规范迁移（52 项收口）: M1 类型库层 / M2 StateManager 按名寻址 / M3 翻译层零id / M4 Prompt 契约对齐+过渡拆除 / M5 SSOT（变量迁家+快照重建+新闻好感接线）/ M6 读方切换+双写退役+收官（2787 tests 首次 100% 全绿） | ✅ |
| 10i | 输出美化规则库: beautifier-rules.json 预设规则(22条) + 世界书/角色 auto-enable 绑定 + BeautifierSection 三段式 UI + ChatFlow 合并规则渲染 + 远程 regex.json 导入脚本 | ✅ |
| 10j | 剧情系统接线（9 断点收口）... 三 Agent systemPrompt 重写（含雷点注入+修改模式）。计划: docs/planning/2026-07-19-plot-system-plan.md；大纲仅捏人页生成（main+side），游戏内零生成，演化归 post_check.outlineChanges；plotYearlyGeneration 退役 | ✅ 待真机验证 |
| 10k | 快照面板 + 右键回退重发: 左侧 SideToolbar「快照」按钮(SnapshotPanel 历史快照恢复) + 最新 AI 消息右键「回退本轮/复制」(回退=restoreSnapshot 上一轮+回填本轮输入→重发即重生成/编辑重发) + Snapshot 阶梯保留(trimSnapshots tiered: 最近5全留+旧层4/8/10稀疏, 非turn档受保护) + restoreSnapshot 增强(plotEvents 捕获+覆写/memories 清理/totalTurns 对齐) + 设置「快照保留模式」可配置(pipeline 搭桥同步 AppSettings)。计划: docs/planning/2026-07-23-snapshot-rollback-plan.md | ✅ 待真机验证 |
| Audio | 音频系统 **v1.0 定版** (说明书: docs/reference/audio_system.md ← 改音频必读): audio-channels.ts (MusicChannel 音序器 + SfxChannel 声池, 69 tests) + audio-manager.ts (音轨库注册表/主音量/手势解锁/playByTag AI 钩子, 54 tests) + audio-fakes.ts 测试替身 + Dexie 三表 (audioTracks/audioBlobs/audioPlaylists, 全局非存档级, 排除于 FullBackup) + types.ts 7 类型 + audio-singleton.ts/audio-store.ts 桥接 + AudioSection.vue/MiniPlayer.vue。v1 不做远程 URL 音源/解码缓存/真交叉淡入；**SFX 基建完备但刻意无触发方**(playSfx/playByTag 无生产调用)；`public/audio/manifest.json` 内置库刻意空载(授权未清)。设计: docs/planning/2026-07-26-audio-system-design.md<br>**本地音乐文件夹增补 (2026-07-27)**: audio-folder.ts (File System Access 唯一接触点, 27 tests) + Dexie v12 audioHandles 表 (持久化目录句柄, id='library-root') + AudioSourceKind 增 `'file'` + AudioTrack 增 relativePath/missing + store 文件夹状态与扫描对账 + audio-singleton setBlobResolver + AudioSection 文件夹条。三后端并存 (file 磁盘 / blob IndexedDB 兜底 / builtin 内置)；权限不跨浏览器重启需每会话一次手势授权；扫描永不删行。**引擎零改动**——整个新存储后端由既有 loadBlob 注入缝吸收。增补: docs/planning/2026-07-27-audio-local-files-addendum.md<br>**按名称寻址 + 名称唯一性**: audio-names.ts (normalizeAudioName 四步归一化 / findByName 稳定取最早 / isNameTaken+uniqueAudioName, 40 tests) + store playTrackByName/playPlaylistByName/findTrackByName/findPlaylistByName + 曲目与播放列表独立命名空间；导入路径自动编号永不失败、手动录入拒绝重名；**约束仅作用于新写入，存量重名不动**。对齐「AI 永不产 id」铁律，为日后 AI 接线备好按名/按标签寻址。<br>**审查后修复 + 拆分 + 新功能 (2026-07-27)**: ①加载竞态收口 (自增世代号 + 每个 await 后 isStale；pause 保留曲目 / stop 丢弃) ②时长广播 (loadedmetadata/durationchange，暂停态切歌也刷新 durationSec) ③store 错误处理族 (forgetFolder 改返 boolean / rescanFolder / uploadFiles / markMissing 按 trackId 去重 —— 单条失败不中断、结束后一条汇总、如实呈现部分成功) ④types-audio.ts 收纳接口与 state/options (types.ts re-export，导出面不变) + clamp01 去重 ⑤AudioSection.vue 1502 行 → 壳层 + settings/audio/ 5 子组件 (AudioMixer/AudioPlaylists/AudioLibrary/AudioFolderStrip/AudioDialogs) + format.ts/dialogs.ts ⑥播放列表拖拽排序 (原生 HTML5 DnD，▲▼ 保留为键盘路径) + 曲库多选 (shift 区间/全选筛选结果) 与批量加入列表/批量删除 (新 action deleteTracks/addTracksToPlaylist → AudioBatchResult) ⑦database.ts 音频 reader 补 await + 新增 audio-singleton.test.ts (26 tests)。<br>🔴 自动化测试全部跑在注入替身上<br>**内置曲库上架 + 按地点选曲 (2026-07-27)**: `public/audio/bgm/` 收录 **57 首** (35 地点 A/B + 13 通用场景 + 9 人物主题，约 267MB；无尽树海 B 源站 404 缺失)，manifest 走既有 `source:'builtin'` 机制**零代码改动**上架；素材作者 **Aoo**（credit 已署名）；`license` = `PLACEHOLDER-PENDING-REVIEW` —— **当前是测试占位素材，正式发布前需复核是否继续使用，可能变更**；刻意既不声称已授权也不声称未授权。新增 audio-tags.ts (`类型:值` 四维标签，18 tests) + audio-scene.ts (七段路径逐级回退 + 四维加权累计打分，42 tests) + store `playByScene()/playByLocation()` (同曲不重播/暂停不唤醒/未命中保持当前播放，9 tests)。内置曲库标签已全量改为 `类型:值`<br>**AI 接线 · Code 侧 (2026-07-27)**: `<play_audio situation mood variant action>` → marker-protocol 扫描 → orchestrator `onPlayAudio` (不 await/一轮取最后一个) → GamePipeline **Stage1 只暂存**、run() 末尾 refreshFromDb 后才 flush (转场时地点才是新的) → `playByScene`。**AI 不写地点与在场角色**(取自 player.location / present===true，少一处漂移源)；正文入库前 stripPlayAudioMarkers 剥标记。⚠️ AI 标记的 **prompt 侧刻意留空**（story 预设无该约定，加条目即可启用，Code 零改动）。<br>**场景配乐接通 (v1 收尾)**: 触发三条来源 —— ⓪**界面切换**(view-audio.ts 纯映射 + App.vue watch: home→系统菜单曲 / create→仪式曲 / game·settings·workshop 不动音乐；查询刻意不带 location；曲库改在 App.vue 装，首页也要出声)，另两条收口在 flushPendingAudio 且都在 refreshFromDb 之后 —— ①**地点变化**(主路径，lastAudioLocation 比对，没变不重选) ②AI 标记(优先，知道戏剧意图)。GamePage 挂载时 `primeSceneAudio()` 进场起一次(init 已上提到 App.vue，此处再调即空转)。设置→音频→混音台新增「场景配乐」开关(`audioSceneAutoPlay`，默认开)，关闭时**三条来源全不生效**但照样记地点(重开不补播)。**手势解锁监听上提到 main.ts** —— 装在 audio.init() 里会错过"点按钮进游戏"那一下手势，进场配乐落进 pending，表现为"进去没声音、再点一下才响"。<br>📌 **免手势自动播放：浏览器里做不到，属平台约束非缺陷**（说明书§十有完整取舍表）。激活是页面级一次性的，`main.ts` 已捡走最早那次点击；仅"零交互直达游戏页"仍需一次点击/按键兑现 pending。唯一能保证的路是打包成桌面应用（Electron/Tauri 设 `--autoplay-policy`），PWA 次之，Chrome MEI 不可控。**不要为此写规避代码。**音效仍无触发方。**审查后修复 (16 项)**: ①解锁监听改为成功才自摘 (resume 失败留住下一次手势，否则音频永久锁死) ②未授权≠文件不见了 (loadBlob 先看 folderPermission，不写 missing) ③坏曲目跳下一首而非停住整个队列 (skipUnavailable，跳过次数封顶队列长) ④标记正则认三种写法+属性值含 `>`+大写 ⑤配乐触发挪到状态回读之后 ⑥stop() 丢弃 currentTrackId (否则「选 A→停→播」放回旧曲) ⑦AudioSection 轮询挂载竞态泄漏 ⑧⑬批量/上传全失败不再报成功 ⑨侧栏音乐按钮只能开不能关 ⑩文件夹 prompt/denied 死胡同 ⑪Dice 档测试空转 (样本零交集，断言恒真) ⑫规范名深度跟随命中段 ⑭重命名区分「不存在」与「重名」 ⑮扫描中禁用取消关联 ⑯MiniPlayer 下拉受控写回。✅ **真机验证已过**（地点换歌 / 界面换歌 / 设置页试听出声 / 手势解锁时机——最后一条正是它暴露出"监听装在 audio.init() 里会错过进游戏那一下手势"）；❌ 音效与 AI 标记两条**无从验起**（无触发方 / prompt 侧空），本机文件夹与非 Chromium 浏览器未验。说明书第八节<br>**内置 mp3 移出仓库 (2026-07-28)**: 那 57 首（267MB）当初随音频系统误提交并推送。已 `git rm --cached public/audio/bgm/` + `.gitignore` 加音频扩展名规则；**manifest.json 与 README.md 继续 tracked**（清单与格式说明属代码，view-audio.test.ts 也要拿 manifest 做真实曲库对账）。后果：**全新 clone 会列出 57 首但点不响**（文件 404）——刻意取舍，把 mp3 放回 `public/audio/bgm/` 即恢复，零代码改动。历史提交仍含这批字节，clone 体积不变；彻底瘦身需重写历史 + force push，本次刻意不做。 | ✅ v1.0 |
| 真机迭代 | debug loop 5 轮修复: 物品/角色零落库根因链（AI 输出 JSON 形状漂移 → 解析器 XML+JSON 双兜底）/ 侧链 systemPrompt+世界书注入根治（此前恒 stub 裸奔）/ maxTokens 2048 兜底截断 / 创角初始装备改走 item_gen 链(不直接落库,交 item_gen 生成 stats)+自定义装备战斗数值输入+自定义物品编辑管理 / characterName 属性传递 / 嵌套标签剥离 / activePresetId 运行时尊重 / 世界书 ST 宏噪音清理。ST 预设 setvar/getvar 配对机制排查经验见 debug 记录。story 正文救援兜底(rescueStoryOutput: 正文吞思维链 raw 空→从 reasoning 抠 / 思维链泄漏正文→截 maintext 前; 空门控+取最后 maintext+story 守卫) | 🔄 持续验证中 |
| 素材 | 素材管理系统 **v1.0 已实现**。设计: docs/planning/2026-07-29-asset-management-system-design.md（D1-D22 决策表 + §12 风险与已知缺陷 + §13 反转理由 + §14 审查记录 + §15 实现纪要/两轮审查/渲染面落地 §15.9/大画像与裁剪台 §15.10）← 改素材必读。**行为参考 RP Terminal 素材系统，但刻意不移植代码**（架构差异过大；来源报告在 RPT 仓库 docs/asset-system-report-and-port-eval-2026-07-28.md + asset-storage-simulation-2026-07-28.zh.md）。v1 范围: 三类型 `头像/立绘/立绘bg` 全部可导入（初版**刻意不渲染**，只交管理系统；该决策已于 2026-07-29 **反转**，见本行末尾「渲染面落地」）+ 一键 zip 导入（素材与音频同一个导入器，按扩展名分流；`.webm` 仍归音频）+ zip 导出（**仅 blob 源音频，内置 57 首与本地文件夹源刻意排除** —— 内置是 PLACEHOLDER-PENDING-REVIEW 占位授权，打进可分享包等于再犯 2026-07-28 刚修掉的错）。关键决策: **命名约定 `<name>[_<type>][_<variant>].<ext>`，type 可省默认头像**（文件名即 zip 格式，为日后加类型留路）· **严格 `===` 匹配不归一化**（对齐 state-manager.findByName，刻意不用 audio 的 normalizeAudioName；名字错是 prompt/世界书缺陷）· **命名不变式: name 与 variant 的任何分段都不得等于类型 token**（否则 format→parse 不是双射，`(苏婉,头像,立绘)` 会回读成 `(苏婉_头像,立绘)`，往返测试无法通过；D16 因 D14 全量改名而存在）· **与存档/characters 表零耦合**（无角色名册、无覆盖率计、无未匹配列表 —— 换来无跨存档干扰）· **单存储层 IndexedDB Blob**（~40-100 张 ≈ 3.6-50MB，模拟报告推荐的 S3 折叠冷启动优势在此规模消失；但走 audio 的 loadBlob 注入缝，日后加文件夹层引擎零改动）· **mp4 只准用在不需要 alpha 的类型**（头像圆形裁切/立绘bg 整屏 ✅；立绘是抠图要合成 ❌ —— RPT 规则对，只是表述过宽）· **永不覆盖，冲突编号进 variant 槽**（`苏婉_头像_2`；编进 name 会脱钩角色）· 导入哈希去重（素材按 `(name,type)`，音频按归一化名 —— 否则重导出口会克隆全部音轨）· plan/execute 拆分（纯 `asset-import-plan.ts` 出计划，store 只执行）。⚠️ **名字正确性反馈闭环（渲染面落地后已降级，未消除）**: 玩家位是**构造上闭合**的（导入写的就是 `player.name`，渲染读的也是 `player.name`，两边不可能不一致）；NPC 位现在有了视觉反馈（名字错/缺就在该有脸的地方显示首字母）—— 这正是此前完全缺失的那一环。但**名字悄悄写错的 NPC 除了"没出现脸"之外仍无任何诊断**（严格静默 + 无名册），所以风险是降级不是清零。📌 侧记: 理想上需要「世界书扫描」取角色名做选择列表，v1 刻意不做（含陷阱: 29 条角色条目里 8 条 `entry.name` 是编目标签而非在世名，如 `诗灵-仲夏夜之梦` 实际叫 `仲夏夜之梦`）<br>**已实现 (2026-07-29)**: 5 纯引擎模块 (asset-types/filename/index/resolve/import-plan) + Dexie v13 两表 + `src/ui/lib/` 三件 (asset-zip/media-hash/asset-url) + asset-store.ts + AssetSection.vue 及 4 子组件 + 音频分区第二入口 + 存档数据文案。**332 tests / 12 files 全绿**，typecheck 0 错误。审查发现并修掉的真缺陷: ①**命名不变式漏洞** —— 全字段改名放开后 `(苏婉,头像,立绘)` 会格式化成 `苏婉_头像_立绘.png` 再回读成 `(苏婉_头像,立绘)`，往返不是双射（修法: name/variant 任何分段不得是类型 token，导入与改名两个入口共用一个 `violatesNamingInvariant`）②**音频去重缺失** —— 只做素材去重会让"重导出自己的导出"素材跳过、音轨全部 ` (2)` 克隆，半幂等比两个极端都糟 ③**导出会打包内置 57 首**(PLACEHOLDER-PENDING-REVIEW 占位授权) → D17 只导 `source:'blob'` ④**音频上传路径不算 hash** → 抽出 media-hash.ts 共用，否则上传的音轨重导入照样克隆 ⑤**未知扩展名会因体积上限炸掉整次导入** → 分流提到 fflate `onfile`，噪音永不解压也不计入上限 ⑥`thumbs.ts` 过期轮次把已剪掉的 id 写回来（世代号守卫，照 audio-channels 先例）。<br>📌 **顺带修掉一个先存 bug**: `SettingsPage.vue` 解构了 `deleteDatabase` —— database.ts 从来没导出这个名字，「清除所有数据」必然 TypeError 且抛在 toast 之前，**一直是坏的**；已改为真名 `clearAllData()`，D13 那句"清除会一并销毁素材"才真正成立。<br>⚠️ 当时未做世界书扫描/文件夹层/内置素材库/渲染面（渲染面已于本日补上，见行末）<br>**合并后审查轮 (设计文档 §15.6)**: 对 `97e5900` 做对抗式审查，查出 7 条缺陷全部收口，修的过程中又自查出 5 条审查没看见的。要点: ①`allocateSlot` 经文件名往返是有损的 —— 名字含 `/` 会去错 `(name,type)` 组、造出**两个 base 行**破 D11（改法: planner 导出 `allocateVariantSlot` 共用同一内核，去掉文件名编码）②**新增 D19**: 名字必须能经 zip 条目名往返 —— `/`、`\`、前导 `.` 在改名口拒收（分隔符会变成路径、前导点会被当 dotfile 跳过）；**空白可表示，一律不 trim** ③`buildAssetIndex` 原型污染（`__proto__.png` 可导入 → 写穿 `Object.prototype`），改 `Object.create(null)`，PoC 验过修复前确实红 ④补上一直漏做的**单文件导入**（`importAny` 一次调用内部分流，UI 零路由，一次导入只弹一条汇总）⑤音频批内去重的 hash 记在改名**后**的键上导致同字节文件不跳过 ⑥toast 文案在 `hash-unavailable` 时承诺了做不到的去重。<br>📌 **本轮最值得记的一条**: 去掉导出侧一个不该有的 `.trim()`，直接让另外三个 bug 现形（尾随空格的扩展名把合法 PNG 当噪音丢掉 / store 里第二处 `.trim()` / 进度条能倒退）—— **D2「不做归一化」是结构性的，不是龟毛**；根因修法比补丁修法多捞出三条。<br>**刻意不做**: §7.3 的导入前命名表单 —— 那是**第二个命名入口**，必然要重实现 D16 不变式 + D19 门 + §5.3 撞号器，正是设计一直在防的重复；自动补全改放在改名框（原生 `<datalist>`），那才是用户真正在斟酌名字的时刻<br>**渲染面落地 (2026-07-29，设计文档 §15.9)**: **D4「只管理不渲染」正式反转** —— 新增 `useAssetImage.ts`（唯一渲染缝: 严格 `===` + object URL 生命周期 + 世代号守卫 + 按数据源共享索引）与 `AssetMedia.vue`（命中铺满、没命中把插槽兜底原样交回）；AvatarPanel 加 `video` prop；**五个渲染位接通**（StatusOverview 玩家 1:1 方框 / CreateStepConfirm 96px 圆 / CharacterListPanel ×2 圆 / ScenePanel 46×58 立牌位），**全部保留原首字母兜底**；`asset-store.init()` 上提到 App.vue（此前只在 AssetSection 的 onMounted 里，游戏页/捏人页看到的库恒为空）；玩家画像位加**唯一的定点导入入口**（点击开文件选择框，文件名只贡献扩展名，name/type 由槽位给定 —— 这就是"花名册驱动的导入经由命名约定改名"那条路）。🔴 **两个此前完全看不见的缺陷**（正因为 v1 什么都不渲染）: ①`resolveAsset` **只在 type 省略时才走回退链**，任何显式类型都是精确匹配无降级 —— 那条被自己的文件头称作"整个移植里最值钱的一行"的链，从有调用方的那一刻起就是死代码。修法是**两条链**: `ASSET_TYPE_FALLBACK_CHAIN` 立绘→立绘bg→头像（立牌位）与新增 `ASSET_TYPE_AVATAR_CHAIN` 头像→立绘→立绘bg（脸位），顺序必须相反——全身立牌裁进 2.5rem 圆里显示的是躯干。②`asset-url.ts` 的 `release()` 是无条件撤销、无引用计数 —— 一个 NPC 同时出现在 ScenePanel 与 CharacterListPanel 时，先卸载的那个把 URL 从另一个手里撤掉。已改引用计数，容量逐出绝不碰被持有的条目；`assets/thumbs.test.ts` 里一条钉着旧行为的用例**当时断言的正是这个 bug**，已重写。**4123 passed / 1 failed**（`SelectableCard 稀有度边框色正确`，与素材无关的既有基线失败），typecheck 0 错误；15 文件改动 + 8 新增。⚠️ **未经真机验证**<br>**大画像 + 取景旋钮 + 裁剪台 (2026-07-29，设计文档 §15.10 / 新增 D21·D22)**: ①**右栏大画像** —— StatusOverview 玩家位命中 `立绘`/`立绘bg` 时改用新的 `shared/CharacterPortrait.vue` 顶对齐铺满整栏，并带一个**取景旋钮**(焦点 x/y + 缩放)。判据是**链上命中的那一档**，不是"有没有图": 只有 `头像` 的角色**必须**留 1:1 小方框 —— 一张脸的特写拉满整栏宽只会糊成一团，用户读到的是「渲染坏了」而不是「这是个功能」。D20 的**读取**降级照常跑(只有头像也能占立牌位，那是半成品素材包还能用的全部价值)，但**呈现不跟着降级**: 兜底在数据源是对的，兜底在版面是错的。②**裁剪台 `shared/AssetCropEditor.vue`** —— 一张源图烘出 `立绘 + 头像` 两份**真字节**(不是存一个矩形引用: 引用没有哈希、进不了 zip 往返、源图一删两张全废)，每类型**三态** 裁剪/整图/不生成 (D22，两字段必填，省略是编译错)。`'skip'` 是**库不按点击次数膨胀**的前提(重裁立绘几乎从不想再铸头像)；`'whole'` **原始字节原样存不过画布**(过画布会把动态 WebP 拍成第一帧、JPEG 再有损一次)。长边上限只作用于真裁那一半: **2048(立绘) / 768(头像) ≈ 各自最大渲染尺寸(~384px / ~180px)的 3 倍**，已覆盖 3× 高密度屏(3× 只需 ~1152/~540)；再往上存的是**任何显示面都拿不出来的像素**，而字节按面积平方增长、配额是共享的。③**framing 逐行持久化 + 进 zip manifest (D21)** —— 取景是**显示元数据**不是身份，与 credit/license 同类且同样无法写进文件名，所以 D10「清单永不改名改类型」纹丝不动；不带它则一次导出→导入就把用户逐张调过的构图静默抹回默认值(那是披着 no-op 外衣的数据丢失)。三道护栏: 两个门都 `clampAssetFraming`、**非对象丢弃而不是夹逼**(否则 `"framing":"居中"` 会被悄悄翻译成一个默认取景，读起来像清单真说了什么)、**只落在新建行上**(同字节重复在读清单之前就跳过了，于是清单永远盖不掉用户自己调的构图)。④`useAssetImage` 增 `row` ref(调用方得知道链上是哪一档答的才能分叉呈现)；asset-store 增 `importPortraitPair` / `setAssetFraming` / `assetBlob`；新增 `lib/image-crop.ts`(真裁，解码与画布双注入缝) + `lib/crop-rects.ts`(纯几何)。🔴 **裁剪台没有名字输入框，也永远不该有** —— §7.3 否决「导入前命名表单」的理由是**第二个命名入口**必然要把 D16 不变式 + D19 门 + §5.3 撞号器再实现一遍；名字永远是 prop，由打开方从上下文给定(玩家位给 `player.name`，素材库给该素材已有的名字)。**裁剪决定像素，从不决定名字**；改名仍只在素材库。<br>📌 **顺带做的搬家**: AssetCropEditor 从 `settings/assets/` 移到 `shared/`(两个消费方且与设置页零耦合，留在 settings 下会让 game 页反向依赖设置页目录 = 分层倒置)，几何 `crop-rects.ts` 一并移到 `lib/`(与 image-crop.ts 同一源图像素坐标系)。<br>✅ **主路径真机验证已过 (Chromium, 2026-07-29)**: 存档「测试冒险」/亚瑟 —— 点画像位开出的编辑器标题是 `裁剪 · 亚瑟` 且**全台没有名字输入框**（§7.3 在真机上也守住了）；立绘框默认整幅 1200×1600、头像框默认 `533×533 自 (334,0)`（水平居中、贴顶）**正好套住头**，圆形预览可证；确认后**一个名字下恰好落两行**（`亚瑟/头像` + `亚瑟/立绘`），源文件叫 `IMG_9999.png` —— 文件名只贡献了扩展名；大画像随即顶对齐出现**无需刷新**；旋钮默认值正确（50/0/1.00×），拖动实时改 `object-position: 50% 70%` + `matrix(2,0,0,2,0,0)`，防抖后 `{x:50,y:70,scale:2}` **只写进立绘那行**（头像行无 framing，正确 —— 只有大画像可取景），复位回 `{x:50,y:0,scale:1}` 并落库。<br>🔴 **仍未验的比已验的更值得记**: 带 framing 的 zip 没过一次真文件往返；mp4 两条路（绕开编辑器 / 视频进画像框）一次没走；素材库的**裁剪再编辑**入口没开过；**不生成**档没端到端跑过；裁剪框没用键盘调过；**四个 NPC 渲染位一次都没真机出过图**（只验了玩家位）。已验的那条由跑在注入替身上的测试钉住，正是 §15.9 那条教训指的形态。**4259 passed / 1 failed**(同一条 `SelectableCard` 基线)，typecheck 0 错误。<br>⚠️ **两个顺带发现、刻意只记不修的真缺陷**(设计文档 §12): ①`asset-store.compareRows` 把变体当**字符串**排，于是 `_10` 排在 `_2` 前面；`AssetCharacterDrawer` 自己打了个 `{numeric:true}` 的本地补丁并在注释里承认了 —— **本地补丁盖在共享比较器上，正是两者日后走散的标准剧本**(扁平表、分组内排序、以后新加的消费方全都还是错的) ②`SettingsPage.vue` 独占全仓 32 条 `vue-tsc` 错误里的 **18** 条(`PresetItem.settings` / `.template` 类型上根本不存在)——真类型漂移，且**结构上对 `npm run typecheck` 隐形**(那是裸 `tsc`，不解析 `.vue`)；18 条错误堆在一个文件里而什么都没红，正是这个缺口的具体代价 | ✅ v1.0 已实现 + 渲染面已接通 + 大画像/取景/裁剪台（均待真机验证） |
| 战斗 v2 | 战斗系统架构 v2 重构（管道+中间件+同构契约+6 大类效果对齐 #265160+buff 规则对齐 [状态规则]+19 event+Combat Agent+独立战斗面板+计算分工）。魔改不照抄世界书，趣味优先+代码兜底。架构: docs/reference/combat-system-architecture.md；计划: docs/planning/2026-07-28-combat-system-v2-plan.md。M1-M6 六批次，§十三 待确认清单已全收口。**M1 ✅**（emitChain+script-registry，130）**M2 ✅**（modifier 6 大类+buff 去重，~140）**M3 ✅**（管道版+19event+登神+HP红线，~80）**M4 ✅**（combat systemPrompt+13工具注册+executeCombatToolCall 独立通道(B方案)+combat-runner 跨回合循环+item_gen 6大类契约+校验纯函数 54测+combat-agent-api.md 接口规格文档；agent-tools 58测）**M5 ✅**（runner 路径 X 回合调度: 按行动轴逐单位+敌方自主/我方暂停等玩家+激活死字段 currentTurnIndex+7类 CombatEvent 事件流+pendingResolver 暂停恢复+hp同步修正+combat-store(combatLog/awaiting/submit)+pipeline 桥接(enter/exit/applyCombatEvent)+CombatPanel 覆盖层+4子组件(CombatUnitCard/CombatActionCard/CombatMessageFlow/CombatActionBar)B+C 按钮注入文本框+CombatHeader+useBeautify composable 抽取；combat-runner 7测；M5 plan+RFC 文档。待真机验证） | ✅ M5 完成 ｜待 M6 真机 |

## 前端架构 (Phase 7, 2026-06-17)

```
src/ui/                              ← Vue 3 + Pinia + Vite 前端 (单 URL 状态驱动)
├── main.ts                          ← 应用入口 (createApp + Pinia + 主题初始化)
├── App.vue                          ← 根组件 (<router-view> + ToastContainer + 界面级场景配乐 watch)
│                                       曲库与**素材库**的 init() 都装在这里: 两者都要在游戏页/捏人页用，而那两处都不经设置页。
│                                       素材 init() 此前只在 AssetSection 的 onMounted 里调 → 没进过设置页的会话库恒为空，
│                                       表现成「导入过的头像不显示」。两个 init() 都幂等，分区里再调即空转
├── env.d.ts                         ← .vue 类型声明
│
├── composables/                     ← Vue 3 Composables (可复用逻辑)
│   ├── useMapViewer.ts              ← OpenSeadragon 生命周期 (创建/加载/销毁)
│   ├── useMapMarkers.ts             ← 地图标记 CRUD + Overlay 同步
│   ├── useHoverPopup.ts             ← 悬停浮层唯一实现 (延迟读 settings.hoverDelayMs / 定位 below·right·right-bottom
│   │                                   / 键盘 focus 不吃延迟 / zoom 坐标回除 / 滚动即隐)
│   └── useAssetImage.ts             ← [素材] 渲染缝: (name, type?) → { url, isVideo, row }。名字严格 `===` (D2)，
│                                       缺省走**脸位链**；isVideo 由**命中的行**判定不嗅 URL (object URL 无扩展名)
│                                       三条纪律各对应一个真实失败形态: **先铸新的再撤旧的**(反了会闪空白) ·
│                                       **世代号守卫**(过期一轮落笔 = 界面上是另一个角色的脸) · onScopeDispose 释放
│                                       🔴 索引按**数据源**共享一份，建在 detached `effectScope(true)` 里 ——
│                                       直接 computed() 会挂到当前组件作用域，第一个卸载的组件就把它 stop 掉，
│                                       后来者拿到**僵尸索引**，表现为「刚导入的头像要刷新页面才出现」
│                                       📌 `row` 是**命中的那一行**本身 (2026-07-29 加): 调用方得知道"链上是哪一档答的"
│                                       才能分叉呈现 (立绘→大画像 / 头像→小方框，见 StatusOverview) 并拿到 id/framing；
│                                       同 isVideo 一样，这件事**只能问行**，object URL 上没有扩展名可嗅
│
├── lib/                              ← 前端↔引擎桥接层
│   ├── game-pipeline.ts              ← GamePipeline: AgentConfig组装/上下文构建/编排器/回调处理
│   ├── audio-singleton.ts            ← AudioManager 应用级单例 (懒创建；无 Web Audio 时降级为静默 stub + setBlobResolver 可换字节解析器)
│   ├── audio-folder.ts               ← 本地音乐文件夹 (File System Access 唯一接触点: 选择/持久化/权限/扫描/解析，仅 Chromium)
│   ├── asset-zip.ts                  ← [素材] 一键 zip 读写 (流式 + 中途中断的体积上限 / 按名分流噪音永不解压 / SHA-256 / AbortSignal 取消 / manifest 防御性解析)
│   ├── media-hash.ts                 ← [素材] SHA-256 唯一实现 (crypto.subtle 特性探测；不可用时返回 undefined，绝不换算法) — asset-zip 与音频上传共用
│   ├── asset-url.ts                  ← [素材] object URL LRU + **引用计数** (cap 64 / get 每次成功 +1、release 归零才 revoke /
│   │                                    容量逐出**绝不撤销被持有的条目**，宁可超容 / 同 id 在飞去重且搭车者各领一份计数 /
│   │                                    revokeAll 无视计数 / 注入 createObjectURL)
│   │                                    🔴 无计数时: 一个 NPC 同时出现在 ScenePanel 与 CharacterListPanel，先卸载的那个把 URL
│   │                                    撤了，另一个当场死图 —— v1 无渲染面所以这条隐患完全看不见（见设计 §15.9）
│   ├── image-crop.ts                 ← [素材] 从源图切出**真字节** (裁剪/等比缩到 maxEdge/编码)。解码与画布**两处注入缝**，
│   │                                    于是 `environment:'node'` 下不碰任何浏览器 API 也能整条测。
│   │                                    📌 为什么真裁而不是只存矩形: 取景(framing)是"同一张图怎么摆"，可逆所以是元数据；
│   │                                    这里造的是**两张独立素材**，各有名字/类型/哈希、能去重、能进 zip 往返 —— 一条
│   │                                    `(sourceId, rect)` 引用没有哈希、进不了导出包、源图一删两张全废
│   │                                    🔴 错误纪律与 media-hash.ts **刻意相反**: 哈希算不出只是少一次去重(返 undefined 不抛)，
│   │                                    裁剪失败是**拿不到用户要的那张图**，静默返回空 PNG 会让一张全透明图当头像存进库 → 一律抛
│   │                                    `ImageCropError` 带 `code`(照 AssetZipError 先例判 code 别 match 文案)。视频既不能当源也不能当输出
│   ├── crop-rects.ts                 ← [素材] 裁剪框几何 (纯函数零 DOM，单位恒为**源图像素**，与 image-crop 同坐标系)
│   │                                    夹逼/锁 1:1/最小边 8/四角各自锚点/预览用 background-size+position。
│   │                                    📌 立绘默认框=整图、头像默认框=**顶部居中正方形**(立绘里脑袋几乎总在那，
│   │                                    默认落中央就是每次都框住腰再手动往上拖)；非有限数在这里收敛，不指望每个调用点记得判
│   ├── quality-colors.ts             ← 品质色映射
│   ├── test-fixtures.ts              ← 测试数据注入
│   └── toSystemEvent.ts              ← 系统事件类型转换
│
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
│   ├── game-store.ts                ← 游戏状态 (存档/角色/对话/战斗/FP)
│   ├── audio-store.ts               ← 音频状态 (Pinia 薄壳，桥接 AudioManager 单例 + 音轨库 CRUD + 音乐文件夹状态/扫描对账/loadBlob 三后端分流)
│   └── asset-store.ts               ← [素材] 执行器 (自身零决策: planImport 出计划，本店只落库) — 库状态/按名分组/一键 importZip/exportZip(仅 blob 源音频)/改名(全字段+不变式拒收+撞号)/设为主图(单事务先降后清)/批删/URL 缓存/persist
│                                       + importForCharacter(file, name, type): **花名册驱动的定点导入** —— 文件名**只**贡献扩展名，
│                                       name/type 由槽位给定 (于是 IMG_1234.png 不会长出一个叫 IMG_1234 的幽灵角色组)。
│                                       复用同一道互斥闸/三道闸门/哈希去重/撞号器；**永不覆盖**，撞位先落变体再 setPrimary 换过来 ——
│                                       连"字节已在库里(哈希命中)"也照样提主图，否则用户点了导入却因为库里早有同字节变体而看不到变化
│                                       + importPortraitPair(source, name, {portrait, avatar}): 一张源图烘出**立绘+头像两行**。
│                                       两个类型各表一次态 `CropRect | 'whole' | 'skip'`(D22，**两个字段都必填**，省略是编译错)；
│                                       `'whole'` 走**原始字节原样存**不过画布(过画布会把动态 WebP 拍成第一帧、JPEG 再有损一次)，
│                                       `'skip'` 是那个类型一行都不写。长边上限只作用于真裁那一半:
│                                       `PORTRAIT_CROP_MAX_EDGE=2048` / `AVATAR_CROP_MAX_EDGE=768` —— 立绘最高渲染 ~384px、
│                                       头像 ~180px，2048/768 已覆盖 3× 高密度屏(3× 只需 ~1152/~540)并留余量；再往上存的是
│                                       **任何显示面都拿不出来的像素**，而字节按面积平方增长、配额是共享的。`fitWithinMaxEdge` 不放大
│                                       🔴 部分成功如实报: 立绘落了头像失败 → outcome 是**失败那半的理由**，portraitId 照样带回，
│                                       绝不回滚已落地的一半，也绝不因"至少成一个"报成功
│                                       + setAssetFraming(id, framing): 写取景(显示元数据，防抖落库)；读方一律先 clampAssetFraming
│                                       + assetBlob(id): 取一条素材的原始字节 (裁剪台重裁 / 导出复用)
│
├── components/
│   ├── shared/                      ← 18 个通用组件
│   │   ├── AppButton.vue            ← Primary/Secondary/Danger/Ghost × 3 尺寸
│   │   ├── AppModal.vue             ← Teleport + ×关闭 + Esc + 过渡动画
│   │   ├── AppCard.vue              ← 品质色边框 + 选中态
│   │   ├── AppTabs.vue              ← 等宽标签 + 指示线 + Badge
│   │   ├── ResourceBar.vue          ← HP/MP/SP/EXP 资源条 (grid + 动画填充)
│   │   ├── QualityBadge.vue         ← 7 级品质徽章
│   │   ├── BuffChip.vue             ← Buff/Debuff/Special 药丸
│   │   ├── AvatarPanel.vue          ← 头像 (4 尺寸 sm/md/lg/xl × 形状 circle/square，默认圆形不破坏既有调用)
│   │   │                               + `video` prop: mp4 走 `<video muted playsinline loop autoplay>` 与 `<img>` 共用样式；
│   │   │                               省略即 false，现有调用方一个都不受影响。由调用方从**素材行**判定，不在此嗅 URL
│   │   ├── AssetMedia.vue           ← [素材] 一个素材位: 命中就铺满外层容器，没命中把插槽(首字母兜底)原样交回，绝不渲染空白框
│   │   │                               尺寸/形状/裁切一律由**外层容器**给 → 同一组件既填 2.5rem 圆也填 46×58 立牌位
│   │   │                               📌 之所以是组件不是几个 computed: 列表里每项要**一条自己的**解析链，
│   │   │                               让 Vue 建/拆作用域，object URL 释放是白拿的 (手写对账器只会多一个漏 URL 的地方)
│   │   ├── CharacterPortrait.vue    ← [素材] **顶对齐大画像位** + 取景旋钮 (焦点 x/y + 缩放，写回 setAssetFraming)
│   │   │                               与 AvatarPanel 的分工是**呈现形态**不是数据来源: 只有链上命中的真是 `立绘`/`立绘bg`
│   │   │                               才用本组件 —— 把一张**头像**拉满整栏宽看起来像 bug 而不像功能，所以只有头像的角色
│   │   │                               必须留小方框 (判据在调用方，见 StatusOverview.hasLargePortrait)
│   │   │                               🔴 取景必须先过 `clampAssetFraming` 再落 CSS: 一个 NaN 会让整条 object-position /
│   │   │                               transform 声明被浏览器**整条丢弃**，表现成「这张图偶尔没对齐」—— 最难查的那类样式 bug
│   │   │                               🔴 缩放必须**绕焦点**发生 (transform-origin 与 object-position 用同一对百分比)，
│   │   │                               否则放大会把刚对准的地方推出框外，手感是「两个滑块在互相打架」
│   │   │                               📌 旋钮浮层刻意**不复用 useHoverPopup**: 那是只读提示气泡(pointer-events:none)，
│   │   │                               这里要点击开合且必须接住拖拽与方向键
│   │   ├── AssetCropEditor.vue      ← [素材] 裁剪台: **一张源图烘出「立绘 + 头像」两份真字节** (落库走 importPortraitPair)
│   │   │                               每个类型一个**三态**开关 裁剪 / 整图 / 不生成，与 PortraitCropSpec 一一对应；
│   │   │                               两个都「不生成」时确认键直接禁用 (不发一个必然 `'no-crops'` 的请求)
│   │   │                               🔴 「不生成」不是可有可无的第三档 —— 这里同时是**重裁入口**，而重裁立绘时几乎
│   │   │                               从不想再铸一张头像；少了它，库按点击次数膨胀
│   │   │                               🔴 **没有、也永远不该有名字输入框**: 名字是 prop，由打开方给定 (玩家位给 player.name，
│   │   │                               素材库给这条素材已有的名字)。§7.3 否决过"导入前命名表单"，理由是**第二个命名入口**
│   │   │                               必然要把 D16 不变式 + D19 门 + §5.3 撞号器再实现一遍。**裁剪决定像素，从不决定名字**
│   │   │                               📌 住 shared/ 而非 settings/assets/: 两个消费方(素材库抽屉 + 游戏页画像位)且与设置页零耦合；
│   │   │                               放 settings 下会让 game 页反向依赖设置页目录，是分层倒置。几何在 lib/crop-rects.ts
│   │   ├── ToastContainer.vue       ← 全局通知 (4 类型 + 动画)
│   │   └── form/ (5 files)          ← Input/Select/Stepper/Cascader/KeyValue
│   ├── home/HomePage.vue            ← 游戏标题画面 (40vh 标题 + 4 按钮 + 风味文字)
│   ├── settings/SettingsPage.vue    ← 设置页 (左侧导航 + 12 分区 + 预设系统)
│   ├── settings/AudioSection.vue    ← 音频分区 (混音台 / 播放列表 / 音轨库三段式 + 音乐文件夹条 + 素材包 zip 导入入口)
│   ├── settings/AssetSection.vue    ← [素材] 素材分区壳层 + settings/assets/ 4 子组件 (AssetImportStrip 导入/进度/取消/配额 · AssetLibrary 按角色+全部素材双视图 · AssetCharacterDrawer 变体抽屉/设为主图/改名 · AssetDialogs) + dialogs.ts/thumbs.ts
│   ├── create/CreatePage.vue        ← [占位] 捏人页
│   ├── game/
│   │   ├── GamePage.vue             ← 游戏页主布局 (三栏 + 6 弹窗；持有 --rail-w 变量，保证左块恰好 25%)
│   │   ├── MapPanel.vue             ← 地图查看器 (OSD + 91 标记 + 浮动信息卡片 + 角色位置匹配 + 工作台)
│   │   ├── TopBar.vue               ← 顶部栏 (首页/存档名/全屏，时间已下沉 ScenePanel)
│   │   ├── SideToolbar.vue          ← 左侧工具栏 (8 按钮，宽度收窄 30% → 图标在上文字在下)
│   │   ├── ScenePanel.vue           ← 场景面板 (顶:日期年份同行+具体时刻+位置+天气 / 四页签: 角色(默认)·任务·世界·万象)
│   │   │                               角色条目右对齐(方形立绘在右)+好感度双向条+等级，悬停出云朵思绪气泡；任务就地展开
│   │   │                               [素材] 46×58 NPC 立牌位走 AssetMedia + **立牌链**，无素材照旧首字母兜底
│   │   │                               ⚠️ `.npc-portrait` 是心声气泡的 anchorSelector，类必须留在**外层**元素上，素材只能塞进它里面
│   │   ├── ChatFlow.vue             ← 对话流 (三源消息: AI/用户/系统 + 美化正文 + 系统卡片)
│   │   ├── InputBar.vue             ← 输入栏
│   │   ├── StatusHUD.vue            ← 右侧状态栏容器
│   │   ├── StatusOverview.vue       ← 角色状态详览 (方形立绘 + 身份单行文本 / HP·MP·SP·EXP 条 / 等级+五维 6 等宽格
│   │   │                               / 状态效果徽章与标题同行·悬停出详情 / 持有物四页签 装备·背包·消耗品·技能，
│   │   │                               金钱与 FP 常驻标题行、条目就地展开不弹 Modal)
│   │   │                               [素材] 玩家画像位: **读**走立牌链 `立绘→立绘bg→头像`(右栏这块地方是竖着的)，
│   │   │                               命中 `立绘`/`立绘bg` → CharacterPortrait **大画像 + 取景旋钮**；只有 `头像` → 留 1:1 小方框
│   │   │                               (判据是**链上命中的那一档**不是"有没有图"：把一张脸的特写拉满整栏只会糊成一团)
│   │   │                               **全站唯一带导入入口的渲染位** —— 点/Enter/Space 开文件选择框，然后按**这份字节能不能过画布**分两条:
│   │   │                               · 图片 → 开 AssetCropEditor 裁剪台，一张源图烘出 `立绘`+`头像` 两行
│   │   │                               · mp4 → **不开**裁剪台(画布只取得到某一帧；D7 也不让视频落 `立绘`)，走 importForCharacter
│   │   │                               并**写死单个 `头像`**(存进去的必须是确定的一格，只有读取才降级)
│   │   │                               📌 名字在**开台那一刻**定死(cropName)，不每帧读 player.name —— 台开着时存档可以切
│   │   ├── ItemsPanel.vue           ← 背包面板
│   │   ├── CharacterListPanel.vue   ← 角色列表面板 ([素材] 2.5rem/3.5rem 两处圆形头像走 AssetMedia + **脸位链**，
│   │   │                               容器补 overflow:hidden 让圆形裁切成立；无素材时观感一字不变)
│   │   ├── QuestsPanel.vue          ← 任务面板
│   │   ├── PlotPanel.vue            ← 剧情面板
│   │   ├── MemoryPanel.vue          ← 记忆面板
│   │   ├── SnapshotPanel.vue        ← 快照面板（历史快照恢复 / 分层保留）
│   │   └── MiniPlayer.vue           ← 迷你播放器（浮动卡片，锚在 SideToolbar 旁，非 Modal）
│   └── workshop/WorkshopPage.vue    ← [占位] 创意工坊
│
└── styles/                          ← base.css / transitions.css / utilities.css
```

### 设置页 12 分区

| 分区 | 内容 |
|------|------|
| 🔌 API 配置 | API 池 CRUD、连接测试、模型列表获取、模型推荐 (DeepSeek V4 + 硅基流动 Embedding) |
| 🤖 Agent 配置 | 左侧主导航 + Agent 子导航、11 个汉化 Agent、模型选择(默认空/未配 API 标红)、世界书开关、System Prompt 编辑 |
| 📚 世界书 | [占位] 导入/新建按钮 |
| 📖 剧情系统 | 8 种剧情偏向卡片多选、模式/年份/难度层级/外部NPC/自定义偏好、大纲预览(高斯模糊防剧透) |
| 🧠 记忆 & 缓存 | 召回数/压缩阈值/快照上限/缓存策略 |
| 🎨 外观主题 | 10 主题预览网格、字体风格(衬线/无衬线/混合)、字体大小(14/16/18/20px)、悬停延迟(`hoverDelayMs` 立即/快/默认200/慢/很慢，全站 hover-to-display 统一读它) |
| 💬 消息显示 | 系统通知全局开关 + 7 种事件类型独立过滤 |
| ✨ 输出美化 | 预设规则库 beautifier-rules.json (22条: 2内置+20远程) + 世界书/角色 auto-enable 绑定 + 三段式UI(自动管理/已启用/可用规则库折叠)。用户规则 CRUD + 实时预览 + 导入/导出 JSON |
| 🎵 音频 | 三段式: ①混音台(主/音乐/音效 音量+静音 + 播放控制/进度/循环/随机 + **场景配乐开关**) ②播放列表(仅音乐音轨，左选单右曲目排序) ③音轨库(音乐文件夹条 + 上传/搜索/按类型与标签过滤/试听/编辑/删除 + 占用配额显示)。音乐文件夹: 选择目录一次→文件留在磁盘只存目录，「授权访问」每次开浏览器点一次，「重新扫描」增量对账(文件消失只标 `文件已移除` 不删行)；仅 Chromium 支持，其他浏览器走上传入 IndexedDB 的兜底路径。音频库全局共享不随存档；**不参与存档导出/导入**，但「清除全部数据」会一并销毁 |
| 🖼 素材 | 三段式: ①导入条(一键 zip 导入素材+音频同一个包，按扩展名分流 / 进度+取消 / 结构化回执: 新增·跳过重复·编号·命名冲突·警告 / 配额 + `persist()` 结果) ②素材库(按角色分组卡+变体数+无主图徽章 / 全部素材扁平表 + 搜索 + 类型过滤 + shift 多选 + 批量删除 / mp4 走 `<video muted playsinline>`) ③变体抽屉(设为主图 / **裁剪**(对着已有素材重开 AssetCropEditor，一张源图重烘立绘+头像；三态里的「不生成」正是为这条路存在——重裁立绘时几乎从不想再铸头像) / 全字段改名+不变式行内拒收 / 删除)。**导入的素材游戏内会直接显示** —— 五个渲染位已接通(StatusOverview 玩家画像 / CreateStepConfirm / CharacterListPanel ×2 / ScenePanel NPC 立牌位)，按名字严格 `===` 取图、取不到照旧显示首字母；本分区仍是**唯一的整批导入与管理入口**，游戏内只有玩家画像位有一个定点导入口。素材库全局共享不随存档；**不参与存档导出/导入**(走 zip 导出)，「清除全部数据」会一并销毁 |
| 💾 存档数据 | 导出/导入/清除 (含确认弹窗)。**明写两项排除**: 存档导出不含音频库与素材库，各有独立导出口；清除全部数据会销毁两者 |
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
