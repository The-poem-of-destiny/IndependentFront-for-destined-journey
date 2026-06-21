# Product Requirements Document: IndependentFront-for-destined-journey

**Version**: 1.0
**Date**: 2026-06-21
**Author**: Sarah (Product Owner)
**Quality Score**: 90/100

---

## Executive Summary

IndependentFront-for-destined-journey（命定之诗独立前端）是一个独立的文字 RPG 引擎库，专为 AI Roleplay (AIRP) 玩家设计。项目的核心动机是解决 SillyTavern（酒馆）单 LLM 架构无法承载大型世界观的根本问题——当世界观规模超过单一模型的上下文处理能力时，叙事质量会严重退化。

本引擎通过**多 Agent 协作架构**将叙事、记忆召回、变量更新、角色管理、剧情追踪等职责拆分为独立的 Agent 管线，每个 Agent 只处理自己可见的上下文子集。配合 DeepSeek 上下文缓存隔离策略，实现大型世界观下的高质量文字 RPG 体验。

项目以 GitHub Release 形式分发，用户在本地部署为静态网站即可运行。

---

## Problem Statement

**Current Situation**: SillyTavern（酒馆）是 AIRP 社区最流行的前端工具，但其架构设计于单 LLM 时代——一个请求中塞入世界书、角色卡、对话历史、变量系统等全部上下文。当世界观规模庞大（如《命定之诗》605 条世界规则、23 种族、14 势力、7 层级体系），单模型面临：
- 上下文窗口被世界书占据，留给叙事的空间不足
- 记忆/剧情/变量/角色等任务与叙事混在同一请求中，互相干扰
- 无法利用不同模型的成本/能力差异（便宜的做总结，强的做叙事）

**Proposed Solution**: 多 Agent 编排引擎——将游戏流程拆分为 6 阶段 DAG 管线，每个阶段由独立 Agent 处理特定子任务。Agent 间通过声明式上下文可见性规则隔离信息（如 Story AI 看不到完整剧情大纲，防止"全知叙事"）。代码层负责所有确定性计算（战斗伤害/制作DC/数值约束），AI 层只负责创造性推理。

**Business Impact**: 为 AIRP 社区提供首个原生支持多 Agent 协作的文字 RPG 引擎，让大型世界观角色卡不再受限于单模型架构。

---

## Success Metrics

**Primary KPIs:**
- **Agent 管线完整性**: 完整跑通一次 6 阶段 Agent 流程（Stage 0→5）不出现引擎级 bug
- **编译 & 测试**: TypeScript 零编译错误 + 全部测试通过（当前 2121 tests）
- **用户可用性**: 用户从 GitHub Release 下载后，本地 `npm run dev` 即可启动完整应用
- **缓存命中率**: Story Agent 的 DeepSeek 上下文缓存命中率 ≥ 80%（通过固定前缀 + 独立 userId 隔离）

**Validation**: Phase 9（集成&交付）完成后，通过手动 E2E 场景测试（创建角色 → 开始游戏 → 完整一轮对话含记忆召回/剧情检查/正文生成/变量更新 → 无报错）

---

## User Personas

### Primary: AIRP 玩家（AI Roleplay Player）

- **Role**: 文字 RPG 爱好者，使用 AI 进行角色扮演和互动叙事
- **Goals**: 在一个深度、自洽的奇幻世界中体验高质量的 AI 叙事
- **Pain Points**:
  - 现有 SillyTavern 单 LLM 架构无法处理大型世界观（上下文不够/质量下降）
  - 世界书条目太多时 AI"失焦"，叙事偏离世界观设定
  - 战斗/制作等系统靠 Prompt 描述不可靠（数值不一致、逻辑错误）
- **Technical Level**: 初级~中级（需要能运行 npm 命令，不需要会编程）

### Secondary: 角色卡/世界书作者

- **Role**: 创作世界观设定、角色卡、剧情大纲的内容创作者
- **Goals**: 在一个支持多 Agent 的引擎上部署自己的世界观，获得比酒馆更好的叙事一致性
- **Pain Points**: 酒馆不支持 Agent 分工，大型世界书注入后 AI 行为不可预测

---

## User Stories & Acceptance Criteria

### Story 1: 作为 AIRP 玩家，我希望能创建角色并开始游戏

**As a** AIRP 玩家
**I want to** 创建角色（选择种族/分配属性/选择命定核心）并开始一局新游戏
**So that** 我能体验基于《命定之诗》世界观的文字 RPG

**Acceptance Criteria:**
- [ ] 捏人页完整可用：角色名/性别/五维属性/种族/命定核心/品质选择/装备/技能/道具/背景故事
- [ ] 属性联动正确：层级→HP/MP/SP 预览实时更新，BP/AP 消耗实时校验
- [ ] 提交创建后写入 IndexedDB（characters 表 + saves 表）
- [ ] 创造模式（转生点 ×100）和标准模式均正常
- [ ] 页面切换通过 Store 导航（单 URL 架构），无需 router

### Story 2: 作为 AIRP 玩家，我希望进行一轮完整的 AI 叙事

**As a** AIRP 玩家
**I want to** 输入行动后获得完整的 AI 叙事回应（含正文/选项/总结/变量更新）
**So that** 我能推进游戏剧情

**Acceptance Criteria:**
- [ ] Stage 0: 记忆召回 + 剧情预检并行执行
- [ ] Stage 1: Story AI 生成正文（XML 格式：thinking/maintext/option/sum/vars）
- [ ] Stage 2: vars_update Agent 提取变量变更 + 检测制作/角色标记
- [ ] Stage 3: char_update Agent 更新角色状态
- [ ] Stage 4: memory_summary Agent 生成本轮记忆
- [ ] Stage 5: plot_post_check Agent 检查世界线变动
- [ ] 全流程无引擎报错，Agent 输出格式正确

### Story 3: 作为 AIRP 玩家，我希望战斗/制作系统数值正确

**As a** AIRP 玩家
**I want to** 在战斗中看到正确的伤害计算，在制作中看到合理的 DC 判定
**So that** 游戏系统的数值逻辑自洽且符合世界观设定

**Acceptance Criteria:**
- [ ] 战斗伤害管线：8 步计算（基础→分段→穿透→装备减免→类型减免→评级→DR→最终）与世界书 #837617 对齐
- [ ] 制作 3 阶段管线（准备→检定→结算）与世界书 #683615 对齐
- [ ] 品质体系（普通~唯一 7 级）与世界书 #265160 对齐
- [ ] 层级压制/集群修正/士气检定按规则正确触发
- [ ] 确定性逻辑全部在 Code 层执行（不依赖 AI Prompt 做数学）

### Story 4: 作为角色卡作者，我希望能自定义 Agent 配置

**As a** 角色卡作者
**I want to** 为不同 Agent 配置模型、世界书分区、采样参数
**So that** 我能针对自己的世界观调校 AI 行为

**Acceptance Criteria:**
- [ ] 设置页 API 池管理：添加/删除/测试 API 端点
- [ ] 设置页 Agent 配置：每个 Agent 独立选择模型、挂载世界书
- [ ] 预设管理：导入 ST JSON 格式 Prompt 预设、采样器参数可视化
- [ ] 世界书管理：导入/新建/编辑/开关条目

### Story 5: 作为 AIRP 玩家，我希望存档数据安全可迁移

**As a** AIRP 玩家
**I want to** 导出/导入存档数据，在不同设备间迁移游戏进度
**So that** 我不会因为本地环境变化丢失进度

**Acceptance Criteria:**
- [ ] 导出全量数据（10 表 JSON）
- [ ] 导入时 3-transaction 写入保证一致性
- [ ] SaveProfile（FP/契约/成就）随存档完整迁移
- [ ] 变量快照机制在回溯历史时正确恢复

---

## Functional Requirements

### Core Features

**Feature 1: 多 Agent 编排引擎**
- Description: DAG 管线编排——6 阶段串行，同阶段 Agent 并行（Promise.allSettled），上游输出通过 agentOutputs 向下游单向传递
- User flow: 用户输入 → Stage 0(memory_recall+plot_pre_check) → Stage 1(story) → Stage 2(vars_update) → Stage 3(char_update×N) → Stage 4(memory_summary) → Stage 5(plot_post_check) → 返回叙事
- Edge cases: Stage 0 任一 Agent 失败不阻塞；Stage 1 依赖 Stage 0 全部完成；管线验证（未知 Agent/缺失依赖/DAG 合法性）
- Error handling: Agent 失败自动重试（指数退避 1s/2s/4s），超时 AbortSignal 取消，secondary API 失败 → fallback primary

**Feature 2: 上下文缓存隔离**
- Description: 每 Agent 独立 DeepSeek userId（`fp|{saveId}|{agentId}`），Prompt 模板分为固定前缀（fixedSystem+fixedExamples，缓存命中关键）+ 可变后缀（variableContext+variableInstruction，每轮动态）
- User flow: 引擎自动构建 messages，无需用户干预
- Edge cases: 世界书静态注入（废除关键词动态匹配）→ 缓存命中率 100%
- Error handling: 缓存命中检测（cache_hit/prompt_cache_hit_tokens header）

**Feature 3: 4 层代码架构**
- Description: Layer 1 原语（StateManager 唯一写入入口）→ Layer 2 计算（骰子/资源/角色查询/时间）→ Layer 3 流程（战斗/制作 Resolver）→ Layer 4 语义（$ API，AI 可见）
- User flow: AI 调用 `$combat.attack()` 声明意图，Code 执行 8 步伤害管线，返回结构化结果
- Edge cases: 层级压制检测、意图非致死判定、集群攻击次数衰减
- Error handling: 数值越界由 $validate 自动钳制

**Feature 4: Marker Protocol 子系统触发**
- Description: 正文 AI 通过 XML 标记与引擎通信——`<craft_request/>`（阻塞注入）、`<combat_trigger/>`（延迟到 Stage2）、`<char_detect/>`（异步后置）
- User flow: 用户输入"打一把长剑" → Story AI 输出正文 + `<craft_request/>` → 引擎剥离标记 → 调用 Craft Agent → 结果卡片注入对话 → 自动继续叙事
- Edge cases: Combat 延迟到 Stage2 char_gen 后执行（确保新敌人已生成）；Craft 阻塞等待创意效果生成
- Error handling: 标记检测用纯正则函数，无状态，失败不影响正文展示

**Feature 5: Vite + Vue 3 单 URL 前端**
- Description: 10 主题 × 16 通用组件 × 4 页面（首页/捏人/游戏/设置/创意工坊），Store 导航（非 Router），localStorage 设置持久化
- User flow: 打开 `localhost:5174` → 首页 → 创建角色 → 进入游戏 → 对话交互
- Edge cases: Pinia Store 跨页面保活，页面切换不丢失状态
- Error handling: Toast 全局通知系统（4 类型 + 动画）

### Out of Scope
- 在线/云端托管服务（纯本地部署）
- 移动端 App
- 多人在线协作
- OpenAI function calling 集成（使用 Marker 协议替代）
- 商业化/付费墙

---

## Technical Constraints

### Performance
- **单轮响应时间**: Story Agent 响应 < 30s（取决于 LLM API），代码层开销 < 10ms
- **缓存命中率**: Story Agent 上下文缓存命中率 ≥ 80%
- **并发支持**: 同阶段 Agent 并行（16 线程上限），Stage 0 两个 Agent 同时发起
- **IndexedDB**: 10 表，单存档 < 50MB

### Security
- **本地部署**: 无服务端，API key 存在 IndexedDB，不上传
- **EJS 沙盒**: `new Function()` 隔离执行，禁止文件/网络访问
- **变量隔离**: `user.` / `sys.` 命名空间，AI 不可越界写入系统变量

### Integration
- **SillyTavern**: 导入/导出兼容 ST 格式（世界书 JSON、预设 JSON、角色卡）
- **LLM API**: OpenAI-compatible `/chat/completions` 端点（DeepSeek/硅基流动/OpenAI 均可）
- **Embedding**: 可选 Embedding API（记忆向量召回）

### Technology Stack
- **前端**: Vue 3 + Pinia + Vite + Vanilla CSS（10 主题）
- **引擎**: TypeScript (strict mode)，纯逻辑无框架依赖
- **持久化**: Dexie.js / IndexedDB（10 表）
- **测试**: Vitest + fake-indexeddb + jsdom
- **分发**: GitHub Release → 用户本地 `npm install && npm run dev`

---

## MVP Scope & Phasing

### MVP (Required for Initial Launch) — Phase 1-9

| Phase | 内容 | 测试 |
|-------|------|------|
| 1 | 架构设计 & 可行性验证 | — |
| 2 | 核心数据结构 & 数据库（10 表） | 83 |
| 3 | Agent 编排引擎（3 模块） | 161 |
| 4 | 记忆系统 & 剧情规划 | 369 |
| 4.5 | 事件系统（GameEvent + StateManager） | 607 |
| 4.6 | Foundation Layer（FP/EJS/Effect） | 1176 |
| 5 | 角色 & 变量系统 + $ API | 1310 |
| Geography | 位置系统（32 节点/10 势力） | 1358 |
| 6a-6e | 战斗/制作/集群/士气/好感/Marker | 1978 |
| 7a-7g | 前端 UI（首页/捏人/游戏/设置/创意工坊） | ~2089 |
| 8 | Agent 上下文可见性 & Prompt 体系 | ~2139 |
| 9 | 集成测试 & E2E & 交付 | ~2179 |

**MVP Definition**: Phase 9 完成 = 用户从 GitHub Release 下载 → 本地部署 → 创建角色 → 完整一轮多 Agent 对话（含记忆召回/剧情检查/正文生成/变量更新/记忆总结）→ 无引擎 bug

### Post-MVP Enhancements
- 创意工坊社区化（角色卡/世界书分享）
- 流式 SSE 正文显示
- 角色卡 CDN 在线更新
- 多语言 UI

### Future Considerations
- 独立桌面应用（Electron/Tauri）
- 多人协作叙事
- AI 生成世界书工具链

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| LLM API 服务不稳定 | High | High | 自动重试+指数退避+双 API fallback |
| DeepSeek 缓存命中率不达标 | Med | High | 固定前缀最大化、世界书静态注入、Prompt 结构优化 |
| 上下文窗口溢出（Agent 输入超长） | Med | High | 变量区截断+对话历史轮数限制+世界书条目精简 |
| 前端性能（10 主题/大量 DOM） | Low | Med | CSS 变量系统+组件懒加载+Vite code splitting |
| 用户部署门槛过高 | Med | Med | 一键 `npm install && npm run dev`，README 详细步骤 |
| SillyTavern 格式兼容性变化 | Low | Low | importer.ts 独立转换层，内部格式与 ST 格式解耦 |
| Agent 输出格式不一致 | High | Med | 严格结构化输出要求 + 解析失败自动重试 |

---

## Dependencies & Blockers

**Dependencies:**
- **DeepSeek API**: 上下文缓存功能依赖 DeepSeek 的 prompt cache 机制
- **硅基流动 Embedding API**: 可选，记忆向量召回需要 Embedding 模型
- **SillyTavern 格式文档**: 世界书/预设/角色卡导入依赖 ST 社区格式

**Known Blockers:**
- **Phase 8 上下文可见性**: 当前 Agent 模板为骨架版，需完整的可见性过滤逻辑配合高质量 System Prompt
- **Phase 7e 游戏页**: 状态栏 HUD 和游戏页是当前开发中的最大 UI 模块

---

## Appendix

### Glossary
- **AIRP**: AI Roleplay，AI 角色扮演
- **酒馆 (Tavern)**: SillyTavern 俗称，最流行的 AIRP 前端工具
- **Agent**: 独立 LLM 调用单元，有自己的 Prompt 模板/API 配置/上下文可见性规则
- **Pipeline**: DAG 编排管线，定义 Agent 执行顺序和依赖关系
- **FP (Fate Point)**: 命运点数，存档级元货币，用于命定契约等核心机制
- **$ API**: AI 可见的语义级 API（如 `$combat.attack()`），封装底层 Code 逻辑
- **Tier (层级)**: 角色力量等级（T1-T7），对应普通→神祗
- **Marker Protocol**: Story AI 通过 XML 标记（`<craft_request/>` 等）与引擎通信的协议
- **VarsPatch**: 变量更新补丁，支持 replace/delta/insert 三种操作
- **World Book (世界书)**: Lorebook/WI 条目集合，注入 AI Prompt 的世界观设定
- **ST**: SillyTavern 缩写

### References
- [CLAUDE.md](../CLAUDE.md) — 项目工作指导 & 架构总览
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 完整软件+世界观架构
- [task_plan.md](./planning/task_plan.md) — 9 Phase 实施计划
- [progress.md](./planning/progress.md) — 开发进度日志
- [phase8_plan.md](./phases/phase8/phase8_plan.md) — Agent 上下文可见性 & Prompt 体系
- [effect_script_system.md](./reference/effect_script_system.md) — 词条效果 & 脚本系统架构
- [world_book_index.md](../reference/world_book_index.md) — 世界书条目索引（605 条目）

---

*This PRD was created through interactive requirements gathering with quality scoring to ensure comprehensive coverage of business, functional, UX, and technical dimensions.*
