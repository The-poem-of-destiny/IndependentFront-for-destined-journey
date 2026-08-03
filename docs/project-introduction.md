# 项目介绍

> 纯Vibe coding作品

---

## 一、这是什么？

**命定之诗独立前端**是一个独立的文字 RPG 引擎库，专为 AI Roleplay（AIRP）玩家设计。它以静态网站形式在本地运行，为用户提供基于大型世界观《命定之诗》的高质量 AI 叙事体验。

核心思路：**把"让 AI 同时做所有事"改成"让多个 AI 各司其职"**。

---

## 二、为什么要做这个项目？

现有的 AI 角色扮演前端（如 SillyTavern / 酒馆）基于**单 LLM 架构**——一个请求中同时塞入世界书、角色卡、对话历史、变量系统等全部上下文。当世界观规模庞大时，《命定之诗》的 605 条世界规则、23 种族、10 势力、T1-T7 七级层级体系会导致严重问题：

| 问题       | 表现                                                   |
| ---------- | ------------------------------------------------------ |
| 任务干扰   | 记忆/剧情/变量/角色等任务与叙事混在同一请求，互相干扰  |
| 成本浪费   | 无法利用不同模型的成本差异（便宜的做总结，强的做叙事） |
| 数值不可靠 | 战斗/制作等确定性计算靠 Prompt 描述，结果不一致        |

本引擎的解决方案是 **多 Agent 协作架构**——将游戏流程拆分为 6 阶段 DAG 管线，每个阶段由独立 Agent 处理特定子任务。Code 层负责所有确定性计算（战斗伤害、制作 DC、数值约束），AI 层只负责创造性推理（叙事、角色、剧情）。

---

## 三、核心架构

### 3.1 Agent 管线

```
用户输入
  │
  ▼
Stage 0  记忆召回 (memory_recall)  +  剧情预检 (plot_pre_check)    ← 并行
  │                    │
  └────────────────────┘
  ▼
Stage 1  Story 正文生成  ──→  叙事正文 + 选项 + 变量 + <marker> 标记
  │
  ▼
Stage 2  变量更新 (vars_update)  +  craft/combat/char 标记处理
  │
  ▼
Stage 3  角色状态更新 (char_update ×N)                              ← 并行
  │
  ▼
Stage 4  记忆总结 (memory_summary)  +  任务委托处理
  │
  ▼
Stage 5  剧情后检 (plot_post_check)
  │
  ▼
返回叙事 → 前端渲染
```

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

| 模块                | 说明                                                                                                                   | 测试 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| **类型系统**        | types.ts，~840 行，45+ 接口/类型，唯一类型来源                                                                         | —    |
| **数据库**          | Dexie/IndexedDB，10 表（lorebooks/presets/settings/chats/memories/plotEvents/characters/snapshots/saves/apiEndpoints） | 83   |
| **Agent 编排引擎**  | DAG 管线，阶段串行 + 同阶段并行，上下游单向传递，Agentic 多轮循环                                                      | 161  |
| **Agent 客户端**    | OpenAI 兼容协议，自动重试+指数退避，缓存命中检测                                                                       |      |
| **Prompt 模板系统** | 11 Agent 全量迁入 agent-config.json，前端可视化编辑                                                                    |      |

### 游戏系统

| 模块                | 说明                                                                          | 测试  |
| ------------------- | ----------------------------------------------------------------------------- | ----- |
| **记忆系统**        | 记忆存储 + Embedding 向量召回 + 自动压缩总结                                  | ~369  |
| **剧情系统**        | 剧情大纲管理 + 剧情引擎 + 世界线追踪                                          |       |
| **事件系统**        | EventBus 发布-订阅 + StateManager 唯一写入入口                                | ~607  |
| **效果系统**        | 声明式效果引擎（6 类型）+ EJS 沙盒评估器                                      | ~1176 |
| **脚本系统**        | 脚本沙盒（$event.on/off 持久订阅 + $call 跨对象引用 + init/cleanup 生命周期） |       |
| **角色系统**        | T1-T7 层级常量 + 23 血脉种族 + 角色查询 + 资源计算 + 游戏时间                 | ~1310 |
| **战斗系统**        | 8 步伤害管线 + 先攻回合管理 + $combat API + 战斗面板                          | ~154  |
| **制作系统**        | 3 阶段管线（准备→检定→结算）+ $craft API + 制作品质链                         | ~155  |
| **集群/士气/好感**  | 集群系统（≥3 合并/减员）+ 士气状态机（4 级/d20 检定）+ 好感度系统             | —     |
| **Marker Protocol** | XML 标记检测（3 种）+ 角色生成链（char_gen→item_gen）                         | —     |
| **位置系统**        | 10 势力 / 32 节点拓扑                                                         | —     |
| **FP 系统**         | 命运点数元货币 + 命定契约 + 存档级隔离                                        | —     |

### 前端 UI（Vue 3 + Pinia + Vite）

| 页面/模块    | 说明                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **主题系统** | 10 套完整主题（曜石黑/羊皮纸/深红/靛蓝/古铜/樱色/象牙白/雾紫/森林/海洋）                                    |
| **通用组件** | 15 个（Button/Modal/Card/Tabs/ResourceBar/QualityBadge/BuffChip/AvatarPanel/ToastContainer + 5 个表单组件） |
| **首页**     | 游戏标题画面，标题→副标题→4 按钮→风味文字，环境检测                                                         |
| **设置页**   | 8 分区（API 配置/Agent 配置/世界书/剧情系统/记忆&缓存/外观主题/存档数据/关于）                              |
| **预设系统** | 仿 ST AI Response Configuration 面板，导入/导出/新建/编辑，采样器可视化                                     |
| **地图系统** | OpenSeadragon 集成，91 个标记点，浮动信息卡片，角色位置匹配，标记工作台                                     |
| **游戏页**   | 三栏布局（左侧工具栏/中央对话流+输入栏/右侧状态栏），6 个功能面板                                           |
| **捏人页**   | 角色创建，属性联动，品质选择，装备/技能/道具编辑                                                            |

### 总体规模

- **TypeScript**：零编译错误
- **测试**：2000+ tests，全部通过
- **引擎模块**：50+ TypeScript 文件
- **前端组件**：25+ Vue 组件 + 10 主题

---

## 五、正在开发 & 待开发的内容

### 正在进行 🔄

| 模块                 | 进度                | 待完成                                         |
| -------------------- | ------------------- | ---------------------------------------------- |
| **捏人页** `/create` | 部分完成            | 种族选择、命定核心、背景故事编辑、完整校验流程 |
| **游戏页 UI**        | 核心布局已实现      | 战斗面板、制作面板、命运抽卡面板               |
| **状态栏 HUD**       | 容器+基础组件已实现 | 数据与引擎层对接                               |

### 待开发 ⬜

| 模块                     | 说明                              |
| ------------------------ | --------------------------------- |
| **创意工坊** `/workshop` | 角色卡/世界书分享社区             |
| **集成测试 & E2E**       | 全流程手动场景测试                |
| **交付准备**             | GitHub Release 打包、用户文档完善 |

### 远期规划

- 流式 SSE 正文显示
- 独立桌面应用（Electron/Tauri）
- 多人协作叙事
- 多语言 UI

---

## 六、技术栈

| 层           | 技术                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| **前端**     | Vue 3 + Pinia + Vite + Vanilla CSS（10 主题）                                             |
| **引擎**     | TypeScript (strict mode)，纯逻辑无框架依赖                                                |
| **持久化**   | Dexie.js / IndexedDB（10 表）                                                             |
| **测试**     | Vitest + fake-indexeddb + jsdom                                                           |
| **LLM 协议** | OpenAI-compatible `/chat/completions`（支持 DeepSeek / 硅基流动 / OpenAI / 任意兼容 API） |
| **分发**     | GitHub Release → 本地 `npm install && npm run dev`                                        |

---

## 七、快速开始

```bash
git clone <repo>
npm install
npm run dev          # 启动 Vite 开发服务器 (localhost:5174)
npm run build        # TypeScript 编译 + Vite 生产构建
npm test             # 运行 2000+ 测试
npm run typecheck    # 仅类型检查，不输出文件
```

---

## 八、项目文档索引

| 文档                                                                                         | 说明                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------- |
| [CLAUDE.md](../CLAUDE.md)                                                                    | 项目工作指导 & 架构总览             |
| [PRD](./fated-poem-engine-prd.md)                                                            | 产品需求文档                        |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                                                         | 完整软件+世界观架构                 |
| [progress.md](./planning/progress.md)                                                        | 开发进度日志                        |
| [phase7e/game_page_design.md](./phases/phase7e/game_page_design.md)                          | 游戏页设计规划                      |
| [phase8_plan.md](./phases/phase8/phase8_plan.md)                                             | Agent 上下文可见性模型              |
| [effect_script_system.md](./reference/effect_script_system.md)                               | 词条效果 & 脚本系统架构             |
| [status_page_architecture.md](./reference/status_page_architecture.md)                       | 状态栏页面架构                      |
| [agent_system_prompt_guide.md](./reference/agent_system_prompt_guide.md)                     | Agent System Prompt 配置流程        |
| [worldbook-ejs-regex-authoring-guide.md](./reference/worldbook-ejs-regex-authoring-guide.md) | 世界书 EJS 与输出美化正则创作者规范 |
| [story_preset_format.md](./reference/story_preset_format.md)                                 | Story Agent 预设编写指南            |
| [world_book_index.md](../reference/world_book_index.md)                                      | 世界书条目索引（605 条目）          |

---

_最后更新：2026-08-02_
