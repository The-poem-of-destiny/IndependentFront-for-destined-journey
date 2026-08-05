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

> ✅ **2026-08-05 起这条已自动化**：`tests/encoding-invariants.test.ts` 把上面三条判据变成了 CI 断言，
> 扫 `data/` 与 `src|server|tests|scripts` 源码（`reference/` 不扫——上游语料自带坏字）。
> 它还多扫一遍**解析后的 JSON 值**：合法转义写出来的退格源码干净、`JSON.parse` 也不报错，
> 但落进字符串值里仍是真退格。上线当天就在 `ejs-backend-parity.test.ts` 逮到两个真 0x08。
> **手工命令仍建议在改完当场跑一次**（比等 CI 快），但漏跑不再等于漏网。

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
npm run lint           # ESLint 闸门（--max-warnings 0：一条 warning 都会挂红）
npm run lint:fix       # 同上 + 自动修（会自动删未引用导入）
npm run knip           # 死代码原始报告（人看的）
npm run knip:ratchet   # 死代码棘轮闸门（CI 跑这个：只许变少不许变多）
npm run knip:update    # 清理完死代码后收紧 knip-baseline.json
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
| 测试加固  | 编码闸门 / knip 棘轮 / 属性测试 / lint 收紧（四种新闸门）  | ✅                  |
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
> 🩹 **游玩链路真机第一轮逮到的（2026-08-05）**：出图端点那格 Base URL 是**自由文本**，一格连坑两轮，而**两次报错都指着无辜的地方** —— 填成 `https://api.novelai.net`（NAI 的**文本/账户**域）时，那台机器上 `/ai/generate-image` 还活着（所以是 400 不是 404）但模型枚举停在 V3，于是它对一个完全合法的 `nai-diffusion-4-5-full` 回 **「model must be a valid enum value」**，看起来像模型名写错；改对域名却漏掉 `https://` 时，BFF 的 `forward()` 回 **「invalid X-Target-Base-URL」**，看起来像 header 坏了。裁定：**出图地址由代码持有，用户只填令牌** —— `scene-image-seams` 不再读 `endpoint.baseUrl`，API 配置里出图端点的「主链接」与「模型」两格直接隐藏（`isImageEntry`）。`image-client` 仍收 `baseUrl`（自建镜像/测试替身）并新增 `resolveImageBaseUrl`：补协议、剃掉 BFF 自己会拼的 `/ai/generate-image`、文本域**只报错不改写**。同一轮还确认「弹回首页」不可能是组件异常 —— 全仓没有任何程序化跳首页的路径，`currentView` 初值就是 `home` 且只活在内存里，所以那是**整页重载**（待再现时取证）。
>
> 🩹 **实施中逮到的两处**：① `blurByDefault`（D46 打码）**声明了但没人传**，整条功能是死的 —— 根因是只有单组件测试，那种测试能证明逻辑对、**证明不了有人供值**，现已补从 ChatFlow 真渲染到底的链路测试。② `data/defaults/agent-config.json` 里有 **47 个 U+FFFD 坏字符**（16 段 / 6 个 agent），其中一处落在闭合 XML 标签的标签名里 —— **既有问题，本轮未修**，已另开任务。
>
> 🟡 **工坊 P2 已实施（T1-T6），真机走查未做**：世界书条目正文的 EJS 现在**会在提示装配期求值**（ADR-30 两轴契约：只读 `stats` + 共写 `vars`，冲突 AI 赢；动态条目沉底、静态前缀字节稳定）。全语料冒烟 509 条目 / 61 动态 / **0 回退**（能力面别名层落地后 7 → 0，白名单已清空；语料门现按 **Legacy 与 QuickJS 双后端**各自跑双向白名单，基线一致），回退条目原文注入不阻断。代码位内嵌的 ST 值宏（`{{roll}}`/`{{random::}}`）已在编译期降成沙盒调用（`rewriteCodeMacros`），uid 358 出列。回退率 / 缓存命中字节 / 跨回合链尚未真机验证，设计全文见 `docs/planning/2026-07-31-workshop-phase2-ejs-design.md`。

## 架构地图（已拆分为分册 —— 必读指引）

两份最大的架构地图已从本文件拆出，各自放到它所描述的代码目录里。**内容一字未改，只是换了位置**：

| 分册                     | 覆盖范围                                                                                  | 位置                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 引擎层架构（已实现部分） | `src/sillytavern/**` —— 类型/数据库/Agent 编排/战斗/制作/效果系统/图像生成等全部引擎模块  | [`src/sillytavern/AGENTS.md`](src/sillytavern/AGENTS.md) |
| 前端架构 (Phase 7)       | `src/ui/**` —— composables / lib 桥接层 / stores / components / 设置页 13 分区 / 预设系统 | [`src/ui/AGENTS.md`](src/ui/AGENTS.md)                   |

拆分理由：这两份地图加起来约 4.4 万字，占本文件六成，但**只在改对应目录的代码时才用得上**；
留在根文件里会让每一次会话（哪怕只改文档）都付它们的上下文成本。

### 🔴 各工具怎么读

- **Codex / Cursor / Windsurf 等只读根 `AGENTS.md` 的工具**：本文件**不再包含**这两份地图。
  动 `src/sillytavern/` 或 `src/ui/` 下任何文件之前，**必须先手动读取对应的分册**（路径见上表）。
  漏读的症状不是报错，是照着不存在的约定改代码 —— 那两份地图里全是「这么写不报错但是错的」这类硬约束。
- **Claude Code**：分册同目录各有一个 `CLAUDE.md` 薄壳（`@AGENTS.md` 导入），
  会在读写该目录下的文件时自动加载，无需手动读取。

其余约定（设计约定 / ADR / 事件驱动架构 / 数据字段规范 / 提交前检查 / 进度）仍全部留在本文件。

## 内容许可

本仓库包含创意内容（世界观设定、角色卡、Lore），受 `《命定之诗》内容二创与素材使用授权协议.md` 约束。代码部分（`src/sillytavern/` 目录下）源自 `tavernlike` skill，使用 **MIT** 许可。两者不可混淆 — 对引擎的修改遵循 MIT；对世界观内容的复用或再分发须遵守独立授权协议。
