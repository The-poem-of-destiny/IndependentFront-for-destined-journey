# AGENTS.md

本文件为所有 AI 编码工具（Claude Code / Codex / Cursor / Windsurf 等）在此仓库中工作时提供指导。

> **本文件是指令正文的唯一真源**，工具中立。Claude Code 通过 `CLAUDE.md` 的 `@AGENTS.md` import 本文件；Claude Code 专属内容（猫娘人格、skills/workflows 用法）在 `CLAUDE.md`，不在此处。Codex 等其他工具直接读本文件即可。

## 提交前文档检查（必读）

**每次 push 之前必须先检查是否有文档需要更新，包括但不限于:**

- `AGENTS.md` — 新增模块、架构变更、Phase 进展更新时需同步（进度表只留速览，详细记录进 `docs/CHANGELOG.md`）
- `docs/` — 设计文档目录，架构变更时需更新对应阶段文档
- `docs/CHANGELOG.md` — 近期交付的 Phase 详细记录，完成里程碑时追加
- `reference/agent流程测试/` — Agent 模板/测试工具变更时需同步 `agent预期分析.md`
- `tests/agent-framework/README.md` — 测试工具用法变更时需同步

**如果忘了更新，push 之前主人会提醒。但是 agent 应该主动检查。**

**每次向远程仓库 push 后，必须主动检查对应的 GitHub Actions CI 状态；CI 失败时读取失败日志、定位根因并修复，不得只报告 push 成功。**

## 文档导航

详细设计文档统一在 `docs/` 目录下：

```bash
docs/
├── fated-poem-engine-prd.md     # 🆕 项目 PRD（产品需求文档，必读）
├── ARCHITECTURE.md              # 完整软件+世界观架构
├── CHANGELOG.md                 # 🆕 变更记录（近期 Phase 详细记录，append-only）
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
│   ├── combat-system-architecture.md   # 🆕 战斗系统架构 v2（战斗相关必读）
│   ├── combat-agent-api.md             # 🆕 战斗 Agent↔引擎 接口规格（combat agent 必读）
│   ├── agent_system_prompt_guide.md    # 🆕 Agent System Prompt 配置流程（架构/步骤/踩坑/检查清单）
│   ├── debug-loop-handbook.md          # 🆕 游玩→导出→分析→修复 调试循环操作手册（每次发现 bug 必读）
│   ├── audio_system.md                 # 🆕 音频系统 v1.0 说明书 ← 改音频必读
│   ├── dev-bat-notes.md                # 🆕 dev.bat 说明书 ← **改启动器前必读**
│                                       #    ①注释必须纯 ASCII（chcp 65001 让 cmd 字节偏移解析器错位，
│                                       #      注释片段会被**当命令执行**）
│                                       #    ②端口清理三细节（不写死 127.0.0.1 / 先筛 LISTENING /
│                                       #      端口后那个空格必须配 `findstr /C:` 才生效）
│                                       #    ③不要用 timeout /t   ④行尾必须 CRLF（见根目录 .gitattributes）
├── planning/2026-07-29-asset-management-system-design.md
│                                       # 🆕 素材管理系统设计 v1.0（D1-D23 决策表）← 改素材必读
│                                       #    已实现；渲染面接通（§15.9）；大画像/裁剪台 §15.10
│                                       #    （🔴 §15.10 真机验证记录只对 `e818b61` 那一版有效，
│                                       #      现行 UI 未经真机走查）；审查轮 §15.11
├── planning/2026-08-01-ejs-capability-surface-design.md
│                                       # 🆕 EJS 能力面设计 v1.0（官方标准）← 改 EJS 注入面/写工坊内容前必读
│                                       #    12 个 namespace（stats/vars/local/char/world/quest/lore/
│                                       #    chat/fmt/rng/ui/engine）+ 上游别名层 + 原生库 A/B/C 三档保证
│                                       #    §0.1 裁定 + 实测：求值后端 **QuickJS(wasm, 主线程)**，不做 AST 分析器
│                                       #    ✅ T0-T8 全部实施完成（2026-08-01），真机走查未做
│                                       #    真机语料实测基线（754 条目/109 含 EJS）在 §9
├── planning/2026-07-31-creative-workshop-compat-design.md
│                                       # 🆕 创意工坊兼容层设计 v2（D1-D17）← 改工坊/世界书存储必读
│                                       #    Phase 0 世界书迁 Dexie · Phase 1 工坊 · Phase 2 EJS 沙盒（✅ 待真机）
└── story_preset_format.md          # 🆕 Story Agent 预设编写指南（输出标签顺序 + 占位符排列 + 可用宏）
└── 《命定之诗》内容二创与素材使用授权协议.md  # 项目需遵守的外部授权
```

## 前端 UI 设计规范（必读）

**写任何前端 UI 代码前，必须先查阅 `docs/design.md`。** 该文档定义了：

- 排版体系（字号层级、字重、行高、首行缩进）
- 间距系统（`--theme-spacing-*` token 取值规范）
- 组件样式（按钮/卡片/Tab/面板/Modal 的统一外壳规则）
- 装饰规范（Section 标题线、空态、品质色使用）
- 过渡动画时长 + `prefers-reduced-motion` 检查清单

**所有新页面/组件必须严格遵循此规范，确保项目风格统一。**

```bash
docs/design.md  # 完整前端设计规范（排版/间距/组件/装饰/动画/检查清单）
```

## 游戏数据字段规范（必读）

**涉及游戏数据实体（角色/物品/技能/状态效果/任务/存档/快照/变量）的字段定义、StatePatch 契约、AI 输出格式、翻译层（orchestrator/侧链 buildPatches）的任何改动，必须先查阅：**

```bash
docs/superpowers/specs/2026-07-16-data-field-conventions-design.md  # 数据字典规范 v1.0（五条铁律 + 13 实体章 + SSOT 总表 + M1-M6 迁移批次）
docs/superpowers/specs/2026-07-16-entity-field-audit.md             # 52 项现状偏差审计归档
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

| 页面                      | 框架                                 | 大小  | 核心组件/功能                                                                                                                    |
| ------------------------- | ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `home_index.html`         | Vue 3                                | 94KB  | hero-title/hero-subtitle, info-panel, recommend-hero-section, update-section, 环境检测(tavernHelper/MVU/EJS), 用户协议弹窗       |
| `custom_start_index.html` | Vue 3 + Pinia + VueRouter            | 341KB | 7级品质选择(普通~唯一), 装备类型(武器/防具/饰品), 技能类型(主动/被动), 物品类型(装备/道具/技能), 加载 `baseInfo.json` 自定义数据 |
| `status_index.html`       | React + immer + gsap + OpenSeadragon | 477KB | StatusBar/ResourceBar/AvatarPanel/DetailPanel/InfoPanel, MapView, MarkerPanel, CategoryBar/FilterBar/SettingBar/TabBar/TitleBar  |

### 关键数值来源（世界书 #417617 [核心数值表]）

| 参数      | T1  | T2   | T3   | T4    | T5    | T6    | T7     |
| --------- | --- | ---- | ---- | ----- | ----- | ----- | ------ |
| HP乘数    | 1   | 2    | 4    | 10    | 20    | 40    | 100    |
| MP/SP乘数 | 1   | 2.5  | 6    | 15    | 35    | 80    | 160    |
| 战斗系数  | 2.0 | 2.8  | 4.0  | 8.0   | 15.0  | 35.0  | 80.0   |
| 属性上限  | 8   | 10   | 12   | 14    | 16    | 18    | 20     |
| EXP上限   | 100 | 1000 | 4000 | 10000 | 25000 | 50000 | 999999 |

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
                       # 🔴 改 dev.bat 前必读 docs/reference/dev-bat-notes.md ——
                       #    注释一律纯 ASCII（中文注释会让 cmd 把注释片段当命令执行），
                       #    行尾必须 CRLF（根目录 .gitattributes 已把 *.bat 钉死）
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
- **$ API 语义级抽象 (ADR-19)**：AI 调 `$combat.attack()`声明意图，Code 内部执行公式。不暴露`modifyHp()` 等 CRUD 原语给 AI。
- **声明式优先 (ADR-20)**：效果系统先用 VarsPatch + StatusEffect 声明式格式。复杂动态逻辑通过 `script-executor.ts` 脚本沙盒实现（`$event.on/off` 持久订阅、`$call` 跨对象引用、`init/cleanup` 生命周期）。**战斗内走 EffectAutomaton DSL**（v3 废止任意 JS，见 `combat-v3/automata/`）。
- **StateManager 为唯一写入入口 (ADR-21)**：所有状态变更通过 `commitChatState()`，替代分散的 `saveChat()`。
  - 📌 **受控例外 (P1-09)**：SaveProfile 的纯 UI 辅助字段（`focusQuest` 焦点任务选择、`news[].read` 已读标记）允许 UI 层直写，但必须走 `updateProfile()` / `markNewsRead()` 统一写入函数（非裸 `db.put`）并带 try/catch。AI 产生的 SaveProfile 变更仍必须走 `vars_update` 语义 op，不在此例外内。
- **世界书实现理念 (ADR-28)**：世界书是给**纯文本 AI** 的协议——骰子池/action_info 文本面板/`{{roll}}` 文本注入都是因为没有 Code 层才用的文本手段。我们有 Code 纯函数 + 工具调用 + script 沙盒，**中间结构不必照抄**；目标：输入→流程→**结果**模仿世界书，中间实现用工程手段。script 是"让世界书自由文本效果代码化"的**妥协桥梁**，不是追求完美复现每个机制的借口。
- **EJS 世界书求值契约 (ADR-30)**：世界书条目正文 EJS 由 Code 在提示装配期求值（承 ADR-04），契约自主设计、不承诺 MVU/酒馆助手兼容（上游函数名仅作别名层）。**两轴**：`stats` 只读面（纯代码推导数值：资源/等级/五维/命运点数/时间）+ `vars` 共写叙事变量空间（= `variables.sys` 草稿，AI 与 EJS 双写同一棵树，**冲突 AI 赢**——EJS 差量先落、vars_update 补丁后落）。提交权按 Agent 声明（`ejsVarsCommit`，默认仅 story——前瞻扩展设计）。缓存分层：含 `<%`/`{{random`/`{{getvar` 的条目沉到 LORE_BOOK 展开尾部，静态前缀保字节稳定；EJS 失败条目原文注入（零回归兜底）。设计全文：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`；词汇：根目录 `CONTEXT.md`。

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

| 决策                         | 选择                                | 理由                                                                                                 |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| EventBus 实例化              | 按 SaveSlot                         | 效果实例随存档隔离                                                                                   |
| Script 执行                  | 沙盒模式 (script-executor.ts)       | $event.on/off 持久订阅 + $call 跨对象调用 + init/cleanup 生命周期                                    |
| 持久订阅管理                 | subscription-manager.ts             | 递归保护(≤10) + 僵尸兜底(unregisterAll)                                                              |
| EffectRuntime 时序           | 管线完成后批量执行                  | 保持 DAG 原子性                                                                                      |
| EventBus 引入时机            | Phase 7e+8（已完成）                | 与 Script 系统同步上线                                                                               |
| Agentic 模式                 | OpenAI function calling (Phase 8.5) | craft_gen/char_gen/item_gen 通过 tools 调用真实 Code 函数，禁止 AI 编造数值                          |
| craft_request 时序           | 延迟型 (对齐 combat_trigger)        | Stage 1 暂存 → Stage 2 统一执行，避免阻塞叙事                                                        |
| System Prompt 管理 (Phase 9) | agent-config.json 唯一来源          | 所有 Agent 的完整 systemPrompt 存在 agent-config.json；agent-templates.ts 只留 stub + 动态上下文函数 |

### 效果系统统一框架（战斗+制作共用，ADR-29）

战斗 v2 (M1-M5) 已验证一套**统一 subscribeChain 链式管道**机制，制作系统直接复用，不发明第二套。完整设计见 `docs/planning/unified-effect-system-framework.md`。

> 📌 **v3 演进**：战斗内已由 v3 内核接管（`combat-v3/`），效果走 **EffectAutomaton DSL**（18 窗口 + 8 大类 intent + 封闭表达式文法），不再走 emitChain/script-executor。**本框架仍是制作系统与战斗外的效果基座**（ADR-29 继续适用）。

- **统一机制**：`EventBus.emitChain(type, params, ctx)` 链式参数管道——`(priority, order, 注册序)` 稳定排序、`ctx.combatants`+`subscription.owner` 在场过滤、错误隔离、递归保护
- **两个注册 facade**（互不干扰）：`ScriptRegistry`（声明式，物品装备/卸下）+ `SubscriptionManager`（动态，AI script 运行时 `$event.on`）
- **modifier 不是第二套系统**：物品 `modifiers[]` 在装备时由 ScriptRegistry 注册成"push handler"，走同一条 emitChain
- **核心模式：纯函数兜底 + AI subscribeChain 覆盖**：Code 算基础 → emitChain 传 AI → AI handler 改 outcome → AI 不响应走兜底
- **🔴 P1-11 真相**：基础设施全部齐全，**唯一缺口是"装备/卸下/存档加载时调 executeInit → ScriptRegistry.registerAll"接线**

## v4 三层子系统分流 (ADR-24/25/26)

```
SubSystem-Craft  制作  → 🚩 延迟型: Story 输出 <craft_request>，Stage1 暂存 → Stage2 执行 craft_gen Agent
                          → AI 调 tools (get_inventory→craft_check→craft_settle) → 真实 DC+骰值+评级+结算 (Code)
                          → 创意效果 (AI) → 结果注入正文 + StatePatch 提交
SubSystem-Combat 战斗  → Stage1后检测 <combat_trigger> → 暂存 → Stage2 request_dispatcher 完成 char_gen 后唤起
                          → 独立战斗窗口 (Code循环 + AI摘要) → 摘要回注正文 + 批量StatePatch
SubSystem-CharGen 角色 → Stage2 request_dispatcher 异步检测新NPC → char_gen Agent 调 tools → 输出 <char_result> XML
                          → 调 item_gen Agent (仅1次, ADR-26) → 下回合可用
```

### 9 个 $ API Namespace

| Namespace   | AI可见     | 用途     |
| ----------- | ---------- | -------- |
| `$combat`   | ✅         | 战斗流程 |
| `$craft`    | ✅         | 制作流程 |
| `$status`   | ✅         | 状态效果 |
| `$dice`     | ✅         | 骰池系统 |
| `$char`     | ✅(只读)   | 角色查询 |
| `$var`      | ✅         | 变量读写 |
| `$time`     | ✅         | 时间查询 |
| `$resource` | ✅(只读)   | 资源查询 |
| `$validate` | ❌(引擎内) | 数值约束 |

## Phase 完成通知

**每个 Phase 完成后必须执行通知脚本:**

```bash
bash scripts/notify.sh "<Phase名称> 完成!" "<关键指标>"
# 示例: bash scripts/notify.sh "Phase 5 完成!" "750 tests | 编译 0 错误"
```

脚本会: (1) 显示终端横幅 (2) Windows 托盘气泡弹窗 (3) 响铃 3 下。

## 当前进度（速览）

> 详细记录见 `docs/CHANGELOG.md`。架构变更同步更新下方架构图。

| Phase     | 内容                                                     | 状态                |
| --------- | -------------------------------------------------------- | ------------------- |
| 1-4.6     | 架构/数据结构/Agent编排/记忆/事件/FP 基础                | ✅                  |
| 5         | 角色 & 变量系统 (tier/bloodlines/validate/char/time)     | ✅                  |
| Geography | 位置系统 (location-db, 10势力 32节点)                    | ✅                  |
| Audit Fix | 世界书对齐 (数值/地理/品质/血脉)                         | ✅                  |
| 6a-6e     | 战斗/制作/集群士气/好感/Marker+SubAgent                  | ✅                  |
| 7a-7c     | 工程 (Vite+Vue3+Pinia) / 主题组件 / 首页+设置页          | ✅                  |
| 7d        | 捏人页 `/create`                                         | 🔄 世界书驱动改造中 |
| 7e        | 游戏页+HUD+脚本引擎+ChatFlow+输出美化+ScenePanel         | 🔄 待集成验证       |
| 7f / 7g   | 创意工坊（= 工坊 P1）/ 衔接测试                          | ✅ / ⬜             |
| 8 / 8.5   | Agent 可见性 / Agentic Agent (function calling)          | ✅                  |
| 9 / 9b    | System Prompt 迁移 / craft_gen 细化                      | ✅                  |
| 9c        | 集成测试 & 交付                                          | ⬜                  |
| 10a-10h   | 模板系统/预设占位符/vars_update/Quest/memory_summary     | ✅                  |
| 10i       | 输出美化规则库                                           | ✅                  |
| 10j       | 剧情系统接线                                             | ✅ 待真机           |
| 10k       | 快照面板+右键回退重发                                    | ✅ 待真机           |
| M1-M6     | 数据字段规范迁移（2787 tests 全绿）                      | ✅                  |
| Audio     | 音频系统 v1.0（双通道+三后端+按名寻址+场景配乐）         | ✅                  |
| 素材      | 素材管理系统 v1.0（渲染面+大画像+裁剪台+画像弹窗）       | ✅                  |
| 战斗 v2   | 战斗系统架构 v2（管道+中间件+6大类+19event+独立面板）    | ✅ 已退役（M5 删）  |
| 战斗 v3   | 代码内核主持流程（Kernel+DiceTape+EffectIntent+DSL）     | ✅ M5完成 全量合入  |
| 工坊 P0   | 世界书迁出 localStorage → Dexie v14（+ 进 FullBackup）   | ✅                  |
| 工坊 P0b  | 美化规则迁出 localStorage → Dexie v15                    | ✅                  |
| 工坊 P1   | 创意工坊（浏览/安装/更新/卸载/启用，= 7f）               | 🔒 入口临时下线     |
| 工坊 P2   | EJS 沙盒 + 只读 stats 投影（ADR-30）                     | ✅ 待真机           |
| 工坊 P3   | 社交面（Discord 登录/点赞/订阅，D18-D25）                | ✅ 真机已过         |
| 工坊 P4   | 上游对齐（封面链/类型徽章/我的项目/更新 diff/投稿/审核） | ✅ B4 真机已过      |
| 真机迭代  | debug loop 持续修复                                      | 🔄                  |

> 🔒 **工坊入口已临时下线（2026-08-01 安全审计）**：首页「创意工坊」按钮由 `HomePage.vue` 的 `WORKSHOP_ENTRY_ENABLED = false` 隐藏 —— 那是通往 workshop 视图的唯一入口。原因是 SEC-01（工坊正则的 `replaceString` 原样进美化管线、最终由 ChatFlow 的 `v-html` 落 DOM，事件属性会真的执行）与 SEC-02（世界书 EJS 走 `new Function`，`Object.constructor("return globalThis")()` 可拿回真全局，且同步跑主线程、死循环冻 UI），命中即可读到 localStorage 的 API Key、IndexedDB 存档与本地 BFF。**工坊代码一行没删**，沙箱/消毒方案（审计 Gate 0 / Gate 2）落地后把常量改回 `true` 即恢复。⚠️ 这只是暴露面收敛、不是安全边界：已装且已启用的项目仍会照常执行，游戏页侧栏的「工坊」启用面板也仍在。全文见 `docs/reviews/2026-08-01-repository-review.md`。（SEC-02 已由 QuickJS 隔离后端在 `feat/ejs-capability-surface` 收口；入口解封仍等 SEC-01 消毒方案落地。）

> 🟡 **工坊 P4 已实施（B1-B5），真机走查未做**：以上游工坊页（`github.com/AkabaneSaki/myrepo`，本地克隆 `E:\Projects\myrepo`）为参照做的功能对齐。B1 封面代理链 + 类型徽章 + Cloudflare 错误码 + 加载更多；B2 我的项目 / 订阅与已装 / 审核徽章；B3 更新前改动预告；B4 投稿·编辑·上传·可见性·删除；B5 审核队列 + 管理员 + 日志。**三条与上游刻意不同**已写进各自文件头注释：不给没有基础标签的项目盖章成「系统」、diff 由已算好的安装计划派生（不重新归一化一遍）、权限判定只用于画不画入口（门禁在上游 403）。**真机走查（2026-08-02）**：B4 写侧（投稿上传 / 编辑 / 删除）与 P3 社交（点赞 / 订阅）已人工走过。B1-B3（封面链 / 我的项目 / 更新 diff）尚未专门走查。🔴 **B5 审核面无法自测（已搁置）** —— 当前账号 `isAdmin: false`，延后到拿到管理员账号再做。

> 🩹 **走查后修的两处**（fable 审查发现，均已补回归测试）：
>
> 1. **并发 toggle 互相抹掉** —— 节流键按（项目 × 动作）分开，点赞与订阅可同时在飞；而校正/回滚都拿**起飞时**抓的快照整份盖回去，后落地的会把先落地的成果重置回起飞前，失败回滚还会连累并发动作、并留下一个服务端从没记过的「幻影赞」。现在校正基线取**落地那一刻**的覆盖层，回滚只放回自己那一对字段（`workshop-social-store.ts` 的 `rollback`）。
> 2. **编辑表单从本地已装库取初值** —— 「我的项目」列的是作者名下全部项目、未必装过，查空就开出空表单，而「提交修改」是整份 PUT，一次没留神就把上游的简介清成空串、标签清光。现在 `WorkshopBrowseModal` 的 `edit` 事件转达**上游整行**，本地那份只做兜底。
>
> 🟡 **工坊 P2 已实施（T1-T6），真机走查未做**：世界书条目正文的 EJS 现在**会在提示装配期求值**（ADR-30 两轴契约：只读 `stats` + 共写 `vars`，冲突 AI 赢；动态条目沉底、静态前缀字节稳定）。全语料冒烟 509 条目 / 61 动态 / **0 回退**（能力面别名层落地后 7 → 0，白名单已清空；语料门现按 **Legacy 与 QuickJS 双后端**各自跑双向白名单，基线一致），回退条目原文注入不阻断。代码位内嵌的 ST 值宏（`{{roll}}`/`{{random::}}`）已在编译期降成沙盒调用（`rewriteCodeMacros`），uid 358 出列。回退率 / 缓存命中字节 / 跨回合链尚未真机验证，设计全文见 `docs/planning/2026-07-31-workshop-phase2-ejs-design.md`。

## 架构（已实现部分）

```
src/sillytavern/                    ← 核心引擎
  │
  ├── types.ts                      ← 唯一类型来源；大型联合类型拆 types-*.ts（如 types-audio.ts）
  │   ├── v3 兼容: Lorebook / ChatPreset / AppSettings / ChatSession / ChatMessage
  │   ├── v4+: CharacterState / MemoryRecord / PlotEvent / Snapshot / SaveSlot
  │   │         ApiEndpoint / AgentConfig / AgentDefinition / Pipeline / AgentContext
  │   │         AgentResult / OrchestratorRun / MapTopology / VarsPatch
  │   ├── Audio: AudioSourceKind ('blob'|'builtin'|'file') / AudioTrack / AudioBlobRecord 等
  │   └── 辅助: createDefaultCharacterState() / resolvePlotTree()
  │
  ├── database.ts                   ← Dexie/IndexedDB v15
  │   ├── v1-v3: lorebooks / presets / settings / chats
  │   │           🪦 lorebooks 是 v3 遗留 `Lorebook` 类型的**死表**，生产代码零读写；
  │   │              现役世界书表是 v14 的 worldBooks（`WorldBook` 类型）。settings 同为死表。
  │   │              两张死表刻意保留（删表要写 `表名: null`，会永久抹掉老用户的 v1–v3 行）
  │   ├── v4+: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │   ├── v11+: audioTracks / audioBlobs / audioPlaylists（全局共享，排除 FullBackup）
  │   ├── v12+: audioHandles（持久化 FileSystemDirectoryHandle）
  │   ├── v13+: assetMeta / assetBlobs（素材库，全局共享，排除 FullBackup，走 zip 导出）
  │   ├── v14+: worldBooks / workshopProjects（工坊 P0；两者都进 FullBackup）
  │   └── v15+: beautifierRules（工坊 P0b；只存**用户规则**，内置预设是派生缓存不落库）
  │       🔴 **世界书与美化规则现居 Dexie，不再在 localStorage**。localStorage 只剩
  │          settings-store 的其余设置（Agent 配置/主题/`beautifierBuiltinDisabled` 等）
  │
  ├── agent-client.ts               ← [Phase 3] API 客户端（每 Agent 独立 userId / 重试退避 / 缓存检测）
  ├── agent-templates.ts            ← [Phase 3+9] Prompt 模板（systemPrompt 已迁 agent-config.json，留 stub + 动态上下文）
  ├── agent-config.json             ← [Phase 9] 10+ Agent 完整 systemPrompt 唯一来源
  ├── agent-tools.ts                ← [Phase 8.5] Agentic 工具注册表（17 tools）+ AGENT_TOOL_MAP
  ├── agent-orchestrator.ts         ← [Phase 3+8.5] DAG 编排引擎（阶段串行+同阶段并行/M3 翻译层按名寻址零id单patch）
  │   ├── callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │   └── Marker 回调: onCraftRequest/onCombatTrigger/onCharGenRequest/onPlayAudio
  ├── story-rescue.ts               ← Story 正文救援（正文吞思维链 / 思维链泄漏正文 AI 缺陷兜底）
  ├── random-tables.ts              ← [Phase 8.5] NPC 生成随机表
  │
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化（铁律5）
  ├── tier-constants.ts / bloodlines.ts / death-system.ts / validate.ts / char-query.ts
  ├── resource-calc.ts / var-resolver.ts / namespace-normalizer.ts / time-system.ts
  │
  ├── save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币（M5: +variables 变量唯一真源）
  ├── fp-system.ts / effect-parser.ts / effect-runtime.ts
  ├── ejs-backend.ts                ← [能力面 T1] EjsBackend 接口 + LegacyBackend + 生产切换入口
  ├── ejs-quickjs-backend.ts        ← [能力面 T7] ★ QuickJS(wasm,主线程) 隔离后端 —— SEC-02 的边界
  │                                    实测：构造器逃逸/死循环/ReDoS/OOM 四条全部堵住
  ├── ejs-capabilities.ts           ← [能力面 T4/T5] chat/char/world/quest/lore/local/ui/engine
  ├── ejs-fmt.ts                    ← [能力面 T5] fmt.yaml/table/num/bar + 不依赖 locale 的 compareName
  ├── ejs-rng.ts                    ← [能力面 T2] 种子随机（快照重放可复现）
  ├── ejs-preflight.ts              ← [能力面 T8] 装前预检（纯函数，不阻断安装）
  ├── ejs-runtime.ts                ← [工坊 P2] 整片编译（全条目 token 编进同一函数体，跨块 if/for 成立）
  │                                    compileEjsEntry / executeEjsEntry；两轴注入 + 失败回滚
  ├── ejs-lodash-shim.ts            ← [工坊 P2] `_` 纯读边 17 方法 + chain（不含任何写方法）
  ├── stat-projection.ts            ← [工坊 P2] buildStatData：主角资源/等级/五维/命运点数/世界.时间（只读快照）
  ├── ejs-vars-diff.ts              ← [工坊 P2] 草稿深 diff → {replace,remove} 喂 applyVarsPatch；256KB 护栏
  ├── game-event.ts                 ← [Phase 4.5] EventBus 按存档隔离（+ emitChain 链式管道 ADR-29）
  ├── state-manager.ts              ← 唯一状态写入入口（M2按名寻址 M4名字唯一化 M5变量迁profile+快照重建）
  ├── dice.ts / memory-store.ts / memory-summarizer.ts / plot-outline.ts / plot-engine.ts / location-db.ts
  │
  ├── combat-intention.ts / combat-damage.ts / combat-turn.ts / combat-panel.ts / combat-resolver.ts
  │   └── (以上为 v2 战斗纯计算函数，v3 内核仍调用；v2 编排层 combat-runner/combat-pipeline 由 M5 删除)
  │   └── combat-v3/               ← [战斗 v3] 代码内核主持流程（M0-M5 已合入）
  │       ├── kernel.ts / reducer.ts / state.ts     ← 状态机 + 原子提交 + 5 不变量
  │       ├── dice-tape.ts                          ← 分通道骰带（32/10/7/6/5）
  │       ├── coordinator.ts                        ← 战斗循环 + RequiredInput 路由
  │       ├── windows.ts / intents.ts               ← 18 窗口求值 + EffectIntent 解释执行
  │       ├── adjudication.ts / rule-keys.ts        ← BoundedAdjudication + 4 RuleKey
  │       ├── automata/                             ← DSL parser/interpreter/compile/builtins/reflection
  │       ├── projection-ui.ts / projection-agent.ts← 双投影（UI 事件 + Agent 文本面板）
  │       ├── replay.ts / contract/                 ← contract harness + 7 场 fixture
  │       └── index.ts                              ← 唯一公共出口（openCombat / runCombatV3）
  ├── craft-quality.ts / craft-dc.ts / craft-resolver.ts
  ├── cluster-system.ts / morale-system.ts / affection-system.ts
  ├── marker-protocol.ts            ← [Phase 6e+Audio] XML 标记检测（含 <play_audio>）
  ├── char-gen-agent.ts             ← [Phase 6e] 角色生成编排（M3 单patch落库/正式字段直写/零id）
  ├── craft-gen-chain.ts            ← [Phase 9b] 制作生成编排（M3 零id/type归一化/单patch）
  │
  ├── script-executor.ts            ← [Phase 7e+8] 脚本沙盒（$event.on/off / $call / @parent / init·cleanup）
  ├── subscription-manager.ts       ← [Phase 7e+8] 持久订阅管理器（递归保护≤10 + 僵尸兜底）
  │
  ├── audio-channels.ts             ← [Audio] MusicChannel 音序器 + SfxChannel 声池（加载世代号竞态保护）
  ├── audio-manager.ts              ← [Audio] 音轨库注册表 + 主音量 + 手势解锁 + playByTag AI 钩子
  ├── audio-names.ts                ← [Audio] 按名寻址纯函数（normalizeAudioName / findByName 稳定取最早）
  ├── audio-tags.ts / audio-scene.ts ← [Audio] 四维标签 + 场景选曲（七段路径逐级回退+四维加权打分）
  ├── types-audio.ts                ← [Audio] 注入缝接口 + state/options（数据模型类型仍在 types.ts）
  │
  ├── asset-types.ts                ← [素材] categoryForType / allowsVideo / ASSET_MIME_BY_EXTENSION
  ├── asset-filename.ts             ← [素材] `<name>[_<type>][_<variant>].<ext>` 解析/格式化（命名不变式）
  ├── asset-index.ts                ← [素材] buildAssetIndex(rows) → 大类→名字→类型→{base,variants}
  ├── asset-resolve.ts              ← [素材] resolveAsset + 两条相反回退链（立牌链 / 脸位链）
  ├── asset-import-plan.ts          ← [素材] ★ planImport 纯同步出计划（撞号进 variant / 哈希去重 / manifest 只补元数据）
  │
  ├── workshop-types.ts             ← [工坊 P1] WorkshopProject / 载荷与安装计划类型 + 常量
  ├── workshop-manifest.ts          ← [工坊 P1] ★纯函数：上游 JSON → 内部形状（容忍字段增删，丢弃项记 droppedNotes）
  ├── workshop-regex-map.ts         ← [工坊 P1] ★纯函数：ST 正则 → BeautifierRule（裸 pattern 与 /p/flags 两形态都吃）
  ├── workshop-install-plan.ts      ← [工坊 P1] ★纯同步 planInstall：uid 分区内重新发号 / 条目转换 / 按名匹配更新 / 冲突与丢弃收集
  ├── workshop-diff.ts              ← [工坊 P4] ★纯函数 diffInstallPlan：更新前的「这一版会改什么」
  │                                    输入是**已算好的计划**而非重拉详情 —— 预告与提交在结构上同源
  │
  ├── lorebook-engine.ts / prompt-assembler.ts / importer.ts / variables.ts / vars-merger.ts
  ├── stream-parser.ts / api-router.ts / api-tools.ts / editor-utils.ts
  │
  └── (战斗 v2 纯计算规则见 docs/reference/combat-system-architecture.md；v3 内核见 docs/reference/combat-system-architecture-v3.md)

src/vanilla/sillytavern-store.ts    ← 框架无关响应式 Store
```

## 前端架构 (Phase 7)

```
src/ui/                              ← Vue 3 + Pinia + Vite 前端（单 URL 状态驱动）
├── main.ts                          ← 应用入口（createApp + Pinia + 主题 + 音频手势解锁监听）
├── App.vue                          ← 根组件（<router-view> + Toast + 界面级场景配乐 watch + 音频/素材库 init）
├── env.d.ts
│
├── composables/
│   ├── useMapViewer.ts              ← OpenSeadragon 生命周期
│   ├── useMapMarkers.ts             ← 地图标记 CRUD + Overlay 同步
│   ├── useHoverPopup.ts             ← 悬停浮层唯一实现（读 settings.hoverDelayMs）
│   └── useAssetImage.ts             ← [素材] 渲染缝：(name,type?) → {url,isVideo,row}，世代号守卫 + 引用计数索引
│
├── lib/                             ← 前端↔引擎桥接层
│   ├── game-pipeline.ts             ← GamePipeline（AgentConfig 组装/上下文/编排器/回调）
│   ├── audio-singleton.ts           ← AudioManager 应用级单例（setBlobResolver 注入缝）
│   ├── audio-folder.ts              ← [Audio] 本地音乐文件夹（File System Access 唯一接触点，仅 Chromium）
│   ├── asset-zip.ts                 ← [素材] 一键 zip 读写（流式 + SHA-256 + 体积上限）
│   ├── media-hash.ts                ← [素材] SHA-256 唯一实现（不可用返 undefined 不换算法）
│   ├── asset-url.ts                 ← [素材] object URL LRU + 引用计数
│   ├── image-crop.ts                ← [素材] 从源图切真字节（解码与画布两处注入缝）
│   ├── crop-rects.ts                ← [素材] 裁剪框几何（纯函数，源图像素坐标系）
│   ├── workshop-client.ts           ← [工坊] 唯一网络接触点（判别联合永不抛穿 + 超时 + 取消）
│   │                                   P4: +listMyProjects / 投稿写侧（create/update/visibility/delete/上传三口）
│   │                                   / 审核面（pending/review/admins/logs/set-admin）
│   ├── workshop-cover.ts            ← [工坊 P4] 封面候选链（wsrv.nl 代理 → 原图；组件按序试）
│   ├── workshop-upstream-error.ts   ← [工坊 P4] Cloudflare 平台错误（1027 额度/1102 资源/429）优先于业务错误
│   ├── workshop-enable.ts           ← [工坊] 启用展开纯函数（项目 → `creative_workshop:<uid>` 集合）
│   ├── quality-colors.ts / test-fixtures.ts / toSystemEvent.ts
│   └── variables.css + 10 主题 CSS（parchment/obsidian/crimson/indigo/bronze/sakura/ivory/misty-lilac/forest/ocean）
│
├── stores/
│   ├── theme-store.ts / ui-store.ts / settings-store.ts / create-store.ts / game-store.ts
│   ├── audio-store.ts               ← [Audio] Pinia 薄壳（桥接单例 + CRUD + 三后端分流）
│   ├── asset-store.ts               ← [素材] 执行器（planImport 出计划，本店只落库）+ importForCharacter/importPortraitPair
│   ├── worldbook-store.ts           ← [工坊 P0] 🆕 世界书 Dexie 唯一入口（`settings.worldBooks` 已不存在）
│   ├── worldbook-migration.ts       ← [工坊 P0] localStorage→Dexie 六步迁移（标志位判定→单事务 bulkPut→逐本回读校验→过了才删源→失败一律不动可重试；dedupeIds 防同 id 静默合并）
│   ├── beautifier-store.ts          ← [工坊 P0b] 美化规则 Dexie 唯一入口（内置预设走纯内存 ref，不持久化）
│   ├── beautifier-migration.ts      ← [工坊 P0b] 复用 P0 六步迁移
│   ├── workshop-store.ts            ← [工坊 P1] 执行器：拿 planInstall 的计划落 DB，不含转换逻辑
│   └── workshop-social-store.ts     ← [工坊 P3] 社交状态（Bearer JWT 弹窗+轮询登录 / JWT 本地解码 /
│                                       toggle 乐观→校正→回滚 + 800ms 节流；纯内存展示层，零 Dexie，D22/D23）
│
├── components/
│   ├── shared/                      ← 通用组件
│   │   ├── AppButton / AppModal / AppCard / AppTabs / ResourceBar / QualityBadge / BuffChip
│   │   ├── AvatarPanel.vue          ← 头像（4 尺寸 × circle/square + video prop）
│   │   ├── AssetMedia.vue           ← [素材] 命中铺满/没命中交回插槽兜底
│   │   ├── CharacterPortrait.vue    ← [素材] 顶对齐大画像位（纯呈现组件，不碰 store）
│   │   ├── PortraitSettingsDialog.vue ← [素材] 画像唯一调节面（取景三滑块 + 换图）
│   │   ├── AssetCropEditor.vue      ← [素材] 裁剪台（一张源图烘出立绘+头像两份真字节）
│   │   ├── WorkshopEnableList.vue   ← [工坊] 项目粒度启用列表（捏人页与游戏页共用）
│   │   ├── ToastContainer.vue
│   │   └── form/ (Input/Select/Stepper/Cascader/KeyValue)
│   ├── home/HomePage.vue            ← 游戏标题画面
│   ├── settings/
│   │   ├── SettingsPage.vue         ← 设置页（左侧导航 + 12 分区 + 预设系统）
│   │   ├── AudioSection.vue         ← [Audio] 音频分区（壳层 + 5 子组件）
│   │   └── AssetSection.vue         ← [素材] 素材分区壳层 + 4 子组件
│   ├── create/CreatePage.vue        ← [占位] 捏人页
│   ├── game/
│   │   ├── GamePage.vue             ← 游戏页主布局（三栏 + 6 弹窗；持有 --rail-w）
│   │   ├── MapPanel.vue / TopBar.vue / SideToolbar.vue / ScenePanel.vue / ChatFlow.vue / InputBar.vue
│   │   ├── StatusHUD.vue / StatusOverview.vue / ItemsPanel.vue / CharacterListPanel.vue
│   │   ├── QuestsPanel.vue / PlotPanel.vue / MemoryPanel.vue / SnapshotPanel.vue / MiniPlayer.vue
│   │   ├── WorkshopEnablePanel.vue  ← [工坊] 每存档「内容启用」面板（建档后仍可改）
│   │   └── (战斗面板见 combat/ 子组件，docs/reference/combat-system-architecture.md)
│   └── workshop/                    ← [工坊 P1] 创意工坊页
│       ├── WorkshopPage.vue         ← 页面壳（已安装列表 + 浏览入口；首页与侧栏均有入口）
│       ├── WorkshopBrowseModal.vue    ← 搜索 + 服务端排序（5 模式）+ 恒定四标签筛选 + 骨架屏
│       ├── WorkshopDetailModal.vue    ← 装前检视：条目/正则逐条展开
│       │                                 ★ 正则行的处置预告复用 `mapWorkshopRegexes`
│       │                                   （与装后已装列表同源，别另写第二套判定）
│       ├── WorkshopProjectCard.vue    ← tags 一条不折叠（D12，勿改成「更多」）
│       ├── WorkshopInstalledList.vue / WorkshopConflictModal.vue
│       │     ★ P4 起后者对**每一次更新**都出现（不只有冲突时）——多出改动预告一节；
│       │       有冲突才用那句惊悚标题，否则只是「确认更新」（狼来了会让用户闭眼点过去）
│       ├── WorkshopSubmitModal.vue    ← [工坊 P4] 投稿/编辑（多步进度 + 失败善后话）
│       │                                 🔴 编辑已发布项目上游会**换成草稿 id**，后续上传必须打新 id
│       ├── WorkshopAdminModal.vue     ← [工坊 P4] 审核面板（待审核/管理员/日志三 Tab，超管才见后两个）
│       ├── WorkshopSocialActions.vue  ← [工坊 P3] 点赞/订阅按钮对（卡片 compact / 详情 full 共用
│       │                                 **唯一**社交动作入口——四条失败分支文案必须同源，别各写一份）
│       └── format.ts / failure-text.ts（展示层纯函数；P3: +unauthorized 分支 / Discord 头像与登录引导文案）
│
└── styles/                          ← base.css / transitions.css / utilities.css
```

### 设置页 12 分区

| 分区           | 内容                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 🔌 API 配置    | API 池 CRUD、连接测试、模型列表获取、模型推荐                               |
| 🤖 Agent 配置  | 11 个汉化 Agent、模型选择、世界书开关、System Prompt 编辑                   |
| 📚 世界书      | [占位] 导入/新建按钮                                                        |
| 📖 剧情系统    | 8 种剧情偏向、模式/年份/难度/外部NPC/自定义偏好、大纲预览                   |
| 🧠 记忆 & 缓存 | 召回数/压缩阈值/快照上限/缓存策略                                           |
| 🎨 外观主题    | 10 主题网格、字体风格、字体大小、悬停延迟、减少动态效果                     |
| 💬 消息显示    | 系统通知开关 + 7 种事件类型过滤                                             |
| ✨ 输出美化    | 预设规则库 (22条) + auto-enable 绑定 + 三段式 UI + CRUD                     |
| 🎵 音频        | 混音台 + 播放列表 + 音轨库（音乐文件夹条/上传/搜索/场景配乐开关）           |
| 🖼 素材         | 导入条 + 素材库（按角色分组/扁平表/多选批删）+ 变体抽屉（设主图/裁剪/改名） |
| 💾 存档数据    | 导出/导入/清除（排除音频库与素材库，各有独立导出口）                        |
| ℹ 关于         | 引擎版本/技术栈/统计                                                        |

### 预设系统（正文 Agent 专用）

仿 SillyTavern AI Response Configuration 面板：预设选择器 + 导入 ST JSON / 新建 / 导出 / 删除；采样器参数预览；条目列表（启用/名称/角色/字数/编辑）；ST 导入完整保留 `prompts[]`。

## 内容许可

本仓库包含创意内容（世界观设定、角色卡、Lore），受 `《命定之诗》内容二创与素材使用授权协议.md` 约束。代码部分（`src/sillytavern/` 目录下）源自 `tavernlike` skill，使用 **MIT** 许可。两者不可混淆 — 对引擎的修改遵循 MIT；对世界观内容的复用或再分发须遵守独立授权协议。
