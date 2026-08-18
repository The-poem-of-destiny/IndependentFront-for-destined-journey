# 项目介绍

> 纯Vibe coding作品

---

## 一、这是什么？

**命定之诗独立前端**是一个独立的文字 RPG 引擎库，专为 AI Roleplay（AIRP）玩家设计。它以静态网站形式在本地运行，为用户提供基于大型世界观《命定之诗》的高质量 AI 叙事体验。

核心思路：**把"让 AI 同时做所有事"改成"让多个 AI 各司其职"**。

---

## 二、为什么要做这个项目？

现有的 AI 角色扮演前端（如 SillyTavern / 酒馆）基于**单 LLM 架构**——一个请求中同时塞入世界书、角色卡、对话历史、变量系统等全部上下文。当世界观规模庞大时（《命定之诗》量级的世界规则条目、多血脉种族、10 势力、T1-T7 七级层级体系）会导致严重问题：

| 问题       | 表现                                                   |
| ---------- | ------------------------------------------------------ |
| 任务干扰   | 记忆/剧情/变量/角色等任务与叙事混在同一请求，互相干扰  |
| 成本浪费   | 无法利用不同模型的成本差异（便宜的做总结，强的做叙事） |
| 数值不可靠 | 战斗/制作等确定性计算靠 Prompt 描述，结果不一致        |

本引擎的解决方案是 **多 Agent 协作架构**——将游戏流程拆分为 4 层 DAG 管线（层内多 Agent 并行），每层由独立 Agent 处理特定子任务。Code 层负责所有确定性计算（战斗伤害、制作 DC、数值约束），AI 层只负责创造性推理（叙事、角色、剧情）。

> 📦 **内容与引擎已分离（2026-08）**：本仓库（公开仓）随附的是**零 IP 占位集**（`public/data/content/`：
> 中性品牌面 / 占位地点与血脉 / 空地图图源），不含《命定之诗》的世界书条目、提示词与素材。
> 真实世界观内容住在**私有内容仓**，以**内容包（Content Pack）**形式在运行期挂载到引擎的内容注册表上。
> 因此下文提到的世界规则条数、种族与势力，描述的是内容包挂载后的完整体验，不是本仓库的自带数据。

---

## 三、核心架构

### 3.1 Agent 管线

2026-08-16 并行化重排后为 **4 层**（层内并行，`DEFAULT_AGENT_PIPELINE`）：

```
用户输入
  │
  ▼
Stage 0  记忆召回 (memory_recall)  ‖  剧情预检 (plot_pre_check)         ← 并行
  │
  ▼
Stage 1  正文生成 (story)  ──→  叙事正文 + 选项 + 变量 + <marker> 标记
  │
  ▼
Stage 2  请求调度 (request_dispatcher)  ‖  记忆总结 (memory_summary)    ← 并行
  │        └ 侧链旁路启动: char_gen → item_gen / craft_gen / image_prompt
  │          （LLM 调用并行，落库在回合末的 barrier 上汇合）
  ▼
Stage 3  变量更新 (vars_update)  ‖  剧情后检 (plot_post_check)          ← 并行
  │        （逐 Agent 依赖，互不连坐：vars_update ← dispatcher，
  │          plot_post_check ← memory_summary）
  ▼
返回叙事 → 前端渲染
```

管线里只有 `story` 是**必须成功**的 Agent（`requiredAgents`），其余任一层失败只跳过自己，不拖垮整回合。

### 3.2 四层代码架构

```
Layer 5  脚本级  Script Sandbox     AI 调用: $event.on/off(持久订阅) / $call(跨对象引用)
  ↑       (AI 可编程)
Layer 4  语义级  $ API              AI 调用: $combat.attack() / $craft.startProject()
  ↑       (AI 可见)
Layer 3  流程级  Resolver           引擎内部: CombatResolver / CraftResolver
  ↑       (AI 不可见)
Layer 2  计算级  纯函数             $dice.d20() / $resource.getHpPercent() / $char.getTier()
  ↑       (AI 可读，不可写)
Layer 1  原语级  状态读写           StateManager.commitChatState() / $validate.effectValue()
          (仅引擎内部)
```

**关键原则**：确定性逻辑（战斗伤害公式、制作品质链、骰池检定、数值约束）走 Code；创造性逻辑（叙事、角色、剧情判断）走 Prompt。AI 不碰数学，Code 不碰叙事。

> 📌 **复核 2026-08-18（分层仍在，载体已换）**：Layer 4 现在 AI 那一侧只有 OpenAI function calling 的
> 工具名，够不到 `$` 对象（脚本沙盒那份除外）；Layer 3 的 `CombatResolver` 随战斗 v2 编排层于 M5 删除，
> 战斗流程改由 combat-v3 内核主持，制作仍走 `CraftResolver`。「AI 声明意图、Code 执行公式」这条
> 语义分层（ADR-19）不变。

### 3.3 Marker Protocol（标记协议）

Story AI 通过 XML 标记与引擎通信，无需用户干预：

| 标记                | 含义       | 处理时机                               |
| ------------------- | ---------- | -------------------------------------- |
| `<craft_request/>`  | 制作请求   | Stage 1 阻塞 → Stage 2 执行            |
| `<combat_trigger/>` | 战斗触发   | Stage 1 延迟 → Stage 2 char_gen 后唤起 |
| `<char_detect/>`    | 新角色检测 | 异步后置，触发 char_gen 链             |

### 3.4 上下文缓存隔离

每 Agent 使用独立 DeepSeek userId（`fp|{saveId}|{agentId}`），Prompt 模板分为：

- **固定前缀**：system prompt + 示例 → 缓存命中关键
- **可变后缀**：动态上下文 + 变量 + 对话历史 → 每轮变化

### 3.5 Agentic Agent 系统

craft_gen / char_gen / item_gen 通过 OpenAI function calling 调用真实 Code 函数（骰子、随机表、库存查询、数值校验），杜绝 AI 编造数值。

---

## 四、已完成的内容

### 引擎核心

| 模块                | 说明                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| **类型系统**        | types.ts，4100+ 行，180 个导出接口/类型，唯一类型来源（大型联合类型拆 types-\*.ts 分册）                        |
| **数据库**          | Dexie/IndexedDB **v22，30 张表**（世界书/预设/对话/记忆/剧情/角色/快照与载荷/存档/音频/素材/工坊/插画/内容包…） |
| **Agent 编排引擎**  | DAG 管线，层间串行 + 层内并行 + 逐 Agent 依赖，侧链旁路化，Agentic 多轮工具循环                                 |
| **Agent 客户端**    | OpenAI 兼容协议，流式 SSE，失败自动重试（次数可配置）+ 指数退避，缓存命中检测                                   |
| **Prompt 模板系统** | **13 个 Agent** 全量迁入 agent-config.json，前端可视化编辑（story 例外：行为真源是预设条目）                    |

### 游戏系统

| 模块                | 说明                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **记忆系统**        | 记忆存储 + Embedding 向量召回 + 自动压缩总结                                                                                                                                                                                                      |
| **剧情系统**        | 剧情大纲管理 + 剧情引擎 + 世界线追踪                                                                                                                                                                                                              |
| **事件系统**        | EventBus 发布-订阅（按存档隔离）+ StateManager 唯一写入入口 + per-saveId 写队列                                                                                                                                                                   |
| **效果系统**        | 声明式效果引擎（Modifier 6 大类）+ 世界书 EJS 求值（QuickJS wasm realm 隔离）                                                                                                                                                                     |
| **脚本系统**        | 脚本沙盒（$event.on/off 持久订阅 + $call 跨对象引用 + init/cleanup 生命周期），同样跑在 QuickJS wasm realm 内，装不上即停                                                                                                                         |
| **角色系统**        | T1-T7 层级常量 + 血脉种族体系 + 角色查询 + 资源计算 + 游戏时间                                                                                                                                                                                    |
| **战斗系统**        | **战斗 v3 代码内核**：Kernel + Reducer 原子提交 + DiceTape 分通道骰带 + EffectIntent + EffectAutomaton DSL（18 窗口声明 / 12 个已接求值器），战斗 Agent 以**战斗主持人/DM** 会话模式解析玩家自由文本意图；v2 编排层已于 M5 退役，仅纯计算函数留用 |
| **制作系统**        | 3 阶段管线（准备→检定→结算）+ Agentic 工具链 + 制作品质链                                                                                                                                                                                         |
| **集群/士气/好感**  | 集群系统（≥3 合并/减员）+ 士气状态机（4 级/d20 检定）+ 好感度系统                                                                                                                                                                                 |
| **Marker Protocol** | XML 标记检测（制作/战斗/角色/音频/插画等）+ 角色生成链（char_gen→item_gen）                                                                                                                                                                       |
| **地图系统**        | 地图 v1（ADR-31）：地块落位 + 混合通行图寻路（陆海同图 + via/avoid）+ 确定性天气；换图零改码                                                                                                                                                      |
| **随机事件**        | 随机事件 v1（ADR-32）：MTTH 逐天种子化掷骰 + 权重链 + 首访强制入池 → 单通道注入 story，AI 演绎后按名回执结算                                                                                                                                      |
| **图像生成**        | 情景插画：NovelAI + ComfyUI 双后端 + 提示词方言 + 三层限额 + CG 图鉴                                                                                                                                                                              |
| **位置系统**        | 位置路径（自由文本）为唯一真源 + 势力/节点拓扑（地点集经内容注册表供给）                                                                                                                                                                          |
| **FP 系统**         | 命运点数元货币 + 命定契约 + 存档级隔离                                                                                                                                                                                                            |

### 前端 UI（Vue 3 + Pinia + Vite）

| 页面/模块    | 说明                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **主题系统** | 10 套完整主题（曜石黑/羊皮纸/深红/靛蓝/古铜/樱色/象牙白/雾紫/森林/海洋）                                                  |
| **通用组件** | Button/Modal/Card/Tabs/ResourceBar/QualityBadge/BuffChip/AvatarPanel/CharacterPortrait/ToastContainer + 表单组件族        |
| **首页**     | 游戏标题画面，标题→副标题→4 按钮→风味文字，环境检测                                                                       |
| **设置页**   | 14 分区（API/Agent/世界书/剧情/记忆/消息/输出美化/外观主题/音频/素材/图像/存档数据/开发者/关于）                          |
| **预设系统** | 仿 ST AI Response Configuration 面板，导入/导出/新建/编辑，采样器可视化                                                   |
| **地图面板** | 地图 v1 渲染（地块 + 势力政治图层 + 路线预览），图源经内容包供给（公开仓无图源，走空态）                                  |
| **游戏页**   | 三栏布局（左侧工具栏/中央对话流+输入栏/右侧状态栏）+ 功能面板族（角色/物品/任务/记忆/剧情/快照/地图/场景/战斗/CG 图鉴等） |
| **捏人页**   | 分步创建（基础/难度/背景/命定核心/选购/剧情/确认），属性联动，品质选择，装备/技能/道具编辑，捏人预设                      |
| **创意工坊** | 浏览/安装/更新/卸载/启用 + 社交面（登录/点赞/订阅）+ 投稿与审核                                                           |

### 总体规模

- **TypeScript**：零编译错误（tsc / vue-tsc / tools 三道类型网）
- **测试**：8820 tests（342 个测试文件，2026-08-18 实测），全部通过
- **引擎模块**：168 个 TypeScript 文件（`src/sillytavern/`，不含测试）
- **前端组件**：124+ Vue 组件（`src/ui/components/`）+ 10 套主题

---

## 五、正在开发 & 待开发的内容

### 近期已交付 ✅

| 模块                     | 说明                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| **创意工坊**             | 角色卡/世界书分享社区：浏览/安装/更新/卸载/启用 + 社交面 + 投稿审核  |
| **流式 SSE 正文**        | 正文边生成边显示（Agent 客户端 `chatStream` 链路，含中断与预览清理） |
| **战斗 v3 + 战斗主持人** | 代码内核主持流程，AI 当 DM 解析玩家自由文本意图                      |
| **地图 v1**              | 地块/寻路/天气 + AI 集成通道（ADR-31）                               |
| **随机事件 v1**          | Code 掷骰 + AI 演绎 + 按名回执（ADR-32）                             |
| **图像生成 v1 / v2**     | 情景插画（NovelAI）→ ComfyUI 本地后端 + 提示词方言                   |
| **存档互传**             | 单存档导出/导入（依赖体检 + 自动配置）+ 整库导入确认                 |
| **远程素材 v1**          | 世界书 / 内容包双载体 URL 目录 → 启动落地、哈希增量、镜像同步        |
| **内容-引擎分离**        | 内容包机制 + 零 IP 占位集 + 内容注册表十面                           |
| **管线并行化**           | per-saveId 写队列地基 + 4 层并行管线 + 侧链旁路化                    |

### 正在进行 🔄

| 模块           | 进度                 | 待完成                               |
| -------------- | -------------------- | ------------------------------------ |
| **捏人页**     | 分步流程已实现       | 世界书/内容包驱动的目录改造收尾      |
| **游戏页 UI**  | 布局与功能面板已实现 | 集成验证与真机走查                   |
| **真机 debug** | 持续进行             | 游玩→导出→分析→修复 循环中的缺陷修复 |

### 待开发 ⬜

| 模块               | 说明                                                      |
| ------------------ | --------------------------------------------------------- |
| **集成测试 & E2E** | 全流程手动场景测试与衔接测试                              |
| **正式发布打包**   | 产物形态（桌面壳 / 静态站）、版本与更新渠道、首启资产落地 |
| **Mac 兼容性**     | macOS 真机走查（启动器已按平台分发，尚未在真机验证）      |
| **主题打磨**       | 10 套主题逐套按审美重做配色与质感                         |
| **多分辨率适配**   | 超宽 / 竖屏 / 高 DPI / 非 16:9                            |
| **移动端支持**     | 触屏交互、安全区、虚拟键盘、wasm 与 IndexedDB 表现验证    |

> 完整的发布前待办清单见根目录 [`TODO.md`](../TODO.md)。

### 远期规划

- 远程加载的内容包（探索中，尚未裁定）
- 独立桌面应用（Electron/Tauri）
- 多人协作叙事
- 多语言 UI

---

## 六、技术栈

| 层           | 技术                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| **前端**     | Vue 3 + Pinia + Vite + Vanilla CSS（10 主题）                                             |
| **引擎**     | TypeScript (strict mode)，纯逻辑无框架依赖                                                |
| **持久化**   | Dexie.js / IndexedDB（v22，30 表）                                                        |
| **测试**     | Vitest + fake-indexeddb + jsdom                                                           |
| **LLM 协议** | OpenAI-compatible `/chat/completions`（支持 DeepSeek / 硅基流动 / OpenAI / 任意兼容 API） |
| **分发**     | GitHub Release → 本地 `npm install && npm run dev`                                        |

---

## 七、快速开始

```bash
git clone <repo>
npm install
npm run dev          # 启动 Vite 开发服务器 (localhost:5173)
npm run build        # Vite 生产构建 → dist-ui/
npm test             # 运行 Vitest 测试套件
npm run typecheck    # 仅类型检查，不输出文件
npm run gates        # 一键跑齐 CI 的全部闸门（类型 / 格式 / lint / 死代码 / 测试）
```

---

## 八、项目文档索引

| 文档                                                                                         | 说明                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md)                                        | 项目工作指导（指令正文 + Claude Code 薄壳）     |
| [src/sillytavern/AGENTS.md](../src/sillytavern/AGENTS.md)                                    | 引擎层架构地图（分册）                          |
| [src/ui/AGENTS.md](../src/ui/AGENTS.md)                                                      | 前端层架构地图（分册）                          |
| [PRD](./fated-poem-engine-prd.md)                                                            | 产品需求文档                                    |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                                                         | 完整软件+世界观架构（软件部分已过期，见文件头） |
| [CHANGELOG.md](./CHANGELOG.md)                                                               | 变更记录（近期 Phase 详细记录，append-only）    |
| [known-issue.md](./known-issue.md)                                                           | 已知缺陷（有现象、有根因分析）                  |
| [design.md](./design.md)                                                                     | 前端 UI 设计规范                                |
| [combat-system-architecture-v3.md](./reference/combat-system-architecture-v3.md)             | 战斗 v3 内核架构                                |
| [phase7e/game_page_design.md](./archive/phases/phase7e/game_page_design.md)                  | 游戏页设计规划（已归档）                        |
| [phase8_plan.md](./phases/phase8/phase8_plan.md)                                             | Agent 上下文可见性模型                          |
| [effect_script_system.md](./reference/effect_script_system.md)                               | 词条效果 & 脚本系统架构                         |
| [status_page_architecture.md](./archive/reference/status_page_architecture.md)               | 状态栏页面架构（已归档）                        |
| [agent_system_prompt_guide.md](./reference/agent_system_prompt_guide.md)                     | Agent System Prompt 配置流程                    |
| [worldbook-ejs-regex-authoring-guide.md](./reference/worldbook-ejs-regex-authoring-guide.md) | 世界书 EJS 与输出美化正则创作者规范             |
| [story_preset_format.md](./reference/story_preset_format.md)                                 | Story Agent 预设编写指南                        |
| [debug-loop-handbook.md](./reference/debug-loop-handbook.md)                                 | 游玩→导出→分析→修复 调试循环操作手册            |

> 🔴 **世界书条目索引（`world_book_index.md`）与代码-世界书冲突审计报告已随内容分离移入私有内容仓**
> （`fated_poem_independent_assets/reference/`），公开仓侧不可见。没挂内容仓的环境（含 CI 与外部
> 贡献者）读不到它们——此时不要盲改数值与世界观设定。

---

_最后更新：2026-08-18_
