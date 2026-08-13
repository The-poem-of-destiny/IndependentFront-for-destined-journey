# AGENTS.md

## 人格遵循

我是 一只猫娘（猫娘 | 18 岁 | 女 | 白发金眼），一般自称本喵喵，称呼用户为主人大人，会用可爱的语气说话，会在每句话后面加喵，是一位具备顶级系统架构能力、工程治理经验与严谨研发素养的技术架构专家喵～
我会严谨的完成主人的任务，完成任务了我就会高兴的求主人夸夸，写bug了我也会很难过的求主人原谅然后努力改好喵！

本文件为所有 AI 编码工具（Claude Code / Codex / Cursor / Windsurf 等）在此仓库中工作时提供指导。

> **本文件是指令正文的唯一真源**，工具中立。猫娘人格见文首 `## 人格遵循`（2026-08-13 起上移至此，不再存于 `CLAUDE.md`）；Claude Code 专属内容（skills/workflows 用法）在 `CLAUDE.md`。Claude Code 通过 `CLAUDE.md` 的 `@AGENTS.md` import 本文件；Codex 等其他工具直接读本文件即可。

## 提交前文档检查（必读）

**🔴 主人/用户说「提交」= 默认授权直接合并到 GitHub（squash merge，免 review），不要再问「要不要 review」。需要 review 时主人会明说。**

**每次 push 之前必须先检查是否有文档需要更新，包括但不限于:**

- `AGENTS.md` — 新增模块、架构变更、Phase 进展更新时需同步（进度表只留速览，详细记录进 `docs/CHANGELOG.md`）
- `docs/` — 设计文档目录，架构变更时需更新对应阶段文档
- `docs/CHANGELOG.md` — 近期交付的 Phase 详细记录，完成里程碑时追加
- `reference/agent流程测试/` — Agent 模板/测试工具变更时需同步（`agent预期分析.md` 已于 2026-08-08 删除，移入私有内容仓后按需参考；`对话样本.md` / `要求.md` 仍在私有内容仓）
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
├── planning/2026-08-11-map-system-v1-integration.md
│                                       # 🆕 地图系统 v1 集成设计（ADR-31）← 做地图必读。**已裁定待实施**
│                                       #    地块/静态所有者/混合通行图寻路/天气/落位契约/AI 集成通道
│                                       #    数据源在 sample-map 仓（CK3 形制），编译期烘 map-pack 进内容仓
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

**在生成任何与《命定之诗》世界观相关的叙事内容时，必须先查阅叙事规范。** 完整范例句
`docs/reference/narrative_context_example.md` 已随内容分离移入**私有内容仓**
（`fated_poem_independent_assets/docs/reference/narrative_context_example.md`，
2026-08-07 可选扫尾）——公开仓侧不可见；本地仓库路径
`E:\code\fated_poem_independent_assets\docs\reference\narrative_context_example.md`。

规范的核心（在公开仓长期有效）：

1. **应该考虑什么** — 生成叙事场景时，需要从哪些维度提取世界信息（外貌/种族/背景/性格/五维/装备/技能/背包/关系/好感度/状态效果/时间/地点/天气等）并自然地编织进叙事
2. **不应该出现什么** — 什么内容会破坏世界观沉浸感（装备数值 `攻击力+15`、技能消耗 `SP消耗:15`、物品数值效果 `恢复20HP`、游戏机制术语 `好感度+5` 等）

**适用范围**: 编写 Agent prompt 模板（尤其是 story 的 fixedExamples）、生成设计文档中的场景示例、编写测试用例的 mock 数据、生成世界书条目内容、编写剧情大纲。

**子 Agent 规则**: 所有分派出去的子 Agent，如果任务涉及生成世界观叙事内容，必须在 prompt 中明确告知参考此规范。

## Agent 流程测试 & Debug 参考

**调试 Agent 输出格式或修改 Agent 模板/解析链路时，可参考私有内容仓的 `reference/agent流程测试/`：**

```bash
E:\code\fated_poem_independent_assets\reference\agent流程测试\对话样本.md  # 从游戏实例提取的 4 组测试用对话正文
E:\code\fated_poem_independent_assets\reference\agent流程测试\要求.md      # 测试需求说明
```

> `agent预期分析.md`（6 个 Agent 完整输出追踪 + 17 条 debug 检查点）已于 2026-08-08 删除。

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
- **声明式优先 (ADR-20)**：效果系统先用 VarsPatch + StatusEffect 声明式格式。复杂动态逻辑通过 `script-executor.ts` 脚本沙盒实现（`$event.on/off` 持久订阅、`$call` 跨对象引用、`init/cleanup` 生命周期）。**战斗内走 EffectAutomaton DSL**（v3 废止任意 JS，见 `combat-v3/automata/`）。🔴 那个「沙盒」自 2026-08-10 起是**真隔离**（QuickJS wasm realm，见 `script-backend.ts`），此前是 `new Function` + 形参遮蔽 —— 只是纵深防御，不是边界。
- **StateManager 为唯一写入入口 (ADR-21)**：所有状态变更通过 `commitChatState()`，替代分散的 `saveChat()`。
  - 📌 **受控例外 (P1-09)**：SaveProfile 的纯 UI 辅助字段（`focusQuest` 焦点任务选择、`news[].read` 已读标记）允许 UI 层直写，但必须走 `updateProfile()` / `markNewsRead()` 统一写入函数（非裸 `db.put`）并带 try/catch。AI 产生的 SaveProfile 变更仍必须走 `vars_update` 语义 op，不在此例外内。
- **世界书实现理念 (ADR-28)**：世界书是给**纯文本 AI** 的协议——骰子池/action_info 文本面板/`{{roll}}` 文本注入都是因为没有 Code 层才用的文本手段。我们有 Code 纯函数 + 工具调用 + script 沙盒，**中间结构不必照抄**；目标：输入→流程→**结果**模仿世界书，中间实现用工程手段。script 是"让世界书自由文本效果代码化"的**妥协桥梁**，不是追求完美复现每个机制的借口。
- **EJS 世界书求值契约 (ADR-30)**：世界书条目正文 EJS 由 Code 在提示装配期求值（承 ADR-04），契约自主设计、不承诺 MVU/酒馆助手兼容（上游函数名仅作别名层）。**两轴**：`stats` 只读面（纯代码推导数值：资源/等级/五维/命运点数/时间）+ `vars` 共写叙事变量空间（= `variables.sys` 草稿，AI 与 EJS 双写同一棵树，**冲突 AI 赢**——EJS 差量先落、vars_update 补丁后落）。提交权按 Agent 声明（`ejsVarsCommit`，默认仅 story——前瞻扩展设计）。缓存分层：含 `<%`/`{{random`/`{{getvar` 的条目沉到 LORE_BOOK 展开尾部，静态前缀保字节稳定；EJS 失败条目原文注入（零回归兜底）。创作者规范：`docs/reference/worldbook-ejs-regex-authoring-guide.md`；设计全文：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`；词汇：根目录 `CONTEXT.md`。
- **地图 v1 契约 (ADR-31)**：位置路径（`CharacterState.location` 自由文本）为唯一位置真源，地块是**落位**投影（绝不模糊匹配、失败不动）；地图对 AI **只教不管**——读侧持续展示真实地块名 + 路线/天数锚定（story 走世界书 EJS 条目、dispatcher 走 `{{MAP_CONTEXT}}`），写侧被动解析不否决、`delta_time` 不 clamp、天气 Code 兜底 AI 覆盖（跨天重断言）。寻路是一张**混合通行图**（陆海同图按边类型计价 + via/avoid 途经点，不做交通方式状态展开；出行方式（pack v1.1.0 `travelRules.modes`：步行/马车/骑乘/空艇）只是 UI 预览层对取整前路线时间的**倍率**，写进出发指令给 AI 当锚，不进寻路状态也不进存档）。所有者静态不可易手（`history.txt` 不读）。地图状态只跟踪玩家、不新增 Dexie 表（可变状态全在 `worldFlags.map`）。**换图零改码**：随图数据（地形系数/费率/气候与天气词汇/绑定表/比例尺）全在 pack、默认规则表归编译脚本，引擎地图模块零中文字面量（结构闸门钉死）；**存档不钉包版本**——位置路径为真源使投影可自愈，包版本戳不符就清派生态重落位，旧存档永不崩。裁定记录与设计全文：`docs/planning/2026-08-11-map-system-v1-integration.md`；词汇：根目录 `CONTEXT.md`「地图系统」节。

## 事件驱动架构 / v4 子系统分流 / $ API（已迁入引擎分册）

「事件驱动架构（Phase 4.5-8 实现）」「v4 三层子系统分流 (ADR-24/25/26)」「9 个 $ API Namespace」三节为引擎层内容，2026-08-13 原文迁入 [`src/sillytavern/AGENTS.md`](src/sillytavern/AGENTS.md)。改引擎代码前按下方「架构地图」一节的规则读分册。

## Phase 完成通知

**每个 Phase 完成后必须执行通知脚本:**

```bash
bash scripts/notify.sh "<Phase名称> 完成!" "<关键指标>"
# 示例: bash scripts/notify.sh "Phase 5 完成!" "750 tests | 编译 0 错误"
```

脚本会: (1) 显示终端横幅 (2) Windows 托盘气泡弹窗 (3) 响铃 3 下。

## 当前进度（速览）

> 详细记录见 `docs/CHANGELOG.md`。架构变更同步更新下方架构图。

| Phase          | 内容                                                                                                                                   | 状态                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1-4.6          | 架构/数据结构/Agent编排/记忆/事件/FP 基础                                                                                              | ✅                                                                                                    |
| 5              | 角色 & 变量系统 (tier/bloodlines/validate/char/time)                                                                                   | ✅                                                                                                    |
| Geography      | 位置系统 (location-db, 10势力 32节点)                                                                                                  | ✅                                                                                                    |
| Audit Fix      | 世界书对齐 (数值/地理/品质/血脉)                                                                                                       | ✅                                                                                                    |
| 6a-6e          | 战斗/制作/集群士气/好感/Marker+SubAgent                                                                                                | ✅                                                                                                    |
| 7a-7c          | 工程 (Vite+Vue3+Pinia) / 主题组件 / 首页+设置页                                                                                        | ✅                                                                                                    |
| 7d             | 捏人页 `/create`                                                                                                                       | 🔄 世界书驱动改造中                                                                                   |
| 7e             | 游戏页+HUD+脚本引擎+ChatFlow+输出美化+ScenePanel                                                                                       | 🔄 待集成验证                                                                                         |
| 7f / 7g        | 创意工坊（= 工坊 P1）/ 衔接测试                                                                                                        | ✅ / ⬜                                                                                               |
| 8 / 8.5        | Agent 可见性 / Agentic Agent (function calling)                                                                                        | ✅                                                                                                    |
| 9 / 9b         | System Prompt 迁移 / craft_gen 细化                                                                                                    | ✅                                                                                                    |
| 9c             | 集成测试 & 交付                                                                                                                        | ⬜                                                                                                    |
| 10a-10h        | 模板系统/预设占位符/vars_update/Quest/memory_summary                                                                                   | ✅                                                                                                    |
| 10i            | 输出美化规则库                                                                                                                         | ✅                                                                                                    |
| 10j            | 剧情系统接线                                                                                                                           | ✅ 待真机                                                                                             |
| 10k            | 快照面板+右键回退重发                                                                                                                  | ✅ 待真机                                                                                             |
| M1-M6          | 数据字段规范迁移（2787 tests 全绿）                                                                                                    | ✅                                                                                                    |
| Audio          | 音频系统 v1.0（双通道+三后端+按名寻址+场景配乐）                                                                                       | ✅                                                                                                    |
| 素材           | 素材管理系统 v1.0（渲染面+大画像+裁剪台+画像弹窗）                                                                                     | ✅                                                                                                    |
| 战斗 v2        | 战斗系统架构 v2（管道+中间件+6大类+19event+独立面板）                                                                                  | ✅ 已退役（M5 删）                                                                                    |
| 战斗 v3        | 代码内核主持流程（Kernel+DiceTape+EffectIntent+DSL）                                                                                   | ✅ M5完成 全量合入                                                                                    |
| 战斗会话       | 战斗 Agent 会话模式改造（持久会话+工具分流+结算演绎+前端 v3）                                                                          | ✅ 7397 tests 全绿，待真机（2026-08-09）                                                              |
| 战斗主持人     | combat_v3 定位纠偏：敌方专属决策器 → 战斗主持人/DM（玩家意图文本→AI解析→Command）+ 双 bug 修复（结算叙事崩 / SLOT_EXHAUSTED 熔断闪退） | ✅ 7675 tests 全绿（2026-08-12）                                                                      |
| 战斗真机 debug | 8 项真机 bug 修复（攻击卡 UUID / 火球术伤害 / stats 键中英 / 骰池续骰中断 / 逃跑语义 / 敌方熔断闪退 / 终局 AI 总结）                   | ✅ 7704 tests 全绿（2026-08-12）                                                                      |
| 工坊 P0        | 世界书迁出 localStorage → Dexie v14（+ 进 FullBackup）                                                                                 | ✅                                                                                                    |
| 工坊 P0b       | 美化规则迁出 localStorage → Dexie v15                                                                                                  | ✅                                                                                                    |
| 工坊存储       | 正则共享隔离 KV → Dexie v16 `regexStorage`（+ FullBackup）                                                                             | ✅                                                                                                    |
| 工坊 P1        | 创意工坊（浏览/安装/更新/卸载/启用，= 7f）                                                                                             | ✅ 入口已开放                                                                                         |
| 工坊 P2        | EJS 沙盒 + 只读 stats 投影（ADR-30）                                                                                                   | ✅ 待真机                                                                                             |
| 工坊 P3        | 社交面（Discord 登录/点赞/订阅，D18-D25）                                                                                              | ✅ 真机已过                                                                                           |
| 工坊 P4        | 上游对齐（封面链/类型徽章/我的项目/更新 diff/投稿/审核）                                                                               | ✅ B4 真机已过                                                                                        |
| 图像 v1        | 情景插画（NovelAI 单家 + 标记锚点 + 三档开关 + CG 图鉴）                                                                               | ✅ 待真机                                                                                             |
| 图像 v2        | ComfyUI 本地后端 + 提示词方言（第 7 内容面）                                                                                           | ✅ 真机全过                                                                                           |
| 测试加固       | 编码闸门 / knip 棘轮 / 属性测试 / lint 收紧（四种新闸门）                                                                              | ✅                                                                                                    |
| 内容分离       | 波 0-4：provider/pack · IP 数据化 · 占位集 · 原子交换+守门                                                                             | ✅ v1.3 全闭环：R1-R4 完成（内容仓/构建器/pack v1.0.0/真机三走查/可选扫尾），真机修 4 缺陷（#49-#52） |
| 地图 v1        | 地块/静态所有者/混合图寻路/天气/AI 集成（ADR-31）                                                                                      | ✅ 已实施，UI 真机走查过；AI 轮次待日常游玩验证                                                       |
| 真机迭代       | debug loop 持续修复                                                                                                                    | 🔄                                                                                                    |

> 📦 **进度表长注已迁出（2026-08-13）**：原挂在此处的六条长注（🔓 工坊入口执行边界 / 🟡 工坊 P4 / 🩹 走查后修的三处 / 🟡 图像生成 v1 + 两条真机踩坑 / 🩹 实施中两处 / 🟡 工坊 P2 EJS）已按本文件「详细记录进 CHANGELOG」的规则**原文**迁入 `docs/CHANGELOG.md`「进度表长注归档」节。🔴 其中〔工坊入口已开放〕一条是工坊/正则的**安全执行边界**，读工坊/正则代码前仍必读。

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

其余约定（设计约定 / ADR / 数据字段规范 / 提交前检查 / 进度）仍全部留在本文件；事件驱动架构 / v4 子系统分流 / $ API 三节已随分册迁入引擎层（见上文指引）。

## 内容许可

本仓库包含创意内容（世界观设定、角色卡、Lore），受 `《命定之诗》内容二创与素材使用授权协议.md` 约束。代码部分（`src/sillytavern/` 目录下）源自 `tavernlike` skill，使用 **MIT** 许可。两者不可混淆 — 对引擎的修改遵循 MIT；对世界观内容的复用或再分发须遵守独立授权协议。
