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
- **私有内容仓**的 `reference/agent流程测试/`（🔴 公开仓侧不存在，路径只在私有内容仓 `fated_poem_independent_assets` 里）— Agent 模板/测试工具变更时需同步（`对话样本.md` / `要求.md` 仍在，`agent预期分析.md` 已于 2026-08-08 删除）

**如果忘了更新，push 之前主人会提醒。但是 agent 应该主动检查。**

**每次向远程仓库 push 后，必须主动检查对应的 GitHub Actions CI 状态；CI 失败时读取失败日志、定位根因并修复，不得只报告 push 成功。**

### 🔴 文档维护守则（2026-08-18 全仓文档普查后立）

> 那次普查（138 份 .md 逐条对码）发现的不是「文档没人写」，而是**六种固定的腐烂模式**。
> 以下每条对着一种模式；写文档/交付系统时照做，就不用再做一次全仓普查。

1. **状态头随实施走，同一个提交里改。** 系统合入时，其设计文档的状态行必须同步改成
   「已实施（日期）+ 真机状态」。腐烂样本：图像 v1 挂着「设计定稿，未实施」、地图 v1 挂着
   「已裁定待实施」各跑了一两周 —— 正文一直有人更新，只有状态行没人碰。
2. **正文优先加带日期的更正注记，不改写历史。** 只有「本身就是现状快照」的文档
   （current_state / 导航树 / README / 进度表）才允许整段重写。老化得最好的文档
   全是在正文就地补「📌 2026-08-x 此条已推翻/已落地」的那批；老化得最差的是
   状态行撒谎但正文没留任何日期锚点的那批。
3. **价值已交付就归档。** plan / RFC / handoff 的退出通道是 `docs/archive/`
   （按原路径镜像，规则见 `docs/archive/README.md`），归档的同一个提交里把仓内引用改指新址。
   **不归档**：设计契约真源（被本文必读清单或源码注释引用的）、在办工作、
   审查报告（`docs/reviews/` 是它们自己的存档地，不进 archive/）。
4. **导航树与磁盘一一对应。** 新增必读文档 → 本文导航树同步加行；归档/移动/退役 → 同步改行。
   普查里最险的一条毒指针就在导航树：v2 战斗文档退役两周后仍标着「战斗相关必读」，
   而 v3 真源根本不在树上 —— 文档各自的自述横幅都是对的，误导完全来自导航。
5. **数字要么当场实测，要么写量级。** 写进文档的计数必须当场从代码/命令数出来并标日期
   （「2026-08-18 实测」），不许从其他文档抄，也不许从**源码头部注释**抄 ——
   普查发现 tool 数（17→27）、占位符数（18→31）、测试数三处，文档 / 代码注释 / 旧文档
   三个来源各自陈旧且互相矛盾。拿不准就写量级（「~30 张表」），别写会过期的精确值。
6. **审查报告落地即建修复状态闭环表，修复逐条回写。** 仍未修的 P0/P1 必须在报告
   老化前晋升到 `docs/known-issue.md` / `TODO.md` —— UI-01 那条 P0（禁用装备可选中）
   曾在唯一一份没有闭环表的审查里静默躺了 6 天。

### 🟢 纯文档改动可以直推 master（免 PR）

**只改 `.md` 的提交允许直接推 master，不必开 PR。** 代码（`src/` `server/` `tests/` `scripts/` 配置文件）仍按 `docs/planning/2026-07-31-repo-management.md` §2 走分支 + PR。

**🔴 但直推之前必须先跑 Prettier**，否则 CI 的 `format:check` 会在 master 上挂红：

```bash
npx prettier --write <你改过的每一个 .md>
```

两条细则：

1. **只 `--write` 你真正改过的文件**。理由已不再是行尾（`.prettierrc` 的 `endOfLine: "auto"` 落地后，
   格式化不会再重写行尾），而是**避免无关 churn** —— 仓库级 `npm run format` 会把几百个与本次改动
   无关的文件卷进同一个提交，淹掉真正要看的那几行。
2. **写完之后再格式化**。先格式化再编辑等于没格式化 —— CI 跑在 Linux/LF 检出上，它是权威闸门。

> ✅ **本地 `npm run format:check` 现在可信**：`endOfLine: "auto"` 之前它在 Windows 上把 776/776 个文件
> 全报成未格式化（纯假红，唯一的信息量是「你在 Windows 上」），只能靠 CI 兜底。现在本地红就是真的红。

推完照样要检查 CI（上一条规则对直推同样生效）。

### 🔴 改中文文本之后必须验编码（每次，别凭肉眼）

本仓大量文件是中文：提示词（`public/data/defaults/agent-config.json`）、世界书、设计文档。
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
> 扫 `public/data/` 与 `src|server|tests|scripts` 源码（`reference/` 不扫——上游语料自带坏字）。
> 🔴 **磁盘路径是 `public/data/`，运行期 URL 仍是 `/data/*`** —— 别看着 URL 就去仓库根找 `data/`，
> 根目录那个 `data/`（真实内容临时驻留区）已被 `.gitignore` 整树排除、公开仓侧不存在。
> 它还多扫一遍**解析后的 JSON 值**：合法转义写出来的退格源码干净、`JSON.parse` 也不报错，
> 但落进字符串值里仍是真退格。上线当天就在 `ejs-backend-parity.test.ts` 逮到两个真 0x08。
> **手工命令仍建议在改完当场跑一次**（比等 CI 快），但漏跑不再等于漏网 ——
> 注意这道自动闸门只覆盖**公开仓侧**（`public/data/` 占位集 + 源码树）；
> 私有内容仓里那份真实提示词/世界书不在扫描范围内，改那边仍然只能靠手工命令。
> 🔴 **`docs/` 也不在自动扫描范围内** —— 批量改 docs/ 中文后必须跑手工命令。
> 唯一豁免：`docs/reference/dev-bat-notes.md` 第 36 行附近有 **4 个刻意保留的 U+FFFD**
> （引用当年 findstr 乱码 stderr 的原文证据，2026-08-18 核准）；数量不是 4 才是新损伤。

> 配套的一条纪律：在脚本里拼这些转义时，用**原始字符串**或 `chr(92)` 拼，
> 别在多层引号里堆反斜杠。2026-08-05 那轮就是这样先写坏了 JSON、又写坏了正则；
> 连本节初稿都栽在同一处 —— 描述这个坑的那两个例子自己被转义吃掉了。

## 文档导航

**发布前待办清单在根目录 [`TODO.md`](TODO.md)**（8 条：Mac 兼容 / 正式打包 / 配乐 / 远程素材 /
远程内容包（探索）/ 主题打磨 / 多分辨率 / 移动端）。做完一条就把它搬进 `docs/CHANGELOG.md`，
已知缺陷记进 `docs/known-issue.md`，别在三处并存。

详细设计文档统一在 `docs/` 目录下：

```bash
docs/
├── fated-poem-engine-prd.md     # 🆕 项目 PRD（产品需求文档，必读）
├── ARCHITECTURE.md              # 现行软件架构总览（2026-08-18 重写，只写层与层之间的形状）
│                                #    + 世界观架构。一层内部的模块清单归两份分册，不在这里重复；
│                                #    2026-06 旧版归档于 archive/ARCHITECTURE-2026-06.md
├── CHANGELOG.md                 # 🆕 变更记录（近期 Phase 详细记录，append-only）
├── known-issue.md               # 🆕 已知缺陷（有现象、有根因分析的那种）← TODO.md 指定的缺陷归属地
├── project-introduction.md      # 项目介绍（对外说明用）
├── design.md                    # 前端设计规范（详见下节「前端 UI 设计规范（必读）」）
├── archive/                     # 🆕 已归档历史文档（价值已交付的 plan/RFC/handoff 与被新版取代的旧文档）
│                                #    按原路径镜像（docs/planning/X → docs/archive/planning/X）；
│                                #    详见 archive/README.md。归档件只作历史脉络参考，别当现行约定
├── reviews/                     # 历次代码审查存档（7 份，含修复状态闭环表）
├── superpowers/specs/           # 数据字段规范 + 实体字段审计（详见下节「游戏数据字段规范（必读）」）
├── planning/                    # 现行设计文档 + 在办计划（已交付的 plan/RFC/handoff 见 archive/planning/）
├── phases/                      # Phase 计划（仅存仍在用的两个阶段，其余已归档）
│   ├── phase7d/                 # Phase 7d 捏人页架构/现状/差距分析
│   └── phase8/                  # Phase 8 Agent 上下文可见性
│       └── phase8_plan.md       # Agent 可见性模型 + 世界书分区 + 预设系统
├── reference/                   # 参考文档
│   ├── effect_script_system.md         # 词条效果 & 脚本系统架构（引擎必读）
│   ├── combat-system-architecture-v3.md
│   │                                   # 🆕 战斗系统架构 v3（战斗相关必读 —— 现行真源）
│   ├── combat-system-architecture.md   # 战斗系统架构 v2 —— **已退役（2026-08-01）**；只剩
│   │                                   #    §四/§五/§八/§九（效果系统 / Buff 状态 / 8 步伤害管线 /
│   │                                   #    核心数值）这些纯计算公式仍被 v3 引用，作公式参考
│   │                                   #    🔴 v2 的 combat-agent-api.md 已归档到 archive/reference/；
│   │                                   #      现行 combat_v3 契约散在三处：`agent-config.json`
│   │                                   #      （`combat_v3` 条目）+ `src/sillytavern/agent-tools.ts`
│   │                                   #      （AGENT_TOOL_MAP）+ `combat-v3/projection-agent.ts`
│   ├── agent_system_prompt_guide.md    # 🆕 Agent System Prompt 配置流程（架构/步骤/踩坑/检查清单）
│   ├── agent_template_guide.md         # Agent 占位符模板系统修改指南（改占位符/解析链路先查这份）
│   ├── debug-loop-handbook.md          # 🆕 游玩→导出→分析→修复 调试循环操作手册（每次发现 bug 必读）
│   ├── audio_system.md                 # 🆕 音频系统 v1.0 说明书 ← 改音频必读
│   ├── worldbook-ejs-regex-authoring-guide.md
│   │                                   # 🆕 世界书 EJS + 输出美化正则创作者规范（作者入口）
│   ├── story_preset_format.md           # 🆕 Story Agent 预设编写指南（输出标签顺序 + 占位符排列 + 可用宏）
│   ├── system_card_spec.md             # 系统事件卡片视觉规格（写 `components/game/cards/*.vue` 时参照）
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
├── planning/2026-07-31-workshop-phase2-ejs-design.md
│                                       # 工坊 Phase 2 EJS 沙盒 + 只读 stats 投影（ADR-30 的**设计历史**）
│                                       #    🔴 部分内容已被 QuickJS 能力面取代（收窄 stats / `new Function`
│                                       #      边界 / 不支持 await 三处描述作废，见上面那份能力面设计）
│                                       #    现行**创作者契约**在 reference/worldbook-ejs-regex-authoring-guide.md
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
├── planning/2026-08-08-comfyui-image-provider-design.md
│                                       # 🆕 图像生成 v2（ComfyUI 本地后端 + 提示词方言，C1-C16）
│                                       #    ← 改图像 provider 必读。**接续 v1 的 D 编号线**：C 号与 D 号不冲突，
│                                       #      v1 的裁定除本文明确推翻处一律继续有效
├── planning/2026-08-05-content-engine-separation-design.md
│                                       # 🆕 内容-引擎分离设计 v1.2 ← 改内容包/分节必读
│                                       #    **内容包（content pack）格式契约的真源**：公开仓只带占位内容，
│                                       #    真实内容由私有仓构建成 pack 导入
├── planning/2026-08-11-map-system-v1-integration.md
│                                       # 🆕 地图系统 v1 集成设计（ADR-31）← 做地图必读。
│                                       #    **✅ 已实施（2026-08-12），UI 真机走查过**
│                                       #    地块/静态所有者/混合通行图寻路/天气/落位契约/AI 集成通道
│                                       #    数据源在 sample-map 仓（CK3 形制），编译期烘 map-pack 进内容仓
├── planning/2026-08-15-random-event-system-design.md
│                                       # 🆕 随机事件系统 v1 设计（ADR-32）← 改随机事件必读
│                                       #    Code 端种子化 MTTH 调度出候选池 → `{{RANDOM_EVENTS}}` 单通道注入
│                                       #    story → AI 以 `<event_trigger>` 回执 → Code 按名字结算
│                                       #    事件定义 = 内容包第 13 分节纯 JSON；开关与剧情系统彼此独立
├── planning/2026-08-20-api-rpm-limiter-design.md
│                                       # 🆕 API 凭据级 RPM 限流设计 ← 改 API 请求发送/限流/等待提示必读
│                                       #    同端点 + Key 全请求面共桶；达限暂停 60 秒 + 全局倒计时 + 自动续行
├── planning/2026-08-22-llm-assembly-delta-architecture-scratch.md
│                                       # 🆕 LLM 组装层 Delta 会话架构 ← 改主 DAG prompt 组装/缓存会话必读
├── planning/2026-08-22-llm-assembly-delta-implementation-plan.md
│                                       # Delta 会话 T0-T5 实施顺序、跨环境交接与验收计划
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

**🔴 三份设计文档分工不同，别混着读**（找错地方的症状是照着一份「记录」当「规范」改代码）：

- `docs/design.md` — **排版 / 间距 / 组件 / token 基线，唯一硬规范（必读）**。写 UI 代码前看这份。
- 根目录 `DESIGN.md` — **主题视觉方向 + 已批准的主题识别决策记录**（英文）。里面的数值是首轮迭代默认值、
  不是铁律：主人反馈、主题识别、文字可读性与实际渲染结果一律优先于它。
- `docs/archive/design-qa.md` — **主题实施后的 QA 证据存档**（逐次走查记录，按日期追加；2026-08-18 已归档）。
  它记的是「那一次走查的结果」，不是任何人要遵循的约定。

## 游戏数据字段规范（必读）

**涉及游戏数据实体（角色/物品/技能/状态效果/任务/存档/快照/变量）的字段定义、StatePatch 契约、AI 输出格式、翻译层（orchestrator/侧链 buildPatches）的任何改动，必须先查阅：**

```bash
docs/superpowers/specs/2026-07-16-data-field-conventions-design.md  # 数据字典规范 v1.0（五条铁律 + 13 实体章 + SSOT 总表 + M1-M6 迁移批次）
docs/superpowers/specs/2026-07-16-entity-field-audit.md             # 52 项现状偏差审计归档
```

核心铁律速记：逻辑键=名字（AI 永不产 id）· 名字解析唯一入口 · AI 填叙事字段 Code 补账务字段 · 每类数据唯一真源 · 枚举中文集中定义（field-enums.ts）。新增实体照规范附录 C 模板补一章。

## 世界观数据参考（必读）

**涉及所有游戏内部改动（数值/地理/种族/品质/战斗/制作/剧情/角色/物品/技能等）时，必须先查阅世界书索引。**

🔴 **这两份资料已随内容分离移入私有内容仓 `fated_poem_independent_assets`，公开仓侧不可见**
（根 `reference/` 已被 `.gitignore` 整树排除）。本机路径：

```bash
E:\Projects\POD-IF\fated_poem_independent_assets\reference\world_book_index.md
                                 # 世界书条目索引（605 条目 → 主世界观/数值/地理/人物/DLC）← 游戏内改动必读
E:\Projects\POD-IF\fated_poem_independent_assets\reference\audit_report.md
                                 # 代码 vs 世界书冲突审计报告
```

> 没挂私有内容仓的环境（含 CI 与外部贡献者）读不到这两份 —— 此时不要盲改数值/世界观，
> 停下来问，或把改动限制在不依赖世界书裁定的范围内。`.claude/workflows/audit-code.js` 与
> PR 模板里对这两个文件的引用同样按此口径理解。

## 世界观叙事内容生成规范（必读）

**在生成任何与《命定之诗》世界观相关的叙事内容时，必须先查阅叙事规范。** 完整范例句
`docs/reference/narrative_context_example.md` 已随内容分离移入**私有内容仓**
（`fated_poem_independent_assets/docs/reference/narrative_context_example.md`，
2026-08-07 可选扫尾）——公开仓侧不可见；本机路径
`E:\Projects\POD-IF\fated_poem_independent_assets\docs\reference\narrative_context_example.md`。

规范的核心（在公开仓长期有效）：

1. **应该考虑什么** — 生成叙事场景时，需要从哪些维度提取世界信息（外貌/种族/背景/性格/五维/装备/技能/背包/关系/好感度/状态效果/时间/地点/天气等）并自然地编织进叙事
2. **不应该出现什么** — 什么内容会破坏世界观沉浸感（装备数值 `攻击力+15`、技能消耗 `SP消耗:15`、物品数值效果 `恢复20HP`、游戏机制术语 `好感度+5` 等）

**适用范围**: 编写 Agent prompt 模板（尤其是 story 的 fixedExamples）、生成设计文档中的场景示例、编写测试用例的 mock 数据、生成世界书条目内容、编写剧情大纲。

**子 Agent 规则**: 所有分派出去的子 Agent，如果任务涉及生成世界观叙事内容，必须在 prompt 中明确告知参考此规范。

## Agent 流程测试 & Debug 参考

**调试 Agent 输出格式或修改 Agent 模板/解析链路时，可参考私有内容仓的 `reference/agent流程测试/`：**

```bash
E:\Projects\POD-IF\fated_poem_independent_assets\reference\agent流程测试\对话样本.md  # 从游戏实例提取的 4 组测试用对话正文
E:\Projects\POD-IF\fated_poem_independent_assets\reference\agent流程测试\要求.md      # 测试需求说明
```

> `agent预期分析.md`（6 个 Agent 完整输出追踪 + 17 条 debug 检查点）已于 2026-08-08 删除。

## 前端 UI 参考（Phase 7 必读）

**写任何前端 UI 代码前，可先查阅以下参考页面。这些是从 v4.2.1 角色卡 CDN 爬取的原始前端，需用 Vanilla TS + HTML 重新实现:**

🔴 **这三份页面同样已移入私有内容仓 `fated_poem_independent_assets`，公开仓侧不可见。** 本机路径：

```bash
E:\Projects\POD-IF\fated_poem_independent_assets\reference\home_index.html
                                   # 首页 (94KB) — Vue 3 SPA, 标题画面/环境检测/用户协议/存档管理入口
E:\Projects\POD-IF\fated_poem_independent_assets\reference\custom_start_index.html
                                   # 捏人页 (341KB) — Vue 3 + Pinia + Router, 角色创建/属性分配/品质选择/装备技能
E:\Projects\POD-IF\fated_poem_independent_assets\reference\status_index.html
                                   # 状态栏 (477KB) — React + immer + gsap, 角色状态/资源条/Avatar/地图/详情面板
```

> 读不到原页面时，下面这份「参考页面架构摘要」与数值表就是公开仓侧的等效摘录，够用；
> 真正的现行前端约定在 [`src/ui/AGENTS.md`](src/ui/AGENTS.md) 与 `docs/design.md`，那两份才是必读。

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

**提交前的本地闸门集合 = `.github/workflows/ci.yml` 三个 job 的全部步骤**（注释里称「八道闸门」）。
一条条敲容易漏，所以有一键入口：

```bash
npm run gates          # 🔴 一键跑齐 CI 的全部闸门（types + quality + test 三组步骤）
                       # 本地只跑其中几条 = 把剩下的留给 CI 挂红，然后连环重推
```

`gates` 展开后就是下面这八条（按 ci.yml 的 job 顺序）：

```bash
# ── types job ──
npm run typecheck      # 仅类型检查，不输出文件 (tsc --noEmit)；主 tsconfig 只 include src/**
npm run typecheck:vue  # vue-tsc --noEmit —— .vue SFC 的类型网，裸 tsc 不解析 SFC，改 Vue 必跑
npm run typecheck:tools # tsc -p tsconfig.tools.json —— server/ tests/ *.config.ts 唯一的类型网
npm run build          # Vite 打包前端 → dist-ui/（顺带兜住 tsc 看不见的资源导入 / CSS url() / vite 插件报错）
# ── quality job ──
npm run format:check   # Prettier 闸门（CI 权威口径；本地只 --write 自己改过的文件，别跑仓库级 format）
npm run lint           # ESLint 闸门（--max-warnings 0：一条 warning 都会挂红）
npm run knip:ratchet   # 死代码棘轮闸门（CI 跑这个：只许变少不许变多）
# ── test job ──
npm run test:run       # 单次运行 Vitest 全量（= npm run test -- --run）
```

其余非闸门命令：

```bash
npm run build:engine   # 编译 TypeScript (tsc) → dist/（引擎产物；注意与上面的 build 不是一回事）
npm run test           # 运行 Vitest 测试套件（watch 模式）
npm run lint:fix       # lint + 自动修（会自动删未引用导入）
npm run knip           # 死代码原始报告（人看的）
npm run knip:update    # 清理完死代码后收紧 knip-baseline.json
npm run format         # ⚠️ 仓库级格式化，仍不建议随手跑：它会把几百个与本次改动无关的文件
                       #    一起重写，淹掉 diff。（`endOfLine: "auto"` 落地后已无行尾重写风险，
                       #    但「无关 churn」这条理由不变。）本地只 --write 自己改过的文件
npm run dev            # 开发服务器（自动杀残留进程 + 固定 5173 端口）
                       # 入口是 scripts/dev.mjs，按平台分发：Windows → dev.bat，
                       # macOS/Linux → dev.sh（行为一致，端口清理用 lsof）
                       # 🔴 改任一启动器前必读 docs/reference/dev-bat-notes.md ——
                       #    dev.bat 注释一律纯 ASCII（中文注释会让 cmd 把注释片段当命令执行）
                       #    且行尾必须 CRLF；dev.sh 反过来必须 LF（shebang 带 CR 会
                       #    报 bad interpreter）。两条都由根目录 .gitattributes 钉死
```

仓库根还有一个**不是 npm 脚本**的入口（玩家侧双击用，非开发流程）：

```bash
update.bat             # 一键更新（双击运行）：git fetch → git pull --ff-only →
                       # 仅当 package-lock.json 的 blob 哈希变了才 npm install →
                       # 打印最近 3 条提交并提示「关掉 dev.bat 窗口再重开」
                       # 不在 git 仓库（下载 zip）或无法快进（本地改过文件/历史分叉）时，
                       # 给中文指引后 pause 退出，不会静默合并或覆盖本地改动
                       # 🔴 与 dev.bat 同一条纪律：注释必须纯 ASCII（chcp 65001 会让
                       #    cmd 的字节偏移解析器错位，中文注释片段会被当命令执行）
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
- **分层方向只有一个：前端 → 引擎**（2026-08-17 收口）。`src/sillytavern/**` 里**禁止** import `../ui/*` / `@ui/*` / `vue` / `pinia`，**type-only 也算**。引擎要用前端的东西只有两条路：把它搬进引擎（先例：`media-hash.ts`、`types.ts` 的 `CreatePreset`），或开一条**注入缝**由前端往里装（现有四条：`engine-settings.ts` / `map-runtime.ts` / `random-event-runtime.ts` / `content-registry-runtime.ts`）。这条契约破坏时不报错 —— 反向 import 编译得过、测试全绿，代价是引擎从此拖着 Vue + Pinia + Dexie 整条前端链，headless 跑批与引擎单测都得把整个 store 拉起来。两道机器闸门钉死：`eslint.config.js` 的 `no-restricted-imports`（静态边）+ `tests/layering-gate.test.ts`（源码扫描，管动态 import / 字符串路径 / `import.meta.glob`；`?raw` 源码读取不算依赖边）。
- **StateManager 为唯一写入入口 (ADR-21)**：所有状态变更通过 `commitChatState()`，替代分散的 `saveChat()`。
  - 📌 **受控例外 (P1-09)**：SaveProfile 的纯 UI 辅助字段（`focusQuest` 焦点任务选择、`news[].read` 已读标记）允许由 UI 触发写入，但必须走 `persistFocusQuest()` / `persistNewsRead()` 这两个命名写入口（非裸 `db.put`、也不再是 UI 自己拼一份整档交出去）并带 try/catch（失败不致命，记日志即可）。🔴 **2026-08-17 起这两个入口串进 `withSaveWriteLock`（per-saveId 写队列）并在锁内重读一份新鲜 profile、只改那一个字段**：提交级缓存把 `commitChatState` 的写窗口拉成「整次提交一拍」，不进队列的 UI 写会被出口那次整档 flush 盖掉，而拿着 UI 手里那份陈旧整档进锁写回去又会反过来抹掉提交结果 —— 两件事缺一条都不算修好。AI 产生的 SaveProfile 变更仍必须走 `vars_update` 语义 op，不在此例外内。
- **世界书实现理念 (ADR-28)**：世界书是给**纯文本 AI** 的协议——骰子池/action_info 文本面板/`{{roll}}` 文本注入都是因为没有 Code 层才用的文本手段。我们有 Code 纯函数 + 工具调用 + script 沙盒，**中间结构不必照抄**；目标：输入→流程→**结果**模仿世界书，中间实现用工程手段。script 是"让世界书自由文本效果代码化"的**妥协桥梁**，不是追求完美复现每个机制的借口。
- **EJS 世界书求值契约 (ADR-30)**：世界书条目正文 EJS 由 Code 在提示装配期求值（承 ADR-04），契约自主设计、不承诺 MVU/酒馆助手兼容（上游函数名仅作别名层）。**两轴**：`stats` 只读面（纯代码推导数值：资源/等级/五维/命运点数/时间）+ `vars` 共写叙事变量空间（= `variables.sys` 草稿，AI 与 EJS 双写同一棵树，**冲突 AI 赢**——EJS 差量先落、vars_update 补丁后落）。提交权按 Agent 声明（`ejsVarsCommit`，默认仅 story——前瞻扩展设计）。缓存分层：含 `<%`/`{{random`/`{{getvar` 的条目沉到 LORE_BOOK 展开尾部，静态前缀保字节稳定；EJS 失败条目原文注入（零回归兜底）。创作者规范：`docs/reference/worldbook-ejs-regex-authoring-guide.md`；设计全文：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`；词汇：根目录 `CONTEXT.md`。
- **地图 v1 契约 (ADR-31)**：位置路径（`CharacterState.location` 自由文本）为唯一位置真源，地块是**落位**投影（绝不模糊匹配、失败不动）；地图对 AI **只教不管**——读侧持续展示真实地块名 + 路线/天数锚定（story 走世界书 EJS 条目、dispatcher 走 `{{MAP_CONTEXT}}`），写侧被动解析不否决、`delta_time` 不 clamp、天气 Code 兜底 AI 覆盖（跨天重断言）。寻路是一张**混合通行图**（陆海同图按边类型计价 + via/avoid 途经点，不做交通方式状态展开；出行方式（pack v1.1.0 `travelRules.modes`：步行/马车/骑乘/空艇）只是路线预览里给玩家看的**参考行**（各方式天数 = 取整前路线时间 × 倍率并排展示，不可选），不进出发指令、不进寻路状态也不进存档 —— 要坐什么玩家在输入框自己说）。所有者静态不可易手（`history.txt` 不读）。地图状态只跟踪玩家、不新增 Dexie 表（可变状态全在 `worldFlags.map`）。**换图零改码**：随图数据（地形系数/费率/气候与天气词汇/绑定表/比例尺）全在 pack、默认规则表归编译脚本，引擎地图模块零中文字面量（结构闸门钉死）；**存档不钉包版本**——位置路径为真源使投影可自愈，包版本戳不符就清派生态重落位，旧存档永不崩。裁定记录与设计全文：`docs/planning/2026-08-11-map-system-v1-integration.md`；词汇：根目录 `CONTEXT.md`「地图系统」节。
- **随机事件 v1 契约 (ADR-32)**：Code 端**种子化确定性调度**（每条事件独立 MTTH × 声明式权重链、`available` 硬门槛先于一切求值、全存档共享全局冷却、作者点名地点首访强制入池）逐天掷骰产出**候选池**（跨回合驻留，池满按 priority 淘汰、forced 免疫）→ 经 `{{RANDOM_EVENTS}}` 注入 story（**不新开 Agent**、不注给 dispatcher，单通道免双写；池空/关闭/**战斗会话活跃**时返空串零 token）→ AI 在叙事方便的时机至多演绎一条并以 `<event_trigger name="事件名"/>` 回执 → Code **按名字**结算（不在池中的名字 warn 忽略 / 清掉全部非 forced 候选 / 起全局冷却 / forced 触发时才记足迹）。**触发纯叙事零副作用**：v1 没有 `onTrigger` 效果表，状态变化由既有 dispatcher/vars_update 管线自然捕获，事件系统只记「触发过」这一事实。事件定义 = **内容包第 13 分节纯 JSON**（`randomEvents`，三态语义照旧、坏定义单条跳过不连坐；引擎侧只带零 IP 占位集）。每存档状态住 `worldFlags.randomEvents`（**事实不是派生态**，故与 `worldFlags.map` 相反：没有 packStamp 自愈清空，零新 Dexie 表、随 saveProfiles 进 FullBackup）。开关是**全局设置两字段**（`randomEventsEnabled` / `randomEventsFrequency`，经 `engine-settings.ts` 注入缝读），与剧情系统三个 Agent 的开关**彼此独立**——`plotMode === 'off'` 时调度/注入/回执三面照常。设计全文：`docs/planning/2026-08-15-random-event-system-design.md`；词汇：根目录 `CONTEXT.md`「随机事件系统」节。
- **地块事实与时间账本契约 (ADR-33)**：地图 v1.2 首次给地块引入**事实态**（AI 叙事产生的地块状态/发展度/建筑/编年史），住新命名空间 `worldFlags.mapFacts` —— 照 ADR-32 先例**永不随 packStamp 清空**（与派生态 `worldFlags.map` 的自愈语义**刻意相反**）、按**地块名**为键（换包名字消失只休眠不删、名字回来自动复活，休眠块时间冻结不结算）、零新 Dexie 表、随 saveProfiles 进 FullBackup。写侧对 ADR-026「无地图写 op」**收窄改判**：只开六个叙事事实 op（状态挂/除、建筑记/改、一次性进度、编年史附注），owner/terrain/adjacency/impassable 依旧零写 op；按名寻址解析失败 warn 忽略不否决。一切按期结算（状态到期/每月进度效果/每月产业收益）走**回合驱动时间账本**（`time-ledger.ts` 纯函数 + `applyTimeAdvance` 单钩子）：到期点从事实锚纯推导（零 lastSettled 簿记）、每事实独立 30 天锚、跨大步 `delta_time` 完整补结算带迭代上限；**永不建自走时钟**，天气/随机事件的既有时间逻辑本次不迁。发展度进度**零后台增长**（只被状态周期效果与一次性 op 推动）；降档按**严格槽位身份**摧毁最高号槽（玩家产业不豁免）。设计全文：`docs/planning/2026-08-18-map-tile-dynamics-v1.2-design.md`；词汇：根目录 `CONTEXT.md`「地图系统」节新增六词。

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

| Phase          | 内容                                                                                                                                                                 | 状态                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1-4.6          | 架构/数据结构/Agent编排/记忆/事件/FP 基础                                                                                                                            | ✅                                                                                                    |
| 5              | 角色 & 变量系统 (tier/bloodlines/validate/char/time)                                                                                                                 | ✅                                                                                                    |
| Geography      | 位置系统 (location-db, 10势力 32节点)                                                                                                                                | ✅                                                                                                    |
| Audit Fix      | 世界书对齐 (数值/地理/品质/血脉)                                                                                                                                     | ✅                                                                                                    |
| 6a-6e          | 战斗/制作/集群士气/好感/Marker+SubAgent                                                                                                                              | ✅                                                                                                    |
| 7a-7c          | 工程 (Vite+Vue3+Pinia) / 主题组件 / 首页+设置页                                                                                                                      | ✅                                                                                                    |
| 7d             | 捏人页 `/create`                                                                                                                                                     | 🔄 世界书驱动改造中                                                                                   |
| 7e             | 游戏页+HUD+脚本引擎+ChatFlow+输出美化+ScenePanel                                                                                                                     | 🔄 待集成验证                                                                                         |
| 7f / 7g        | 创意工坊（= 工坊 P1）/ 衔接测试                                                                                                                                      | ✅ / ⬜                                                                                               |
| 8 / 8.5        | Agent 可见性 / Agentic Agent (function calling)                                                                                                                      | ✅                                                                                                    |
| 9 / 9b         | System Prompt 迁移 / craft_gen 细化                                                                                                                                  | ✅                                                                                                    |
| 9c             | 集成测试 & 交付                                                                                                                                                      | ⬜                                                                                                    |
| 10a-10h        | 模板系统/预设占位符/vars_update/Quest/memory_summary                                                                                                                 | ✅                                                                                                    |
| 10i            | 输出美化规则库                                                                                                                                                       | ✅                                                                                                    |
| 10j            | 剧情系统接线                                                                                                                                                         | ✅ 待真机                                                                                             |
| 10k            | 快照面板+右键回退重发                                                                                                                                                | ✅ 待真机                                                                                             |
| M1-M6          | 数据字段规范迁移（2787 tests 全绿）                                                                                                                                  | ✅                                                                                                    |
| Audio          | 音频系统 v1.0（双通道+三后端+按名寻址+场景配乐）                                                                                                                     | ✅                                                                                                    |
| 素材           | 素材管理系统 v1.0（渲染面+大画像+裁剪台+画像弹窗）                                                                                                                   | ✅                                                                                                    |
| 战斗 v2        | 战斗系统架构 v2（管道+中间件+6大类+19event+独立面板）                                                                                                                | ✅ 已退役（M5 删）                                                                                    |
| 战斗 v3        | 代码内核主持流程（Kernel+DiceTape+EffectIntent+DSL）                                                                                                                 | ✅ M5完成 全量合入                                                                                    |
| 战斗会话       | 战斗 Agent 会话模式改造（持久会话+工具分流+结算演绎+前端 v3）                                                                                                        | ✅ 7397 tests 全绿，待真机（2026-08-09）                                                              |
| 战斗主持人     | combat_v3 定位纠偏：敌方专属决策器 → 战斗主持人/DM（玩家意图文本→AI解析→Command）+ 双 bug 修复（结算叙事崩 / SLOT_EXHAUSTED 熔断闪退）                               | ✅ 7675 tests 全绿（2026-08-12）                                                                      |
| 战斗真机 debug | 8 项真机 bug 修复（攻击卡 UUID / 火球术伤害 / stats 键中英 / 骰池续骰中断 / 逃跑语义 / 敌方熔断闪退 / 终局 AI 总结）                                                 | ✅ 7704 tests 全绿（2026-08-12）                                                                      |
| 工坊 P0        | 世界书迁出 localStorage → Dexie v14（+ 进 FullBackup）                                                                                                               | ✅                                                                                                    |
| 工坊 P0b       | 美化规则迁出 localStorage → Dexie v15                                                                                                                                | ✅                                                                                                    |
| 工坊存储       | 正则共享隔离 KV → Dexie v16 `regexStorage`（+ FullBackup）                                                                                                           | ✅                                                                                                    |
| 工坊 P1        | 创意工坊（浏览/安装/更新/卸载/启用，= 7f）                                                                                                                           | ✅ 入口已开放                                                                                         |
| 工坊 P2        | EJS 沙盒 + 只读 stats 投影（ADR-30）                                                                                                                                 | ✅ 待真机                                                                                             |
| 工坊 P3        | 社交面（Discord 登录/点赞/订阅，D18-D25）                                                                                                                            | ✅ 真机已过                                                                                           |
| 工坊 P4        | 上游对齐（封面链/类型徽章/我的项目/更新 diff/投稿/审核）                                                                                                             | ✅ B4 真机已过                                                                                        |
| 图像 v1        | 情景插画（NovelAI 单家 + 标记锚点 + 三档开关 + CG 图鉴）                                                                                                             | ✅ 待真机                                                                                             |
| 图像 v2        | ComfyUI 本地后端 + 提示词方言（第 7 内容面）                                                                                                                         | ✅ 真机全过                                                                                           |
| 测试加固       | 编码闸门 / knip 棘轮 / 属性测试 / lint 收紧（四种新闸门）                                                                                                            | ✅                                                                                                    |
| 内容分离       | 波 0-4：provider/pack · IP 数据化 · 占位集 · 原子交换+守门                                                                                                           | ✅ v1.3 全闭环：R1-R4 完成（内容仓/构建器/pack v1.0.0/真机三走查/可选扫尾），真机修 4 缺陷（#49-#52） |
| 地图 v1        | 地块/静态所有者/混合图寻路/天气/AI 集成（ADR-31）                                                                                                                    | ✅ 已实施，UI 真机走查过；AI 轮次待日常游玩验证                                                       |
| 存档互传       | 单存档导出/导入（依赖体检+自动配置）+ 整库导入确认 + memory id 跨档修复                                                                                              | ✅ 真机走查过（2026-08-15）                                                                           |
| 随机事件 v1    | MTTH+权重+首访+组装事件（Code 掷骰 AI 演绎，story marker 单通道）                                                                                                    | ✅ 待真机                                                                                             |
| 管线并行化     | 写队列地基（per-saveId FIFO + 记忆全局锁，修 3 个既有竞态）+ 4 层管线（dispatcher‖memory_summary、vars_update‖post_check）+ 侧链旁路化（LLM 并行、落库 barrier）     | ✅ 待真机（2026-08-16）                                                                               |
| Agent 重试     | 失败自动重试可配置（默认 3 遍，chat/chatStream 双路径 + abort 短路 + 流式清预览）+ 设置页旋钮 + 幽灵快照根因修复                                                     | ✅（2026-08-16）                                                                                      |
| API RPM 限流   | 全局按端点 + API Key 指纹配置；Chat / Embedding / NovelAI 共桶 FIFO，超限提示并于 60 秒后自动续发（ADR-34）                                                          | ✅ 已实施并走查设置页（2026-08-21）                                                                   |
| 远程素材 v1    | 世界书 + 内容包双载体目录（char-info 静态抽取 + 第 14 分节）→ 启动落地 / 哈希增量 / 镜像同步                                                                         | ✅ 真机核心链路已验（2026-08-17）                                                                     |
| 地图 v1.2      | 地块动态（状态/发展度/建筑/主建筑/编年史 + 时间账本 + 六语义 op，ADR-33）                                                                                            | ✅ 9030 tests 全绿，待真机（2026-08-18）                                                              |
| 任务系统完善   | reward 提示词（严格参照正文）/ 手动完成·删除（withSaveWriteLock 窄改）/ 分组排序（进行中优先+段内按优先级）                                                          | ✅（2026-08-24）                                                                                      |
| 经验系统 v2    | LevelXpTable 累计经验表迁移 + Code 接管升级（exp-table.ts）+ 登神长阶放宽版 + 战斗经验系数按档（修错用伤害系数）+ 简单/普通模式 + 旧档经验归一化（幂等只提升）       | ✅ 9223 tests 全绿（2026-08-24）                                                                      |
| 重铸系统       | 单条目重铸（item_gen replace 属性范式 + REWRITE_TARGET/REWRITE_REASON + remove/add 同事务）+ 主角/NPC 面板入口 + NPC 补背包 tab + 查看脚本升级（modifiers/automata） | ✅ 9248 tests 全绿（2026-08-24）                                                                      |
| 真机迭代       | debug loop 持续修复                                                                                                                                                  | 🔄                                                                                                    |

> 📦 **进度表长注已迁出（2026-08-13）**：原挂在此处的六条长注（🔓 工坊入口执行边界 / 🟡 工坊 P4 / 🩹 走查后修的三处 / 🟡 图像生成 v1 + 两条真机踩坑 / 🩹 实施中两处 / 🟡 工坊 P2 EJS）已按本文件「详细记录进 CHANGELOG」的规则**原文**迁入 `docs/CHANGELOG.md`「进度表长注归档」节。🔴 其中〔工坊入口已开放〕一条是工坊/正则的**安全执行边界**，读工坊/正则代码前仍必读。

## 架构地图（已拆分为分册 —— 必读指引）

两份最大的架构地图已从本文件拆出，各自放到它所描述的代码目录里。**内容一字未改，只是换了位置**：

| 分册                     | 覆盖范围                                                                                  | 位置                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 引擎层架构（已实现部分） | `src/sillytavern/**` —— 类型/数据库/Agent 编排/战斗/制作/效果系统/图像生成等全部引擎模块  | [`src/sillytavern/AGENTS.md`](src/sillytavern/AGENTS.md) |
| 前端架构 (Phase 7)       | `src/ui/**` —— composables / lib 桥接层 / stores / components / 设置页 14 分区 / 预设系统 | [`src/ui/AGENTS.md`](src/ui/AGENTS.md)                   |

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
