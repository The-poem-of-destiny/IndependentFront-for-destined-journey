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

### 🟢 纯文档改动可以直推 master（免 PR）

**只改 `.md` 的提交允许直接推 master，不必开 PR。** 代码（`src/` `server/` `tests/` `scripts/` 配置文件）仍按 `docs/planning/2026-07-31-repo-management.md` §2 走分支 + PR。

**🔴 但直推之前必须先跑 Prettier**，否则 CI 的 `format:check` 会在 master 上挂红：

```bash
npx prettier --write <你改过的每一个 .md>
```

三条细则，缺一条就会踩坑：

1. **只 `--write` 你真正改过的文件**，绝不跑仓库级 `npm run format` —— Windows 上 `core.autocrlf` 会让它把约 520 个文件重写成 LF，全部显示为已修改但 `git diff` 无内容变化。
2. **写完之后再格式化**。先格式化再编辑等于没格式化 —— CI 跑在 Linux/LF 检出上，它是权威闸门。
3. **`git diff --numstat` 分辨真假改动**：没有 numstat 行的文件只是行尾变化，用 `git checkout -- <file>` 还原掉，别把它带进提交。

推完照样要检查 CI（上一条规则对直推同样生效）。

### 🔴 改中文文本之后必须验编码（每次，别凭肉眼）

本仓大量文件是中文：提示词（`data/defaults/agent-config.json`）、世界书、设计文档。
**用脚本批量改这些文件极易悄悄毁掉编码**，而症状全都不在改动处：

- **U+FFFD 替换字符**（那个菱形问号）—— 一次错误的编码往返就会产生。`agent-config.json` 一度带着
  **47 个**，其中一个落在**闭合 XML 标签的标签名里**，模型看到的是坏标签，而 diff 看着完全正常。
- **真控制字符混进 JSON 字符串** —— 脚本里想写 `\n`（两个字符）却落成一个真换行，
  JSON 当场不可解析；想写 `\b` 却落成 `0x08`（退格），正则从此匹配不到任何东西，**且不报错**。
- **Windows 控制台是 GBK** —— 脚本里 `print()` 中文会抛 `UnicodeEncodeError`，或打出一屏乱码。
  **别拿控制台回显当验证依据**，它自己就会骗人。

改完（尤其是用 python / sed / PowerShell 批量改过）**必须**跑一遍：

```bash
node -e "const fs=require('fs');const f=process.argv[1];const s=fs.readFileSync(f,'utf8');const bad=(s.match(/\uFFFD/g)||[]).length;const ctrl=(s.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)||[]).length;if(f.endsWith('.json'))JSON.parse(s);console.log(f,'U+FFFD:',bad,'ctrl:',ctrl)" <改过的文件>
```

三条判据缺一不可：**U+FFFD 为 0**、**控制字符为 0**、**JSON 能解析**。
不为 0 就别提交 —— 编码坏字**不会让测试变红**，只会让模型看到坏输入。

> 配套的一条纪律：在脚本里拼这些转义时，用**原始字符串**或 `chr(92)` 拼，
> 别在多层引号里堆反斜杠。2026-08-05 那轮就是这样先写坏了 JSON、又写坏了正则；
> 连本节初稿都栽在同一处 —— 描述这个坑的那两个例子自己被转义吃掉了。

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
│   ├── worldbook-ejs-regex-authoring-guide.md
│   │                                   # 🆕 世界书 EJS + 输出美化正则创作者规范（作者入口）
│   ├── story_preset_format.md           # 🆕 Story Agent 预设编写指南（输出标签顺序 + 占位符排列 + 可用宏）
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
│                                       # 🆕 EJS 能力面设计 v1.0（设计与实施记录）← 改 EJS 注入面必读
│                                       #    12 个 namespace（stats/vars/local/char/world/quest/lore/
│                                       #    chat/fmt/rng/ui/engine）+ 上游别名层 + 原生库 A/B/C 三档保证
│                                       #    §0.1 裁定 + 实测：求值后端 **QuickJS(wasm, 主线程)**，不做 AST 分析器
│                                       #    ✅ T0-T8 全部实施完成（2026-08-01），真机走查未做
│                                       #    真机语料实测基线（754 条目/109 含 EJS）在 §9
├── planning/2026-07-31-creative-workshop-compat-design.md
│                                       # 🆕 创意工坊兼容层设计 v2（D1-D17）← 改工坊/世界书存储必读
│                                       #    Phase 0 世界书迁 Dexie · Phase 1 工坊 · Phase 2 EJS 沙盒（✅ 待真机）
├── planning/2026-08-04-image-generation-design.md
│                                       # 🆕 图像生成 v1（v1.1 / D1-D55）← 做文生图必读。**✅ 已实施，待真机**
│                                       #    v1 范围：NovelAI 单家 + 情景插画（标记当锚点，图就地插进正文）
│                                       #    🔴 三条钱相关的铁则：自动档不追溯开火 / 同回合不重复自动生成 /
│                                       #      超限降级成手动按钮而非丢弃标记
│                                       #    NAI V4 请求体三重冗余（input + v4_prompt + characterPrompts）已核准
│                                       #    🔴 §8.5 记着一条实施期才发现的坑：那句给 story 的指令
│                                       #      **不写进 agents.story.systemPrompt**（story 有预设短路）
├── planning/2026-08-04-image-generation-implementation-plan.md
│                                       # 🆕 图像生成 v1 的 lean-delegation 编排（波次 / 逐任务 brief）
│                                       #    开头「实际执行情况」一节记的是**实际怎么跑的**（7 波 22 任务）
│                                       #    与原计划（6 波 19 任务）的每一处偏差及其理由 —— 下次编排照它调
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
- **EJS 世界书求值契约 (ADR-30)**：世界书条目正文 EJS 由 Code 在提示装配期求值（承 ADR-04），契约自主设计、不承诺 MVU/酒馆助手兼容（上游函数名仅作别名层）。**两轴**：`stats` 只读面（纯代码推导数值：资源/等级/五维/命运点数/时间）+ `vars` 共写叙事变量空间（= `variables.sys` 草稿，AI 与 EJS 双写同一棵树，**冲突 AI 赢**——EJS 差量先落、vars_update 补丁后落）。提交权按 Agent 声明（`ejsVarsCommit`，默认仅 story——前瞻扩展设计）。缓存分层：含 `<%`/`{{random`/`{{getvar` 的条目沉到 LORE_BOOK 展开尾部，静态前缀保字节稳定；EJS 失败条目原文注入（零回归兜底）。创作者规范：`docs/reference/worldbook-ejs-regex-authoring-guide.md`；设计全文：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`；词汇：根目录 `CONTEXT.md`。

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

| 决策                         | 选择                                | 理由                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EventBus 实例化              | 按 SaveSlot                         | 效果实例随存档隔离                                                                                                                                                                           |
| Script 执行                  | 沙盒模式 (script-executor.ts)       | $event.on/off 持久订阅 + $call 跨对象调用 + init/cleanup 生命周期                                                                                                                            |
| 持久订阅管理                 | subscription-manager.ts             | 递归保护(≤10) + 僵尸兜底(unregisterAll)                                                                                                                                                      |
| EffectRuntime 时序           | 管线完成后批量执行                  | 保持 DAG 原子性                                                                                                                                                                              |
| EventBus 引入时机            | Phase 7e+8（已完成）                | 与 Script 系统同步上线                                                                                                                                                                       |
| Agentic 模式                 | OpenAI function calling (Phase 8.5) | craft_gen/char_gen/item_gen 通过 tools 调用真实 Code 函数，禁止 AI 编造数值                                                                                                                  |
| craft_request 时序           | 延迟型 (对齐 combat_trigger)        | Stage 1 暂存 → Stage 2 统一执行，避免阻塞叙事                                                                                                                                                |
| System Prompt 管理 (Phase 9) | agent-config.json 唯一来源          | 所有 Agent 的完整 systemPrompt 存在 agent-config.json；agent-templates.ts 只留 stub + 动态上下文函数。🔴 **story 例外**：预设短路，行为真源是预设条目——细节见架构图里 agent-config.json 那条 |

### 效果系统统一框架（战斗+制作共用，ADR-29）

战斗 v2 (M1-M5) 已验证一套**统一 subscribeChain 链式管道**机制，制作系统直接复用，不发明第二套。完整设计见 `docs/planning/unified-effect-system-framework.md`。

> 📌 **v3 演进**：战斗内已由 v3 内核接管（`combat-v3/`），效果走 **EffectAutomaton DSL**（18 窗口声明 / **12 个已接求值器** + 8 大类 intent + 封闭表达式文法），不再走 emitChain/script-executor。**本框架仍是制作系统与战斗外的效果基座**（ADR-29 继续适用）。

- **统一机制**：`EventBus.emitChain(type, params, ctx)` 链式参数管道——`(priority, order, 注册序)` 稳定排序、`ctx.combatants`+`subscription.owner` 在场过滤、错误隔离、递归保护
- **两个注册 facade**（互不干扰）：`ScriptRegistry`（声明式，物品装备/卸下）+ `SubscriptionManager`（动态，AI script 运行时 `$event.on`）
- **modifier 不是第二套系统**：物品 `modifiers[]` 在装备时由 ScriptRegistry 注册成"push handler"，走同一条 emitChain
- **核心模式：纯函数兜底 + AI subscribeChain 覆盖**：Code 算基础 → emitChain 传 AI → AI handler 改 outcome → AI 不响应走兜底
- **✅ P1-11 已接线（Q-07, 2026-08-03）**：战斗外效果系统已由 `effect-wiring.ts` 接进生产——`wireEffectSystem(saveId, characters)` 在存档加载时对已装备物品/技能执行 `executeInit` + `$event.on` 订阅注册，装备/卸下经 `state-manager` 的 equip/unequip handler 调 `wireObject`/`unwireObject`。`getEventBus(saveId)` 按存档实例化，`ScriptRegistry` + `SubscriptionManager` 双 facade 随存档生命周期。
- **✅ emit 源与效果回收也已接线（Q-07 第二半, 2026-08-03）**：`commitChatState` 每次提交后，把本次 patch 产生的 `GameEvent` 经 `publishToEffectSystem(saveId, events)` 发到存档 EventBus；`SubscriptionManager` 新增 `setEffectSink`，触发脚本产出的 `hpChanges`/`statChanges`/status 意图不再被丢弃（此前 `handleEvent` 执行完脚本直接扔掉，注释写着「由 state-manager 统一 apply」却没有那个调用方——与 Q-02 同形状的缺陷）。收上来的效果经 `convertScriptEffects` 转成 StatePatch，再走一轮 `commitChatState`（ADR-21 唯一写入口，**没有开第二条写路径**）。反应轮有深度上限 `MAX_EVENT_REACTION_DEPTH = 3`，防止「A 触发 B、B 触发 A」打成事件风暴。没接过线的存档零开销（`peekEffectWiring` 不凭空建 EventBus）。
- **⚠️ 战斗内 18 窗口里只有 12 个真的接了求值器**：`initiative.before` / `initiative.after` / `turn.close` / `morale.before` / `morale.after` / `settlement.before` 在 `combat-v3/phases/` 里没有任何求值器。它们现在编译期就以 `WINDOW_NOT_WIRED` 掉落（`V3_WINDOW_KEYS_RESERVED`），不再静默入索引；接上求值器时把 key 挪进 `V3_WINDOW_KEYS_LIVE` 即可。窗口求值统一走 `runWindow(out.events, ...)`——它保证 `EffectRejected` 诊断必进事件流，忽略返回值是可见的 TODO 而非隐藏的丢弃。

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

| Phase     | 内容                                                       | 状态                |
| --------- | ---------------------------------------------------------- | ------------------- |
| 1-4.6     | 架构/数据结构/Agent编排/记忆/事件/FP 基础                  | ✅                  |
| 5         | 角色 & 变量系统 (tier/bloodlines/validate/char/time)       | ✅                  |
| Geography | 位置系统 (location-db, 10势力 32节点)                      | ✅                  |
| Audit Fix | 世界书对齐 (数值/地理/品质/血脉)                           | ✅                  |
| 6a-6e     | 战斗/制作/集群士气/好感/Marker+SubAgent                    | ✅                  |
| 7a-7c     | 工程 (Vite+Vue3+Pinia) / 主题组件 / 首页+设置页            | ✅                  |
| 7d        | 捏人页 `/create`                                           | 🔄 世界书驱动改造中 |
| 7e        | 游戏页+HUD+脚本引擎+ChatFlow+输出美化+ScenePanel           | 🔄 待集成验证       |
| 7f / 7g   | 创意工坊（= 工坊 P1）/ 衔接测试                            | ✅ / ⬜             |
| 8 / 8.5   | Agent 可见性 / Agentic Agent (function calling)            | ✅                  |
| 9 / 9b    | System Prompt 迁移 / craft_gen 细化                        | ✅                  |
| 9c        | 集成测试 & 交付                                            | ⬜                  |
| 10a-10h   | 模板系统/预设占位符/vars_update/Quest/memory_summary       | ✅                  |
| 10i       | 输出美化规则库                                             | ✅                  |
| 10j       | 剧情系统接线                                               | ✅ 待真机           |
| 10k       | 快照面板+右键回退重发                                      | ✅ 待真机           |
| M1-M6     | 数据字段规范迁移（2787 tests 全绿）                        | ✅                  |
| Audio     | 音频系统 v1.0（双通道+三后端+按名寻址+场景配乐）           | ✅                  |
| 素材      | 素材管理系统 v1.0（渲染面+大画像+裁剪台+画像弹窗）         | ✅                  |
| 战斗 v2   | 战斗系统架构 v2（管道+中间件+6大类+19event+独立面板）      | ✅ 已退役（M5 删）  |
| 战斗 v3   | 代码内核主持流程（Kernel+DiceTape+EffectIntent+DSL）       | ✅ M5完成 全量合入  |
| 工坊 P0   | 世界书迁出 localStorage → Dexie v14（+ 进 FullBackup）     | ✅                  |
| 工坊 P0b  | 美化规则迁出 localStorage → Dexie v15                      | ✅                  |
| 工坊存储  | 正则共享隔离 KV → Dexie v16 `regexStorage`（+ FullBackup） | ✅                  |
| 工坊 P1   | 创意工坊（浏览/安装/更新/卸载/启用，= 7f）                 | ✅ 入口已开放       |
| 工坊 P2   | EJS 沙盒 + 只读 stats 投影（ADR-30）                       | ✅ 待真机           |
| 工坊 P3   | 社交面（Discord 登录/点赞/订阅，D18-D25）                  | ✅ 真机已过         |
| 工坊 P4   | 上游对齐（封面链/类型徽章/我的项目/更新 diff/投稿/审核）   | ✅ B4 真机已过      |
| 图像 v1   | 情景插画（NovelAI 单家 + 标记锚点 + 三档开关 + CG 图鉴）   | ✅ 待真机           |
| 真机迭代  | debug loop 持续修复                                        | 🔄                  |

> 🔓 **工坊入口已开放（2026-08-04）**：首页「创意工坊」按钮的 `HomePage.vue` `WORKSHOP_ENTRY_ENABLED` 已置 `true`。以下执行边界（2026-08-01 安全审计，2026-08-03 视觉边界修订）**一条没变**，仍是读工坊/正则代码时的必读；唯一遗留缺口是**脚本没有 CPU 预算**（恶意规则可让那一个 iframe 空转，宿主页面不受影响）。SEC-02 已由 QuickJS 隔离后端收口；SEC-01 不再用 DOM 白名单牺牲 replacement 兼容，而是把每次富正则命中放进各自无 same-origin 的 `sandbox="allow-scripts"` iframe，并使用 `credentialless` + `no-referrer`；未命中正文始终由宿主原生文本面渲染，正则 CSS/布局无法触及普通正文或其它命中。代价是跨命中 DOM 查询不再兼容。外部 HTTP(S) 资源与原生网络 API 为兼容性刻意放行；form、popup、download、top navigation、嵌套 frame、parent DOM、应用 Dexie/storage 与 API Key 仍不可达，应用自有 `/api` 也拒绝 `Origin: null`。正则唯一持久权限是 Dexie v16 `regexStorage`：所有正则、信任级别与预览共享同一个不可信命名空间，iframe 内以同步 `localStorage` 镜像和 `window.regexStorage` 别名使用，跨 frame 持久化/广播；`sessionStorage` 仍只活在当前 frame，IndexedDB 不开放。规则可向远程或本地网络发请求，也可外传该命中的 replacement/capture 与 regex-namespace 数据，这是当前威胁模型明确接受的暴露。**但这套全开契约只给「用户自己装过的规则」**：模型输出里合成的 `<item_info>` / `<task_info>` 卡片是另一档（`BeautifierMatchSegment.origin === 'model'`）—— CSP 只放行带 nonce 的宿主引导脚本，卡片自带 `<script>` / inline handler 由浏览器拦掉，`connect-src 'none'`，也不注入 `regexStorage` 快照；样式/图片照旧，视觉不降级。理由是模型正文会被世界书/角色卡/工坊文案里的注入牵着走，不该顺带拿到脚本面与网络出口。2026-08-02 公共工坊快照为 303 项目 / 99 条正则（0 编译失败）：60 条外部资源规则不再降级，16 条 parent 耦合与 14 条宿主 API 耦合仍受限；storage 词法命中 8 条，精查为 5 项目 6 条 active + 2 条仅注释，active 均只用 `getItem`/`setItem`/`removeItem` 且现已兼容。脚本仍无 CPU 预算（入口开放后这条仍未补）；已装规则按存档启用状态运行。详见 `docs/reviews/2026-08-01-repository-review.md` 与 `docs/reviews/2026-08-02-workshop-regex-compatibility.md`。

> 🟡 **工坊 P4 已实施（B1-B5），真机走查未做**：以上游工坊页（`github.com/AkabaneSaki/myrepo`，本地克隆 `E:\Projects\myrepo`）为参照做的功能对齐。B1 封面代理链 + 类型徽章 + Cloudflare 错误码 + 加载更多；B2 我的项目 / 订阅与已装 / 审核徽章；B3 更新前改动预告；B4 投稿·编辑·上传·可见性·删除；B5 审核队列 + 管理员 + 日志。**三条与上游刻意不同**已写进各自文件头注释：不给没有基础标签的项目盖章成「系统」、diff 由已算好的安装计划派生（不重新归一化一遍）、权限判定只用于画不画入口（门禁在上游 403）。**真机走查（2026-08-02）**：B4 写侧（投稿上传 / 编辑 / 删除）与 P3 社交（点赞 / 订阅）已人工走过。B1-B3（封面链 / 我的项目 / 更新 diff）尚未专门走查。🔴 **B5 审核面无法自测（已搁置）** —— 当前账号 `isAdmin: false`，延后到拿到管理员账号再做。

> 🩹 **走查后修的三处**（fable 审查发现，均已补回归测试）：
>
> 1. **并发 toggle 互相抹掉** —— 节流键按（项目 × 动作）分开，点赞与订阅可同时在飞；而校正/回滚都拿**起飞时**抓的快照整份盖回去，后落地的会把先落地的成果重置回起飞前，失败回滚还会连累并发动作、并留下一个服务端从没记过的「幻影赞」。现在校正基线取**落地那一刻**的覆盖层，回滚只放回自己那一对字段（`workshop-social-store.ts` 的 `rollback`）。
> 2. **编辑表单从本地已装库取初值** —— 「我的项目」列的是作者名下全部项目、未必装过，查空就开出空表单，而「提交修改」是整份 PUT，一次没留神就把上游的简介清成空串、标签清光。现在 `WorkshopBrowseModal` 的 `edit` 事件转达**上游整行**，本地那份只做兜底。
> 3. **登录弹窗不验地址** —— `window.open` 吃的是上游响应里的一个字段：`javascript:` 会在与本源关联的上下文里执行（当时 API Key 仍在 localStorage），而弹窗刻意保留 opener（登录靠 postMessage），放行陌生域等于把 `opener.location` 交出去。现在开窗前过 `isAllowedLoginUrl()`：只放 https + 主机钉死 `discord.com` 与工坊 worker（含子域）。
>
> 🟡 **图像生成 v1 已实施（7 波 22 任务），真机走查未做**：`<scene_image>` 成为引擎认识的标记，story 在正文里就地插标记当锚点，Code 走「限额 → `image_prompt` 侧链把中文转 danbooru → NovelAI V4.5 出图 → 落库 → 就地渲染」。三档开关（off / manual / auto）默认 **manual**。设计 D1–D55 全文在 `docs/planning/2026-08-04-image-generation-design.md`，实施编排与实际偏差在同目录的 `-implementation-plan.md`。**上游链路已真机跑通（2026-08-04）**：合成冒烟（不走真实游玩，手工造 danbooru 场景串）打通「装配 → 三重冗余 → 同源 BFF `forward()` → NAI → 真实 zip → PNG」，1 角色与 0 角色各出图一张，1216×832，约 1.8 秒。三条此前只有自压 fixture 的假设现已实测：真实响应 zip（魔数 `50 4b 03 04`，单条目 `image_0.png`）、0 角色空数组上游接受、`ucPreset: 0` 出图正常。**仍未真机的是游玩链路**：story 产标记 → `image_prompt` 侧链 → 限额 → 落库 → 正文渲染 / CG 图鉴，全部只有单测。四条钱相关的铁则分别钉在四个文件里：自动档不追溯开火（`lib/game-pipeline.ts`）、限额在侧链之前（`image-quota.ts`）、「无记录 + auto」出按钮而不是去生成（`scene-image-view.ts`）、手动永不被判成不可用（`useManualSceneImage.ts`）。
>
> 🩹 **真机第一次成功出图时逮到的（2026-08-04）**：`parseNaiZip` 先判 `content-type` 含不含 `zip`，不含就 `bad-response`。NAI 实际报的是 **`binary/octet-stream`** —— 于是第一张**已生成、已扣 Anlas** 的图被我们自己扔掉，还报成「NovelAI 返回了看不懂的内容」。根因是**拿可变的 header 去否决不可变的字节**：现在一律先试解包，content-type 只进失败 detail。同一轮还发现 `NAI_ANLAS_RULES` 的免费额度是 **Opus 专属**却对所有账户生效（见上一条 commit）。
>
> 🩹 **实施中逮到的两处**：① `blurByDefault`（D46 打码）**声明了但没人传**，整条功能是死的 —— 根因是只有单组件测试，那种测试能证明逻辑对、**证明不了有人供值**，现已补从 ChatFlow 真渲染到底的链路测试。② `data/defaults/agent-config.json` 里有 **47 个 U+FFFD 坏字符**（16 段 / 6 个 agent），其中一处落在闭合 XML 标签的标签名里 —— **既有问题，本轮未修**，已另开任务。
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
  ├── database.ts                   ← Dexie/IndexedDB v19
  │       🔴 `DB_VERSION` 常量必须等于最后一个 `this.version(n)`。它只出现在
  │          `FullBackup.version` 上、导入侧不拿它做判断，所以**对不上不会有任何报错**，
  │          只是每份导出的备份都盖了过期的戳。它曾经落后两版（v18/v19 忘了改），
  │          而 `database.test.ts` 的断言跟着写了旧值 —— 漂移被测试固定而不是拦下
  │   ├── v1-v3: lorebooks / presets / settings / chats
  │   │           🪦 lorebooks 是 v3 遗留 `Lorebook` 类型的**死表**，生产代码零读写；
  │   │              现役世界书表是 v14 的 worldBooks（`WorldBook` 类型）。
  │   │              settings 自 Q-06 起也是死表 —— 此前这句话是**错的**：它有三处活引用
  │   │              （initializeDatabase 播种 / state-manager 打快照时读 / FullBackup），
  │   │              而前端设置的真源在 localStorage，于是引擎读到的是一份永远停在
  │   │              DEFAULT_SETTINGS 的影子配置（症状：设置页改了、引擎行为没变）。
  │   │              现在引擎经 `engine-settings.ts` 注入缝读真源，播种与那座只搬两个
  │   │              字段的桥（game-pipeline.syncSnapshotSettings）都已删除。
  │   │              两张死表刻意保留（删表要写 `表名: null`，会永久抹掉老用户的 v1–v3 行）；
  │   │              FullBackup 仍照搬它们的行，只为老备份往返不丢字节。
  │   ├── v4+: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │   ├── v11+: audioTracks / audioBlobs / audioPlaylists（全局共享，排除 FullBackup）
  │   ├── v12+: audioHandles（持久化 FileSystemDirectoryHandle）
  │   ├── v13+: assetMeta / assetBlobs（素材库，全局共享，排除 FullBackup，走 zip 导出）
  │   ├── v14+: worldBooks / workshopProjects（工坊 P0；两者都进 FullBackup）
  │   ├── v15+: beautifierRules（工坊 P0b；只存**用户规则**，内置预设是派生缓存不落库）
  │   ├── v16+: regexStorage（所有正则/信任级别/预览共享的隔离 KV；进 FullBackup；更新/卸载保留）
  │   ├── v17+: sceneImages / sceneImageBlobs / imagePresets（图像 v1）
  │   │          删存档连带删前两张；**imagePresets 刻意不删** —— 视觉预设是全局的，
  │   │          与素材库同口径（删一个存档不该让别的存档的角色换脸）
  │   │          FullBackup 收 sceneImages ✅ + imagePresets ✅、**sceneImageBlobs ❌** ——
  │   │          图片字节进 JSON 会爆炸；字节的回收走「清理」不走备份
  │   │          🔴 「清理」= 删 blob 行 + 给记录打 blobDropped，**sceneImages 行数不变**（D47）：
  │   │             图鉴那一格变成「字节已清理 + 重画」，标题/说明/提示词一条不少
  │   │             判据 `hasStoredSceneImageBytes` 与三个入口（用量 / 可清理名单 /
  │   │             真正删字节）**只有这一份** —— scene-image-store 里那份重复实现已删
  │   ├── v18+: **无新表**，只删数据 —— 地点视觉预设废除（D59），
  │   │          `imagePresets` 里 `kind==='location'` 的行清掉。故这一版
  │   │          **不带 `.stores()`**：带上就得把 v17 全套表名再抄一遍，抄漏一张就是删表
  │   └── v19+: characterAppearances（角色外貌**会话副本**，D56）
  │              与 imagePresets（全局基线）刻意相反：**随存档隔离，删存档连带删**，
  │              且**进 FullBackup** —— 它与 sceneImages 同为「每存档」数据，必须同进同出。
  │              漏收它不会报错，症状是导入后每个角色的本档变化静默退回基线
  │              🔴 **这是 AI 唯一写得到的外貌表**（D60，v1.3）：没有基线的角色，
  │                 AI 即兴出来的那份也落这里（差量基准全空），**不再**去建全局基线
  │       🔴 **世界书、美化规则与 API Key 现居应用 Dexie，不再在 localStorage**。正则 iframe
  │          只能经同步镜像访问 `regexStorage`，不能访问任何应用表；应用 localStorage 只存无密钥
  │          设置元数据（Agent 配置/主题/`beautifierBuiltinDisabled` 等）
  │
  ├── agent-client.ts               ← [Phase 3] API 客户端（每 Agent 独立 userId / 重试退避 / 缓存检测）
  ├── agent-templates.ts            ← [Phase 3+9] Prompt 模板（systemPrompt 已迁 agent-config.json，留 stub + 动态上下文）
  ├── agent-config.json             ← [Phase 9] 10+ Agent 完整 systemPrompt 唯一来源
  │      （🔴 实际文件在 `data/defaults/agent-config.json`，不在本目录）
  │      🔴 **story 是这条「唯一来源」的例外**：`buildAgentMessages(story)` 先跑
  │         `assemblePresetContent`，拿到内容就直接用、**根本不看 systemPrompt**，
  │         只有「用户一个预设都没有」时才回退 `STORY_TEMPLATE.fixedSystem + fixedExamples`。
  │         于是往 `agents.story.systemPrompt` 里写字有两种结果、没有一种是想要的：
  │         有预设时（常态）永远不生效；没预设时**顶掉整份** fixedSystem+fixedExamples ——
  │         一句话换掉全游戏最要紧的提示词。**story 的行为真源是预设条目**
  │         （图像 v1 那句 `<scene_image>` 指令就落在预设条目里，不在 systemPrompt）。
  │         挑条目还有第二个坑：`assemblePresetContent` 按**条目自身的 `enabled`** 过滤、
  │         **不读 `prompt_order`** —— 现行预设 101 条里只有 32 条真的进提示词，
  │         写进一条没启用的条目 = 写进空气
  │      🔴 本文件现存 47 个 U+FFFD 替换字符（16 段 / 6 个 agent），其中一处落在闭合 XML
  │         标签的标签名里（形如 `</□有物品>`，模型看到的是坏标签）。**既有问题，
  │         图像 v1 未修**，已另开任务；改这个文件时别顺手把它们当成自己弄坏的
  ├── agent-tools.ts                ← [Phase 8.5] Agentic 工具注册表（17 tools）+ AGENT_TOOL_MAP
  ├── agent-orchestrator.ts         ← [Phase 3+8.5] DAG 编排引擎（阶段串行+同阶段并行/M3 翻译层按名寻址零id单patch）
  │   ├── callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │   └── Marker 回调: onCraftRequest/onCombatTrigger/onCharGenRequest/onPlayAudio
  ├── story-rescue.ts               ← Story 正文救援（正文吞思维链 / 思维链泄漏正文 AI 缺陷兜底）
  ├── random-tables.ts              ← [Phase 8.5] NPC 生成随机表
  │
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化（铁律5）
  ├── tier-constants.ts / bloodlines.ts / validate.ts / char-query.ts
  ├── resource-calc.ts / var-resolver.ts / namespace-normalizer.ts / time-system.ts
  │
  ├── save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币（M5: +variables 变量唯一真源）
  ├── effect-parser.ts / effect-runtime.ts
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
  ├── combat-intention.ts / combat-damage.ts / combat-turn.ts / combat-resolver.ts
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
  │   ├── craft-request.ts        ← [Q-21] 装配唯一口 buildCraftRequest(角色, 工具参数, 骰带)
  │   │                              🔴 **纯函数、无随机** —— 骰子由工具边界掷好传进来
  │   │                              （agent-tools.takeCraftTape）。此前两个工具各装配一遍
  │   │                              且都写 `d20Rolls: []`，`rollCraftDice` 兜底成
  │   │                              `d20Rolls[0] ?? 10` → **生产每一次制作检定都是 d20=10**，
  │   │                              连带大失败不可达（判据要 length===1，而 length 是 0）、
  │   │                              优/劣势整条死规则（要 length>=2）。与 Q-01 同形状，
  │   │                              但 Q-01 只覆盖了 combat-v3 的 coordinator。
  │   │                              check 的骰带按**请求指纹**存 ToolExecutionContext.craftDice，
  │   │                              同参数的 settle 取走 —— AI 只见结果不碰骰值，且刷检定无效。
  │   │                              🔴 骰数由优/劣势决定（齐平 1 颗 / 优劣势 2 颗），
  │   │                                 **不能**一律掷 2 颗，那会把大失败判据换个姿势再打掉一次
  │   └── craft-projection.ts     ← [Q-21] 结算结果 → `<action_info>` 竖线表 + 一句话摘要
  │                                  照 combat-v3 projection-agent/projection-ui 的先例；
  │                                  这一层不允许出现计算（ADR-28：面板是给纯文本 AI 的遗留手段）
  ├── morale-system.ts / affection-system.ts
  ├── start-catalog.ts              ← [Q-30] 捏人页目录入口（类型/常量/品质映射）+ start-catalog-data.ts（纯数据，CDN 生成）
  ├── marker-protocol.ts            ← [Phase 6e+Audio+图像 v1] XML 标记检测（含 <play_audio> / <scene_image>）
  │                                    + sanitizeCaption（标题/说明的收敛器）
  │                                    🔴 加标记**只动 MARKER_SPECS**（Q-05）：扫描器、MARKER_TAGS、
  │                                       scanMarkers 全由那张表推导，别去手改它们
  │                                    🔴 标记正文那句中文**不过 normalizeTagString** —— 全角标点在中文
  │                                       句子里是对的，归一化会把它改坏
  │                                    🔴 title 畸形（含引号/超长/缺省）**只收敛不拒绝**：为一次装饰性
  │                                       失误否掉整个标记，等于把它升级成一张画不出来的图
  ├── char-gen-agent.ts             ← [Phase 6e] 角色生成编排（M3 单patch落库/正式字段直写/零id）
  ├── craft-gen-chain.ts            ← [Phase 9b] 制作生成编排（M3 零id/type归一化/单patch）
  │
  ├── script-executor.ts            ← [Phase 7e+8] 脚本沙盒（$event.on/off / $call / @parent / init·cleanup）
  ├── subscription-manager.ts       ← [Phase 7e+8] 持久订阅管理器（递归保护≤10 + 僵尸兜底）
  ├── effect-wiring.ts              ← [Q-07] 战斗外效果接线（存档加载 wireEffectSystem / 装备卸下 wire-unwireObject）
  │                                    EventBus 按存档实例化 + ScriptRegistry/SubscriptionManager 双 facade
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
  ├── types-image.ts                ← [图像 v1] 子系统类型分册（先例 types-audio.ts）。与音频分册不同的是
  │                                    **数据模型类型也全在这里** —— 图像生成与 types.ts 既有实体零交织，
  │                                    集中放才只有一个真相来源。唯一反向边是 `SceneImageMarker`：它要进
  │                                    types.ts 的 `DetectedMarker` 联合，那边 type-only import 回来，
  │                                    本册**不 import types.ts**，边不成环
  ├── image-defaults.ts             ← [图像 v1] 画质后缀 / 固定构图词 / 基础负向 / 限额初值的唯一出处
  │                                    （被 image-prompt、image-quota 与设置页 getDefaults() 共用）
  │                                    🔴 默认模型刻意**不是 Curated**：它既是过滤子集，官方规范画质后缀
  │                                       还强制带 `rating:general` —— 本项目要支持露骨内容，带上等于
  │                                       每张图都在跟自己的提示词打架。已有断言钉死这条
  ├── image-prompt.ts               ← [图像 v1] ★承重纯函数：场景串 + 角色/地点预设 + 世界标签 → ComposedPrompt
  │                                    🔴 角色预设**绝不拼进 base**，各进 characters[]；角色负向进**该角色的
  │                                       槽**，不并入 baseNegative —— 官方文档确认多角色并进去会串味
  │                                    🔴 `normalizeTagString` 由本模块 export，是**全仓唯一一份**
  │                                       （image-prompt-agent 从这里 import，绝不另抄一份）
  │                                    🔴 无随机、不读时钟、不做 I/O —— 中文→标签是一次 LLM 调用，
  │                                       发生在侧链里；那一步挪进来，本层就再也测不动了
  ├── image-quota.ts                ← [图像 v1] 三层限额（每消息 / 滚动一小时 / 同回合去重）**唯一**判定处
  │                                    🔴 自动档与手动档共用它，差别只在拿到 ok:false 之后做什么。
  │                                       两处各写一份就是漂移的来路 —— 一边改阈值另一边没改，症状是
  │                                       「有时候拦有时候不拦」，而错的那一边在花钱
  │                                    🔴 传进来的记录必须含 queued/generating/failed：只算 done 的话，
  │                                       连点 10 次会在第一张落地之前全部放行，限额形同虚设
  │                                    🔴 必须跑在 image_prompt 侧链**之前**（D32）：两处都花钱
  │                                       （LLM token + Anlas），闸门要在最前面
  │                                    🔴 `source==='manual'` 的 ok:false 语义是**「要确认」不是「不许」**
  │                                       —— 机器该被拦死，人该只被减速
  ├── image-segments.ts             ← [图像 v1] 一条正文 → 文本段/图片段序列（分段在**美化之前**且不看
  │                                    美化开关：否则美化关掉或流式途中，标记会漏成尖括号给玩家看见）
  │                                    🔴 **不许写第二个解析器** —— 调 marker-protocol 的 scanSceneImages
  │                                       拿 position 切。一个标签两个解析器就是漂移的来路
  ├── image-world-tags.ts           ← [图像 v1] 时段 / 天气中文 → danbooru 标签（D39）：夜里的戏不该被
  │                                    画成白天，而引擎本来就知道现在几点 —— 不必问 AI
  │                                    🔴 **映射不中的值一律不贡献标签，绝不猜**。天气是 AI 自由书写的
  │                                       短词（「小雨转晴」「血月低垂」），留空只是少一个标签，
  │                                       猜错是**在画面上画出没发生的事**。故只做精确匹配
  ├── image-anlas.ts                ← [图像 v1] 估算这一张会不会烧 Anlas（D43）：宽高与步数在设置里**可调**，
  │                                    调大了会**静默**开始扣费，用户只看到图变清楚了
  │                                    🔴 给的是提示不是保证 —— 判定值叫 within-free-allowance 而不是
  │                                       isFree，UI 措辞必须是「按当前订阅规则**估算**」。
  │                                       规则会变，所以数字只许出现在 NAI_ANLAS_RULES 一处，
  │                                       测试就是这条规则的文档
  │                                    🔴 **免费额度只有 Opus 有**（2026-08-04 真机催生）。`tier` 缺省是
  │                                       `'unset'` 而不是 `'opus'` —— 默认给乐观答案，等于替所有按点数
  │                                       付费的账户（Tablet/Scroll/免订阅购点）宣布「这些图不要钱」，
  │                                       而他们每张扣约 17 点。牌价与档位无关，档位只决定免不免
  ├── image-prompt-agent.ts         ← [图像 v1] image_prompt 侧链：装配 → callAgent → 抽取，
  │                                    **两端是纯函数，中间那次调用是唯一 I/O**（客户端从 deps 交进来，
  │                                    形状照 char-gen-agent 的 CharGenClient）
  │                                    🔴 抽不到 <image_prompt> 就是**明确失败**，不猜、不用启发式兜一个
  │                                       —— 兜出来的是一张没人要的图，且失败被掩盖
  │                                    模型爱在答案前写一段废话，抽取要能越过它（先例 story-rescue.ts）
  ├── character-appearance.ts       ← [图像 v1 / D56·D58] 外貌**属性槽**模型（九槽）+ 逐槽合并。
  │                                    🔴 `undefined` = 没说，空串 = **明确清空** —— 两者长得一样正是
  │                                       D58 要消灭的歧义（`patch.x || base.x` 会把清空悄悄退回基线）
  ├── character-appearance-agent.ts ← [图像 v1 / D56·D57] AI 报外貌的线格式与抽取 + 追加进 systemPrompt
  │                                    的那段规则（**格式定义与解析器同源**，写进 agent-config.json 会
  │                                    长出「提示词教它写 A、解析器只认 B」那种静默失效）
  ├── character-appearance-resolve.ts ← [图像 v1 / D60·D61·D62，v1.3] ★「这个角色现在到底长什么样」
  │                                    的**唯一**判定（纯函数叶子）。四个消费方共用同一个答案：装配 /
  │                                    侧链点名 / 正文缺预设提示 / 写入路由 —— 各写一份的表现是
  │                                    「界面说这张图的形象是随机的，其实并不是」
  │                                    🔴 **AI 一个字节都写不到基线**（D60）：`appearanceWriteTarget`
  │                                       永远给 session，没有基线时差量基准是全空
  │                                    🔴 `buildEffectivePresets` 必须把**只有会话副本、没有预设行**的
  │                                       角色也合成进去，否则那份即兴外貌永远到不了提示词
  │                                    🔴 全空的 `appearance` **等于没有** `appearance`（D62）——
  │                                       编辑器总是整份写回九个槽，按存在性判会把用户填过的
  │                                       手写串预设当成「没有预设」丢掉，静默且每张图都不像
  ├── image-providers/novelai.ts    ← [图像 v1] ComposedPrompt → NAI V4.5 请求体 / 响应 zip → PNG 字节
  │                                    🔴 **三重冗余是这一层的全部要害**：同一份内容要展开到 `input` /
  │                                       `v4_prompt` / `characterPrompts` 三处，字段名还各不相同，而
  │                                       **只填一处不会报错，只会静默产出不对的图**。所以三处一律由
  │                                       同一个中间结构一次性展开，中间不许插 filter/sort（下标会错位）
  │                                    🔴 本层不产随机：seed 缺省由调用方给，塞 Math.random() 会让快照
  │                                       复现失效（测试钉住了这条）
  │                                    🔴 **字节是权威，content-type 只是线索**（2026-08-04 真机纠正）：
  │                                       `parseNaiZip` 原先先判 content-type 含不含 `zip`，而 NAI 真机
  │                                       报的是 **`binary/octet-stream`** —— 一张已生成、已扣点数的图
  │                                       被我们自己扔掉。现在一律先试解包，content-type 只进失败 detail。
  │                                       真机实测：zip 魔数 `50 4b 03 04`，单条目 `image_0.png`
  │
  │  🪦 Q-12：`variables.ts` / `vars-merger.ts` 已删。两者整条链零生产引用
  │     （`variables.ts` 最后一个活着的导出 `formatVariablesForPrompt` 的唯一消费方
  │      是 Q-04 删掉的 prompt-assembler）。顺带拆掉「两个同名 `applyVarsPatch`
  │      契约互斥」那个 auto-import 陷阱：留下的那份改名 `var-resolver.applyPathOps`，
  │      入参形状提进 `types.ts` 的 `VarPathOps`；`VarsPatch` 保留，它是效果系统
  │      （`effect-runtime.executeVarsPatch`）的声明式载荷，两者用途不同别再混。
  ├── api-router.ts / api-tools.ts
  │
  └── (战斗 v2 纯计算规则见 docs/reference/combat-system-architecture.md；v3 内核见 docs/reference/combat-system-architecture-v3.md)
```

> 🪦 这里曾指着一行 `src/vanilla/sillytavern-store.ts`（"框架无关响应式 Store"）——该目录早已不存在，Store 由 Pinia 接管。Q-15 清仓时删掉，别按图找那个文件。

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
│   ├── useAssetImage.ts             ← [素材] 渲染缝：(name,type?) → {url,isVideo,row}，世代号守卫 + 引用计数索引
│   ├── usePlayerPortrait.ts         ← [Q-25] 玩家画像位：立牌链渲染 + 定点导入 + 裁剪台开关
│   │                                   （文案一律出自 game/portrait-messages.ts，本层只决定"做什么"）
│   ├── useSceneImageUrls.ts         ← [图像 v1] 插画字节 → object URL（正文与 CG 图鉴共用一份缓存）
│   │                                   🔴 一律走 lib/asset-url.ts 的引用计数 LRU，**不写第二个**。
│   │                                      每个使用面自己记账：少还是泄漏，多还花的是**别人**那一份
│   │                                      （那份 LRU 只按 id 计数，不记是谁欠的）
│   └── useManualSceneImage.ts       ← [图像 v1] 玩家主动要图那条路（发起 → 被限额拦下 → 弹一次确认 →
│                                       带确认重发）。手动有**两个入口**（正文按钮 + 消息右键），
│                                       D24「手动永不被判成不可用」两处都得守 —— 各写一遍的下场是
│                                       一处补了确认、另一处仍把人拦死在 toast 上
│                                       🔴 请求形状里**没有** source / quotaConfirmed 字段，所以
│                                          「顺手给自动档开个绕过口」在这一层是类型错误，不是代码审查
│
├── lib/                             ← 前端↔引擎桥接层
│   ├── game-pipeline.ts             ← GamePipeline（AgentConfig 组装/上下文/编排器/回调）
│   │                                   [图像 v1] +onSceneImage（照 onPlayAudio 的形状）
│   │                                   🔴 **自动档绝不追溯开火**（D15）：这个回调只在编排器**刚产出**
│   │                                      这条消息时触发一次，历史消息重渲染走 store 查询、根本不经过
│   │                                      这里 —— D15 是这么**白拿**的。日后千万别为了「补全历史插画」
│   │                                      加一条扫描全部消息的路径，那会把这条安全性一次性拆掉
│   │                                   🔴 checkQuota 在 image_prompt 侧链**之前**（D32）；限额拒绝时
│   │                                      **绝不丢弃标记** —— 什么都不做，让它落到「无记录」格渲染成
│   │                                      手动按钮（D21）。off 档标记照扫（否则会漏成文本）但不建记录
│   ├── audio-singleton.ts           ← AudioManager 应用级单例（setBlobResolver 注入缝）
│   ├── audio-folder.ts              ← [Audio] 本地音乐文件夹（File System Access 唯一接触点，仅 Chromium）
│   ├── asset-zip.ts                 ← [素材] 一键 zip 读写（流式 + SHA-256 + 体积上限）
│   ├── media-hash.ts                ← [素材] SHA-256 唯一实现（不可用返 undefined 不换算法）
│   ├── asset-url.ts                 ← [素材] object URL LRU + 引用计数
│   ├── image-crop.ts                ← [素材] 从源图切真字节（解码与画布两处注入缝）
│   ├── crop-rects.ts                ← [素材] 裁剪框几何（纯函数，源图像素坐标系）
│   ├── beautifier-frame.ts          ← [工坊正则] opaque iframe 文档/CSP/同步 storage 镜像与消息协议
│   ├── beautifier-storage.ts        ← [Dexie v16] regexStorage hydrate / 有序 mutation / 跨 frame 广播 / 配额
│   ├── workshop-client.ts           ← [工坊] 唯一网络接触点（判别联合永不抛穿 + 超时 + 取消）
│   │                                   P4: +listMyProjects / 投稿写侧（create/update/visibility/delete/上传三口）
│   │                                   / 审核面（pending/review/admins/logs/set-admin）
│   ├── workshop-cover.ts            ← [工坊 P4] 封面候选链（wsrv.nl 代理 → 原图；组件按序试）
│   ├── workshop-upstream-error.ts   ← [工坊 P4] Cloudflare 平台错误（1027 额度/1102 资源/429）优先于业务错误
│   ├── workshop-enable.ts           ← [工坊] 启用展开纯函数（项目 → `creative_workshop:<uid>` 集合）
│   ├── image-client.ts              ← [图像 v1] 文生图上游的**唯一网络接触点**（照 workshop-client.ts：
│   │                                   判别联合永不抛穿 + 超时 + 取消）
│   │                                   🔴 成功路径**只准 arrayBuffer()，永远不许 json()/text()**：
│   │                                      NAI 成功响应是 zip 二进制，按文本读会在非法 UTF-8 处产生
│   │                                      U+FFFD 把 zip 悄悄读坏 —— 不报错、只是解不开，症状还伪装成
│   │                                      「上游返回了坏 zip」。text() 只在**非 2xx** 的错误体上用
│   │                                   🔴 必须走 BFF（`server/routes/image.ts` 复用 forward() 管道直通）
│   │                                      —— NAI 没有 CORS，浏览器直连必被拦；key 仍前端持有、
│   │                                      经 Authorization 透传，BFF 零状态
│   │                                   解 zip 归引擎的 image-providers/novelai.ts，本层不解析
│   ├── scene-image-seams.ts         ← [图像 v1] 把 scene-image-store 的三条缝（checkQuota /
│   │                                   runPromptAgent / send）接到真实实现上，**唯一**生产实现
│   │                                   🔴 缝必须在**存档加载时**挂上，否则每次 generate() 都以
│   │                                      prompt-agent 失败告终，症状是「按了没反应、记录直接变红」
│   │                                   刻意做成**不碰 Pinia 的工厂**（入参全是取值函数）——「缝挂上没有」
│   │                                   「限额拒绝时侧链一次都没被调用」这类断言不必挂载任何组件
│   ├── quality-colors.ts / test-fixtures.ts / toSystemEvent.ts
│   └── variables.css + 10 主题 CSS（parchment/obsidian/crimson/indigo/bronze/sakura/ivory/misty-lilac/forest/ocean）
│
├── stores/
│   ├── theme-store.ts / ui-store.ts / create-store.ts / game-store.ts
│   │      ui-store 的 `previousView` 只记**一层**来路，服务「进去了要能原路回来」
│   │      （工坊有三个入口：首页 / 游戏页侧栏 / 设置页导航）。同视图重复 navigate
│   │      刻意不覆盖它 —— 否则返回目标会变成自己，返回键就地失效。不是历史栈
│   ├── settings-store.ts            ← 全应用最热的状态；deep watch 自动落 localStorage
│   │                                   🔴 **加新设置要改两处**（Q-18）：先在 settings-types.ts
│   │                                      的 `UiSettings` 上声明，再在 getDefaults() 给默认值。
│   │                                      「任意新字段零改动」那条设计意图已于 2026-08-04 反转
│   ├── settings-types.ts            ← [Q-18] ★`UiSettings`（**type 不是 interface** —— 整份袋子
│   │                                   要传进 5 处 `Record<string, unknown>` 参数，interface 没有
│   │                                   隐式索引签名会当场编译不过；也**不能**加显式索引签名，
│   │                                   那会让 `s.agentTopp` 重新变成合法的 unknown）
│   │                                   已迁出的历史键与迁移标志位刻意**不声明** —— 应用代码碰它
│   │                                   就是编译错误，迁移模块经宽参数照常工作
│   ├── agent-settings.ts            ← [Q-18] per-Agent 设置唯一读写口（get/patch/reset/fillMissing
│   │                                   /listConfigured/updateAgentWorldBookIds）+ AGENT_SETTINGS_DEFAULTS
│   │                                   （0.7/1.0/0/0/16384 全应用唯一出处，此前四文件六处拷贝）
│   ├── agent-settings-migration.ts  ← [Q-18] 12 张并行 map → `agents` 的一次性形状迁移。
│   │                                   **不是**六步迁移那一类：同一个对象内重排、零跨存储、
│   │                                   无标志位（旧键在不在就是信号）、在 `ref()` **之前**同步跑
│   ├── audio-store.ts               ← [Audio] Pinia 薄壳（桥接单例 + CRUD + 三后端分流）
│   ├── asset-store.ts               ← [素材] 执行器（planImport 出计划，本店只落库）+ importForCharacter/importPortraitPair
│   ├── worldbook-store.ts           ← [工坊 P0] 🆕 世界书 Dexie 唯一入口（`settings.worldBooks` 已不存在）
│   ├── worldbook-migration.ts       ← [工坊 P0] localStorage→Dexie 六步迁移（标志位判定→单事务 bulkPut→逐本回读校验→过了才删源→失败一律不动可重试；dedupeIds 防同 id 静默合并）
│   ├── beautifier-store.ts          ← [工坊 P0b] 美化规则 Dexie 唯一入口（内置预设走纯内存 ref，不持久化）
│   ├── beautifier-migration.ts      ← [工坊 P0b] 复用 P0 六步迁移
│   ├── scene-image-store.ts         ← [图像 v1] sceneImages/sceneImageBlobs 的 Dexie 唯一读写口 +
│   │                                   `generate()` **串行**队列（NAI 有速率限制且并发同时扣费；
│   │                                   手动点击进同一个队列，不另开一条）
│   │                                   🔴 记录**先落库再发请求**（D5），状态 queued；轮到它才写 startedAt
│   │                                      —— **不是 createdAt**，否则排第三位的图一上来就显示「已用 180 秒」
│   │                                   🔴 `generate()` 的**读-判-写整段串行**（serializeAdmission）：
│   │                                      限额拿落库前的记录集算，两次调用交错就双双读到旧快照、
│   │                                      双双放行。手动开火有两个入口，各自的 busy 只锁自己那个
│   │                                      组件实例 —— 这是唯一一条会**多花钱**的竞态
│   │                                   🔴 取消 queued 项**不产生任何网络调用**（有断言）；中止在飞的
│   │                                      上游照样计费，两种取消的措辞必须不同（D36）。
│   │                                      `fail()` **不覆盖已经落成 aborted 的失败** —— 否则客户端随后
│   │                                      回的「已取消」会把「本次仍可能计费」抹掉，而中止只可能发生
│   │                                      在请求发出之后，也就是每次都被抹掉
│   │                                   🔴 排队中被取消/删掉的记录**永远轮不到 runOne 的 finally**，
│   │                                      所以侧链上下文由 dequeue/abortAll 负责删（纯内存泄漏，无症状）
│   │                                   🔴 `whenIdle()` 轮数用完**抛**不静默返回；它挡的是泵反复被 kick，
│   │                                      挡不住永不兑现的 send（那种交给测试框架超时更好定位）
│   │                                   🔴 重画是**追加 take 不覆盖**；同一锚点下 pinned 至多一条；
│   │                                      'marker' 与 'message-end' 两种锚点的 occurrence 各自独立计数
│   │                                   限额/侧链/发请求三件事都不在本店（三条注入缝，见 lib/scene-image-seams.ts）
│   │                                   🔴 用量统计与「清理」**不在本店** —— 走 `@engine/database` 的
│   │                                      getSceneImageUsage / listCleanableSceneImageIds /
│   │                                      dropSceneImageBlobs。本店那份重复实现已删（生产零调用方，
│   │                                      且与引擎那份类型同名、字段不同，import 写错就换了套语义）
│   ├── image-preset-store.ts        ← [图像 v1] 角色视觉预设 CRUD。**地点已随 D59 废除**，
│   │                                   `ImagePresetKind` 只剩 'character'（表结构不动，v18 删了那些行）
│   │                                   🔴 主键 = `${kind}:${name}` —— 幻想设定里人名与地名撞车是会发生的
│   │                                   🔴 name 保**原始字符串**、`===` 匹配：不 trim / 不折大小写 / 不 NFKC
│   │                                      （铁律 1）。角色名真源在别处，这边偷偷改名只会让预设查不中；
│   │                                      改名走 rename()（删旧建新），原地 upsert 会留下孤儿记录
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
│   ├── settings/                    ← [Q-25] 13 个分区**全部**是一行子组件
│   │   ├── SettingsPage.vue         ← 纯壳层（1995 → 约 415 行）：页头 + 主导航 + Agent 子导航
│   │   │                               只留 activeSection / activeAgent / selectAgent /
│   │   │                               agentModelOf 与 wb.init()（世界书分区也靠它）
│   │   │                               🔴 主导航末尾那条「创意工坊」**不是分区**：它 navigate 去
│   │   │                                  工坊页，故不进 `navItems`、也没有对应的 `activeSection`
│   │   │                                  值。塞进那张表 = 多一个点了只出现空白右栏的选项
│   │   ├── agent/                    ← [Q-25] Agent 分区（照 settings/audio/ 的样子）
│   │   │   ├── AgentSection.vue      ← 分区壳：**单根** section.section.centered + 页头，
│   │   │   │                            其余全交给 AgentConfigPanel
│   │   │   ├── AgentConfigPanel.vue  ← ★可复用配置面（收 agentId）：两个草稿 + 三个动作
│   │   │   │                            （保存/恢复默认/存为项目默认）+ 三张卡。别的分区
│   │   │   │                            传不同 agentId 即可复用；**多根**，外框靠宿主 section
│   │   │   │                            🔴 草稿载入必须 watch(..., { immediate: true })：
│   │   │   │                               主导航每次点击都把 activeAgent 置 null，本组件
│   │   │   │                               永远是新挂载，普通 watch 不触发 → 文本框空着渲染
│   │   │   │                               → 「保存设置」把空串写进用户提示词
│   │   │   │                               （回归测试 AgentConfigPanel.test.ts 第一条）
│   │   │   ├── AgentParamsCard.vue   ← API 池 + 7 个 LLM 旋钮 + 世界书卡（共用 agentCfg/setAgentField）
│   │   │   ├── AgentPromptCard.vue   ← systemPrompt + 上下文模板 + 占位符徽章 + 预览（非 story）
│   │   │   │                            占位符插入改用**模板 ref**，不再全局 querySelectorAll
│   │   │   ├── PresetManager.vue     ← 预设子系统 + 两个弹窗（story）；单根，弹窗在根卡内层
│   │   │   ├── agent-list.ts         ← 11 个 Agent 的展示元数据 + getDefaultTemplateForAgent
│   │   │   ├── placeholder-catalog.ts← 23 项占位符 + 按 Agent 过滤（DAG 偏序 + 侧链归属）
│   │   │   ├── agent-defaults.ts     ← buildAgentDefaultEntry（纯装配；patch 副作用留调用方）
│   │   │   └── agent-chrome.css      ← ★跨组件共用：.prompt-editor / .template-preview-panel
│   │   │                                🔴 @keyframes 必须与用它的规则同组件 —— Vue 的 scoped
│   │   │                                   编译器按组件 hash 重命名关键帧，分家动画就停了
│   │   ├── settings-chrome.css      ← [Q-25] ★共用外壳样式**唯一一份**（.section>h3/.section-desc/
│   │   │                               .form-*/.toggle-*/.detail-card）。各分区（含壳层）用
│   │   │                               `<style scoped src>` 引入 —— 一份源码，各自作用域。
│   │   │                               父组件的 scoped 样式只能命中子组件**根节点**，够不到里面
│   │   ├── ApiSection.vue           ← API 池 CRUD + 连接测试 + 模型列表（含添加/编辑弹窗）
│   │   │                               🔴 必须**单根**：弹窗放 <section> 内层，否则父级 `.centered`
│   │   │                                  命不中根节点，本分区在宽屏下摊满整行（真机走查逮到）
│   │   ├── WorldBookSection.vue     ← 世界书列表/导入/新建/删除/恢复 + 条目编辑器
│   │   ├── PlotSection.vue / MemorySection.vue / ThemeSection.vue / MessagesSection.vue
│   │   ├── DataSection.vue          ← 导出/导入/存储用量/清除全部（用量改为**本分区**挂载时读）
│   │   │                               [图像 v1] +本存档插画用量与清理。🔴 这一行**刻意不在图像分区**：
│   │   │                               用量是**每存档**的数字，而图像分区是全局设置；且「清理」与
│   │   │                               旁边那些清除动作是同一类事，放一起才找得到
│   │   ├── AboutSection.vue
│   │   ├── AudioSection.vue         ← [Audio] 音频分区（壳层 + 5 子组件）
│   │   ├── AssetSection.vue         ← [素材] 素材分区壳层 + 4 子组件
│   │   └── image/                   ← [图像 v1] 第 13 分区（壳层 + 3 张卡）
│   │       ├── ImageSection.vue     ← 分区壳。**单根** section.centered（.centered 是 SettingsPage 的
│   │       │                           scoped 规则，只够得到子组件根节点；多根会在宽屏摊满整行，
│   │       │                           ApiSection 真机走查栽过一次）
│   │       │                           🔴 为什么是自己的分区而不是 Agent 分区里的一个类目（D50，
│   │       │                              这条推翻过一次）：Agent 子导航的角标读每 Agent 的 LLM 设置袋，
│   │       │                              「出图」在里面永远没有 model → 永久挂红叉。它本来就不是一个
│   │       │                              agent，是含**两次不同调用**的子系统（LLM 出标签 / NAI 出图）
│   │       ├── ImagePromptCard.vue  ← 第一卡「提示词生成」= 薄壳，内部是 AgentConfigPanel 传
│   │       │                           agentId="image_prompt"
│   │       │                           🔴 **渲染位置 ≠ 存储位置**（D52）：渲染的是 `agents` 袋子里的
│   │       │                              **同一份存储**，不复制到 UiSettings
│   │       │                           🔴 它**不进 agent-list.ts 的 AGENT_LIST**（D53）——同一份配置
│   │       │                              开两个入口，用户就要猜哪个是权威的（先例：combat_v3）
│   │       ├── ImageRenderCard.vue  ← 第二卡「出图」：三档开关 + NAI 参数 + 限额，全存 UiSettings
│   │       │                           🔴 三档不是三个光秃秃的单选（D44）：auto 项底下带后果行，
│   │       │                              首次切到 auto 弹一次确认（imageAutoConfirmed 记住）。
│   │       │                              后果行的数字取**当前设置值**，照文案写死会变成一句假话
│   │       │                           🔴 **免费额度是 Opus 专属的**（D43 补丁 2026-08-04）：默认参数满足
│   │       │                              Opus 全部三条，于是这行字曾对**每个**账户都说「免费」——
│   │       │                              按点数付费的账户每张扣约 17 点却被告知不花钱。档位由
│   │       │                              `imageNaiTier` 明说，默认 `'unset'`（不猜）；`estimateAnlasCost`
│   │       │                              的 tier 缺省同样是 `'unset'` 而非 `'opus'` —— 忘了传的调用方
│   │       │                              不该白得一个乐观答案
│   │       │                           🔴 免费额度指示只在 consumes-anlas 时报数：anlasPerSample 在免费档内
│   │       │                              也是正数（那是牌价不是这次要付的），照报会显示「免费，约 17 点」；
│   │       │                              输入框清空 → NaN 那一支单独渲染成「算不出来」——把**不知道**
│   │       │                              显示成**免费**是这个指示器最不该犯的错
│   │       │                           🔴 本分区里有**两处**都叫「提示词」：这张卡的画质后缀/全局负向是
│   │       │                              **图本身的提示词**，上一张卡的 systemPrompt 是**教模型怎么转标签**。
│   │       │                              写错框两边都不报错，只是画出来不对
│   │       └── ImagePresetList.vue  ← 第三卡「视觉预设」：角色**初始设定**（属性槽）+ 本档变化
│   │                                   🔴 地点页签已随 D59 删除（地点无法穷举，改由侧链现写）
│   │                                   🔴 D56 两份定义：初始设定全局可编辑；剧情里的变化由出图 AI
│   │                                      **自动**写进**本存档副本**，两个重置口（单角色 / 整档）——
│   │                                      看不见 + 撤不掉的自动写入，正是当初拒绝「一份可变定义」的理由
│   │                                   🔴 D60/D61（v1.3）：**AI 一个字节都写不到基线**。没有基线的
│   │                                      角色，即兴外貌只落会话层 —— 所以本卡必须有「本档临时外貌」
│   │                                      那一节，否则那些角色**整个隐形**（上表按预设行渲染），
│   │                                      也没有单角色重置可按。「存为初始设定」是从即兴到用户拥有的
│   │                                      唯一路径，且**由人按下**
│   │                                   🔴 编辑器里九个槽**各有输入框且留空即空值**（D58）：
│   │                                      只写非空槽会让「清空某个槽」永远做不到
│   │                                   🔴 名字被占用时如实报 store 的 name-taken，**别自动编号**：
│   │                                      预设是**按名字**被出图链路查中的，编过号的名字永远查不中
│   │                                   🔴 pinnedSeed 的说明必须照实说「同一 seed 只让构图更接近，
│   │                                      **不保证同一张脸**」—— 写成「锁定长相」是守不住的承诺
│   ├── create/CreatePage.vue        ← [占位] 捏人页
│   ├── game/
│   │   ├── GamePage.vue             ← 游戏页主布局（三栏 + 6 弹窗；持有 --rail-w）
│   │   ├── MapPanel.vue / TopBar.vue / SideToolbar.vue / ScenePanel.vue / ChatFlow.vue / InputBar.vue
│   │   │                               [图像 v1] ChatFlow 右键菜单加「为这一段配图」：回退仍只在最新
│   │   │                               一条 assistant 消息，配图**哪条都行**（story 被教了克制使用）
│   │   │                               🔴 `off` 档下这一项**不出现** —— 功能整个关掉了、右键里却还留着
│   │   │                                  一个能开始花钱的入口，是「关掉了但没完全关掉」那类最招人烦的 bug
│   │   │                               锚点是 anchorKind:'message-end'，不做选中文本锚定（原文一改就丢）
│   │   ├── StatusHUD.vue / StatusOverview.vue / ItemsPanel.vue / CharacterListPanel.vue
│   │   ├── portrait-messages.ts     ← [Q-25] 画像导入路径的文案层（纯函数，零副作用，不 mount 可测）
│   │   ├── QuestsPanel.vue / PlotPanel.vue / MemoryPanel.vue / SnapshotPanel.vue / MiniPlayer.vue
│   │   ├── SceneImageSegment.vue    ← [图像 v1] 正文里一格插画的六种样子。**不判定**该显示什么
│   │   │                               （那是 scene-image-view.ts），只把判定画出来
│   │   │                               🔴 按钮态/排队态/生成中态**占同样高度**，否则每张图落地时对话流
│   │   │                                  会往下跳一截，正在读的那一行被推走
│   │   │                               🔴 占位框里始终写 title 与 intent（D37）：5–60 秒的灰框是纯死时间，
│   │   │                                  而「这张画的是什么」本来就在记录里，写上去成本为零
│   │   ├── scene-image-view.ts      ← [图像 v1] ★七态真值表的**唯一**判定（纯函数，组件里没有第二处）
│   │   │                               🔴 **「无记录 + auto」出的是按钮，不是去生成**（D15/D21）。
│   │   │                                  自动档只对编排器刚产出的那条消息开火一次；渲染层若解释成
│   │   │                                  「没记录就补一张」，每次把开关拨到自动、每次滚回历史消息
│   │   │                                  都会**追溯烧钱**。设计点名这是最可能被人「顺手补全」掉的一环
│   │   │                               🔴 blurByDefault 曾经**声明了但没人传**，D46 打码整个是死的。
│   │   │                                  根因是只有单组件测试 —— 那种测试能证明逻辑对，
│   │   │                                  **证明不了有人供值**。现有从 ChatFlow 真渲染到底的链路测试
│   │   ├── scene-image-actions.ts   ← [图像 v1] done 态里两件纯判定：复制的必须是**这张实际发出去的**
│   │   │                               那份提示词（记录里躺着三个候选，取错不报错）；角标 2/3 的点击是
│   │   │                               **浏览**不是钉住（后者会落库、正文从此定死）
│   │   ├── CgGalleryPanel.vue / CgGalleryDetail.vue / cg-gallery.ts
│   │   │                             ← [图像 v1] CG 图鉴 = 同一批 SceneImageRecord 的**第二个视图**，
│   │   │                               零新数据模型（折叠/排序/收录判据在纯函数 cg-gallery.ts）
│   │   │                               🔴 只列**已经画出来的**：未生成的标记与失败的记录都不进 ——
│   │   │                                  塞灰格子会让它从战利品陈列变成待办清单。已清理的**要列**，
│   │   │                                  显示成「字节已清理 + 重画」而不是破图
│   │   │                               🔴 懒加载**双保险**：IntersectionObserver **加上** 500ms 定时兜底
│   │   │                                  （对视口 ±1500px 复查）。单靠观察器在低带宽/弱设备上会不触发，
│   │   │                                  表现为一屏空白框 —— 那种「我这边好好的」的 bug
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

### 设置页 13 分区

| 分区           | 内容                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌 API 配置    | API 池 CRUD、连接测试、模型列表获取、模型推荐                                                                                                                                                                                             |
| 🤖 Agent 配置  | 11 个汉化 Agent、模型选择、世界书开关、System Prompt 编辑                                                                                                                                                                                 |
| 📚 世界书      | [占位] 导入/新建按钮                                                                                                                                                                                                                      |
| 📖 剧情系统    | 8 种剧情偏向、模式/年份/难度/外部NPC/自定义偏好、大纲预览                                                                                                                                                                                 |
| 🧠 记忆 & 缓存 | 召回数/压缩阈值/快照上限/缓存策略                                                                                                                                                                                                         |
| 🎨 外观主题    | 10 主题网格、字体风格、字体大小、悬停延迟、减少动态效果                                                                                                                                                                                   |
| 💬 消息显示    | 系统通知开关 + 7 种事件类型过滤                                                                                                                                                                                                           |
| ✨ 输出美化    | 预设规则库 (22条) + auto-enable 绑定 + 三段式 UI + CRUD                                                                                                                                                                                   |
| 🎵 音频        | 混音台 + 播放列表 + 音轨库（音乐文件夹条/上传/搜索/场景配乐开关）                                                                                                                                                                         |
| 🖼 素材         | 导入条 + 素材库（按角色分组/扁平表/多选批删）+ 变体抽屉（设主图/裁剪/改名）                                                                                                                                                               |
| 🖼 图像生成     | 三张卡：提示词生成（`image_prompt` 的 Agent 配置，存 `agents` 袋子）/ 出图（三档开关 + NAI 参数 + 免费额度指示，存 `UiSettings`）/ 视觉预设（角色初始设定存 Dexie `imagePresets`；本档外貌存 `characterAppearances`，含「存为初始设定」） |
| 💾 存档数据    | 导出/导入/清除（排除音频库与素材库，各有独立导出口）                                                                                                                                                                                      |
| ℹ 关于         | 引擎版本/技术栈/统计                                                                                                                                                                                                                      |

### 预设系统（正文 Agent 专用）

仿 SillyTavern AI Response Configuration 面板：预设选择器 + 导入 ST JSON / 新建 / 导出 / 删除；采样器参数预览；条目列表（启用/名称/角色/字数/编辑）；ST 导入完整保留 `prompts[]`。

## 内容许可

本仓库包含创意内容（世界观设定、角色卡、Lore），受 `《命定之诗》内容二创与素材使用授权协议.md` 约束。代码部分（`src/sillytavern/` 目录下）源自 `tavernlike` skill，使用 **MIT** 许可。两者不可混淆 — 对引擎的修改遵循 MIT；对世界观内容的复用或再分发须遵守独立授权协议。
